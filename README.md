# VIC 光伏+电池可行性分析（工商业）

这是一个可本地运行的 MVP：基于客户详细用电曲线（建议 15min/30min/1h）和电费输入，
快速做工商业客户的 **HOMER/Orkestra 类似 feasibility 分析**。

当前版本聚焦：
- 光伏（PV）与储能（Battery）规模组合
- VIC 工商业场景下的账单与现金流
- 月峰值需量、能量电费、固定费、可选反送电计价
- 简洁仪表盘（streamlit）和图表

> ⚠️ 注意：默认电价参数是“演示值/示例参数”，请用客户真实合同/电费协议替换。

## 功能

- 上传：
  - `CSV/XLSX` 负荷曲线（时间戳 + 用电量 kWh）
  - 可选：账单摘要文件（用于自动估计基准电价）
- 自动预处理：时间解析、时区/频率处理、按小时聚合
- 情景分析：网格搜索 PV（kWp）与电池（kWh / kW）组合
- 输出：
  - 年化基准电费与系统后电费
  - 能源费/需量费分解
  - 简单 NPV/回收期/IRR 近似指标
  - 节省率、负荷自发自用率
  - 月度柱状节约、年化现金流、示例场景的逐时仿真曲线

## 快速开始

```bash
cd /home/jojo/projects/solar-feasibility-vic
python -m pip install -r requirements.txt
streamlit run app.py
```

## 输入文件格式（示例）

### 负荷曲线（必需）

文件需包含时间戳与每个计量间隔的能量列。例如:

```csv
# sample_data/sample_load_hourly.csv
timestamp,energy_kwh
2026-01-01 00:00:00,85.2
2026-01-01 01:00:00,72.4
...
```

程序会自动识别常见字段名：
- 时间列：`timestamp`,`time`,`datetime`,`date`
- 用电量列：`kwh`,`energy_kwh`,`consumption_kwh`,`value`

### 账单文件（可选）

支持 `bill_amount`, `annual_kwh`, `peak_kw`, `demand_charge`, `energy_charge` 等关键字段，缺省会尝试做文本匹配提取。

## 示例运行（无UI）

在 shell 下生成一个样例场景并输出前 5 行结果:

```bash
cd /home/jojo/projects/solar-feasibility-vic
python - <<'PY'
from pathlib import Path
from vic_feasibility.engine import run_feasibility
import pandas as pd

load_csv = Path('sample_data/sample_load_hourly.csv')
res = run_feasibility(
    load_path=load_csv,
    pv_kw_choices=[0,100,200],
    batt_kw_choices=[0,50,100],
    batt_kwh_choices=[0,150,300],
)
print(res['best_scenarios'][['pv_kw','battery_kwh','npv_20y','payback_years','annual_savings']].head())
print('baseline annual cost:', res['baseline_summary']['total_cost'])
PY
```

## 文件结构

- `app.py`：Streamlit UI
- `src/vic_feasibility/`：核心计算引擎
- `sample_data/`：示例文件

## 后续可扩展

- 接入真实天气站点（Swin) API 形成更准确太阳资源（按纬度/经度）
- 支持更多 VIC 电费结构（阶梯、分时段需量、季节分段）
- 加入项目层级多场址、导出 PDF 报告（含图表）
- 加入报价模板和客户参数（OPEX、融资成本、税前税后等）