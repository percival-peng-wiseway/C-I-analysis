from __future__ import annotations

from solar_battery.ci_workspace_readiness import ci_workspace_readiness_contract
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


EXPECTED_WORKSPACE_IDS = [
    "data_qc", "tariff_mapping", "peak_shaving", "kw_kva_pf_evidence",
    "scenario_ranking", "report_preview",
]


def test_ci_workspace_readiness_contract_fails_closed_without_local_evidence(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("CI_TARIFF_PROFILE_PATH", str(tmp_path / "missing.json"))
    contract = ci_workspace_readiness_contract()
    assert contract["contract_version"] == "ci_workspace_readiness_v3"
    assert contract["product_id"] == "commercial_and_industrial"
    assert contract["availability"] == "unavailable"
    assert contract["active_profile_id"] is None
    assert contract["blockers"][0]["code"] == "ci_evidence_gate_issue_5"
    areas = contract["workspace_areas"]
    assert [area["workspace_id"] for area in areas] == EXPECTED_WORKSPACE_IDS
    assert {area["availability"] for area in areas} == {"unavailable"}


def test_ci_workspace_readiness_api_serializes_python_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CI_TARIFF_PROFILE_PATH", str(tmp_path / "missing.json"))
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-readiness.sqlite3")) as client:
        response = client.get("/api/commercial-industrial/workspace-readiness")
    assert response.status_code == 200
    assert response.json() == ci_workspace_readiness_contract()
