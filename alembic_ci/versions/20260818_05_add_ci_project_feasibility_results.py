"""Persist current project-scoped C&I physical-feasibility results."""

from alembic import op
import sqlalchemy as sa


revision = "20260818_05_ci"
down_revision = "20260817_04_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_project_feasibility_results",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("ci_projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("result_contract_version", sa.String(64), nullable=False),
        sa.Column("interval_sha256", sa.String(64), nullable=False),
        sa.Column("design_candidates_sha256", sa.String(64), nullable=False),
        sa.Column("result_sha256", sa.String(64), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_project_feasibility_scope_updated",
        "ci_project_feasibility_results",
        ["workspace_id", "owner_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ci_project_feasibility_scope_updated",
        table_name="ci_project_feasibility_results",
    )
    op.drop_table("ci_project_feasibility_results")
