from __future__ import annotations

import json


CONTRACT_VERSION = "ci_component_cost_library_v1"


_LIBRARY = {
    "contract_version": CONTRACT_VERSION,
    "library_id": "provided_ci_component_costs",
    "currency": "AUD",
    "entries": [
        {
            "component_id": "astronergy-astro-n7-600-series-provided",
            "label": "Astronergy ASTRO N7 600-series",
            "abbreviation": "PV",
            "category": "solar_pv",
            "source_size_metric": "pv_kwp_dc",
            "source_size_unit": "kW",
            "source_tax_basis": "not_stated",
            "source_reference": "user_provided_cost_screenshot_2026_08_10",
            "stated_lifetime_years": 30,
            "reuse_status": "direct",
            "cost_rows": [
                {"size": 80.0, "capital_cost_aud": 42400.0, "replacement_cost_aud": 42400.0, "annual_om_cost_aud": 0.0},
                {"size": 90.0, "capital_cost_aud": 47700.0, "replacement_cost_aud": 47700.0, "annual_om_cost_aud": 0.0},
                {"size": 99.0, "capital_cost_aud": 52470.0, "replacement_cost_aud": 52470.0, "annual_om_cost_aud": 0.0},
                {"size": 99.38, "capital_cost_aud": 52671.4, "replacement_cost_aud": 52671.4, "annual_om_cost_aud": 0.0},
            ],
            "pricing_catalog_template": {
                "item_id": "provided-astronergy-astro-n7-pv",
                "label": "Astronergy ASTRO N7 600-series PV",
                "category": "solar_pv",
                "pricing_basis": "size_cost_table",
                "unit_price_aud": 0.0,
                "size_metric": "pv_kwp_dc",
                "replacement_interval_years": 30,
                "cost_rows": [
                    {"size": 80.0, "capital_cost_aud": 42400.0, "replacement_cost_aud": 42400.0, "annual_om_cost_aud": 0.0},
                    {"size": 90.0, "capital_cost_aud": 47700.0, "replacement_cost_aud": 47700.0, "annual_om_cost_aud": 0.0},
                    {"size": 99.0, "capital_cost_aud": 52470.0, "replacement_cost_aud": 52470.0, "annual_om_cost_aud": 0.0},
                    {"size": 99.38, "capital_cost_aud": 52671.4, "replacement_cost_aud": 52671.4, "annual_om_cost_aud": 0.0},
                ],
                "effective_status": "active",
                "source_component_id": "astronergy-astro-n7-600-series-provided",
                "source_tax_basis": "not_stated",
            },
        },
        {
            "component_id": "fox-ess-cq7-ci-provided",
            "label": "Fox ESS CQ7 C&I",
            "abbreviation": "LFP",
            "category": "battery",
            "source_size_metric": "battery_kwh",
            "source_size_unit": "kWh",
            "source_tax_basis": "not_stated",
            "source_reference": "user_provided_cost_screenshot_2026_08_10",
            "capacity_source_reference": "fox_ess_au_cq7_datasheet_v1_2_20260514",
            "capacity_source_url": "https://au.fox-ess.com/Public/Uploads/uploadfile/files/20260514/ENCQ7DatasheetAUV1.220260514.pdf",
            "module_nominal_capacity_kwh": 6.96,
            "stated_lifetime_years": None,
            "reuse_status": "replacement_interval_required",
            "cost_rows": [
                {"size": 83.52, "capital_cost_aud": 34712.0, "replacement_cost_aud": 20844.0, "annual_om_cost_aud": 0.0},
                {"size": 125.28, "capital_cost_aud": 49002.0, "replacement_cost_aud": 33048.0, "annual_om_cost_aud": 0.0},
                {"size": 167.04, "capital_cost_aud": 63290.0, "replacement_cost_aud": 45252.0, "annual_om_cost_aud": 0.0},
            ],
            "pricing_catalog_template": {
                "item_id": "provided-fox-ess-cq7-ci-battery",
                "label": "Fox ESS CQ7 C&I battery",
                "category": "battery",
                "pricing_basis": "size_cost_table",
                "unit_price_aud": 0.0,
                "size_metric": "battery_kwh",
                "replacement_interval_years": None,
                "cost_rows": [
                    {"size": 83.52, "capital_cost_aud": 34712.0, "replacement_cost_aud": 20844.0, "annual_om_cost_aud": 0.0},
                    {"size": 125.28, "capital_cost_aud": 49002.0, "replacement_cost_aud": 33048.0, "annual_om_cost_aud": 0.0},
                    {"size": 167.04, "capital_cost_aud": 63290.0, "replacement_cost_aud": 45252.0, "annual_om_cost_aud": 0.0},
                ],
                "effective_status": "active",
                "source_component_id": "fox-ess-cq7-ci-provided",
                "source_tax_basis": "not_stated",
                "source_quantity_points": [12, 18, 24],
                "module_nominal_capacity_kwh": 6.96,
            },
        },
        {
            "component_id": "provided-inverter-inv",
            "label": "Provided inverter cost table",
            "abbreviation": "INV",
            "category": "pcs_inverter",
            "source_size_metric": "pv_inverter_kw_ac",
            "source_size_unit": "kW",
            "source_tax_basis": "not_stated",
            "source_reference": "user_provided_cost_screenshot_2026_08_10",
            "stated_lifetime_years": 15,
            "reuse_status": "direct",
            "cost_rows": [
                {"size": 80.0, "capital_cost_aud": 9000.0, "replacement_cost_aud": 9000.0, "annual_om_cost_aud": 0.0},
                {"size": 100.0, "capital_cost_aud": 9500.0, "replacement_cost_aud": 9500.0, "annual_om_cost_aud": 0.0},
                {"size": 125.0, "capital_cost_aud": 10000.0, "replacement_cost_aud": 10000.0, "annual_om_cost_aud": 0.0},
            ],
            "pricing_catalog_template": {
                "item_id": "provided-inverter-inv",
                "label": "Provided inverter cost table (INV)",
                "category": "pcs_inverter",
                "pricing_basis": "size_cost_table",
                "unit_price_aud": 0.0,
                "size_metric": "pv_inverter_kw_ac",
                "replacement_interval_years": 15,
                "cost_rows": [
                    {"size": 80.0, "capital_cost_aud": 9000.0, "replacement_cost_aud": 9000.0, "annual_om_cost_aud": 0.0},
                    {"size": 100.0, "capital_cost_aud": 9500.0, "replacement_cost_aud": 9500.0, "annual_om_cost_aud": 0.0},
                    {"size": 125.0, "capital_cost_aud": 10000.0, "replacement_cost_aud": 10000.0, "annual_om_cost_aud": 0.0},
                ],
                "effective_status": "active",
                "source_component_id": "provided-inverter-inv",
                "source_tax_basis": "not_stated",
            },
        },
    ],
}


def ci_component_cost_library() -> dict[str, object]:
    """Return a detached copy of the reusable, evidence-preserving library."""
    return json.loads(json.dumps(_LIBRARY))
