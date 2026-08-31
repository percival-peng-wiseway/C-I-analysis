"""Add the isolated C&I project registry."""

from alembic import op
import sqlalchemy as sa


revision = "20260817_02_ci"
down_revision = "20260817_01_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("current_stage", sa.String(32), nullable=False),
        sa.Column("setup_status", sa.String(32), nullable=False),
        sa.Column("design_candidate_count", sa.Integer(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_projects_scope_updated",
        "ci_projects",
        ["workspace_id", "owner_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_ci_projects_scope_updated", table_name="ci_projects")
    op.drop_table("ci_projects")
