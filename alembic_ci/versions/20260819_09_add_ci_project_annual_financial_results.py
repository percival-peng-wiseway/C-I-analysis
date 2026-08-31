"""Persist project-scoped C&I annual financial comparisons."""

from alembic import op
import sqlalchemy as sa


revision = "20260819_09_ci"
down_revision = "20260819_08_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_project_annual_financial_results",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("ci_projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("result_contract_version", sa.String(64), nullable=False),
        sa.Column("tariff_replay_result_sha256", sa.String(64), nullable=False),
        sa.Column("result_sha256", sa.String(64), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_project_annual_financial_scope_updated",
        "ci_project_annual_financial_results",
        ["workspace_id", "owner_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ci_project_annual_financial_scope_updated",
        table_name="ci_project_annual_financial_results",
    )
    op.drop_table("ci_project_annual_financial_results")
