from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

from solar_battery.ci_project_handbook import build_ci_project_handbook
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def test_project_handbook_is_a_read_only_ledger_for_an_empty_project(tmp_path) -> None:
    database_url = sqlite_url_for_path(tmp_path / "handbook.sqlite3")
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Handbook audit"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]

        response = client.get(
            f"/api/commercial-industrial/projects/{project_id}/calculation-handbook"
        )

    assert response.status_code == 200, response.json()
    payload = response.json()
    assert payload["contract_version"] == "ci_project_handbook_v1"
    assert payload["project"]["project_id"] == project_id
    assert payload["authority"] == {
        "calculation_authority": "python",
        "presentation_authority": "handbook_projection_only",
        "mutation_policy": "controlled_existing_module_inputs",
        "statement": (
            "The Handbook reads saved inputs and results. It does not run or "
            "replace Python calculations."
        ),
    }
    modules = {module["module_id"]: module for module in payload["modules"]}
    assert set(modules) == {
        "evidence",
        "solution_generator",
        "scenario_analysis",
        "finance_analysis",
    }
    assert modules["evidence"]["status"] == "input_required"
    assert modules["solution_generator"]["status"] == "input_required"
    assert modules["scenario_analysis"]["status"] == "not_saved"
    assert modules["finance_analysis"]["status"] == "not_saved"
    formula_ids = {
        formula["calculation_id"]
        for module in modules.values()
        for formula in module["calculations"]
    }
    assert {
        "evidence.apparent_power",
        "solution.net_capex",
        "scenario.soc_balance",
        "finance.npv",
        "finance.irr",
    }.issubset(formula_ids)
    assert payload["summary"]["module_count"] == 4
    assert payload["summary"]["calculation_count"] == len(formula_ids)
    assert response.headers["cache-control"] == "no-store"


def test_project_handbook_does_not_mutate_project_timestamp(tmp_path) -> None:
    database_url = sqlite_url_for_path(tmp_path / "handbook-read-only.sqlite3")
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "No calculation on read"},
        ).json()
        project_id = created["project_id"]
        before = client.get("/api/commercial-industrial/projects").json()["projects"][0]

        first = client.get(
            f"/api/commercial-industrial/projects/{project_id}/calculation-handbook"
        )
        second = client.get(
            f"/api/commercial-industrial/projects/{project_id}/calculation-handbook"
        )
        after = client.get("/api/commercial-industrial/projects").json()["projects"][0]

    assert first.status_code == second.status_code == 200
    assert before["updated_at"] == after["updated_at"]
    assert first.json() == second.json()


def test_project_handbook_projects_saved_price_stc_and_finance_audit_without_recalculation() -> None:
    project = SimpleNamespace(
        id="project-audit",
        display_name="Saved audit",
        updated_at=datetime(2026, 9, 4, tzinfo=timezone.utc),
    )
    candidate = {
        "scenario_id": "scenario-1",
        "label": "PV and battery",
        "pv_capacity_kwp_dc": 100.0,
        "nominal_capacity_kwh": 50.0,
        "pv_inverter_capacity_kw_ac": 80.0,
    }
    price_solution = {
        "scenario_id": "scenario-1",
        "gross_capex_aud_ex_gst": 220_000.0,
        "upfront_rebate_aud_ex_gst": 7_000.0,
        "net_capex_aud_ex_gst": 213_000.0,
        "capex_breakdown_aud_ex_gst": {
            "pv_aud": 53_000.0,
            "battery_aud": 158_000.0,
            "inverter_aud": 9_000.0,
        },
        "rebate_calculation": {
            "total_rebate_aud_ex_gst": 7_000.0,
            "programs": {
                "solar_stc": {
                    "label": "Solar STCs",
                    "status": "applied",
                    "reason_codes": [],
                    "certificate_quantity": 175,
                    "unit_price_aud_ex_gst": 40.0,
                    "rebate_aud_ex_gst": 7_000.0,
                    "formula": {
                        "rule_id": "solar-rule",
                        "rounding": "floor_after_multiplication",
                        "operands": {
                            "system_capacity_kwp_dc": 100.0,
                            "postcode_zone_rating": 1.4,
                            "deeming_years": 1,
                        },
                    },
                },
                "battery_stc": {
                    "label": "Battery STCs",
                    "status": "ineligible",
                    "reason_codes": ["battery_stc_nominal_capacity_out_of_range"],
                    "certificate_quantity": 0,
                    "unit_price_aud_ex_gst": 40.0,
                    "rebate_aud_ex_gst": 0.0,
                    "formula": {
                        "rule_id": "battery-rule",
                        "rounding": "floor_after_all_tiers_summed",
                        "operands": {
                            "nominal_capacity_kwh": 300.0,
                            "claimable_usable_capacity_kwh": 50.0,
                        },
                    },
                },
            },
        },
    }
    device_profile = {
        "equipment_catalog": {
            "pv_products": [
                {
                    "product_id": "pv-a",
                    "manufacturer": "PV Co",
                    "model": "PV 650",
                    "capital_cost_aud_per_kwp_dc": 530.0,
                    "replacement_cost_aud_per_kwp_dc": 500.0,
                    "annual_om_aud": 0.0,
                }
            ],
            "battery_products": [
                {
                    "product_id": "battery-a",
                    "manufacturer": "Battery Co",
                    "model": "Pack 7",
                    "module_capacity_kwh": 7.0,
                    "cost_curve": [
                        {
                            "quantity": 30,
                            "capital_cost_aud": 77_578.0,
                            "replacement_cost_aud": 57_456.0,
                            "annual_om_aud": 0.0,
                        },
                        {
                            "quantity": 42,
                            "capital_cost_aud": 106_154.0,
                            "replacement_cost_aud": 81_864.0,
                            "annual_om_aud": 0.0,
                        },
                    ],
                }
            ],
            "inverter_products": [
                {
                    "product_id": "inverter-a",
                    "manufacturer": "Inverter Co",
                    "model": "PCS 125",
                    "sizing_unit_kw_ac": 125.0,
                    "cost_curve": [
                        {
                            "capacity_kw_ac": 80.0,
                            "capital_cost_aud": 9_000.0,
                            "replacement_cost_aud": 9_000.0,
                            "annual_om_aud": 0.0,
                        },
                        {
                            "capacity_kw_ac": 125.0,
                            "capital_cost_aud": 10_000.0,
                            "replacement_cost_aud": 10_000.0,
                            "annual_om_aud": 0.0,
                        },
                    ],
                }
            ],
        },
        "default_equipment_selection": {
            "pv_product_id": "pv-a",
            "battery_product_id": "battery-a",
            "inverter_product_id": "inverter-a",
        },
    }
    tariff_profile = {
        "factors": {"mlf": 1.01, "dlf": 1.02},
        "rates": {
            "retail_peak_c_per_kwh": 30.0,
            "retail_off_peak_c_per_kwh": 20.0,
            "incentive_demand_aud_per_kva_month": 12.0,
            "rolling_demand_aud_per_kva_month": 15.0,
            "network_peak_c_per_kwh": 10.0,
            "network_off_peak_c_per_kwh": 5.0,
            "aemo_ancillary_c_per_kwh": 1.0,
            "aemo_participant_c_per_kwh": 0.5,
            "aemo_frc_c_per_day": 2.0,
            "environmental_c_per_kwh": 0.8,
            "environmental_certificate_fraction": 1.0,
            "metering_aud_per_day": 2.5,
            "value_added_c_per_day": 25.0,
        },
        "windows": {
            key: {"start": "07:00", "end": "22:00"}
            for key in (
                "retail_energy",
                "network_energy",
                "rolling_demand",
                "incentive_demand",
            )
        },
        "minimum_chargeable_rolling_kva": 50.0,
        "gst_rate": 0.1,
        "additional_bill_adjustment_aud": -5.0,
    }
    tariff_scenario = {
        "scenario_id": "scenario-1",
        "label": "PV and battery",
        "annual_tariff_value": {
            "baseline_cost_ex_gst_aud": 100_000.0,
            "scenario_cost_ex_gst_aud": 75_000.0,
            "first_year_value_ex_gst_aud": 25_000.0,
        },
    }
    finance_solution = {
        "scenario_id": "scenario-1",
        "label": "PV and battery",
        "financial_review_rank": 1,
        "gross_upfront_cost_aud_ex_gst": 205_000.0,
        "upfront_cost_aud_ex_gst": 205_000.0,
        "upfront_rebate_aud_ex_gst": 0.0,
        "rebate_application_status": "not_applied_to_manual_quote",
        "first_year_value_aud_ex_gst": 25_000.0,
        "annual_om_cost_aud_ex_gst": 3_075.0,
        "metrics": {
            "net_present_value_aud": 32_100.25,
            "internal_rate_of_return": 0.102345,
            "payback_period_years": 9.35,
            "lifetime_net_value_undiscounted_aud": 110_500.0,
            "annual_cashflows_aud": [21_925.0, 22_330.0],
        },
    }
    states = {
        "evidence_state": {"status": "not_saved"},
        "design_candidates": [candidate],
        "design_context": {
            "search_space": {},
            "site_factors": {},
            "technical_options": {},
            "profile_selection": {},
        },
        "design_price_preview_state": {
            "status": "ready",
            "preview": {
                "equipment_selection": device_profile[
                    "default_equipment_selection"
                ],
                "solutions": [price_solution],
            },
        },
        "feasibility_state": {"status": "not_saved"},
        "tariff_profile_state": {"status": "approved", "profile": tariff_profile},
        "rebate_profile_state": {
            "status": "approved",
            "profile": {
                "programs": {
                    "solar_stc": {
                        "enabled": True,
                        "certificate_price_aud_ex_gst": 40.0,
                        "price_source_label": "Broker evidence",
                    },
                    "battery_stc": {
                        "enabled": True,
                        "certificate_price_aud_ex_gst": 40.0,
                        "price_source_label": "Broker evidence",
                    },
                }
            },
        },
        "tariff_replay_state": {
            "status": "ready",
            "result": {"scenarios": [tariff_scenario]},
        },
        "annual_financial_state": {
            "status": "ready",
            "result": {
                "assumptions": {
                    "discount_rate": 0.08,
                    "annual_value_escalation_rate": 0.025,
                    "annual_value_degradation_rate": 0.005,
                    "annual_om_fraction_of_capex": 0.015,
                    "analysis_term_years": 15,
                    "price_source": "analyst_entered_total_solution_price",
                    "rebate_application_basis": (
                        "not_deducted_from_analyst_entered_manual_quote"
                    ),
                    "replacement_events_aud": [],
                },
                "solutions": [finance_solution],
            },
        },
        "device_profile_state": {"status": "ready", "profile": device_profile},
    }
    before = deepcopy(states)

    payload = build_ci_project_handbook(project=project, **states)

    assert states == before
    modules = {module["module_id"]: module for module in payload["modules"]}
    solution = modules["solution_generator"]
    finance = modules["finance_analysis"]
    parameters = {item["parameter_id"]: item for item in solution["parameters"]}
    assert parameters["solution.cost.pv.0.capital_cost_aud_per_kwp_dc"]["value"] == 530.0
    assert parameters["solution.cost.battery.0.curve.0.capital_cost_aud"]["value"] == 77_578.0
    assert parameters["solution.cost.inverter.0.curve.1.capacity_kw_ac"]["value"] == 125.0
    assert parameters["solution.cost.battery.0.curve.0.replacement_cost_aud"]["active_in_current_model"] is False

    calculations = {
        item["calculation_id"]: item
        for module in (solution, finance)
        for item in module["calculations"]
    }
    assert calculations["solution.gross_capex"]["current_example"]["result"] == 220_000.0
    assert calculations["solution.net_capex"]["current_example"]["result"] == 213_000.0
    assert calculations["solution.solar_stc"]["current_example"]["result"] == 7_000.0
    assert "battery_stc_nominal_capacity_out_of_range" in calculations[
        "solution.battery_stc"
    ]["current_example"]["substitution"]
    assert calculations["finance.first_year_value"]["current_example"]["result"] == 25_000.0
    assert calculations["finance.manual_quote"]["current_example"]["result"] == 205_000.0
    assert "not_applied_to_manual_quote" in calculations["finance.manual_quote"][
        "current_example"
    ]["substitution"]
    assert calculations["finance.annual_om"]["current_example"]["result"] == 3_075.0
    assert calculations["finance.year_cashflow"]["current_example"]["result"] == 21_925.0
    assert calculations["finance.npv"]["current_example"]["result"] == 32_100.25
    assert calculations["finance.roi"]["formula"] == "undefined in the current authoritative model"
    assert calculations["finance.lcoe"]["current_example"] is None
    assert calculations["finance.lcos"]["current_example"] is None

    rebate_rows = next(
        item for item in solution["result_sets"]
        if item["result_set_id"] == "solution.rebate_audit"
    )["rows"]
    assert {row["values"]["status"] for row in rebate_rows} == {
        "applied",
        "ineligible",
    }
    finance_parameters = {
        item["parameter_id"]: item for item in finance["parameters"]
    }
    assert finance_parameters["finance.one_click_fallback.discount_rate"]["value"] == 0.08
    assert finance_parameters["finance.one_click_fallback.discount_rate"]["active_in_current_model"] is True
    finance_row = finance["result_sets"][0]["rows"][0]["values"]
    assert finance_row["gross_upfront"] == finance_row["net_capex"] == 205_000.0
    assert finance_row["upfront_rebate"] == 0.0


def _direct_handbook(**overrides):
    states = {
        "evidence_state": {"status": "not_saved"},
        "design_candidates": None,
        "design_context": None,
        "design_price_preview_state": {"status": "not_saved"},
        "feasibility_state": {"status": "not_saved"},
        "tariff_profile_state": {"status": "not_available"},
        "rebate_profile_state": {"status": "not_configured"},
        "tariff_replay_state": {"status": "not_saved"},
        "annual_financial_state": {"status": "not_saved"},
        "device_profile_state": {"status": "not_configured"},
    }
    states.update(overrides)
    return build_ci_project_handbook(
        project=SimpleNamespace(
            id="direct-audit",
            display_name="Direct audit",
            updated_at=datetime(2026, 9, 4, tzinfo=timezone.utc),
        ),
        **states,
    )


def test_handbook_uses_legacy_site_operands_and_marks_unapproved_profiles_inactive() -> None:
    legacy_options = {
        "annual_specific_yield_kwh_per_kw": 1500.0,
        "shading_loss_percent": 3.0,
        "soiling_loss_percent": 2.0,
        "temperature_loss_percent": 5.0,
        "wiring_mismatch_loss_percent": 2.0,
        "other_system_loss_percent": 1.0,
        "system_availability_percent": 99.0,
        "target_dc_ac_ratio": 1.2,
        "inverter_block_size_kw": 125.0,
        "site_ac_headroom_kw": 500.0,
        "battery_duration_hours": 2.0,
        "charge_efficiency_percent": 95.0,
        "discharge_efficiency_percent": 95.0,
        "minimum_soc_percent": 5.0,
        "maximum_soc_percent": 100.0,
        "allow_grid_charging": True,
        "reactive_support_enabled": True,
        "reactive_support_max_kvar": 82.5,
        "grid_emissions_factor_kg_co2e_per_kwh": 0.79,
    }
    suggested_tariff = {
        "factors": {"mlf": 1.01, "dlf": 1.02},
        "rates": {"retail_peak_c_per_kwh": 31.0},
    }
    for rebate_status in ("draft", "stale"):
        payload = _direct_handbook(
            design_context={
                "contract_version": "ci_design_context_v1",
                "technical_options": legacy_options,
            },
            feasibility_state={"status": "ready", "result": {"coverage": {}}},
            tariff_replay_state={"status": "not_saved"},
            rebate_profile_state={
                "status": rebate_status,
                "profile": {
                    "programs": {
                        "solar_stc": {
                            "enabled": True,
                            "certificate_price_aud_ex_gst": 39.0,
                        }
                    }
                },
            },
            tariff_profile_state={
                "status": "not_available",
                "suggested_profile": suggested_tariff,
            },
        )
        modules = {item["module_id"]: item for item in payload["modules"]}
        assert modules["scenario_analysis"]["status"] == "ready"

        solution_parameters = {
            item["parameter_id"]: item
            for item in modules["solution_generator"]["parameters"]
        }
        legacy_yield = solution_parameters[
            "solution.site.annual_specific_yield_kwh_per_kw"
        ]
        assert legacy_yield["value"] == 1500.0
        assert legacy_yield["source_path"].endswith(
            "technical_options.annual_specific_yield_kwh_per_kw"
        )
        assert solution_parameters["solution.technical.target_dc_ac_ratio"][
            "editable"
        ] is False
        assert solution_parameters["solution.technical.maximum_soc_percent"][
            "source_kind"
        ] == "model_policy"
        assert solution_parameters["solution.technical.allow_grid_charging"][
            "editable"
        ] is False
        rebate_price = solution_parameters["solution.rebate.solar_stc.price"]
        assert rebate_price["source_kind"] == "working_copy"
        assert rebate_price["active_in_current_model"] is False

        finance_parameters = {
            item["parameter_id"]: item
            for item in modules["finance_analysis"]["parameters"]
        }
        suggested_rate = finance_parameters[
            "finance.tariff.rate.retail_peak_c_per_kwh"
        ]
        assert suggested_rate["value"] == 31.0
        assert suggested_rate["source_kind"] == "suggested_assumption"
        assert suggested_rate["source_label"] == "Bill-derived suggested tariff"
        assert suggested_rate["active_in_current_model"] is False

        calculations = {
            item["calculation_id"]: item
            for module in modules.values()
            for item in module["calculations"]
        }
        assert "for every headroom-feasible battery option" in calculations[
            "solution.pcs_size"
        ]["formula"]
        assert "PV_export[t]" in calculations["scenario.grid_balance"]["formula"]
        assert "grid_charge[t] + PV_charge[t]" in calculations[
            "scenario.soc_balance"
        ]["formula"]
        assert "shared_AC_kW * delta_t_hours" in calculations[
            "scenario.pv_clipping"
        ]["formula"]
        assert "solution.veec" in calculations


def test_handbook_projects_profile_operands_and_optimizer_snapshot() -> None:
    design_context = {
        "contract_version": "ci_design_context_v2",
        "search_space": {},
        "site_factors": {},
        "technical_options": {
            "target_dc_ac_ratio": 1.2,
            "inverter_block_size_kw": 125.0,
            "maximum_soc_percent": 100.0,
            "allow_grid_charging": True,
        },
        "profile_selection": {
            "solar_profile_id": "solar-v1",
            "battery_profile_id": "battery-v1",
            "inverter_profile_id": "inverter-v1",
            "solar_profile": {
                "profile_id": "solar-v1",
                "name": "Solar snapshot",
                "default_dc_ac_ratio": 1.2,
                "rated_power_w": 650.0,
                "annual_degradation_percent": 0.35,
            },
            "battery_profile": {
                "profile_id": "battery-v1",
                "name": "Battery snapshot",
                "coupling": "ac",
                "nominal_capacity_kwh_per_unit": 97.44,
                "continuous_power_kw_per_unit": 64.51,
                "round_trip_efficiency_percent": 95.0,
                "power_conversion_efficiency_percent": 95.0,
                "usable_depth_of_discharge_percent": 95.0,
                "annual_capacity_degradation_percent": 3.0,
                "minimum_units": 1,
                "maximum_units": 30,
            },
            "inverter_profile": {
                "profile_id": "inverter-v1",
                "name": "Inverter snapshot",
                "rated_active_power_kw": 125.0,
                "rated_apparent_power_kva": 137.5,
                "maximum_reactive_power_kvar": 82.5,
                "european_efficiency_percent": 98.1,
                "pq_capability_curve_available": True,
            },
        },
    }
    optimizer_snapshot = {
        "contract_version": "ci_optimizer_run_snapshot_v2",
        "algorithm_id": "ci_peak_shaving_rolling_replay_v2",
        "solver_version": "1.11.0",
        "status": "optimal_lp_exact",
        "planner_status": "optimal_lp_exact",
        "snapshot_sha256": "a" * 64,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "input_projection": {
            "scenario_sha256": "b" * 64,
            "tariff_profile_sha256": "c" * 64,
            "interval_inputs_sha256": "d" * 64,
        },
        "physical_assumptions": {
            "shared_ac_headroom_kw": 250.0,
            "allow_grid_charging": True,
            "battery": {"nominal_capacity_kwh": 400.0},
            "reactive_support": {"enabled": True, "max_reactive_support_kvar": 82.5},
        },
        "result_projection": {
            "interval_count": 35040,
            "window_count": 365,
            "idle_baseline_bill_aud": 100000.0,
            "exact_replay_bill_aud": 80000.0,
            "optimization_exactness_gap_aud": 0.2,
            "bill_reconciliation_difference_aud": 0.0,
            "dispatch_totals": {
                "grid_import_kwh": 500000.0,
                "pv_export_kwh": 1000.0,
                "grid_charge_kwh": 10000.0,
                "pv_charge_kwh": 12000.0,
                "discharge_kwh": 20000.0,
            },
        },
        "corrections": ["exact_kva_replay_within_aud_5_materiality"],
        "disclosures": ["Internal review only"],
    }
    payload = _direct_handbook(
        design_candidates=[
            {
                "scenario_id": "scenario-1",
                "label": "Scenario 1",
                "pv_capacity_kwp_dc": 100.0,
                "nominal_capacity_kwh": 400.0,
                "pv_inverter_capacity_kw_ac": 250.0,
            }
        ],
        design_context=design_context,
        tariff_replay_state={
            "status": "ready",
            "result": {
                "scenarios": [
                    {
                        "scenario_id": "scenario-1",
                        "label": "Scenario 1",
                        "optimizer_run_snapshot": optimizer_snapshot,
                    }
                ]
            },
        },
    )
    modules = {item["module_id"]: item for item in payload["modules"]}
    solution_parameters = {
        item["parameter_id"]: item
        for item in modules["solution_generator"]["parameters"]
    }
    assert solution_parameters[
        "solution.profile_snapshot.battery.nominal_capacity_kwh_per_unit"
    ]["active_in_current_model"] is True
    assert solution_parameters[
        "solution.profile_snapshot.battery.annual_capacity_degradation_percent"
    ]["active_in_current_model"] is False
    assert solution_parameters[
        "solution.profile_snapshot.inverter.rated_apparent_power_kva"
    ]["active_in_current_model"] is True
    assert solution_parameters[
        "solution.profile_snapshot.inverter.european_efficiency_percent"
    ]["active_in_current_model"] is False
    assert all(
        item["editable"] is False
        for parameter_id, item in solution_parameters.items()
        if parameter_id.startswith("solution.profile_snapshot.")
    )

    optimizer_results = next(
        item
        for item in modules["scenario_analysis"]["result_sets"]
        if item["result_set_id"] == "scenario.optimizer_runs"
    )
    assert len(optimizer_results["rows"]) == 1
    values = optimizer_results["rows"][0]["values"]
    assert values["snapshot_sha256"] == "a" * 64
    assert values["grid_charge"] == 10000.0
    assert values["pv_charge"] == 12000.0
    assert values["exact_bill"] == 80000.0
    assert values["customer_facing_permission"] is False


def test_handbook_explains_peak_dispatch_and_finance_provenance() -> None:
    source_tariff_replay_sha256 = "e" * 64
    payload = _direct_handbook(
        feasibility_state={"status": "ready", "result": {"coverage": {}}},
        tariff_replay_state={"status": "ready", "result": {"scenarios": []}},
        annual_financial_state={
            "status": "ready",
            "result": {
                "source_tariff_replay_sha256": source_tariff_replay_sha256,
                "assumptions": {},
                "solutions": [],
            },
        },
    )
    modules = {item["module_id"]: item for item in payload["modules"]}
    scenario = modules["scenario_analysis"]
    finance = modules["finance_analysis"]

    scenario_calculations = {
        item["calculation_id"]: item for item in scenario["calculations"]
    }
    technical_target = scenario_calculations[
        "scenario.pre_tariff_peak_target"
    ]
    assert "active-power stress test" in technical_target["description"]
    assert "upper bound, not an equality" in technical_target["description"]
    assert "approved_demand_rate[d] > 0" in scenario_calculations[
        "scenario.optimizer_objective"
    ]["formula"]
    assert "zero-rate demand component is omitted" in scenario_calculations[
        "scenario.optimizer_objective"
    ]["description"]
    assert "does not require every interval to equal the ceiling" in (
        scenario_calculations["scenario.demand_peak"]["description"]
    )
    assert any(
        "technical active-kW envelope" in boundary
        for boundary in scenario["boundaries"]
    )

    finance_parameters = {
        item["parameter_id"]: item for item in finance["parameters"]
    }
    provenance = finance_parameters[
        "finance.provenance.source_tariff_replay_sha256"
    ]
    assert provenance["value"] == source_tariff_replay_sha256
    assert provenance["editable"] is False
    assert provenance["active_in_current_model"] is True

    finance_calculations = {
        item["calculation_id"]: item for item in finance["calculations"]
    }
    provenance_calculation = finance_calculations[
        "finance.tariff_replay_provenance"
    ]
    assert "strictly consumes" in provenance_calculation["description"]
    assert "source_tariff_replay_sha256" in provenance_calculation["formula"]
    first_year_value = finance_calculations["finance.first_year_value"]
    assert "optimized_post_dispatch_annual_cost" in first_year_value["formula"]
    assert "pre-tariff technical peak-day result" in first_year_value[
        "description"
    ]
    tariff_model = next(
        item for item in finance["models"]
        if item["model_id"] == "finance.tariff_replay"
    )
    assert any(
        "zero rate produces zero demand-charge saving" in constraint
        for constraint in tariff_model["constraints"]
    )
    assert any(
        "bound to the exact saved tariff replay" in boundary
        for boundary in finance["boundaries"]
    )
