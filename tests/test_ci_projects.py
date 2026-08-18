from __future__ import annotations

from dataclasses import replace

from tests.durable_test_helpers import (
    create_test_client,
    durable_settings,
    sqlite_url_for_path,
)


def _scenario() -> dict[str, object]:
    return {
        "scenario_id": "pv-001__battery-001",
        "label": "100 kWp + 200 kWh",
        "battery_system_id": "battery-001",
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_system_id": "pv-001",
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": 100.0,
        "pv_inverter_capacity_kw_ac": 80.0,
        "shared_ac_headroom_kw": 250.0,
        "reactive_support_enabled": False,
        "reactive_support_max_kvar": 0.0,
        "shared_inverter_apparent_power_limit_kva": None,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": 1500.0,
        "pv_derating_factor": 0.88,
        "nominal_capacity_kwh": 200.0,
        "max_charge_kw": 100.0,
        "max_discharge_kw": 100.0,
        "charge_efficiency": 0.9486832981,
        "discharge_efficiency": 0.9486832981,
        "min_soc_fraction": 0.1,
        "max_soc_fraction": 1.0,
        "initial_soc_fraction": 1.0,
        "allow_grid_charging": False,
    }


def test_ci_projects_are_persistent_and_design_validation_is_project_scoped(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _nem12, **kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": "ready_for_profile_review",
            "privacy": {
                "files_persisted": kwargs.get("files_persisted", False),
                "customer_identifiers_returned": False,
                "customer_facing_permission": False,
            },
        },
    )
    captured_feasibility: dict[str, object] = {}

    def feasibility(interval_bytes, *, scenarios):
        captured_feasibility["interval_bytes"] = interval_bytes
        captured_feasibility["scenarios"] = scenarios
        return {
            "contract_version": "ci_design_feasibility_v2",
            "status": "ready",
            "analysis_mode": "pre_tariff_physical_feasibility",
            "customer_facing_permission": False,
            "recommendation_permitted": False,
            "tariff_evaluated": False,
            "currency_values_permitted": False,
        }

    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_design_feasibility", feasibility
    )
    captured_activity: dict[str, object] = {}

    def interval_activity(
        interval_bytes, *, scenarios, scenario_id, start_date, days
    ):
        captured_activity.update(
            interval_bytes=interval_bytes,
            scenarios=scenarios,
            scenario_id=scenario_id,
            start_date=start_date.isoformat(),
            days=days,
        )
        return {
            "contract_version": "ci_interval_activity_v1",
            "status": "ready",
            "customer_facing_permission": False,
        }

    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_interval_activity", interval_activity
    )
    object_store_root = tmp_path / "objects"
    with create_test_client(
        sqlite_url_for_path(tmp_path / "ci-projects.sqlite3"),
        object_store_root=object_store_root,
    ) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Factory Alpha"},
        )
        assert created.status_code == 201
        project = created.json()
        assert project["contract_version"] == "ci_project_v1"
        assert project["setup_status"] == "input_required"

        listed = client.get("/api/commercial-industrial/projects")
        assert listed.status_code == 200
        assert [item["display_name"] for item in listed.json()["projects"]] == [
            "Factory Alpha"
        ]

        blocked = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates",
            json={"scenarios": [_scenario()]},
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"]["code"] == "ci_project_setup_required"

        unsaved = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates"
        )
        assert unsaved.status_code == 200
        assert unsaved.json() == {
            "contract_version": "ci_saved_design_state_v1",
            "status": "not_saved",
            "design": None,
        }

        inspected = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("bill.pdf", b"synthetic", "application/pdf"),
                "nem12": ("nem12.csv", b"synthetic", "text/csv"),
            },
        )
        assert inspected.status_code == 200
        assert inspected.json()["privacy"]["files_persisted"] is True

        restored_evidence = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake"
        )
        assert restored_evidence.status_code == 200
        evidence_state = restored_evidence.json()
        assert evidence_state["contract_version"] == "ci_project_evidence_state_v1"
        assert evidence_state["status"] == "saved"
        assert evidence_state["evidence"]["files"] == {
            "bill": {
                "filename": "bill.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(b"synthetic"),
            },
            "interval": {
                "filename": "nem12.csv",
                "content_type": "text/csv",
                "size_bytes": len(b"synthetic"),
            },
        }
        assert evidence_state["evidence"]["inspection"] == inspected.json()
        assert "object_store" not in str(evidence_state)

        validated = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates",
            json={"scenarios": [_scenario()]},
        )
        assert validated.status_code == 200
        result = validated.json()
        assert result["contract_version"] == "ci_design_candidate_validation_v1"
        assert result["candidate_count"] == 1
        assert result["dispatch_evaluated"] is False
        assert result["tariff_evaluated"] is False
        assert result["recommendation_permitted"] is False

        reopened = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates"
        )
        assert reopened.status_code == 200
        saved = reopened.json()
        assert saved["contract_version"] == "ci_saved_design_state_v1"
        assert saved["status"] == "ready"
        assert saved["design"] == result

        feasibility_result = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        )
        assert feasibility_result.status_code == 200
        assert feasibility_result.json()["contract_version"] == "ci_design_feasibility_v2"
        assert captured_feasibility == {
            "interval_bytes": b"synthetic",
            "scenarios": [_scenario()],
        }
        restored_feasibility = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        )
        assert restored_feasibility.status_code == 200
        saved_feasibility = restored_feasibility.json()
        assert saved_feasibility["contract_version"] == "ci_project_feasibility_state_v1"
        assert saved_feasibility["status"] == "ready"
        assert saved_feasibility["stale_reasons"] == []
        assert saved_feasibility["result"] == feasibility_result.json()

        activity_result = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility/interval-activity",
            json={
                "scenario_id": _scenario()["scenario_id"],
                "start_date": "2026-01-02",
                "days": 3,
            },
        )
        assert activity_result.status_code == 200
        assert activity_result.json()["contract_version"] == "ci_interval_activity_v1"
        assert captured_activity == {
            "interval_bytes": b"synthetic",
            "scenarios": [_scenario()],
            "scenario_id": _scenario()["scenario_id"],
            "start_date": "2026-01-02",
            "days": 3,
        }

        replaced_evidence = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("bill-v2.pdf", b"synthetic-v2", "application/pdf"),
                "nem12": ("nem12-v2.csv", b"synthetic-interval-v2", "text/csv"),
            },
        )
        assert replaced_evidence.status_code == 200
        stale_after_evidence = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        ).json()
        assert stale_after_evidence["status"] == "stale"
        assert stale_after_evidence["result"] is None
        assert stale_after_evidence["stale_reasons"] == [
            "interval_evidence_changed"
        ]

        rerun = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        )
        assert rerun.status_code == 200
        changed_scenario = {**_scenario(), "label": "Revised design"}
        revised_design = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-candidates",
            json={"scenarios": [changed_scenario]},
        )
        assert revised_design.status_code == 200
        stale_after_design = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        ).json()
        assert stale_after_design["status"] == "stale"
        assert stale_after_design["result"] is None
        assert stale_after_design["stale_reasons"] == ["design_changed"]

        refreshed = client.get("/api/commercial-industrial/projects").json()["projects"][0]
        assert refreshed["setup_status"] == "ready"
        assert refreshed["current_stage"] == "system_design"
        assert refreshed["design_candidate_count"] == 1

    stored_files = [path for path in object_store_root.rglob("*") if path.is_file()]
    assert len(stored_files) == 2
    assert sorted(path.read_bytes() for path in stored_files) == [
        b"synthetic-interval-v2",
        b"synthetic-v2",
    ]


def test_ci_projects_are_isolated_by_local_identity(tmp_path) -> None:
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-project-scope.sqlite3")) as client:
        response = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "  "},
        )
        assert response.status_code == 422


def test_replacing_project_evidence_replaces_private_objects_and_resets_setup(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda bill, _interval, **kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": (
                "ready_for_profile_review" if bill == b"ready" else "action_required"
            ),
            "privacy": {
                "files_persisted": kwargs.get("files_persisted", False),
                "customer_identifiers_returned": False,
                "customer_facing_permission": False,
            },
        },
    )
    object_store_root = tmp_path / "replacement-objects"
    with create_test_client(
        sqlite_url_for_path(tmp_path / "replacement.sqlite3"),
        object_store_root=object_store_root,
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Replace evidence"},
        ).json()
        project_url = (
            f"/api/commercial-industrial/projects/{project['project_id']}"
        )
        not_saved = client.get(f"{project_url}/evidence-intake")
        assert not_saved.json() == {
            "contract_version": "ci_project_evidence_state_v1",
            "status": "not_saved",
            "evidence": None,
        }

        ready = client.post(
            f"{project_url}/evidence-intake/inspect",
            files={
                "bill": ("first.pdf", b"ready", "application/pdf"),
                "nem12": ("first.csv", b"first-interval", "text/csv"),
            },
        )
        assert ready.status_code == 200
        assert client.get("/api/commercial-industrial/projects").json()["projects"][0][
            "setup_status"
        ] == "ready"

        replaced = client.post(
            f"{project_url}/evidence-intake/inspect",
            files={
                "bill": ("second.pdf", b"needs-review", "application/pdf"),
                "nem12": ("second.csv", b"second-interval", "text/csv"),
            },
        )
        assert replaced.status_code == 200
        state = client.get(f"{project_url}/evidence-intake").json()
        assert state["evidence"]["files"]["bill"]["filename"] == "second.pdf"
        refreshed = client.get("/api/commercial-industrial/projects").json()["projects"][0]
        assert refreshed["setup_status"] == "input_required"
        assert refreshed["current_stage"] == "setup"

    stored_files = [path for path in object_store_root.rglob("*") if path.is_file()]
    assert sorted(path.read_bytes() for path in stored_files) == [
        b"needs-review",
        b"second-interval",
    ]


def test_saved_project_evidence_is_owner_scoped(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _interval, **kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": "ready_for_profile_review",
            "privacy": {
                "files_persisted": kwargs.get("files_persisted", False),
                "customer_identifiers_returned": False,
                "customer_facing_permission": False,
            },
        },
    )
    database_url = sqlite_url_for_path(tmp_path / "owner-scope.sqlite3")
    object_store_root = tmp_path / "owner-scope-objects"
    owner_a = durable_settings(
        database_url, object_store_root=str(object_store_root)
    )
    with create_test_client(
        database_url,
        object_store_root=object_store_root,
        settings_override=owner_a,
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects", json={"display_name": "Owner A"}
        ).json()
        response = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("private.pdf", b"private-bill", "application/pdf"),
                "nem12": ("private.csv", b"private-interval", "text/csv"),
            },
        )
        assert response.status_code == 200

    owner_b = replace(
        owner_a,
        local_owner_id="other-owner",
        local_actor_id="other-owner",
        api_bearer_token="other-test-credential",
    )
    with create_test_client(
        database_url,
        object_store_root=object_store_root,
        settings_override=owner_b,
    ) as client:
        response = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake"
        )
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "ci_project_not_found"
        feasibility = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/design-feasibility"
        )
        assert feasibility.status_code == 404
        assert feasibility.json()["detail"]["code"] == "ci_project_not_found"
