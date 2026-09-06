from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from solar_battery.ci_projects import CiProjectError, create_ci_project, list_ci_projects, require_ci_project, restore_ci_project, trash_ci_project
from solar_battery.durable_cockpit.orm import CiProjectModel
from tests.durable_test_helpers import create_sqlite_session_factory, create_test_client, local_actor, sqlite_url_for_path


def test_trash_is_persisted_recoverable_and_preserves_saved_design(tmp_path):
    url = sqlite_url_for_path(tmp_path / "trash.sqlite3")
    factory = create_sqlite_session_factory(url)
    with create_test_client(url, object_store_root=tmp_path / "objects") as client:
        original = client.post("/api/commercial-industrial/projects", json={"display_name": "Synthetic site"}).json()
        project_id = original["project_id"]
        path = f"/api/commercial-industrial/projects/{project_id}"
        with factory.begin() as session:
            row = session.get(CiProjectModel, UUID(project_id))
            row.design_candidates_json = [{"scenario_id": "saved-example"}]
            row.design_context_json = {"saved": True}
            row.design_price_preview_json = {"test_value": 123}
        assert client.delete(path).json()["status"] == "trashed"
        assert client.delete(path).status_code == 200
        assert client.get("/api/commercial-industrial/projects").json()["projects"] == []
        assert client.get("/api/commercial-industrial/projects?deleted_only=true").json()["projects"][0]["project_id"] == project_id
        assert client.get(f"{path}/design-candidates").status_code == 404
        with factory() as session:
            row = session.get(CiProjectModel, UUID(project_id))
            assert row.deleted_at is not None
            assert row.deleted_by_actor_id == local_actor().actor_id
            assert row.design_price_preview_json == {"test_value": 123}
        restored = client.post(f"{path}/restore")
        assert restored.status_code == 200
        # SQLite may omit the original timezone suffix; the stored time is unchanged.
        assert restored.json()["updated_at"].removesuffix("+00:00") == original["updated_at"].removesuffix("+00:00")
        assert client.post(f"{path}/restore").status_code == 200
        assert len(client.get("/api/commercial-industrial/projects").json()["projects"]) == 1
        assert client.get("/api/commercial-industrial/projects?deleted_only=true").json()["projects"] == []
        with factory() as session:
            row = require_ci_project(session, project_id=UUID(project_id), actor=local_actor())
            assert row.design_candidates_json == [{"scenario_id": "saved-example"}]
            assert row.design_context_json == {"saved": True}
    factory.kw["bind"].dispose()


@pytest.mark.parametrize("foreign", [local_actor(owner_id="another-owner"), local_actor(workspace_id="another-workspace")])
def test_trash_and_restore_are_tenant_scoped(tmp_path, foreign):
    factory = create_sqlite_session_factory(sqlite_url_for_path(tmp_path / "scope.sqlite3"))
    with factory.begin() as session:
        project = create_ci_project(session, display_name="Private synthetic site", actor=local_actor())
        project_id = UUID(project["project_id"])
        for operation in (trash_ci_project, restore_ci_project):
            with pytest.raises(CiProjectError, match="not found"):
                operation(session, project_id=project_id, actor=foreign)
        trash_ci_project(session, project_id=project_id, actor=local_actor())
        assert list_ci_projects(session, actor=foreign, deleted_only=True) == []
        with pytest.raises(CiProjectError, match="not found"):
            require_ci_project(session, project_id=project_id, actor=local_actor())
        with pytest.raises(CiProjectError, match="not found"):
            trash_ci_project(session, project_id=uuid4(), actor=local_actor())
    factory.kw["bind"].dispose()


def test_soft_delete_migration_preserves_existing_projects(tmp_path, monkeypatch):
    import logging

    analysis_logger = logging.getLogger("solar_battery.ci_scenario_analysis")
    monkeypatch.setattr(analysis_logger, "disabled", False)
    url = sqlite_url_for_path(tmp_path / "migration.sqlite3")
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config("alembic-ci.ini")
    command.upgrade(config, "20260904_13_ci")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO ci_projects (id, workspace_id, owner_id, display_name, current_stage, setup_status, design_candidate_count, created_by_actor_id, updated_by_actor_id, created_at, updated_at) VALUES (:id, 'test', 'test', 'Existing', 'setup', 'input_required', 0, 'test', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"), {"id": uuid4().hex})
    command.upgrade(config, "head")
    assert not analysis_logger.disabled
    with engine.connect() as connection:
        assert tuple(connection.execute(text("SELECT display_name, deleted_at, deleted_by_actor_id FROM ci_projects")).one()) == ("Existing", None, None)
    engine.dispose()
