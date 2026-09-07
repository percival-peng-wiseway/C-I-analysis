from copy import deepcopy
from uuid import UUID

import pytest
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path, create_sqlite_session_factory, local_actor
from tests.test_ci_solution_generator import _request, _device_profile
from solar_battery.ci_solution_generator import generate_ci_solutions
from solar_battery.ci_projects import record_ci_design_candidates


def test_site_factors_survive_refresh_without_generating_solutions(tmp_path):
    url = sqlite_url_for_path(tmp_path / 'site.sqlite3')
    factors = _request()['site_factors']
    factors.update(annual_specific_yield_kwh_per_kw=1000, array_tilt_degrees=0, array_azimuth_degrees=0)
    with create_test_client(url) as client:
        project = client.post('/api/commercial-industrial/projects', json={'display_name':'Synthetic site factors'}).json()
        route = f"/api/commercial-industrial/projects/{project['project_id']}/site-factors"
        assert client.get(route).json()['site_factors'] is None
        saved = client.put(route, json=factors)
        assert saved.status_code == 200
        result = saved.json()
        assert result['effective_yield_kwh_per_kwp'] == pytest.approx(1000 * .97 * .98 * .95 * .98 * .99)
    with create_test_client(url) as client:
        assert client.get(route).json() == result
        project = client.get('/api/commercial-industrial/projects').json()['projects'][0]
        assert project['site_factors'] == result['site_factors']
        assert project['design_candidate_count'] == 0
        bad = deepcopy(factors)
        bad['shading_loss_percent'] = 100
        assert client.put(route, json=bad).status_code == 422
        assert client.get(route).json() == result
        assert client.put('/api/commercial-industrial/projects/00000000-0000-0000-0000-000000000001/site-factors', json=factors).status_code == 404


def test_saved_effective_yield_is_the_generated_scenarios_yield(tmp_path):
    url = sqlite_url_for_path(tmp_path / 'generation.sqlite3')
    request = _request()
    with create_test_client(url) as client:
        project = client.post('/api/commercial-industrial/projects', json={'display_name':'Synthetic yield propagation'}).json()
        route = f"/api/commercial-industrial/projects/{project['project_id']}/site-factors"
        first = client.put(route, json=request['site_factors']).json()
        changed = deepcopy(request['site_factors'])
        changed.update(annual_specific_yield_kwh_per_kw=1000, shading_loss_percent=20)
        saved = client.put(route, json=changed).json()
        request['site_factors'] = client.get(route).json()['site_factors']
        generated = generate_ci_solutions(request, device_profile=_device_profile(), device_profile_sha256='a'*64)
        for candidate in generated['candidates']:
            assert candidate['pv_annual_specific_yield_kwh_per_kw'] * candidate['pv_derating_factor'] == pytest.approx(saved['effective_yield_kwh_per_kwp'])
        assert saved['effective_yield_kwh_per_kwp'] < first['effective_yield_kwh_per_kwp']
        with create_sqlite_session_factory(url)() as session, session.begin():
            record_ci_design_candidates(session, project_id=UUID(project['project_id']), actor=local_actor(), candidate_count=len(generated['candidates']), candidates=generated['candidates'], design_context=generated['design_context'], persist_site_factors=True)
        assert client.get(route).json()['site_factors'] == generated['design_context']['site_factors']


def test_effective_yield_changes_dispatched_pv_and_energy_savings(monkeypatch):
    from solar_battery.ci_scenario_analysis import analyze_ci_physical_scenarios
    from tests.test_ci_scenario_analysis import _profile, _streams, _scenario
    baseline = {'profile': {'profile_id': 'synthetic'}, 'demand_evidence': {
        'rolling_demand_kva': 15., 'chargeable_rolling_demand_kva': 15.,
        'incentive_demand_kva': 15., 'billing_period_max_kva': 15., 'billing_period_max_kw': 12.,
    }}
    monkeypatch.setattr('solar_battery.ci_scenario_analysis.analyze_ci_nem12', lambda *args, **kwargs: baseline)
    monkeypatch.setattr('solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence', lambda *args, **kwargs: {'streams': _streams()})
    high = _scenario('high-yield', 0., 0.)
    high.update(pv_capacity_kwp_dc=.1, pv_annual_specific_yield_kwh_per_kw=1000., pv_derating_factor=.9)
    low = {**high, 'scenario_id': 'low-yield', 'pv_system_id': 'pv-low', 'pv_derating_factor': .45}
    result = analyze_ci_physical_scenarios(b'synthetic', profile=_profile(), scenarios=[high, low])
    rows = {row['scenario_id']: row for row in result['scenarios']}
    assert rows['high-yield']['post_dispatch']['pv_generation_kwh'] == pytest.approx(2 * rows['low-yield']['post_dispatch']['pv_generation_kwh'], abs=.002)
    high_savings = rows['high-yield']['annual_tariff_value']['category_savings_ex_gst_aud']['energy_charges']
    low_savings = rows['low-yield']['annual_tariff_value']['category_savings_ex_gst_aud']['energy_charges']
    assert high_savings > 0
    assert high_savings == pytest.approx(2 * low_savings, abs=.03)
