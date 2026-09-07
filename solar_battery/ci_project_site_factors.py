"""Project site assumptions, saved independently of generated solutions."""
from datetime import datetime, timezone

from solar_battery.ci_projects import require_ci_project
from solar_battery.ci_solution_generator import _site_factors, _effective_derating


def site_factors_state(session, *, project_id, actor):
    project = require_ci_project(session, project_id=project_id, actor=actor)
    factors = project.site_factors_json
    if factors is None and isinstance(project.design_context_json, dict):
        factors = project.design_context_json.get("site_factors")
    if factors is None:
        return {"site_factors": None, "effective_yield_kwh_per_kwp": None}
    factors = _site_factors(factors)
    return {
        "site_factors": factors,
        "effective_yield_kwh_per_kwp": float(factors["annual_specific_yield_kwh_per_kw"]) * _effective_derating(factors),
    }


def save_site_factors(session, *, project_id, actor, factors):
    project = require_ci_project(session, project_id=project_id, actor=actor)
    project.site_factors_json = _site_factors(factors)
    project.updated_by_actor_id = actor.actor_id
    project.updated_at = datetime.now(timezone.utc)
    session.flush()
    return site_factors_state(session, project_id=project_id, actor=actor)
