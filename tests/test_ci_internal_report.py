from __future__ import annotations

from datetime import datetime, timezone
import json
from uuid import UUID, uuid4

import pytest

from solar_battery.ci_financial_solutions import _canonical_sha256
from solar_battery.ci_internal_report import (
    CiInternalReportError,
    download_ci_internal_report,
    prepare_ci_internal_report,
)
from solar_battery.durable_cockpit.filesystem_object_store import FilesystemObjectStore
from solar_battery.durable_cockpit.orm import CiFinancialSolutionModel
from tests.durable_test_helpers import create_sqlite_session_factory, create_test_client, sqlite_url_for_path


def _source_and_row():
    snapshot_sha = "a" * 64
    selected = {
        "scenario_id": "pv-battery",
        "label": "PV and battery",
        "authored_inputs": {
            "pv_capacity_kwp_dc": 100.0,
            "pv_inverter_capacity_kw_ac": 80.0,
            "nominal_capacity_kwh": 200.0,
            "max_discharge_kw": 100.0,
        },
        "post_dispatch": {"raw_rolling_demand_kva": 80.0},
        "optimizer_run_snapshot": {"snapshot_sha256": snapshot_sha},
        "optimizer_audit_projection": {"snapshot_sha256": snapshot_sha},
    }
    points = [
        {
            "interval_timestamp": f"2026-01-05T{hour:02d}:00:00+11:00",
            "local_time_label": f"{hour:02d}:00 AEDT",
            "no_system": {"import_kw": 120.0 - hour, "import_kva": 125.0 - hour, "grid_charge_kw": 0.0, "pv_charge_kw": 0.0, "battery_discharge_kw": 0.0, "soc_end_kwh": None},
            "pv_only": {"import_kw": 100.0 - hour, "import_kva": 105.0 - hour, "grid_charge_kw": 0.0, "pv_charge_kw": 0.0, "battery_discharge_kw": 0.0, "soc_end_kwh": None},
            "pv_battery": {"import_kw": 80.0 - hour, "import_kva": 85.0 - hour, "grid_charge_kw": 0.0, "pv_charge_kw": 2.0, "battery_discharge_kw": 20.0, "soc_end_kwh": 180.0 - hour},
        }
        for hour in range(8)
    ]
    comparison_without_digest = {
        "contract_version": "ci_three_case_peak_day_comparison_v2",
        "cases": [
            {"case_id": "no_system", "label": "No system", "scenario_id": None},
            {"case_id": "pv_only", "label": "PV only", "scenario_id": "pv-only"},
            {"case_id": "pv_battery", "label": "PV and battery", "scenario_id": "pv-battery", "optimizer_snapshot_sha256": snapshot_sha},
        ],
        "points": points,
        "provenance": {"source_nem12_sha256": "b" * 64},
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "eligibility_permitted": False,
        "delivery_permitted": False,
    }
    comparison = {
        **comparison_without_digest,
        "comparison_sha256": _canonical_sha256(comparison_without_digest),
    }
    physical_digest = _canonical_sha256(selected)
    now = datetime.now(timezone.utc)
    row = CiFinancialSolutionModel(
        id=uuid4(), workspace_id="local-workspace", owner_id="local-analyst",
        label="PV and battery", scenario_id="pv-battery",
        source_physical_scenario_sha256=physical_digest,
        optimizer_run_snapshot_sha256=snapshot_sha,
        optimizer_run_snapshot_json={"snapshot_sha256": snapshot_sha},
        optimizer_audit_projection_json={"snapshot_sha256": snapshot_sha},
        assumptions_json={
            "upfront_cost_aud": 250000.0, "first_year_net_value_aud": 40000.0,
            "annual_om_cost_aud": 1000.0, "replacement_events_aud": [],
            "discount_rate": 0.08, "annual_value_degradation_rate": 0.01,
            "analysis_term_years": 10, "currency": "AUD",
            "value_source": "evidence_bound_tariff_scenario",
            "pricing_resolution": {"tax_basis": "gst_exclusive"},
        },
        metrics_json={
            "net_present_value_aud": 32000.0, "payback_period_years": 6.2,
            "internal_rate_of_return": 0.12,
            "lifetime_net_value_undiscounted_aud": 100000.0,
            "annual_cashflows_aud": [39000.0] * 10,
        },
        starred=False, created_by_actor_id="local-analyst",
        updated_by_actor_id="local-analyst", created_at=now, updated_at=now,
    )
    source = {
        "contract_version": "ci_internal_report_source_v1",
        "analysis": {
            "customer_facing_permission": False,
            "assumptions": ["Synthetic evidence used for this test."],
        },
        "physical_result": {
            "customer_facing_permission": False,
            "recommendation_permitted": False,
            "scenarios": [selected],
        },
        "comparison": comparison,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }
    return source, row


def test_prepare_reuses_exact_source_and_validates_html_pdf_downloads(tmp_path):
    factory = create_sqlite_session_factory(sqlite_url_for_path(tmp_path / "ci-report.sqlite3"))
    store = FilesystemObjectStore(tmp_path / "objects")
    source, row = _source_and_row()
    with factory() as session, session.begin():
        session.add(row)
    with factory() as session, session.begin():
        first = prepare_ci_internal_report(
            session, object_store=store, workspace_id="local-workspace",
            owner_id="local-analyst", actor_id="local-analyst",
            financial_solution_id=row.id, source=source,
        )
    assert first["created_new"] is True
    assert first["page_count"] == 3
    assert first["customer_facing_permission"] is False
    with factory() as session, session.begin():
        second = prepare_ci_internal_report(
            session, object_store=store, workspace_id="local-workspace",
            owner_id="local-analyst", actor_id="local-analyst",
            financial_solution_id=row.id, source=source,
        )
        html, html_type, _ = download_ci_internal_report(
            session, object_store=store, artifact_id=UUID(first["artifact_id"]),
            artifact_kind="html", workspace_id="local-workspace", owner_id="local-analyst",
        )
        pdf, pdf_type, _ = download_ci_internal_report(
            session, object_store=store, artifact_id=UUID(first["artifact_id"]),
            artifact_kind="pdf", workspace_id="local-workspace", owner_id="local-analyst",
        )
    assert second["created_new"] is False
    assert second["artifact_id"] == first["artifact_id"]
    assert html.startswith(b"<!doctype html>") and html_type.startswith("text/html")
    assert pdf.startswith(b"%PDF-") and pdf_type == "application/pdf"


def test_prepare_fails_closed_on_comparison_or_permission_mismatch(tmp_path):
    factory = create_sqlite_session_factory(sqlite_url_for_path(tmp_path / "ci-report-fail.sqlite3"))
    store = FilesystemObjectStore(tmp_path / "objects")
    source, row = _source_and_row()
    with factory() as session, session.begin():
        session.add(row)
    source["comparison"]["customer_facing_permission"] = True
    with factory() as session, session.begin(), pytest.raises(CiInternalReportError) as error:
        prepare_ci_internal_report(
            session, object_store=store, workspace_id="local-workspace",
            owner_id="local-analyst", actor_id="local-analyst",
            financial_solution_id=row.id, source=source,
        )
    assert error.value.code == "ci_internal_report_source_invalid"


def test_authenticated_api_prepares_and_downloads_exact_pair(tmp_path, monkeypatch):
    database_url = sqlite_url_for_path(tmp_path / "ci-report-api.sqlite3")
    factory = create_sqlite_session_factory(database_url)
    source, row = _source_and_row()
    with factory() as session, session.begin():
        session.add(row)
    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {})
    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_internal_report_source",
        lambda *_args, **_kwargs: source,
    )
    with create_test_client(
        database_url, object_store_root=tmp_path / "objects"
    ) as client:
        response = client.post(
            "/api/commercial-industrial/internal-review-report",
            files={"file": ("synthetic.csv", b"synthetic", "text/csv")},
            data={
                "payload": json.dumps(
                    {
                        "financial_solution_id": str(row.id),
                        "scenarios": [{"scenario_id": "pv-only"}, {"scenario_id": "pv-battery"}],
                        "pv_only_scenario_id": "pv-only",
                        "pv_battery_scenario_id": "pv-battery",
                    }
                )
            },
        )
        assert response.status_code == 201
        artifact = response.json()
        state = client.get("/api/commercial-industrial/internal-review-report")
        assert state.status_code == 200
        assert state.json()["artifact"]["artifact_id"] == artifact["artifact_id"]
        html = client.get(
            f'/api/commercial-industrial/internal-review-report/{artifact["artifact_id"]}.html'
        )
        pdf = client.get(
            f'/api/commercial-industrial/internal-review-report/{artifact["artifact_id"]}.pdf'
        )
    assert html.status_code == 200 and html.content.startswith(b"<!doctype html>")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
    assert "attachment" in pdf.headers["content-disposition"]
