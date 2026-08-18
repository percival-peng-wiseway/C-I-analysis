from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import desc, select

from solar_battery.ci_financial_solutions import _canonical_sha256, _serialize
from solar_battery.ci_internal_report_renderer import (
    RENDERER_CONTRACT_VERSION,
    CiInternalReportRenderError,
    render_ci_internal_review_report_html,
)
from solar_battery.durable_cockpit.object_store import ObjectStore
from solar_battery.durable_cockpit.orm import (
    CiFinancialSolutionModel,
    CiInternalReportArtifactModel,
    utcnow,
)
from solar_battery.durable_cockpit.pdf_renderer import (
    PdfRenderError,
    WeasyPrintPdfRenderer,
)


REPORT_CONTRACT_VERSION = "ci_internal_review_report_v1"
ARTIFACTS_CONTRACT_VERSION = "ci_internal_review_report_artifacts_v1"
EXPECTED_PAGE_COUNT = 3


class CiInternalReportError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def prepare_ci_internal_report(
    session,
    *,
    object_store: ObjectStore,
    workspace_id: str,
    owner_id: str,
    actor_id: str,
    financial_solution_id: UUID,
    source: dict[str, object],
) -> dict[str, object]:
    solution_row = session.scalar(
        select(CiFinancialSolutionModel).where(
            CiFinancialSolutionModel.id == financial_solution_id,
            CiFinancialSolutionModel.workspace_id == workspace_id,
            CiFinancialSolutionModel.owner_id == owner_id,
        )
    )
    if solution_row is None:
        raise CiInternalReportError(
            "ci_internal_report_solution_not_found",
            "The saved financial solution is unavailable.",
        )
    contract, source_identity = _build_contract(solution_row, source)
    source_fingerprint = _canonical_sha256(source_identity)
    existing = session.scalar(
        select(CiInternalReportArtifactModel).where(
            CiInternalReportArtifactModel.workspace_id == workspace_id,
            CiInternalReportArtifactModel.owner_id == owner_id,
            CiInternalReportArtifactModel.source_fingerprint == source_fingerprint,
        )
    )
    if existing is not None:
        _validated_bytes(object_store, existing, "html")
        _validated_bytes(object_store, existing, "pdf")
        return _serialize_artifact(existing, created_new=False)

    contract["document"]["prepared_at"] = datetime.now(timezone.utc).isoformat()
    contract["source_identity"]["source_fingerprint"] = source_fingerprint
    try:
        html_bytes = render_ci_internal_review_report_html(contract)
        rendered = WeasyPrintPdfRenderer().render(html_bytes)
    except (CiInternalReportRenderError, PdfRenderError) as exc:
        raise CiInternalReportError(
            "ci_internal_report_render_failed",
            "The internal report could not be rendered safely.",
        ) from exc
    if rendered.page_count != EXPECTED_PAGE_COUNT:
        raise CiInternalReportError(
            "ci_internal_report_page_contract_failed",
            "The internal report did not satisfy its three-page contract.",
        )

    artifact_id = uuid4()
    html_stored = object_store.put_bytes(
        namespace="ci-internal-reports",
        filename_hint="internal-review.html",
        data=html_bytes,
        object_identity=f"{artifact_id.hex}-html",
    )
    try:
        pdf_stored = object_store.put_bytes(
            namespace="ci-internal-reports",
            filename_hint="internal-review.pdf",
            data=rendered.data,
            object_identity=f"{artifact_id.hex}-pdf",
        )
    except Exception:
        object_store.delete(html_stored.storage_key)
        raise
    row = CiInternalReportArtifactModel(
        id=artifact_id,
        workspace_id=workspace_id,
        owner_id=owner_id,
        financial_solution_id=solution_row.id,
        report_contract_version=REPORT_CONTRACT_VERSION,
        renderer_contract_version=RENDERER_CONTRACT_VERSION,
        source_fingerprint=source_fingerprint,
        source_nem12_sha256=source_identity["source_nem12_sha256"],
        source_physical_scenario_sha256=source_identity[
            "source_physical_scenario_sha256"
        ],
        optimizer_run_snapshot_sha256=source_identity[
            "optimizer_run_snapshot_sha256"
        ],
        comparison_sha256=source_identity["comparison_sha256"],
        report_contract_json=contract,
        html_object_store_key=html_stored.storage_key,
        html_sha256=html_stored.sha256_hex,
        html_byte_size=html_stored.size_bytes,
        pdf_object_store_key=pdf_stored.storage_key,
        pdf_sha256=pdf_stored.sha256_hex,
        pdf_byte_size=pdf_stored.size_bytes,
        pdf_renderer_id=rendered.renderer_id,
        pdf_renderer_version=rendered.renderer_version,
        page_count=rendered.page_count,
        created_by_actor_id=actor_id,
        created_at=utcnow(),
    )
    session.add(row)
    try:
        session.flush()
    except Exception:
        object_store.delete(html_stored.storage_key)
        object_store.delete(pdf_stored.storage_key)
        raise
    return _serialize_artifact(row, created_new=True)


def latest_ci_internal_report(
    session, *, object_store: ObjectStore, workspace_id: str, owner_id: str
) -> dict[str, object] | None:
    row = session.scalar(
        select(CiInternalReportArtifactModel)
        .where(
            CiInternalReportArtifactModel.workspace_id == workspace_id,
            CiInternalReportArtifactModel.owner_id == owner_id,
        )
        .order_by(desc(CiInternalReportArtifactModel.created_at))
        .limit(1)
    )
    if row is None:
        return None
    _validated_bytes(object_store, row, "html")
    _validated_bytes(object_store, row, "pdf")
    return _serialize_artifact(row, created_new=False)


def download_ci_internal_report(
    session,
    *,
    object_store: ObjectStore,
    artifact_id: UUID,
    artifact_kind: Literal["html", "pdf"],
    workspace_id: str,
    owner_id: str,
) -> tuple[bytes, str, str]:
    row = session.scalar(
        select(CiInternalReportArtifactModel).where(
            CiInternalReportArtifactModel.id == artifact_id,
            CiInternalReportArtifactModel.workspace_id == workspace_id,
            CiInternalReportArtifactModel.owner_id == owner_id,
        )
    )
    if row is None:
        raise CiInternalReportError(
            "ci_internal_report_not_found", "The internal report is unavailable."
        )
    data = _validated_bytes(object_store, row, artifact_kind)
    if artifact_kind == "html":
        return data, "text/html; charset=utf-8", "ci-internal-review.html"
    return data, "application/pdf", "ci-internal-review.pdf"


def _build_contract(
    solution_row: CiFinancialSolutionModel, source: dict[str, object]
) -> tuple[dict[str, Any], dict[str, str]]:
    if (
        source.get("contract_version") != "ci_internal_report_source_v1"
        or source.get("customer_facing_permission") is not False
        or source.get("recommendation_permitted") is not False
    ):
        raise _source_error()
    analysis = source.get("analysis")
    physical_result = source.get("physical_result")
    comparison = source.get("comparison")
    if not all(isinstance(value, dict) for value in (analysis, physical_result, comparison)):
        raise _source_error()
    if (
        analysis.get("customer_facing_permission") is not False
        or physical_result.get("customer_facing_permission") is not False
        or physical_result.get("recommendation_permitted") is not False
        or comparison.get("customer_facing_permission") is not False
        or comparison.get("recommendation_permitted") is not False
        or comparison.get("eligibility_permitted") is not False
        or comparison.get("delivery_permitted") is not False
    ):
        raise _source_error()
    scenarios = physical_result.get("scenarios")
    if not isinstance(scenarios, list):
        raise _source_error()
    selected = next(
        (
            item
            for item in scenarios
            if isinstance(item, dict) and item.get("scenario_id") == solution_row.scenario_id
        ),
        None,
    )
    if selected is None:
        raise CiInternalReportError(
            "ci_internal_report_solution_mismatch",
            "The saved financial solution does not match the current report scenario.",
        )
    authored_inputs = selected.get("authored_inputs")
    if not isinstance(authored_inputs, dict):
        raise _source_error()
    physical_digest = _canonical_sha256(selected)
    snapshot = selected.get("optimizer_run_snapshot")
    if (
        physical_digest != solution_row.source_physical_scenario_sha256
        or not isinstance(snapshot, dict)
        or snapshot.get("snapshot_sha256")
        != solution_row.optimizer_run_snapshot_sha256
    ):
        raise CiInternalReportError(
            "ci_internal_report_source_mismatch",
            "The current scenario does not match the saved financial solution.",
        )
    comparison_digest = comparison.get("comparison_sha256")
    comparison_without_digest = {
        key: value for key, value in comparison.items() if key != "comparison_sha256"
    }
    cases = comparison.get("cases")
    battery_case = next(
        (item for item in cases if isinstance(item, dict) and item.get("case_id") == "pv_battery"),
        None,
    ) if isinstance(cases, list) else None
    if (
        not _is_sha256(comparison_digest)
        or _canonical_sha256(comparison_without_digest) != comparison_digest
        or not isinstance(battery_case, dict)
        or battery_case.get("scenario_id") != solution_row.scenario_id
        or battery_case.get("optimizer_snapshot_sha256")
        != solution_row.optimizer_run_snapshot_sha256
    ):
        raise CiInternalReportError(
            "ci_internal_report_comparison_mismatch",
            "The three-case comparison does not match the saved financial solution.",
        )
    provenance = comparison.get("provenance")
    source_nem12_sha256 = (
        provenance.get("source_nem12_sha256") if isinstance(provenance, dict) else None
    )
    if not _is_sha256(source_nem12_sha256):
        raise _source_error()
    solution = _serialize(solution_row)
    report_solution = {
        key: value
        for key, value in solution.items()
        if key not in {"starred", "updated_at"}
    }
    source_identity = {
        "report_contract_version": REPORT_CONTRACT_VERSION,
        "renderer_contract_version": RENDERER_CONTRACT_VERSION,
        "financial_solution_id": str(solution_row.id),
        "financial_solution_sha256": _canonical_sha256(report_solution),
        "source_nem12_sha256": source_nem12_sha256,
        "source_physical_scenario_sha256": physical_digest,
        "optimizer_run_snapshot_sha256": solution_row.optimizer_run_snapshot_sha256,
        "comparison_sha256": comparison_digest,
    }
    contract: dict[str, Any] = {
        "contract_version": REPORT_CONTRACT_VERSION,
        "document": {
            "report_label": "Private internal review",
            "prepared_at": None,
            "solution_label": solution_row.label,
        },
        "analysis": analysis,
        "solution": {
            "label": selected.get("label"),
            "configuration": (
                f'{authored_inputs["pv_capacity_kwp_dc"]} kWp PV / '
                f'{authored_inputs["nominal_capacity_kwh"]} kWh battery'
            ),
            "pv_capacity_kwp_dc": authored_inputs["pv_capacity_kwp_dc"],
            "battery_capacity_kwh": authored_inputs["nominal_capacity_kwh"],
            "inverter_kw": authored_inputs["pv_inverter_capacity_kw_ac"],
        },
        "physical_scenario": selected,
        "comparison": comparison,
        "financial_solution": report_solution,
        "assumptions": {
            "discount_rate": solution["assumptions"]["discount_rate"],
            "annual_value_degradation_rate": solution["assumptions"][
                "annual_value_degradation_rate"
            ],
            "analysis_term_years": solution["assumptions"]["analysis_term_years"],
            "annual_om_cost_aud": solution["assumptions"]["annual_om_cost_aud"],
            "replacement_events_aud": solution["assumptions"][
                "replacement_events_aud"
            ],
            "pricing_tax_basis": solution["assumptions"]["pricing_resolution"][
                "tax_basis"
            ],
            "analysis_notes": analysis.get("assumptions", []),
        },
        "limitations": (
            "Estimates are bound to the recorded evidence, tariff profile, scenario, "
            "pricing and finance assumptions. Actual bills and performance may vary. "
            "No eligibility, recommendation, customer claim or delivery permission is granted."
        ),
        "source_identity": {**source_identity, "source_fingerprint": None},
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "eligibility_permitted": False,
        "manual_delivery_permission": False,
        "repository_managed_delivery_permission": False,
    }
    return contract, source_identity


def _validated_bytes(
    object_store: ObjectStore,
    row: CiInternalReportArtifactModel,
    kind: Literal["html", "pdf"],
) -> bytes:
    key = row.html_object_store_key if kind == "html" else row.pdf_object_store_key
    expected_sha = row.html_sha256 if kind == "html" else row.pdf_sha256
    expected_size = row.html_byte_size if kind == "html" else row.pdf_byte_size
    try:
        with object_store.open_read(key) as handle:
            data = handle.read(expected_size + 1)
    except (OSError, ValueError) as exc:
        raise CiInternalReportError(
            "ci_internal_report_integrity_failed",
            "The internal report bytes are unavailable or invalid.",
        ) from exc
    if (
        len(data) != expected_size
        or hashlib.sha256(data).hexdigest() != expected_sha
        or (kind == "html" and not data.startswith(b"<!doctype html>"))
        or (kind == "pdf" and not data.startswith(b"%PDF-"))
    ):
        raise CiInternalReportError(
            "ci_internal_report_integrity_failed",
            "The internal report bytes are unavailable or invalid.",
        )
    return data


def _serialize_artifact(
    row: CiInternalReportArtifactModel, *, created_new: bool
) -> dict[str, object]:
    return {
        "contract_version": ARTIFACTS_CONTRACT_VERSION,
        "artifact_id": str(row.id),
        "status": "ready",
        "display_status": "Ready",
        "created_new": created_new,
        "financial_solution_id": str(row.financial_solution_id),
        "source_fingerprint": row.source_fingerprint,
        "source_nem12_sha256": row.source_nem12_sha256,
        "source_physical_scenario_sha256": row.source_physical_scenario_sha256,
        "optimizer_run_snapshot_sha256": row.optimizer_run_snapshot_sha256,
        "comparison_sha256": row.comparison_sha256,
        "html_sha256": row.html_sha256,
        "html_byte_size": row.html_byte_size,
        "pdf_sha256": row.pdf_sha256,
        "pdf_byte_size": row.pdf_byte_size,
        "renderer_id": row.pdf_renderer_id,
        "renderer_version": row.pdf_renderer_version,
        "page_count": row.page_count,
        "created_at": row.created_at.isoformat(),
        "can_download_html": True,
        "can_download_pdf": True,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "eligibility_permitted": False,
        "manual_delivery_permission": False,
        "repository_managed_delivery_permission": False,
    }


def _source_error() -> CiInternalReportError:
    return CiInternalReportError(
        "ci_internal_report_source_invalid",
        "The current report source is incomplete or unsafe.",
    )


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )
