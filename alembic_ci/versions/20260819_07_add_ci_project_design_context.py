"""Persist C&I existing assets and technical design options."""

from alembic import op
import sqlalchemy as sa


revision = "20260819_07_ci"
down_revision = "20260819_06_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ci_projects",
        sa.Column("design_context_json", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ci_projects", "design_context_json")
