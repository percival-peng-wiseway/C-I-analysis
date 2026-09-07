"""Independent STC worksheet; no changes to evidence or approved rebate history."""
from alembic import op
import sqlalchemy as sa

revision = "20260907_16_ci"
down_revision = "20260907_15_ci"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ci_projects", sa.Column("stc_calculator_json", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("ci_projects", "stc_calculator_json")
