from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


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


class CiDeviceProfileRequest(BaseModel):
    contract_version: Literal["ci_device_profile_v2"] = "ci_device_profile_v2"
    profile_id: Literal["workspace_device_profile"] = "workspace_device_profile"
    currency: Literal["AUD"] = "AUD"
    tax_basis: Literal["gst_exclusive"] = "gst_exclusive"
    pv_cost_aud_per_kwp_dc: float = Field(gt=0, le=1_000_000)
    battery_cost_aud_per_kwh: float = Field(gt=0, le=1_000_000)
    inverter_cost_aud_per_kw_ac: float = Field(gt=0, le=1_000_000)
    equipment_catalog: dict[str, object]
    default_equipment_selection: dict[str, str]
    discount_rate: float = Field(default=0.08, ge=0, lt=1)
    annual_value_escalation_rate: float = Field(default=0.025, ge=0, lt=1)
    annual_value_degradation_rate: float = Field(default=0.005, ge=0, lt=1)
    annual_om_fraction_of_capex: float = Field(default=0.015, ge=0, le=0.2)
    analysis_term_years: int = Field(default=15, ge=1, le=50)


class CiDesignCandidatesRequest(BaseModel):
    scenarios: list[dict[str, object]] = Field(min_length=1, max_length=200)
    design_context: dict[str, object] | None = None


class CiIntervalActivityRequest(BaseModel):
    scenario_id: str = Field(min_length=1, max_length=120)
    start_date: date
    days: Literal[1, 3, 7]


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
