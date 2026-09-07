"""Standalone, analyst-entered STC arithmetic. Never a finance input or entitlement."""
from decimal import Decimal, ROUND_HALF_UP

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from solar_battery.ci_projects import require_ci_project

BATTERY_FACTORS = {
    "2025": "9.3", "2026-01_04": "8.4", "2026-05_12": "6.8",
    "2027-01_06": "5.7", "2027-07_12": "5.2",
    "2028-01_06": "4.6", "2028-07_12": "4.1",
    "2029-01_06": "3.6", "2029-07_12": "3.1",
    "2030-01_06": "2.6", "2030-07_12": "2.1",
}


class CiStcCalculatorInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    solar_installation_year: int = Field(ge=2025, le=2030)
    solar_zone: Literal[3, 4]
    pv_capacity_kwp: float = Field(ge=0, le=1_000_000)
    solar_certificate_price: float = Field(ge=0, le=1000)
    battery_installation_period: Literal[
        "2025", "2026-01_04", "2026-05_12", "2027-01_06", "2027-07_12",
        "2028-01_06", "2028-07_12", "2029-01_06", "2029-07_12",
        "2030-01_06", "2030-07_12",
    ]
    battery_usable_capacity_kwh: float = Field(ge=0, le=1_000_000)
    battery_certificate_price: float = Field(ge=0, le=1000)


def calculate_stc_estimate(inputs: CiStcCalculatorInput) -> dict:
    deeming = 2030 - inputs.solar_installation_year + 1
    zone = Decimal("1.382" if inputs.solar_zone == 3 else "1.185")
    factor = Decimal(BATTERY_FACTORS[inputs.battery_installation_period])
    solar_quantity = Decimal(deeming) * zone * Decimal(str(inputs.pv_capacity_kwp))
    battery_quantity = Decimal(str(inputs.battery_usable_capacity_kwh)) * factor

    def money(quantity, price):
        return (quantity * Decimal(str(price))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    solar = money(solar_quantity, inputs.solar_certificate_price)
    battery = money(battery_quantity, inputs.battery_certificate_price)
    return {
        "contract_version": "ci_stc_manual_estimate_v1",
        "inputs": inputs.model_dump(mode="json"),
        "solar_deeming_years": deeming, "solar_zone_factor": float(zone),
        "battery_factor": float(factor),
        "solar_calculated_quantity": float(solar_quantity),
        "battery_calculated_quantity": float(battery_quantity),
        "solar_rebate_aud": float(solar), "battery_rebate_aud": float(battery),
        "total_rebate_aud": float(solar + battery),
        "calculation_basis": "user_supplied_formula_without_eligibility_caps_tiering_or_certificate_rounding",
        "applied_to_solutions": False, "applied_to_finance": False,
        "customer_facing_permission": False,
    }


def stc_calculator_state(session, *, project_id, actor):
    project = require_ci_project(session, project_id=project_id, actor=actor)
    saved = project.stc_calculator_json
    return {"contract_version": "ci_stc_calculator_state_v1", "project_id": str(project_id),
            "estimate": calculate_stc_estimate(CiStcCalculatorInput.model_validate(saved)) if saved is not None else None}


def save_stc_calculator(session, *, project_id, actor, inputs):
    project = require_ci_project(session, project_id=project_id, actor=actor)
    project.stc_calculator_json = inputs.model_dump(mode="json")
    session.flush()
    return stc_calculator_state(session, project_id=project_id, actor=actor)
