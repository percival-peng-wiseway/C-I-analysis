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
        "ci_device_profiles",
        "ci_internal_report_artifacts",
        "ci_pricing_catalog_versions",
        "ci_project_evidence",
        "ci_project_annual_financial_results",
        "ci_project_feasibility_results",
        "ci_project_rebate_profiles",
        "ci_project_site_material",
        "ci_project_tariff_replay_results",
        "ci_project_tariff_profiles",
        "ci_projects",
    }
    project_columns = {
        column["name"] for column in inspect(engine).get_columns("ci_projects")
    }
    assert "design_context_json" in project_columns
    tariff_profile_columns = {
        column["name"]
        for column in inspect(engine).get_columns("ci_project_tariff_profiles")
    }
    assert tariff_profile_columns == {
        "project_id",
        "workspace_id",
        "owner_id",
        "profile_contract_version",
        "approval_status",
        "source_bill_sha256",
        "source_interval_sha256",
        "source_tariff_facts_sha256",
        "profile_sha256",
        "profile_json",
        "calculation_profile_sha256",
        "calculation_profile_json",
        "approved_by_actor_id",
        "approved_at",
        "created_by_actor_id",
        "updated_by_actor_id",
        "created_at",
        "updated_at",
    }
    rebate_profile_columns = {
        column["name"]
        for column in inspect(engine).get_columns("ci_project_rebate_profiles")
    }
    assert rebate_profile_columns == {
        "project_id",
        "workspace_id",
        "owner_id",
        "profile_contract_version",
        "approval_status",
        "site_evidence_sha256",
        "ruleset_id",
        "ruleset_sha256",
        "profile_sha256",
        "profile_json",
        "calculation_profile_sha256",
        "calculation_profile_json",
        "approved_by_actor_id",
        "approved_at",
        "created_by_actor_id",
        "updated_by_actor_id",
        "created_at",
        "updated_at",
    }
    annual_finance_columns = {
        column["name"]
        for column in inspect(engine).get_columns(
            "ci_project_annual_financial_results"
        )
    }
    assert "rebate_profile_sha256" in annual_finance_columns
    assert not any(table.startswith("residential_") for table in tables)
    engine.dispose()
