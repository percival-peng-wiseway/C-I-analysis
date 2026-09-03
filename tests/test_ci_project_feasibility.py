from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID

import pytest

from solar_battery.ci_project_feasibility import (
    ci_design_feasibility_state,
    design_candidates_sha256,
    record_ci_design_feasibility_result,
)
from solar_battery.ci_projects import CiProjectError, create_ci_project
from solar_battery.durable_cockpit.orm import (
    CiProjectEvidenceModel,
    CiProjectFeasibilityResultModel,
    CiProjectModel,
)
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    local_actor,
    sqlite_url_for_path,
)


INTERVAL_SHA256 = "1" * 64


def _candidates() -> list[dict[str, object]]:
    return [
        {"scenario_id": "scenario-a", "label": "A"},
        {"scenario_id": "scenario-b", "label": "B"},
        {"scenario_id": "scenario-c", "label": "C"},
    ]


def _scenario_result(
    scenario_id: str,
    *,
    energy_reduction_kwh: float,
    peak_reduction_kw: float,
    top_10_coverage_percent: float,
    remaining_peak_kw: float,
    pv_kwp: float,
    battery_kwh: float,
    inverter_kw: float,
) -> dict[str, object]:
    return {
        "scenario_id": scenario_id,
        "physical_review_rank": 1,
        "recommendation_permitted": False,
        "authored_inputs": {
            "pv_capacity_kwp_dc": pv_kwp,
            "nominal_capacity_kwh": battery_kwh,
            "pv_inverter_capacity_kw_ac": inverter_kw,
        },
        "coverage_energy": {
            "grid_import_reduction_kwh": energy_reduction_kwh,
        },
        "coverage_performance": {
            "grid_import_peak_reduction_kw": peak_reduction_kw,
            "top_10_event_coverage_percent": top_10_coverage_percent,
            "grid_import_peak_kw": remaining_peak_kw,
        },
    }


def _result(*scenarios: dict[str, object]) -> dict[str, object]:
    return {
        "contract_version": "ci_design_feasibility_v5",
        "status": "ready",
        "analysis_mode": "pre_tariff_physical_feasibility",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "tariff_evaluated": False,
        "currency_values_permitted": False,
        "coverage": {"interval_minutes": 30, "interval_count": 17_520},
        "baseline": {"peak_kw": 300.0},
        "physical_review_order": {
            "algorithm_id": "ci_pre_tariff_physical_review_order_v2",
            "shortlist_count": min(10, len(scenarios)),
            "basis": "Physical review only.",
            "recommendation_permitted": False,
        },
        "scenarios": list(scenarios),
        "assumptions": [],
    }


def _seed_project(session) -> UUID:
    actor = local_actor()
    project = create_ci_project(
        session,
        display_name="Feasibility checkpoint persistence",
        actor=actor,
    )
    project_id = UUID(str(project["project_id"]))
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
    return record_ci_design_feasibility_result(
        session,
        project_id=project_id,
        actor=local_actor(),
        expected_interval_sha256=INTERVAL_SHA256,
        expected_design_candidates_sha256=(
            expected_design_sha256
            if expected_design_sha256 is not None
            else design_candidates_sha256(_candidates())
        ),
        expected_scenario_ids=scenario_ids,
        result=result,
        merge_checkpoint=True,
    )


def test_checkpoint_batches_merge_rerank_and_retry_idempotently(tmp_path) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "feasibility-checkpoints.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)

    scenario_a = _scenario_result(
        "scenario-a",
        energy_reduction_kwh=100.0,
        peak_reduction_kw=20.0,
        top_10_coverage_percent=40.0,
        remaining_peak_kw=280.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        inverter_kw=100.0,
    )
    scenario_b = _scenario_result(
        "scenario-b",
        energy_reduction_kwh=200.0,
        peak_reduction_kw=30.0,
        top_10_coverage_percent=60.0,
        remaining_peak_kw=270.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        inverter_kw=125.0,
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
    assert second["result"]["physical_review_order"]["shortlist_count"] == 2
    assert second["result"]["customer_facing_permission"] is False
    assert second["result"]["recommendation_permitted"] is False
    assert second["result"]["currency_values_permitted"] is False

    with session_factory() as session:
        row = session.get(CiProjectFeasibilityResultModel, project_id)
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
        row = session.get(CiProjectFeasibilityResultModel, project_id)
        assert row is not None
        assert row.result_sha256 == digest_before_retry
        assert row.updated_at == updated_at_before_retry
        state = ci_design_feasibility_state(
            session,
            project_id=project_id,
            actor=local_actor(),
        )
        assert state["status"] == "ready"
        assert state["result"] == second["result"]


def test_checkpoint_merge_rejects_envelope_scenario_and_integrity_conflicts(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "feasibility-conflicts.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)

    scenario_a = _scenario_result(
        "scenario-a",
        energy_reduction_kwh=100.0,
        peak_reduction_kw=20.0,
        top_10_coverage_percent=40.0,
        remaining_peak_kw=280.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        inverter_kw=100.0,
    )
    scenario_b = _scenario_result(
        "scenario-b",
        energy_reduction_kwh=200.0,
        peak_reduction_kw=30.0,
        top_10_coverage_percent=60.0,
        remaining_peak_kw=270.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        inverter_kw=125.0,
    )
    with session_factory.begin() as session:
        _record(
            session,
            project_id=project_id,
            result=_result(scenario_a),
            scenario_ids=["scenario-a"],
        )

    changed_envelope = _result(scenario_b)
    changed_envelope["baseline"] = {"peak_kw": 301.0}
    with pytest.raises(CiProjectError) as envelope_conflict:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=changed_envelope,
                scenario_ids=["scenario-b"],
            )
    assert envelope_conflict.value.code == (
        "ci_project_feasibility_checkpoint_result_conflict"
    )

    conflicting_a = deepcopy(scenario_a)
    conflicting_a["coverage_energy"]["grid_import_reduction_kwh"] = 101.0
    with pytest.raises(CiProjectError) as scenario_conflict:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=_result(conflicting_a),
                scenario_ids=["scenario-a"],
            )
    assert scenario_conflict.value.code == (
        "ci_project_feasibility_checkpoint_result_conflict"
    )

    with session_factory.begin() as session:
        row = session.get(CiProjectFeasibilityResultModel, project_id)
        assert row is not None
        row.result_sha256 = "f" * 64
    with pytest.raises(CiProjectError) as invalid_integrity:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=_result(scenario_b),
                scenario_ids=["scenario-b"],
            )
    assert invalid_integrity.value.code == "ci_project_feasibility_result_invalid"


def test_checkpoint_merge_resets_old_snapshot_and_rejects_inflight_change(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "feasibility-reset.sqlite3")
    )
    with session_factory.begin() as session:
        project_id = _seed_project(session)

    scenario_a = _scenario_result(
        "scenario-a",
        energy_reduction_kwh=100.0,
        peak_reduction_kw=20.0,
        top_10_coverage_percent=40.0,
        remaining_peak_kw=280.0,
        pv_kwp=100.0,
        battery_kwh=200.0,
        inverter_kw=100.0,
    )
    with session_factory.begin() as session:
        _record(
            session,
            project_id=project_id,
            result=_result(scenario_a),
            scenario_ids=["scenario-a"],
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
        energy_reduction_kwh=200.0,
        peak_reduction_kw=30.0,
        top_10_coverage_percent=60.0,
        remaining_peak_kw=270.0,
        pv_kwp=120.0,
        battery_kwh=300.0,
        inverter_kw=125.0,
    )
    with pytest.raises(CiProjectError) as changed_during_run:
        with session_factory.begin() as session:
            _record(
                session,
                project_id=project_id,
                result=_result(scenario_b),
                scenario_ids=["scenario-b"],
            )
    assert changed_during_run.value.code == "ci_project_feasibility_inputs_changed"

    with session_factory.begin() as session:
        reset = _record(
            session,
            project_id=project_id,
            result=_result(scenario_b),
            scenario_ids=["scenario-b"],
            expected_design_sha256=design_candidates_sha256(changed_candidates),
        )
    assert [
        item["scenario_id"] for item in reset["result"]["scenarios"]
    ] == ["scenario-b"]

    with session_factory() as session:
        row = session.get(CiProjectFeasibilityResultModel, project_id)
        assert row is not None
        assert [
            item["scenario_id"] for item in row.result_json["scenarios"]
        ] == ["scenario-b"]
        assert row.design_candidates_sha256 == design_candidates_sha256(
            changed_candidates
        )
