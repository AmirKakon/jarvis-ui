"""REST API endpoints."""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import List, Optional
from database.db import get_db, async_session_maker
from services.session_manager import session_manager
from services.session_cleanup import session_cleanup_service
from config import get_settings

router = APIRouter(prefix="/api", tags=["api"])


class MessageResponse(BaseModel):
    """Message response model."""
    id: int
    session_id: str
    role: str
    content: str
    timestamp: str
    metadata: dict = {}


class HistoryResponse(BaseModel):
    """Chat history response model."""
    session_id: str
    messages: List[MessageResponse]


class SessionCheckResponse(BaseModel):
    """Session check response model."""
    exists: bool
    session_id: str


class ChatSummaryResponse(BaseModel):
    """Chat summary response model."""
    id: int
    session_id: str
    summary: str
    topics: List[str]
    message_count: int
    session_created_at: str
    session_ended_at: str
    created_at: str


class CleanupRequest(BaseModel):
    """Request to cleanup old sessions."""
    new_session_id: str
    min_messages: int = 2


class CleanupResponse(BaseModel):
    """Response from cleanup operation."""
    sessions_found: int
    sessions_summarized: int
    sessions_deleted: int
    sessions_skipped: int
    errors: List[str]


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    settings = get_settings()
    return {
        "status": "healthy",
        "llm_provider": settings.llm_provider,
        "llm_model": settings.llm_model,
    }


@router.get("/history/{session_id}", response_model=HistoryResponse)
async def get_chat_history(
    session_id: str,
    limit: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Get chat history for a session.
    
    Args:
        session_id: The session UUID
        limit: Optional limit on number of messages
        db: Database session
        
    Returns:
        Chat history with messages
    """
    messages = await session_manager.get_messages(db, session_id, limit)
    
    return HistoryResponse(
        session_id=session_id,
        messages=[
            MessageResponse(
                id=msg.id,
                session_id=str(msg.session_id),
                role=msg.role,
                content=msg.content,
                timestamp=msg.timestamp.isoformat(),
                metadata=msg.metadata_ or {},
            )
            for msg in messages
        ],
    )


@router.get("/session/{session_id}", response_model=SessionCheckResponse)
async def check_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Check if a session exists.
    
    Args:
        session_id: The session UUID
        db: Database session
        
    Returns:
        Session existence status
    """
    exists = await session_manager.session_exists(db, session_id)
    return SessionCheckResponse(exists=exists, session_id=session_id)


async def run_cleanup_in_background(new_session_id: str, min_messages: int = 2):
    """Background task to run session cleanup."""
    import logging
    logger = logging.getLogger(__name__)
    
    async with async_session_maker() as db:
        try:
            result = await session_cleanup_service.cleanup_sessions(
                db=db,
                new_session_id=new_session_id,
                min_messages=min_messages,
            )
            logger.info(f"Background cleanup completed: {result}")
        except Exception as e:
            logger.error(f"Background cleanup failed: {e}")


@router.post("/session/cleanup", response_model=CleanupResponse)
async def cleanup_sessions(
    request: CleanupRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Cleanup old sessions when creating a new session.
    
    This will summarize all existing sessions (except the new one),
    save the summaries, and delete the old sessions.
    
    The cleanup runs in the background to avoid blocking the UI.
    
    Args:
        request: Cleanup request with new session ID
        background_tasks: FastAPI background tasks
        db: Database session
        
    Returns:
        Acknowledgment that cleanup has started
    """
    # Start cleanup in background
    background_tasks.add_task(
        run_cleanup_in_background,
        request.new_session_id,
        request.min_messages,
    )
    
    # Return immediately with acknowledgment
    return CleanupResponse(
        sessions_found=0,
        sessions_summarized=0,
        sessions_deleted=0,
        sessions_skipped=0,
        errors=["Cleanup started in background"],
    )


@router.get("/summaries", response_model=List[ChatSummaryResponse])
async def get_summaries(
    limit: int = 10,
    db: AsyncSession = Depends(get_db),
):
    """
    Get recent chat summaries.
    
    These summaries can be used to provide context about past conversations.
    
    Args:
        limit: Maximum number of summaries to return
        db: Database session
        
    Returns:
        List of chat summaries
    """
    summaries = await session_cleanup_service.get_recent_summaries(db, limit=limit)
    
    return [
        ChatSummaryResponse(
            id=s.id,
            session_id=str(s.session_id),
            summary=s.summary,
            topics=s.topics or [],
            message_count=s.message_count,
            session_created_at=s.session_created_at.isoformat(),
            session_ended_at=s.session_ended_at.isoformat(),
            created_at=s.created_at.isoformat(),
        )
        for s in summaries
    ]


@router.get("/summaries/context", response_model=str)
async def get_summaries_context(
    limit: int = 5,
    db: AsyncSession = Depends(get_db),
):
    """
    Get chat summaries formatted as context for the AI agent.
    
    This endpoint returns a formatted string that can be included in the
    system prompt to give the agent context about past conversations.
    
    Args:
        limit: Maximum number of summaries to include
        db: Database session
        
    Returns:
        Formatted context string
    """
    summaries = await session_cleanup_service.get_recent_summaries(db, limit=limit)
    
    if not summaries:
        return ""
    
    context_parts = ["## Previous Conversation Summaries\n"]
    
    for s in summaries:
        topics_str = ", ".join(s.topics) if s.topics else "N/A"
        context_parts.append(
            f"### Session from {s.session_created_at.strftime('%Y-%m-%d %H:%M')}\n"
            f"**Topics:** {topics_str}\n"
            f"**Summary:** {s.summary}\n"
        )
    
    return "\n".join(context_parts)

