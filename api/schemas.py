"""Shared schemas for the current API root."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    scenario_analysis_source_sha256: str
    optimizer_source_sha256: str
