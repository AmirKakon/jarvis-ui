"""Add knowledge-graph tables: graph_entities, graph_relations, fact_entities

Revision ID: 004
Revises: 003
Create Date: 2026-07-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from pgvector.sqlalchemy import Vector

revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIMENSIONS = 1536


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')

    # --- graph_entities ---
    op.create_table(
        'graph_entities',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('normalized_name', sa.String(255), nullable=False),
        sa.Column('type', sa.String(50), nullable=True),
        sa.Column('aliases', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('embedding', Vector(EMBEDDING_DIMENSIONS), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('NOW()')),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_graph_entities_normalized_name', 'graph_entities', ['normalized_name'])
    op.create_index('idx_graph_entities_created_at', 'graph_entities', ['created_at'])
    op.execute(
        'CREATE INDEX idx_graph_entities_embedding ON graph_entities '
        'USING hnsw (embedding vector_cosine_ops)'
    )

    # --- graph_relations ---
    op.create_table(
        'graph_relations',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('subject_entity_id', sa.Integer(), nullable=False),
        sa.Column('predicate', sa.String(255), nullable=False),
        sa.Column('object_entity_id', sa.Integer(), nullable=False),
        sa.Column('source_fact_id', sa.Integer(), nullable=True),
        sa.Column('confidence', sa.Float(), nullable=False, server_default='0.7'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('NOW()')),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(['subject_entity_id'], ['graph_entities.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['object_entity_id'], ['graph_entities.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['source_fact_id'], ['memory_facts.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_graph_relations_subject', 'graph_relations', ['subject_entity_id'])
    op.create_index('idx_graph_relations_object', 'graph_relations', ['object_entity_id'])
    # Soft-unique on the triple to keep upserts idempotent
    op.create_index(
        'uq_graph_relations_triple',
        'graph_relations',
        ['subject_entity_id', 'predicate', 'object_entity_id'],
        unique=True,
    )

    # --- fact_entities (join table) ---
    op.create_table(
        'fact_entities',
        sa.Column('fact_id', sa.Integer(), nullable=False),
        sa.Column('entity_id', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['fact_id'], ['memory_facts.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['entity_id'], ['graph_entities.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('fact_id', 'entity_id'),
    )
    op.create_index('idx_fact_entities_entity', 'fact_entities', ['entity_id'])


def downgrade() -> None:
    op.drop_index('idx_fact_entities_entity', table_name='fact_entities')
    op.drop_table('fact_entities')

    op.drop_index('uq_graph_relations_triple', table_name='graph_relations')
    op.drop_index('idx_graph_relations_object', table_name='graph_relations')
    op.drop_index('idx_graph_relations_subject', table_name='graph_relations')
    op.drop_table('graph_relations')

    op.drop_index('idx_graph_entities_embedding', table_name='graph_entities')
    op.drop_index('idx_graph_entities_created_at', table_name='graph_entities')
    op.drop_index('idx_graph_entities_normalized_name', table_name='graph_entities')
    op.drop_table('graph_entities')
