"""Chat summary database model for storing session summaries."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB
from pgvector.sqlalchemy import Vector
from database.db import Base

# Embedding dimensions for text-embedding-3-small
EMBEDDING_DIMENSIONS = 1536


class ChatSummary(Base):
    """
    Chat summary model for storing summaries of completed sessions.
    
    When a new session is created, old sessions are summarized and stored here,
    allowing the agent to reference past conversations for context.
    
    Includes vector embedding for semantic search - only relevant summaries
    are included in the AI context based on query similarity.
    """
    
    __tablename__ = "chat_summaries"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(
        UUID(as_uuid=True),
        nullable=False,
        unique=True,
        index=True,
    )
    user_id = Column(String(255), nullable=True)  # For future multi-user support
    summary = Column(Text, nullable=False)  # LLM-generated summary of the conversation
    topics = Column(JSONB, default=list)  # List of main topics discussed
    embedding = Column(Vector(EMBEDDING_DIMENSIONS), nullable=True)  # For semantic search
    message_count = Column(Integer, nullable=False)  # Number of messages in original session
    session_created_at = Column(
        DateTime(timezone=True),
        nullable=False,
    )
    session_ended_at = Column(
        DateTime(timezone=True),
        nullable=False,
    )
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    metadata_ = Column("metadata", JSONB, default=dict)  # Additional context
    
    def __repr__(self):
        return f"<ChatSummary(id={self.id}, session_id={self.session_id})>"
    
    def to_dict(self):
        """Convert summary to dictionary."""
        return {
            "id": self.id,
            "session_id": str(self.session_id),
            "user_id": self.user_id,
            "summary": self.summary,
            "topics": self.topics or [],
            "message_count": self.message_count,
            "session_created_at": self.session_created_at.isoformat(),
            "session_ended_at": self.session_ended_at.isoformat(),
            "created_at": self.created_at.isoformat(),
            "metadata": self.metadata_ or {},
        }

