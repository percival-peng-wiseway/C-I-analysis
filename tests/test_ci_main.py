from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from api.ci_main import app
from solar_battery import ci_peak_shaving_optimizer, ci_scenario_analysis


def test_health_identifies_the_running_scenario_analysis_source() -> None:
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "scenario_analysis_source_sha256": hashlib.sha256(
            Path(ci_scenario_analysis.__file__).read_bytes()
        ).hexdigest(),
        "optimizer_source_sha256": hashlib.sha256(
            Path(ci_peak_shaving_optimizer.__file__).read_bytes()
        ).hexdigest(),
    }
