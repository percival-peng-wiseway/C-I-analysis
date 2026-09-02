from __future__ import annotations

from datetime import date
import hashlib
import json


CI_REBATE_RULESET_CONTRACT_VERSION = "ci_rebate_ruleset_v1"
CI_REBATE_RULESET_ID = "au_ci_rebates_2026_v1"

CI_SOLAR_STC_RULE_ID = "cer_solar_stc_2026_2030_v1"
CI_BATTERY_STC_RULE_ID = "cer_battery_stc_2025_2030_v1"
CI_VIC_DEEMED_VEEC_RULE_ID = "vic_veu_part47_v25_2026_v1"

CI_SOLAR_STC_ZONE_RATINGS = (1.622, 1.536, 1.382, 1.185)
CI_SOLAR_STC_DEEMING_YEARS = {
    2026: 5,
    2027: 4,
    2028: 3,
    2029: 2,
    2030: 1,
}

CI_BATTERY_STC_FACTORS = (
    (date(2025, 7, 1), date(2025, 12, 31), 9.3, "untiered"),
    (date(2026, 1, 1), date(2026, 4, 30), 8.4, "untiered"),
    (date(2026, 5, 1), date(2026, 12, 31), 6.8, "tiered_14_28_50"),
    (date(2027, 1, 1), date(2027, 6, 30), 5.7, "tiered_14_28_50"),
    (date(2027, 7, 1), date(2027, 12, 31), 5.2, "tiered_14_28_50"),
    (date(2028, 1, 1), date(2028, 6, 30), 4.6, "tiered_14_28_50"),
    (date(2028, 7, 1), date(2028, 12, 31), 4.1, "tiered_14_28_50"),
    (date(2029, 1, 1), date(2029, 6, 30), 3.6, "tiered_14_28_50"),
    (date(2029, 7, 1), date(2029, 12, 31), 3.1, "tiered_14_28_50"),
    (date(2030, 1, 1), date(2030, 6, 30), 2.6, "tiered_14_28_50"),
    (date(2030, 7, 1), date(2030, 12, 31), 2.1, "tiered_14_28_50"),
)

CI_VIC_DEEMED_VEEC_PROGRAM_COMMENCEMENT_DATE = date(2025, 9, 29)
CI_VIC_DEEMED_VEEC_SOURCE_EFFECTIVE_FROM = date(2026, 7, 21)
CI_VIC_DEEMED_VEEC_MODEL_SUPPORTED_THROUGH = date(2026, 12, 31)

CI_REBATE_OFFICIAL_SOURCES = (
    {
        "source_id": "cer_stc_entitlements",
        "label": "Clean Energy Regulator — calculate STC entitlements",
        "url": "https://cer.gov.au/schemes/renewable-energy-target/small-scale-renewable-energy-scheme/small-scale-technology-certificates/calculate-small-scale-technology-certificate-entitlements",
        "status": "authoritative",
    },
    {
        "source_id": "cer_solar_batteries",
        "label": "Clean Energy Regulator — solar battery eligibility and STC calculation",
        "url": "https://cer.gov.au/schemes/renewable-energy-target/small-scale-renewable-energy-scheme/small-scale-renewable-energy-systems/solar-batteries",
        "status": "authoritative",
    },
    {
        "source_id": "vic_veu_specification_v25",
        "label": "Victorian Energy Upgrades Specifications 2018 — Version 25.0, Part 47",
        "url": "https://www.energy.vic.gov.au/__data/assets/pdf_file/0041/795488/Victorian-Energy-Upgrades-Specifications-2018-Version-25.pdf",
        "status": "authoritative",
    },
    {
        "source_id": "vic_part47_faq",
        "label": "Victorian Energy Upgrades — C&I Solar Part 47 FAQs",
        "url": "https://www.energy.vic.gov.au/__data/assets/pdf_file/0032/779108/Victorian-Energy-Upgrades-Commercial-and-Industrial-solar-FAQs.pdf",
        "status": "authoritative",
    },
    {
        "source_id": "cer_mid_scale_solar_proposal_2026",
        "label": "CER announcement — proposed mid-scale SRES expansion from 1 October 2026",
        "url": "https://cer.gov.au/news-and-media/news/2026/august/expansion-solar-photovoltaic-pv-eligibility-under-small-scale-renewable-energy-scheme",
        "status": "proposal_not_enabled",
    },
)


def _ruleset_payload() -> dict[str, object]:
    return {
        "contract_version": CI_REBATE_RULESET_CONTRACT_VERSION,
        "ruleset_id": CI_REBATE_RULESET_ID,
        "official_sources": [dict(item) for item in CI_REBATE_OFFICIAL_SOURCES],
        "solar_stc": {
            "rule_id": CI_SOLAR_STC_RULE_ID,
            "maximum_system_capacity_kw": 100.0,
            "maximum_annual_output_kwh_inclusive": 250_000.0,
            "zone_ratings": list(CI_SOLAR_STC_ZONE_RATINGS),
            "deeming_years": dict(CI_SOLAR_STC_DEEMING_YEARS),
            "rounding": "floor_after_multiplication",
            "mid_scale_100kw_to_1mw_proposal_enabled": False,
        },
        "battery_stc": {
            "rule_id": CI_BATTERY_STC_RULE_ID,
            "minimum_nominal_capacity_kwh": 5.0,
            "maximum_nominal_capacity_kwh": 100.0,
            "maximum_linked_solar_capacity_kw": 100.0,
            "maximum_claimable_usable_capacity_kwh": 50.0,
            "tiered_from": "2026-05-01",
            "tiers": [
                {"from_exclusive_kwh": 0.0, "to_inclusive_kwh": 14.0, "factor_fraction": 1.0},
                {"from_exclusive_kwh": 14.0, "to_inclusive_kwh": 28.0, "factor_fraction": 0.6},
                {"from_exclusive_kwh": 28.0, "to_inclusive_kwh": 50.0, "factor_fraction": 0.15},
            ],
            "factors": [
                {
                    "valid_from": start.isoformat(),
                    "valid_to": end.isoformat(),
                    "factor": factor,
                    "method": method,
                }
                for start, end, factor, method in CI_BATTERY_STC_FACTORS
            ],
            "rounding": "floor_after_all_tiers_summed",
        },
        "vic_deemed_veec": {
            "rule_id": CI_VIC_DEEMED_VEEC_RULE_ID,
            "source_specification_effective_from": (
                CI_VIC_DEEMED_VEEC_SOURCE_EFFECTIVE_FROM.isoformat()
            ),
            "program_commencement_date": (
                CI_VIC_DEEMED_VEEC_PROGRAM_COMMENCEMENT_DATE.isoformat()
            ),
            "rule_snapshot_valid_from": (
                CI_VIC_DEEMED_VEEC_SOURCE_EFFECTIVE_FROM.isoformat()
            ),
            "model_supported_through": (
                CI_VIC_DEEMED_VEEC_MODEL_SUPPORTED_THROUGH.isoformat()
            ),
            "minimum_system_capacity_kw": 30.0,
            "maximum_system_capacity_kw": 200.0,
            "minimum_inverter_capacity_kva": 30.0,
            "input_factor_at_or_below_100kw": 0.133,
            "input_factor_above_100kw": 0.25,
            "lifetime_years": 10.0,
            "regional_factors": {"metropolitan": 0.98, "regional": 1.04},
            "rounding": "floor_after_multiplication",
        },
    }


def ci_rebate_ruleset_sha256() -> str:
    return hashlib.sha256(
        json.dumps(
            _ruleset_payload(),
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


def ci_rebate_ruleset_metadata() -> dict[str, object]:
    return {
        "ruleset_id": CI_REBATE_RULESET_ID,
        "ruleset_sha256": ci_rebate_ruleset_sha256(),
        "official_sources": [dict(item) for item in CI_REBATE_OFFICIAL_SOURCES],
    }


def solar_stc_deeming_years(target: date) -> int | None:
    return CI_SOLAR_STC_DEEMING_YEARS.get(target.year)


def battery_stc_factor(target: date) -> tuple[float, str] | None:
    for start, end, factor, method in CI_BATTERY_STC_FACTORS:
        if start <= target <= end:
            return factor, method
    return None


def vic_deemed_veec_rules_available(target: date) -> bool:
    return (
        CI_VIC_DEEMED_VEEC_SOURCE_EFFECTIVE_FROM
        <= target
        <= CI_VIC_DEEMED_VEEC_MODEL_SUPPORTED_THROUGH
    )
