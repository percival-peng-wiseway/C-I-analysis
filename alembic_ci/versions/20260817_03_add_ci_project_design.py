"""Persist Python-validated C&I project design candidates."""

from alembic import op
import sqlalchemy as sa


revision = "20260817_03_ci"
down_revision = "20260817_02_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ci_projects",
        sa.Column("design_candidates_json", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ci_projects", "design_candidates_json")
