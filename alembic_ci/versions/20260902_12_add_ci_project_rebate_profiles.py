"""Add project rebate profiles and bind annual finance to rebates."""

from alembic import op
import sqlalchemy as sa


revision = "20260902_12_ci"
down_revision = "20260902_11_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_project_rebate_profiles",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("ci_projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("profile_contract_version", sa.String(64), nullable=False),
        sa.Column("approval_status", sa.String(32), nullable=False),
        sa.Column("site_evidence_sha256", sa.String(64), nullable=False),
        sa.Column("ruleset_id", sa.String(120), nullable=False),
        sa.Column("ruleset_sha256", sa.String(64), nullable=False),
        sa.Column("profile_sha256", sa.String(64), nullable=False),
        sa.Column("profile_json", sa.JSON(), nullable=False),
        sa.Column("calculation_profile_sha256", sa.String(64), nullable=True),
        sa.Column("calculation_profile_json", sa.JSON(), nullable=True),
        sa.Column("approved_by_actor_id", sa.String(120), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_project_rebate_profiles_scope_updated",
        "ci_project_rebate_profiles",
        ["workspace_id", "owner_id", "updated_at"],
    )
    op.add_column(
        "ci_project_annual_financial_results",
        sa.Column("rebate_profile_sha256", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column(
        "ci_project_annual_financial_results", "rebate_profile_sha256"
    )
    op.drop_index(
        "ix_ci_project_rebate_profiles_scope_updated",
        table_name="ci_project_rebate_profiles",
    )
    op.drop_table("ci_project_rebate_profiles")
