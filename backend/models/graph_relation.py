"""Knowledge-graph relation model.

A relation is a typed, directed edge (subject -[predicate]-> object) between
two entities, optionally traced back to the fact it was extracted from.
"""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from database.db import Base


class GraphRelation(Base):
    """
    A directed, typed edge between two entities.

    Example: (Amir) -[works_on]-> (Enforcer). Traversed via recursive CTE to
    expand retrieval beyond a single fact's immediate content.
    """

    __tablename__ = "graph_relations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    subject_entity_id = Column(
        Integer,
        ForeignKey("graph_entities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    predicate = Column(String(255), nullable=False)  # normalized relation label
    object_entity_id = Column(
        Integer,
        ForeignKey("graph_entities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_fact_id = Column(
        Integer,
        ForeignKey("memory_facts.id", ondelete="SET NULL"),
        nullable=True,
    )
    confidence = Column(Float, nullable=False, default=0.7)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    metadata_ = Column("metadata", JSONB, default=dict)

    def __repr__(self):
        return (
            f"<GraphRelation(id={self.id}, "
            f"{self.subject_entity_id}-[{self.predicate}]->{self.object_entity_id})>"
        )

    def to_dict(self):
        return {
            "id": self.id,
            "subject_entity_id": self.subject_entity_id,
            "predicate": self.predicate,
            "object_entity_id": self.object_entity_id,
            "source_fact_id": self.source_fact_id,
            "confidence": self.confidence,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
