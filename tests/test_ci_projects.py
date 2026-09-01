from __future__ import annotations

from dataclasses import replace
from uuid import UUID

from solar_battery.ci_project_evidence import (
    CiEvidenceSource,
    ci_project_evidence_state,
    record_ci_project_evidence,
    store_ci_project_evidence_files,
    update_ci_project_evidence_inspection_if_current,
)
from solar_battery.durable_cockpit.filesystem_object_store import (
    FilesystemObjectStore,
)

from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    durable_settings,
    local_actor,
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
        "grid_emissions_factor_kg_co2e_per_kwh": 0.79,
    }


def _design_context() -> dict[str, object]:
    return {
        "contract_version": "ci_design_context_v1",
        "existing_solar": {
            "installed": True,
            "brand": "Trina",
            "model": "Vertex S+",
            "panel_count": 100,
            "panel_rating_w": 500,
            "installed_capacity_kwp_dc": 50,
            "inverter_brand": "Sungrow",
            "inverter_model": "SG50CX",
            "inverter_capacity_kw_ac": 50,
            "installation_year": 2022,
            "operating_status": "operational",
            "included_in_interval_baseline": True,
        },
        "existing_battery": {
            "installed": False,
            "brand": "",
            "model": "",
            "nominal_capacity_kwh": 0,
            "usable_capacity_kwh": 0,
            "power_kw": 0,
            "installation_year": None,
            "operating_status": "unknown",
            "included_in_interval_baseline": False,
        },
        "technical_options": {
            "annual_specific_yield_kwh_per_kw": 1500,
            "shading_loss_percent": 3,
            "soiling_loss_percent": 2,
            "temperature_loss_percent": 5,
            "wiring_mismatch_loss_percent": 2,
            "other_system_loss_percent": 0,
            "system_availability_percent": 99,
            "target_dc_ac_ratio": 1.15,
            "inverter_block_size_kw": 5,
            "site_ac_headroom_kw": 250,
            "battery_duration_hours": 2,
            "charge_efficiency_percent": 95,
            "discharge_efficiency_percent": 95,
            "minimum_soc_percent": 10,
            "maximum_soc_percent": 100,
            "allow_grid_charging": False,
            "reactive_support_enabled": False,
            "reactive_support_max_kvar": 0,
            "grid_emissions_factor_kg_co2e_per_kwh": 0.79,
        },
    }


def _saved_evidence_inspection(
    marker: str, *, contract_version: str = "ci_evidence_intake_v9"
) -> dict[str, object]:
    return {
        "contract_version": contract_version,
        "intake_status": "ready_for_profile_review",
        "marker": marker,
        "bill": {
            "site_address": "1 Test Street Melbourne VIC 3000",
            "network_tariff_code": "LLVT2",
        },
        "nem12": {"full_tariff_analysis_ready": True},
        "privacy": {
            "files_persisted": True,
            "customer_identifiers_returned": True,
            "customer_facing_permission": False,
        },
    }


def test_lazy_evidence_upgrade_updates_when_saved_at_token_is_current(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "lazy-upgrade-current.sqlite3")
    object_store_root = tmp_path / "lazy-upgrade-current-objects"
    session_factory = create_sqlite_session_factory(database_url)
    actor = local_actor()
    source_inspection = _saved_evidence_inspection("source-v9")
    upgraded_inspection = _saved_evidence_inspection(
        "upgraded-v10", contract_version="ci_evidence_intake_v10"
    )
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _interval, **_kwargs: source_inspection,
    )
    monkeypatch.setattr(
        "api.ci_routes.enrich_ci_evidence_tariff_summary",
        lambda inspection, interval: (
            upgraded_inspection
            if inspection["marker"] == "source-v9" and interval == b"source-interval"
            else inspection
        ),
    )
    captured_tokens: list[str] = []

    def compare_and_swap_spy(*args, expected_saved_at: str, **kwargs) -> bool:
        captured_tokens.append(expected_saved_at)
        return update_ci_project_evidence_inspection_if_current(
            *args, expected_saved_at=expected_saved_at, **kwargs
        )

    monkeypatch.setattr(
        "api.ci_routes.update_ci_project_evidence_inspection_if_current",
        compare_and_swap_spy,
    )

    with create_test_client(
        database_url, object_store_root=object_store_root
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Current lazy upgrade"},
        ).json()
        project_id = UUID(project["project_id"])
        project_url = f"/api/commercial-industrial/projects/{project_id}"
        saved = client.post(
            f"{project_url}/evidence-intake/inspect",
            files={
                "bill": ("source.pdf", b"source-bill", "application/pdf"),
                "nem12": ("source.csv", b"source-interval", "text/csv"),
            },
        )
        assert saved.status_code == 200
        with session_factory() as session:
            before = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
        current_saved_at = before["evidence"]["saved_at"]

        upgraded = client.get(f"{project_url}/evidence-intake")

        assert upgraded.status_code == 200
        assert upgraded.json()["evidence"]["inspection"] == upgraded_inspection
        assert captured_tokens == [current_saved_at]
        with session_factory() as session:
            persisted = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
        assert persisted["evidence"]["inspection"] == upgraded_inspection
        assert persisted["evidence"]["saved_at"] != current_saved_at


def test_lazy_evidence_upgrade_stale_token_cannot_overwrite_newer_evidence(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "lazy-upgrade-stale.sqlite3")
    object_store_root = tmp_path / "lazy-upgrade-stale-objects"
    session_factory = create_sqlite_session_factory(database_url)
    object_store = FilesystemObjectStore(object_store_root)
    actor = local_actor()
    source_inspection = _saved_evidence_inspection("source-v9")
    stale_upgrade = _saved_evidence_inspection(
        "stale-upgrade", contract_version="ci_evidence_intake_v10"
    )
    newer_inspection = _saved_evidence_inspection(
        "newer-evidence", contract_version="ci_evidence_intake_v10"
    )
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _interval, **_kwargs: source_inspection,
    )

    with create_test_client(
        database_url, object_store_root=object_store_root
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Stale lazy upgrade"},
        ).json()
        project_id = UUID(project["project_id"])
        project_url = f"/api/commercial-industrial/projects/{project_id}"
        saved = client.post(
            f"{project_url}/evidence-intake/inspect",
            files={
                "bill": ("source.pdf", b"source-bill", "application/pdf"),
                "nem12": ("source.csv", b"source-interval", "text/csv"),
            },
        )
        assert saved.status_code == 200
        with session_factory() as session:
            before = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
        stale_saved_at = before["evidence"]["saved_at"]

        def replace_evidence_during_upgrade(
            inspection: dict[str, object], interval: bytes
        ) -> dict[str, object]:
            assert inspection["marker"] == "source-v9"
            assert interval == b"source-interval"
            bill_source = CiEvidenceSource(
                "newer.pdf", "application/pdf", b"newer-bill"
            )
            interval_source = CiEvidenceSource(
                "newer.csv", "text/csv", b"newer-interval"
            )
            bill_object, interval_object = store_ci_project_evidence_files(
                object_store,
                project_id=project_id,
                bill=bill_source,
                interval=interval_source,
            )
            with session_factory() as session:
                with session.begin():
                    old_keys = record_ci_project_evidence(
                        session,
                        project_id=project_id,
                        actor=actor,
                        bill=bill_source,
                        interval=interval_source,
                        bill_object=bill_object,
                        interval_object=interval_object,
                        inspection_result=newer_inspection,
                    )
            for old_key in old_keys:
                object_store.delete(old_key)
            return stale_upgrade

        monkeypatch.setattr(
            "api.ci_routes.enrich_ci_evidence_tariff_summary",
            replace_evidence_during_upgrade,
        )

        restored = client.get(f"{project_url}/evidence-intake")

        assert restored.status_code == 200
        state = restored.json()
        assert state["evidence"]["inspection"] == newer_inspection
        assert state["evidence"]["files"]["bill"]["filename"] == "newer.pdf"
        assert state["evidence"]["files"]["interval"]["filename"] == "newer.csv"
        assert state["evidence"]["saved_at"] != stale_saved_at
        with session_factory() as session:
            persisted = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
        assert persisted["evidence"]["inspection"] == newer_inspection
        assert persisted["evidence"]["files"] == state["evidence"]["files"]


def test_ci_projects_are_persistent_and_design_validation_is_project_scoped(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda _bill, _nem12, **kwargs: {
            "contract_version": "ci_evidence_intake_v7",
            "intake_status": "ready_for_profile_review",
            "bill": {
                "review_status": "analyst_confirmed",
                "network_tariff_code": "TEST-TARIFF",
            },
            "nem12": {"full_tariff_analysis_ready": True},
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
            "contract_version": "ci_design_feasibility_v4",
            "status": "ready",
            "analysis_mode": "pre_tariff_physical_feasibility",
            "customer_facing_permission": False,
            "recommendation_permitted": False,
            "tariff_evaluated": False,
            "currency_values_permitted": False,
            "physical_review_order": {
                "algorithm_id": "ci_pre_tariff_physical_review_order_v2",
                "shortlist_count": 1,
                "basis": "Physical review only.",
                "recommendation_permitted": False,
            },
            "scenarios": [
                {
                    "physical_review_rank": 1,
                    "recommendation_permitted": False,
                }
            ],
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
    captured_tariff: dict[str, object] = {}

    def tariff_replay(interval_bytes, *, profile, scenarios):
        captured_tariff.update(
            interval_bytes=interval_bytes,
            profile=profile,
            scenarios=scenarios,
        )
        return {
            "contract_version": "ci_physical_scenario_review_v6",
            "analysis_status": "ready",
            "analysis_mode": "evidence_limited_internal_review",
            "customer_facing_permission": False,
            "recommendation_permitted": False,
            "currency_values_permitted": True,
            "scenarios": [
                {
                    "scenario_id": scenarios[0]["scenario_id"],
                    "annual_tariff_value": {
                        "customer_facing_permission": False,
                    },
                }
            ],
            "report_preview": {"download_available": False},
        }

    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {"profile_id": "test"})
    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_physical_scenarios", tariff_replay
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
            json={"scenarios": [_scenario()], "design_context": _design_context()},
        )
        assert validated.status_code == 200
        result = validated.json()
        assert result["contract_version"] == "ci_design_candidate_validation_v1"
        assert result["candidate_count"] == 1
        assert result["dispatch_evaluated"] is False
        assert result["tariff_evaluated"] is False
        assert result["recommendation_permitted"] is False
        assert result["design_context"]["existing_solar"] == {
            **_design_context()["existing_solar"],
            "panel_rating_w": 500.0,
            "installed_capacity_kwp_dc": 50.0,
            "inverter_capacity_kw_ac": 50.0,
        }
        assert result["design_context"]["technical_options"][
            "effective_derating_percent"
        ] == 87.6158514

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
        assert feasibility_result.json()["contract_version"] == "ci_design_feasibility_v4"
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

        tariff_result = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/tariff-replay"
        )
        assert tariff_result.status_code == 200
        assert tariff_result.json()["contract_version"] == "ci_physical_scenario_review_v6"
        assert captured_tariff == {
            "interval_bytes": b"synthetic",
            "profile": {"profile_id": "test"},
            "scenarios": [_scenario()],
        }
        restored_tariff = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/tariff-replay"
        )
        assert restored_tariff.status_code == 200
        assert restored_tariff.json()["contract_version"] == (
            "ci_project_tariff_replay_state_v1"
        )
        assert restored_tariff.json()["status"] == "ready"
        assert restored_tariff.json()["result"] == tariff_result.json()

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
        stale_tariff = client.get(
            f"/api/commercial-industrial/projects/{project['project_id']}/tariff-replay"
        ).json()
        assert stale_tariff["status"] == "stale"
        assert stale_tariff["result"] is None
        assert stale_tariff["stale_reasons"] == ["interval_evidence_changed"]

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


def test_ci_project_site_photos_persist_reload_and_delete(tmp_path) -> None:
    object_store_root = tmp_path / "site-material-objects"
    with create_test_client(
        sqlite_url_for_path(tmp_path / "site-material.sqlite3"),
        object_store_root=object_store_root,
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Roof photo project"},
        ).json()
        project_url = f"/api/commercial-industrial/projects/{project['project_id']}"

        empty = client.get(f"{project_url}/site-material")
        assert empty.status_code == 200
        assert empty.json() == {
            "contract_version": "ci_project_site_material_v1",
            "photos": [],
        }

        jpeg = b"\xff\xd8\xff\xe0" + b"private-roof-photo"
        uploaded = client.post(
            f"{project_url}/site-material",
            files={"photo": ("north-roof.jpg", jpeg, "image/jpeg")},
        )
        assert uploaded.status_code == 201
        saved = uploaded.json()["photo"]
        assert saved["filename"] == "north-roof.jpg"
        assert saved["content_type"] == "image/jpeg"
        assert saved["size_bytes"] == len(jpeg)
        assert saved["content_url"].endswith(
            f"/site-material/{saved['photo_id']}/content"
        )
        assert "object_store" not in str(uploaded.json())

        restored = client.get(f"{project_url}/site-material")
        assert restored.status_code == 200
        assert restored.json()["photos"] == [saved]

        content = client.get(saved["content_url"])
        assert content.status_code == 200
        assert content.headers["content-type"] == "image/jpeg"
        assert content.headers["cache-control"] == "private, max-age=300"
        assert content.content == jpeg

        removed = client.delete(
            f"{project_url}/site-material/{saved['photo_id']}"
        )
        assert removed.status_code == 204
        assert client.get(f"{project_url}/site-material").json()["photos"] == []
        assert client.get(saved["content_url"]).status_code == 404

    assert [path for path in object_store_root.rglob("*") if path.is_file()] == []


def test_ci_project_site_photos_reject_disguised_or_unsupported_files(tmp_path) -> None:
    with create_test_client(
        sqlite_url_for_path(tmp_path / "invalid-site-material.sqlite3"),
        object_store_root=tmp_path / "invalid-site-material-objects",
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Invalid roof photo project"},
        ).json()
        endpoint = (
            f"/api/commercial-industrial/projects/{project['project_id']}"
            "/site-material"
        )

        disguised = client.post(
            endpoint,
            files={"photo": ("not-really.jpg", b"plain text", "image/jpeg")},
        )
        assert disguised.status_code == 422
        assert (
            disguised.json()["detail"]["code"]
            == "ci_project_site_material_content_invalid"
        )

        unsupported = client.post(
            endpoint,
            files={"photo": ("roof.svg", b"<svg/>", "image/svg+xml")},
        )
        assert unsupported.status_code == 422
        assert (
            unsupported.json()["detail"]["code"]
            == "ci_project_site_material_type_invalid"
        )
