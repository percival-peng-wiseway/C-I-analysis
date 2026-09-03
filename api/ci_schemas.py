from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictStr,
    field_validator,
    model_validator,
)


class CiFinancialAssumptionsRequest(BaseModel):
    discount_rate: float = Field(ge=0, lt=1)
    annual_value_degradation_rate: float = Field(ge=0, lt=1)
    analysis_term_years: int = Field(ge=1, le=50)


class CiFinancialSolutionRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    scenario_id: str = Field(min_length=1, max_length=120)
    source_physical_scenario: dict[str, object]
    assumptions: CiFinancialAssumptionsRequest
    pricing_catalog_version_id: UUID
    product_ids: list[str] = Field(default_factory=list)
    installation_item_ids: list[str] = Field(default_factory=list)


class CiPricingCatalogReplaceRequest(BaseModel):
    catalog: dict[str, object]


class CiPricingCatalogPublishRequest(BaseModel):
    expected_catalog_hash: str = Field(min_length=64, max_length=64)


class CiFinancialSolutionStarRequest(BaseModel):
    starred: bool


class CiInternalReportRequest(BaseModel):
    financial_solution_id: UUID
    scenarios: list[dict[str, object]] = Field(min_length=2, max_length=200)
    pv_only_scenario_id: str = Field(min_length=1, max_length=120)
    pv_battery_scenario_id: str = Field(min_length=1, max_length=120)


class CiProjectCreateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=255)


class CiProjectTariffProfileSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile: dict[str, object]
    approve_for_calculation: bool = False


class CiProjectRebateProfileSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile: dict[str, object]
    approve_for_calculation: bool = False


class CiProjectStcSettingsSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    solar_stc_enabled: bool
    solar_stc_price_aud_ex_gst: float = Field(ge=0, le=1_000_000)
    battery_stc_enabled: bool
    battery_stc_price_aud_ex_gst: float = Field(ge=0, le=1_000_000)


class CiDeviceProfileRequest(BaseModel):
    contract_version: Literal[
        "ci_device_profile_v2",
        "ci_device_profile_v3",
        "ci_device_profile_v4",
    ] = "ci_device_profile_v2"
    profile_id: Literal["workspace_device_profile"] = "workspace_device_profile"
    currency: Literal["AUD"] = "AUD"
    tax_basis: Literal["gst_exclusive"] = "gst_exclusive"
    pv_cost_aud_per_kwp_dc: float = Field(gt=0, le=1_000_000)
    battery_cost_aud_per_kwh: float = Field(gt=0, le=1_000_000)
    inverter_cost_aud_per_kw_ac: float = Field(gt=0, le=1_000_000)
    equipment_catalog: dict[str, object]
    default_equipment_selection: dict[str, str]
    solution_profiles: dict[str, list[dict[str, object]]] | None = None
    default_solution_profile_selection: dict[str, str] | None = None
    discount_rate: float = Field(default=0.08, ge=0, lt=1)
    annual_value_escalation_rate: float = Field(default=0.025, ge=0, lt=1)
    annual_value_degradation_rate: float = Field(default=0.005, ge=0, lt=1)
    annual_om_fraction_of_capex: float = Field(default=0.015, ge=0, le=0.2)
    analysis_term_years: int = Field(default=15, ge=1, le=50)


class CiSolutionPvRangeRequest(BaseModel):
    minimum_kwp_dc: float = Field(gt=0, le=1_000_000)
    maximum_kwp_dc: float = Field(gt=0, le=1_000_000)
    step_kwp_dc: float = Field(gt=0, le=1_000_000)


class CiSolutionBatteryRangeRequest(BaseModel):
    minimum_kwh: float = Field(ge=0, le=1_000_000)
    maximum_kwh: float = Field(ge=0, le=1_000_000)
    step_kwh: float = Field(gt=0, le=1_000_000)


class CiSolutionSiteFactorsRequest(BaseModel):
    resource_basis: Literal["gross_specific_yield_before_site_losses"]
    resource_source: Literal[
        "analyst_assumption", "site_assessment", "imported_resource_study"
    ]
    resource_label: str = Field(min_length=1, max_length=160)
    annual_specific_yield_kwh_per_kw: float = Field(ge=500, le=3000)
    array_azimuth_degrees: float = Field(ge=0, le=360)
    array_tilt_degrees: float = Field(ge=0, le=90)
    shading_loss_percent: float = Field(ge=0, le=99)
    soiling_loss_percent: float = Field(ge=0, le=99)
    temperature_loss_percent: float = Field(ge=0, le=99)
    wiring_mismatch_loss_percent: float = Field(ge=0, le=99)
    other_system_loss_percent: float = Field(ge=0, le=99)
    system_availability_percent: float = Field(ge=1, le=100)


class CiSolutionConnectionOptionsRequest(BaseModel):
    inverter_block_size_kw: float = Field(ge=0.1, le=1000)
    inverter_quantity: int | None = Field(default=None, ge=1, le=10_000)
    site_ac_headroom_kw: float = Field(gt=0, le=1_000_000)
    allow_grid_charging: bool
    reactive_support_enabled: bool
    reactive_support_max_kvar: float = Field(ge=0, le=1_000_000)
    grid_emissions_factor_kg_co2e_per_kwh: float | None = Field(
        default=None, ge=0, le=5
    )
    initial_soc_basis: Literal["full_soc_physical_upper_bound"]


class CiSolutionGenerationRequest(BaseModel):
    contract_version: Literal["ci_solution_generation_request_v1"]
    pv_range: CiSolutionPvRangeRequest
    battery_range: CiSolutionBatteryRangeRequest
    solar_profile_id: str = Field(min_length=1, max_length=160)
    battery_profile_id: str = Field(min_length=1, max_length=160)
    inverter_profile_id: str | None = Field(default=None, min_length=1, max_length=160)
    site_factors: CiSolutionSiteFactorsRequest
    connection_options: CiSolutionConnectionOptionsRequest


class CiDesignCandidatesRequest(BaseModel):
    scenarios: list[dict[str, object]] | None = Field(
        default=None, min_length=1, max_length=200
    )
    generation_request: CiSolutionGenerationRequest | None = None
    design_context: dict[str, object] | None = None

    @model_validator(mode="after")
    def exactly_one_candidate_source(self):
        if (self.scenarios is None) == (self.generation_request is None):
            raise ValueError(
                "Provide exactly one of scenarios or generation_request."
            )
        if self.generation_request is not None and self.design_context is not None:
            raise ValueError(
                "Generated solutions derive their design context in Python."
            )
        return self


class CiCustomDesignCandidateRequest(BaseModel):
    contract_version: Literal["ci_custom_design_candidate_request_v1"]
    label: str = Field(min_length=1, max_length=80)
    pv_capacity_kwp_dc: float = Field(gt=0, le=1_000_000)
    battery_capacity_kwh: float = Field(ge=0, le=1_000_000)
    inverter_capacity_kw_ac: float = Field(gt=0, le=1_000_000)
    quoted_net_capex_aud_ex_gst: float = Field(gt=0, le=1_000_000_000_000)


class CiIntervalActivityRequest(BaseModel):
    scenario_id: str = Field(min_length=1, max_length=120)
    start_date: date
    days: Literal[1, 3, 7]


class CiScenarioSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_ids: list[StrictStr] = Field(min_length=1, max_length=200)

    @field_validator("scenario_ids")
    @classmethod
    def validate_scenario_ids(
        cls, scenario_ids: list[str]
    ) -> list[str]:
        if any(not scenario_id.strip() for scenario_id in scenario_ids):
            raise ValueError("scenario_ids must contain non-empty strings")
        if len(set(scenario_ids)) != len(scenario_ids):
            raise ValueError("scenario_ids must be unique")
        return scenario_ids


class CiBillReviewRequest(BaseModel):
    confirmed: Literal[True]
    retailer: str = Field(min_length=1, max_length=120)
    invoice_kind: str = Field(min_length=1, max_length=120)
    nmi: str | None = Field(default=None, pattern=r"^[A-Za-z0-9]{10,11}$")
    billing_period_start: date
    billing_period_end: date
    network_tariff_code: str = Field(min_length=1, max_length=40)
    consumption_kwh: float = Field(ge=0)
    highest_metered_demand_kva: float = Field(ge=0)
    power_factor_at_highest_demand: float = Field(ge=0, le=1)
    subtotal_ex_gst_aud: float = Field(ge=0)
    gst_aud: float = Field(ge=0)
    total_inc_gst_aud: float = Field(ge=0)


class CiAnnualFinancialSimulationRequest(BaseModel):
    scenario_id: str = Field(min_length=1, max_length=120)
    value_basis: Literal["battery_incremental", "whole_solution"]
    pricing_catalog_version_id: UUID
    product_ids: list[str] = Field(default_factory=list)
    installation_item_ids: list[str] = Field(default_factory=list)
    discount_rate: float = Field(ge=0, lt=1)
    annual_value_degradation_rate: float = Field(ge=0, lt=1)
    analysis_term_years: int = Field(ge=1, le=50)


class CiAnnualFinancialPriceInput(BaseModel):
    scenario_id: str = Field(min_length=1, max_length=120)
    upfront_cost_aud_ex_gst: float = Field(gt=0, le=10_000_000_000)


class CiAnnualFinancialComparisonRequest(BaseModel):
    pricing_mode: Literal["manual_quotes", "device_profile"] = "manual_quotes"
    prices: list[CiAnnualFinancialPriceInput] = Field(default_factory=list, max_length=200)
    equipment_selection: dict[str, str] | None = None
    discount_rate: float | None = Field(default=None, ge=0, lt=1)
    annual_value_escalation_rate: float | None = Field(default=None, ge=0, lt=1)
    annual_value_degradation_rate: float | None = Field(default=None, ge=0, lt=1)
    annual_om_fraction_of_capex: float | None = Field(default=None, ge=0, le=0.2)
    analysis_term_years: int | None = Field(default=None, ge=1, le=50)
