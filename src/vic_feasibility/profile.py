from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd


def melbourne_hourly_pv_profile(index: pd.DatetimeIndex,
                              annual_kwh_per_kw: float = 1450.0) -> pd.Series:
    """生成一个维州（近似）基于月份与小时形状的 PV 出力曲线。

    输出单位：kWh per kWp per hour。
    """
    idx = pd.DatetimeIndex(index).tz_localize(None)
    hour = idx.hour.values
    month = idx.month.values

    # 小时形状（黎明到黄昏近似抛物线）
    # 7:00-18:00 有发电，峰值约在 12:30
    day_shape = np.clip(np.sin(np.pi * (hour - 6) / 12.0), 0, None)

    # 季节形状：12月和1月高（夏季），6-7月低（冬季）
    # 365天尺度：day-of-year 172（6/21）附近为夏至，355/175 etc
    doy = idx.dayofyear.to_numpy()
    seasonal = 0.80 + 0.45 * (np.sin(2 * np.pi * (doy - 172) / 365) + 1) / 2

    # 月份微调：冬季抑制更明显
    month_mult = np.array([
        1.05, 1.05, 1.00, 0.95, 0.85,
        0.75, 0.72, 0.78, 0.90, 1.05, 1.10, 1.08
    ])
    m_mult = month_mult[month - 1]

    raw = day_shape * seasonal * m_mult
    # 防止除零
    raw_sum = float(raw.sum())
    if raw_sum <= 0:
        return pd.Series(np.zeros(len(idx)), index=idx, name="pv_kwh_per_kw")

    # 缩放到目标年发电量（kWh/kWp）
    scale = float(annual_kwh_per_kw) / raw_sum
    pv = raw * scale

    # 轻微截断，避免夜间出现负值
    return pd.Series(np.clip(pv, 0, None), index=idx, name="pv_kwh_per_kw")


def load_or_generate_solar_profile(index: pd.DatetimeIndex,
                                 uploaded_path: Optional[str] = None) -> pd.Series:
    """Future: 支持用户上传场址辐照/预计出力文件；当前未上传则使用简化默认型。

    返回单位：每kWp每小时 kWh。
    """
    # 预留接口，先返回默认 profile
    del uploaded_path
    return melbourne_hourly_pv_profile(index)
