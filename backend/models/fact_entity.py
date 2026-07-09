"""Association between durable facts and knowledge-graph entities.

Many-to-many: a fact can mention several entities, and an entity can be
mentioned by many facts. This is the bridge that lets vector-seeded facts
"jump" into the graph for expansion.
"""
from sqlalchemy import Column, Integer, ForeignKey
from database.db import Base


class FactEntity(Base):
    """Link row connecting memory_facts to graph_entities."""

    __tablename__ = "fact_entities"

    fact_id = Column(
        Integer,
        ForeignKey("memory_facts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    entity_id = Column(
        Integer,
        ForeignKey("graph_entities.id", ondelete="CASCADE"),
        primary_key=True,
    )

    def __repr__(self):
        return f"<FactEntity(fact_id={self.fact_id}, entity_id={self.entity_id})>"
