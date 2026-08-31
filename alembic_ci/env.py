from __future__ import annotations

from logging.config import fileConfig
import os

from alembic import context
from sqlalchemy import MetaData, engine_from_config, pool

from solar_battery.durable_cockpit.orm import Base


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option(
    "sqlalchemy.url",
    os.getenv(
        "DATABASE_URL",
        "sqlite+pysqlite:///./.local/e3_ci_analyzer.sqlite3",
    ),
)

target_metadata = MetaData()
for table_name in (
    "ci_projects",
    "ci_project_evidence",
    "ci_project_feasibility_results",
    "ci_project_tariff_replay_results",
    "ci_project_annual_financial_results",
    "ci_device_profiles",
    "ci_project_site_material",
    "ci_pricing_catalog_versions",
    "ci_financial_solutions",
    "ci_internal_report_artifacts",
):
    Base.metadata.tables[table_name].to_metadata(target_metadata)


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
