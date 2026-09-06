"""Recoverable C&I project deletion; retain evidence and calculation snapshots."""

from alembic import op
import sqlalchemy as sa

revision = "20260906_14_ci"
down_revision = "20260904_13_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ci_projects", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ci_projects", sa.Column("deleted_by_actor_id", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("ci_projects", "deleted_by_actor_id")
    op.drop_column("ci_projects", "deleted_at")
