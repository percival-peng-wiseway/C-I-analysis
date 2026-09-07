from copy import deepcopy
from uuid import UUID

import pytest
from pydantic import ValidationError

from solar_battery.ci_stc_calculator import CiStcCalculatorInput, calculate_stc_estimate
from solar_battery.durable_cockpit.orm import CiProjectModel
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path, create_sqlite_session_factory


def inputs(**changes):
    return CiStcCalculatorInput.model_validate({
        "solar_installation_year": 2025, "solar_zone": 4, "pv_capacity_kwp": 140,
        "solar_certificate_price": 39,
        "battery_stc_count": 174, "battery_certificate_price": 39, **changes,
    })


def test_manual_example_no_caps_tiering_or_certificate_floor():
    result = calculate_stc_estimate(inputs())
    assert result["solar_calculated_quantity"] == 995.4
    assert result["solar_rebate_aud"] == 38820.60
    assert result["battery_calculated_quantity"] == 174
    assert result["battery_rebate_aud"] == 6786
    assert result["total_rebate_aud"] == 45606.60
    assert "battery_factor" not in result
    assert "battery_installation_period" not in result["inputs"]
    assert result["applied_to_solutions"] is result["applied_to_finance"] is False
    assert result["customer_facing_permission"] is False
    assert calculate_stc_estimate(inputs(solar_zone=3))["solar_zone_factor"] == 1.382
    assert calculate_stc_estimate(inputs(solar_installation_year=2030))["solar_deeming_years"] == 1


@pytest.mark.parametrize("count,price,expected", [(174, 39, 6786), (200, 40, 8000), (0, 39, 0), (174, 0, 0), (3, 1.235, 3.71)])
def test_battery_count_times_price_only(count, price, expected):
    result = calculate_stc_estimate(inputs(battery_stc_count=count, battery_certificate_price=price))
    assert result["battery_calculated_quantity"] == count
    assert result["battery_rebate_aud"] == expected


@pytest.mark.parametrize("invalid", [
    {"solar_installation_year": 2031}, {"solar_zone": 2}, {"pv_capacity_kwp": -1},
    {"battery_installation_period": "2026-05_12"}, {"battery_certificate_price": float("nan")},
    {"solar_certificate_price": float("inf")}, {"approved": True},
    {"battery_stc_count": -1}, {"battery_stc_count": float("nan")},
    {"battery_stc_count": 1_000_001}, {"battery_usable_capacity_kwh": 390},
])
def test_invalid_inputs_fail_closed(invalid):
    with pytest.raises(ValidationError):
        inputs(**invalid)


def test_project_worksheet_persists_without_touching_calculation_snapshots(tmp_path):
    url = sqlite_url_for_path(tmp_path / "stc.sqlite3")
    with create_test_client(url) as client:
        first = client.post("/api/commercial-industrial/projects", json={"display_name": "Synthetic worksheet"}).json()
        second = client.post("/api/commercial-industrial/projects", json={"display_name": "Separate worksheet"}).json()
        pid = first["project_id"]
        route = f"/api/commercial-industrial/projects/{pid}/stc-calculator"
        factory = create_sqlite_session_factory(url)
        with factory() as session:
            row = session.get(CiProjectModel, UUID(pid))
            before = {column.name: deepcopy(getattr(row, column.name)) for column in row.__table__.columns if column.name != "stc_calculator_json"}
        assert client.get(route).json()["estimate"] is None
        response = client.put(route, json=inputs().model_dump())
        assert response.status_code == 200
        assert response.json()["estimate"]["total_rebate_aud"] == 45606.60
        assert client.get(f"/api/commercial-industrial/projects/{second['project_id']}/stc-calculator").json()["estimate"] is None
        assert client.put(route, json={**inputs().model_dump(), "pv_capacity_kwp": -1}).status_code == 422
        assert client.get(route).json() == response.json()
        with factory() as session:
            row = session.get(CiProjectModel, UUID(pid))
            assert {column.name: getattr(row, column.name) for column in row.__table__.columns if column.name != "stc_calculator_json"} == before
        missing = "/api/commercial-industrial/projects/00000000-0000-0000-0000-000000000001/stc-calculator"
        assert client.get(missing).status_code == 404
    with create_test_client(url) as client:
        assert client.get(route).json() == response.json()


def test_default_count_and_zero():
    payload = inputs().model_dump()
    payload.pop("battery_stc_count")
    assert CiStcCalculatorInput.model_validate(payload).battery_stc_count == 174
    assert calculate_stc_estimate(inputs(battery_stc_count=0))["battery_rebate_aud"] == 0


def test_legacy_capacity_is_not_reinterpreted_or_overwritten_on_read(tmp_path):
    url = sqlite_url_for_path(tmp_path / "legacy.sqlite3")
    with create_test_client(url) as client:
        pid = client.post("/api/commercial-industrial/projects", json={"display_name": "Legacy worksheet"}).json()["project_id"]
        route = f"/api/commercial-industrial/projects/{pid}/stc-calculator"
        legacy = inputs().model_dump()
        legacy.pop("battery_stc_count")
        legacy["battery_usable_capacity_kwh"] = 390
        factory = create_sqlite_session_factory(url)
        with factory() as session:
            row = session.get(CiProjectModel, UUID(pid))
            row.stc_calculator_json = legacy
            session.commit()
        state = client.get(route).json()
        assert state["legacy_capacity_reset"] is True
        assert state["estimate"] is None
        assert state["draft_inputs"] == inputs().model_dump()
        with factory() as session:
            assert session.get(CiProjectModel, UUID(pid)).stc_calculator_json == legacy
        response = client.put(route, json={**state["draft_inputs"], "battery_stc_count": 200})
        assert response.status_code == 200
        assert response.json()["legacy_capacity_reset"] is False
        assert response.json()["estimate"]["battery_rebate_aud"] == 7800
        assert client.get(route).json() == response.json()


@pytest.mark.parametrize("period", ["2025", "2026-01_04", "2026-05_12", "2027-01_06", "2027-07_12", "2028-01_06", "2028-07_12", "2029-01_06", "2029-07_12", "2030-01_06", "2030-07_12"])
def test_old_period_worksheet_retains_count_but_requires_new_formula_save(tmp_path, period):
    url = sqlite_url_for_path(tmp_path / "period.sqlite3")
    with create_test_client(url) as client:
        pid = client.post("/api/commercial-industrial/projects", json={"display_name": "Old formula"}).json()["project_id"]
        route = f"/api/commercial-industrial/projects/{pid}/stc-calculator"
        legacy = {**inputs(battery_stc_count=200).model_dump(), "battery_installation_period": period}
        factory = create_sqlite_session_factory(url)
        with factory() as session:
            session.get(CiProjectModel, UUID(pid)).stc_calculator_json = legacy
            session.commit()
        state = client.get(route).json()
        assert state["requires_recalculation"] is True
        assert state["legacy_capacity_reset"] is False
        assert state["estimate"] is None
        assert state["draft_inputs"] == inputs(battery_stc_count=200).model_dump()
        with factory() as session:
            assert session.get(CiProjectModel, UUID(pid)).stc_calculator_json == legacy
        saved = client.put(route, json=state["draft_inputs"]).json()
        assert saved["requires_recalculation"] is False
        assert saved["estimate"]["battery_rebate_aud"] == 7800
        assert client.get(route).json() == saved
