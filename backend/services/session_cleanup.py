"""Session cleanup service for summarizing and archiving old sessions."""
import logging
from datetime import datetime, timezone
from typing import Optional, List
from sqlalchemy import select, delete, text
from sqlalchemy.ext.asyncio import AsyncSession
from models.session import Session
from models.message import Message
from models.chat_summary import ChatSummary
from services.llm_provider import ChatMessage, create_provider_from_settings
from services.embeddings import embedding_service

logger = logging.getLogger(__name__)

# Similarity threshold for including summaries in context
# Higher = more selective (0.0 to 1.0)
SIMILARITY_THRESHOLD = 0.3

# Prompt for summarizing chat sessions
SUMMARIZATION_PROMPT = """You are a conversation summarizer. Analyze the following chat conversation and provide:

1. A concise summary (2-4 sentences) capturing the main topics and outcomes
2. A list of 3-5 key topics/themes discussed

Format your response as JSON:
{
    "summary": "Your concise summary here...",
    "topics": ["topic1", "topic2", "topic3"]
}

CONVERSATION:
"""


class SessionCleanupService:
    """Service for cleaning up old sessions by summarizing and archiving them."""
    
    def __init__(self):
        self._llm_provider = None
    
    @property
    def llm_provider(self):
        """Lazy-load LLM provider."""
        if self._llm_provider is None:
            self._llm_provider = create_provider_from_settings()
        return self._llm_provider
    
    async def get_sessions_to_cleanup(
        self,
        db: AsyncSession,
        exclude_session_id: Optional[str] = None,
        min_messages: int = 2,
    ) -> List[Session]:
        """
        Get all sessions that should be cleaned up.
        
        Args:
            db: Database session
            exclude_session_id: Session ID to exclude (the new active session)
            min_messages: Minimum messages required for a session to be summarized
            
        Returns:
            List of Session objects to clean up
        """
        import uuid
        
        query = select(Session)
        
        if exclude_session_id:
            try:
                exclude_uuid = uuid.UUID(exclude_session_id)
                query = query.where(Session.session_id != exclude_uuid)
            except ValueError:
                pass
        
        result = await db.execute(query)
        sessions = list(result.scalars().all())
        
        # Filter sessions that have enough messages to summarize
        sessions_to_cleanup = []
        for session in sessions:
            # Count messages for this session
            msg_count_result = await db.execute(
                select(Message).where(Message.session_id == session.session_id)
            )
            messages = list(msg_count_result.scalars().all())
            
            if len(messages) >= min_messages:
                sessions_to_cleanup.append(session)
        
        return sessions_to_cleanup
    
    async def summarize_session(
        self,
        db: AsyncSession,
        session: Session,
    ) -> Optional[ChatSummary]:
        """
        Generate a summary for a session's conversation.
        
        Args:
            db: Database session
            session: The session to summarize
            
        Returns:
            ChatSummary object or None if summarization fails
        """
        import json
        
        # Get all messages for this session
        result = await db.execute(
            select(Message)
            .where(Message.session_id == session.session_id)
            .order_by(Message.timestamp)
        )
        messages = list(result.scalars().all())
        
        if not messages:
            logger.warning(f"No messages found for session {session.session_id}")
            return None
        
        # Format conversation for summarization
        conversation_text = "\n".join([
            f"{msg.role.upper()}: {msg.content}"
            for msg in messages
        ])
        
        # Generate summary using LLM
        try:
            summary_request = [
                ChatMessage(
                    role="user",
                    content=f"{SUMMARIZATION_PROMPT}\n{conversation_text}"
                )
            ]
            
            response, _ = await self.llm_provider.chat(
                messages=summary_request,
                system_prompt="You are a helpful assistant that summarizes conversations. Always respond with valid JSON.",
            )
            
            # Parse the JSON response
            try:
                # Try to extract JSON from the response
                response_text = response.strip()
                
                # Handle case where response is wrapped in markdown code blocks
                if response_text.startswith("```"):
                    lines = response_text.split("\n")
                    json_lines = []
                    in_json = False
                    for line in lines:
                        if line.startswith("```") and not in_json:
                            in_json = True
                            continue
                        elif line.startswith("```") and in_json:
                            break
                        elif in_json:
                            json_lines.append(line)
                    response_text = "\n".join(json_lines)
                
                summary_data = json.loads(response_text)
                summary_text = summary_data.get("summary", response)
                topics = summary_data.get("topics", [])
                
            except json.JSONDecodeError:
                # If JSON parsing fails, use the raw response as summary
                logger.warning(f"Could not parse JSON summary, using raw response")
                summary_text = response
                topics = []
            
            # Get timestamps
            first_message = messages[0]
            last_message = messages[-1]
            
            # Generate embedding for semantic search
            # Combine summary and topics for richer embedding
            embedding_text = summary_text
            if topics:
                embedding_text += f" Topics: {', '.join(topics)}"
            
            embedding = await embedding_service.create_embedding(embedding_text)
            if not embedding:
                logger.warning(f"Could not create embedding for session {session.session_id}")
            
            # Create summary record
            chat_summary = ChatSummary(
                session_id=session.session_id,
                user_id=session.user_id,
                summary=summary_text,
                topics=topics,
                embedding=embedding,
                message_count=len(messages),
                session_created_at=session.created_at,
                session_ended_at=last_message.timestamp,
                metadata_={
                    "first_message_preview": first_message.content[:200] if first_message.content else "",
                    "last_message_preview": last_message.content[:200] if last_message.content else "",
                },
            )
            
            db.add(chat_summary)
            logger.info(f"Created summary for session {session.session_id} (embedding: {'yes' if embedding else 'no'})")
            
            return chat_summary
            
        except Exception as e:
            logger.error(f"Error summarizing session {session.session_id}: {e}")
            return None
    
    async def delete_session(
        self,
        db: AsyncSession,
        session: Session,
    ) -> bool:
        """
        Delete a session and its messages.
        
        Args:
            db: Database session
            session: The session to delete
            
        Returns:
            True if deletion was successful
        """
        try:
            # Messages are deleted automatically via CASCADE
            await db.delete(session)
            logger.info(f"Deleted session {session.session_id}")
            return True
        except Exception as e:
            logger.error(f"Error deleting session {session.session_id}: {e}")
            return False
    
    async def cleanup_sessions(
        self,
        db: AsyncSession,
        new_session_id: str,
        min_messages: int = 2,
    ) -> dict:
        """
        Clean up all old sessions when a new session is created.
        
        This will:
        1. Find all sessions except the new one
        2. Summarize each session
        3. Delete the original session and messages
        
        Args:
            db: Database session
            new_session_id: The new session ID to exclude from cleanup
            min_messages: Minimum messages required for summarization
            
        Returns:
            Summary of cleanup operation
        """
        result = {
            "sessions_found": 0,
            "sessions_summarized": 0,
            "sessions_deleted": 0,
            "sessions_skipped": 0,
            "errors": [],
        }
        
        # Get sessions to clean up
        sessions = await self.get_sessions_to_cleanup(
            db,
            exclude_session_id=new_session_id,
            min_messages=min_messages,
        )
        result["sessions_found"] = len(sessions)
        
        logger.info(f"Found {len(sessions)} sessions to clean up")
        
        for session in sessions:
            try:
                # Check if summary already exists
                existing = await db.execute(
                    select(ChatSummary).where(ChatSummary.session_id == session.session_id)
                )
                if existing.scalar_one_or_none():
                    logger.info(f"Summary already exists for session {session.session_id}, skipping")
                    result["sessions_skipped"] += 1
                    # Still delete the session
                    if await self.delete_session(db, session):
                        result["sessions_deleted"] += 1
                    continue
                
                # Summarize the session
                summary = await self.summarize_session(db, session)
                if summary:
                    result["sessions_summarized"] += 1
                    
                    # Delete the session after successful summarization
                    if await self.delete_session(db, session):
                        result["sessions_deleted"] += 1
                else:
                    # If summarization fails, still try to delete if session is old
                    logger.warning(f"Could not summarize session {session.session_id}")
                    result["errors"].append(f"Failed to summarize session {session.session_id}")
                    
            except Exception as e:
                error_msg = f"Error processing session {session.session_id}: {e}"
                logger.error(error_msg)
                result["errors"].append(error_msg)
        
        # Commit all changes
        await db.commit()
        
        # Clear the orchestrator's summaries cache so new summaries are picked up
        try:
            from services.orchestrator import clear_summaries_cache
            clear_summaries_cache()
        except ImportError:
            pass
        
        logger.info(f"Cleanup complete: {result}")
        return result
    
    async def get_recent_summaries(
        self,
        db: AsyncSession,
        limit: int = 10,
        user_id: Optional[str] = None,
    ) -> List[ChatSummary]:
        """
        Get recent chat summaries for context.
        
        Args:
            db: Database session
            limit: Maximum number of summaries to return
            user_id: Optional user ID filter
            
        Returns:
            List of ChatSummary objects
        """
        query = (
            select(ChatSummary)
            .order_by(ChatSummary.created_at.desc())
            .limit(limit)
        )
        
        if user_id:
            query = query.where(ChatSummary.user_id == user_id)
        
        result = await db.execute(query)
        return list(result.scalars().all())
    
    async def get_summaries_by_topic(
        self,
        db: AsyncSession,
        topic: str,
        limit: int = 5,
    ) -> List[ChatSummary]:
        """
        Search summaries by topic.
        
        Args:
            db: Database session
            topic: Topic to search for
            limit: Maximum number of summaries to return
            
        Returns:
            List of matching ChatSummary objects
        """
        from sqlalchemy import func
        
        # Search for topic in the topics JSONB array
        query = (
            select(ChatSummary)
            .where(ChatSummary.topics.contains([topic]))
            .order_by(ChatSummary.created_at.desc())
            .limit(limit)
        )
        
        result = await db.execute(query)
        return list(result.scalars().all())
    
    async def search_relevant_summaries(
        self,
        db: AsyncSession,
        query_text: str,
        limit: int = 3,
        similarity_threshold: float = SIMILARITY_THRESHOLD,
    ) -> List[tuple[ChatSummary, float]]:
        """
        Search for summaries semantically relevant to the query.
        
        Uses vector similarity search with pgvector to find summaries
        that are contextually related to the user's query.
        
        Args:
            db: Database session
            query_text: The user's query to find relevant summaries for
            limit: Maximum number of summaries to return
            similarity_threshold: Minimum similarity score (0-1)
            
        Returns:
            List of (ChatSummary, similarity_score) tuples, ordered by relevance
        """
        # Generate embedding for the query
        query_embedding = await embedding_service.create_embedding(query_text)
        
        if not query_embedding:
            logger.warning("Could not create embedding for query, falling back to recent summaries")
            # Fallback to recent summaries without semantic filtering
            summaries = await self.get_recent_summaries(db, limit=limit)
            return [(s, 0.5) for s in summaries]  # Default similarity
        
        # Use pgvector's cosine distance operator for similarity search
        # Note: pgvector uses distance (lower is better), we convert to similarity
        # cosine_distance = 1 - cosine_similarity, so similarity = 1 - distance
        
        # Build the query using raw SQL for pgvector operations
        embedding_str = f"[{','.join(str(x) for x in query_embedding)}]"
        
        sql = text(f"""
            SELECT 
                id, session_id, user_id, summary, topics, message_count,
                session_created_at, session_ended_at, created_at, metadata,
                1 - (embedding <=> :embedding::vector) as similarity
            FROM chat_summaries
            WHERE embedding IS NOT NULL
            AND 1 - (embedding <=> :embedding::vector) >= :threshold
            ORDER BY embedding <=> :embedding::vector
            LIMIT :limit
        """)
        
        result = await db.execute(
            sql,
            {
                "embedding": embedding_str,
                "threshold": similarity_threshold,
                "limit": limit,
            }
        )
        
        rows = result.fetchall()
        
        summaries_with_scores = []
        for row in rows:
            # Reconstruct ChatSummary from row data
            summary = ChatSummary(
                id=row.id,
                session_id=row.session_id,
                user_id=row.user_id,
                summary=row.summary,
                topics=row.topics,
                message_count=row.message_count,
                session_created_at=row.session_created_at,
                session_ended_at=row.session_ended_at,
                created_at=row.created_at,
                metadata_=row.metadata,
            )
            summaries_with_scores.append((summary, row.similarity))
        
        logger.debug(f"Found {len(summaries_with_scores)} relevant summaries for query")
        return summaries_with_scores


# Global instance
session_cleanup_service = SessionCleanupService()

