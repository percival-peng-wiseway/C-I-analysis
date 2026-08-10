from __future__ import annotations

import csv
import io
import math
import tempfile
from pathlib import Path
import sys

from flask import Flask, jsonify, render_template, request, send_from_directory

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from vic_feasibility.engine import run_feasibility
from vic_feasibility.tariff import TimeOfUseRate, TariffConfig

app = Flask(__name__)

ALLOWED_EXTS = {".csv", ".xls", ".xlsx"}


def _float_list(text: str, default: list[float]) -> list[float]:
    vals: list[float] = []
    for piece in (text or "").replace("，", ",").split(","):
        p = piece.strip()
        if not p:
            continue
        try:
            v = float(p)
            if v >= 0:
                vals.append(v)
        except ValueError:
            continue

    if not vals:
        return [float(x) for x in default]
    vals = sorted(set(vals))
    return vals


def _safe_float(v) -> float | None:
    try:
        if v is None:
            return None
        if isinstance(v, str):
            if v.strip() == "":
                return None
            v = float(v)
        if isinstance(v, (int,)):
            return float(v)
        if isinstance(v, float):
            return float(v)
        if math.isnan(float(v)):
            return None
        return float(v)
    except Exception:
        return None


def _to_plain_dict(record: dict) -> dict:
    out = {}
    for k, v in record.items():
        if hasattr(v, "item"):
            try:
                vv = v.item()
            except Exception:
                vv = v
        else:
            vv = v
        if isinstance(vv, bool):
            out[k] = bool(vv)
        elif isinstance(vv, (int, float)):
            out[k] = float(vv)
        elif vv is None:
            out[k] = None
        else:
            out[k] = vv
    return out


def _write_upload(file_storage, suffix_default: str) -> str:
    if file_storage is None or file_storage.filename == "":
        return ""
    suffix = Path(file_storage.filename).suffix.lower()
    if suffix not in ALLOWED_EXTS:
        if suffix:
            suffix = ""  # keep as provided for unsupported
        else:
            suffix = suffix_default
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix or suffix_default)
    file_storage.save(tmp.name)
    return tmp.name


def _cleanup(paths: list[str]) -> None:
    for p in paths:
        try:
            if p:
                Path(p).unlink(missing_ok=True)
        except Exception:
            pass


def _make_tariff(form) -> TariffConfig:
    peak = _safe_float(form.get("peak_rate", 0.278))
    offpeak = _safe_float(form.get("offpeak_rate", 0.178))
    demand = _safe_float(form.get("demand_charge", 9.5)) or 0.0
    fixed = _safe_float(form.get("fixed_daily", 6.4)) or 0.0
    export = _safe_float(form.get("export_rate", 0.05)) or 0.0
    annual_escalation = _safe_float(form.get("annual_escalation", 0.06)) or 0.06
    opex_rate = _safe_float(form.get("opex_rate", 0.01)) or 0.01

    rates = [
        TimeOfUseRate("peak", 7, 22, float(peak), "weekday"),
        TimeOfUseRate("off_peak", 0, 7, float(offpeak), "weekday"),
        TimeOfUseRate("off_peak", 22, 24, float(offpeak), "weekday"),
        TimeOfUseRate("off_peak", 0, 24, float(offpeak), "weekend"),
    ]

    return TariffConfig(
        name="VIC 工商业示例TOU",
        rates=rates,
        demand_charge_per_kw_per_month=float(demand),
        fixed_daily_charge_aud=float(fixed),
        export_rate_aud_per_kwh=float(export),
        annual_escalation=float(annual_escalation),
        opex_rate_pct=float(opex_rate),
    )


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/sample/<name>")
def sample_file(name: str):
    if name not in {"sample_load_hourly.csv", "sample_bill_summary.csv"}:
        return "Not found", 404
    return send_from_directory(str(ROOT / "sample_data"), name, as_attachment=True)


@app.get("/health")
def health():
    return {"ok": True, "service": "vic-ci-web"}


@app.post("/api/analyze")
def analyze():
    load_file = request.files.get("load_file")
    if load_file is None or load_file.filename == "":
        return jsonify({"ok": False, "error": "请上传负荷明细文件（必填）"}), 400

    bill_file = request.files.get("bill_file")

    pv_candidates = _float_list(request.form.get("pv_candidates", ""), [100, 150, 200])
    batt_kw_candidates = _float_list(request.form.get("batt_kw_candidates", ""), [0, 50, 100])
    batt_kwh_candidates = _float_list(request.form.get("batt_kwh_candidates", ""), [0, 100, 150])

    batt_min_soc = _safe_float(request.form.get("batt_min_soc", 0.1)) or 0.1
    batt_eff = _safe_float(request.form.get("batt_eff", 0.9)) or 0.9
    top_n = int(_safe_float(request.form.get("top_n", 8)) or 8)
    top_n = max(1, min(top_n, 200))

    tariff = _make_tariff(request.form)

    load_path = _write_upload(load_file, ".csv")
    bill_path = _write_upload(bill_file, ".csv") if bill_file else ""

    try:
        out = run_feasibility(
            load_path=load_path,
            pv_kw_choices=pv_candidates,
            batt_kw_choices=batt_kw_candidates,
            batt_kwh_choices=batt_kwh_candidates,
            tariff=tariff,
            bill_path=bill_path or None,
            top_n=top_n,
            batt_min_soc=float(max(0.0, min(0.5, batt_min_soc))),
            battery_eff=float(max(0.7, min(0.98, batt_eff))),
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    finally:
        _cleanup([load_path, bill_path])

    baseline = out["baseline_summary"]
    scenarios = out["scenarios"].copy()
    best = out["best_scenarios"].copy()

    best_records = [_to_plain_dict(r) for r in best.to_dict("records")]
    scenario_records = [_to_plain_dict(r) for r in scenarios.to_dict("records")]

    top = best.head(min(8, len(best))).copy()
    cost_labels = [f"PV {int(r['pv_kw'])}kWp + B{int(r['battery_kwh'])}kWh" for _, r in top.iterrows()]

    pivot = top.pivot_table(
        index="pv_kw",
        columns="battery_kwh",
        values="annual_savings",
        aggfunc="max",
        fill_value=0,
    ).fillna(0)

    pivot_payload = {
        "rows": [float(r) for r in pivot.index.tolist()],
        "cols": [float(c) for c in pivot.columns.tolist()],
        "matrix": [[float(v) for v in row] for row in pivot.values.tolist()],
    }

    csv_buf = io.StringIO()
    writer = csv.DictWriter(csv_buf, fieldnames=scenarios.columns)
    writer.writeheader()
    writer.writerows(scenario_records)

    response = {
        "ok": True,
        "baseline": {
            "total_cost": float(baseline.get("total_cost", 0.0)),
            "annual_kwh": float(baseline.get("annual_kwh", 0.0)),
            "energy_cost": float(baseline.get("energy_cost", 0.0)),
            "demand_charge": float(baseline.get("demand_charge", 0.0)),
            "fixed_charge": float(baseline.get("fixed_charge", 0.0)),
            "implied_energy_rate_from_bill": baseline.get("implied_energy_rate_from_bill"),
            "bill_kwh_from_file": baseline.get("bill_kwh_from_file"),
            "bill_total_from_file": baseline.get("bill_total_from_file"),
        },
        "scenario_count": len(scenarios),
        "best": best_records,
        "scenarios_csv": csv_buf.getvalue(),
        "charts": {
            "labels": cost_labels,
            "annual_savings": [float(x) for x in top["annual_savings"].tolist()],
            "annual_grid_cost": [float(x) for x in top["annual_grid_cost"].tolist()],
            "payback_years": [float(x) for x in top["payback_years"].tolist()],
            "irr": [float(x) for x in top["irr_estimate"].tolist()],
            "self_consumption": [float(x) for x in top["self_consumption_ratio"].tolist()],
            "pivot": pivot_payload,
            "baseline_cost": float(baseline.get("total_cost", 0.0)),
        },
        "scenarios": scenario_records,
    }

    return jsonify(response)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
