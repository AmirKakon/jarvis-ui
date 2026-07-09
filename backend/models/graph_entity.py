"""Knowledge-graph entity model.

An entity is a canonical thing referenced by durable facts (a person, org,
place, service, concept, etc). Entities are linked to facts via `fact_entities`
and to each other via typed edges in `graph_relations`.
"""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from pgvector.sqlalchemy import Vector
from database.db import Base

EMBEDDING_DIMENSIONS = 1536


class GraphEntity(Base):
    """
    A canonical node in the knowledge graph.

    Entity resolution merges surface forms (aliases) into one canonical row
    using name normalization + embedding similarity, mirroring the fact-dedup
    approach used for memory_facts.
    """

    __tablename__ = "graph_entities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)  # canonical display name
    normalized_name = Column(String(255), nullable=False, index=True)  # lowercased, trimmed
    type = Column(String(50), nullable=True)  # person, org, place, thing, concept
    aliases = Column(JSONB, default=list)  # alternate surface forms
    embedding = Column(Vector(EMBEDDING_DIMENSIONS), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    metadata_ = Column("metadata", JSONB, default=dict)

    def __repr__(self):
        return f"<GraphEntity(id={self.id}, name={self.name}, type={self.type})>"

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "normalized_name": self.normalized_name,
            "type": self.type,
            "aliases": self.aliases or [],
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
