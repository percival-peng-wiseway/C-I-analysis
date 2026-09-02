from __future__ import annotations

from datetime import date

import pytest

from solar_battery.ci_annual_financial_comparison import (
    compare_ci_annual_financial_scenarios,
    preview_ci_design_candidate_prices,
)
from solar_battery.ci_device_profile import suggested_ci_device_profile
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_project_rebate_profile import (
    validate_ci_project_rebate_profile,
)
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_rebate_calculation import calculate_ci_scenario_rebate
from solar_battery.ci_rebate_rules import (
    CI_REBATE_RULESET_ID,
    battery_stc_factor,
    ci_rebate_ruleset_metadata,
    ci_rebate_ruleset_sha256,
    solar_stc_deeming_years,
    vic_deemed_veec_rules_available,
)


def _scenario(**overrides: object) -> dict[str, object]:
    authored = {
        "pv_capacity_kwp_dc": 100.0,
        "pv_inverter_capacity_kw_ac": 80.0,
        "pv_annual_specific_yield_kwh_per_kw": 1500.0,
        "pv_derating_factor": 1.0,
        "nominal_capacity_kwh": 100.0,
        **overrides,
    }
    return {"scenario_id": "scenario-1", "authored_inputs": authored}


def _program(
    *,
    enabled: bool,
    price: float,
    **extra: object,
) -> dict[str, object]:
    return {
        "enabled": enabled,
        "eligibility_confirmed": enabled,
        "eligibility_source_label": "Analyst-reviewed official eligibility evidence",
        "certificate_price_aud_ex_gst": price,
        "price_source_label": "Analyst-reviewed market evidence",
        "price_as_of_date": "2026-09-01",
        **extra,
    }


def _calculation_profile(
    *,
    target: str = "2026-09-02",
    state: str = "VIC",
    solar: bool = False,
    battery: bool = False,
    veec: bool = False,
) -> dict[str, object]:
    profile = {
        "contract_version": "ci_project_rebate_calculation_profile_v1",
        "source_profile_sha256": "0" * 64,
        "ruleset_id": CI_REBATE_RULESET_ID,
        "ruleset_sha256": ci_rebate_ruleset_sha256(),
        "design_candidates_sha256": "a" * 64,
        "design_context_sha256": "b" * 64,
        "device_profile_sha256": "c" * 64,
        "target_certificate_date": target,
        "site_state_code": state,
        "site_postcode": "3000",
        "site_location_source_label": "Verified bill site address",
        "stacking_confirmed": True,
        "programs": {
            "solar_stc": _program(
                enabled=solar,
                price=39.0,
                postcode_zone_rating=1.382,
                zone_source_label="CER postcode zone table",
            ),
            "battery_stc": _program(
                enabled=battery,
                price=39.0,
                certified_usable_capacity_fraction=0.5,
                capacity_source_label="Certified product specification",
            ),
            "vic_deemed_veec": _program(
                enabled=veec,
                price=70.0,
                victoria_region="metropolitan",
                inverter_apparent_power_kva_per_kw_ac=1.0,
                inverter_apparent_power_source_label="Approved inverter datasheet",
            ),
        },
    }
    return _refresh_source_profile_sha256(profile)


def _refresh_source_profile_sha256(
    profile: dict[str, object],
) -> dict[str, object]:
    editable = validate_ci_project_rebate_profile(
        {
            "contract_version": "ci_project_rebate_profile_v1",
            "target_certificate_date": profile["target_certificate_date"],
            "site_state_code": profile["site_state_code"],
            "site_postcode": profile["site_postcode"],
            "site_location_confirmed": True,
            "site_location_source_label": profile[
                "site_location_source_label"
            ],
            "stacking_confirmed": profile["stacking_confirmed"],
            "programs": profile["programs"],
        }
    )
    profile["source_profile_sha256"] = canonical_sha256(editable)
    return profile


def test_ruleset_is_versioned_and_does_not_enable_mid_scale_proposal() -> None:
    metadata = ci_rebate_ruleset_metadata()

    assert metadata["ruleset_id"] == "au_ci_rebates_2026_v1"
    assert len(str(metadata["ruleset_sha256"])) == 64
    assert any(
        source["status"] == "proposal_not_enabled"
        for source in metadata["official_sources"]
    )
    assert any(
        source["source_id"] == "vic_veu_specification_v25"
        and source["status"] == "authoritative"
        for source in metadata["official_sources"]
    )
    assert [solar_stc_deeming_years(date(year, 1, 1)) for year in range(2026, 2031)] == [5, 4, 3, 2, 1]
    assert battery_stc_factor(date(2026, 4, 30)) == (8.4, "untiered")
    assert battery_stc_factor(date(2026, 5, 1)) == (6.8, "tiered_14_28_50")
    assert vic_deemed_veec_rules_available(date(2026, 7, 20)) is False
    assert vic_deemed_veec_rules_available(date(2026, 7, 21)) is True
    assert vic_deemed_veec_rules_available(date(2026, 12, 31)) is True
    assert vic_deemed_veec_rules_available(date(2027, 1, 1)) is False


def test_approved_programs_apply_flooring_tiers_and_auditable_sources() -> None:
    result = calculate_ci_scenario_rebate(
        _scenario(),
        rebate_profile=_calculation_profile(solar=True, battery=True, veec=True),
    )

    solar = result["programs"]["solar_stc"]
    battery = result["programs"]["battery_stc"]
    veec = result["programs"]["vic_deemed_veec"]
    assert (solar["status"], solar["certificate_quantity"], solar["rebate_aud_ex_gst"]) == (
        "applied",
        691,
        26949.0,
    )
    assert (
        battery["status"],
        battery["certificate_quantity"],
        battery["rebate_aud_ex_gst"],
    ) == ("applied", 174, 6786.0)
    assert (veec["status"], veec["certificate_quantity"], veec["rebate_aud_ex_gst"]) == (
        "applied",
        130,
        9100.0,
    )
    assert result["total_rebate_aud_ex_gst"] == 42835.0
    assert result["eligibility_guaranteed"] is False
    assert result["customer_facing_permission"] is False
    assert solar["sources"] == {
        "eligibility_source_label": "Analyst-reviewed official eligibility evidence",
        "price_source_label": "Analyst-reviewed market evidence",
        "price_as_of_date": "2026-09-01",
        "zone_source_label": "CER postcode zone table",
    }
    assert battery["formula"]["operands"]["weighted_usable_capacity_kwh"] == 25.7


def test_rebate_boundaries_fail_closed() -> None:
    solar_profile = _calculation_profile(solar=True)
    exactly_100 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=100.0), rebate_profile=solar_profile
    )["programs"]["solar_stc"]
    over_100 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=100.001), rebate_profile=solar_profile
    )["programs"]["solar_stc"]
    exact_250_mwh = calculate_ci_scenario_rebate(
        _scenario(pv_annual_specific_yield_kwh_per_kw=2500.0),
        rebate_profile=solar_profile,
    )["programs"]["solar_stc"]
    above_250_mwh = calculate_ci_scenario_rebate(
        _scenario(pv_annual_specific_yield_kwh_per_kw=2500.01),
        rebate_profile=solar_profile,
    )["programs"]["solar_stc"]
    assert exactly_100["status"] == "applied"
    assert over_100["status"] == "ineligible"
    assert "solar_stc_capacity_out_of_range" in over_100["reason_codes"]
    assert exact_250_mwh["status"] == "applied"
    assert above_250_mwh["status"] == "ineligible"
    assert "solar_stc_annual_output_above_250mwh" in above_250_mwh["reason_codes"]

    april = calculate_ci_scenario_rebate(
        _scenario(),
        rebate_profile=_calculation_profile(target="2026-04-30", battery=True),
    )["programs"]["battery_stc"]
    may = calculate_ci_scenario_rebate(
        _scenario(),
        rebate_profile=_calculation_profile(target="2026-05-01", battery=True),
    )["programs"]["battery_stc"]
    assert april["certificate_quantity"] == 420
    assert may["certificate_quantity"] == 174

    battery_profile = _calculation_profile(battery=True)
    nominal_5 = calculate_ci_scenario_rebate(
        _scenario(nominal_capacity_kwh=5.0), rebate_profile=battery_profile
    )["programs"]["battery_stc"]
    nominal_100 = calculate_ci_scenario_rebate(
        _scenario(nominal_capacity_kwh=100.0), rebate_profile=battery_profile
    )["programs"]["battery_stc"]
    nominal_over_100 = calculate_ci_scenario_rebate(
        _scenario(nominal_capacity_kwh=100.001), rebate_profile=battery_profile
    )["programs"]["battery_stc"]
    linked_solar_over_100 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=100.001), rebate_profile=battery_profile
    )["programs"]["battery_stc"]
    capped_profile = _calculation_profile(battery=True)
    capped_profile["programs"]["battery_stc"][
        "certified_usable_capacity_fraction"
    ] = 0.8
    _refresh_source_profile_sha256(capped_profile)
    capped = calculate_ci_scenario_rebate(
        _scenario(nominal_capacity_kwh=80.0), rebate_profile=capped_profile
    )["programs"]["battery_stc"]
    assert nominal_5["status"] == "applied"
    assert nominal_100["status"] == "applied"
    assert nominal_over_100["status"] == "ineligible"
    assert linked_solar_over_100["status"] == "ineligible"
    assert capped["formula"]["operands"]["certified_usable_capacity_kwh"] == 64.0
    assert capped["formula"]["operands"]["claimable_usable_capacity_kwh"] == 50.0

    metro_profile = _calculation_profile(veec=True)
    regional_profile = _calculation_profile(veec=True)
    regional_profile["programs"]["vic_deemed_veec"]["victoria_region"] = "regional"
    _refresh_source_profile_sha256(regional_profile)
    veec_30_metro = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=30.0, pv_inverter_capacity_kw_ac=30.0),
        rebate_profile=metro_profile,
    )["programs"]["vic_deemed_veec"]
    veec_30_regional = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=30.0, pv_inverter_capacity_kw_ac=30.0),
        rebate_profile=regional_profile,
    )["programs"]["vic_deemed_veec"]
    veec_100 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=100.0), rebate_profile=metro_profile
    )["programs"]["vic_deemed_veec"]
    veec_over_100 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=100.001), rebate_profile=metro_profile
    )["programs"]["vic_deemed_veec"]
    veec_200 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=200.0), rebate_profile=metro_profile
    )["programs"]["vic_deemed_veec"]
    veec_over_200 = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=200.001), rebate_profile=metro_profile
    )["programs"]["vic_deemed_veec"]
    assert veec_30_metro["certificate_quantity"] == 39
    assert veec_30_regional["certificate_quantity"] == 41
    assert veec_100["certificate_quantity"] == 130
    assert veec_over_100["status"] == "applied"
    assert veec_over_100["formula"]["operands"]["input_factor"] == 0.25
    assert veec_200["certificate_quantity"] == 490
    assert veec_over_200["status"] == "ineligible"

    kva_profile = _calculation_profile(veec=True)
    kva_profile["programs"]["vic_deemed_veec"][
        "inverter_apparent_power_kva_per_kw_ac"
    ] = 1.2
    _refresh_source_profile_sha256(kva_profile)
    exactly_30_kva = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=30.0, pv_inverter_capacity_kw_ac=25.0),
        rebate_profile=kva_profile,
    )["programs"]["vic_deemed_veec"]
    below_30_kva = calculate_ci_scenario_rebate(
        _scenario(pv_capacity_kwp_dc=30.0, pv_inverter_capacity_kw_ac=24.999),
        rebate_profile=kva_profile,
    )["programs"]["vic_deemed_veec"]
    assert exactly_30_kva["status"] == "applied"
    assert exactly_30_kva["formula"]["operands"][
        "connected_inverter_capacity_kva"
    ] == 30.0
    assert below_30_kva["status"] == "ineligible"
    assert "vic_deemed_veec_inverter_below_30kva" in below_30_kva[
        "reason_codes"
    ]

    with pytest.raises(CiProjectError, match="Victorian deemed VEEC evidence"):
        calculate_ci_scenario_rebate(
            _scenario(pv_capacity_kwp_dc=30.0, pv_inverter_capacity_kw_ac=30.0),
            rebate_profile=_calculation_profile(state="NSW", veec=True),
        )

    with pytest.raises(CiProjectError, match="Victorian deemed VEEC evidence"):
        calculate_ci_scenario_rebate(
            _scenario(),
            rebate_profile=_calculation_profile(target="2027-01-01", veec=True),
        )

    with pytest.raises(CiProjectError, match="Victorian deemed VEEC evidence"):
        calculate_ci_scenario_rebate(
            _scenario(),
            rebate_profile=_calculation_profile(target="2026-07-20", veec=True),
        )


def test_calculation_profile_binding_and_source_fail_closed() -> None:
    missing_binding = _calculation_profile(solar=True)
    missing_binding["design_context_sha256"] = None
    with pytest.raises(CiProjectError, match="binding is incomplete"):
        calculate_ci_scenario_rebate(
            _scenario(), rebate_profile=missing_binding
        )

    mismatched_source = _calculation_profile(solar=True)
    mismatched_source["source_profile_sha256"] = "f" * 64
    with pytest.raises(CiProjectError, match="source evidence is invalid"):
        calculate_ci_scenario_rebate(
            _scenario(), rebate_profile=mismatched_source
        )

    future_price = _calculation_profile(solar=True)
    future_price["programs"]["solar_stc"]["price_as_of_date"] = "2099-01-01"
    _refresh_source_profile_sha256(future_price)
    with pytest.raises(CiProjectError, match="source evidence is incomplete"):
        calculate_ci_scenario_rebate(
            _scenario(), rebate_profile=future_price
        )

    unsupported_field = _calculation_profile(solar=True)
    unsupported_field["screenshot_rule"] = True
    with pytest.raises(CiProjectError, match="unavailable or stale"):
        calculate_ci_scenario_rebate(
            _scenario(), rebate_profile=unsupported_field
        )

    all_disabled = _calculation_profile()
    for key in (
        "design_candidates_sha256",
        "design_context_sha256",
        "device_profile_sha256",
    ):
        all_disabled[key] = None
    result = calculate_ci_scenario_rebate(
        _scenario(), rebate_profile=all_disabled
    )
    assert result["total_rebate_aud_ex_gst"] == 0


def test_no_approved_profile_is_zero_and_manual_quote_is_never_reduced() -> None:
    no_profile = calculate_ci_scenario_rebate(_scenario(), rebate_profile=None)
    assert no_profile["total_rebate_aud_ex_gst"] == 0
    assert {item["status"] for item in no_profile["programs"].values()} == {
        "disabled"
    }

    scenario = {
        "scenario_id": "scenario-1",
        "label": "100 kWp + 100 kWh",
        "physical_review_rank": 1,
        "authored_inputs": _scenario()["authored_inputs"],
        "annual_tariff_value": {
            "scenario_cost_ex_gst_aud": 70000.0,
            "first_year_value_ex_gst_aud": 30000.0,
        },
    }
    tariff_result = {
        "contract_version": "ci_physical_scenario_review_v6",
        "analysis_status": "ready",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "profile": {"profile_id": "approved-test"},
        "scenarios": [scenario],
    }
    profile = _calculation_profile(solar=True)
    manual = compare_ci_annual_financial_scenarios(
        tariff_replay_result=tariff_result,
        request={
            "pricing_mode": "manual_quotes",
            "prices": [
                {
                    "scenario_id": "scenario-1",
                    "upfront_cost_aud_ex_gst": 90000.0,
                }
            ],
        },
        rebate_profile=profile,
    )["solutions"][0]
    assert manual["gross_upfront_cost_aud_ex_gst"] == 90000.0
    assert manual["upfront_rebate_aud_ex_gst"] == 0
    assert manual["upfront_cost_aud_ex_gst"] == 90000.0
    assert manual["rebate_calculation"]["total_rebate_aud_ex_gst"] == 26949.0
    assert manual["rebate_application_status"] == "not_applied_to_manual_quote"

    device_profile = suggested_ci_device_profile()
    device = compare_ci_annual_financial_scenarios(
        tariff_replay_result=tariff_result,
        request={
            "pricing_mode": "device_profile",
            "prices": [],
            "equipment_selection": device_profile["default_equipment_selection"],
        },
        device_profile=device_profile,
        rebate_profile=profile,
    )["solutions"][0]
    assert device["upfront_rebate_aud_ex_gst"] == 26949.0
    assert device["upfront_cost_aud_ex_gst"] == round(
        device["gross_upfront_cost_aud_ex_gst"] - 26949.0, 2
    )
    assert device["annual_om_cost_aud_ex_gst"] == round(
        device["gross_upfront_cost_aud_ex_gst"] * 0.015, 2
    )


def test_design_price_preview_lists_every_candidate_and_returns_net_capex() -> None:
    authored = _scenario()["authored_inputs"]
    candidates = [
        {**authored, "scenario_id": "scenario-1", "label": "Option 1"},
        {
            **authored,
            "scenario_id": "scenario-2",
            "label": "Option 2",
            "pv_capacity_kwp_dc": 120.0,
        },
    ]
    result = preview_ci_design_candidate_prices(
        candidates=candidates,
        device_profile=suggested_ci_device_profile(),
        rebate_profile=None,
    )

    assert result["contract_version"] == "ci_design_price_preview_v1"
    assert result["candidate_count"] == 2
    assert [item["scenario_id"] for item in result["solutions"]] == [
        "scenario-1",
        "scenario-2",
    ]
    assert all(
        item["gross_capex_aud_ex_gst"]
        - item["upfront_rebate_aud_ex_gst"]
        == item["net_capex_aud_ex_gst"]
        for item in result["solutions"]
    )
    assert result["quotation_override_basis"].startswith(
        "Entered quotation replaces modelled Net CAPEX"
    )
