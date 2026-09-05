from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone
import math
from uuid import UUID

import pytest

from solar_battery.ci_pv_timing import (
    SOLAR_GEOMETRY_PROFILE_ID,
    _solar_geometry_weight,
    build_geometry_pv_profile,
    normalize_pv_geometry,
    pv_geometry_cache_key,
)


AEST = timezone(timedelta(hours=10))


def geometry(**overrides) -> dict[str, object]:
    return {
        "latitude_degrees": -37.8,
        "longitude_degrees": 145.0,
        "array_tilt_degrees": 30.0,
        "array_azimuth_degrees": 0.0,
        "location_source_label": "Reviewed synthetic site geometry",
        "location_confirmed": True,
        **overrides,
    }


def stamps(start: datetime, count: int, minutes: int = 30) -> tuple[datetime, ...]:
    return tuple(start + timedelta(minutes=minutes * index) for index in range(count))


def profile(timestamps, *, coordinates=None, minutes=30, annual=1500.0):
    return build_geometry_pv_profile(
        timestamps, annual, interval_minutes=minutes,
        geometry=coordinates or geometry(),
    )


@pytest.mark.parametrize("year", [2024, 2025])
def test_geometry_preserves_authored_annual_yield_including_leap_year(year):
    series = profile(stamps(datetime(year, 1, 1, tzinfo=AEST), (365 + calendar.isleap(year)) * 48))
    assert math.fsum(series) == pytest.approx(1500.0, abs=1e-9)
    assert all(math.isfinite(value) and value >= 0 for value in series)


def test_partial_pv_input_is_not_rescaled_to_a_whole_annual_yield():
    whole = profile(stamps(datetime(2025, 1, 1, tzinfo=AEST), 365 * 48))
    january = profile(stamps(datetime(2025, 1, 1, tzinfo=AEST), 31 * 48))
    assert january == whole[:31 * 48]
    assert math.fsum(january) < 200


def test_summer_daylight_extends_beyond_old_fixed_six_to_eighteen_window():
    summer = profile(stamps(datetime(2025, 12, 21, tzinfo=AEST), 48), coordinates=geometry(array_tilt_degrees=0))
    winter = profile(stamps(datetime(2025, 6, 21, tzinfo=AEST), 48), coordinates=geometry(array_tilt_degrees=0))
    assert math.fsum(summer[:12]) > 0
    assert math.fsum(summer[36:]) > 0
    assert math.fsum(winter[:12]) == 0
    assert math.fsum(winter[36:]) == 0
    assert summer[0] == summer[-1] == 0


def test_east_and_west_arrays_shift_energy_to_the_corresponding_half_day():
    series = stamps(datetime(2025, 3, 20, tzinfo=AEST), 48)
    east = profile(series, coordinates=geometry(array_azimuth_degrees=90, array_tilt_degrees=45))
    west = profile(series, coordinates=geometry(array_azimuth_degrees=270, array_tilt_degrees=45))
    assert math.fsum(east[:24]) > math.fsum(west[:24])
    assert math.fsum(west[26:]) > math.fsum(east[26:])


def test_longitude_changes_meter_clock_solar_noon_and_tilt_changes_timing():
    series = stamps(datetime(2025, 3, 20, tzinfo=AEST), 96, 15)
    eastern = profile(series, coordinates=geometry(longitude_degrees=150), minutes=15)
    western = profile(series, coordinates=geometry(longitude_degrees=135), minutes=15)
    east_peak = max(range(96), key=eastern.__getitem__)
    west_peak = max(range(96), key=western.__getitem__)
    assert west_peak - east_peak == pytest.approx(4, abs=1)
    flat = profile(series, coordinates=geometry(array_tilt_degrees=0), minutes=15)
    assert flat != eastern


def test_geometry_is_a_physical_instant_not_a_local_clock_label():
    at_aest = datetime(2025, 9, 1, 12, 30, tzinfo=AEST)
    at_utc = at_aest.astimezone(timezone.utc)
    key = pv_geometry_cache_key(geometry())
    assert _solar_geometry_weight(at_aest, key) == _solar_geometry_weight(at_utc, key)
    # At equatorial equinox noon the horizontal projection is almost unity.
    equator = pv_geometry_cache_key(geometry(latitude_degrees=0, longitude_degrees=0, array_tilt_degrees=0))
    assert _solar_geometry_weight(datetime(2025, 3, 20, 12, tzinfo=timezone.utc), equator) > 0.995


@pytest.mark.parametrize("change", [
    {"latitude_degrees": None}, {"latitude_degrees": -91},
    {"longitude_degrees": 181}, {"longitude_degrees": float("nan")},
    {"array_tilt_degrees": 91}, {"array_azimuth_degrees": True},
    {"location_confirmed": False}, {"location_confirmed": 1},
    {"location_source_label": " "},
])
def test_geometry_fails_closed_without_finite_explicit_location_and_orientation(change):
    with pytest.raises(ValueError):
        normalize_pv_geometry(geometry(**change))


def test_geometry_rejects_missing_or_gapped_or_naive_intervals():
    with pytest.raises(ValueError):
        profile([])
    with pytest.raises(ValueError):
        profile(stamps(datetime(2025, 1, 1), 2))
    with pytest.raises(ValueError):
        profile(stamps(datetime(2025, 1, 1, tzinfo=AEST), 2, 60), minutes=30)
    with pytest.raises(ValueError):
        build_geometry_pv_profile(stamps(datetime(2025, 1, 1, tzinfo=AEST), 2), 1500, interval_minutes=30, geometry=None)


def test_scenario_validation_carries_geometry_and_rejects_silent_mode_mismatch():
    from solar_battery.ci_scenario_analysis import CiScenarioAnalysisError, _validated_scenarios
    from tests.test_ci_projects import _scenario

    raw = _scenario()
    raw.update(pv_profile_id=SOLAR_GEOMETRY_PROFILE_ID, pv_geometry=geometry())
    validated = _validated_scenarios([raw])[0]
    assert validated.pv_geometry == geometry()
    with pytest.raises(CiScenarioAnalysisError):
        _validated_scenarios([{**raw, "pv_geometry": None}])
    with pytest.raises(CiScenarioAnalysisError):
        _validated_scenarios([{**raw, "pv_profile_id": "generic_normalized_solar_shape_v1"}])


def test_feasibility_and_tariff_geometry_have_identical_interval_energy_basis():
    from solar_battery.ci_design_feasibility import _normalized_solar_shape, analyze_ci_design_feasibility
    from solar_battery.ci_evidence_intake import parse_ci_active_interval_series
    from solar_battery.ci_scenario_analysis import _validated_scenarios
    from tests.test_ci_design_feasibility import _wide_bytes
    from tests.test_ci_projects import _scenario

    raw = _scenario()
    raw.update(pv_profile_id=SOLAR_GEOMETRY_PROFILE_ID, pv_geometry=geometry())
    scenario = _validated_scenarios([raw])[0]
    intervals = parse_ci_active_interval_series(_wide_bytes()).intervals
    screening = _normalized_solar_shape(intervals, scenario=scenario)
    tariff = build_geometry_pv_profile(
        tuple(row.timestamp for row in intervals),
        scenario.pv_annual_specific_yield_kwh_per_kw,
        interval_minutes=30, geometry=scenario.pv_geometry,
    )
    assert tuple(value * scenario.pv_annual_specific_yield_kwh_per_kw for value in screening) == pytest.approx(tariff)
    result = analyze_ci_design_feasibility(_wide_bytes(), scenarios=[raw])
    assert any("not measured or weather-derived" in text for text in result["assumptions"])
    assert result["customer_facing_permission"] is False


@pytest.mark.parametrize("geometry_mode", [False, True])
@pytest.mark.parametrize("topology,efficiency_basis", [
    ("shared_hybrid_dc", "pack_plus_conversion"),
    ("separate_ac", "whole_system_ac"),
])
def test_api_geometry_generate_save_restore_and_custom_preserve_explicit_timing(
    tmp_path, monkeypatch, geometry_mode, topology, efficiency_basis,
):
    from api.ci_schemas import CiDesignCandidatesRequest
    from solar_battery.ci_design_context import validate_ci_design_context
    from solar_battery.durable_cockpit.orm import CiProjectModel
    from tests.durable_test_helpers import (
        create_sqlite_session_factory, create_test_client, sqlite_url_for_path,
    )
    from tests.test_ci_solution_generator import _device_profile, _request

    request = _request()
    request["connection_options"].update(
        dispatch_topology=topology, battery_efficiency_basis=efficiency_basis,
    )
    if geometry_mode:
        request["site_factors"].update(
            pv_timing_model=SOLAR_GEOMETRY_PROFILE_ID,
            **geometry(),
        )
    # Exercise actual Pydantic defaults/None serialization, not just the Python
    # generator's hand-built requests. A dropped opt-in must fail this test.
    body = CiDesignCandidatesRequest(generation_request=request).model_dump()
    expected_geometry = geometry() if geometry_mode else None
    expected_profile = SOLAR_GEOMETRY_PROFILE_ID if geometry_mode else "generic_normalized_solar_shape_v1"
    database_url = sqlite_url_for_path(tmp_path / "pv-timing-api.sqlite3")
    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", lambda *_args, **_kwargs: {
        "contract_version": "ci_device_profile_state_v1", "status": "ready",
        "updated_at": "2026-09-01T00:00:00+00:00", "profile_sha256": "c" * 64,
        "profile": _device_profile(), "suggested_profile": _device_profile(),
    })
    session_factory = create_sqlite_session_factory(database_url)
    try:
        with create_test_client(database_url) as client:
            created = client.post("/api/commercial-industrial/projects", json={"display_name": "Synthetic geometry regression"})
            assert created.status_code == 201
            project_id = created.json()["project_id"]
            with session_factory.begin() as session:
                project = session.get(CiProjectModel, UUID(project_id))
                assert project is not None
                project.setup_status = "ready"
                project.current_stage = "system_design"
            route = f"/api/commercial-industrial/projects/{project_id}/design-candidates"
            generated = client.post(route, json=body)
            assert generated.status_code == 200, generated.text
            payload = generated.json()
            assert payload["candidate_count"] == 6
            assert all(row["pv_profile_id"] == expected_profile and row.get("pv_geometry") == expected_geometry for row in payload["candidates"])
            assert all(row["dispatch_topology"] == topology and row["battery_efficiency_basis"] == efficiency_basis for row in payload["candidates"])
            if geometry_mode:
                assert payload["design_context"]["site_factors"]["pv_timing_model"] == SOLAR_GEOMETRY_PROFILE_ID
                assert {key: payload["design_context"]["site_factors"][key] for key in geometry()} == expected_geometry
            restored = client.get(route)
            assert restored.status_code == 200
            assert restored.json()["design"]["candidates"] == payload["candidates"]
            assert restored.json()["design"]["design_context"] == payload["design_context"]
            assert validate_ci_design_context(payload["design_context"]) == payload["design_context"]

            custom = client.post(route + "/custom", json={
                "contract_version": "ci_custom_design_candidate_request_v1",
                "label": "Synthetic custom geometry", "pv_capacity_kwp_dc": 120,
                "battery_capacity_kwh": 14, "inverter_capacity_kw_ac": 106,
                "quoted_net_capex_aud_ex_gst": 245000,
                "stc_settings": {"solar_stc_enabled": False, "solar_stc_price_aud_ex_gst": 39,
                                 "battery_stc_enabled": False, "battery_stc_price_aud_ex_gst": 39},
            })
            assert custom.status_code == 200, custom.text
            added = next(row for row in custom.json()["candidates"] if row["scenario_id"] == custom.json()["added_scenario_id"])
            assert added["pv_profile_id"] == expected_profile
            assert added.get("pv_geometry") == expected_geometry
            assert added["dispatch_topology"] == topology
            assert added["battery_efficiency_basis"] == efficiency_basis
            if topology == "separate_ac":
                assert added["battery_inverter_capacity_kw_ac"] == 106
                assert added["pv_inverter_capacity_kw_ac"] == 100
                assert added["charge_efficiency"] * added["discharge_efficiency"] == pytest.approx(0.9)
            saved_custom = client.get(route).json()["design"]
            assert saved_custom["candidate_count"] == 7
            assert saved_custom["candidates"] == custom.json()["candidates"]

            invalid = _request()
            invalid["site_factors"]["pv_timing_model"] = SOLAR_GEOMETRY_PROFILE_ID
            rejected = client.post(route, json={"generation_request": invalid})
            assert rejected.status_code == 422, rejected.text
            # Rejecting an incomplete new mode must not overwrite the saved
            # design or turn its current geometry into generic timing.
            assert client.get(route).json()["design"]["candidates"] == saved_custom["candidates"]
    finally:
        session_factory.kw["bind"].dispose()
