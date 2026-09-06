import json

import pytest

from solar_battery import ci_solar_resource as solar


def providers(monkeypatch, *, matches=None, annual=1440):
    calls = []
    monkeypatch.setenv("GEOAPIFY_API_KEY", "secret-test-key")
    def get(url, params):
        calls.append((url, params))
        if url == solar.GEOAPIFY_URL:
            return {"results": matches if matches is not None else [{
                "lat": -37.8, "lon": 144.9, "formatted": "Example, Australia",
                "country_code": "au", "result_type": "building", "rank": {"confidence": 1},
            }]}
        return {"outputs": {"totals": {"fixed": {"E_y": annual}}, "monthly": {"fixed": [
            {"month": month, "E_m": 120} for month in range(1, 13)
        ]}}}
    monkeypatch.setattr(solar, "_get_json", get)
    return calls


def test_missing_key_or_address_does_not_call_provider(monkeypatch):
    monkeypatch.delenv("GEOAPIFY_API_KEY", raising=False)
    monkeypatch.setattr(solar, "_get_json", lambda *args: pytest.fail("unexpected network"))
    assert solar.lookup_solar_resource(None)["status"] == "fallback"
    result = solar.lookup_solar_resource("Example")
    assert result["status"] == "missing_key"
    assert result["annual_specific_yield_kwh_per_kw"] == 1000


@pytest.mark.parametrize("azimuth,aspect", [(0, -180), (90, -90), (180, 0), (270, 90), (360, -180)])
def test_one_kwp_yield_orientation_and_no_double_temperature(monkeypatch, azimuth, aspect):
    calls = providers(monkeypatch)
    result = solar.lookup_solar_resource("Example", tilt=25, azimuth=azimuth)
    assert result["status"] == "ready"
    assert result["annual_specific_yield_kwh_per_kw"] == 1440
    assert calls[1][1]["peakpower"] == 1
    assert calls[1][1]["loss"] == 0
    assert calls[1][1]["aspect"] == aspect
    assert calls[1][1]["raddatabase"] == "PVGIS-ERA5"
    assert sum(result["monthly_kwh_per_kwp"]) == 1440
    assert "secret-test-key" not in json.dumps(result)
    assert result["customer_facing_permission"] is False


def test_cache_reuses_only_current_address_and_orientation(monkeypatch):
    calls = providers(monkeypatch)
    previous = solar.lookup_solar_resource("Example")
    assert solar.lookup_solar_resource("Example", previous=previous) == previous
    assert len(calls) == 2
    solar.lookup_solar_resource("Example", previous=previous, tilt=30)
    assert len(calls) == 3  # PVGIS only; same verified address.
    solar.lookup_solar_resource("Different", previous=previous)
    assert len(calls) == 5


@pytest.mark.parametrize("matches", [[], [{"country_code": "au", "result_type": "city"}], [
    {"country_code": "au", "result_type": "building", "rank": {"confidence": .5}},
]])
def test_no_city_centroid_or_low_confidence_site(monkeypatch, matches):
    calls = providers(monkeypatch, matches=matches)
    assert solar.lookup_solar_resource("Example")["status"] == "location_review"
    assert len(calls) == 1


def test_provider_failure_is_redacted_and_falls_back(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", "secret-test-key")
    def fail(*args):
        raise OSError("https://provider/?apiKey=secret-test-key")
    monkeypatch.setattr(solar, "_get_json", fail)
    result = solar.lookup_solar_resource("Example")
    assert result["status"] == "service_unavailable"
    assert "secret-test-key" not in json.dumps(result)
    assert result["annual_specific_yield_kwh_per_kw"] == 1000


@pytest.mark.parametrize("annual", [float("nan"), 100, 2500])
def test_invalid_or_inconsistent_pvgis_is_not_applied(monkeypatch, annual):
    providers(monkeypatch, annual=annual)
    assert solar.lookup_solar_resource("Example")["status"] == "service_unavailable"


def test_import_enrichment_and_refresh_preserve_bill_and_intervals(tmp_path, monkeypatch):
    from tests.durable_test_helpers import create_test_client, sqlite_url_for_path
    from tests.test_ci_evidence_intake import BILL_TEXT, _nem12_bytes
    from solar_battery import ci_evidence_intake

    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)
    lookups = []
    def lookup(address, **kwargs):
        lookups.append((address, kwargs))
        return {"status": "missing_key", "annual_specific_yield_kwh_per_kw": 1000}
    monkeypatch.setattr("api.ci_routes.lookup_solar_resource", lookup)
    with create_test_client(sqlite_url_for_path(tmp_path / "solar.sqlite3"),
                            object_store_root=tmp_path / "objects") as client:
        project = client.post("/api/commercial-industrial/projects", json={"display_name": "Solar test"}).json()
        url = f"/api/commercial-industrial/projects/{project['project_id']}"
        assert client.post(url + "/solar-resource", json={}).status_code == 409
        imported = client.post(url + "/evidence-intake/inspect", files={
            "bill": ("invoice.pdf", b"synthetic-pdf", "application/pdf"),
            "nem12": ("meter.csv", _nem12_bytes(), "text/csv"),
        })
        assert imported.status_code == 200
        before = client.get(url + "/evidence-intake").json()["evidence"]
        assert len(lookups) == 1
        assert imported.json()["solar_resource"]["annual_specific_yield_kwh_per_kw"] == 1000
        refreshed = client.post(url + "/solar-resource", json={"tilt_degrees": 30, "azimuth_degrees": 90})
        assert refreshed.status_code == 200
        assert lookups[-1][1]["tilt"] == 30
        after = client.get(url + "/evidence-intake").json()["evidence"]
        assert before["inspection"]["bill"] == after["inspection"]["bill"]
        assert before["inspection"]["nem12"] == after["inspection"]["nem12"]
        assert before["files"] == after["files"]
        assert client.post(url + "/solar-resource", json={"tilt_degrees": 91}).status_code == 422
        monkeypatch.setattr("api.ci_routes.update_ci_project_evidence_inspection_if_current", lambda *a, **k: False)
        assert client.post(url + "/solar-resource", json={}).status_code == 409
