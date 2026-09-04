from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

import pytest

from solar_battery.ci_project_feasibility import (
    canonical_sha256,
    design_candidates_sha256,
)
from solar_battery.ci_project_tariff_replay import (
    ci_tariff_replay_state,
    record_ci_tariff_replay_result,
    tariff_profile_sha256,
)
from solar_battery.ci_projects import CiProjectError, create_ci_project
from solar_battery.durable_cockpit.orm import (
    CiProjectEvidenceModel,
    CiProjectModel,
    CiProjectTariffReplayResultModel,
)
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    local_actor,
    sqlite_url_for_path,
)


INTERVAL_SHA256 = "1" * 64
TARIFF_PROFILE = {"profile_id": "approved-test-profile"}


def _candidates() -> list[dict[str, object]]:
    return [
        {"scenario_id": "scenario-a", "label": "A"},
        {"scenario_id": "scenario-b", "label": "B"},
        {"scenario_id": "scenario-c", "label": "C"},
    ]


def _scenario_result(
    scenario_id: str,
    *,
    raw_demand_kva: float,
    pv_kwp: float,
    battery_kwh: float,
    scenario_cost_aud: float,
) -> dict[str, object]:
    return {
        "scenario_id": scenario_id,
        "physical_review_rank": 1,
        "recommendation_permitted": False,
        "authored_inputs": {
            "pv_capacity_kwp_dc": pv_kwp,
            "nominal_capacity_kwh": battery_kwh,
        },
        "post_dispatch": {"raw_rolling_demand_kva": raw_demand_kva},
        "annual_tariff_value": {
            "customer_facing_permission": False,
            "baseline_cost_ex_gst_aud": 1_000.0,
            "scenario_cost_ex_gst_aud": scenario_cost_aud,
            "first_year_value_ex_gst_aud": round(
                1_000.0 - scenario_cost_aud, 2
            ),
        },
    }


def _result(*scenarios: dict[str, object]) -> dict[str, object]:
    return {
        "contract_version": "ci_physical_scenario_review_v6",
        "calculation_revision": "ci_physical_scenario_planner_limits_primal_simplex_v1",
        "analysis_status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "currency_values_permitted": True,
        "profile": {"profile_id": "approved-test-profile"},
        "baseline": {"raw_rolling_demand_kva": 300.0},
        "ranking_basis": "Physical review only.",
        "scenarios": list(scenarios),
        "report_preview": {"download_available": False},
        "assumptions": [],
    }


def _seed_project(session) -> UUID:
    actor = local_actor()
    project = create_ci_project(
        session,
        display_name="Tariff checkpoint persistence",
        actor=actor,
    )
    project_id = UUID(str(project["project_id"]))
    row = session.get(CiProjectEvidenceModel, project_id)
    assert row is None
    now = datetime.now(timezone.utc)
    session.add(
        CiProjectEvidenceModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            bill_filename="bill.pdf",
            bill_content_type="application/pdf",
            bill_object_store_key="test/bill.pdf",
            bill_size_bytes=1,
            bill_sha256="2" * 64,
            interval_filename="interval.csv",
            interval_content_type="text/csv",
            interval_object_store_key="test/interval.csv",
            interval_size_bytes=1,
            interval_sha256=INTERVAL_SHA256,
            inspection_result_json={},
            created_by_actor_id=actor.actor_id,
            updated_by_actor_id=actor.actor_id,
            created_at=now,
            updated_at=now,
        )
    )
    project_row = session.get(CiProjectModel, project_id)
    assert project_row is not None
    project_row.design_candidates_json = _candidates()
    project_row.design_candidate_count = len(_candidates())
    session.flush()
    return project_id


def _record(
    session,
    *,
    project_id: UUID,
    result: dict[str, object],
    scenario_ids: list[str],
    expected_design_sha256: str | None = None,
) -> dict[str, object]:
    return record_ci_tariff_replay_result(
        session,
        project_id=project_id,
        actor=local_actor(),
        expected_interval_sha256=INTERVAL_SHA256,
        expected_design_candidates_sha256=(
            expected_design_sha256
            if expected_design_sha256 is not None
            else design_candidates_sha256(_candidates())
        ),
        expected_tariff_profile_sha256=tariff_profile_sha256(TARIFF_PROFILE),
        expected_scenario_ids=scenario_ids,
        active_tariff_profile=TARIFF_PROFILE,
        result=result,
        merge_checkpoint=True,
    )


def test_checkpoint_batches_merge_idempotently_without_adding_currency_values(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "tariff-checkpoints.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)

    scenario_a = _scenario_result(
        "scenario-a",
        raw_demand_kva=210.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        scenario_cost_aud=800.0,
    )
    scenario_b = _scenario_result(
        "scenario-b",
        raw_demand_kva=180.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        scenario_cost_aud=700.0,
    )

    with session_factory.begin() as session:
        first = _record(
            session,
            project_id=project_id,
            result=_result(scenario_a),
            scenario_ids=["scenario-a"],
        )
    assert first["status"] == "ready"
    assert [item["scenario_id"] for item in first["result"]["scenarios"]] == [
        "scenario-a"
    ]

    with session_factory.begin() as session:
        second = _record(
            session,
            project_id=project_id,
            result=_result(scenario_b),
            scenario_ids=["scenario-b"],
        )
    assert [
        (item["scenario_id"], item["physical_review_rank"])
        for item in second["result"]["scenarios"]
    ] == [("scenario-b", 1), ("scenario-a", 2)]
    assert {
        item["scenario_id"]: item["annual_tariff_value"][
            "scenario_cost_ex_gst_aud"
        ]
        for item in second["result"]["scenarios"]
    } == {"scenario-a": 800.0, "scenario-b": 700.0}

    with session_factory() as session:
        row = session.get(CiProjectTariffReplayResultModel, project_id)
        assert row is not None
        digest_before_retry = row.result_sha256
        updated_at_before_retry = row.updated_at

    with session_factory.begin() as session:
        retry = _record(
            session,
            project_id=project_id,
            result=_result(scenario_b),
            scenario_ids=["scenario-b"],
        )
    assert retry["result"] == second["result"]

    with session_factory() as session:
        row = session.get(CiProjectTariffReplayResultModel, project_id)
        assert row is not None
        assert row.result_sha256 == digest_before_retry
        assert row.updated_at == updated_at_before_retry
        state = ci_tariff_replay_state(
            session,
            project_id=project_id,
            actor=local_actor(),
            active_tariff_profile=TARIFF_PROFILE,
        )
        assert state["status"] == "ready"
        assert state["result"] == second["result"]


def test_checkpoint_merge_resets_old_snapshot_but_rejects_inflight_change_and_conflict(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "tariff-checkpoint-conflict.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)

    scenario_a = _scenario_result(
        "scenario-a",
        raw_demand_kva=210.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        scenario_cost_aud=800.0,
    )
    with session_factory.begin() as session:
        _record(
            session,
            project_id=project_id,
            result=_result(scenario_a),
            scenario_ids=["scenario-a"],
        )

    conflicting_a = _scenario_result(
        "scenario-a",
        raw_demand_kva=210.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        scenario_cost_aud=799.0,
    )
    with pytest.raises(CiProjectError) as conflict:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=_result(conflicting_a),
                scenario_ids=["scenario-a"],
            )
    assert conflict.value.code == (
        "ci_project_tariff_replay_checkpoint_result_conflict"
    )

    changed_candidates = [
        {**candidate, "label": f"{candidate['label']} revised"}
        for candidate in _candidates()
    ]
    with session_factory.begin() as session:
        project = session.get(CiProjectModel, project_id)
        assert project is not None
        project.design_candidates_json = changed_candidates

    scenario_b = _scenario_result(
        "scenario-b",
        raw_demand_kva=180.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        scenario_cost_aud=700.0,
    )
    with pytest.raises(CiProjectError) as changed_during_run:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=_result(scenario_b),
                scenario_ids=["scenario-b"],
            )
    assert changed_during_run.value.code == (
        "ci_project_tariff_replay_inputs_changed"
    )

    with session_factory.begin() as session:
        reset = _record(
            session,
            project_id=project_id,
            result=_result(scenario_b),
            scenario_ids=["scenario-b"],
            expected_design_sha256=design_candidates_sha256(
                changed_candidates
            ),
        )
    assert [
        item["scenario_id"] for item in reset["result"]["scenarios"]
    ] == ["scenario-b"]

    with session_factory() as session:
        row = session.get(CiProjectTariffReplayResultModel, project_id)
        assert row is not None
        assert [
            item["scenario_id"] for item in row.result_json["scenarios"]
        ] == ["scenario-b"]
        assert row.design_candidates_sha256 == design_candidates_sha256(
            changed_candidates
        )


def test_saved_replay_without_current_calculation_revision_is_stale(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "tariff-old-calculation.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)
        _record(
            session,
            project_id=project_id,
            result=_result(
                _scenario_result(
                    "scenario-a",
                    raw_demand_kva=210.0,
                    pv_kwp=100.0,
                    battery_kwh=200.0,
                    scenario_cost_aud=800.0,
                )
            ),
            scenario_ids=["scenario-a"],
        )
        row = session.get(CiProjectTariffReplayResultModel, project_id)
        assert row is not None
        old_result = dict(row.result_json)
        old_result.pop("calculation_revision")
        row.result_json = old_result
        row.result_sha256 = canonical_sha256(old_result)

    with session_factory() as session:
        state = ci_tariff_replay_state(
            session,
            project_id=project_id,
            actor=local_actor(),
            active_tariff_profile=TARIFF_PROFILE,
        )

    assert state["status"] == "stale"
    assert state["result"] is None
    assert state["stale_reasons"] == [
        "result_calculation_revision_unsupported"
    ]

    replacement = _scenario_result(
        "scenario-b",
        raw_demand_kva=180.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        scenario_cost_aud=700.0,
    )
    with session_factory.begin() as session:
        refreshed = _record(
            session,
            project_id=project_id,
            result=_result(replacement),
            scenario_ids=["scenario-b"],
        )

    assert refreshed["status"] == "ready"
    assert refreshed["result"]["calculation_revision"] == (
        "ci_physical_scenario_planner_limits_primal_simplex_v1"
    )
    assert [
        item["scenario_id"] for item in refreshed["result"]["scenarios"]
    ] == ["scenario-b"]
