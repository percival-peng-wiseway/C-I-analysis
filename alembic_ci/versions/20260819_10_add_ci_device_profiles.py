"""Add workspace-scoped C&I device price profiles."""

from alembic import op
import sqlalchemy as sa


revision = "20260819_10_ci"
down_revision = "20260819_09_ci"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ci_device_profiles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.String(120), nullable=False),
        sa.Column("owner_id", sa.String(120), nullable=False),
        sa.Column("profile_contract_version", sa.String(64), nullable=False),
        sa.Column("profile_sha256", sa.String(64), nullable=False),
        sa.Column("profile_json", sa.JSON(), nullable=False),
        sa.Column("created_by_actor_id", sa.String(120), nullable=False),
        sa.Column("updated_by_actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "uq_ci_device_profiles_scope",
        "ci_device_profiles",
        ["workspace_id", "owner_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_ci_device_profiles_scope", table_name="ci_device_profiles"
    )
    op.drop_table("ci_device_profiles")
