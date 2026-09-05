from __future__ import annotations

from datetime import date, timedelta

import pytest

from solar_battery.ci_annual_financial_comparison import (
    compare_ci_annual_financial_scenarios,
)
from solar_battery.ci_scenario_analysis import analyze_ci_physical_scenarios


def _profile(*, minimum_chargeable_rolling_kva: float) -> dict[str, object]:
    return {
        "timezone_name": "Australia/Melbourne",
        "rolling_period": {"start_date": "2025-04-01", "end_date": "2026-03-31"},
        "billing_period": {"start_date": "2026-03-02", "end_date": "2026-03-02"},
        "rolling_demand_window": {
            "start": "07:00",
            "end": "19:00",
            "time_basis": "local",
            "excluded_dates": [],
        },
        "incentive_demand_window": {
            "start": "16:00",
            "end": "19:00",
            "time_basis": "local",
            "excluded_dates": [],
        },
        "retail_energy_window": {
            "start": "07:00",
            "end": "23:00",
            "time_basis": "meter_aest",
            "excluded_dates": [],
        },
        "network_energy_window": {
            "start": "07:00",
            "end": "19:00",
            "time_basis": "local",
            "excluded_dates": [],
        },
        "minimum_chargeable_rolling_kva": minimum_chargeable_rolling_kva,
        "gst_rate": 0.1,
        "additional_bill_adjustment_aud": 0.0,
        "factors": {"mlf": 1.0, "dlf": 1.0},
        "rates": {
            "retail_peak_c_per_kwh": 10.0,
            "retail_off_peak_c_per_kwh": 10.0,
            "incentive_demand_aud_per_kva_month": 0.0,
            "rolling_demand_aud_per_kva_month": 1.0,
            "network_peak_c_per_kwh": 0.0,
            "network_off_peak_c_per_kwh": 0.0,
            "aemo_ancillary_c_per_kwh": 0.0,
            "aemo_participant_c_per_kwh": 0.0,
            "aemo_frc_c_per_day": 0.0,
            "environmental": [],
            "metering_aud_per_day": 0.0,
            "value_added_c_per_day": 0.0,
        },
        "annual_financial_model": {
            "method": "representative_year_repeat_v1",
            "incentive_demand_months": [12, 1, 2, 3],
            "incentive_demand_aud_per_kva_month": 2.0,
        },
    }


def _first_weekday(year: int, month: int) -> date:
    day = date(year, month, 1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _positive_q1_streams() -> dict[str, dict[date, list[float]]]:
    days = [_first_weekday(2025, month) for month in range(4, 13)] + [
        _first_weekday(2026, month) for month in range(1, 4)
    ]
    return {
        "B1": {day: [0.0] * 288 for day in days},
        "E1": {day: [1.0] * 288 for day in days},
        "Q1": {day: [0.75] * 288 for day in days},
    }


def _same_sized_reactive_pair() -> list[dict[str, object]]:
    common: dict[str, object] = {
        "battery_system_id": "battery-none",
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": 10.0,
        "pv_inverter_capacity_kw_ac": 8.0,
        "shared_ac_headroom_kw": 50.0,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": 1200.0,
        "pv_derating_factor": 0.9,
        "nominal_capacity_kwh": 0.0,
        "max_charge_kw": 0.0,
        "max_discharge_kw": 0.0,
        "charge_efficiency": 0.95,
        "discharge_efficiency": 0.95,
        "min_soc_fraction": 0.1,
        "max_soc_fraction": 1.0,
        "initial_soc_fraction": 1.0,
        "allow_grid_charging": True,
    }
    return [
        {
            **common,
            "scenario_id": "reactive-disabled",
            "label": "Same design without reactive support",
            "pv_system_id": "same-design-reactive-disabled",
            "reactive_support_enabled": False,
            "reactive_support_max_kvar": 0.0,
            "shared_inverter_apparent_power_limit_kva": None,
        },
        {
            **common,
            "scenario_id": "reactive-enabled",
            "label": "Same design with reactive support",
            "pv_system_id": "same-design-reactive-enabled",
            "reactive_support_enabled": True,
            "reactive_support_max_kvar": 9.0,
            "shared_inverter_apparent_power_limit_kva": 20.0,
        },
    ]


def _run_tariff_and_finance(monkeypatch, profile: dict[str, object]):
    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "1")
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: {
            "profile": {"profile_id": "synthetic-reactive-regression"},
            "demand_evidence": {
                "rolling_demand_kva": 15.0,
                "chargeable_rolling_demand_kva": 15.0,
                "incentive_demand_kva": 15.0,
                "billing_period_max_kva": 15.0,
                "billing_period_max_kw": 12.0,
            },
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _positive_q1_streams()},
    )
    tariff = analyze_ci_physical_scenarios(
        b"synthetic-positive-q1",
        profile=profile,
        scenarios=_same_sized_reactive_pair(),
    )
    finance = compare_ci_annual_financial_scenarios(
        tariff_replay_result=tariff,
        request={
            "pricing_mode": "manual_quotes",
            "prices": [
                {
                    "scenario_id": scenario_id,
                    "upfront_cost_aud_ex_gst": 100_000.0,
                }
                for scenario_id in ("reactive-disabled", "reactive-enabled")
            ],
        },
    )
    tariff_by_id = {row["scenario_id"]: row for row in tariff["scenarios"]}
    finance_by_id = {row["scenario_id"]: row for row in finance["solutions"]}
    return tariff_by_id, finance_by_id


def test_reactive_support_value_flows_from_post_kva_to_finance_npv(monkeypatch) -> None:
    tariff, finance = _run_tariff_and_finance(
        monkeypatch,
        _profile(minimum_chargeable_rolling_kva=0.0),
    )
    disabled = tariff["reactive-disabled"]
    enabled = tariff["reactive-enabled"]
    disabled_value = disabled["annual_tariff_value"]
    enabled_value = enabled["annual_tariff_value"]

    assert enabled["post_dispatch"]["maximum_reactive_support_kvar"] > 0.0
    assert (
        enabled["post_dispatch"]["raw_rolling_demand_kva"]
        < disabled["post_dispatch"]["raw_rolling_demand_kva"]
    )
    assert (
        enabled_value["scenario_categories_ex_gst_aud"]["network_charges"]
        < disabled_value["scenario_categories_ex_gst_aud"]["network_charges"]
    )
    assert (
        enabled_value["scenario_cost_ex_gst_aud"]
        < disabled_value["scenario_cost_ex_gst_aud"]
    )
    assert (
        enabled_value["first_year_value_ex_gst_aud"]
        > disabled_value["first_year_value_ex_gst_aud"]
    )
    assert finance["reactive-enabled"]["first_year_value_aud_ex_gst"] == (
        enabled_value["first_year_value_ex_gst_aud"]
    )
    assert finance["reactive-disabled"]["first_year_value_aud_ex_gst"] == (
        disabled_value["first_year_value_ex_gst_aud"]
    )
    assert (
        finance["reactive-enabled"]["metrics"]["net_present_value_aud"]
        > finance["reactive-disabled"]["metrics"]["net_present_value_aud"]
    )


def test_minimum_demand_floor_preserves_physical_kva_but_removes_dollar_value(
    monkeypatch,
) -> None:
    profile = _profile(minimum_chargeable_rolling_kva=50.0)
    profile["annual_financial_model"][
        "incentive_demand_aud_per_kva_month"
    ] = 0.0
    tariff, finance = _run_tariff_and_finance(monkeypatch, profile)
    disabled = tariff["reactive-disabled"]
    enabled = tariff["reactive-enabled"]
    disabled_value = disabled["annual_tariff_value"]
    enabled_value = enabled["annual_tariff_value"]

    assert (
        enabled["post_dispatch"]["raw_rolling_demand_kva"]
        < disabled["post_dispatch"]["raw_rolling_demand_kva"]
    )
    assert enabled["post_dispatch"]["chargeable_rolling_demand_kva"] == 50.0
    assert disabled["post_dispatch"]["chargeable_rolling_demand_kva"] == 50.0
    assert enabled_value["scenario_categories_ex_gst_aud"][
        "network_charges"
    ] == pytest.approx(
        disabled_value["scenario_categories_ex_gst_aud"]["network_charges"]
    )
    assert enabled_value["scenario_cost_ex_gst_aud"] == pytest.approx(
        disabled_value["scenario_cost_ex_gst_aud"]
    )
    assert enabled_value["first_year_value_ex_gst_aud"] == pytest.approx(
        disabled_value["first_year_value_ex_gst_aud"]
    )
    assert finance["reactive-enabled"]["metrics"][
        "net_present_value_aud"
    ] == pytest.approx(
        finance["reactive-disabled"]["metrics"]["net_present_value_aud"]
    )
