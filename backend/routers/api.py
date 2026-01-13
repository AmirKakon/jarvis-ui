"""REST API endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import List, Optional
from database.db import get_db
from services.session_manager import session_manager
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

