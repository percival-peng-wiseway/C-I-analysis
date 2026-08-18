from __future__ import annotations

import json

import pytest

from solar_battery.ci_financial_solutions import (
    CiFinancialSolutionError,
    _canonical_sha256,
    _optimizer_evidence as validate_optimizer_evidence,
    calculate_metrics,
)
from solar_battery.ci_peak_shaving_optimizer import (
    CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
)
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def _payload(label: str = "Battery A") -> dict[str, object]:
    return {
        "label": label,
        "scenario_id": "scenario-a",
        "source_physical_scenario": {
            "scenario_id": "scenario-a",
            "authored_inputs": {"nominal_capacity_kwh": 500.0, "max_discharge_kw": 250.0, "pv_capacity_kwp_dc": 100.0, "pv_inverter_capacity_kw_ac": 80.0, "reactive_support_enabled": True, "reactive_support_max_kvar": 80.0, "shared_inverter_apparent_power_limit_kva": 275.0, "reactive_capability_curve": "circular_pq", "reactive_capability_provenance": "analyst_assumption", "reactive_overcompensation_permitted": False},
            "post_dispatch": {"raw_rolling_demand_kva": 390.0},
            "annual_tariff_value": _tariff_value(25000.0),
        },
        "assumptions": {
            "discount_rate": 0.08,
            "annual_value_degradation_rate": 0.0,
            "analysis_term_years": 10,
        },
    }


def _tariff_value(value_ex_gst: float) -> dict[str, object]:
    return {
        "calculation_method": "representative_year_repeat_v1",
        "period_start": "2025-06-01",
        "period_end": "2026-05-31",
        "rate_basis": "synthetic",
        "baseline_cost_ex_gst_aud": 100000.0,
        "scenario_cost_ex_gst_aud": 100000.0 - value_ex_gst,
        "first_year_value_ex_gst_aud": value_ex_gst,
        "baseline_cost_inc_gst_aud": 110000.0,
        "scenario_cost_inc_gst_aud": 110000.0 - value_ex_gst * 1.1,
        "first_year_value_inc_gst_aud": value_ex_gst * 1.1,
        "category_savings_ex_gst_aud": {"energy_charges": value_ex_gst},
        "customer_facing_permission": False,
    }


def _optimizer_evidence(scenario: dict[str, object]) -> dict[str, object]:
    authored_inputs = {
        key: value
        for key, value in scenario.items()
        if key not in {"scenario_id", "label"}
    }
    snapshot_without_hash = {
        "contract_version": "ci_optimizer_run_snapshot_v2",
        "algorithm_id": CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
        "solver_version": "test-stub",
        "status": "optimal_lp_exact",
        "planner_status": "optimal_lp_exact",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "input_projection": {
            "scenario_sha256": _canonical_sha256(
                {
                    "scenario_id": scenario["scenario_id"],
                    "label": scenario["label"],
                    **authored_inputs,
                }
            )
        },
        "physical_assumptions": {"shared_ac_headroom_kw": 250.0, "reactive_support": {"enabled": True, "max_reactive_support_kvar": 80.0, "inverter_apparent_power_limit_kva": 275.0, "capability_curve": "circular_pq", "provenance": "analyst_assumption", "overcompensation_permitted": False}},
        "result_projection": {"interval_dispatch_sha256": "0" * 64},
        "corrections": [],
        "disclosures": [],
    }
    snapshot_hash = _canonical_sha256(snapshot_without_hash)
    return {
        "post_dispatch": {
            "authority_source": CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
            "raw_rolling_demand_kva": 390.0,
        },
        "optimizer_run_snapshot": {
            **snapshot_without_hash,
            "snapshot_sha256": snapshot_hash,
        },
        "optimizer_audit_projection": {
            "contract_version": "ci_optimizer_audit_projection_v2",
            "snapshot_sha256": snapshot_hash,
            "customer_facing_permission": False,
            "recommendation_permitted": False,
        },
    }


@pytest.fixture(autouse=True)
def _authoritative_physical_rerun(monkeypatch) -> None:
    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {})

    def analyze(_upload, *, profile, scenarios):
        scenario = scenarios[0]
        return {
            "scenarios": [{
                "scenario_id": scenario["scenario_id"],
                "label": scenario["label"],
                "authored_inputs": {
                    key: value
                    for key, value in scenario.items()
                    if key not in {"scenario_id", "label"}
                },
                **_optimizer_evidence(scenario),
                "annual_tariff_value": _tariff_value(25000.0),
            }]
        }

    monkeypatch.setattr("api.ci_routes.analyze_ci_physical_scenarios", analyze)


def _post_solution(client, payload: dict[str, object]):
    return client.post(
        "/api/commercial-industrial/financial-solutions",
        files={"file": ("synthetic.csv", b"synthetic", "text/csv")},
        data={"payload": json.dumps(payload)},
    )


def _catalog() -> dict[str, object]:
    return {
        "contract_version": "ci_pricing_catalog_v1",
        "catalog_id": "ci_solution_pricing",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "products": [{
            "item_id": "battery",
            "label": "Battery",
            "category": "battery",
            "pricing_basis": "size_cost_table",
            "size_metric": "battery_kwh",
            "replacement_interval_years": 8,
            "cost_rows": [
                {"size": 400.0, "capital_cost_aud": 65000.0, "replacement_cost_aud": 20000.0, "annual_om_cost_aud": 800.0},
                {"size": 500.0, "capital_cost_aud": 75000.0, "replacement_cost_aud": 25000.0, "annual_om_cost_aud": 1000.0},
            ],
            "effective_status": "active",
        }],
        "installation_items": [{"item_id": "install", "label": "Installation", "pricing_basis": "fixed", "unit_price_aud": 25000.0, "effective_status": "active"}],
    }


def _publish_catalog(client) -> str:
    draft = client.post("/api/commercial-industrial/pricing-catalog/drafts").json()
    updated = client.put(
        f"/api/commercial-industrial/pricing-catalog/drafts/{draft['catalog_version_id']}",
        json={"catalog": _catalog()},
    ).json()
    published = client.post(
        f"/api/commercial-industrial/pricing-catalog/drafts/{draft['catalog_version_id']}/publish",
        json={"expected_catalog_hash": updated["catalog_hash"]},
    )
    assert published.status_code == 200
    return draft["catalog_version_id"]


def test_python_finance_owns_npv_payback_and_irr() -> None:
    metrics = calculate_metrics({"upfront_cost_aud": 100000.0, "first_year_net_value_aud": 25000.0, **_payload()["assumptions"]})
    assert metrics["net_present_value_aud"] == 67752.03
    assert metrics["payback_period_years"] == 4.0
    assert metrics["internal_rate_of_return"] == 0.214065


def test_python_finance_applies_catalog_om_and_replacement_cashflows() -> None:
    assumptions = {
        "upfront_cost_aud": 100000.0,
        "first_year_net_value_aud": 25000.0,
        "annual_om_cost_aud": 1000.0,
        "replacement_events_aud": [{"year": 5, "amount_aud": 20000.0}],
        "discount_rate": 0.08,
        "annual_value_degradation_rate": 0.0,
        "analysis_term_years": 10,
    }

    metrics = calculate_metrics(assumptions)

    assert metrics["annual_cashflows_aud"][0] == 24000.0
    assert metrics["annual_cashflows_aud"][4] == 4000.0
    assert metrics["net_present_value_aud"] == 47430.29


def test_financial_solution_save_list_and_star_are_workspace_persistent(tmp_path) -> None:
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-finance.sqlite3")) as client:
        version_id = _publish_catalog(client)
        payload = _payload() | {"pricing_catalog_version_id": version_id, "product_ids": ["battery"], "installation_item_ids": ["install"]}
        payload["source_physical_scenario"]["annual_tariff_value"] = _tariff_value(999999.0)
        created = _post_solution(client, payload)
        assert created.status_code == 201
        solution = created.json()
        assert solution["contract_version"] == "ci_financial_solution_v4"
        assert solution["customer_facing_permission"] is False
        assert solution["starred"] is False
        assert solution["assumptions"]["upfront_cost_aud"] == 100000.0
        assert solution["assumptions"]["annual_om_cost_aud"] == 1000.0
        assert solution["assumptions"]["first_year_net_value_aud"] == 25000.0
        assert solution["assumptions"]["value_source"] == "evidence_bound_tariff_scenario"
        assert solution["assumptions"]["replacement_events_aud"] == [
            {"year": 8, "amount_aud": 25000.0}
        ]
        assert solution["assumptions"]["pricing_resolution"]["tax_basis"] == "gst_exclusive"
        assert (
            solution["optimizer_audit_projection"]["snapshot_sha256"]
            == solution["optimizer_run_snapshot_sha256"]
        )

        listed = client.get("/api/commercial-industrial/financial-solutions")
        assert listed.status_code == 200
        assert [item["solution_id"] for item in listed.json()["solutions"]] == [
            solution["solution_id"]
        ]

        starred = client.patch(
            f"/api/commercial-industrial/financial-solutions/{solution['solution_id']}/star",
            json={"starred": True},
        )
        assert starred.status_code == 200
        assert starred.json()["starred"] is True
        assert (
            starred.json()["optimizer_run_snapshot_sha256"]
            == solution["optimizer_run_snapshot_sha256"]
        )


def test_financial_solution_rejects_tampered_optimizer_snapshot(tmp_path, monkeypatch) -> None:
    def analyze(_upload, *, profile, scenarios):
        scenario = scenarios[0]
        evidence = _optimizer_evidence(scenario)
        evidence["optimizer_run_snapshot"]["status"] = "tampered"
        return {
            "scenarios": [{
                "scenario_id": scenario["scenario_id"],
                "label": scenario["label"],
                "authored_inputs": {
                    key: value
                    for key, value in scenario.items()
                    if key not in {"scenario_id", "label"}
                },
                **evidence,
                "annual_tariff_value": _tariff_value(25000.0),
            }]
        }

    monkeypatch.setattr("api.ci_routes.analyze_ci_physical_scenarios", analyze)
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-finance-tamper.sqlite3")) as client:
        version_id = _publish_catalog(client)
        payload = _payload() | {
            "pricing_catalog_version_id": version_id,
            "product_ids": ["battery"],
            "installation_item_ids": [],
        }
        response = _post_solution(client, payload)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "ci_financial_solution_invalid"


def test_financial_solution_rejects_mismatched_physical_scenario(tmp_path) -> None:
    payload = _payload()
    payload["source_physical_scenario"]["scenario_id"] = "another-scenario"
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-finance-invalid.sqlite3")) as client:
        version_id = _publish_catalog(client)
        payload |= {"pricing_catalog_version_id": version_id, "product_ids": ["battery"], "installation_item_ids": []}
        response = _post_solution(client, payload)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "ci_financial_solution_invalid"


def test_financial_optimizer_digest_rejects_stale_reactive_assumption() -> None:
    scenario = {
        "scenario_id": "scenario-a",
        "label": "Battery A",
        **_payload()["source_physical_scenario"]["authored_inputs"],
    }
    source = {
        "scenario_id": scenario["scenario_id"],
        "label": scenario["label"],
        "authored_inputs": {
            key: value
            for key, value in scenario.items()
            if key not in {"scenario_id", "label"}
        },
        **_optimizer_evidence(scenario),
    }
    source["authored_inputs"]["reactive_support_max_kvar"] = 81.0

    with pytest.raises(
        CiFinancialSolutionError,
        match="optimizer evidence input does not match",
    ):
        validate_optimizer_evidence(source)
