"""Add memory_facts table and recency columns to chat_summaries

Revision ID: 003
Revises: 002
Create Date: 2026-03-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from pgvector.sqlalchemy import Vector

revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIMENSIONS = 1536


def upgrade() -> None:
    # --- memory_facts table ---
    op.create_table(
        'memory_facts',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('category', sa.String(100), nullable=True),
        sa.Column('embedding', Vector(EMBEDDING_DIMENSIONS), nullable=True),
        sa.Column('source', sa.String(50), nullable=False, server_default='telegram'),
        sa.Column('created_by', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('NOW()')),
        sa.Column('last_accessed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_memory_facts_created_at', 'memory_facts', ['created_at'])
    op.create_index('idx_memory_facts_category', 'memory_facts', ['category'])
    op.execute(
        'CREATE INDEX idx_memory_facts_embedding ON memory_facts '
        'USING hnsw (embedding vector_cosine_ops)'
    )

    # --- chat_summaries: add recency and source columns ---
    op.add_column('chat_summaries',
                  sa.Column('last_accessed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('chat_summaries',
                  sa.Column('source', sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column('chat_summaries', 'source')
    op.drop_column('chat_summaries', 'last_accessed_at')

    op.drop_index('idx_memory_facts_embedding', table_name='memory_facts')
    op.drop_index('idx_memory_facts_category', table_name='memory_facts')
    op.drop_index('idx_memory_facts_created_at', table_name='memory_facts')
    op.drop_table('memory_facts')
