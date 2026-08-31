from __future__ import annotations

import math

import pytest

from solar_battery.ci_internal_report_renderer import (
    RENDERER_CONTRACT_VERSION,
    CiInternalReportRenderError,
    render_ci_internal_review_report_html,
)


def _contract() -> dict[str, object]:
    point = {
        "interval_timestamp": "2025-01-01T00:00:00+11:00",
        "no_system": {"import_kw": 10, "import_kva": 12, "soc_end_kwh": None},
        "pv_only": {"import_kw": 8, "import_kva": 9, "soc_end_kwh": None},
        "pv_battery": {"import_kw": 6, "import_kva": 7, "battery_discharge_kw": 2, "soc_end_kwh": 40},
    }
    return {
        "contract_version": "ci_internal_review_report_v1",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "eligibility_permitted": False,
        "manual_delivery_permission": False,
        "repository_managed_delivery_permission": False,
        "document": {"report_label": "Private internal review", "solution_label": "Solar + battery"},
        "solution": {"configuration": "100 kWp / 50 kWh", "pv_capacity_kwp_dc": 100, "battery_capacity_kwh": 50, "inverter_kw": 50},
        "comparison": {"points": [point], "cases": [{"case_id": "no_system", "label": "No system", "peak_kw": 10, "peak_kva": 12}, {"case_id": "pv_only", "label": "PV-only", "peak_kw": 8, "peak_kva": 9}, {"case_id": "pv_battery", "label": "PV+battery", "peak_kw": 6, "peak_kva": 7}]},
        "financial_solution": {"metrics": {"upfront_cost_aud": 1000, "first_year_net_value_aud": 200, "net_present_value_aud": 500, "payback_period_years": 5, "internal_rate_of_return": 0.1, "annual_cashflows_aud": [200, 190]}},
        "source_identity": {"source_fingerprint": "abc", "comparison_sha256": "d" * 64},
    }


def test_renderer_is_deterministic_self_contained_and_three_pages():
    first = render_ci_internal_review_report_html(_contract())
    second = render_ci_internal_review_report_html(_contract())
    assert first == second
    assert first.count(b'class="page"') == 3
    assert b"https://" not in first and b"http://" not in first
    assert RENDERER_CONTRACT_VERSION.encode() in first


def test_renderer_contains_required_internal_wording_and_values():
    rendered = render_ci_internal_review_report_html(_contract()).decode()
    for phrase in ("Private internal review", "Not a customer report", "customer-facing permission: false", "recommendation permission: false", "100", "500", "2025-01-01"):
        assert phrase in rendered
    for forbidden in ("best", "recommended", "approved", "guaranteed"):
        assert forbidden not in rendered.lower()


def test_renderer_rejects_permissions_and_nonfinite_values():
    bad_permission = _contract()
    bad_permission["customer_facing_permission"] = True
    with pytest.raises(CiInternalReportRenderError):
        render_ci_internal_review_report_html(bad_permission)
    bad_number = _contract()
    bad_number["comparison"] = {"points": [{"value": math.nan}]}
    with pytest.raises(CiInternalReportRenderError):
        render_ci_internal_review_report_html(bad_number)
