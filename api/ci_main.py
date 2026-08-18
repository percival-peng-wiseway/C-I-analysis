from __future__ import annotations

from fastapi import APIRouter, FastAPI

from api.ci_routes import router as ci_router
from api.schemas import HealthResponse


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
        return HealthResponse(status="healthy")

    app.include_router(api_router)
    return app


app = create_ci_app()
