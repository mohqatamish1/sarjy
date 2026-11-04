"""Allow automatically captured identity facts to be corrected without duplicates."""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("memories", sa.Column("fact_key", sa.String(30), nullable=True))
    op.create_unique_constraint("uq_memory_fact", "memories", ["workspace_id", "fact_key"])


def downgrade():
    op.drop_constraint("uq_memory_fact", "memories", type_="unique")
    op.drop_column("memories", "fact_key")
