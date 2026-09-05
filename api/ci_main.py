from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, FastAPI

from api.ci_routes import router as ci_router
from api.schemas import HealthResponse
from solar_battery import ci_peak_shaving_optimizer, ci_scenario_analysis


def _scenario_analysis_source_sha256() -> str:
    """Identify the exact authoritative scenario source in this runtime."""

    return hashlib.sha256(
        Path(ci_scenario_analysis.__file__).read_bytes()
    ).hexdigest()


SCENARIO_ANALYSIS_SOURCE_SHA256 = _scenario_analysis_source_sha256()
OPTIMIZER_SOURCE_SHA256 = hashlib.sha256(
    Path(ci_peak_shaving_optimizer.__file__).read_bytes()
).hexdigest()


def create_ci_app() -> FastAPI:
    app = FastAPI(
        title="Commercial & Industrial Solar Battery Analysis API",
        description=(
            "Evidence-limited internal C&I analysis. Customer-facing, "
            "recommendation and delivery permissions remain unavailable."
        ),
    )
    api_router = APIRouter(prefix="/api")
    api_router.include_router(ci_router)

    @api_router.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="healthy",
            scenario_analysis_source_sha256=(
                SCENARIO_ANALYSIS_SOURCE_SHA256
            ),
            optimizer_source_sha256=OPTIMIZER_SOURCE_SHA256,
        )

    app.include_router(api_router)
    return app


app = create_ci_app()
