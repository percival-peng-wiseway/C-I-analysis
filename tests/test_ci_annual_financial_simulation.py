from __future__ import annotations

import json
from uuid import UUID

import pytest

from solar_battery.ci_annual_financial_comparison import (
    compare_ci_annual_financial_scenarios,
)
from solar_battery.ci_project_annual_financial import (
    ci_annual_financial_state,
    record_ci_annual_financial_result,
)
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_projects import CiProjectError, create_ci_project
from solar_battery.ci_rebate_rules import ci_rebate_ruleset_sha256
from solar_battery.durable_cockpit.orm import CiProjectAnnualFinancialResultModel
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    local_actor,
    sqlite_url_for_path,
)


def _scenario() -> dict[str, object]:
    return {
        "scenario_id": "pv-001__battery-001",
        "label": "100 kWp + 200 kWh",
        "battery_system_id": "battery-001",
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_system_id": "pv-001",
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": 100.0,
        "pv_inverter_capacity_kw_ac": 80.0,
        "shared_ac_headroom_kw": 250.0,
        "reactive_support_enabled": False,
        "reactive_support_max_kvar": 0.0,
        "shared_inverter_apparent_power_limit_kva": None,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": 1500.0,
        "pv_derating_factor": 0.88,
        "nominal_capacity_kwh": 200.0,
        "max_charge_kw": 100.0,
        "max_discharge_kw": 100.0,
        "charge_efficiency": 0.9486832981,
        "discharge_efficiency": 0.9486832981,
        "min_soc_fraction": 0.1,
        "max_soc_fraction": 1.0,
        "initial_soc_fraction": 1.0,
        "allow_grid_charging": False,
    }


def _catalog() -> dict[str, object]:
    return {
        "contract_version": "ci_pricing_catalog_v1",
        "catalog_id": "ci_solution_pricing",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "products": [
            {
                "item_id": "battery",
                "label": "Battery",
                "category": "battery",
                "pricing_basis": "fixed",
                "unit_price_aud": 50000.0,
                "effective_status": "active",
            }
        ],
        "installation_items": [
            {
                "item_id": "install",
                "label": "Installation",
                "pricing_basis": "fixed",
                "unit_price_aud": 10000.0,
                "effective_status": "active",
            }
        ],
    }


def _device_profile() -> dict[str, object]:
    from solar_battery.ci_device_profile import suggested_ci_device_profile

    return suggested_ci_device_profile()


def _physical_result(_upload, *, profile, scenarios):
    results = []
    for index, scenario in enumerate(scenarios, start=1):
        battery = float(scenario["nominal_capacity_kwh"]) > 0
        cost_ex = 60000.0 if battery else 70000.0
        results.append(
            {
                "scenario_id": scenario["scenario_id"],
                "label": scenario["label"],
                "physical_review_rank": index,
                "authored_inputs": {
                    key: value
                    for key, value in scenario.items()
                    if key not in {"scenario_id", "label"}
                },
                "post_dispatch": {"raw_rolling_demand_kva": 220.0 if battery else 250.0},
                "annual_tariff_value": {
                    "calculation_method": "representative_year_repeat_v1",
                    "period_start": "2025-01-01",
                    "period_end": "2025-12-31",
                    "rate_basis": "synthetic-evidence",
                    "baseline_cost_ex_gst_aud": 100000.0,
                    "scenario_cost_ex_gst_aud": cost_ex,
                    "first_year_value_ex_gst_aud": 100000.0 - cost_ex,
                    "baseline_cost_inc_gst_aud": 110000.0,
                    "scenario_cost_inc_gst_aud": cost_ex * 1.1,
                    "first_year_value_inc_gst_aud": 110000.0 - cost_ex * 1.1,
                    "category_savings_ex_gst_aud": {},
                    "customer_facing_permission": False,
                },
            }
        )
    return {
        "contract_version": "ci_physical_scenario_review_v6",
        "calculation_revision": "ci_physical_scenario_planner_limits_primal_simplex_v1",
        "analysis_status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "currency_values_permitted": True,
        "profile": {"profile_id": "test", "display_label": "Test profile", "source_version": "v1"},
        "baseline": {"raw_rolling_demand_kva": 300.0},
        "scenarios": results,
        "report_preview": {"download_available": False},
    }


def _feasibility_result(scenarios: list[dict[str, object]]) -> dict[str, object]:
    return {
        "contract_version": "ci_design_feasibility_v5",
        "status": "ready",
        "analysis_mode": "pre_tariff_physical_feasibility",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "tariff_evaluated": False,
        "currency_values_permitted": False,
        "physical_review_order": {
            "algorithm_id": "ci_pre_tariff_physical_review_order_v2",
            "shortlist_count": min(10, len(scenarios)),
            "basis": "Test physical review order only.",
            "recommendation_permitted": False,
        },
        "scenarios": [
            {
                "scenario_id": item["scenario_id"],
                "label": item["label"],
                "physical_review_rank": index,
                "recommendation_permitted": False,
            }
            for index, item in enumerate(scenarios, start=1)
        ],
    }


def _persistable_finance_result(
    *, project_id: UUID, tariff_replay_result: dict[str, object]
) -> dict[str, object]:
    result = compare_ci_annual_financial_scenarios(
        tariff_replay_result=tariff_replay_result,
        request={
            "pricing_mode": "manual_quotes",
            "prices": [
                {
                    "scenario_id": "pv-001__battery-001",
                    "upfront_cost_aud_ex_gst": 90_000.0,
                }
            ],
        },
    )
    result["project_id"] = str(project_id)
    return result


def test_annual_finance_rejects_result_bound_to_another_tariff_replay(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "finance-result-binding.sqlite3")
    )
    actor = local_actor()
    with session_factory.begin() as session:
        project = create_ci_project(
            session,
            display_name="Finance result binding",
            actor=actor,
        )
        project_id = UUID(str(project["project_id"]))

    tariff_replay_result = _physical_result(
        None,
        profile={},
        scenarios=[_scenario()],
    )
    expected_sha256 = canonical_sha256(tariff_replay_result)
    result = _persistable_finance_result(
        project_id=project_id,
        tariff_replay_result=tariff_replay_result,
    )
    result["source_tariff_replay_sha256"] = "f" * 64

    with session_factory.begin() as session:
        with pytest.raises(CiProjectError) as error:
            record_ci_annual_financial_result(
                session,
                project_id=project_id,
                actor=actor,
                expected_tariff_replay_result_sha256=expected_sha256,
                expected_rebate_profile_sha256=None,
                active_tariff_replay_result=tariff_replay_result,
                result=result,
            )
    assert error.value.code == "ci_project_annual_financial_result_invalid"


def test_annual_finance_restore_rejects_tampered_tariff_replay_binding(
    tmp_path,
) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "finance-restore-binding.sqlite3")
    )
    actor = local_actor()
    with session_factory.begin() as session:
        project = create_ci_project(
            session,
            display_name="Finance restore binding",
            actor=actor,
        )
        project_id = UUID(str(project["project_id"]))

    tariff_replay_result = _physical_result(
        None,
        profile={},
        scenarios=[_scenario()],
    )
    expected_sha256 = canonical_sha256(tariff_replay_result)
    result = _persistable_finance_result(
        project_id=project_id,
        tariff_replay_result=tariff_replay_result,
    )
    with session_factory.begin() as session:
        saved = record_ci_annual_financial_result(
            session,
            project_id=project_id,
            actor=actor,
            expected_tariff_replay_result_sha256=expected_sha256,
            expected_rebate_profile_sha256=None,
            active_tariff_replay_result=tariff_replay_result,
            result=result,
        )
    assert saved["status"] == "ready"

    with session_factory.begin() as session:
        row = session.get(CiProjectAnnualFinancialResultModel, project_id)
        assert row is not None
        tampered = dict(row.result_json)
        tampered["source_tariff_replay_sha256"] = "f" * 64
        row.result_json = tampered
        row.result_sha256 = canonical_sha256(tampered)

    with session_factory() as session:
        with pytest.raises(CiProjectError) as error:
            ci_annual_financial_state(
                session,
                project_id=project_id,
                actor=actor,
                active_tariff_replay_result=tariff_replay_result,
            )
    assert error.value.code == "ci_project_annual_financial_result_invalid"


def test_project_annual_finance_compares_pv_only_with_battery_and_projects_cashflow(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.approved_ci_project_tariff_calculation_profile",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _nem12, **_kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": "ready_for_profile_review",
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_annual_financial_simulation.analyze_ci_physical_scenarios",
        _physical_result,
    )
    with create_test_client(sqlite_url_for_path(tmp_path / "annual-finance.sqlite3")) as client:
        project = client.post(
            "/api/commercial-industrial/projects", json={"display_name": "Factory"}
        ).json()
        client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("bill.pdf", b"synthetic", "application/pdf"),
                "nem12": ("nem12.csv", b"synthetic", "text/csv"),
            },
        )
        saved = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates",
            json={"scenarios": [_scenario()]},
        )
        assert saved.status_code == 200
        draft = client.post("/api/commercial-industrial/pricing-catalog/drafts").json()
        updated = client.put(
            f"/api/commercial-industrial/pricing-catalog/drafts/{draft['catalog_version_id']}",
            json={"catalog": _catalog()},
        ).json()
        assert "catalog_hash" in updated, updated
        published = client.post(
            f"/api/commercial-industrial/pricing-catalog/drafts/{draft['catalog_version_id']}/publish",
            json={"expected_catalog_hash": updated["catalog_hash"]},
        )
        assert published.status_code == 200

        response = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-simulation",
            files={"file": ("nem12.csv", b"synthetic", "text/csv")},
            data={
                "payload": json.dumps(
                    {
                        "scenario_id": "pv-001__battery-001",
                        "value_basis": "battery_incremental",
                        "pricing_catalog_version_id": draft["catalog_version_id"],
                        "product_ids": ["battery"],
                        "installation_item_ids": ["install"],
                        "discount_rate": 0.08,
                        "annual_value_degradation_rate": 0.0,
                        "analysis_term_years": 10,
                    }
                )
            },
        )
        assert response.status_code == 200
        result = response.json()
        assert result["contract_version"] == "ci_annual_financial_simulation_v1"
        assert [item["case_id"] for item in result["cases"]] == [
            "no_system",
            "pv_only",
            "pv_battery",
        ]
        assert result["battery_incremental_value"]["ex_gst_aud"] == 10000.0
        assert result["financial_projection"]["assumptions"]["upfront_cost_aud"] == 60000.0
        assert result["financial_projection"]["assumptions"]["first_year_net_value_aud"] == 10000.0
        assert len(result["financial_projection"]["metrics"]["annual_cashflows_aud"]) == 10
        assert result["customer_facing_permission"] is False
        assert result["recommendation_permitted"] is False

        refreshed = client.get("/api/commercial-industrial/projects").json()["projects"][0]
        assert refreshed["current_stage"] == "financial_simulation"
        assert refreshed["design_status"] == "ready"


def test_project_annual_finance_prices_selected_tariff_scenarios_and_ranks_by_npv(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.approved_ci_project_tariff_calculation_profile",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _nem12, **_kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": "ready_for_profile_review",
            "bill": {
                "review_status": "analyst_confirmed",
                "network_tariff_code": "TEST",
                "site_address": "10 Collins Street Melbourne VIC 3000",
            },
            "nem12": {"full_tariff_analysis_ready": True},
        },
    )
    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_physical_scenarios",
        _physical_result,
    )
    scenarios = [
        _scenario(),
        {
            **_scenario(),
            "scenario_id": "pv-002__battery-001",
            "label": "120 kWp + 200 kWh",
            "pv_system_id": "pv-002",
            "pv_capacity_kwp_dc": 120.0,
            "pv_inverter_capacity_kw_ac": 90.0,
        },
        {
            **_scenario(),
            "scenario_id": "pv-003__battery-001",
            "label": "140 kWp + 200 kWh",
            "pv_system_id": "pv-003",
            "pv_capacity_kwp_dc": 140.0,
            "pv_inverter_capacity_kw_ac": 150.0,
        },
    ]
    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_design_feasibility",
        lambda _upload, *, scenarios: _feasibility_result(scenarios),
    )
    with create_test_client(sqlite_url_for_path(tmp_path / "annual-compare.sqlite3")) as client:
        project = client.post(
            "/api/commercial-industrial/projects", json={"display_name": "Factory"}
        ).json()
        client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("bill.pdf", b"synthetic", "application/pdf"),
                "nem12": ("nem12.csv", b"synthetic", "text/csv"),
            },
        )
        saved = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates",
            json={"scenarios": scenarios},
        )
        assert saved.status_code == 200, saved.json()
        feasibility = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        )
        assert feasibility.status_code == 200, feasibility.json()
        device_profile = client.put(
            "/api/commercial-industrial/settings/device-profile",
            json=_device_profile(),
        )
        assert device_profile.status_code == 200, device_profile.json()
        tariff = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/tariff-replay"
        )
        assert tariff.status_code == 200, tariff.json()
        not_yet_calculated = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison"
        ).json()
        assert not_yet_calculated["status"] == "not_saved"
        calculated = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison",
            json={
                "pricing_mode": "device_profile",
                "prices": [],
                "equipment_selection": _device_profile()[
                    "default_equipment_selection"
                ],
            },
        )
        assert calculated.status_code == 200, calculated.json()
        automatic = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison"
        ).json()
        assert automatic["status"] == "ready"
        assert automatic["result"]["assumptions"]["price_source"] == "workspace_device_profile"
        assert automatic["result"]["shortlist_source"]["shortlist_count"] == 3
        auto_by_id = {
            item["scenario_id"]: item for item in automatic["result"]["solutions"]
        }
        assert auto_by_id[scenarios[0]["scenario_id"]][
            "upfront_cost_aud_ex_gst"
        ] == 135883.81
        assert auto_by_id[scenarios[0]["scenario_id"]][
            "capex_breakdown_aud_ex_gst"
        ] == {"pv_aud": 53000.0, "battery_aud": 73883.81, "inverter_aud": 9000.0}
        assert auto_by_id[scenarios[2]["scenario_id"]][
            "capex_breakdown_aud_ex_gst"
        ]["inverter_aud"] == 12000.0
        changed_profile = client.put(
            "/api/commercial-industrial/settings/device-profile",
            json={**_device_profile(), "battery_cost_aud_per_kwh": 500.0},
        )
        assert changed_profile.status_code == 200
        stale = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison"
        ).json()
        assert stale["status"] == "stale"
        assert "device_profile_changed" in stale["stale_reasons"]

        response = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison",
            json={
                "prices": [
                    {
                        "scenario_id": scenarios[0]["scenario_id"],
                        "upfront_cost_aud_ex_gst": 90000.0,
                    },
                    {
                        "scenario_id": scenarios[1]["scenario_id"],
                        "upfront_cost_aud_ex_gst": 60000.0,
                    },
                    {
                        "scenario_id": scenarios[2]["scenario_id"],
                        "upfront_cost_aud_ex_gst": 75000.0,
                    },
                ]
            },
        )
        assert response.status_code == 200, response.json()
        result = response.json()
        assert result["contract_version"] == "ci_annual_financial_comparison_v4"
        assert result["assumptions"] == {
            "currency": "AUD",
            "tax_basis": "gst_exclusive",
            "price_source": "analyst_entered_total_solution_price",
            "device_profile_sha256": None,
            "device_prices": None,
            "equipment_selection": None,
            "rebate_profile_sha256": None,
            "rebate_ruleset_id": "au_ci_rebates_2026_v1",
            "rebate_ruleset_sha256": ci_rebate_ruleset_sha256(),
            "rebate_application_basis": (
                "not_deducted_from_analyst_entered_manual_quote"
            ),
            "discount_rate": 0.08,
            "annual_value_escalation_rate": 0.025,
            "annual_value_degradation_rate": 0.005,
            "annual_om_fraction_of_capex": 0.015,
            "analysis_term_years": 15,
            "replacement_events_aud": [],
        }
        assert result["financial_review_order"]["leader_scenario_id"] == scenarios[1]["scenario_id"]
        assert [item["financial_review_rank"] for item in result["solutions"]] == [1, 2, 3]
        assert [item["upfront_cost_aud_ex_gst"] for item in result["solutions"]] == [
            60000.0,
            75000.0,
            90000.0,
        ]
        assert all(
            item["gross_upfront_cost_aud_ex_gst"]
            == item["upfront_cost_aud_ex_gst"]
            and item["upfront_rebate_aud_ex_gst"] == 0
            and item["rebate_application_status"]
            == "not_applied_to_manual_quote"
            for item in result["solutions"]
        )
        assert result["assumptions"]["rebate_profile_sha256"] is None
        assert all(len(item["metrics"]["annual_cashflows_aud"]) == 15 for item in result["solutions"])
        assert result["customer_facing_permission"] is False
        assert result["recommendation_permitted"] is False
        restored = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison"
        ).json()
        assert restored["status"] == "ready"
        assert restored["result"] == result

        selected_one = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison",
            json={
                "prices": [
                    {
                        "scenario_id": scenarios[0]["scenario_id"],
                        "upfront_cost_aud_ex_gst": 90000.0,
                    }
                ]
            },
        )
        assert selected_one.status_code == 200
        assert selected_one.json()["shortlist_source"]["shortlist_count"] == 1

        rebate_profile = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/rebate-profile"
        ).json()["suggested_profile"]
        rebate_profile["site_location_confirmed"] = True
        rebate_profile["site_location_source_label"] = "Analyst-reviewed bill address"
        rebate_profile["programs"]["solar_stc"].update(
            {
                "enabled": True,
                "eligibility_confirmed": True,
                "eligibility_source_label": "CER eligibility reviewed",
                "price_source_label": "Current broker evidence",
                "postcode_zone_rating": 1.382,
                "zone_source_label": "CER postcode zone table",
            }
        )
        draft_rebate = client.put(
            f"/api/commercial-industrial/projects/{project['project_id']}/rebate-profile",
            json={
                "profile": rebate_profile,
                "approve_for_calculation": False,
            },
        )
        assert draft_rebate.status_code == 200
        blocked_saved_finance = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/annual-financial-comparison"
        ).json()
        assert blocked_saved_finance["status"] == "stale"
        assert blocked_saved_finance["result"] is None
        assert "rebate_profile_approval_required" in blocked_saved_finance[
            "stale_reasons"
        ]
