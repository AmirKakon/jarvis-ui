"""Add chat_summaries table for session summarization with vector embeddings

Revision ID: 002
Revises: 001
Create Date: 2026-01-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from pgvector.sqlalchemy import Vector

# revision identifiers, used by Alembic.
revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Embedding dimensions for text-embedding-3-small
EMBEDDING_DIMENSIONS = 1536


def upgrade() -> None:
    # Enable pgvector extension (may already exist)
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')
    
    # Create chat_summaries table
    op.create_table(
        'chat_summaries',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', sa.String(255), nullable=True),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('topics', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('embedding', Vector(EMBEDDING_DIMENSIONS), nullable=True),
        sa.Column('message_count', sa.Integer(), nullable=False),
        sa.Column('session_created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('session_ended_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id')
    )
    op.create_index('idx_chat_summaries_session_id', 'chat_summaries', ['session_id'])
    op.create_index('idx_chat_summaries_created_at', 'chat_summaries', ['created_at'])
    op.create_index('idx_chat_summaries_user_id', 'chat_summaries', ['user_id'])
    
    # Create vector index for similarity search (using HNSW for fast approximate search)
    op.execute(
        'CREATE INDEX idx_chat_summaries_embedding ON chat_summaries '
        'USING hnsw (embedding vector_cosine_ops)'
    )


def downgrade() -> None:
    op.drop_index('idx_chat_summaries_embedding', table_name='chat_summaries')
    op.drop_index('idx_chat_summaries_user_id', table_name='chat_summaries')
    op.drop_index('idx_chat_summaries_created_at', table_name='chat_summaries')
    op.drop_index('idx_chat_summaries_session_id', table_name='chat_summaries')
    op.drop_table('chat_summaries')

