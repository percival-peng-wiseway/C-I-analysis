"""Persist private C&I project roof and site photos."""

from alembic import op
import sqlalchemy as sa


revision = "20260819_06_ci"
down_revision = "20260818_05_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_project_site_material",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("ci_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(128), nullable=False),
        sa.Column("object_store_key", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ci_project_site_material_scope_project_created",
        "ci_project_site_material",
        ["workspace_id", "owner_id", "project_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ci_project_site_material_scope_project_created",
        table_name="ci_project_site_material",
    )
    op.drop_table("ci_project_site_material")
