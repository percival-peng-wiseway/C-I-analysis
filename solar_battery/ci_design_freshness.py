"""Keep saved scenario operands aligned with editable project assumptions."""
from solar_battery.ci_device_profile import ci_device_profile_state
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_solution_generator import _site_factors


def design_input_changes(session, *, project, actor, profile_loader=ci_device_profile_state) -> list[str]:
    context = getattr(project, "design_context_json", None)
    factors = getattr(project, "site_factors_json", None)
    changes = []
    if factors is not None:
        saved = context.get("site_factors") if isinstance(context, dict) else None
        if saved is None or _site_factors(factors) != _site_factors(saved):
            changes.append("Site factors changed")
    if not isinstance(context, dict) or context.get("contract_version") != "ci_design_context_v2":
        return changes
    selection = context.get("profile_selection", {})
    state = profile_loader(session, actor=actor)
    profile = state.get("profile")
    if state.get("status") != "ready" or not isinstance(profile, dict):
        return [*changes, "The saved profile library is unavailable"]
    technical = context.get("technical_options", {})
    for kind, fields in (
        ("solar", ("default_dc_ac_ratio",)),
        ("battery", ("coupling", "nominal_capacity_kwh_per_unit", "continuous_power_kw_per_unit", "round_trip_efficiency_percent", "usable_depth_of_discharge_percent")
         + (("power_conversion_efficiency_percent",) if technical.get("battery_efficiency_basis", "pack_plus_conversion") == "pack_plus_conversion" else ())),
        ("inverter", ("rated_active_power_kw", "reactive_support_enabled", "rated_apparent_power_kva", "maximum_reactive_power_kvar")),
    ):
        saved = selection.get(f"{kind}_profile")
        if saved is None and kind == "inverter":
            continue  # Older designs can use explicit connection assumptions.
        if kind == "inverter" and isinstance(saved, dict) and "reactive_support_enabled" not in saved:
            saved = {**saved, "reactive_support_enabled": technical.get("reactive_support_enabled")}
        current = next((item for item in profile["solution_profiles"][f"{kind}_profiles"]
                        if item.get("profile_id") == selection.get(f"{kind}_profile_id")), None)
        if not isinstance(saved, dict) or current is None or current.get("status") != "published" or any(saved.get(key) != current.get(key) for key in fields):
            changes.append(f"The selected {kind} profile changed")
    return changes


def require_current_design_inputs(session, *, project, actor, profile_loader=ci_device_profile_state) -> None:
    changes = design_input_changes(session, project=project, actor=actor, profile_loader=profile_loader)
    if changes:
        raise CiProjectError(
            "ci_project_design_inputs_changed",
            f"{'; '.join(changes)}. Regenerate solutions in Solution Generator before calculating again.",
        )
