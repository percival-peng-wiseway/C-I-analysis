"""Shared schemas for the current API root."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
