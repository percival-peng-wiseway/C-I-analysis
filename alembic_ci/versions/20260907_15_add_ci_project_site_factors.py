"""Persist site performance factors before solutions are generated."""
from alembic import op
import sqlalchemy as sa

revision = "20260907_15_ci"
down_revision = "20260906_14_ci"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ci_projects", sa.Column("site_factors_json", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("ci_projects", "site_factors_json")
