from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Iterable, List, Optional

import numpy as np
import pandas as pd

from .io import BillEstimate, load_bill_summary, load_load_profile
from .profile import load_or_generate_solar_profile
from .tariff import TariffConfig, default_vic_commercial_tou


@dataclass
class ScenarioResult:
    pv_kw: float
    battery_kwh: float
    battery_kw: float
    annual_grid_cost: float
    annual_savings: float
    annual_self_consumed_pv_kwh: float
    annual_export_kwh: float
    annual_import_kwh: float
    annual_pv_kwh: float
    baseline_cost: float
    demand_charge: float
    energy_cost: float
    fixed_charge: float
    payback_years: float
    npv_20y: float
    irr_estimate: float
    self_consumption_ratio: float
    hours_of_solar_cover: float


@dataclass
class FeasibilitySummary:
    baseline_summary: Dict
    scenarios: pd.DataFrame
    best_scenarios: pd.DataFrame


def _calc_baseline(load_kwh: pd.Series, tariff: TariffConfig) -> Dict[str, float]:
    idx = load_kwh.index
    rates = [tariff.energy_rate(pd.Timestamp(t)) for t in idx]
    energy_cost = float(np.sum(load_kwh.to_numpy() * np.array(rates)))
    monthly_peak_kw = load_kwh.groupby(load_kwh.index.to_period("M")).max()  # 对于小时序列，kWh=1h等价kW
    demand_charge = float((monthly_peak_kw * tariff.demand_charge_per_kw_per_month).sum())
    fixed_charge = tariff.annual_fixed_charge(len(load_kwh))
    total = energy_cost + demand_charge + fixed_charge

    return {
        "total_cost": total,
        "energy_cost": energy_cost,
        "demand_charge": demand_charge,
        "fixed_charge": fixed_charge,
        "annual_kwh": float(load_kwh.sum()),
    }


def simulate_single_scenario(load_kwh: pd.Series, tariff: TariffConfig, pv_kw: float, battery_kwh: float,
                           battery_kw: float, pv_profile_kwh_per_kw: pd.Series,
                           batt_roundtrip_eff: float = 0.9,
                           battery_min_soc: float = 0.05,
                           battery_initial_soc_ratio: float = 0.2) -> ScenarioResult:
    if len(load_kwh) == 0:
        raise ValueError("负荷数据为空")

    idx = load_kwh.index
    if not load_kwh.index.equals(pv_profile_kwh_per_kw.index):
        raise ValueError("负荷序列和光伏序列时间轴不一致")

    if pv_kw <= 0 and battery_kwh <= 0:
        raise ValueError("PV 或电池至少输入一个正值")

    dt_hours = 1.0
    if len(idx) > 1:
        dt_hours = float((idx[1] - idx[0]).total_seconds()) / 3600.0
        if dt_hours <= 0:
            dt_hours = 1.0

    # capex：简单示例，便于比较
    pv_capex = pv_kw * 1200.0
    batt_capex = battery_kwh * 550.0
    opex_pct = tariff.opex_rate_pct

    rates = pd.Series([tariff.energy_rate(pd.Timestamp(t)) for t in idx], index=idx)

    pv_kwh = pv_kw * pv_profile_kwh_per_kw.astype(float)

    soc = battery_kwh * max(0.0, min(1.0, battery_initial_soc_ratio))

    batt_soc = np.zeros(len(load_kwh), dtype=float)
    grid_import = np.zeros(len(load_kwh), dtype=float)
    grid_export = np.zeros(len(load_kwh), dtype=float)
    batt_ch = np.zeros(len(load_kwh), dtype=float)
    batt_dis = np.zeros(len(load_kwh), dtype=float)
    pv_to_load = np.zeros(len(load_kwh), dtype=float)
    pv_self = np.zeros(len(load_kwh), dtype=float)

    for i, t in enumerate(idx.to_pydatetime()):
        load = float(load_kwh.iloc[i])
        pv = float(pv_kwh.iloc[i])

        direct = min(load, pv)
        pv_to_load[i] = direct

        remaining_load = load - direct
        excess_pv = pv - direct

        ch = 0.0
        dis = 0.0

        if battery_kwh > 0:
            # 优先把富余PV充电
            if excess_pv > 1e-9:
                avail_cap = max(0.0, battery_kwh * (1.0 - battery_min_soc) - soc)
                max_ch = min(excess_pv, battery_kw * dt_hours, avail_cap / max(batt_roundtrip_eff, 1e-6))
                ch = max(0.0, max_ch)
                soc += ch * batt_roundtrip_eff
                excess_pv -= ch
            else:
                excess_pv = 0.0

            grid_export[i] = excess_pv

            # 再用电池给剩余负荷补网电
            if remaining_load > 1e-9:
                # 可放出功率与SOC受限
                max_discharge = min(remaining_load, battery_kw * dt_hours, soc - battery_kwh * battery_min_soc)
                dis = max(0.0, min(max_discharge, soc * batt_roundtrip_eff))
                # 放电到负荷后能量损失
                soc -= dis / max(batt_roundtrip_eff, 1e-6)
                remaining_load = max(0.0, remaining_load - dis)
        else:
            # 无电池时，剩余光伏直接计入外送
            grid_export[i] = excess_pv

        batt_dis[i] = dis
        batt_ch[i] = ch
        batt_soc[i] = soc
        pv_self[i] = direct + ch
        grid_import[i] = remaining_load

    sim = pd.DataFrame({
        "load_kwh": load_kwh.values,
        "pv_kwh": pv_kwh.values,
        "pv_to_load": pv_to_load,
        "battery_charge_kwh": batt_ch,
        "battery_discharge_kwh": batt_dis,
        "battery_soc_kwh": batt_soc,
        "grid_import_kwh": grid_import,
        "grid_export_kwh": grid_export,
        "energy_rate": rates.values,
    }, index=idx)

    energy_cost = float((sim["grid_import_kwh"] * sim["energy_rate"]).sum())
    export_credit = float((sim["grid_export_kwh"] * tariff.export_rate_aud_per_kwh).sum())

    monthly_peak_kw = (sim["grid_import_kwh"] / max(dt_hours, 1e-9)).groupby(sim.index.to_period("M")).max()
    demand_charge = float((monthly_peak_kw * tariff.demand_charge_per_kw_per_month).sum())
    fixed_charge = tariff.annual_fixed_charge(len(load_kwh))

    annual_grid_cost = energy_cost - export_credit + demand_charge + fixed_charge
    baseline_cost = float(_calc_baseline(load_kwh, tariff)["total_cost"])
    annual_savings = baseline_cost - annual_grid_cost

    annual_pv_kwh = float(pv_kwh.sum())
    annual_self = float(pv_self.sum())
    annual_export = float(sim["grid_export_kwh"].sum())
    annual_import = float(sim["grid_import_kwh"].sum())

    self_consumption_ratio = (annual_self / annual_pv_kwh) if annual_pv_kwh > 0 else 0.0
    # 简化：覆盖小时数 = 负载时段有PV供电的小时占比
    hours_of_solar_cover = float(np.mean((sim["pv_to_load"] > 0).astype(float)) * 24 * 365)

    capex = pv_capex + batt_capex
    opex = capex * opex_pct
    cashflows = [-(capex)] + [annual_savings - opex] * 20

    # 粗略IRR：先用NPV反解为 payback
    npv = -capex
    if annual_savings <= 0:
        payback = 999.0
        irr = -1.0
    else:
        payback = capex / annual_savings
        irr = ((annual_savings * 20) / capex) ** (1 / 20) - 1 if capex > 0 else 0.0

        npv = 0.0
        discount = 1.0 + (tariff.annual_escalation if tariff.annual_escalation else 0.06)
        for t, cf in enumerate(cashflows):
            npv += cf / (discount ** t)

    return ScenarioResult(
        pv_kw=float(pv_kw),
        battery_kwh=float(battery_kwh),
        battery_kw=float(battery_kw),
        annual_grid_cost=float(annual_grid_cost),
        annual_savings=float(annual_savings),
        annual_self_consumed_pv_kwh=float(annual_self),
        annual_export_kwh=float(annual_export),
        annual_import_kwh=float(annual_import),
        annual_pv_kwh=float(annual_pv_kwh),
        baseline_cost=baseline_cost,
        demand_charge=demand_charge,
        energy_cost=energy_cost,
        fixed_charge=fixed_charge,
        payback_years=float(payback),
        npv_20y=float(npv),
        irr_estimate=float(irr),
        self_consumption_ratio=float(self_consumption_ratio),
        hours_of_solar_cover=float(hours_of_solar_cover),
    )


def _make_range(values_or_range: Iterable[int | float] | None, default: List[int]) -> List[float]:
    if values_or_range is None:
        return [float(x) for x in default]
    vals = list(values_or_range)
    if len(vals) == 1:
        return [float(vals[0])]
    return [float(v) for v in vals]


def run_feasibility(load_path: str,
                   pv_kw_choices: Iterable[int | float] | None = None,
                   batt_kw_choices: Iterable[int | float] | None = None,
                   batt_kwh_choices: Iterable[int | float] | None = None,
                   tariff: Optional[TariffConfig] = None,
                   bill_path: Optional[str] = None,
                   pv_profile_path: Optional[str] = None,
                   top_n: int = 20,
                   batt_min_soc: float = 0.1,
                   battery_eff: float = 0.9,
                   ) -> Dict:
    tariff = tariff or default_vic_commercial_tou()
    load_kwh = load_load_profile(load_path)

    baseline = _calc_baseline(load_kwh, tariff)

    bill_est: Optional[BillEstimate] = None
    if bill_path:
        bill_est = load_bill_summary(bill_path)

    if bill_est and bill_est.annual_total_cost is not None:
        baseline["bill_total_from_file"] = bill_est.annual_total_cost
        if bill_est.annual_kwh:
            baseline["bill_kwh_from_file"] = bill_est.annual_kwh
    if bill_est and bill_est.implied_energy_rate:
        # 仅用于提示，不直接覆盖默认率，避免误导
        baseline["implied_energy_rate_from_bill"] = bill_est.implied_energy_rate

    pv_kw_choices = _make_range(pv_kw_choices, [100, 200, 300])
    batt_kw_choices = _make_range(batt_kw_choices, [50, 100, 150])
    batt_kwh_choices = _make_range(batt_kwh_choices, [0, 100, 200])

    pv_profile = load_or_generate_solar_profile(load_kwh.index, uploaded_path=pv_profile_path)

    results = []
    for pv_kw in pv_kw_choices:
        for bat_kw in batt_kw_choices:
            for bat_kwh in batt_kwh_choices:
                # 对battery_kw不满足常识约束则跳过
                if bat_kwh == 0 and bat_kw > 0:
                    continue
                if bat_kw > 0 and bat_kwh == 0:
                    continue
                if pv_kw == 0 and bat_kwh == 0:
                    continue
                try:
                    res = simulate_single_scenario(
                        load_kwh,
                        tariff=tariff,
                        pv_kw=float(pv_kw),
                        battery_kwh=float(bat_kwh),
                        battery_kw=float(bat_kw),
                        pv_profile_kwh_per_kw=pv_profile,
                        batt_roundtrip_eff=float(max(0.7, min(0.98, battery_eff))),
                        battery_min_soc=float(max(0.0, min(0.5, batt_min_soc))),
                    )
                except Exception:
                    continue
                results.append(asdict(res))

    scenarios = pd.DataFrame(results)
    if scenarios.empty:
        raise RuntimeError("未生成可用方案，请放宽参数范围")

    scenarios = scenarios.sort_values(["annual_savings", "npv_20y"], ascending=[False, False])
    best = scenarios.head(top_n).copy()

    return {
        "baseline_summary": baseline,
        "scenarios": scenarios,
        "best_scenarios": best,
    }
