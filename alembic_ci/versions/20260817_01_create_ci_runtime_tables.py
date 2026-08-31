"""Create the isolated C&I runtime tables."""

from alembic import op
import sqlalchemy as sa


revision = "20260817_01_ci"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_pricing_catalog_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("catalog_json", sa.JSON(), nullable=False),
        sa.Column("catalog_hash", sa.String(64), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("published_by_actor_id", sa.String(120)),
    )
    op.create_index(
        "uq_ci_pricing_catalog_version",
        "ci_pricing_catalog_versions",
        ["workspace_id", "owner_id", "version_number"],
        unique=True,
    )
    op.create_index(
        "ix_ci_pricing_catalog_scope",
        "ci_pricing_catalog_versions",
        ["workspace_id", "owner_id", "created_at"],
    )
    op.create_table(
        "ci_financial_solutions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("scenario_id", sa.String(120), nullable=False),
        sa.Column("source_physical_scenario_sha256", sa.String(64), nullable=False),
        sa.Column("optimizer_run_snapshot_sha256", sa.String(64)),
        sa.Column("optimizer_run_snapshot_json", sa.JSON()),
        sa.Column("optimizer_audit_projection_json", sa.JSON()),
        sa.Column("assumptions_json", sa.JSON(), nullable=False),
        sa.Column("metrics_json", sa.JSON(), nullable=False),
        sa.Column("starred", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_financial_solutions_scope",
        "ci_financial_solutions",
        ["workspace_id", "owner_id", "updated_at"],
    )
    op.create_table(
        "ci_internal_report_artifacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column(
            "financial_solution_id",
            sa.Uuid(),
            sa.ForeignKey("ci_financial_solutions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("report_contract_version", sa.String(120), nullable=False),
        sa.Column("renderer_contract_version", sa.String(120), nullable=False),
        sa.Column("source_fingerprint", sa.String(64), nullable=False),
        sa.Column("source_nem12_sha256", sa.String(64), nullable=False),
        sa.Column("source_physical_scenario_sha256", sa.String(64), nullable=False),
        sa.Column("optimizer_run_snapshot_sha256", sa.String(64), nullable=False),
        sa.Column("comparison_sha256", sa.String(64), nullable=False),
        sa.Column("report_contract_json", sa.JSON(), nullable=False),
        sa.Column("html_object_store_key", sa.String(255), nullable=False),
        sa.Column("html_sha256", sa.String(64), nullable=False),
        sa.Column("html_byte_size", sa.Integer(), nullable=False),
        sa.Column("pdf_object_store_key", sa.String(255), nullable=False),
        sa.Column("pdf_sha256", sa.String(64), nullable=False),
        sa.Column("pdf_byte_size", sa.Integer(), nullable=False),
        sa.Column("pdf_renderer_id", sa.String(120), nullable=False),
        sa.Column("pdf_renderer_version", sa.String(120), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "uq_ci_internal_report_source",
        "ci_internal_report_artifacts",
        ["workspace_id", "owner_id", "source_fingerprint"],
        unique=True,
    )
    op.create_index(
        "ix_ci_internal_report_scope_created",
        "ci_internal_report_artifacts",
        ["workspace_id", "owner_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ci_internal_report_scope_created",
        table_name="ci_internal_report_artifacts",
    )
    op.drop_index(
        "uq_ci_internal_report_source",
        table_name="ci_internal_report_artifacts",
    )
    op.drop_table("ci_internal_report_artifacts")
    op.drop_index(
        "ix_ci_financial_solutions_scope",
        table_name="ci_financial_solutions",
    )
    op.drop_table("ci_financial_solutions")
    op.drop_index(
        "ix_ci_pricing_catalog_scope",
        table_name="ci_pricing_catalog_versions",
    )
    op.drop_index(
        "uq_ci_pricing_catalog_version",
        table_name="ci_pricing_catalog_versions",
    )
    op.drop_table("ci_pricing_catalog_versions")
