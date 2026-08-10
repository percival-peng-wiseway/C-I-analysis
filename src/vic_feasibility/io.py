from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import pandas as pd


@dataclass
class BillEstimate:
    annual_kwh: Optional[float] = None
    annual_energy_cost: Optional[float] = None
    annual_demand_charge: Optional[float] = None
    annual_fixed_charge: Optional[float] = None
    annual_total_cost: Optional[float] = None

    @property
    def implied_energy_rate(self) -> Optional[float]:
        if self.annual_kwh and self.annual_kwh > 0 and self.annual_energy_cost is not None:
            return self.annual_energy_cost / self.annual_kwh
        return None


def _read_any_table(path: Path) -> pd.DataFrame:
    ext = path.suffix.lower()
    if ext in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    return pd.read_csv(path)


def load_load_profile(path: str | Path) -> pd.Series:
    """Load a meter interval time series and return hourly kWh Series."""
    path = Path(path)
    df = _read_any_table(path)
    if df.empty:
        raise ValueError("负荷文件为空")

    cols = {c.lower(): c for c in df.columns}

    timestamp_col = next((cols[k] for k in cols if k in {"timestamp", "time", "datetime", "date"}), None)
    if timestamp_col is None:
        raise ValueError("未找到时间列，请使用 timestamp/time/datetime/date")

    value_col = next((cols[k] for k in cols if k in {
        "kwh",
        "energy_kwh",
        "consumption_kwh",
        "load_kwh",
        "value",
    }), None)
    if value_col is None:
        raise ValueError("未找到用电量列，请使用 kwh/energy_kwh/consumption_kwh/value")

    df = df[[timestamp_col, value_col]].copy()
    df[timestamp_col] = pd.to_datetime(df[timestamp_col], errors="coerce")
    df = df.dropna(subset=[timestamp_col, value_col]).sort_values(timestamp_col)
    df[value_col] = pd.to_numeric(df[value_col], errors="coerce")
    df = df.dropna(subset=[value_col])

    ser = pd.Series(df[value_col].values, index=pd.DatetimeIndex(df[timestamp_col]))
    ser = ser[~ser.index.duplicated(keep="first")]

    # 聚合到小时：如果输入是15min/30min -> sum；1h -> unchanged
    hourly = ser.resample("1h").sum()
    return hourly.astype(float)


def detect_bill_columns(df: pd.DataFrame) -> BillEstimate:
    """Very simple heuristics to estimate annual bill fields."""
    low = {c.lower(): c for c in df.columns}

    def pick(*keywords):
        for k in keywords:
            for c in low:
                if k in c:
                    return low[c]
        return None

    ann_kwh = pick("annual_kwh", "total_kwh", "usage_kwh", "kwh")
    ann_cost = pick("total", "amount", "total_amount", "invoice_total")
    ann_energy = pick("energy", "energy_charge")
    ann_demand = pick("demand", "demand_charge")
    ann_fixed = pick("fixed", "daily")

    def num(v):
        if v is None:
            return None
        series = pd.to_numeric(df[v], errors="coerce")
        if series.dropna().empty:
            return None
        return float(series.dropna().iloc[0])

    return BillEstimate(
        annual_kwh=num(ann_kwh),
        annual_energy_cost=num(ann_energy),
        annual_demand_charge=num(ann_demand),
        annual_fixed_charge=num(ann_fixed),
        annual_total_cost=num(ann_cost),
    )


def load_bill_summary(path: str | Path) -> BillEstimate:
    path = Path(path)
    df = _read_any_table(path)
    if df.empty:
        raise ValueError("账单文件为空")
    return detect_bill_columns(df)


def merge_bill_hint_to_tariff(bill: BillEstimate, tariff):
    """Use bill info to pre-fill simple tariff defaults."""
    if bill is None:
        return tariff

    if bill.annual_kwh and bill.annual_kwh > 0 and bill.annual_energy_cost:
        tariff = tariff
        # 用于页面初始显示，真正仿真按用户后续编辑结果进行
    return tariff
