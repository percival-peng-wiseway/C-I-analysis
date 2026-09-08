from uuid import UUID

import pytest

from solar_battery.ci_design_freshness import design_input_changes, require_current_design_inputs
from solar_battery.ci_device_profile import save_ci_device_profile, suggested_ci_device_profile
from solar_battery.ci_project_feasibility import canonical_sha256, ci_design_feasibility_state, record_ci_design_feasibility_result
from solar_battery.ci_project_site_factors import save_site_factors
from solar_battery.ci_project_tariff_replay import ci_tariff_replay_state, record_ci_tariff_replay_result
from solar_battery.ci_projects import create_ci_project, mark_ci_setup_ready, record_ci_design_candidates, require_ci_project, CiProjectError
from solar_battery.ci_solution_generator import generate_ci_solutions
from solar_battery.durable_cockpit.orm import CiProjectFeasibilityResultModel, CiProjectTariffReplayResultModel
from tests.durable_test_helpers import create_sqlite_session_factory, create_test_client, local_actor, sqlite_url_for_path
from tests.test_ci_solution_generator import _request, _device_profile


@pytest.fixture
def configured(tmp_path):
    url = sqlite_url_for_path(tmp_path / "parameter-updates.sqlite3")
    # Initialize the same schema as the application.
    with create_test_client(url):
        pass
    factory = create_sqlite_session_factory(url)
    actor = local_actor()
    profile = suggested_ci_device_profile()
    profile["solution_profiles"]["inverter_profiles"][0]["status"] = "published"
    request = _request(maximum_pv=100)
    request["solar_profile_id"] = profile["default_solution_profile_selection"]["solar_profile_id"]
    request["battery_profile_id"] = profile["default_solution_profile_selection"]["battery_profile_id"]
    request["inverter_profile_id"] = profile["solution_profiles"]["inverter_profiles"][0]["profile_id"]
    with factory.begin() as session:
        state = save_ci_device_profile(session, actor=actor, profile=profile)
        profile = state["profile"]
        project_id = UUID(create_ci_project(session, display_name="Synthetic update audit", actor=actor)["project_id"])
        mark_ci_setup_ready(session, project_id=project_id, actor=actor)
        generated = generate_ci_solutions(request, device_profile=profile, device_profile_sha256=state["profile_sha256"])
        record_ci_design_candidates(session, project_id=project_id, actor=actor, candidate_count=len(generated["candidates"]), candidates=generated["candidates"], design_context=generated["design_context"], persist_site_factors=True)
    return url, factory, actor, project_id, profile, request, generated


def test_saved_site_edits_block_every_calculation_entry_until_regeneration(configured):
    url, factory, actor, project_id, profile, request, generated = configured
    with factory.begin() as session:
        project = require_ci_project(session, project_id=project_id, actor=actor)
        assert not design_input_changes(session, project=project, actor=actor)
        factors = {**request["site_factors"], "shading_loss_percent": 25}
        save_site_factors(session, project_id=project_id, actor=actor, factors=factors)
        assert design_input_changes(session, project=project, actor=actor) == ["Site factors changed"]
    with create_test_client(url) as client:
        for endpoint, payload in [
            ("design-feasibility", {"scenario_ids": [generated["candidates"][0]["scenario_id"]]}),
            ("tariff-replay", {"scenario_ids": [generated["candidates"][0]["scenario_id"]]}),
            ("design-feasibility/interval-activity", {"scenario_id": generated["candidates"][0]["scenario_id"], "start_date": "2026-01-01", "days": 1}),
            ("design-candidates/custom", {"contract_version": "ci_custom_design_candidate_request_v1", "label": "Synthetic option", "pv_capacity_kwp_dc": 120, "battery_capacity_kwh": 50, "inverter_capacity_kw_ac": 125, "quoted_net_capex_aud_ex_gst": 100000}),
        ]:
            result = client.post(f"/api/commercial-industrial/projects/{project_id}/{endpoint}", json=payload)
            assert result.status_code == 409, result.json()
            assert result.json()["detail"]["code"] == "ci_project_design_inputs_changed"
    request["site_factors"] = factors
    updated = generate_ci_solutions(request, device_profile=profile, device_profile_sha256="a" * 64)
    with factory.begin() as session:
        record_ci_design_candidates(session, project_id=project_id, actor=actor, candidate_count=len(updated["candidates"]), candidates=updated["candidates"], design_context=updated["design_context"], persist_site_factors=True)
        require_current_design_inputs(session, project=require_ci_project(session, project_id=project_id, actor=actor), actor=actor)
    assert updated["candidates"][0]["pv_derating_factor"] < generated["candidates"][0]["pv_derating_factor"]


@pytest.mark.parametrize("kind,field,value", [
    ("solar", "default_dc_ac_ratio", 1.4),
    ("battery", "round_trip_efficiency_percent", 80),
    ("battery", "usable_depth_of_discharge_percent", 70),
    ("inverter", "maximum_reactive_power_kvar", 50),
])
def test_selected_performance_edits_require_regeneration(configured, kind, field, value):
    _, factory, actor, project_id, profile, request, generated = configured
    selected = next(item for item in profile["solution_profiles"][f"{kind}_profiles"] if item["status"] == "published")
    selected[field] = value
    with factory.begin() as session:
        save_ci_device_profile(session, actor=actor, profile=profile)
        with pytest.raises(CiProjectError, match=f"selected {kind} profile changed"):
            require_current_design_inputs(session, project=require_ci_project(session, project_id=project_id, actor=actor), actor=actor)
    updated = generate_ci_solutions(request, device_profile=profile, device_profile_sha256=None)
    assert updated["candidates"] != generated["candidates"]


def test_prices_finance_and_reference_fields_do_not_invalidate_physical_operands(configured):
    _, factory, actor, project_id, profile, _, _ = configured
    profile["installation_misc_cost_aud"] = 80000
    profile["discount_rate"] = 0.05
    profile["solution_profiles"]["solar_profiles"][0]["module_efficiency_percent"] = 21
    with factory.begin() as session:
        save_ci_device_profile(session, actor=actor, profile=profile)
        assert not design_input_changes(session, project=require_ci_project(session, project_id=project_id, actor=actor), actor=actor)


def test_existing_results_and_late_checkpoint_writes_fail_closed_on_site_edits(configured):
    _, factory, actor, project_id, _, request, generated = configured
    digest = canonical_sha256(generated["candidates"])
    with factory.begin() as session:
        for model in (CiProjectFeasibilityResultModel, CiProjectTariffReplayResultModel):
            session.add(model(project_id=project_id, workspace_id=actor.workspace_id, owner_id=actor.owner_id,
                              result_contract_version="synthetic", interval_sha256="a" * 64,
                              design_candidates_sha256=digest, result_sha256=canonical_sha256({}), result_json={},
                              created_by_actor_id=actor.actor_id, updated_by_actor_id=actor.actor_id,
                              **({"tariff_profile_sha256": "b" * 64} if model is CiProjectTariffReplayResultModel else {})))
        save_site_factors(session, project_id=project_id, actor=actor, factors={**request["site_factors"], "annual_specific_yield_kwh_per_kw": 1000})
        session.flush()
        for state in (ci_design_feasibility_state(session, project_id=project_id, actor=actor), ci_tariff_replay_state(session, project_id=project_id, actor=actor, active_tariff_profile=None)):
            assert state["status"] == "stale"
            assert "design_changed" in state["stale_reasons"]
            assert state["result"] is None
        for record in (record_ci_design_feasibility_result, record_ci_tariff_replay_result):
            with pytest.raises(CiProjectError, match="Site factors changed"):
                record(session, project_id=project_id, actor=actor, expected_interval_sha256="a" * 64,
                       expected_design_candidates_sha256=digest, expected_scenario_ids=[], result={},
                       **({"expected_tariff_profile_sha256": "b" * 64, "active_tariff_profile": {}} if record is record_ci_tariff_replay_result else {}))


@pytest.mark.parametrize("field,value,operand", [
    ("annual_specific_yield_kwh_per_kw", 1000, "pv_annual_specific_yield_kwh_per_kw"),
    ("shading_loss_percent", 15, "pv_derating_factor"),
    ("soiling_loss_percent", 12, "pv_derating_factor"),
    ("temperature_loss_percent", 10, "pv_derating_factor"),
    ("wiring_mismatch_loss_percent", 7, "pv_derating_factor"),
    ("other_system_loss_percent", 4, "pv_derating_factor"),
    ("system_availability_percent", 95, "pv_derating_factor"),
])
def test_each_site_factor_reaches_generated_calculation_operands(field, value, operand):
    request = _request(maximum_pv=100)
    before = generate_ci_solutions(request, device_profile=_device_profile(), device_profile_sha256=None)
    request["site_factors"][field] = value
    after = generate_ci_solutions(request, device_profile=_device_profile(), device_profile_sha256=None)
    assert before["candidates"][0][operand] != after["candidates"][0][operand]
