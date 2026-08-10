from __future__ import annotations

import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

import matplotlib.pyplot as plt
import streamlit as st

from vic_feasibility.engine import run_feasibility
from vic_feasibility.tariff import TARIFF_PRESETS, TimeOfUseRate, TariffConfig

st.set_page_config(page_title="VIC 光伏储能可行性分析", layout="wide")
st.title("VIC 工商业光伏+储能 Feasibility（MVP）")
st.caption("目标：用客户电表明细 + 电价，输出可行性情景对比")

st.markdown("""
**说明**：以下是工程版 MVP，优先保证能跑通“同类能力”的核心：
- 用电账单/明细数据预处理
- 逐小时现金流仿真
- PV/电池组合网格搜索
- 节约分析与财务指标

**请先在左侧上传负荷文件，再设置参数并点击分析。**
""")

st.sidebar.header("1) 文件")
load_file = st.sidebar.file_uploader("上传负荷明细（CSV 或 XLSX）", type=["csv", "xlsx", "xls"])
bill_file = st.sidebar.file_uploader("可选：上传账单摘要（CSV/XLSX）", type=["csv", "xlsx", "xls"])

st.sidebar.header("2) 电价（VIC）")
tariff_name = st.sidebar.selectbox("预设模板", ["VIC_工商业示例TOU"])
tariff = TARIFF_PRESETS[tariff_name]

st.sidebar.subheader("峰值/低谷（示例）")
peak = st.sidebar.number_input("峰段电价（AUD/kWh）", value=tariff.rates[0].rate_aud_per_kwh, min_value=0.0, step=0.001, format="%.3f")
offpeak = st.sidebar.number_input("平段电价（AUD/kWh）", value=tariff.rates[1].rate_aud_per_kwh, min_value=0.0, step=0.001, format="%.3f")
demand_charge = st.sidebar.number_input("需量费（AUD/kW/月）", value=tariff.demand_charge_per_kw_per_month, min_value=0.0, step=0.1)
fixed_daily = st.sidebar.number_input("固定费（AUD/日）", value=tariff.fixed_daily_charge_aud, min_value=0.0, step=0.1)
export_rate = st.sidebar.number_input("反送电单价（AUD/kWh）", value=tariff.export_rate_aud_per_kwh, min_value=0.0, step=0.001)

st.sidebar.header("3) 设备方案")
pv_candidates = st.sidebar.text_input("PV 候选容量 (kWp，英文逗号分隔)", value="0,100,150,200")
batt_kw_candidates = st.sidebar.text_input("电池功率（kW）候选", value="0,50,100")
batt_kwh_candidates = st.sidebar.text_input("电池容量（kWh）候选", value="0,100,200,300")
batt_min_soc = st.sidebar.slider("电池最低SOC", min_value=0.0, max_value=0.5, value=0.1, step=0.05)
batt_eff = st.sidebar.slider("往返效率", min_value=0.7, max_value=0.98, value=0.9, step=0.01)

run_btn = st.button("开始分析", type="primary")


def _float_list(text: str):
    vals = []
    for piece in text.replace("，", ",").split(","):
        s = piece.strip()
        if not s:
            continue
        try:
            vals.append(float(s))
        except ValueError:
            pass
    return sorted(set(v for v in vals if v >= 0)) or [0]

# 自定义电价（保留用户手工修改）
custom_rates = [
    TimeOfUseRate("peak", 7, 22, float(peak), "weekday"),
    TimeOfUseRate("offpeak", 0, 7, float(offpeak), "weekday"),
    TimeOfUseRate("offpeak", 22, 24, float(offpeak), "weekday"),
    TimeOfUseRate("offpeak", 0, 24, float(offpeak), "weekend"),
]
custom_tariff = TariffConfig(
    name=tariff_name,
    rates=custom_rates,
    demand_charge_per_kw_per_month=float(demand_charge),
    fixed_daily_charge_aud=float(fixed_daily),
    export_rate_aud_per_kwh=float(export_rate),
)


def _write_uploaded_file(uploaded, suffix):
    if not uploaded:
        return None
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{suffix}")
    tmp.write(uploaded.read())
    tmp.flush()
    return tmp.name


if run_btn:
    if load_file is None:
        st.error("请先上传负荷明细文件")
    else:
        suffix = "csv" if load_file.name.lower().endswith(".csv") else "xlsx"
        load_path = _write_uploaded_file(load_file, suffix)
        bill_path = _write_uploaded_file(bill_file, "csv" if (bill_file and bill_file.name.lower().endswith("csv")) else "xlsx") if bill_file else None

        if bill_file:
            st.info("已上传账单文件，系统将以实际账单用于结果参考，但价格参数仍按左侧设置参与仿真。")

        with st.spinner("正在计算情景... 这是本地计算，可能几秒到几十秒"):
            try:
                out = run_feasibility(
                    load_path=load_path,
                    pv_kw_choices=_float_list(pv_candidates),
                    batt_kw_choices=_float_list(batt_kw_candidates),
                    batt_kwh_choices=_float_list(batt_kwh_candidates),
                    tariff=custom_tariff,
                    bill_path=bill_path,
                    batt_min_soc=batt_min_soc,
                    battery_eff=batt_eff,
                    top_n=20,
                )
            except Exception as e:
                st.exception(e)
                st.stop()

        baseline = out["baseline_summary"]
        best = out["best_scenarios"]
        scenarios = out["scenarios"]

        st.success(f"分析完成：共评估 {len(scenarios)} 个方案")

        # 指标区
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("基准年电费", f"${baseline['total_cost']:.0f}")
        c2.metric("年用电量", f"{baseline['annual_kwh']:.0f} kWh")
        c3.metric("基准能量费", f"${baseline['energy_cost']:.0f}")
        c4.metric("基准需量费", f"${baseline['demand_charge']:.0f}")

        if "implied_energy_rate_from_bill" in baseline:
            st.caption(f"账单推导均价（仅参考）: ${baseline['implied_energy_rate_from_bill']:.3f}/kWh")

        st.subheader("Top 10 方案（按年化节省排序）")
        cols = [
            "pv_kw", "battery_kwh", "battery_kw", "annual_grid_cost", "annual_savings",
            "payback_years", "npv_20y", "irr_estimate", "self_consumption_ratio",
        ]
        best_view = best[cols].copy()
        best_view["annual_savings"] = best_view["annual_savings"].round(0)
        best_view["annual_grid_cost"] = best_view["annual_grid_cost"].round(0)
        best_view["payback_years"] = best_view["payback_years"].round(1)
        best_view["irr_estimate"] = best_view["irr_estimate"].map(lambda x: f"{x*100:.1f}%")
        best_view["self_consumption_ratio"] = best_view["self_consumption_ratio"].map(lambda x: f"{x*100:.1f}%")
        st.dataframe(best_view.reset_index(drop=True), use_container_width=True)

        st.subheader("Top 方案年化对比图")
        fig, ax = plt.subplots(figsize=(10, 4))
        top3 = best.head(5).copy()
        x = [f"PV{int(r.pv_kw)} + B{int(r.battery_kwh)}kWh" for _, r in top3.iterrows()]
        ax.bar(range(len(top3)), top3["annual_savings"], label="Annual Savings")
        ax.set_xticks(range(len(top3)))
        ax.set_xticklabels(x, rotation=20)
        ax.set_ylabel("年化节省 (AUD)")
        ax.set_title("Top5 方案年化节省")
        ax.grid(axis="y", alpha=0.3)
        st.pyplot(fig)

        st.subheader("Top 方案：PV 与储能成本关系")
        fig2, ax2 = plt.subplots(figsize=(10, 4))
        cost = top3["annual_grid_cost"]
        ax2.bar(range(len(top3)), cost)
        ax2.set_xticks(range(len(top3)))
        ax2.set_xticklabels(x, rotation=20)
        ax2.set_ylabel("方案后年电费 (AUD)")
        ax2.set_title("Top5 方案年电费")
        ax2.grid(axis="y", alpha=0.3)
        st.pyplot(fig2)

        st.subheader("参数敏感度（PV vs 储能）")
        pivot = best.pivot_table(index="pv_kw", columns="battery_kwh", values="annual_savings", aggfunc="max").fillna(0)
        st.dataframe(pivot.round(0), use_container_width=True)

        st.subheader("结果解释")
        st.markdown(
            """
- **payback_years** 为简单回收期（资本支出/年节省）
- **npv_20y** 按 20 年固定现金流估算（未包含折旧、税费和融资成本）
- **self_consumption_ratio** 为自发自用率
- 该 MVP 使用简化光伏曲线模型；若需要精准，请上传场址实测辐照或气象 API 数据。
        """
        )

        st.subheader("下载")
        csv = scenarios.to_csv(index=False).encode("utf-8")
        st.download_button("下载全部方案 CSV", csv, file_name="vic_feasibility_results.csv", mime="text/csv")

else:
    st.info("填写参数后点击左侧‘开始分析’开始运算。")
