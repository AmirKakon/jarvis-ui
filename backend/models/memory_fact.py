"""Memory fact model for storing durable facts that never decay."""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from pgvector.sqlalchemy import Vector
from database.db import Base

EMBEDDING_DIMENSIONS = 1536


class MemoryFact(Base):
    """
    Durable fact that persists indefinitely without decay.

    Examples: server IPs, passwords, preferences, setup details.
    Stored via /remember command or auto-extracted during session summarization.
    Always injected into Claude's context regardless of query similarity.
    """

    __tablename__ = "memory_facts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    category = Column(String(100), nullable=True)
    embedding = Column(Vector(EMBEDDING_DIMENSIONS), nullable=True)
    source = Column(String(50), nullable=False, default="telegram")
    created_by = Column(String(255), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    metadata_ = Column("metadata", JSONB, default=dict)

    def __repr__(self):
        return f"<MemoryFact(id={self.id}, content={self.content[:50]})>"

    def to_dict(self):
        return {
            "id": self.id,
            "content": self.content,
            "category": self.category,
            "source": self.source,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat(),
            "last_accessed_at": self.last_accessed_at.isoformat() if self.last_accessed_at else None,
        }
