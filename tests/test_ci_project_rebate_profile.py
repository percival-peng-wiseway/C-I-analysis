from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID

from solar_battery import ci_project_rebate_profile as rebate_profiles
from solar_battery.ci_device_profile import (
    device_profile_sha256,
    suggested_ci_device_profile,
)
from solar_battery.ci_project_rebate_profile import (
    approved_ci_project_rebate_calculation_profile,
)
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    local_actor,
    sqlite_url_for_path,
)


def _inspection(address: str) -> dict[str, object]:
    return {
        "contract_version": "ci_evidence_intake_v10",
        "intake_status": "ready_for_profile_review",
        "bill": {"site_address": address},
        "nem12": {},
    }


def _create_project(client) -> tuple[UUID, str]:
    response = client.post(
        "/api/commercial-industrial/projects",
        json={"display_name": "Rebate profile project"},
    )
    assert response.status_code == 201
    project_id = UUID(response.json()["project_id"])
    return project_id, f"/api/commercial-industrial/projects/{project_id}"


def _save_evidence(client, project_url: str, marker: bytes) -> None:
    response = client.post(
        f"{project_url}/evidence-intake/inspect",
        files={
            "bill": ("bill.pdf", marker, "application/pdf"),
            "nem12": ("nem12.csv", marker, "text/csv"),
        },
    )
    assert response.status_code == 200, response.json()


def _complete_solar(profile: dict[str, object]) -> dict[str, object]:
    result = deepcopy(profile)
    result["site_location_confirmed"] = True
    result["site_location_source_label"] = "Analyst-reviewed supply address"
    solar = result["programs"]["solar_stc"]
    solar.update(
        {
            "enabled": True,
            "eligibility_confirmed": True,
            "eligibility_source_label": "CER eligibility evidence reviewed",
            "price_source_label": "Broker quote reviewed by analyst",
            "postcode_zone_rating": 1.382,
            "zone_source_label": "CER postcode zone table",
        }
    )
    return result


def _stable_binding() -> dict[str, str]:
    return {
        "design_candidates_sha256": "a" * 64,
        "design_context_sha256": "b" * 64,
        "device_profile_sha256": "c" * 64,
    }


def _install_binding(monkeypatch, binding: dict[str, str]) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile._current_rebate_binding",
        lambda *_args, **_kwargs: dict(binding),
    )


def test_current_binding_requires_design_context_from_current_device(
    monkeypatch,
) -> None:
    device_profile = suggested_ci_device_profile()
    current_device_sha256 = device_profile_sha256(device_profile)
    context = {
        "contract_version": "ci_design_context_v2",
        "profile_selection": {"device_profile_sha256": "f" * 64},
    }
    project = SimpleNamespace(
        design_candidates_json=[{"scenario_id": "scenario-1"}],
        design_context_json=context,
    )
    monkeypatch.setattr(
        rebate_profiles,
        "ci_device_profile_state",
        lambda *_args, **_kwargs: {
            "status": "ready",
            "profile": device_profile,
        },
    )

    mismatched = rebate_profiles._current_rebate_binding(
        None, project=project, actor=local_actor()
    )
    assert mismatched["design_candidates_sha256"] is not None
    assert mismatched["design_context_sha256"] is None
    assert mismatched["device_profile_sha256"] == current_device_sha256

    context["profile_selection"][
        "device_profile_sha256"
    ] = current_device_sha256
    matched = rebate_profiles._current_rebate_binding(
        None, project=project, actor=local_actor()
    )
    assert matched["design_context_sha256"] is not None


def test_all_disabled_profile_can_be_approved_without_evidence_or_binding(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "all-disabled.sqlite3")
    with create_test_client(database_url, object_store_root=tmp_path / "objects") as client:
        project_id, project_url = _create_project(client)
        initial = client.get(f"{project_url}/rebate-profile")
        assert initial.status_code == 200
        assert initial.headers["cache-control"] == "no-store"
        state = initial.json()
        assert state["status"] == "not_configured"
        assert state["suggested_profile"]["site_state_code"] == ""
        assert state["suggested_profile"]["programs"]["solar_stc"]["enabled"] is False
        assert state["suggested_profile"]["programs"]["solar_stc"]["price_source_label"] == ""

        saved = client.put(
            f"{project_url}/rebate-profile",
            json={
                "profile": state["suggested_profile"],
                "approve_for_calculation": True,
            },
        )
        assert saved.status_code == 200, saved.json()
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json()["status"] == "approved"
        assert saved.json()["blockers"] == []

    # A disabled/$0 approval remains usable if a design and Device profile are
    # added later; binding changes only invalidate enabled rebate programs.
    _install_binding(monkeypatch, _stable_binding())
    session_factory = create_sqlite_session_factory(database_url)
    with session_factory() as session:
        profile = approved_ci_project_rebate_calculation_profile(
            session,
            project_id=project_id,
            actor=local_actor(),
        )
    assert profile is not None
    assert all(item["enabled"] is False for item in profile["programs"].values())


def test_enabled_profile_requires_current_site_and_analyst_sources(
    tmp_path, monkeypatch
) -> None:
    _install_binding(monkeypatch, _stable_binding())
    database_url = sqlite_url_for_path(tmp_path / "missing-evidence.sqlite3")
    with create_test_client(database_url, object_store_root=tmp_path / "objects") as client:
        _, project_url = _create_project(client)
        profile = _complete_solar(
            client.get(f"{project_url}/rebate-profile").json()["suggested_profile"]
        )
        profile["site_state_code"] = "VIC"
        profile["site_postcode"] = "3000"

        response = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": profile, "approve_for_calculation": True},
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "rebate_site_evidence_required"

        profile["programs"]["solar_stc"]["price_source_label"] = ""
        draft = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": profile, "approve_for_calculation": False},
        )
        assert draft.status_code == 200
        assert draft.json()["status"] == "draft"
        assert "solar_stc_price_source_required" in {
            item["code"] for item in draft.json()["blockers"]
        }


def test_approved_profile_is_evidence_design_and_device_bound(
    tmp_path, monkeypatch
) -> None:
    address = {"value": "10 Collins Street Melbourne VIC, 3000"}
    binding = _stable_binding()
    _install_binding(monkeypatch, binding)
    monkeypatch.setattr(
        "api.ci_routes.inspect_ci_evidence_pair",
        lambda *_args, **_kwargs: _inspection(address["value"]),
    )
    database_url = sqlite_url_for_path(tmp_path / "approved.sqlite3")
    with create_test_client(database_url, object_store_root=tmp_path / "objects") as client:
        project_id, project_url = _create_project(client)
        _save_evidence(client, project_url, b"evidence-a")
        state = client.get(f"{project_url}/rebate-profile").json()
        assert state["site_evidence"] == {
            "detected_site_address": "10 Collins Street Melbourne VIC, 3000",
            "state_code": "VIC",
            "postcode": "3000",
        }
        profile = _complete_solar(state["suggested_profile"])

        draft = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": profile, "approve_for_calculation": False},
        )
        assert draft.status_code == 200
        assert draft.json()["status"] == "draft"
        assert [item["code"] for item in draft.json()["blockers"]] == [
            "rebate_profile_approval_required"
        ]

        approved = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": profile, "approve_for_calculation": True},
        )
        assert approved.status_code == 200, approved.json()
        assert approved.json()["status"] == "approved"
        assert len(approved.json()["profile_sha256"]) == 64

        binding["device_profile_sha256"] = "d" * 64
        binding_stale = client.get(f"{project_url}/rebate-profile").json()
        assert binding_stale["status"] == "stale"
        assert binding_stale["blockers"][0]["code"] == "rebate_profile_stale"

        binding["device_profile_sha256"] = "c" * 64
        restored = client.get(f"{project_url}/rebate-profile").json()
        assert restored["status"] == "approved"

        # Replacing the bill/NEM12 at the same address must still invalidate
        # the approval because NMI/site evidence may have changed.
        _save_evidence(client, project_url, b"evidence-a-replacement")
        evidence_stale = client.get(f"{project_url}/rebate-profile").json()
        assert evidence_stale["status"] == "stale"
        assert evidence_stale["blockers"][0]["code"] == "rebate_profile_stale"
        reapproved = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": profile, "approve_for_calculation": True},
        )
        assert reapproved.status_code == 200, reapproved.json()
        assert reapproved.json()["status"] == "approved"

        unknown = deepcopy(profile)
        unknown["programs"]["solar_stc"]["screenshot_rule"] = True
        rejected = client.put(
            f"{project_url}/rebate-profile",
            json={"profile": unknown, "approve_for_calculation": False},
        )
        assert rejected.status_code == 422
        assert rejected.json()["detail"]["code"] == "ci_project_rebate_profile_invalid"

        address["value"] = "20 Bourke Street Melbourne VIC, 3000"
        _save_evidence(client, project_url, b"evidence-b")
        stale = client.get(f"{project_url}/rebate-profile").json()
        assert stale["status"] == "stale"
        assert stale["blockers"][0]["code"] == "rebate_profile_stale"

    session_factory = create_sqlite_session_factory(database_url)
    with session_factory() as session:
        assert (
            approved_ci_project_rebate_calculation_profile(
                session,
                project_id=project_id,
                actor=local_actor(),
            )
            is None
        )
