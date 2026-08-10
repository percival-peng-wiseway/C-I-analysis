from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from vic_feasibility.engine import run_feasibility
from vic_feasibility.tariff import default_vic_commercial_tou

def _parse_list(value: str):
    vals = []
    for x in value.replace("，", ",").split(","):
        x = x.strip()
        if x:
            vals.append(float(x))
    if not vals:
        vals = [0]
    return vals


def main() -> None:
    p = argparse.ArgumentParser(description="VIC C&I feasibility quick runner")
    p.add_argument("--load", required=True, help="负荷明细文件路径 (csv/xlsx)")
    p.add_argument("--bill", help="可选账单摘要文件路径")
    p.add_argument("--pv", default="0,100,200", help="PV 候选 kWp")
    p.add_argument("--batt-kw", default="0,100", help="储能功率 kW 候选")
    p.add_argument("--batt-kwh", default="0,200", help="储能容量 kWh 候选")
    p.add_argument("--top", type=int, default=5, help="返回前N方案")
    args = p.parse_args()

    result = run_feasibility(
        load_path=args.load,
        bill_path=args.bill,
        pv_kw_choices=_parse_list(args.pv),
        batt_kw_choices=_parse_list(args.batt_kw),
        batt_kwh_choices=_parse_list(args.batt_kwh),
        tariff=default_vic_commercial_tou(),
        top_n=args.top,
    )

    print(f"基准年电费: {result['baseline_summary']['total_cost']:.2f} AUD")
    print(f"基准年用电量: {result['baseline_summary']['annual_kwh']:.2f} kWh")
    print("\n前N名方案:")
    print(result["best_scenarios"][
        ["pv_kw", "battery_kw", "battery_kwh", "annual_savings", "payback_years", "npv_20y", "self_consumption_ratio"]
    ].head(args.top).to_string(index=False))


if __name__ == "__main__":
    main()
