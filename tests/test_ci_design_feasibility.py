from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from solar_battery.ci_design_feasibility import (
    analyze_ci_design_feasibility,
    analyze_ci_interval_activity,
)
from solar_battery.ci_evidence_intake import (
    CiEvidenceIntakeError,
    parse_ci_active_interval_series,
)
from tests.test_ci_projects import _scenario


def _wide_bytes(*, days: int = 3, include_kw: bool = True) -> bytes:
    headings = [
        "NMI", "Meter", "Period", "ReadingDateTime", "E", "B", "Q", "K",
        "kWh", "kW", "kVA", "PowerFactor", "Quality", "QualityText",
    ]
    rows = ["\t".join(headings)]
    start = datetime(2026, 1, 1)
    for index in range(days * 48):
        stamp = start + timedelta(minutes=30 * index)
        hour = stamp.hour + stamp.minute / 60
        kw = 40.0 + (80.0 if 16 <= hour < 18 else 0.0)
        rows.append("\t".join([
            "SYNTH00001", "METER1", "30", stamp.strftime("%d/%m/%Y %H:%M"),
            "", "", "", "", str(kw / 2), str(kw) if include_kw else "",
            str(kw / 0.9), "0.9", "A", "Actual",
        ]))
    return ("\n".join(rows) + "\n").encode()


def test_wide_active_series_preserves_thirty_minute_kw() -> None:
    series = parse_ci_active_interval_series(_wide_bytes())

    assert series.input_format == "wide_interval_30_minute"
    assert series.interval_minutes == 30
    assert len(series.intervals) == 144
    assert series.intervals[0].load_kw_avg == 40.0
    assert series.reported_kva[0] == pytest.approx(40.0 / 0.9)


def test_wide_active_series_fails_closed_for_kva_only_or_missing_rows() -> None:
    with pytest.raises(CiEvidenceIntakeError) as kva_only:
        parse_ci_active_interval_series(_wide_bytes(include_kw=False))
    assert kva_only.value.code == "interval_active_demand_unavailable"

    lines = _wide_bytes().decode().splitlines()
    with pytest.raises(CiEvidenceIntakeError) as missing:
        parse_ci_active_interval_series(
            ("\n".join([*lines[:20], *lines[21:]]) + "\n").encode()
        )
    assert missing.value.code == "interval_series_incomplete"


def test_design_feasibility_returns_energy_and_peak_day_physics_without_tariff() -> None:
    scenario = _scenario()
    result = analyze_ci_design_feasibility(
        _wide_bytes(), scenarios=[scenario]
    )

    assert result["contract_version"] == "ci_design_feasibility_v4"
    assert result["analysis_mode"] == "pre_tariff_physical_feasibility"
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False
    assert result["tariff_evaluated"] is False
    assert result["currency_values_permitted"] is False
    assert result["coverage"]["interval_minutes"] == 30
    assert result["coverage"]["primary_year"] == 2026
    assert result["physical_review_order"] == {
        "algorithm_id": "ci_pre_tariff_physical_review_order_v2",
        "shortlist_count": 1,
        "basis": (
            "Highest measured-coverage grid-import energy reduction, then greater "
            "active-power peak reduction and top-10 event coverage. Exact performance "
            "ties prefer the smaller authored PV, battery and inverter capacity. This "
            "is a physical review order, not a recommendation."
        ),
        "recommendation_permitted": False,
    }

    evaluated = result["scenarios"][0]
    assert evaluated["physical_review_rank"] == 1
    assert evaluated["scenario_id"] == scenario["scenario_id"]
    assert evaluated["coverage_energy"]["grid_import_after_kwh"] < evaluated["coverage_energy"]["site_import_before_kwh"]
    assert evaluated["coverage_energy"]["pv_self_consumption_percent"] >= 0
    assert evaluated["coverage_energy"]["grid_export_kwh"] >= 0
    assert evaluated["coverage_energy"]["pv_clipped_kwh"] >= 0
    assert evaluated["coverage_energy"]["battery_equivalent_full_cycles"] >= 0
    assert evaluated["coverage_energy"]["grid_emissions_factor_kg_co2e_per_kwh"] == 0.79
    assert evaluated["coverage_energy"]["baseline_scope_2_emissions_t_co2e"] > evaluated["coverage_energy"]["post_system_scope_2_emissions_t_co2e"]
    assert evaluated["coverage_energy"]["avoided_scope_2_emissions_t_co2e"] > 0
    assert evaluated["coverage_energy"]["scope_2_emissions_reduction_percent"] == pytest.approx(evaluated["coverage_energy"]["grid_import_reduction_percent"])
    assert evaluated["coverage_performance"]["dispatch_basis"] == "pv_first_coverage_dispatch"
    assert evaluated["coverage_performance"]["top_10_event_count"] == 10
    assert len(evaluated["coverage_performance"]["top_peak_events"]) <= 20
    assert evaluated["coverage_performance"]["battery_duration_at_max_discharge_hours"] > 0
    assert evaluated["peak_day"]["date"] == result["baseline"]["peak_date"]
    assert evaluated["peak_day"]["baseline_peak_kw"] == 120.0
    assert evaluated["peak_day"]["achieved_peak_kw"] < 120.0
    assert evaluated["peak_day"]["billing_demand_interpretation_permitted"] is False
    assert len(evaluated["peak_day"]["points"]) == 48
    assert all("aud" not in str(key).lower() for key in evaluated)


def test_design_feasibility_shortlists_the_first_ten_physical_results() -> None:
    scenarios = []
    for index in range(12):
        scenario = _scenario()
        scenario["scenario_id"] = f"candidate-{index:02d}"
        scenario["pv_system_id"] = f"pv-{index:02d}"
        scenario["pv_capacity_kwp_dc"] = 20.0 + index * 5
        scenario["pv_inverter_capacity_kw_ac"] = 20.0 + index * 5
        scenarios.append(scenario)

    result = analyze_ci_design_feasibility(_wide_bytes(), scenarios=scenarios)

    assert result["physical_review_order"]["shortlist_count"] == 10
    assert [item["physical_review_rank"] for item in result["scenarios"]] == list(
        range(1, 13)
    )
    reductions = [
        item["coverage_energy"]["grid_import_reduction_kwh"]
        for item in result["scenarios"]
    ]
    assert reductions == sorted(reductions, reverse=True)
    assert result["scenarios"][0]["authored_inputs"]["pv_capacity_kwp_dc"] == 75.0


def test_design_feasibility_omits_carbon_claims_when_factor_is_disabled() -> None:
    scenario = _scenario()
    scenario["grid_emissions_factor_kg_co2e_per_kwh"] = 0.0

    result = analyze_ci_design_feasibility(_wide_bytes(), scenarios=[scenario])

    energy = result["scenarios"][0]["coverage_energy"]
    assert "grid_emissions_factor_kg_co2e_per_kwh" not in energy
    assert "baseline_scope_2_emissions_t_co2e" not in energy
    assert "post_system_scope_2_emissions_t_co2e" not in energy
    assert "avoided_scope_2_emissions_t_co2e" not in energy
    assert "scope_2_emissions_reduction_percent" not in energy


def test_design_feasibility_selects_a_complete_peak_day_with_partial_edges() -> None:
    lines = _wide_bytes(days=4).decode().splitlines()
    partial_edges = ("\n".join([lines[0], *lines[2:-1]]) + "\n").encode()

    result = analyze_ci_design_feasibility(
        partial_edges, scenarios=[_scenario()]
    )

    assert result["baseline"]["peak_date"] == "2026-01-02"
    assert len(result["scenarios"][0]["peak_day"]["points"]) == 48


def test_interval_activity_returns_bounded_multi_day_physical_flows() -> None:
    scenario = _scenario()

    result = analyze_ci_interval_activity(
        _wide_bytes(days=8),
        scenarios=[scenario],
        scenario_id=scenario["scenario_id"],
        start_date=date(2026, 1, 2),
        days=3,
    )

    assert result["contract_version"] == "ci_interval_activity_v1"
    assert result["analysis_mode"] == "pre_tariff_physical_interval_activity"
    assert result["scenario_id"] == scenario["scenario_id"]
    assert result["interval_minutes"] == 30
    assert result["range"] == {
        "requested_start_date": "2026-01-02",
        "requested_days": 3,
        "effective_start_timestamp": "2026-01-02T00:00:00+10:00",
        "effective_end_timestamp": "2026-01-04T23:30:00+10:00",
        "interval_count": 144,
        "complete": True,
    }
    assert len(result["points"]) == 144
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False
    assert result["tariff_evaluated"] is False
    assert result["billing_demand_interpretation_permitted"] is False
    assert all(
        point[key] >= 0
        for point in result["points"]
        for key in (
            "measured_import_kw",
            "grid_import_kw",
            "solar_to_load_kw",
            "grid_export_kw",
        )
    )
    assert all(
        point["grid_import_kw"] <= point["measured_import_kw"] + 1e-6
        for point in result["points"]
    )


def test_interval_activity_rejects_unknown_scenario_and_range() -> None:
    with pytest.raises(CiEvidenceIntakeError) as scenario_error:
        analyze_ci_interval_activity(
            _wide_bytes(),
            scenarios=[_scenario()],
            scenario_id="not-saved",
            start_date=date(2026, 1, 1),
            days=1,
        )
    assert scenario_error.value.code == "interval_activity_scenario_unavailable"

    with pytest.raises(CiEvidenceIntakeError) as range_error:
        analyze_ci_interval_activity(
            _wide_bytes(),
            scenarios=[_scenario()],
            scenario_id=_scenario()["scenario_id"],
            start_date=date(2027, 1, 1),
            days=1,
        )
    assert range_error.value.code == "interval_activity_range_unavailable"
