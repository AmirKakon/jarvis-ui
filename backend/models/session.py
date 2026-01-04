"""Session database model."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from database.db import Base


class Session(Base):
    """Session model for storing chat sessions."""
    
    __tablename__ = "sessions"
    
    session_id = Column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id = Column(String(255), nullable=True)  # For future multi-user support
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    last_activity = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    metadata_ = Column("metadata", JSONB, default=dict)  # For future features
    
    # Relationship to messages
    messages = relationship(
        "Message",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Message.timestamp",
    )
    
    def __repr__(self):
        return f"<Session(session_id={self.session_id})>"

