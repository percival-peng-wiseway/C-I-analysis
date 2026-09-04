from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta
import hashlib
from uuid import UUID

from solar_battery.ci_project_tariff_profile import (
    approved_ci_project_tariff_calculation_profile,
)
from solar_battery.ci_project_evidence import update_ci_project_evidence_inspection
from solar_battery.ci_tariff_analysis import analyze_ci_nem12
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    local_actor,
    sqlite_url_for_path,
)
from tests.test_ci_tariff_analysis import _nem12_bytes, _nem12_bytes_for_dates


def _approved_evidence_inspection() -> dict[str, object]:
    return {
        "contract_version": "ci_evidence_intake_v10",
        "intake_status": "ready_for_profile_review",
        "bill": {
            "retailer": "Synthetic Retailer",
            "invoice_kind": "Synthetic business electricity invoice",
            "extraction_method": "verified_synthetic_template",
            "review_status": "not_required",
            "missing_fields": [],
            "invoice_arithmetic_scope": "charge_categories_and_totals",
            "billing_period_start": "2026-01-05",
            "billing_period_end": "2026-01-05",
            "billing_days": 1,
            "network_tariff_code": "LLVT2",
            "consumption_kwh": 288.0,
            "highest_metered_demand_kva": 15.0,
            "power_factor_at_highest_demand": 0.8,
            "charge_categories_ex_gst_aud": {
                "energy_charges": 28.8,
                "network_charges": 57.6,
                "regulated_charges": 2.88,
                "environmental_charges": 1.44,
                "metering_charges": 2.0,
                "additional_charges": -5.0,
            },
            "subtotal_ex_gst_aud": 87.72,
            "gst_aud": 8.77,
            "total_inc_gst_aud": 96.49,
        },
        "nem12": {
            "input_format": "nem12_standard",
            "coverage_start": "2026-01-05",
            "coverage_end": "2026-01-05",
            "interval_minutes": 5,
            "stream_ids": ["B1", "E1", "K1", "Q1"],
            "aligned_stream_ids": ["B1", "E1", "K1", "Q1"],
            "missing_stream_ids": [],
            "unaligned_stream_ids": [],
            "capability_status": "full_active_reactive_import_export",
            "full_tariff_analysis_ready": True,
            "days_per_stream": 1,
            "quality_method_counts": {"A": 4},
            "quality_override_count": 0,
        },
        "pair_checks": [
            {"code": code, "passed": True, "severity": "pass", "message": "Passed."}
            for code in (
                "site_identity_match",
                "bill_period_covered",
                "invoice_arithmetic",
                "bill_review_confirmed",
                "supported_current_tariff",
            )
        ],
        "privacy": {
            "files_persisted": True,
            "customer_identifiers_returned": False,
            "customer_facing_permission": False,
        },
    }


def _annual_meter_dates() -> list[str]:
    start = date(2025, 1, 6)
    return [
        (start + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(365)
    ]


def _annual_nem12_bytes() -> bytes:
    return _nem12_bytes_for_dates(_annual_meter_dates())


def _nem12_bytes_with_future_peak(
    *,
    start: date,
    end: date,
    future_peak_day: date,
) -> bytes:
    rows = ["100,NEM12,202601060000,SYNTHETIC"]
    base_active = ",".join(["1.0"] * 288)
    future_active = ",".join(["10.0"] * 288)
    reactive = ",".join(["0.75"] * 288)
    zeros = ",".join(["0.0"] * 288)
    dates = [
        start + timedelta(days=offset)
        for offset in range((end - start).days + 1)
    ]
    for register, unit, base_intervals in (
        ("B1", "kWh", zeros),
        ("E1", "kWh", base_active),
        ("K1", "kVArh", zeros),
        ("Q1", "kVArh", reactive),
    ):
        rows.append(
            f"200,SYNTH0001,B1E1K1Q1,{register},{register},N1,METER1,{unit},5"
        )
        for meter_day in dates:
            intervals = (
                future_active
                if register == "E1" and meter_day == future_peak_day
                else base_intervals
            )
            rows.append(
                f"300,{meter_day.strftime('%Y%m%d')},{intervals},A,,,"
            )
    rows.append("900")
    return ("\n".join(rows) + "\n").encode()


def _annualized_evidence_inspection() -> dict[str, object]:
    inspection = _approved_evidence_inspection()
    inspection["nem12"] = {
        **inspection["nem12"],
        "coverage_start": "2025-01-06",
        "coverage_end": "2026-01-05",
        "days_per_stream": 365,
    }
    inspection["annual_bill_estimate"] = {
        "status": "estimated",
        "method": "bill_derived_interval_scaled_v1",
        "confidence": "evidence_limited",
        "tariff_code": "LLVT2",
        "coverage_start": "2025-01-06",
        "coverage_end": "2026-01-05",
        "annual_import_kwh": 105120.0,
        "bill_period_reconciliation": {"status": "pass"},
        "total_ex_gst_aud": 33842.8,
        "customer_facing_permission": False,
        "warning": "Internal evidence-limited estimate.",
        "assumptions": [],
        "groups": [],
    }
    return inspection


def _future_peak_evidence_inspection() -> dict[str, object]:
    inspection = _annualized_evidence_inspection()
    inspection["bill"] = {
        **inspection["bill"],
        "billing_period_start": "2025-06-30",
        "billing_period_end": "2025-06-30",
    }
    inspection["nem12"] = {
        **inspection["nem12"],
        "coverage_start": "2024-07-01",
        "coverage_end": "2025-12-31",
        "days_per_stream": 549,
    }
    inspection["annual_bill_estimate"] = {
        **inspection["annual_bill_estimate"],
        "coverage_start": "2025-01-01",
        "coverage_end": "2025-12-31",
    }
    return inspection


def _create_project(client, *, name: str = "Tariff profile project") -> tuple[UUID, str]:
    response = client.post(
        "/api/commercial-industrial/projects",
        json={"display_name": name},
    )
    assert response.status_code == 201
    project_id = UUID(response.json()["project_id"])
    return project_id, f"/api/commercial-industrial/projects/{project_id}"


def _save_evidence(client, project_url: str, *, bill_bytes: bytes, nem12: bytes) -> None:
    response = client.post(
        f"{project_url}/evidence-intake/inspect",
        files={
            "bill": ("bill.pdf", bill_bytes, "application/pdf"),
            "nem12": ("nem12.csv", nem12, "text/csv"),
        },
    )
    assert response.status_code == 200


def test_project_tariff_profile_without_evidence_is_not_available(tmp_path) -> None:
    database_url = sqlite_url_for_path(tmp_path / "no-evidence.sqlite3")
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)

        response = client.get(f"{project_url}/tariff-profile")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "contract_version": "ci_project_tariff_profile_state_v1",
        "status": "not_available",
        "updated_at": None,
        "approved_at": None,
        "profile_sha256": None,
        "profile": None,
        "suggested_profile": None,
        "evidence_basis": None,
        "blockers": [
            {
                "code": "tariff_evidence_required",
                "message": "Upload and confirm a bill with detected tariff charge categories.",
            }
        ],
    }


def test_bill_evidence_produces_a_review_only_tariff_suggestion(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _approved_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "suggestion.sqlite3")
    nem12 = _nem12_bytes()
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)

        response = client.get(f"{project_url}/tariff-profile")

    assert response.status_code == 200
    state = response.json()
    assert state["status"] == "not_available"
    assert state["profile"] is None
    assert [item["code"] for item in state["blockers"]] == [
        "tariff_annual_interval_required",
        "tariff_profile_approval_required",
    ]
    suggestion = state["suggested_profile"]
    assert suggestion["contract_version"] == "ci_project_tariff_profile_v1"
    assert suggestion["network_tariff_code"] == "LLVT2"
    assert suggestion["additional_bill_adjustment_aud"] == -5.0
    assert suggestion["rates"] == {
        "aemo_ancillary_c_per_kwh": 1.0,
        "aemo_frc_c_per_day": 0.0,
        "aemo_participant_c_per_kwh": 0.0,
        "environmental_c_per_kwh": 0.5,
        "environmental_certificate_fraction": 1.0,
        "incentive_demand_aud_per_kva_month": 0.0,
        "metering_aud_per_day": 2.0,
        "network_off_peak_c_per_kwh": 20.0,
        "network_peak_c_per_kwh": 20.0,
        "retail_off_peak_c_per_kwh": 10.0,
        "retail_peak_c_per_kwh": 10.0,
        "rolling_demand_aud_per_kva_month": 0.0,
        "value_added_c_per_day": 0.0,
    }
    assert suggestion["windows"]["rolling_demand"] == {
        "start": "07:00",
        "end": "19:00",
    }
    assert suggestion["windows"]["incentive_demand"] == {
        "start": "16:00",
        "end": "19:00",
    }
    assert "not detected contractual line items" in state["evidence_basis"][
        "derivation_notice"
    ]


def test_draft_save_does_not_create_an_approved_calculation_profile(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _approved_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "draft.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    nem12 = _nem12_bytes()
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        suggestion.pop("additional_bill_adjustment_aud")

        response = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": False},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "draft"
    assert response.json()["approved_at"] is None
    assert "additional_bill_adjustment_aud" not in response.json()["profile"]
    with session_factory() as session:
        assert (
            approved_ci_project_tariff_calculation_profile(
                session, project_id=project_id, actor=local_actor()
            )
            is None
        )


def test_approval_requires_a_complete_365_day_fixed_aest_meter_period(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _approved_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "annual-period-required.sqlite3")
    nem12 = _nem12_bytes()
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        state = client.get(f"{project_url}/tariff-profile").json()

        response = client.put(
            f"{project_url}/tariff-profile",
            json={
                "profile": state["suggested_profile"],
                "approve_for_calculation": True,
            },
        )

    assert state["status"] == "not_available"
    assert state["blockers"][0]["code"] == "tariff_annual_interval_required"
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "tariff_annual_interval_required"


def test_approval_requires_365_days_ending_on_the_bill_end(
    tmp_path, monkeypatch
) -> None:
    inspection = _annualized_evidence_inspection()
    inspection["bill"] = {
        **inspection["bill"],
        "billing_period_start": "2025-07-01",
        "billing_period_end": "2025-07-01",
    }
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: inspection,
    )
    database_url = sqlite_url_for_path(tmp_path / "bill-history-required.sqlite3")
    nem12 = _annual_nem12_bytes()
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        state = client.get(f"{project_url}/tariff-profile").json()
        response = client.put(
            f"{project_url}/tariff-profile",
            json={
                "profile": state["suggested_profile"],
                "approve_for_calculation": True,
            },
        )

    assert state["blockers"][0]["code"] == "tariff_annual_interval_required"
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "tariff_annual_interval_required"


def test_approval_binds_the_real_saved_nem12_and_loads_a_calculation_profile(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _annualized_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "approved.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    nem12 = _annual_nem12_bytes()
    bill_bytes = b"synthetic approved bill"
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=bill_bytes, nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]

        response = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": True},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["approved_at"] is not None
    with session_factory() as session:
        calculation_profile = approved_ci_project_tariff_calculation_profile(
            session, project_id=project_id, actor=local_actor()
        )
    assert calculation_profile is not None
    assert calculation_profile["source_bill_sha256"] == hashlib.sha256(
        bill_bytes
    ).hexdigest()
    assert calculation_profile["expected_nem12_sha256"] == hashlib.sha256(
        nem12
    ).hexdigest()
    assert calculation_profile["additional_bill_adjustment_aud"] == -5.0
    assert calculation_profile["expected_reconciliation"][
        "category_additional_charges_aud"
    ] == -5.0
    assert calculation_profile["analysis_period"] == {
        "start_date": "2025-01-06",
        "end_date": "2026-01-05",
    }
    assert calculation_profile["rolling_period"] == calculation_profile[
        "analysis_period"
    ]
    assert calculation_profile["rolling_demand_window"] == {
        "start": "07:00",
        "end": "19:00",
        "time_basis": "local",
        "excluded_dates": [],
    }
    assert calculation_profile["incentive_demand_window"] == {
        "start": "16:00",
        "end": "19:00",
        "time_basis": "local",
        "excluded_dates": [],
    }
    assert calculation_profile["annual_financial_model"][
        "incentive_demand_months"
    ] == [12, 1, 2, 3]
    assert calculation_profile["expected_reconciliation"]["import_kwh"] == 288.0
    assert analyze_ci_nem12(nem12, profile=calculation_profile)[
        "analysis_status"
    ] == "ready"


def test_bill_reconciliation_rolling_period_excludes_a_future_analysis_peak(
    tmp_path, monkeypatch
) -> None:
    inspection = _future_peak_evidence_inspection()
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: inspection,
    )
    nem12 = _nem12_bytes_with_future_peak(
        start=date(2024, 7, 1),
        end=date(2025, 12, 31),
        future_peak_day=date(2025, 12, 1),
    )
    database_url = sqlite_url_for_path(tmp_path / "future-peak.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        response = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": True},
        )

    assert response.status_code == 200
    with session_factory() as session:
        calculation_profile = approved_ci_project_tariff_calculation_profile(
            session, project_id=project_id, actor=local_actor()
        )
    assert calculation_profile is not None
    assert calculation_profile["rolling_period"] == {
        "start_date": "2024-07-01",
        "end_date": "2025-06-30",
    }
    assert calculation_profile["analysis_period"] == {
        "start_date": "2025-01-01",
        "end_date": "2025-12-31",
    }
    assert calculation_profile["expected_reconciliation"][
        "rolling_demand_kva"
    ] == 15.0


def test_replacing_evidence_marks_the_approved_tariff_profile_stale(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _annualized_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "stale.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    nem12 = _annual_nem12_bytes()
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"first bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        approved = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": True},
        )
        assert approved.status_code == 200

        _save_evidence(client, project_url, bill_bytes=b"replacement bill", nem12=nem12)
        response = client.get(f"{project_url}/tariff-profile")

    assert response.status_code == 200
    assert response.json()["status"] == "stale"
    assert response.json()["blockers"][0]["code"] == "tariff_profile_stale"
    with session_factory() as session:
        assert (
            approved_ci_project_tariff_calculation_profile(
                session, project_id=project_id, actor=local_actor()
            )
            is None
        )


def test_material_bill_review_change_marks_the_approved_profile_stale(
    tmp_path, monkeypatch
) -> None:
    inspection = _annualized_evidence_inspection()
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: deepcopy(inspection),
    )
    database_url = sqlite_url_for_path(tmp_path / "stale-tariff-facts.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    nem12 = _annual_nem12_bytes()
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"same bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        approved = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": True},
        )
        assert approved.status_code == 200

        changed_inspection = deepcopy(inspection)
        changed_inspection["bill"]["charge_categories_ex_gst_aud"][
            "energy_charges"
        ] = 29.8
        with session_factory() as session:
            with session.begin():
                update_ci_project_evidence_inspection(
                    session,
                    project_id=project_id,
                    actor=local_actor(),
                    inspection_result=changed_inspection,
                )

        response = client.get(f"{project_url}/tariff-profile")

    assert response.status_code == 200
    assert response.json()["status"] == "stale"
    with session_factory() as session:
        assert (
            approved_ci_project_tariff_calculation_profile(
                session, project_id=project_id, actor=local_actor()
            )
            is None
        )


def test_losing_the_complete_annual_period_invalidates_an_approved_profile(
    tmp_path, monkeypatch
) -> None:
    inspection = _annualized_evidence_inspection()
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: deepcopy(inspection),
    )
    database_url = sqlite_url_for_path(tmp_path / "annual-period-stale.sqlite3")
    session_factory = create_sqlite_session_factory(database_url)
    nem12 = _annual_nem12_bytes()
    with create_test_client(database_url) as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"same bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        approved = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": suggestion, "approve_for_calculation": True},
        )
        assert approved.status_code == 200

        changed_inspection = deepcopy(inspection)
        changed_inspection["annual_bill_estimate"] = {
            "status": "unavailable",
            "method": "unavailable",
            "coverage_start": None,
            "coverage_end": None,
            "annual_import_kwh": None,
            "bill_period_reconciliation": {"status": "pass"},
        }
        with session_factory() as session:
            with session.begin():
                update_ci_project_evidence_inspection(
                    session,
                    project_id=project_id,
                    actor=local_actor(),
                    inspection_result=changed_inspection,
                )

        response = client.get(f"{project_url}/tariff-profile")

    assert response.status_code == 200
    assert response.json()["status"] == "stale"
    assert response.json()["blockers"] == [
        {
            "code": "tariff_annual_interval_required",
            "message": (
                "Upload NEM12 with a most-recent complete 365 consecutive "
                "fixed-AEST meter-date period before running Finance Analysis."
            ),
        }
    ]
    with session_factory() as session:
        assert (
            approved_ci_project_tariff_calculation_profile(
                session, project_id=project_id, actor=local_actor()
            )
            is None
        )


def test_approval_rejects_rates_that_do_not_reconcile_to_the_bill(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _annualized_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "bill-mismatch.sqlite3")
    nem12 = _annual_nem12_bytes()
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        profile = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]
        profile["rates"]["retail_peak_c_per_kwh"] = 99.0
        profile["rates"]["retail_off_peak_c_per_kwh"] = 99.0

        response = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": profile, "approve_for_calculation": True},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == (
        "ci_project_tariff_profile_reconciliation_failed"
    )


def test_tariff_profile_rejects_unknown_fields_and_overnight_windows(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _approved_evidence_inspection(),
    )
    database_url = sqlite_url_for_path(tmp_path / "invalid.sqlite3")
    nem12 = _nem12_bytes()
    with create_test_client(database_url) as client:
        _, project_url = _create_project(client)
        _save_evidence(client, project_url, bill_bytes=b"synthetic bill", nem12=nem12)
        suggestion = client.get(f"{project_url}/tariff-profile").json()[
            "suggested_profile"
        ]

        unknown_profile = deepcopy(suggestion)
        unknown_profile["import_metadata"] = {"trusted": True}
        unknown = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": unknown_profile, "approve_for_calculation": False},
        )

        overnight_profile = deepcopy(suggestion)
        overnight_profile["windows"]["network_energy"] = {
            "start": "23:00",
            "end": "07:00",
        }
        overnight = client.put(
            f"{project_url}/tariff-profile",
            json={"profile": overnight_profile, "approve_for_calculation": False},
        )

        unknown_envelope = client.put(
            f"{project_url}/tariff-profile",
            json={
                "profile": suggestion,
                "approve_for_calculation": False,
                "import_trust": "approved",
            },
        )

    assert unknown.status_code == 422
    assert unknown.json()["detail"]["code"] == "ci_project_tariff_profile_invalid"
    assert overnight.status_code == 422
    assert overnight.json()["detail"]["code"] == "ci_project_tariff_profile_invalid"
    assert unknown_envelope.status_code == 422
