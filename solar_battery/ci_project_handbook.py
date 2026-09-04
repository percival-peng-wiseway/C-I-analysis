from __future__ import annotations

from typing import Any


CI_PROJECT_HANDBOOK_CONTRACT_VERSION = "ci_project_handbook_v1"


def build_ci_project_handbook(
    *,
    project: object,
    evidence_state: dict[str, object],
    design_candidates: list[dict[str, object]] | None,
    design_context: dict[str, object] | None,
    design_price_preview_state: dict[str, object],
    feasibility_state: dict[str, object],
    tariff_profile_state: dict[str, object],
    rebate_profile_state: dict[str, object],
    tariff_replay_state: dict[str, object],
    annual_financial_state: dict[str, object],
    device_profile_state: dict[str, object],
) -> dict[str, object]:
    """Build a read-only calculation ledger from already persisted project state.

    This function deliberately does not execute generation, dispatch, tariff or
    finance calculations.  It only projects the Python-owned formula catalogue
    beside current persisted inputs and results.
    """

    project_id = str(getattr(project, "id"))
    project_name = str(getattr(project, "display_name"))
    project_updated_at = getattr(project, "updated_at").isoformat()
    modules = [
        _evidence_module(evidence_state),
        _solution_module(
            design_candidates=design_candidates,
            design_context=design_context,
            price_state=design_price_preview_state,
            rebate_state=rebate_profile_state,
            device_state=device_profile_state,
        ),
        _scenario_module(feasibility_state, tariff_replay_state),
        _finance_module(
            tariff_profile_state=tariff_profile_state,
            rebate_profile_state=rebate_profile_state,
            tariff_replay_state=tariff_replay_state,
            annual_financial_state=annual_financial_state,
            device_profile_state=device_profile_state,
        ),
    ]
    return {
        "contract_version": CI_PROJECT_HANDBOOK_CONTRACT_VERSION,
        "project": {
            "project_id": project_id,
            "display_name": project_name,
            "snapshot_at": project_updated_at,
        },
        "authority": {
            "calculation_authority": "python",
            "presentation_authority": "handbook_projection_only",
            "mutation_policy": "controlled_existing_module_inputs",
            "statement": (
                "The Handbook reads saved inputs and results. It does not run or "
                "replace Python calculations."
            ),
        },
        "parameter_management": {
            "mode": "edit_at_source",
            "stable_parameter_ids": True,
            "supports_generic_formula_mutation": False,
            "statement": (
                "Editable parameters remain governed by their source module and "
                "validation contract. Stable IDs allow controlled editors to be "
                "added without changing result meaning."
            ),
        },
        "modules": modules,
        "summary": {
            "module_count": len(modules),
            "parameter_count": sum(len(item["parameters"]) for item in modules),
            "calculation_count": sum(len(item["calculations"]) for item in modules),
            "model_count": sum(len(item["models"]) for item in modules),
            "result_row_count": sum(
                len(group["rows"])
                for item in modules
                for group in item["result_sets"]
            ),
        },
    }


def _evidence_module(state: dict[str, object]) -> dict[str, object]:
    evidence = _mapping(state.get("evidence"))
    inspection = _mapping(evidence.get("inspection"))
    bill = _mapping(inspection.get("bill"))
    nem12 = _mapping(inspection.get("nem12"))
    parameters: list[dict[str, object]] = []
    for key, label, unit in (
        ("billing_period_start", "Bill period start", None),
        ("billing_period_end", "Bill period end", None),
        ("billing_days", "Bill days", "days"),
        ("network_tariff_code", "Detected network tariff", None),
        ("consumption_kwh", "Billed consumption", "kWh"),
        ("highest_metered_demand_kva", "Billed highest demand", "kVA"),
        ("power_factor_at_highest_demand", "Power factor at highest demand", None),
        ("subtotal_ex_gst_aud", "Bill subtotal", "AUD ex GST"),
        ("gst_aud", "Bill GST", "AUD"),
        ("total_inc_gst_aud", "Bill total", "AUD inc GST"),
    ):
        parameters.append(
            _parameter(
                f"evidence.bill.{key}",
                label,
                bill.get(key),
                unit=unit,
                source_kind="evidence",
                source_label="Approved bill extraction",
                source_path=f"evidence.inspection.bill.{key}",
                edit_stage="evidence",
            )
        )
    for key, label, unit in (
        ("input_format", "Interval input format", None),
        ("coverage_start", "Interval coverage start", None),
        ("coverage_end", "Interval coverage end", None),
        ("interval_minutes", "Source interval length", "minutes"),
        ("days_per_stream", "Days per stream", "days"),
        ("aligned_stream_ids", "Aligned interval streams", None),
        ("capability_status", "Interval capability", None),
        ("full_tariff_analysis_ready", "Full tariff stream set ready", None),
    ):
        parameters.append(
            _parameter(
                f"evidence.nem12.{key}",
                label,
                nem12.get(key),
                unit=unit,
                source_kind="evidence",
                source_label="Saved interval inspection",
                source_path=f"evidence.inspection.nem12.{key}",
                edit_stage="evidence",
                editable=False,
            )
        )
    calculations = [
        _calculation(
            "evidence.interval_energy",
            "Interval energy to average demand",
            "P_avg,kW = E_interval,kWh / (interval_minutes / 60)",
            "Converts each active-energy interval into average active demand.",
            ["E_interval,kWh", "interval_minutes"],
            "solar_battery/ci_evidence_intake.py::parse_ci_active_interval_series",
        ),
        _calculation(
            "evidence.fifteen_minute_demand",
            "15-minute demand aggregation",
            "kW = 4 * sum(E1_5min); kvar = 4 * sum(Q1_5min)",
            "Aggregates three 5-minute NEM12 intervals into one 15-minute demand interval.",
            ["E1", "Q1"],
            "solar_battery/ci_tariff_analysis.py::_build_demand_intervals",
        ),
        _calculation(
            "evidence.apparent_power",
            "Apparent power",
            "kVA = sqrt(kW^2 + kvar^2)",
            "Combines measured active and reactive demand.",
            ["kW", "kvar"],
            "solar_battery/ci_tariff_analysis.py::_build_demand_intervals",
        ),
        _calculation(
            "evidence.power_factor",
            "Power factor",
            "PF = kW / kVA, or 1 when kVA = 0",
            "Calculates interval power factor from measured demand.",
            ["kW", "kVA"],
            "solar_battery/ci_tariff_analysis.py::_build_demand_intervals",
        ),
        _calculation(
            "evidence.bill_reconciliation",
            "Bill reconciliation",
            "difference = calculated value - bill value; pass when abs(difference) <= tolerance",
            "Fails closed when the approved bill cannot be reconciled to the tariff calculation.",
            ["calculated charge", "approved bill charge", "field tolerance"],
            "solar_battery/ci_tariff_analysis.py::_reconciliation_checks",
        ),
    ]
    result_rows = []
    categories = _mapping(bill.get("charge_categories_ex_gst_aud"))
    for key, value in categories.items():
        result_rows.append(
            {"result_id": f"bill-category-{key}", "label": str(key), "values": {"amount": value}}
        )
    return _module(
        "evidence",
        "Evidence",
        "Measured inputs, data quality and bill reconciliation.",
        status="ready" if state.get("status") == "saved" else "input_required",
        saved_at=evidence.get("saved_at"),
        parameters=parameters,
        calculations=calculations,
        models=[
            _model(
                "evidence.nem12_validation",
                "NEM12 evidence validation",
                "Deterministic parser and stream-alignment checks",
                "Accept only supported, aligned active and reactive streams with verified coverage.",
                [
                    "Standard NEM12 requires 5-minute E1, B1, Q1 and K1 streams for full tariff analysis.",
                    "Evidence identity is bound by SHA-256 before tariff execution.",
                ],
                "solar_battery/ci_tariff_analysis.py::validated_ci_nem12_evidence",
            )
        ],
        result_sets=[
            _result_set(
                "evidence.bill_categories",
                "Saved bill charge categories",
                [{"key": "amount", "label": "Amount", "unit": "AUD ex GST"}],
                result_rows,
            )
        ],
        boundaries=[
            "Evidence fields are not inferred when the source is missing or unapproved.",
            "The Handbook does not load or parse the original files.",
        ],
    )


def _solution_module(
    *,
    design_candidates: list[dict[str, object]] | None,
    design_context: dict[str, object] | None,
    price_state: dict[str, object],
    rebate_state: dict[str, object],
    device_state: dict[str, object],
) -> dict[str, object]:
    context = _mapping(design_context)
    search = _mapping(context.get("search_space"))
    pv_range = _mapping(search.get("pv_range"))
    battery_range = _mapping(search.get("battery_range"))
    technical = _mapping(context.get("technical_options"))
    saved_site = _mapping(context.get("site_factors"))
    # V1 design contexts pre-date the separate site_factors object.  Their
    # validated site operands live in technical_options and remain useful audit
    # evidence even though they cannot be edited through the V2 generator.
    site = saved_site or technical
    site_source_path = (
        "design_context.site_factors"
        if saved_site
        else "design_context.technical_options"
    )
    selection = _mapping(context.get("profile_selection"))
    solar_snapshot = _mapping(selection.get("solar_profile"))
    battery_snapshot = _mapping(selection.get("battery_profile"))
    inverter_snapshot = _mapping(selection.get("inverter_profile"))
    price = (
        _mapping(price_state.get("preview"))
        if price_state.get("status") == "ready"
        else {}
    )
    priced_solutions = _list_of_mappings(price.get("solutions"))
    device_profile = (
        _mapping(device_state.get("profile"))
        if device_state.get("status") == "ready"
        else {}
    )
    equipment_selection = _mapping(price.get("equipment_selection")) or _mapping(
        device_profile.get("default_equipment_selection")
    )
    parameters: list[dict[str, object]] = []
    for key, label, unit in (
        ("minimum_kwp_dc", "PV range minimum", "kWp DC"),
        ("maximum_kwp_dc", "PV range maximum", "kWp DC"),
        ("step_kwp_dc", "PV range step", "kWp DC"),
    ):
        parameters.append(_parameter(f"solution.pv_range.{key}", label, pv_range.get(key), unit=unit, source_kind="analyst_input", source_label="Solution Generator", source_path=f"design_context.search_space.pv_range.{key}", edit_stage="physical_feasibility"))
    for key, label, unit in (
        ("minimum_kwh", "Battery range minimum", "kWh"),
        ("maximum_kwh", "Battery range maximum", "kWh"),
        ("step_kwh", "Battery range step", "kWh"),
    ):
        parameters.append(_parameter(f"solution.battery_range.{key}", label, battery_range.get(key), unit=unit, source_kind="analyst_input", source_label="Solution Generator", source_path=f"design_context.search_space.battery_range.{key}", edit_stage="physical_feasibility"))
    for key, label, unit in (
        ("annual_specific_yield_kwh_per_kw", "Annual specific yield", "kWh/kWp/year"),
        ("shading_loss_percent", "Shading loss", "%"),
        ("soiling_loss_percent", "Soiling loss", "%"),
        ("temperature_loss_percent", "Temperature loss", "%"),
        ("wiring_mismatch_loss_percent", "Wiring and mismatch loss", "%"),
        ("other_system_loss_percent", "Other system loss", "%"),
        ("system_availability_percent", "System availability", "%"),
    ):
        parameters.append(_parameter(f"solution.site.{key}", label, site.get(key), unit=unit, source_kind="analyst_input", source_label=str(site.get("resource_label") or "Solution Generator"), source_path=f"{site_source_path}.{key}", edit_stage="physical_feasibility"))
    technical_parameters = (
        ("target_dc_ac_ratio", "Solar default DC/AC ratio", None, "derived", False, True),
        (
            "inverter_block_size_kw",
            "Selected inverter rated active power",
            "kW AC",
            "profile" if inverter_snapshot else "analyst_input",
            not bool(inverter_snapshot),
            True,
        ),
        ("inverter_quantity", "Configured inverter quantity", "units", "analyst_input", True, False),
        ("site_ac_headroom_kw", "Site AC headroom", "kW AC", "analyst_input", True, True),
        ("battery_duration_hours", "Battery duration", "hours", "derived", False, True),
        ("charge_efficiency_percent", "One-way charge efficiency", "%", "derived", False, True),
        ("discharge_efficiency_percent", "One-way discharge efficiency", "%", "derived", False, True),
        ("minimum_soc_percent", "Minimum SOC", "%", "derived", False, True),
        ("maximum_soc_percent", "Maximum SOC", "%", "model_policy", False, True),
        ("initial_soc_basis", "Initial SOC basis", None, "model_policy", False, True),
        ("allow_grid_charging", "Grid charging", None, "model_policy", False, True),
        (
            "reactive_support_enabled",
            "Reactive support",
            None,
            "profile_snapshot" if inverter_snapshot else "analyst_input",
            not bool(inverter_snapshot),
            True,
        ),
        (
            "reactive_support_max_kvar",
            (
                "Per-inverter maximum reactive power"
                if inverter_snapshot
                else "Legacy reactive support cap"
            ),
            "kvar",
            "profile_snapshot" if inverter_snapshot else "analyst_input",
            not bool(inverter_snapshot),
            True,
        ),
        ("grid_emissions_factor_kg_co2e_per_kwh", "Grid emissions factor", "kg CO2-e/kWh", "analyst_input", True, True),
    )
    reactive_snapshot_keys = {
        "reactive_support_enabled": "reactive_support_enabled",
        "reactive_support_max_kvar": "maximum_reactive_power_kvar",
    }
    inverter_source_label = str(
        inverter_snapshot.get("name")
        or inverter_snapshot.get("profile_id")
        or "Saved inverter profile snapshot"
    )
    for key, label, unit, source_kind, editable, active in technical_parameters:
        snapshot_key = reactive_snapshot_keys.get(key) if inverter_snapshot else None
        parameters.append(
            _parameter(
                f"solution.technical.{key}",
                label,
                (
                    inverter_snapshot.get(snapshot_key)
                    if snapshot_key is not None
                    else technical.get(key)
                ),
                unit=unit,
                source_kind=source_kind,
                source_label=(
                    inverter_source_label
                    if snapshot_key is not None
                    else "Saved design context"
                ),
                source_path=(
                    f"design_context.profile_selection.inverter_profile.{snapshot_key}"
                    if snapshot_key is not None
                    else f"design_context.technical_options.{key}"
                ),
                edit_stage="physical_feasibility",
                editable=editable,
                active=active,
            )
        )
    for key, label in (
        ("solar_profile_id", "Solar performance profile"),
        ("battery_profile_id", "Battery performance profile"),
        ("inverter_profile_id", "Inverter performance profile"),
    ):
        parameters.append(_parameter(f"solution.profile.{key}", label, selection.get(key), source_kind="profile", source_label="Saved profile snapshot", source_path=f"design_context.profile_selection.{key}", edit_stage="physical_feasibility", active=selection.get(key) is not None))
    parameters.extend(
        _profile_snapshot_parameters(
            solar=solar_snapshot,
            battery=battery_snapshot,
            inverter=inverter_snapshot,
        )
    )

    parameters.extend(
        _equipment_cost_parameters(
            device_profile=device_profile,
            equipment_selection=equipment_selection,
        )
    )

    rebate_status = str(rebate_state.get("status") or "not_configured")
    saved_rebate_profile = _mapping(rebate_state.get("profile"))
    suggested_rebate_profile = _mapping(rebate_state.get("suggested_profile"))
    rebate_profile = saved_rebate_profile or suggested_rebate_profile
    rebate_profile_path = (
        "rebate_profile_state.profile"
        if saved_rebate_profile
        else "rebate_profile_state.suggested_profile"
    )
    rebate_approved = rebate_status == "approved" and bool(saved_rebate_profile)
    rebate_source_kind = (
        "approved_assumption"
        if rebate_approved
        else "working_copy"
        if saved_rebate_profile
        else "suggested_assumption"
    )
    rebate_source_label = (
        "Approved project rebate profile"
        if rebate_approved
        else "Saved rebate working copy"
        if saved_rebate_profile
        else "Suggested rebate assumptions"
    )
    parameters.append(
        _parameter(
            "solution.rebate.approval_status",
            "Rebate profile status",
            rebate_status,
            source_kind="approval_state",
            source_label="Project rebate profile state",
            source_path="rebate_profile_state.status",
            edit_stage="physical_feasibility",
            editable=False,
            active=False,
        )
    )
    programs = _mapping(rebate_profile.get("programs"))
    for program_id, label in (("solar_stc", "Solar STCs"), ("battery_stc", "Battery STCs"), ("vic_deemed_veec", "Victorian deemed VEECs")):
        program = _mapping(programs.get(program_id))
        parameters.extend([
            _parameter(f"solution.rebate.{program_id}.enabled", f"{label} enabled", program.get("enabled"), source_kind=rebate_source_kind, source_label=rebate_source_label, source_path=f"{rebate_profile_path}.programs.{program_id}.enabled", edit_stage="physical_feasibility", active=rebate_approved),
            _parameter(f"solution.rebate.{program_id}.price", f"{label} certificate price", program.get("certificate_price_aud_ex_gst"), unit="AUD ex GST/certificate", source_kind=rebate_source_kind, source_label=str(program.get("price_source_label") or rebate_source_label), source_path=f"{rebate_profile_path}.programs.{program_id}.certificate_price_aud_ex_gst", edit_stage="physical_feasibility", active=rebate_approved and program.get("enabled") is True),
        ])

    calculations = [
        _calculation("solution.range_count", "Candidate values in one range", "count = floor((maximum - minimum) / step) + 1", "Builds the analyst-authored PV or battery target list without equipment-size rounding.", ["minimum", "maximum", "step"], "solar_battery/ci_solution_generator.py::_range_values"),
        _calculation("solution.matrix_count", "Requested solution combinations", "requested_count = PV candidate count * battery candidate count", "Forms the Cartesian product before connection checks.", ["PV candidate count", "battery candidate count"], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
        _calculation("solution.pv_derating", "Effective PV derating", "derating = availability * product(1 - loss_i)", "Combines all saved site-loss assumptions multiplicatively.", ["availability", "shading", "soiling", "temperature", "wiring/mismatch", "other loss"], "solar_battery/ci_solution_generator.py::_effective_derating", example=_pv_derating_example(site, technical)),
        _calculation("solution.annual_pv_output", "Expected annual PV output", "annual_kWh = PV_kWp * specific_yield_kWh_per_kWp * derating", "Used for energy screening and Solar STC output eligibility.", ["PV capacity", "specific yield", "derating"], "solar_battery/ci_design_feasibility.py::_scenario_energy_series"),
        _calculation("solution.battery_power", "Battery screening power", "battery_kW = target_kWh * profile_kW_per_unit / profile_kWh_per_unit", "Uses the selected battery profile as a performance ratio only.", ["target battery capacity", "profile continuous power", "profile nominal capacity"], "solar_battery/ci_solution_generator.py::_screening_battery_power"),
        _calculation("solution.one_way_efficiency", "One-way battery efficiency", "eta_one_way = sqrt(round_trip_efficiency) * conversion_efficiency", "The same one-way efficiency is assigned to charge and discharge.", ["round-trip efficiency", "power conversion efficiency"], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
        _calculation("solution.minimum_soc", "Minimum state of charge", "minimum_SOC = 1 - usable_depth_of_discharge", "Converts usable DoD into the lower SOC bound.", ["usable depth of discharge"], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
        _calculation("solution.pcs_size", "Common screening PCS capacity", "requirement(PV,battery) = max(PV_kWp / DC_AC_ratio, battery_kW); PCS(PV) = max(requirement(PV,battery) for every headroom-feasible battery option in that PV row)", "Every surviving battery alternative for one PV target receives the same continuous PCS capacity. The value is not snapped to configured inverter quantity or block size.", ["PV capacity", "DC/AC ratio", "all feasible battery screening powers for the PV row"], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
        _calculation("solution.headroom_gate", "Site connection gate", "feasible when max(PV_kWp / DC_AC_ratio, battery_kW) <= site_AC_headroom_kW", "Rejects combinations above the saved site connection allowance.", ["PV requirement", "battery requirement", "site AC headroom"], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
        _calculation("solution.reactive_cap", "Profile-scaled reactive support limit", "profile_scale = candidate_PCS_kW / profile_rated_active_kW; Q_cap = profile_scale * profile_Q_max when profile_reactive_enabled else 0; S_limit = profile_scale * profile_rated_apparent_kVA when enabled else null", "The immutable inverter profile snapshot is authoritative whenever it exists. Legacy project-level reactive switches and caps are used only for saved designs without an inverter profile.", ["candidate PCS capacity", "profile rated active power", "profile reactive-support switch", "profile maximum reactive power", "profile rated apparent power"], "solar_battery/ci_solution_generator.py::_scenario"),
        _calculation("solution.pq_limit", "Circular P-Q capability", "P^2 + Q^2 <= S_limit^2", "Constrains shared inverter active and reactive power in dispatch. Q and S limits come from the scaled inverter profile snapshot, while the circular capability shape remains an analyst assumption because the current profile does not provide an executable P-Q curve.", ["active power", "reactive power", "profile-scaled apparent power limit"], "solar_battery/ci_peak_shaving_optimizer.py"),
        _calculation("solution.battery_curve_cost", "Battery equipment curve cost", "units = target_battery_kWh / module_capacity_kWh; cost = proportional below first point, linearly interpolated between points, and last-segment extrapolated above the final point", "The requested battery target remains continuous; its capacity is converted to a reference module quantity only for equipment pricing.", ["target battery capacity", "module capacity", "selected battery capital-cost curve"], "solar_battery/ci_annual_financial_comparison.py::_curve_cost"),
        _calculation("solution.inverter_curve_cost", "Inverter equipment curve cost", "cost = curve(capacity) when capacity <= sizing_unit; otherwise cost = capacity / sizing_unit * curve(sizing_unit)", "Above the selected inverter sizing unit, pricing scales the cost at that sizing unit rather than extrapolating the last curve segment.", ["screening inverter capacity", "sizing unit", "selected inverter capital-cost curve"], "solar_battery/ci_annual_financial_comparison.py::_profile_capex_breakdown"),
        _calculation("solution.gross_capex", "Gross equipment CAPEX", "gross_CAPEX = PV_kWp * selected_PV_AUD_per_kWp + battery_curve_cost + inverter_curve_cost", "Uses the selected workspace equipment catalogue. Each component is rounded to cents before the stored gross total is rounded to cents.", ["PV capacity", "battery reference quantity", "inverter capacity", "selected device prices"], "solar_battery/ci_annual_financial_comparison.py::_profile_capex_breakdown", example=_gross_capex_example(priced_solutions)),
        _calculation("solution.net_capex", "Model Net CAPEX", "model_Net_CAPEX = gross_CAPEX - approved_upfront_rebates", "This value is the model price preview. A later manual quotation replaces it as final Net CAPEX and must not be reduced by rebates a second time.", ["gross CAPEX", "approved rebate total"], "solar_battery/ci_annual_financial_comparison.py::preview_ci_design_candidate_prices", example=_net_capex_example(priced_solutions)),
        _calculation("solution.solar_stc_eligibility", "Solar STC eligibility", "eligible only when 0 < PV_kWp <= 100 and PV_kWp * specific_yield * derating <= 250,000 kWh/year", "The program must also be enabled with current eligibility, site, zone, price and ruleset evidence. An ineligible scenario receives zero certificates rather than an estimated entitlement.", ["PV capacity", "annual specific yield", "derating", "approved evidence bindings"], "solar_battery/ci_rebate_calculation.py::_solar_stc"),
        _calculation("solution.solar_stc", "Solar STC rebate", "STCs = floor(PV_kWp * postcode_zone_rating * deeming_years); rebate = round(STCs * certificate_price, 2)", "The whole product is floored once. Deeming years are determined by the approved target certificate date.", ["PV capacity", "zone rating", "deeming years", "certificate price"], "solar_battery/ci_rebate_calculation.py::_solar_stc", example=_rebate_example(priced_solutions, "solar_stc")),
        _calculation("solution.battery_stc_eligibility", "Battery STC eligibility", "eligible only when 5 <= nominal_battery_kWh <= 100 and 0 < linked_PV_kWp <= 100", "Certified usable capacity is nominal capacity times the approved usable fraction, capped at 50 kWh for the certificate calculation. A 300-400 kWh candidate is therefore ineligible under the current rule set even if Battery STCs are enabled.", ["nominal battery capacity", "linked PV capacity", "certified usable fraction", "approved evidence bindings"], "solar_battery/ci_rebate_calculation.py::_battery_stc"),
        _calculation("solution.battery_stc", "Battery STC rebate", "weighted_kWh = tier_1 + 0.6 * tier_2 + 0.15 * tier_3; STCs = floor(weighted_kWh * date_factor); rebate = round(STCs * certificate_price, 2)", "For the tiered method, tiers cover claimable usable capacity 0-14, 14-28 and 28-50 kWh. The floor is applied after all weighted tiers are summed.", ["certified usable capacity", "tier weights", "date factor", "certificate price"], "solar_battery/ci_rebate_calculation.py::_battery_stc", example=_rebate_example(priced_solutions, "battery_stc")),
        _calculation("solution.veec_eligibility", "Victorian deemed VEEC eligibility", "eligible only when site_state = VIC, 30 <= PV_kWp <= 200, and connected_inverter_kVA = PCS_kW * approved_kVA_per_kW_AC >= 30", "The program must also be enabled under a current approved rebate profile with Victorian region, inverter apparent-power evidence, certificate price and active ruleset evidence.", ["site state", "PV capacity", "PCS capacity", "approved inverter kVA/kW ratio", "approved evidence bindings"], "solar_battery/ci_rebate_calculation.py::_vic_deemed_veec"),
        _calculation("solution.veec", "Victorian deemed VEEC rebate", "input_factor = 0.133 when PV_kWp <= 100 else 0.25; regional_factor = 0.98 metropolitan else 1.04; VEECs = floor(PV_kWp * input_factor * 10 * regional_factor); rebate = round(VEECs * certificate_price, 2)", "The lifetime is fixed at 10 years and the whole certificate product is floored once.", ["PV capacity", "input factor", "10-year lifetime", "Victorian regional factor", "certificate price"], "solar_battery/ci_rebate_calculation.py::_vic_deemed_veec", example=_rebate_example(priced_solutions, "vic_deemed_veec")),
        _calculation("solution.manual_quote_basis", "Manual quotation hand-off", "finance_gross_upfront = finance_Net_CAPEX = entered_quoted_Net_CAPEX; finance_rebate_deduction = 0", "The quotation field is explicitly a final ex-GST Net CAPEX. The theoretical rebate audit is retained, but annual finance does not deduct it again.", ["analyst-entered quoted Net CAPEX"], "solar_battery/ci_annual_financial_comparison.py::_financial_solution"),
    ]
    price_by_id = {str(row.get("scenario_id")): row for row in priced_solutions}
    rows = []
    rebate_rows = []
    for candidate in design_candidates or []:
        scenario_id = str(candidate.get("scenario_id", ""))
        priced = price_by_id.get(scenario_id, {})
        breakdown = _mapping(priced.get("capex_breakdown_aud_ex_gst"))
        rows.append({
            "result_id": scenario_id,
            "label": str(candidate.get("label") or scenario_id),
            "values": {
                "pv_capacity": candidate.get("pv_capacity_kwp_dc"),
                "battery_capacity": candidate.get("nominal_capacity_kwh"),
                "pcs_capacity": candidate.get("pv_inverter_capacity_kw_ac"),
                "gross_capex": priced.get("gross_capex_aud_ex_gst"),
                "pv_capex": breakdown.get("pv_aud"),
                "battery_capex": breakdown.get("battery_aud"),
                "inverter_capex": breakdown.get("inverter_aud"),
                "upfront_rebate": priced.get("upfront_rebate_aud_ex_gst"),
                "net_capex": priced.get("net_capex_aud_ex_gst"),
            },
        })
        rebate_calculation = _mapping(priced.get("rebate_calculation"))
        for program_id, program in _mapping(
            rebate_calculation.get("programs")
        ).items():
            if not isinstance(program, dict):
                continue
            formula = _mapping(program.get("formula"))
            rebate_rows.append(
                {
                    "result_id": f"{scenario_id}:{program_id}",
                    "label": f"{candidate.get('label') or scenario_id} - {program.get('label') or program_id}",
                    "values": {
                        "status": program.get("status"),
                        "reason_codes": _joined_values(program.get("reason_codes")),
                        "certificate_quantity": program.get("certificate_quantity"),
                        "unit_price": program.get("unit_price_aud_ex_gst"),
                        "rebate": program.get("rebate_aud_ex_gst"),
                        "rule_id": formula.get("rule_id"),
                        "rounding": formula.get("rounding"),
                        "operands": _display_mapping(formula.get("operands")),
                    },
                }
            )
    return _module(
        "solution_generator",
        "Solution Generator",
        "Search-space generation, equipment performance, rebates and Net CAPEX.",
        status="ready" if design_candidates else "input_required",
        saved_at=None,
        parameters=parameters,
        calculations=calculations,
        models=[
            _model("solution.cartesian_search", "Candidate generator", "Deterministic Cartesian search with connection rejection", "Generate every PV and battery target pair, then reject pairs above site AC headroom.", ["Maximum 20 PV candidates, 15 battery candidates and 200 total combinations.", "Target PV and battery capacities are preserved exactly for screening.", "PCS sizing is continuous; configured inverter quantity is currently not a sizing constraint."], "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
            _model("solution.profile_usage", "Equipment profile usage", "Performance-ratio projection", "Solar, battery and inverter profiles provide model performance inputs, not target-size snapping.", ["Solar module watts, module efficiency, temperature coefficient and degradation are not active in current physical calculations.", "Battery standby loss, annual degradation and profile min/max unit counts are not active in current physical calculations.", "The inverter reactive-support switch, rated active/apparent power and maximum kvar are active and scale with candidate PCS capacity.", "Inverter efficiency, power-factor limits, night capability and P-Q availability flags are not active; the circular P-Q envelope remains an analyst assumption."], "solar_battery/ci_solution_generator.py"),
        ],
        result_sets=[
            _result_set("solution.solutions", "Generated solutions", [
                {"key": "pv_capacity", "label": "PV", "unit": "kWp DC"},
                {"key": "battery_capacity", "label": "Battery", "unit": "kWh"},
                {"key": "pcs_capacity", "label": "PCS", "unit": "kW AC"},
                {"key": "pv_capex", "label": "PV CAPEX", "unit": "AUD ex GST"},
                {"key": "battery_capex", "label": "Battery CAPEX", "unit": "AUD ex GST"},
                {"key": "inverter_capex", "label": "Inverter CAPEX", "unit": "AUD ex GST"},
                {"key": "gross_capex", "label": "Gross CAPEX", "unit": "AUD ex GST"},
                {"key": "upfront_rebate", "label": "Rebates", "unit": "AUD ex GST"},
                {"key": "net_capex", "label": "Model Net CAPEX", "unit": "AUD ex GST"},
            ], rows),
            _result_set("solution.rebate_audit", "Saved rebate calculation audit", [
                {"key": "status", "label": "Status", "unit": None},
                {"key": "reason_codes", "label": "Reason codes", "unit": None},
                {"key": "certificate_quantity", "label": "Certificates", "unit": "certificates"},
                {"key": "unit_price", "label": "Certificate price", "unit": "AUD ex GST/certificate"},
                {"key": "rebate", "label": "Rebate", "unit": "AUD ex GST"},
                {"key": "rule_id", "label": "Rule", "unit": None},
                {"key": "rounding", "label": "Rounding", "unit": None},
                {"key": "operands", "label": "Saved operands", "unit": None},
            ], rebate_rows),
        ],
        boundaries=[
            f"Net CAPEX snapshot: {price_state.get('status', 'not_saved')}.",
            f"Device profile: {device_state.get('status', 'not_configured')}.",
            f"Rebate profile: {rebate_state.get('status', 'not_configured')}.",
            "Candidate generation is sorted by PV capacity, battery capacity, inverter capacity and scenario ID in ascending order; this is canonical storage order, not an economic ranking.",
            "The model-price preview rounds each equipment component, Gross CAPEX, approved rebate total and Net CAPEX to two decimal places.",
            "Legacy top-level AUD/kWp, AUD/kWh and AUD/kW price summaries in the device profile are not the active battery or inverter curve inputs for the current price preview; the selected equipment catalogue is authoritative.",
            "Draft, stale and suggested rebate values are shown as inactive working information. Only an approved rebate calculation profile may affect the saved Net CAPEX preview.",
            "Certificate eligibility is not guaranteed. Disabled or ineligible programs remain visible with zero value, reason codes, source provenance, saved operands and the active ruleset identity.",
            "The selected battery profile must be AC-coupled, while the current optimizer models PV-to-battery charging as a path that does not consume the shared AC port. This modelling boundary should be reviewed for project-specific topology.",
        ],
    )


def _scenario_module(
    feasibility_state: dict[str, object],
    tariff_replay_state: dict[str, object],
) -> dict[str, object]:
    physical = _mapping(feasibility_state.get("result"))
    tariff = _mapping(tariff_replay_state.get("result"))
    coverage = _mapping(physical.get("coverage"))
    parameters = [
        _parameter("scenario.coverage.interval_minutes", "Dispatch interval", coverage.get("interval_minutes"), unit="minutes", source_kind="evidence", source_label="Saved NEM12 coverage", source_path="feasibility.result.coverage.interval_minutes", edit_stage="evidence", editable=False),
        _parameter("scenario.coverage.interval_count", "Dispatch interval count", coverage.get("interval_count"), unit="intervals", source_kind="evidence", source_label="Saved NEM12 coverage", source_path="feasibility.result.coverage.interval_count", edit_stage="evidence", editable=False),
        _parameter("scenario.coverage.primary_year", "Primary analysis year", coverage.get("primary_year"), source_kind="derived", source_label="Physical feasibility result", source_path="feasibility.result.coverage.primary_year", edit_stage="evidence", editable=False),
    ]
    for key, label, value, unit in (
        ("algorithm_id", "Optimizer algorithm", "ci_peak_shaving_rolling_replay_v2", None),
        ("wear_shadow_cost", "Battery-discharge shadow cost", 0.05, "AUD/kWh discharged"),
        ("time_limit", "Scenario solver time limit", 120.0, "seconds"),
        (
            "highs_threads",
            "Rolling and multi-scenario HiGHS threads",
            1,
            "thread per solve",
        ),
        (
            "single_scenario_annual_planner_threads",
            "Single-scenario annual planner HiGHS threads",
            4,
            "threads",
        ),
        ("coordinator_threads", "Maximum parallel scenarios", 4, "scenarios"),
        ("request_watchdog", "Complete-analysis watchdog", 600.0, "seconds"),
        ("primary_tolerance", "Primary-objective tolerance", 0.01, "AUD"),
        ("materiality_tolerance", "Exact-replay materiality tolerance", 5.0, "AUD"),
        ("maximum_kva_cuts", "Maximum exact-kVA cut iterations", 24, "iterations"),
        ("pq_segments", "Conservative P-Q polygon segments", 16, "segments"),
        ("rolling_horizon", "Rolling planning horizon", 48, "hours"),
        ("rolling_commit", "Rolling commit horizon", 24, "hours"),
        ("idle_improvement_gate", "Minimum optimized-bill improvement", 0.005, "AUD"),
    ):
        parameters.append(
            _parameter(
                f"scenario.optimizer.{key}",
                label,
                value,
                unit=unit,
                source_kind="model_policy",
                source_label="Python optimizer contract",
                source_path="solar_battery/ci_peak_shaving_optimizer.py",
                edit_stage="tariff_replay",
                editable=False,
            )
        )
    calculations = [
        _calculation("scenario.interval_pv", "Unclipped interval PV energy", "PV_unclipped_kWh,t = normalized_shape_t * specific_yield * PV_kWp * derating", "Scales the repository solar shape to the saved system before inverter and shared-AC clipping.", ["normalized solar shape", "specific yield", "PV capacity", "derating"], "solar_battery/ci_design_feasibility.py::_scenario_energy_series"),
        _calculation("scenario.pv_clipping", "Delivered interval PV energy", "PV_delivered_kWh,t = min(PV_unclipped_kWh,t, inverter_kW * delta_t_hours, shared_AC_kW * delta_t_hours)", "The pre-tariff feasibility series records the energy that survives inverter and shared-connection clipping.", ["unclipped PV energy", "inverter capacity", "shared AC headroom", "interval duration"], "solar_battery/ci_design_feasibility.py::_scenario_energy_series"),
        _calculation("scenario.pv_to_load", "PV allocation", "PV_to_load = min(load_kWh, PV_kWh); surplus = max(0, PV_kWh - PV_to_load)", "Uses PV-first self-consumption in the pre-tariff feasibility pass.", ["measured load", "PV generation"], "solar_battery/ci_design_feasibility.py::_scenario_energy_series"),
        _calculation("scenario.pre_tariff_peak_target", "Technical peak-day target", "sampled_target_kW = min(theta in 51 samples from 0 to 1.1 * PV_only_peak_kW where post_import_kW[t] <= theta for every selected peak-day interval)", "This is a tariff-independent active-power stress test. The target is an upper bound, not an equality or an all-day smoothing objective: intervals above the feasible target may form a flat clipped section, while intervals already below it remain below it.", ["selected measured peak day", "PV-only import kW", "battery energy and power", "initial SOC", "shared AC headroom"], "solar_battery/ci_design_feasibility.py::_peak_day_envelope"),
        _calculation("scenario.soc_balance", "Battery SOC balance", "SOC[t+1] = SOC[t] + delta_t * eta * (grid_charge[t] + PV_charge[t]) - delta_t * discharge[t] / eta", "Maintains interval energy balance inside min and max SOC bounds and includes both permitted charging paths.", ["SOC start", "interval duration", "grid charge", "PV charge", "discharge", "symmetric one-way efficiency"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.grid_balance", "Grid active-power balance", "grid_import[t] = load[t] + grid_charge[t] + PV_export[t] - PV_to_AC[t] - discharge[t]", "Grid import is a non-negative decision variable. The allocation constraints prevent battery export and require exported PV to be part of PV sent to AC.", ["load", "grid charge", "PV export", "PV to AC", "battery discharge"], "solar_battery/ci_peak_shaving_optimizer.py::_solution"),
        _calculation("scenario.pv_export", "PV export constraints", "0 <= PV_export[t] <= PV_to_AC[t]; PV_to_AC[t] + discharge[t] - PV_export[t] <= load[t]", "Only PV may be exported under the current dispatch contract; battery discharge cannot supply export.", ["PV export", "PV to AC", "battery discharge", "load"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.pv_allocation", "Optimizer PV allocation", "PV_to_AC[t] + PV_charge[t] <= PV_available[t]", "PV charging is a separate DC-path variable in the optimizer and does not consume the shared AC port.", ["PV to AC", "PV charge", "available PV"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.shared_ac_port", "Shared AC-port power", "P_port[t] = PV_to_AC[t] + discharge[t] - grid_charge[t]; abs(P_port[t]) <= shared_AC_headroom_kW", "The headroom is bidirectional. The current optimizer excludes the PV-to-battery path from this AC-port expression.", ["PV to AC", "discharge", "grid charge", "shared AC headroom"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.reactive_balance", "Reactive import after support", "post_kvar = measured_kvar - inverter_reactive_support", "The saved inverter profile snapshot enables or disables support and supplies the per-inverter kvar capability; the Solution Generator scales that capability to each candidate PCS. Support cannot overcompensate measured reactive import. The physical reduction changes the bill only through an approved non-zero kVA demand rate.", ["measured kvar", "profile-scaled reactive support kvar", "approved kVA demand rate"], "solar_battery/ci_scenario_analysis.py::_execute_scenario"),
        _calculation("scenario.post_kva", "Post-system apparent demand", "post_kVA = sqrt(post_kW^2 + post_kvar^2)", "Produces the kVA series used by rolling and incentive demand charges.", ["post kW", "post kvar"], "solar_battery/ci_scenario_analysis.py::_execute_scenario"),
        _calculation("scenario.optimizer_objective", "Tariff-aware dispatch objective", "min sum_t(delta_t * (grid_import[t] * import_rate[t] - PV_export[t] * export_credit[t] + discharge[t] * 0.05)) + sum_{d: approved_demand_rate[d] > 0}(demand_peak[d] * demand_rate[d])", "Tariff replay re-optimizes dispatch from the saved scenario using approved rates. The export credit is currently fixed to zero and the AUD 0.05/kWh discharge term is a deterministic throughput tie-break, not a finance cashflow. A zero-rate demand component is omitted, so the optimizer does not reserve battery energy solely to lower that unpriced kVA peak; reactive support may still reduce physical kVA but creates no demand-charge value at a zero rate.", ["interval imports", "zero export credit", "battery discharge", "positive-rate approved demand components"], "solar_battery/ci_peak_shaving_optimizer.py::_model_bill"),
        _calculation("scenario.saved_result_reuse", "Saved-result reuse gate", "reuse = interval_SHA256_match AND design_SHA256_match AND tariff_SHA256_match AND calculation_revision_match AND result_SHA256_valid AND exact_requested_scenario_ID_set_match", "A repeated Analysis request returns the saved authoritative result without starting HiGHS only when every input identity, calculation revision, result digest and requested solution set matches. Any mismatch runs the full Python calculation again.", ["saved NEM12 digest", "saved design digest", "approved tariff digest", "calculation revision", "saved result digest", "selected solution IDs"], "solar_battery/ci_project_tariff_replay.py::reusable_ci_tariff_replay_result"),
        _calculation("scenario.pq_polygon", "Optimizer P-Q envelope", "for 16 segment normals: cos(theta_j) * P_port[t] + sin(theta_j) * Q_support[t] <= S_limit * cos(pi / 32)", "HiGHS uses a conservative 16-segment inner approximation of a circular inverter capability envelope; exact nonlinear replay verifies apparent power. The Q and S limits are scaled from the saved inverter profile snapshot, but the circular curve model itself remains an analyst assumption rather than a supplier P-Q curve.", ["shared-port active power", "reactive support", "profile-scaled apparent-power limit"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.demand_peak", "Demand-peak epigraph", "peak[d] >= minimum_chargeable[d] and peak[d] >= post_import_kW[t] or exact post_import_kVA[t] for every interval in priced demand window d", "This defines the smallest economically selected ceiling for a positive-rate demand component; it does not require every interval to equal the ceiling or minimise profile variance. Only binding peak intervals are expected to appear flat. kVA components start with linear bounds and receive tangent cuts until exact nonlinear replay is within the fixed materiality gate or the run fails closed.", ["priced demand window", "post-import kW/kVA", "minimum chargeable demand", "positive demand rate"], "solar_battery/ci_peak_shaving_optimizer.py::_build_model"),
        _calculation("scenario.peak_reduction", "Peak reduction", "peak_reduction = max(0, baseline_peak - post_system_peak)", "Reported for the saved measured coverage or billing period, depending on the result field.", ["baseline peak", "post-system peak"], "solar_battery/ci_design_feasibility.py::_performance_metrics"),
        _calculation("scenario.energy_reduction", "Grid import reduction", "reduction_kWh = max(0, baseline_import_kWh - post_import_kWh)", "Sums interval imports across the measured coverage.", ["baseline import", "post-system import"], "solar_battery/ci_design_feasibility.py::_energy_totals"),
        _calculation("scenario.self_consumption", "PV self-consumption", "100 * min(PV_generation, PV_direct + PV_to_battery) / PV_generation", "Measures the share of generated PV used directly or sent to the battery.", ["PV generation", "PV direct", "PV to battery"], "solar_battery/ci_design_feasibility.py::_energy_totals"),
        _calculation("scenario.cycles", "Equivalent full cycles", "EFC = battery_discharge_output_kWh / nominal_battery_kWh", "Coverage-period throughput indicator without degradation ageing.", ["battery discharge output", "nominal battery capacity"], "solar_battery/ci_design_feasibility.py::_energy_totals"),
        _calculation("scenario.scope2", "Operational Scope 2 estimate", "tCO2-e = grid_import_kWh * emissions_factor / 1000", "Calculated only when a positive approved emissions factor is saved.", ["grid import", "emissions factor"], "solar_battery/ci_design_feasibility.py::_energy_totals"),
        _calculation("scenario.tariff_value", "First-year tariff value", "first_year_value = baseline_annual_cost - scenario_annual_cost", "Uses the approved representative-year tariff replay.", ["baseline cost", "scenario cost"], "solar_battery/ci_scenario_analysis.py::_annual_tariff_value"),
    ]
    feasibility_rows = []
    for row in _list_of_mappings(physical.get("scenarios")):
        energy = _mapping(row.get("coverage_energy"))
        performance = _mapping(row.get("coverage_performance"))
        peak_day = _mapping(row.get("peak_day"))
        feasibility_rows.append({
            "result_id": str(row.get("scenario_id", "")),
            "label": str(row.get("label") or row.get("scenario_id") or "Scenario"),
            "values": {
                "rank": row.get("physical_review_rank"),
                "grid_import_reduction": energy.get("grid_import_reduction_kwh"),
                "peak_reduction": performance.get("grid_import_peak_reduction_kw"),
                "self_consumption": energy.get("pv_self_consumption_percent"),
                "equivalent_cycles": energy.get("battery_equivalent_full_cycles"),
                "peak_day_reduction": peak_day.get("peak_reduction_kw"),
            },
        })
    tariff_rows = []
    optimizer_rows = []
    for row in _list_of_mappings(tariff.get("scenarios")):
        dispatch = _mapping(row.get("post_dispatch"))
        value = _mapping(row.get("annual_tariff_value"))
        tariff_rows.append({
            "result_id": str(row.get("scenario_id", "")),
            "label": str(row.get("label") or row.get("scenario_id") or "Scenario"),
            "values": {
                "rank": row.get("physical_review_rank"),
                "rolling_demand": dispatch.get("raw_rolling_demand_kva"),
                "chargeable_demand": dispatch.get("chargeable_rolling_demand_kva"),
                "pv_generation": dispatch.get("pv_generation_kwh"),
                "maximum_reactive_support": dispatch.get("maximum_reactive_support_kvar"),
                "annual_cost": value.get("scenario_cost_ex_gst_aud"),
                "first_year_value": value.get("first_year_value_ex_gst_aud"),
            },
        })
        snapshot = _mapping(row.get("optimizer_run_snapshot"))
        if snapshot:
            input_projection = _mapping(snapshot.get("input_projection"))
            physical_assumptions = _mapping(snapshot.get("physical_assumptions"))
            result_projection = _mapping(snapshot.get("result_projection"))
            dispatch_totals = _mapping(result_projection.get("dispatch_totals"))
            optimizer_rows.append({
                "result_id": str(row.get("scenario_id", "")),
                "label": str(row.get("label") or row.get("scenario_id") or "Scenario"),
                "values": {
                    "contract_version": snapshot.get("contract_version"),
                    "algorithm_id": snapshot.get("algorithm_id"),
                    "solver_version": snapshot.get("solver_version"),
                    "status": snapshot.get("status"),
                    "planner_status": snapshot.get("planner_status"),
                    "snapshot_sha256": snapshot.get("snapshot_sha256"),
                    "scenario_sha256": input_projection.get("scenario_sha256"),
                    "tariff_profile_sha256": input_projection.get("tariff_profile_sha256"),
                    "interval_inputs_sha256": input_projection.get("interval_inputs_sha256"),
                    "interval_count": result_projection.get("interval_count"),
                    "window_count": result_projection.get("window_count"),
                    "shared_ac_headroom": physical_assumptions.get("shared_ac_headroom_kw"),
                    "allow_grid_charging": physical_assumptions.get("allow_grid_charging"),
                    "battery_assumptions": _display_mapping(physical_assumptions.get("battery")),
                    "reactive_assumptions": _display_mapping(physical_assumptions.get("reactive_support")),
                    "grid_import": dispatch_totals.get("grid_import_kwh"),
                    "pv_export": dispatch_totals.get("pv_export_kwh"),
                    "grid_charge": dispatch_totals.get("grid_charge_kwh"),
                    "pv_charge": dispatch_totals.get("pv_charge_kwh"),
                    "discharge": dispatch_totals.get("discharge_kwh"),
                    "idle_bill": result_projection.get("idle_baseline_bill_aud"),
                    "exact_bill": result_projection.get("exact_replay_bill_aud"),
                    "exactness_gap": result_projection.get("optimization_exactness_gap_aud"),
                    "bill_reconciliation": result_projection.get("bill_reconciliation_difference_aud"),
                    "corrections": _joined_values(snapshot.get("corrections")),
                    "disclosures": _joined_values(snapshot.get("disclosures")),
                    "customer_facing_permission": snapshot.get("customer_facing_permission"),
                    "recommendation_permitted": snapshot.get("recommendation_permitted"),
                },
            })
    status = _combined_scenario_status(feasibility_state, tariff_replay_state)
    return _module(
        "scenario_analysis",
        "Scenario Analysis",
        "Physical dispatch, peak demand, reactive support and tariff replay.",
        status=status,
        saved_at=tariff_replay_state.get("saved_at") or feasibility_state.get("saved_at"),
        parameters=parameters,
        calculations=calculations,
        models=[
            _model("scenario.pre_tariff_dispatch", "Pre-tariff feasibility dispatch", "PV-first self-consumption plus sampled peak-day active-kW envelope", "Test technical peak shaving and rank measured-coverage physical performance before any customer-dollar meaning.", ["The selected target is the lowest feasible of 51 sampled active-kW ceilings on the selected measured peak day.", "A ceiling is an upper bound, not an equality: only intervals that would exceed it are shaved toward it.", "Grid charging is disabled in the pre-tariff energy review.", "Ranking prioritises import-energy reduction, peak reduction and top-event coverage."], "solar_battery/ci_design_feasibility.py"),
            _model("scenario.highs_dispatch", "Tariff-aware optimizer", "HiGHS LP first; rerun as MILP if simultaneous charging and discharging is detected; then exact nonlinear rolling replay", "Re-optimize each saved scenario to minimise approved interval import and positive-rate demand charges, zero-valued exports and the fixed discharge shadow cost while satisfying interval energy, SOC, power, demand and P-Q constraints.", ["48-hour planning horizon with 24-hour commits; December look-ahead wraps the same representative year's January without billing wrapped rows twice.", "The representative year begins and ends at the saved 100% initial SOC basis, and each rolling boundary must preserve at least the annual planner's feasible SOC.", "Grid charge plus PV charge cannot exceed battery charge power; discharge cannot exceed battery discharge power; charge and discharge modes are made mutually exclusive in the MILP fallback.", "Demand ceilings are upper bounds, not a requirement to flatten every interval.", "Demand components with an approved rate of zero are not planner objectives; physical post-dispatch peaks remain reportable but do not receive an authored economic ceiling.", "Reactive support reduces post-dispatch kvar and kVA subject to the shared P-Q capability, but affects bill value only when an approved kVA demand rate is positive.", "The shared AC port is bidirectional and excludes the separately modelled PV-to-battery path.", "A conservative 16-segment P-Q polygon and iterative kVA tangent cuts are verified by exact nonlinear replay. Interval P-Q rows are omitted only when the variable bounds prove every polygon facet is redundant; fixed-limit rolling windows then use the equivalent exact residual-kvar active-power bound.", "The annual planner uses its exact-replay-validated primary optimum only as feasible demand-ceiling and SOC seeds, so it omits the non-authoritative full-year throughput tie-break; every final 48-hour rolling window retains the two-stage AUD 0.01 throughput tie-break and deterministic primal-simplex basis reuse.", "Each selected request runs in a disposable coordinator process. Battery scenarios use at most four coordinator threads, bounded by the selected battery-scenario count; every model in a multi-battery request stays at one HiGHS thread with parallel mode disabled. When exactly one battery scenario is requested, only its non-authoritative primary annual LP planner uses four-thread PAMI, then the process-global HiGHS scheduler is reset before the authoritative 48-hour rolling windows resume one-thread parallel-off solves. PV-only rows run inline, mutable caches remain isolated, final results retain authored order and no nested process pool is created.", "Primary tolerance is AUD 0.01, exact-replay materiality is AUD 5, and maximum kVA refinement is 24 iterations. The 120-second limit applies to each HiGHS solve; production applies a separate 600-second hard deadline to the entire physical-analysis request and terminates the disposable coordinator directly, or its process group when supported, on expiry. Any coordinator-thread failure discards the request result and fails closed.", "If the optimized exact bill fails to improve the idle bill by AUD 0.005, the saved dispatch falls back to idle."], "solar_battery/ci_peak_shaving_optimizer.py::execute_ci_peak_shaving_rolling"),
            _model("scenario.physical_ranking", "Physical review order", "Deterministic multi-key sort", "Pre-tariff: highest import reduction, then peak and event coverage. Tariff replay: lowest post-dispatch raw rolling kVA, then smaller capacities.", ["The order is an internal review order, not a customer recommendation."], "solar_battery/ci_design_feasibility.py and solar_battery/ci_scenario_analysis.py"),
        ],
        result_sets=[
            _result_set("scenario.feasibility", "Saved physical feasibility", [
                {"key": "rank", "label": "Rank", "unit": None},
                {"key": "grid_import_reduction", "label": "Import reduction", "unit": "kWh"},
                {"key": "peak_reduction", "label": "Peak reduction", "unit": "kW"},
                {"key": "self_consumption", "label": "PV self-consumption", "unit": "%"},
                {"key": "equivalent_cycles", "label": "Battery EFC", "unit": "cycles"},
                {"key": "peak_day_reduction", "label": "Peak-day reduction", "unit": "kW"},
            ], feasibility_rows),
            _result_set("scenario.tariff_replay", "Saved tariff replay", [
                {"key": "rank", "label": "Rank", "unit": None},
                {"key": "rolling_demand", "label": "Rolling demand", "unit": "kVA"},
                {"key": "chargeable_demand", "label": "Chargeable demand", "unit": "kVA"},
                {"key": "pv_generation", "label": "PV generation", "unit": "kWh"},
                {"key": "maximum_reactive_support", "label": "Max reactive support", "unit": "kvar"},
                {"key": "annual_cost", "label": "Annual cost", "unit": "AUD ex GST"},
                {"key": "first_year_value", "label": "First-year value", "unit": "AUD ex GST"},
            ], tariff_rows),
            _result_set("scenario.optimizer_runs", "Saved optimizer run snapshots", [
                {"key": "contract_version", "label": "Snapshot contract", "unit": None},
                {"key": "algorithm_id", "label": "Algorithm", "unit": None},
                {"key": "solver_version", "label": "HiGHS version", "unit": None},
                {"key": "status", "label": "Run status", "unit": None},
                {"key": "planner_status", "label": "Planner status", "unit": None},
                {"key": "snapshot_sha256", "label": "Snapshot SHA-256", "unit": None},
                {"key": "scenario_sha256", "label": "Scenario SHA-256", "unit": None},
                {"key": "tariff_profile_sha256", "label": "Tariff SHA-256", "unit": None},
                {"key": "interval_inputs_sha256", "label": "Interval-input SHA-256", "unit": None},
                {"key": "interval_count", "label": "Intervals", "unit": "intervals"},
                {"key": "window_count", "label": "Rolling windows", "unit": "windows"},
                {"key": "shared_ac_headroom", "label": "Shared AC headroom", "unit": "kW"},
                {"key": "allow_grid_charging", "label": "Grid charging", "unit": None},
                {"key": "battery_assumptions", "label": "Battery operands", "unit": None},
                {"key": "reactive_assumptions", "label": "Reactive operands", "unit": None},
                {"key": "grid_import", "label": "Grid import", "unit": "kWh"},
                {"key": "pv_export", "label": "PV export", "unit": "kWh"},
                {"key": "grid_charge", "label": "Grid charge", "unit": "kWh"},
                {"key": "pv_charge", "label": "PV charge", "unit": "kWh"},
                {"key": "discharge", "label": "Battery discharge", "unit": "kWh"},
                {"key": "idle_bill", "label": "Idle objective", "unit": "AUD"},
                {"key": "exact_bill", "label": "Exact replay objective", "unit": "AUD"},
                {"key": "exactness_gap", "label": "Optimization exactness gap", "unit": "AUD"},
                {"key": "bill_reconciliation", "label": "Bill reconciliation difference", "unit": "AUD"},
                {"key": "corrections", "label": "Corrections", "unit": None},
                {"key": "disclosures", "label": "Disclosures", "unit": None},
                {"key": "customer_facing_permission", "label": "Customer-facing permission", "unit": None},
                {"key": "recommendation_permitted", "label": "Recommendation permitted", "unit": None},
            ], optimizer_rows),
        ],
        boundaries=[
            f"Physical feasibility snapshot: {feasibility_state.get('status', 'not_saved')}.",
            f"Tariff replay snapshot: {tariff_replay_state.get('status', 'not_saved')}.",
            "The pre-tariff peak-day view is a technical active-kW envelope. Tariff replay is a separate annual optimization of the same saved scenario against approved tariff windows and rates, including kVA where applicable.",
            "A demand ceiling is an upper bound, not an all-day flattening target. With a zero approved demand rate, the optimizer has no bill incentive to reserve battery energy for that kVA peak; reactive support may still reduce physical kVA but cannot create demand-charge savings.",
            "Saved results become stale when evidence, design candidates or the approved tariff changes.",
        ],
    )


def _finance_module(
    *,
    tariff_profile_state: dict[str, object],
    rebate_profile_state: dict[str, object],
    tariff_replay_state: dict[str, object],
    annual_financial_state: dict[str, object],
    device_profile_state: dict[str, object],
) -> dict[str, object]:
    finance = _mapping(annual_financial_state.get("result"))
    assumptions = _mapping(finance.get("assumptions"))
    finance_solutions = _list_of_mappings(finance.get("solutions"))
    tariff_result = _mapping(tariff_replay_state.get("result"))
    tariff_scenarios = _list_of_mappings(tariff_result.get("scenarios"))
    tariff_status = str(tariff_profile_state.get("status") or "not_available")
    tariff_state_profile = _mapping(tariff_profile_state.get("profile"))
    suggested_tariff_profile = _mapping(tariff_profile_state.get("suggested_profile"))
    tariff_profile = tariff_state_profile or suggested_tariff_profile
    tariff_profile_path = (
        "tariff_profile_state.profile"
        if tariff_state_profile
        else "tariff_profile_state.suggested_profile"
    )
    tariff_approved = tariff_status == "approved" and bool(tariff_state_profile)
    tariff_source_kind = (
        "approved_assumption"
        if tariff_approved
        else "working_copy"
        if tariff_state_profile
        else "suggested_assumption"
    )
    tariff_source_label = (
        "Approved tariff profile"
        if tariff_approved
        else "Saved tariff working copy"
        if tariff_state_profile
        else "Bill-derived suggested tariff"
    )
    rates = _mapping(tariff_profile.get("rates"))
    factors = _mapping(tariff_profile.get("factors"))
    parameters: list[dict[str, object]] = [
        _parameter(
            "finance.tariff.approval_status",
            "Tariff profile status",
            tariff_status,
            source_kind="approval_state",
            source_label="Project tariff profile state",
            source_path="tariff_profile_state.status",
            edit_stage="evidence",
            editable=False,
            active=False,
        ),
        _parameter(
            "finance.provenance.source_tariff_replay_sha256",
            "Source tariff replay SHA-256",
            finance.get("source_tariff_replay_sha256"),
            source_kind="provenance",
            source_label="Saved annual finance result",
            source_path="annual_financial.result.source_tariff_replay_sha256",
            edit_stage="tariff_replay",
            editable=False,
            active=annual_financial_state.get("status") == "ready",
        ),
    ]
    for key, label, unit in (
        ("discount_rate", "Discount rate", "fraction/year"),
        ("annual_value_escalation_rate", "Annual value escalation", "fraction/year"),
        ("annual_value_degradation_rate", "Annual value degradation", "fraction/year"),
        ("annual_om_fraction_of_capex", "Annual O&M fraction", "fraction/year"),
        ("analysis_term_years", "Analysis term", "years"),
        ("price_source", "Solution price source", None),
        ("rebate_application_basis", "Rebate application basis", None),
    ):
        parameters.append(_parameter(f"finance.assumption.{key}", label, assumptions.get(key), unit=unit, source_kind="analyst_input" if key not in {"price_source", "rebate_application_basis"} else "model_policy", source_label="Saved annual finance result", source_path=f"annual_financial.result.assumptions.{key}", edit_stage="tariff_replay"))
    one_click_fallbacks = (
        ("discount_rate", "One-click fallback discount rate", 0.08, "fraction/year"),
        ("annual_value_escalation_rate", "One-click fallback annual value escalation", 0.025, "fraction/year"),
        ("annual_value_degradation_rate", "One-click fallback annual value degradation", 0.005, "fraction/year"),
        ("annual_om_fraction_of_capex", "One-click fallback annual O&M fraction", 0.015, "fraction/year"),
        ("analysis_term_years", "One-click fallback analysis term", 15, "years"),
    )
    one_click_fallback_active = (
        assumptions.get("price_source")
        == "analyst_entered_total_solution_price"
        and all(assumptions.get(key) == value for key, _label, value, _unit in one_click_fallbacks)
    )
    for key, label, value, unit in one_click_fallbacks:
        parameters.append(
            _parameter(
                f"finance.one_click_fallback.{key}",
                label,
                value,
                unit=unit,
                source_kind="model_default",
                source_label="Python annual-finance fallback",
                source_path=(
                    "solar_battery/ci_annual_financial_comparison.py"
                    f"::_validated_assumptions.{key}"
                ),
                edit_stage="tariff_replay",
                editable=False,
                active=one_click_fallback_active,
            )
        )
    for key, label, unit in (
        ("mlf", "Marginal loss factor", None),
        ("dlf", "Distribution loss factor", None),
    ):
        parameters.append(_parameter(f"finance.tariff.factor.{key}", label, factors.get(key), unit=unit, source_kind=tariff_source_kind, source_label=tariff_source_label, source_path=f"{tariff_profile_path}.factors.{key}", edit_stage="evidence", active=tariff_approved))
    for key, label, unit in (
        ("retail_peak_c_per_kwh", "Retail peak energy rate", "c/kWh"),
        ("retail_off_peak_c_per_kwh", "Retail off-peak energy rate", "c/kWh"),
        ("incentive_demand_aud_per_kva_month", "Incentive demand rate", "AUD/kVA/month"),
        ("rolling_demand_aud_per_kva_month", "Rolling demand rate", "AUD/kVA/month"),
        ("network_peak_c_per_kwh", "Network peak energy rate", "c/kWh"),
        ("network_off_peak_c_per_kwh", "Network off-peak energy rate", "c/kWh"),
        ("aemo_ancillary_c_per_kwh", "AEMO ancillary rate", "c/kWh"),
        ("aemo_participant_c_per_kwh", "AEMO participant rate", "c/kWh"),
        ("aemo_frc_c_per_day", "AEMO FRC rate", "c/day"),
        ("environmental_c_per_kwh", "Environmental certificate rate", "c/kWh"),
        ("environmental_certificate_fraction", "Environmental certificate fraction", "fraction"),
        ("metering_aud_per_day", "Metering rate", "AUD/day"),
        ("value_added_c_per_day", "Value-added service rate", "c/day"),
    ):
        parameters.append(_parameter(f"finance.tariff.rate.{key}", label, rates.get(key), unit=unit, source_kind=tariff_source_kind, source_label=tariff_source_label, source_path=f"{tariff_profile_path}.rates.{key}", edit_stage="evidence", active=tariff_approved))
    for key, label, unit in (
        ("minimum_chargeable_rolling_kva", "Minimum chargeable rolling demand", "kVA"),
        ("gst_rate", "GST rate", "fraction"),
        ("additional_bill_adjustment_aud", "Bill-only reconciliation adjustment", "AUD ex GST"),
    ):
        parameters.append(
            _parameter(
                f"finance.tariff.{key}",
                label,
                tariff_profile.get(key),
                unit=unit,
                source_kind=tariff_source_kind,
                source_label=tariff_source_label,
                source_path=f"{tariff_profile_path}.{key}",
                edit_stage="evidence",
                active=tariff_approved and key != "additional_bill_adjustment_aud",
            )
        )
    windows = _mapping(tariff_profile.get("windows"))
    for key, label in (
        ("retail_energy", "Retail peak window"),
        ("network_energy", "Network peak window"),
        ("rolling_demand", "Rolling demand window"),
        ("incentive_demand", "Incentive demand window"),
    ):
        parameters.append(
            _parameter(
                f"finance.tariff.window.{key}",
                label,
                _window_text(_mapping(windows.get(key))),
                source_kind=tariff_source_kind,
                source_label=tariff_source_label,
                source_path=f"{tariff_profile_path}.windows.{key}",
                edit_stage="evidence",
                active=tariff_approved,
            )
        )
    calculations = [
        _calculation("finance.annual_energy_quantities", "Representative-year energy quantities", "import_kWh = sum(interval_import_kW * 0.25); peak_kWh = sum(import_kW * 0.25 where interval is inside the approved workday window); off_peak_kWh = import_kWh - peak_kWh", "The current annual replay expects 15-minute rows and repeats the evidence-bound analysis year. Retail classification uses the tariff meter basis; network and demand windows use the saved local-time mapping.", ["15-minute post-dispatch kW", "approved windows", "excluded dates"], "solar_battery/ci_scenario_analysis.py::_annual_tariff_quantities"),
        _calculation("finance.annual_demand_quantities", "Representative-year demand quantities", "rolling_quantity = max(max_window_kVA, minimum_chargeable_kVA) * 12; incentive_quantity = sum(monthly_max_window_kVA for approved months)", "Rolling and incentive quantities are calculated separately for baseline and post-dispatch apparent demand. Each annual demand quantity is rounded to two decimals before multiplying its monthly rate.", ["15-minute kVA", "demand windows", "minimum chargeable demand", "incentive months"], "solar_battery/ci_scenario_analysis.py::_annual_tariff_quantities"),
        _calculation("finance.energy_charge", "Retail energy charge", "charge = kWh * rate_c_per_kWh / 100 * MLF * DLF", "Calculated separately for peak and off-peak retail energy.", ["energy quantity", "retail rate", "MLF", "DLF"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.network_energy_charge", "Network energy charge", "charge = network_window_kWh * network_rate_c_per_kWh / 100", "Calculated separately for peak and off-peak network windows; MLF and DLF are not applied to these network energy lines.", ["network energy quantity", "network rate"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.demand_charge", "Demand charge", "incentive_charge = round2(incentive_quantity_kVA) * incentive_AUD_per_kVA_month; rolling_charge = round2(rolling_quantity_kVA) * rolling_AUD_per_kVA_month", "For annual replay, the rolling quantity already contains twelve months and the incentive quantity is the sum of approved monthly maxima.", ["rolling quantity", "incentive quantity", "demand rates"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.regulated_charge", "Regulated charges", "ancillary = import_kWh * ancillary_c_per_kWh / 100 * DLF; participant = import_kWh * participant_c_per_kWh / 100 * DLF; FRC = days * FRC_c_per_day / 100", "MLF is not applied to regulated charge lines in the current implementation.", ["import energy", "regulated rates", "DLF", "days"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.environmental_charge", "Environmental charges", "charge_i = import_kWh * rate_i_c_per_kWh / 100 * certificate_fraction_i * DLF", "Each saved environmental line is priced separately and then rounded to invoice cents.", ["import energy", "environmental rate", "certificate fraction", "DLF"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.metering_charge", "Metering charges", "metering = days * AUD_per_day; value_added = days * c_per_day / 100", "Uses inclusive calendar-day count for the representative analysis period.", ["analysis days", "daily rates"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.tariff_total", "Tariff total", "subtotal_ex_GST = sum(round_half_up(each charge line, 2)); GST = sum(round_half_up(each line * GST_rate, 2)); total = subtotal + GST", "The scenario annual replay sets include_bill_adjustment=False and export credit is currently zero, so the bill-only adjustment and exported energy do not create scenario value.", ["charge lines", "GST rate"], "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
        _calculation("finance.tariff_replay_provenance", "Tariff replay provenance", "finance.source_tariff_replay_sha256 = SHA256(saved_tariff_replay); finance.scenario_id and first_year_value = matching tariff_replay.scenario_id and annual_tariff_value", "Finance strictly consumes the saved tariff-aware optimized replay. Persistence fails closed when its embedded source digest differs from the saved replay digest, and every financial row must retain the matching scenario ID and tariff-derived annual value.", ["saved tariff replay", "tariff replay SHA-256", "scenario ID", "tariff-derived first-year value"], "solar_battery/ci_annual_financial_comparison.py::compare_ci_annual_financial_scenarios and solar_battery/ci_project_annual_financial.py::_validate_result"),
        _calculation("finance.first_year_value", "First-year tariff value", "first_year_value_ex_GST = baseline_annual_cost_ex_GST - optimized_post_dispatch_annual_cost_ex_GST", "Uses the baseline total and the matching scenario's stored tariff-aware optimized annual total; it is not a generic retail-bill estimate or the pre-tariff technical peak-day result.", ["baseline annual tariff total", "optimized post-dispatch annual tariff total"], "solar_battery/ci_scenario_analysis.py::_annual_tariff_value", example=_tariff_value_example(tariff_scenarios)),
        _calculation("finance.manual_quote", "Manual quote as final Net CAPEX", "gross_upfront_cost = upfront_cost = entered_quoted_Net_CAPEX; upfront_rebate = 0", "In the current one-click Analysis path, pricing_mode is manual_quotes. The saved theoretical rebate audit remains visible, but Python deliberately does not subtract it from an already-net quotation.", ["selected solution quote"], "solar_battery/ci_annual_financial_comparison.py::compare_ci_annual_financial_scenarios", example=_manual_quote_example(finance_solutions, assumptions)),
        _calculation("finance.one_click_assumptions", "One-click finance fallback", "when omitted in manual_quotes mode: discount=8%; escalation=2.5%; degradation=0.5%; O&M=1.5%; term=15 years", "The current one-click Analysis request sends selected quoted Net CAPEX values but no finance assumption fields. Python therefore applies these fixed fallbacks. Device-profile finance defaults are used only in device_profile pricing mode.", ["pricing mode", "optional finance request fields"], "solar_battery/ci_annual_financial_comparison.py::_validated_assumptions", example=_assumption_example(assumptions)),
        _calculation("finance.annual_om", "Annual O&M", "annual_O&M = gross_upfront_cost * annual_O&M_fraction", "In manual quote mode, gross_upfront_cost equals the entered Net CAPEX quote. O&M remains constant in nominal AUD across the current annual cashflow model.", ["gross upfront cost", "O&M fraction"], "solar_battery/ci_annual_financial_comparison.py::_financial_solution", example=_annual_om_example(finance_solutions, assumptions)),
        _calculation("finance.year_cashflow", "Annual cashflow", "CF_y = value_1 * (1 + escalation)^(y-1) * (1 - degradation)^(y-1) - annual_O&M - replacements_y", "Builds one annual cashflow for each year of the analysis term. Current comparison supplies an empty replacement-event list and rounds displayed annual cashflows to cents.", ["first-year value", "escalation", "degradation", "O&M", "replacement events"], "solar_battery/ci_financial_solutions.py::calculate_metrics", example=_cashflow_example(finance_solutions, assumptions)),
        _calculation("finance.npv", "Net present value", "NPV = sum(CF_y / (1 + discount_rate)^y), including CF_0 = -Net_CAPEX", "Discounts all project cashflows to year zero and rounds the saved result to cents.", ["cashflows", "discount rate"], "solar_battery/ci_financial_solutions.py::calculate_metrics", example=_metric_example(finance_solutions, "net_present_value_aud", "AUD", "saved NPV")),
        _calculation("finance.payback", "Simple payback period", "payback = prior_year + (-cumulative_before / current_year_cashflow)", "Uses undiscounted cashflow and linear interpolation within the crossing year. The saved result is rounded to three decimals and is null if cumulative cashflow never reaches zero within the term.", ["annual undiscounted cashflows"], "solar_battery/ci_financial_solutions.py::_payback_years", example=_metric_example(finance_solutions, "payback_period_years", "years", "saved simple payback")),
        _calculation("finance.irr", "Internal rate of return", "find r where sum(CF_y / (1 + r)^y) = 0", "Uses bisection from -99.9999% to 1000% for up to 120 iterations; returns null if no bracketed root exists and does not resolve multiple-root ambiguity. The saved result is rounded to six decimals.", ["cashflows"], "solar_battery/ci_financial_solutions.py::_irr", example=_metric_example(finance_solutions, "internal_rate_of_return", "fraction", "saved IRR")),
        _calculation("finance.lifetime_value", "Undiscounted lifetime net value", "lifetime_net_value = sum(CF_0 ... CF_N)", "Shows nominal total value without time-value discounting and rounds the saved result to cents.", ["all cashflows"], "solar_battery/ci_financial_solutions.py::calculate_metrics", example=_metric_example(finance_solutions, "lifetime_net_value_undiscounted_aud", "AUD", "saved undiscounted lifetime value")),
        _calculation("finance.roi", "Return on investment (ROI)", "undefined in the current authoritative model", "ROI is not calculated or persisted; do not infer it from NPV, IRR or lifetime value.", ["not implemented"], "solar_battery/ci_financial_solutions.py::calculate_metrics"),
        _calculation("finance.lcoe", "Levelised cost of energy (LCOE)", "undefined in the current authoritative model", "LCOE is not calculated because the current finance contract has no discounted lifetime generation-cost denominator model.", ["not implemented"], "solar_battery/ci_financial_solutions.py::calculate_metrics"),
        _calculation("finance.lcos", "Levelised cost of storage (LCOS)", "undefined in the current authoritative model", "LCOS is not calculated because the current finance contract has no discounted battery throughput and replacement-cost denominator model.", ["not implemented"], "solar_battery/ci_financial_solutions.py::calculate_metrics"),
    ]
    rows = []
    for row in finance_solutions:
        metrics = _mapping(row.get("metrics"))
        rows.append({
            "result_id": str(row.get("scenario_id", "")),
            "label": str(row.get("label") or row.get("scenario_id") or "Scenario"),
            "values": {
                "rank": row.get("financial_review_rank"),
                "net_capex": row.get("upfront_cost_aud_ex_gst"),
                "gross_upfront": row.get("gross_upfront_cost_aud_ex_gst"),
                "upfront_rebate": row.get("upfront_rebate_aud_ex_gst"),
                "rebate_status": row.get("rebate_application_status"),
                "first_year_value": row.get("first_year_value_aud_ex_gst"),
                "annual_om": row.get("annual_om_cost_aud_ex_gst"),
                "npv": metrics.get("net_present_value_aud"),
                "irr": metrics.get("internal_rate_of_return"),
                "payback": metrics.get("payback_period_years"),
                "lifetime_value": metrics.get("lifetime_net_value_undiscounted_aud"),
                "annual_cashflows": metrics.get("annual_cashflows_aud"),
            },
        })
    return _module(
        "finance_analysis",
        "Finance Analysis",
        "Tariff charges, annual value, cashflows and investment metrics.",
        status=str(annual_financial_state.get("status") or "not_saved"),
        saved_at=annual_financial_state.get("saved_at"),
        parameters=parameters,
        calculations=calculations,
        models=[
            _model("finance.tariff_replay", "Representative-year tariff model", "Evidence-bound tariff-aware optimized interval replay", "Consume the matching saved scenario's optimized annual interval quantities and price baseline and post-dispatch quantities with the active approved tariff.", ["The embedded source_tariff_replay_sha256 must match the saved tariff replay digest or the finance result fails closed.", "Scenario IDs and first-year values are inherited from the matching tariff replay row, not recomputed from the pre-tariff technical envelope.", "Reactive support changes finance only through reduced kVA multiplied by a positive approved demand rate; a zero rate produces zero demand-charge saving.", "Export credit is currently zero in dispatch and tariff value.", "Source-bill adjustment is excluded from scenario annual replay.", "The same tariff rates are used for baseline and scenario; future tariff changes and category-specific escalation are not modelled.", "Demand and tariff claims remain internal until evidence gates pass."], "solar_battery/ci_scenario_analysis.py::_annual_tariff_value and solar_battery/ci_project_annual_financial.py"),
            _model("finance.discounted_cashflow", "Discounted cashflow model", "Nominal annual cashflows with NPV, IRR and simple payback", "Combine saved Net CAPEX, tariff value, O&M, escalation, degradation and replacement events across the selected term.", ["Current comparison stores no replacement events.", "O&M is flat nominal AUD and is not escalated.", "Taxes, financing, depreciation, residual value, insurance, development costs and battery replacement or ageing are not modelled in this comparison."], "solar_battery/ci_financial_solutions.py::calculate_metrics"),
            _model("finance.review_order", "Financial review order", "Highest NPV, then shorter payback, lower Net CAPEX, physical rank and scenario ID", "Creates a deterministic internal comparison order.", ["Null payback sorts after finite payback.", "The leader is not a customer recommendation."], "solar_battery/ci_annual_financial_comparison.py::compare_ci_annual_financial_scenarios"),
        ],
        result_sets=[_result_set("finance.solutions", "Saved financial comparison", [
            {"key": "rank", "label": "Rank", "unit": None},
            {"key": "net_capex", "label": "Net CAPEX", "unit": "AUD ex GST"},
            {"key": "gross_upfront", "label": "Finance gross upfront", "unit": "AUD ex GST"},
            {"key": "upfront_rebate", "label": "Finance rebate deduction", "unit": "AUD ex GST"},
            {"key": "rebate_status", "label": "Rebate application", "unit": None},
            {"key": "first_year_value", "label": "First-year value", "unit": "AUD ex GST"},
            {"key": "annual_om", "label": "Annual O&M", "unit": "AUD ex GST/year"},
            {"key": "npv", "label": "NPV", "unit": "AUD"},
            {"key": "irr", "label": "IRR", "unit": "fraction"},
            {"key": "payback", "label": "Payback", "unit": "years"},
            {"key": "lifetime_value", "label": "Lifetime net value", "unit": "AUD"},
            {"key": "annual_cashflows", "label": "Annual cashflows", "unit": "AUD/year"},
        ], rows)],
        boundaries=[
            f"Tariff profile: {tariff_profile_state.get('status', 'not_configured')}.",
            f"Rebate profile: {rebate_profile_state.get('status', 'not_configured')}.",
            f"Tariff replay snapshot: {tariff_replay_state.get('status', 'not_saved')}.",
            f"Annual finance snapshot: {annual_financial_state.get('status', 'not_saved')}.",
            f"Device profile: {device_profile_state.get('status', 'not_configured')}.",
            "Scenario IDs are the provenance join from generated candidate to tariff replay, quoted Net CAPEX and annual finance result; the Handbook only projects saved rows and never repairs a missing join.",
            "Finance is bound to the exact saved tariff replay by source_tariff_replay_sha256 and consumes that replay's tariff-aware optimized annual value. A changed or mismatched replay makes the financial result invalid or stale.",
            "The pre-tariff technical active-kW peak target is not a finance input. kVA reductions from battery dispatch or reactive support change demand charges only when the matching approved demand rate is greater than zero.",
            "The current one-click Analysis flow uses manual quote mode and omits finance inputs, so its authoritative fallback is 8% discount, 2.5% value escalation, 0.5% value degradation, 1.5% annual O&M and 15 years.",
            "Manual quotations are already final Net CAPEX. The calculated rebate audit remains attached for traceability, while upfront_rebate_aud_ex_gst is zero to prevent a second deduction.",
            "Certificate prices and tariff rates are deterministic point assumptions. Expiry, price volatility, Monte Carlo uncertainty and future rules or tariff structures are not modelled.",
            "Suggested, draft and stale tariff fields are displayed as inactive working values. Only the current approved tariff calculation profile is authoritative for tariff replay and customer-dollar outputs.",
            "ROI, LCOE and LCOS have no current Python definition or persisted result. Only NPV, simple payback, IRR and undiscounted lifetime net value are authoritative finance metrics.",
            "All customer-dollar, demand-charge and recommendation claims remain internal and fail closed unless their evidence-bound saved states are ready.",
        ],
    )


def _profile_snapshot_parameters(
    *,
    solar: dict[str, object],
    battery: dict[str, object],
    inverter: dict[str, object],
) -> list[dict[str, object]]:
    """Expose the immutable operands captured with a generated design.

    The library profile can change later, so calculations must be explained from
    these embedded snapshots rather than from the current device-profile library.
    """

    parameters: list[dict[str, object]] = []
    definitions = (
        (
            "solar",
            solar,
            (
                ("default_dc_ac_ratio", "Default DC/AC ratio", None, True),
                ("rated_power_w", "Module rated power", "W", False),
                ("module_efficiency_percent", "Module efficiency", "%", False),
                ("temperature_coefficient_percent_per_c", "Temperature coefficient", "%/degC", False),
                ("annual_degradation_percent", "Annual module degradation", "%/year", False),
                ("module_technology", "Module technology", None, False),
            ),
        ),
        (
            "battery",
            battery,
            (
                ("coupling", "Battery coupling", None, True),
                ("nominal_capacity_kwh_per_unit", "Nominal capacity per profile unit", "kWh/unit", True),
                ("continuous_power_kw_per_unit", "Continuous power per profile unit", "kW/unit", True),
                ("round_trip_efficiency_percent", "Round-trip efficiency", "%", True),
                ("power_conversion_efficiency_percent", "Power conversion efficiency", "%", True),
                ("usable_depth_of_discharge_percent", "Usable depth of discharge", "%", True),
                ("standby_loss_percent_per_month", "Standby loss", "%/month", False),
                ("annual_capacity_degradation_percent", "Annual capacity degradation", "%/year", False),
                ("minimum_units", "Minimum profile units", "units", False),
                ("maximum_units", "Maximum profile units", "units", False),
                ("chemistry", "Battery chemistry", None, False),
            ),
        ),
        (
            "inverter",
            inverter,
            (
                ("rated_active_power_kw", "Rated active power", "kW AC", True),
                ("rated_apparent_power_kva", "Rated apparent power", "kVA", True),
                ("reactive_support_enabled", "Reactive support enabled", None, True),
                ("maximum_reactive_power_kvar", "Maximum reactive power", "kvar", True),
                ("european_efficiency_percent", "European efficiency", "%", False),
                ("maximum_efficiency_percent", "Maximum efficiency", "%", False),
                ("power_factor_leading_limit", "Leading power-factor limit", None, False),
                ("power_factor_lagging_limit", "Lagging power-factor limit", None, False),
                ("pq_capability_curve_available", "P-Q capability curve available", None, False),
                ("reactive_power_at_zero_active_power", "Reactive power at zero active power", None, False),
                ("night_reactive_capability", "Night reactive capability", None, False),
            ),
        ),
    )
    for category, snapshot, fields in definitions:
        source_label = str(
            snapshot.get("name")
            or snapshot.get("profile_id")
            or f"Saved {category} profile snapshot"
        )
        for key, label, unit, used in fields:
            parameters.append(
                _parameter(
                    f"solution.profile_snapshot.{category}.{key}",
                    label,
                    snapshot.get(key),
                    unit=unit,
                    source_kind="profile_snapshot",
                    source_label=source_label,
                    source_path=(
                        f"design_context.profile_selection.{category}_profile.{key}"
                    ),
                    edit_stage="physical_feasibility",
                    editable=False,
                    active=bool(snapshot) and used,
                )
            )
    return parameters


def _equipment_cost_parameters(
    *,
    device_profile: dict[str, object],
    equipment_selection: dict[str, object],
) -> list[dict[str, object]]:
    """Project saved catalogue prices without invoking the pricing engine."""

    catalog = _mapping(device_profile.get("equipment_catalog"))
    parameters: list[dict[str, object]] = []
    groups = (
        ("pv", "pv_products", "pv_product_id"),
        ("battery", "battery_products", "battery_product_id"),
        ("inverter", "inverter_products", "inverter_product_id"),
    )
    for category, catalog_key, selection_key in groups:
        products = _list_of_mappings(catalog.get(catalog_key))
        selected_id = equipment_selection.get(selection_key)
        for product_index, product in enumerate(products):
            product_id = product.get("product_id")
            selected = bool(product_id) and product_id == selected_id
            source_label = " ".join(
                str(value).strip()
                for value in (product.get("manufacturer"), product.get("model"))
                if str(value or "").strip()
            ) or str(product_id or f"{category} product {product_index + 1}")
            base_id = f"solution.cost.{category}.{product_index}"
            base_path = (
                f"device_profile.equipment_catalog.{catalog_key}.{product_index}"
            )
            parameters.append(
                _parameter(
                    f"{base_id}.product_id",
                    f"{source_label} product ID",
                    product_id,
                    source_kind="profile",
                    source_label="Saved workspace device profile",
                    source_path=f"{base_path}.product_id",
                    edit_stage="physical_feasibility",
                    editable=False,
                    active=selected,
                )
            )
            if category == "pv":
                for key, label, unit, active in (
                    (
                        "capital_cost_aud_per_kwp_dc",
                        "capital cost",
                        "AUD ex GST/kWp DC",
                        selected,
                    ),
                    (
                        "replacement_cost_aud_per_kwp_dc",
                        "replacement cost",
                        "AUD ex GST/kWp DC",
                        False,
                    ),
                    ("annual_om_aud", "catalogue annual O&M", "AUD/year", False),
                ):
                    parameters.append(
                        _parameter(
                            f"{base_id}.{key}",
                            f"{source_label} {label}",
                            product.get(key),
                            unit=unit,
                            source_kind="profile",
                            source_label="Saved workspace equipment catalogue",
                            source_path=f"{base_path}.{key}",
                            edit_stage="physical_feasibility",
                            editable=False,
                            active=active,
                        )
                    )
                continue
            size_key = (
                "module_capacity_kwh"
                if category == "battery"
                else "sizing_unit_kw_ac"
            )
            size_label = (
                "module capacity"
                if category == "battery"
                else "pricing sizing unit"
            )
            size_unit = "kWh/module" if category == "battery" else "kW AC"
            parameters.append(
                _parameter(
                    f"{base_id}.{size_key}",
                    f"{source_label} {size_label}",
                    product.get(size_key),
                    unit=size_unit,
                    source_kind="profile",
                    source_label="Saved workspace equipment catalogue",
                    source_path=f"{base_path}.{size_key}",
                    edit_stage="physical_feasibility",
                    editable=False,
                    active=selected,
                )
            )
            axis = "quantity" if category == "battery" else "capacity_kw_ac"
            axis_unit = "modules" if category == "battery" else "kW AC"
            for point_index, point in enumerate(
                _list_of_mappings(product.get("cost_curve"))
            ):
                point_id = f"{base_id}.curve.{point_index}"
                point_path = f"{base_path}.cost_curve.{point_index}"
                for key, label, unit, active in (
                    (axis, "curve axis", axis_unit, selected),
                    ("capital_cost_aud", "capital cost", "AUD ex GST", selected),
                    (
                        "replacement_cost_aud",
                        "replacement cost",
                        "AUD ex GST",
                        False,
                    ),
                    ("annual_om_aud", "catalogue annual O&M", "AUD/year", False),
                ):
                    parameters.append(
                        _parameter(
                            f"{point_id}.{key}",
                            f"{source_label} point {point_index + 1} {label}",
                            point.get(key),
                            unit=unit,
                            source_kind="profile",
                            source_label="Saved workspace equipment catalogue",
                            source_path=f"{point_path}.{key}",
                            edit_stage="physical_feasibility",
                            editable=False,
                            active=active,
                        )
                    )
    return parameters


def _gross_capex_example(
    priced_solutions: list[dict[str, Any]],
) -> dict[str, object] | None:
    if not priced_solutions:
        return None
    row = priced_solutions[0]
    breakdown = _mapping(row.get("capex_breakdown_aud_ex_gst"))
    result = row.get("gross_capex_aud_ex_gst")
    if not isinstance(result, (int, float)) or not breakdown:
        return None
    return {
        "substitution": (
            f"{row.get('scenario_id')}: stored PV {breakdown.get('pv_aud')} + "
            f"battery {breakdown.get('battery_aud')} + inverter "
            f"{breakdown.get('inverter_aud')}"
        ),
        "result": result,
        "unit": "AUD ex GST",
    }


def _net_capex_example(
    priced_solutions: list[dict[str, Any]],
) -> dict[str, object] | None:
    if not priced_solutions:
        return None
    row = priced_solutions[0]
    result = row.get("net_capex_aud_ex_gst")
    if not isinstance(result, (int, float)):
        return None
    return {
        "substitution": (
            f"{row.get('scenario_id')}: stored gross "
            f"{row.get('gross_capex_aud_ex_gst')} - stored approved rebate "
            f"{row.get('upfront_rebate_aud_ex_gst')}"
        ),
        "result": result,
        "unit": "AUD ex GST",
    }


def _rebate_example(
    priced_solutions: list[dict[str, Any]], program_id: str
) -> dict[str, object] | None:
    for row in priced_solutions:
        rebate = _mapping(row.get("rebate_calculation"))
        program = _mapping(_mapping(rebate.get("programs")).get(program_id))
        if not program:
            continue
        formula = _mapping(program.get("formula"))
        reasons = _joined_values(program.get("reason_codes"))
        return {
            "substitution": (
                f"{row.get('scenario_id')}: status={program.get('status')}; "
                f"operands[{_display_mapping(formula.get('operands'))}]; "
                f"certificates={program.get('certificate_quantity')}; "
                f"price={program.get('unit_price_aud_ex_gst')}; "
                f"rounding={formula.get('rounding')}; reasons={reasons}"
            ),
            "result": program.get("rebate_aud_ex_gst"),
            "unit": "AUD ex GST",
        }
    return None


def _tariff_value_example(
    tariff_scenarios: list[dict[str, Any]],
) -> dict[str, object] | None:
    for row in tariff_scenarios:
        annual = _mapping(row.get("annual_tariff_value"))
        result = annual.get("first_year_value_ex_gst_aud")
        if not isinstance(result, (int, float)):
            continue
        return {
            "substitution": (
                f"{row.get('scenario_id')}: stored baseline annual cost "
                f"{annual.get('baseline_cost_ex_gst_aud')} - stored scenario "
                f"annual cost {annual.get('scenario_cost_ex_gst_aud')}"
            ),
            "result": result,
            "unit": "AUD ex GST",
        }
    return None


def _manual_quote_example(
    finance_solutions: list[dict[str, Any]], assumptions: dict[str, object]
) -> dict[str, object] | None:
    if (
        assumptions.get("price_source")
        != "analyst_entered_total_solution_price"
        or not finance_solutions
    ):
        return None
    row = finance_solutions[0]
    result = row.get("upfront_cost_aud_ex_gst")
    if not isinstance(result, (int, float)):
        return None
    return {
        "substitution": (
            f"{row.get('scenario_id')}: quote={row.get('gross_upfront_cost_aud_ex_gst')}; "
            f"finance rebate deduction={row.get('upfront_rebate_aud_ex_gst')}; "
            f"status={row.get('rebate_application_status')}"
        ),
        "result": result,
        "unit": "AUD ex GST",
    }


def _assumption_example(
    assumptions: dict[str, object],
) -> dict[str, object] | None:
    keys = (
        "discount_rate",
        "annual_value_escalation_rate",
        "annual_value_degradation_rate",
        "annual_om_fraction_of_capex",
        "analysis_term_years",
    )
    if any(assumptions.get(key) is None for key in keys):
        return None
    return {
        "substitution": f"saved price_source={assumptions.get('price_source')}",
        "result": (
            f"discount={assumptions['discount_rate']}; "
            f"escalation={assumptions['annual_value_escalation_rate']}; "
            f"degradation={assumptions['annual_value_degradation_rate']}; "
            f"O&M={assumptions['annual_om_fraction_of_capex']}; "
            f"term={assumptions['analysis_term_years']} years"
        ),
        "unit": None,
    }


def _annual_om_example(
    finance_solutions: list[dict[str, Any]], assumptions: dict[str, object]
) -> dict[str, object] | None:
    if not finance_solutions:
        return None
    row = finance_solutions[0]
    result = row.get("annual_om_cost_aud_ex_gst")
    if not isinstance(result, (int, float)):
        return None
    return {
        "substitution": (
            f"{row.get('scenario_id')}: saved gross upfront "
            f"{row.get('gross_upfront_cost_aud_ex_gst')} * saved O&M fraction "
            f"{assumptions.get('annual_om_fraction_of_capex')}"
        ),
        "result": result,
        "unit": "AUD ex GST/year",
    }


def _cashflow_example(
    finance_solutions: list[dict[str, Any]], assumptions: dict[str, object]
) -> dict[str, object] | None:
    if not finance_solutions:
        return None
    row = finance_solutions[0]
    metrics = _mapping(row.get("metrics"))
    cashflows = metrics.get("annual_cashflows_aud")
    if not isinstance(cashflows, list) or not cashflows:
        return None
    return {
        "substitution": (
            f"{row.get('scenario_id')} year 1: stored value "
            f"{row.get('first_year_value_aud_ex_gst')}; escalation exponent=0; "
            f"degradation exponent=0; stored O&M "
            f"{row.get('annual_om_cost_aud_ex_gst')}; saved replacements="
            f"{_joined_values(assumptions.get('replacement_events_aud'))}"
        ),
        "result": cashflows[0],
        "unit": "AUD",
    }


def _metric_example(
    finance_solutions: list[dict[str, Any]],
    metric_key: str,
    unit: str,
    label: str,
) -> dict[str, object] | None:
    if not finance_solutions:
        return None
    row = finance_solutions[0]
    metrics = _mapping(row.get("metrics"))
    if metric_key not in metrics:
        return None
    return {
        "substitution": f"{row.get('scenario_id')}: {label} from saved cashflow vector",
        "result": metrics.get(metric_key),
        "unit": unit,
    }


def _window_text(window: dict[str, object]) -> str:
    if not window:
        return "Not saved"
    start = window.get("start")
    end = window.get("end")
    return f"{start or 'unspecified'}-{end or 'unspecified'} on workdays"


def _combined_scenario_status(
    feasibility_state: dict[str, object],
    tariff_replay_state: dict[str, object],
) -> str:
    """Report the most advanced saved scenario state without truthy fallback bugs."""

    physical_status = str(feasibility_state.get("status") or "not_saved")
    tariff_status = str(tariff_replay_state.get("status") or "not_saved")
    if tariff_status == "ready":
        return "ready"
    if tariff_status == "stale":
        return "stale"
    if physical_status == "ready":
        return "ready"
    if physical_status == "stale":
        return "stale"
    return "not_saved"


def _joined_values(value: object) -> str:
    if not isinstance(value, list) or not value:
        return "none"
    return ", ".join(str(item) for item in value)


def _display_mapping(value: object) -> str:
    mapping = _mapping(value)
    if not mapping:
        return "none"
    return ", ".join(
        f"{key}={mapping[key]}" for key in sorted(mapping)
    )


def _module(
    module_id: str,
    label: str,
    description: str,
    *,
    status: str,
    saved_at: object,
    parameters: list[dict[str, object]],
    calculations: list[dict[str, object]],
    models: list[dict[str, object]],
    result_sets: list[dict[str, object]],
    boundaries: list[str],
) -> dict[str, object]:
    return {
        "module_id": module_id,
        "label": label,
        "description": description,
        "status": status,
        "saved_at": saved_at,
        "parameters": parameters,
        "calculations": calculations,
        "models": models,
        "result_sets": result_sets,
        "boundaries": boundaries,
    }


def _parameter(
    parameter_id: str,
    label: str,
    value: object,
    *,
    unit: str | None = None,
    source_kind: str,
    source_label: str,
    source_path: str,
    edit_stage: str,
    editable: bool = True,
    active: bool = True,
) -> dict[str, object]:
    return {
        "parameter_id": parameter_id,
        "label": label,
        "value": value,
        "unit": unit,
        "source_kind": source_kind,
        "source_label": source_label,
        "source_path": source_path,
        "editable": editable,
        "edit_stage": edit_stage if editable else None,
        "active_in_current_model": active,
    }


def _calculation(
    calculation_id: str,
    label: str,
    formula: str,
    description: str,
    inputs: list[str],
    source_reference: str,
    *,
    example: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "calculation_id": calculation_id,
        "label": label,
        "formula": formula,
        "description": description,
        "inputs": inputs,
        "source_reference": source_reference,
        "current_example": example,
    }


def _model(
    model_id: str,
    label: str,
    method: str,
    objective: str,
    constraints: list[str],
    source_reference: str,
) -> dict[str, object]:
    return {
        "model_id": model_id,
        "label": label,
        "method": method,
        "objective": objective,
        "constraints": constraints,
        "source_reference": source_reference,
    }


def _result_set(
    result_set_id: str,
    label: str,
    columns: list[dict[str, object]],
    rows: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "result_set_id": result_set_id,
        "label": label,
        "columns": columns,
        "rows": rows,
    }


def _pv_derating_example(
    site: dict[str, object], technical: dict[str, object]
) -> dict[str, object] | None:
    keys = (
        "system_availability_percent",
        "shading_loss_percent",
        "soiling_loss_percent",
        "temperature_loss_percent",
        "wiring_mismatch_loss_percent",
        "other_system_loss_percent",
    )
    if any(not isinstance(site.get(key), (int, float)) for key in keys):
        return None
    result = technical.get("effective_derating_percent")
    if not isinstance(result, (int, float)):
        return None
    values = [float(site[key]) for key in keys]
    return {
        "substitution": (
            f"{values[0] / 100:g} * "
            + " * ".join(f"(1 - {value / 100:g})" for value in values[1:])
        ),
        "result": result,
        "unit": "%",
    }


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list_of_mappings(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]
