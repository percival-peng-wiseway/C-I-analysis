"""Persist the calculated Net CAPEX snapshot for a generated design."""

from alembic import op
import sqlalchemy as sa


revision = "20260904_13_ci"
down_revision = "20260902_12_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ci_projects",
        sa.Column("design_price_preview_json", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ci_projects", "design_price_preview_json")
