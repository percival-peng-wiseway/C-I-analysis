from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_standalone_migration_creates_only_ci_tables(tmp_path, monkeypatch) -> None:
    database_url = f"sqlite+pysqlite:///{tmp_path / 'standalone-ci.sqlite3'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    command.upgrade(Config("alembic-ci.ini"), "head")

    engine = create_engine(database_url)
    tables = set(inspect(engine).get_table_names())
    assert tables == {
        "alembic_version",
        "ci_financial_solutions",
        "ci_internal_report_artifacts",
        "ci_pricing_catalog_versions",
        "ci_project_evidence",
        "ci_project_feasibility_results",
        "ci_projects",
    }
    assert not any(table.startswith("residential_") for table in tables)
    engine.dispose()
