"""Persist private C&I project Setup evidence references and safe results."""

from alembic import op
import sqlalchemy as sa


revision = "20260817_04_ci"
down_revision = "20260817_03_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_project_evidence",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("ci_projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("bill_filename", sa.String(255), nullable=False),
        sa.Column("bill_content_type", sa.String(128), nullable=False),
        sa.Column("bill_object_store_key", sa.String(255), nullable=False),
        sa.Column("bill_size_bytes", sa.Integer(), nullable=False),
        sa.Column("bill_sha256", sa.String(64), nullable=False),
        sa.Column("interval_filename", sa.String(255), nullable=False),
        sa.Column("interval_content_type", sa.String(128), nullable=False),
        sa.Column("interval_object_store_key", sa.String(255), nullable=False),
        sa.Column("interval_size_bytes", sa.Integer(), nullable=False),
        sa.Column("interval_sha256", sa.String(64), nullable=False),
        sa.Column("inspection_result_json", sa.JSON(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_project_evidence_scope_updated",
        "ci_project_evidence",
        ["workspace_id", "owner_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ci_project_evidence_scope_updated", table_name="ci_project_evidence"
    )
    op.drop_table("ci_project_evidence")
