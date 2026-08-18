from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
import math

from solar_battery.battery_dispatch import (
    BatteryDispatchEnergyInput,
    build_energy_only_battery_dispatch_result,
)
from solar_battery.battery_strategy import (
    BatteryStrategyConfig,
    BatteryStrategyIdentifier,
    StrategyGateStatus,
)
from solar_battery.ci_evidence_intake import (
    CiEvidenceIntakeError,
    parse_ci_active_interval_series,
)
from solar_battery.ci_scenario_analysis import (
    _Scenario,
    _validated_scenarios,
)
from solar_battery.models import BatteryPreset, CleanedInterval
from solar_battery.solar_profile import solar_shape


CI_DESIGN_FEASIBILITY_CONTRACT_VERSION = "ci_design_feasibility_v2"
CI_INTERVAL_ACTIVITY_CONTRACT_VERSION = "ci_interval_activity_v1"
CI_ENERGY_DISPATCH_ID = "ci_pre_tariff_pv_self_consumption_v1"
CI_PEAK_DAY_ENVELOPE_ID = "ci_pre_tariff_peak_day_envelope_v1"
PEAK_THRESHOLD_COUNT = 51


@dataclass(frozen=True, slots=True)
class _ScenarioEnergySeries:
    pv_unclipped_energy: tuple[float, ...]
    pv_energy: tuple[float, ...]
    pv_to_load: tuple[float, ...]
    pv_surplus: tuple[float, ...]
    pv_only_import: tuple[float, ...]
    grid_import: tuple[float, ...]
    battery_charge: tuple[float, ...]
    battery_discharge: tuple[float, ...]
    grid_export: tuple[float, ...]
    soc_end: tuple[float | None, ...]
    initial_soc: float | None
    final_soc: float | None


def analyze_ci_design_feasibility(
    upload_bytes: bytes, *, scenarios: object
) -> dict[str, object]:
    """Evaluate saved design candidates without tariff or customer-dollar meaning."""
    authored = _validated_scenarios(scenarios)
    series = parse_ci_active_interval_series(upload_bytes)
    intervals = series.intervals
    expected_day_intervals = 24 * 60 // series.interval_minutes
    indexes_by_day: dict[date, list[int]] = defaultdict(list)
    for index, row in enumerate(intervals):
        indexes_by_day[row.source_date].append(index)
    complete_days = tuple(
        day
        for day, indexes in indexes_by_day.items()
        if len(indexes) == expected_day_intervals
    )
    if len(complete_days) < 2:
        raise CiEvidenceIntakeError(
            "interval_horizon_too_short",
            "System design feasibility requires at least two complete measured days.",
        )

    peak_date = max(
        complete_days,
        key=lambda day: max(
            intervals[index].load_kw_avg for index in indexes_by_day[day]
        ),
    )
    peak_indexes = tuple(indexes_by_day[peak_date])
    baseline_peak_index = max(
        peak_indexes, key=lambda index: intervals[index].load_kw_avg
    )
    shape_energy_per_interval = _normalized_solar_shape(intervals)
    year_indexes = _year_indexes(intervals)
    complete_years = tuple(
        year for year, indexes in year_indexes.items()
        if _complete_calendar_year(intervals, indexes)
    )
    primary_year = max(complete_years or tuple(year_indexes))
    results = [
        _analyze_scenario(
            scenario,
            intervals=intervals,
            shape_energy_per_interval=shape_energy_per_interval,
            peak_indexes=peak_indexes,
            year_indexes=year_indexes,
        )
        for scenario in authored
    ]
    return {
        "contract_version": CI_DESIGN_FEASIBILITY_CONTRACT_VERSION,
        "status": "ready",
        "analysis_mode": "pre_tariff_physical_feasibility",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "tariff_evaluated": False,
        "currency_values_permitted": False,
        "coverage": {
            "input_format": series.input_format,
            "interval_minutes": series.interval_minutes,
            "interval_count": len(intervals),
            "start_timestamp": intervals[0].timestamp.isoformat(),
            "end_timestamp": intervals[-1].timestamp.isoformat(),
            "time_basis": series.time_basis,
            "years": [
                {
                    "year": year,
                    "interval_count": len(indexes),
                    "complete_calendar_year": year in complete_years,
                }
                for year, indexes in year_indexes.items()
            ],
            "primary_year": primary_year,
        },
        "baseline": {
            "peak_date": peak_date.isoformat(),
            "peak_kw": round(intervals[baseline_peak_index].load_kw_avg, 6),
            "peak_timestamp": intervals[baseline_peak_index].timestamp.isoformat(),
            "daily_profile_cloud": _daily_profile_cloud(intervals, peak_date),
        },
        "scenarios": results,
        "assumptions": [
            "Measured active import is the physical load basis; it is not reconstructed gross site load.",
            "Standard NEM12 E1 is aggregated to 15 minutes; reported wide-export kW remains at 30 minutes and is never upsampled.",
            "The repository solar shape is scaled to each authored annual specific yield and PV derating assumption.",
            "Coverage energy uses PV-first self-consumption dispatch. Grid charging is not scheduled without an approved tariff time basis.",
            "Peak reduction is a selected measured peak-day physical envelope starting at the authored SOC, not a billing-demand result.",
            "No tariff window, minimum demand, kVA/PF outcome, demand charge, savings, recommendation or customer claim is calculated.",
        ],
    }


def analyze_ci_interval_activity(
    upload_bytes: bytes,
    *,
    scenarios: object,
    scenario_id: str,
    start_date: date,
    days: int,
) -> dict[str, object]:
    """Return one bounded multi-day physical-flow view for a saved candidate."""
    if days not in {1, 3, 7}:
        raise CiEvidenceIntakeError(
            "interval_activity_days_invalid",
            "Interval activity supports only 1, 3 or 7 calendar days.",
        )
    authored = _validated_scenarios(scenarios)
    scenario = next(
        (item for item in authored if item.scenario_id == scenario_id), None
    )
    if scenario is None:
        raise CiEvidenceIntakeError(
            "interval_activity_scenario_unavailable",
            "Select a scenario saved to this project before loading interval activity.",
        )
    source = parse_ci_active_interval_series(upload_bytes)
    intervals = source.intervals
    requested_end = start_date + timedelta(days=days - 1)
    indexes = tuple(
        index
        for index, row in enumerate(intervals)
        if start_date <= row.source_date <= requested_end
    )
    if not indexes:
        raise CiEvidenceIntakeError(
            "interval_activity_range_unavailable",
            "The selected date range is outside this project's measured interval coverage.",
        )

    energy = _scenario_energy_series(
        scenario,
        intervals=intervals,
        shape_energy_per_interval=_normalized_solar_shape(intervals),
    )
    hours = source.interval_minutes / 60
    points = []
    for index in indexes:
        row = intervals[index]
        points.append(
            {
                "timestamp": row.timestamp.isoformat(),
                "time_label": row.timestamp.strftime("%d %b %H:%M"),
                "measured_import_kw": round(row.load_kw_avg, 6),
                "grid_import_kw": round(energy.grid_import[index] / hours, 6),
                "solar_to_load_kw": round(energy.pv_to_load[index] / hours, 6),
                "grid_export_kw": round(energy.grid_export[index] / hours, 6),
            }
        )
    expected_count = days * 24 * 60 // source.interval_minutes
    return {
        "contract_version": CI_INTERVAL_ACTIVITY_CONTRACT_VERSION,
        "status": "ready",
        "analysis_mode": "pre_tariff_physical_interval_activity",
        "scenario_id": scenario.scenario_id,
        "scenario_label": scenario.label,
        "interval_minutes": source.interval_minutes,
        "time_basis": source.time_basis,
        "range": {
            "requested_start_date": start_date.isoformat(),
            "requested_days": days,
            "effective_start_timestamp": intervals[indexes[0]].timestamp.isoformat(),
            "effective_end_timestamp": intervals[indexes[-1]].timestamp.isoformat(),
            "interval_count": len(indexes),
            "complete": len(indexes) == expected_count,
        },
        "points": points,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "tariff_evaluated": False,
        "billing_demand_interpretation_permitted": False,
    }


def _normalized_solar_shape(
    intervals: tuple[CleanedInterval, ...]
) -> tuple[float, ...]:
    minutes = intervals[0].interval_minutes
    interval_hours = minutes / 60
    fixed_aest = timezone(timedelta(hours=10), name="AEST")
    reference_start = datetime(2025, 1, 1, tzinfo=fixed_aest)
    reference_count = 365 * 24 * 60 // minutes
    reference_raw = math.fsum(
        solar_shape(
            (reference_start + timedelta(minutes=minutes * index)).hour
            + (reference_start + timedelta(minutes=minutes * index)).minute / 60,
            (reference_start + timedelta(minutes=minutes * index)).timetuple().tm_yday,
        )
        * interval_hours
        for index in range(reference_count)
    )
    return tuple(
        solar_shape(
            row.timestamp.hour + row.timestamp.minute / 60,
            row.timestamp.timetuple().tm_yday,
        )
        * interval_hours
        / reference_raw
        for row in intervals
    )


def _analyze_scenario(
    scenario: _Scenario,
    *,
    intervals: tuple[CleanedInterval, ...],
    shape_energy_per_interval: tuple[float, ...],
    peak_indexes: tuple[int, ...],
    year_indexes: dict[int, tuple[int, ...]],
) -> dict[str, object]:
    energy = _scenario_energy_series(
        scenario,
        intervals=intervals,
        shape_energy_per_interval=shape_energy_per_interval,
    )
    pv_energy = energy.pv_energy

    peak_day = _peak_day_envelope(
        scenario,
        intervals=intervals,
        pv_energy=pv_energy,
        peak_indexes=peak_indexes,
    )
    yearly = [
        _year_energy_result(
            year,
            indexes,
            intervals=intervals,
            energy=energy,
            scenario=scenario,
        )
        for year, indexes in year_indexes.items()
    ]
    return {
        "scenario_id": scenario.scenario_id,
        "label": scenario.label,
        "authored_inputs": asdict(scenario),
        "energy_dispatch_algorithm_id": CI_ENERGY_DISPATCH_ID,
        "yearly_energy": yearly,
        "coverage_energy": _energy_totals(
            range(len(intervals)),
            intervals=intervals,
            energy=energy,
            scenario=scenario,
        ),
        "coverage_performance": _performance_metrics(
            range(len(intervals)),
            intervals=intervals,
            energy=energy,
            scenario=scenario,
        ),
        "initial_soc_kwh": (
            round(energy.initial_soc, 6)
            if energy.initial_soc is not None
            else None
        ),
        "final_soc_kwh": (
            round(energy.final_soc, 6) if energy.final_soc is not None else None
        ),
        "peak_day": peak_day,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }


def _scenario_energy_series(
    scenario: _Scenario,
    *,
    intervals: tuple[CleanedInterval, ...],
    shape_energy_per_interval: tuple[float, ...],
) -> _ScenarioEnergySeries:
    hours = intervals[0].interval_minutes / 60
    pv_unclipped_energy = tuple(
        shape_per_year
        * scenario.pv_annual_specific_yield_kwh_per_kw
        * scenario.pv_capacity_kwp_dc
        * scenario.pv_derating_factor
        for shape_per_year in shape_energy_per_interval
    )
    pv_energy = tuple(
        min(
            unclipped,
            scenario.pv_inverter_capacity_kw_ac * hours,
            scenario.shared_ac_headroom_kw * hours,
        )
        for unclipped in pv_unclipped_energy
    )
    pv_to_load = tuple(
        min(interval.load_kwh, pv)
        for interval, pv in zip(intervals, pv_energy, strict=True)
    )
    pv_surplus = tuple(
        max(0.0, pv - used)
        for pv, used in zip(pv_energy, pv_to_load, strict=True)
    )
    pv_only_import = tuple(
        interval.load_kwh - used
        for interval, used in zip(intervals, pv_to_load, strict=True)
    )

    if scenario.nominal_capacity_kwh <= 0:
        empty = tuple(0.0 for _ in intervals)
        return _ScenarioEnergySeries(
            pv_unclipped_energy=pv_unclipped_energy,
            pv_energy=pv_energy,
            pv_to_load=pv_to_load,
            pv_surplus=pv_surplus,
            pv_only_import=pv_only_import,
            grid_import=pv_only_import,
            battery_charge=empty,
            battery_discharge=empty,
            grid_export=pv_surplus,
            soc_end=tuple(None for _ in intervals),
            initial_soc=None,
            final_soc=None,
        )

    dispatch = build_energy_only_battery_dispatch_result(
        tuple(
            BatteryDispatchEnergyInput(
                source_interval=interval,
                charge_available_kwh=surplus,
                discharge_demand_kwh=(
                    0.0
                    if surplus > 0
                    else min(
                        remaining,
                        max(
                            0.0,
                            scenario.shared_ac_headroom_kw * hours - pv_used,
                        ),
                    )
                ),
            )
            for interval, surplus, remaining, pv_used in zip(
                intervals, pv_surplus, pv_only_import, pv_to_load, strict=True
            )
        ),
        BatteryStrategyConfig(
            strategy_id=BatteryStrategyIdentifier.SELF_CONSUMPTION,
            allow_grid_charging=False,
            gate_status=StrategyGateStatus.REVIEW_ONLY,
            assumptions=(
                "PV-first pre-tariff physical energy review.",
                "Grid charging is not scheduled without approved tariff windows.",
            ),
        ),
        _battery(scenario),
        initial_soc_kwh=(
            scenario.nominal_capacity_kwh * scenario.initial_soc_fraction
        ),
    )
    battery_charge = tuple(
        row.battery_charge_input_kwh for row in dispatch.intervals
    )
    battery_discharge = tuple(
        row.battery_discharge_output_kwh for row in dispatch.intervals
    )
    return _ScenarioEnergySeries(
        pv_unclipped_energy=pv_unclipped_energy,
        pv_energy=pv_energy,
        pv_to_load=pv_to_load,
        pv_surplus=pv_surplus,
        pv_only_import=pv_only_import,
        grid_import=tuple(
            max(0.0, base - discharged)
            for base, discharged in zip(
                pv_only_import, battery_discharge, strict=True
            )
        ),
        battery_charge=battery_charge,
        battery_discharge=battery_discharge,
        grid_export=tuple(
            max(0.0, surplus - charged)
            for surplus, charged in zip(
                pv_surplus, battery_charge, strict=True
            )
        ),
        soc_end=tuple(row.soc_end_kwh for row in dispatch.intervals),
        initial_soc=dispatch.initial_soc_kwh,
        final_soc=dispatch.final_soc_kwh,
    )


def _battery(scenario: _Scenario) -> BatteryPreset:
    return BatteryPreset(
        name=scenario.battery_system_id,
        nominal_capacity_kwh=scenario.nominal_capacity_kwh,
        min_soc_fraction=scenario.min_soc_fraction,
        max_soc_fraction=scenario.max_soc_fraction,
        max_charge_kw=min(
            scenario.max_charge_kw, scenario.shared_ac_headroom_kw
        ),
        max_discharge_kw=min(
            scenario.max_discharge_kw, scenario.shared_ac_headroom_kw
        ),
        charge_efficiency=scenario.charge_efficiency,
        discharge_efficiency=scenario.discharge_efficiency,
        capex_aud=0.0,
        source_date=date(2026, 8, 17),
    )


def _peak_day_envelope(
    scenario: _Scenario,
    *,
    intervals: tuple[CleanedInterval, ...],
    pv_energy: tuple[float, ...],
    peak_indexes: tuple[int, ...],
) -> dict[str, object]:
    rows = tuple(intervals[index] for index in peak_indexes)
    pv = tuple(pv_energy[index] for index in peak_indexes)
    hours = rows[0].interval_minutes / 60
    pv_to_load = tuple(
        min(row.load_kwh, amount) for row, amount in zip(rows, pv, strict=True)
    )
    surplus = tuple(
        max(0.0, amount - used)
        for amount, used in zip(pv, pv_to_load, strict=True)
    )
    net = tuple(
        row.load_kwh - used
        for row, used in zip(rows, pv_to_load, strict=True)
    )
    pv_only_peak = max(amount / hours for amount in net)
    baseline_peak = max(row.load_kw_avg for row in rows)

    if scenario.nominal_capacity_kwh <= 0:
        selected = None
        achieved = pv_only_peak
        dispatch_rows = None
    else:
        battery = _battery(scenario)
        selected = pv_only_peak
        achieved = pv_only_peak
        dispatch_rows = None
        upper = pv_only_peak * 1.1
        for index in range(PEAK_THRESHOLD_COUNT):
            threshold = upper * index / (PEAK_THRESHOLD_COUNT - 1)
            intents = []
            for row, remaining, pv_surplus, pv_used in zip(
                rows, net, surplus, pv_to_load, strict=True
            ):
                remaining_kw = remaining / hours
                if remaining_kw > threshold:
                    intents.append(
                        BatteryDispatchEnergyInput(
                            source_interval=row,
                            discharge_demand_kwh=min(
                                (remaining_kw - threshold) * hours,
                                max(
                                    0.0,
                                    scenario.shared_ac_headroom_kw * hours
                                    - pv_used,
                                ),
                            ),
                        )
                    )
                else:
                    grid_headroom = (
                        max(0.0, threshold - remaining_kw) * hours
                        if scenario.allow_grid_charging
                        else 0.0
                    )
                    intents.append(
                        BatteryDispatchEnergyInput(
                            source_interval=row,
                            charge_available_kwh=pv_surplus + grid_headroom,
                        )
                    )
            candidate = build_energy_only_battery_dispatch_result(
                tuple(intents),
                BatteryStrategyConfig(
                    strategy_id=BatteryStrategyIdentifier.SELF_CONSUMPTION,
                    allow_grid_charging=scenario.allow_grid_charging,
                    gate_status=StrategyGateStatus.REVIEW_ONLY,
                    assumptions=(
                        "Selected measured peak-day physical envelope.",
                        "No tariff demand window or billing semantics.",
                    ),
                ),
                battery,
                initial_soc_kwh=(
                    scenario.nominal_capacity_kwh
                    * scenario.initial_soc_fraction
                ),
            )
            imports = []
            for remaining, pv_surplus, dispatched in zip(
                net, surplus, candidate.intervals, strict=True
            ):
                pv_charge = min(
                    pv_surplus, dispatched.battery_charge_input_kwh
                )
                grid_charge = (
                    dispatched.battery_charge_input_kwh - pv_charge
                )
                imports.append(
                    max(
                        0.0,
                        remaining
                        + grid_charge
                        - dispatched.battery_discharge_output_kwh,
                    )
                )
            candidate_peak = max(amount / hours for amount in imports)
            if candidate_peak <= threshold + 1e-7:
                selected = threshold
                achieved = candidate_peak
                dispatch_rows = (candidate, tuple(imports))
                break

    points = []
    for point_index, (row, pv_amount, remaining, pv_used) in enumerate(
        zip(rows, pv, net, pv_to_load, strict=True)
    ):
        if dispatch_rows is None:
            after = remaining
            charge = discharge = 0.0
            soc = None
        else:
            dispatch, imports = dispatch_rows
            after = imports[point_index]
            charge = dispatch.intervals[point_index].battery_charge_input_kwh
            discharge = dispatch.intervals[point_index].battery_discharge_output_kwh
            soc = dispatch.intervals[point_index].soc_end_kwh
        points.append(
            {
                "timestamp": row.timestamp.isoformat(),
                "time_label": row.timestamp.strftime("%H:%M"),
                "baseline_kw": round(row.load_kw_avg, 6),
                "pv_only_import_kw": round(remaining / hours, 6),
                "pv_battery_import_kw": round(after / hours, 6),
                "pv_generation_kw": round(pv_amount / hours, 6),
                "battery_charge_kw": round(charge / hours, 6),
                "battery_discharge_kw": round(discharge / hours, 6),
                "soc_kwh": round(soc, 6) if soc is not None else None,
            }
        )
    return {
        "algorithm_id": CI_PEAK_DAY_ENVELOPE_ID,
        "date": rows[0].source_date.isoformat(),
        "baseline_peak_kw": round(baseline_peak, 6),
        "pv_only_peak_kw": round(pv_only_peak, 6),
        "achieved_peak_kw": round(achieved, 6),
        "sampled_target_kw": round(selected, 6) if selected is not None else None,
        "peak_reduction_kw": round(max(0.0, baseline_peak - achieved), 6),
        "peak_reduction_percent": round(
            100 * max(0.0, baseline_peak - achieved) / baseline_peak
            if baseline_peak > 0 else 0.0,
            6,
        ),
        "points": points,
        "billing_demand_interpretation_permitted": False,
    }


def _year_indexes(
    intervals: tuple[CleanedInterval, ...]
) -> dict[int, tuple[int, ...]]:
    grouped: dict[int, list[int]] = defaultdict(list)
    for index, row in enumerate(intervals):
        grouped[row.source_date.year].append(index)
    return {year: tuple(indexes) for year, indexes in sorted(grouped.items())}


def _complete_calendar_year(
    intervals: tuple[CleanedInterval, ...], indexes: tuple[int, ...]
) -> bool:
    first = intervals[indexes[0]]
    last = intervals[indexes[-1]]
    expected = (
        (date(first.source_date.year + 1, 1, 1) - date(first.source_date.year, 1, 1)).days
        * 24
        * 60
        // first.interval_minutes
    )
    return (
        first.source_date == date(first.source_date.year, 1, 1)
        and first.timestamp.hour == 0
        and first.timestamp.minute == 0
        and last.source_date == date(first.source_date.year, 12, 31)
        and len(indexes) == expected
    )


def _year_energy_result(
    year: int,
    indexes: tuple[int, ...],
    **kwargs,
) -> dict[str, object]:
    return {
        "year": year,
        **_energy_totals(indexes, **kwargs),
        "performance": _performance_metrics(indexes, **kwargs),
    }


def _energy_totals(
    indexes,
    *,
    intervals: tuple[CleanedInterval, ...],
    energy: _ScenarioEnergySeries,
    scenario: _Scenario,
) -> dict[str, float | int]:
    selected = tuple(indexes)
    site = math.fsum(intervals[index].load_kwh for index in selected)
    imported = math.fsum(energy.grid_import[index] for index in selected)
    pv_only_imported = math.fsum(
        energy.pv_only_import[index] for index in selected
    )
    pv_generation = math.fsum(energy.pv_energy[index] for index in selected)
    pv_direct = math.fsum(energy.pv_to_load[index] for index in selected)
    pv_to_battery = math.fsum(energy.battery_charge[index] for index in selected)
    battery_discharge = math.fsum(
        energy.battery_discharge[index] for index in selected
    )
    measured_days = {intervals[index].source_date for index in selected}
    active_days = {
        intervals[index].source_date
        for index in selected
        if energy.battery_charge[index] > 1e-7
        or energy.battery_discharge[index] > 1e-7
    }
    return {
        "site_import_before_kwh": round(site, 6),
        "grid_import_after_pv_only_kwh": round(pv_only_imported, 6),
        "grid_import_after_kwh": round(imported, 6),
        "grid_import_reduction_kwh": round(max(0.0, site - imported), 6),
        "grid_import_reduction_percent": round(
            100 * max(0.0, site - imported) / site if site > 0 else 0.0, 6
        ),
        "pv_generation_kwh": round(pv_generation, 6),
        "pv_direct_to_load_kwh": round(pv_direct, 6),
        "pv_to_battery_kwh": round(pv_to_battery, 6),
        "grid_export_kwh": round(
            math.fsum(energy.grid_export[index] for index in selected), 6
        ),
        "pv_clipped_kwh": round(
            math.fsum(
                max(
                    0.0,
                    energy.pv_unclipped_energy[index] - energy.pv_energy[index],
                )
                for index in selected
            ),
            6,
        ),
        "pv_self_consumption_percent": round(
            100 * min(pv_generation, pv_direct + pv_to_battery) / pv_generation
            if pv_generation > 0
            else 0.0,
            6,
        ),
        "battery_charge_input_kwh": round(pv_to_battery, 6),
        "battery_discharge_output_kwh": round(battery_discharge, 6),
        "battery_equivalent_full_cycles": round(
            battery_discharge / scenario.nominal_capacity_kwh
            if scenario.nominal_capacity_kwh > 0
            else 0.0,
            6,
        ),
        "battery_active_days": len(active_days),
        "battery_active_day_percent": round(
            100 * len(active_days) / len(measured_days) if measured_days else 0.0,
            6,
        ),
    }


def _performance_metrics(
    indexes,
    *,
    intervals: tuple[CleanedInterval, ...],
    energy: _ScenarioEnergySeries,
    scenario: _Scenario,
) -> dict[str, object]:
    selected = tuple(indexes)
    hours = intervals[0].interval_minutes / 60
    baseline_peak = max(intervals[index].load_kw_avg for index in selected)
    pv_only_peak = max(energy.pv_only_import[index] / hours for index in selected)
    after_peak = max(energy.grid_import[index] / hours for index in selected)
    events = _top_peak_events(
        selected,
        intervals=intervals,
        energy=energy,
        interval_hours=hours,
    )
    top_ten = events[:10]
    effective_power = min(
        scenario.max_discharge_kw, scenario.shared_ac_headroom_kw
    )
    usable_delivered = (
        scenario.nominal_capacity_kwh
        * max(0.0, scenario.max_soc_fraction - scenario.min_soc_fraction)
        * scenario.discharge_efficiency
    )
    soc_values = [
        energy.soc_end[index]
        for index in selected
        if energy.soc_end[index] is not None
    ]
    return {
        "dispatch_basis": "pv_first_coverage_dispatch",
        "baseline_peak_kw": round(baseline_peak, 6),
        "pv_only_peak_kw": round(pv_only_peak, 6),
        "grid_import_peak_kw": round(after_peak, 6),
        "grid_import_peak_reduction_kw": round(
            max(0.0, baseline_peak - after_peak), 6
        ),
        "grid_import_peak_reduction_percent": round(
            100 * max(0.0, baseline_peak - after_peak) / baseline_peak
            if baseline_peak > 0
            else 0.0,
            6,
        ),
        "top_10_event_count": len(top_ten),
        "top_10_events_mitigated": sum(
            1 for event in top_ten if event["mitigated"]
        ),
        "top_10_event_coverage_percent": round(
            100
            * sum(1 for event in top_ten if event["mitigated"])
            / len(top_ten)
            if top_ten
            else 0.0,
            6,
        ),
        "top_20_event_count": len(events),
        "top_20_events_mitigated": sum(
            1 for event in events if event["mitigated"]
        ),
        "top_20_event_coverage_percent": round(
            100
            * sum(1 for event in events if event["mitigated"])
            / len(events)
            if events
            else 0.0,
            6,
        ),
        "battery_duration_at_max_discharge_hours": round(
            usable_delivered / effective_power if effective_power > 0 else 0.0,
            6,
        ),
        "battery_power_to_peak_percent": round(
            100 * effective_power / baseline_peak if baseline_peak > 0 else 0.0,
            6,
        ),
        "minimum_observed_soc_kwh": (
            round(min(value for value in soc_values if value is not None), 6)
            if soc_values
            else None
        ),
        "maximum_observed_soc_kwh": (
            round(max(value for value in soc_values if value is not None), 6)
            if soc_values
            else None
        ),
        "top_peak_events": events,
    }


def _top_peak_events(
    indexes: tuple[int, ...],
    *,
    intervals: tuple[CleanedInterval, ...],
    energy: _ScenarioEnergySeries,
    interval_hours: float,
) -> list[dict[str, object]]:
    selected_indexes: list[int] = []
    for index in sorted(
        indexes,
        key=lambda item: intervals[item].load_kw_avg,
        reverse=True,
    ):
        if all(
            abs(intervals[index].timestamp - intervals[other].timestamp)
            >= timedelta(hours=2)
            for other in selected_indexes
        ):
            selected_indexes.append(index)
            if len(selected_indexes) == 20:
                break
    events = []
    for rank, index in enumerate(selected_indexes, start=1):
        baseline = intervals[index].load_kw_avg
        pv_only = energy.pv_only_import[index] / interval_hours
        after = energy.grid_import[index] / interval_hours
        reduction = max(0.0, baseline - after)
        events.append(
            {
                "rank": rank,
                "timestamp": intervals[index].timestamp.isoformat(),
                "baseline_kw": round(baseline, 6),
                "pv_only_import_kw": round(pv_only, 6),
                "grid_import_kw": round(after, 6),
                "reduction_kw": round(reduction, 6),
                "reduction_percent": round(
                    100 * reduction / baseline if baseline > 0 else 0.0, 6
                ),
                "mitigated": reduction > 1e-7,
            }
        )
    return events


def _daily_profile_cloud(
    intervals: tuple[CleanedInterval, ...], peak_date: date
) -> dict[str, object]:
    grouped: dict[date, list[CleanedInterval]] = defaultdict(list)
    for row in intervals:
        grouped[row.source_date].append(row)
    expected = 24 * 60 // intervals[0].interval_minutes
    complete = [day for day, rows in grouped.items() if len(rows) == expected]
    if not complete:
        return {"sampled_daily_profiles": [], "average_day_kw": []}
    stride = max(1, len(complete) // 90)
    sampled_days = complete[::stride][:90]
    profiles = [
        {
            "date": day.isoformat(),
            "values_kw": [round(row.load_kw_avg, 6) for row in grouped[day]],
        }
        for day in sampled_days
        if day != peak_date
    ]
    average = [
        round(
            math.fsum(grouped[day][slot].load_kw_avg for day in complete)
            / len(complete),
            6,
        )
        for slot in range(expected)
    ]
    return {
        "sampled_daily_profiles": profiles,
        "average_day_kw": average,
        "selected_peak_day_kw": [
            round(row.load_kw_avg, 6) for row in grouped[peak_date]
        ],
        "time_labels": [
            row.timestamp.strftime("%H:%M") for row in grouped[peak_date]
        ],
    }
