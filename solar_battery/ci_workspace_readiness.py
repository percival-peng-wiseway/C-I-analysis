from __future__ import annotations

from solar_battery.ci_tariff_analysis import ci_analysis_availability

CI_EVIDENCE_GATE_BLOCKER = {
    "code": "ci_evidence_gate_issue_5",
    "message": (
        "Unavailable while Issue #5 C&I-EVIDENCE-PARKED remains blocked. "
        "No demand-charge, peak-shaving, kVA or power-factor customer-dollar "
        "capability is implied."
    ),
}

_WORKSPACE_AREAS = (
    ("data_qc", "C&I Data QC", "Interval-data suitability and quality evidence."),
    (
        "tariff_mapping",
        "C&I Tariff Mapping",
        "Tariff structure and demand-window evidence.",
    ),
    (
        "peak_shaving",
        "Peak Shaving",
        "Physical dispatch review after explicit battery inputs are provided.",
    ),
    (
        "kw_kva_pf_evidence",
        "kW/kVA/PF Evidence",
        "Power, apparent-power and power-factor evidence.",
    ),
    (
        "scenario_ranking",
        "C&I Scenario Ranking",
        "Physical review ordering after two to four scenarios are run.",
    ),
    (
        "report_preview",
        "C&I Report Preview",
        "In-app physical evidence preview; no downloadable customer report.",
    ),
)


def ci_workspace_readiness_contract() -> dict[str, object]:
    """Return Python-owned C&I readiness, limited by local evidence."""
    supported = ci_analysis_availability()
    evidence_ready = supported["availability"] == "evidence_limited"
    available_ids = {"data_qc", "tariff_mapping", "kw_kva_pf_evidence"}
    return {
        "contract_version": "ci_workspace_readiness_v3",
        "product_id": "commercial_and_industrial",
        "availability": (
            "evidence_limited" if evidence_ready else "unavailable"
        ),
        "active_profile_id": supported["profile_id"],
        "active_profile_label": supported["profile_label"],
        "blockers": [dict(CI_EVIDENCE_GATE_BLOCKER)],
        "workspace_areas": [
            {
                "workspace_id": workspace_id,
                "display_label": display_label,
                "description": description,
                "availability": (
                    "evidence_limited"
                    if evidence_ready and workspace_id in available_ids
                    else "input_required"
                    if evidence_ready
                    else "unavailable"
                ),
            }
            for workspace_id, display_label, description in _WORKSPACE_AREAS
        ],
    }
