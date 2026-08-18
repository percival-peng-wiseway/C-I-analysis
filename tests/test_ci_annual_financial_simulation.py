from __future__ import annotations

import json

from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


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


def _physical_result(_upload, *, profile, scenarios):
    results = []
    for scenario in scenarios:
        battery = float(scenario["nominal_capacity_kwh"]) > 0
        cost_ex = 60000.0 if battery else 70000.0
        results.append(
            {
                "scenario_id": scenario["scenario_id"],
                "label": scenario["label"],
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
        "profile": {"profile_id": "test", "display_label": "Test profile", "source_version": "v1"},
        "baseline": {"raw_rolling_demand_kva": 300.0},
        "scenarios": results,
    }


def test_project_annual_finance_compares_pv_only_with_battery_and_projects_cashflow(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {})
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
