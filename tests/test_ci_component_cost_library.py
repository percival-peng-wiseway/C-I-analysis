from __future__ import annotations

from solar_battery.ci_component_cost_library import ci_component_cost_library
from solar_battery.ci_pricing_catalog import validate_catalog
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def test_provided_component_library_preserves_cost_points_and_cq7_mapping() -> None:
    library = ci_component_cost_library()
    assert library["contract_version"] == "ci_component_cost_library_v1"
    entries = {entry["component_id"]: entry for entry in library["entries"]}
    assert set(entries) == {
        "astronergy-astro-n7-600-series-provided",
        "fox-ess-cq7-ci-provided",
        "provided-inverter-inv",
    }

    battery = entries["fox-ess-cq7-ci-provided"]
    assert battery["module_nominal_capacity_kwh"] == 6.96
    assert [row["size"] for row in battery["cost_rows"]] == [83.52, 125.28, 167.04]
    assert [row["capital_cost_aud"] for row in battery["cost_rows"]] == [
        34712.0,
        49002.0,
        63290.0,
    ]
    assert battery["pricing_catalog_template"]["replacement_interval_years"] is None

    pv = entries["astronergy-astro-n7-600-series-provided"]
    inverter = entries["provided-inverter-inv"]
    assert pv["cost_rows"][-1]["capital_cost_aud"] == 52671.4
    assert inverter["cost_rows"] == [
        {"size": 80.0, "capital_cost_aud": 9000.0, "replacement_cost_aud": 9000.0, "annual_om_cost_aud": 0.0},
        {"size": 100.0, "capital_cost_aud": 9500.0, "replacement_cost_aud": 9500.0, "annual_om_cost_aud": 0.0},
        {"size": 125.0, "capital_cost_aud": 10000.0, "replacement_cost_aud": 10000.0, "annual_om_cost_aud": 0.0},
    ]


def test_library_templates_are_detached_and_direct_templates_validate() -> None:
    first = ci_component_cost_library()
    first["entries"][0]["cost_rows"][0]["capital_cost_aud"] = -1
    second = ci_component_cost_library()
    assert second["entries"][0]["cost_rows"][0]["capital_cost_aud"] == 42400.0

    for entry in second["entries"]:
        template = entry["pricing_catalog_template"]
        if entry["reuse_status"] != "direct":
            continue
        catalog = {
            "contract_version": "ci_pricing_catalog_v1",
            "catalog_id": "ci_solution_pricing",
            "currency": "AUD",
            "tax_basis": "gst_exclusive",
            "products": [template],
            "installation_items": [],
        }
        assert validate_catalog(catalog) == []

    battery_template = second["entries"][1]["pricing_catalog_template"]
    battery_template["replacement_interval_years"] = 10
    battery_catalog = {
        "contract_version": "ci_pricing_catalog_v1",
        "catalog_id": "ci_solution_pricing",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "products": [battery_template],
        "installation_items": [],
    }
    assert validate_catalog(battery_catalog) == []


def test_component_library_api_returns_backend_owned_contract(tmp_path) -> None:
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-library.sqlite3")) as client:
        response = client.get("/api/commercial-industrial/component-cost-library")
    assert response.status_code == 200
    assert response.json()["contract_version"] == "ci_component_cost_library_v1"
    assert len(response.json()["entries"]) == 3
