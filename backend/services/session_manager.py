"""Session management service."""
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from models.session import Session
from models.message import Message


class SessionManager:
    """Manages chat sessions and messages."""
    
    async def get_or_create_session(
        self, 
        db: AsyncSession, 
        session_id: str
    ) -> Session:
        """
        Get existing session or create new one.
        
        Args:
            db: Database session
            session_id: UUID string of the session
            
        Returns:
            Session object
        """
        try:
            session_uuid = uuid.UUID(session_id)
        except ValueError:
            # Invalid UUID, create new one
            session_uuid = uuid.uuid4()
        
        # Try to get existing session
        result = await db.execute(
            select(Session).where(Session.session_id == session_uuid)
        )
        session = result.scalar_one_or_none()
        
        if session is None:
            # Create new session
            session = Session(session_id=session_uuid)
            db.add(session)
            await db.commit()
            await db.refresh(session)
        else:
            # Update last activity
            session.last_activity = datetime.now(timezone.utc)
            await db.commit()
        
        return session
    
    async def add_message(
        self,
        db: AsyncSession,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[dict] = None,
    ) -> Message:
        """
        Add a message to a session.
        
        Args:
            db: Database session
            session_id: UUID string of the session
            role: 'user' or 'assistant'
            content: Message content
            metadata: Optional metadata dict
            
        Returns:
            Created Message object
        """
        session = await self.get_or_create_session(db, session_id)
        
        message = Message(
            session_id=session.session_id,
            role=role,
            content=content,
            metadata_=metadata or {},
        )
        db.add(message)
        
        # Update session last activity
        session.last_activity = datetime.now(timezone.utc)
        
        await db.commit()
        await db.refresh(message)
        
        return message
    
    async def get_messages(
        self,
        db: AsyncSession,
        session_id: str,
        limit: Optional[int] = None,
    ) -> List[Message]:
        """
        Get messages for a session.
        
        Args:
            db: Database session
            session_id: UUID string of the session
            limit: Optional limit on number of messages
            
        Returns:
            List of Message objects
        """
        try:
            session_uuid = uuid.UUID(session_id)
        except ValueError:
            return []
        
        query = (
            select(Message)
            .where(Message.session_id == session_uuid)
            .order_by(Message.timestamp)
        )
        
        if limit:
            query = query.limit(limit)
        
        result = await db.execute(query)
        return list(result.scalars().all())
    
    async def session_exists(self, db: AsyncSession, session_id: str) -> bool:
        """Check if a session exists."""
        try:
            session_uuid = uuid.UUID(session_id)
        except ValueError:
            return False
        
        result = await db.execute(
            select(Session.session_id).where(Session.session_id == session_uuid)
        )
        return result.scalar_one_or_none() is not None

    async def get_latest_session(self, db: AsyncSession) -> Optional[Session]:
        """
        Get the most recently active session.
        
        This allows users to resume their conversation from any device.
        
        Args:
            db: Database session
            
        Returns:
            The most recent Session or None if no sessions exist
        """
        from sqlalchemy.orm import selectinload
        
        result = await db.execute(
            select(Session)
            .options(selectinload(Session.messages))
            .order_by(Session.last_activity.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()


# Global session manager instance
session_manager = SessionManager()

