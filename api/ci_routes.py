from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import ValidationError

from api.ci_schemas import (
    CiAnnualFinancialSimulationRequest,
    CiBillReviewRequest,
    CiDesignCandidatesRequest,
    CiFinancialSolutionRequest,
    CiFinancialSolutionStarRequest,
    CiInternalReportRequest,
    CiIntervalActivityRequest,
    CiPricingCatalogPublishRequest,
    CiPricingCatalogReplaceRequest,
    CiProjectCreateRequest,
)
from api.dependencies import (
    get_durable_session_factory,
    get_identity_provider,
    get_object_store,
)
from solar_battery.ci_component_cost_library import ci_component_cost_library
from solar_battery.ci_annual_financial_simulation import (
    simulate_ci_annual_financial_scenario,
)
from solar_battery.ci_evidence_intake import (
    CiEvidenceIntakeError,
    MAX_CI_BILL_UPLOAD_BYTES,
    inspect_ci_evidence_pair,
)
from solar_battery.ci_design_feasibility import (
    analyze_ci_design_feasibility,
    analyze_ci_interval_activity,
)
from solar_battery.ci_financial_solutions import (
    CiFinancialSolutionError,
    list_solutions as list_ci_financial_solutions,
    save_solution as save_ci_financial_solution,
    set_starred as set_ci_financial_solution_starred,
)
from solar_battery.ci_internal_report import (
    CiInternalReportError,
    download_ci_internal_report,
    latest_ci_internal_report,
    prepare_ci_internal_report,
)
from solar_battery.ci_project_evidence import (
    CiEvidenceSource,
    ci_project_evidence_state,
    load_ci_project_evidence_sources,
    record_ci_project_evidence,
    store_ci_project_evidence_files,
    update_ci_project_evidence_inspection,
)
from solar_battery.ci_project_feasibility import (
    ci_design_feasibility_state,
    design_candidates_sha256,
    record_ci_design_feasibility_result,
)
from solar_battery.ci_pricing_catalog import (
    CiPricingCatalogError,
    create_draft as create_ci_pricing_draft,
    list_versions as list_ci_pricing_versions,
    publish as publish_ci_pricing_catalog,
    replace_draft as replace_ci_pricing_draft,
)
from solar_battery.ci_projects import (
    CiProjectError,
    create_ci_project,
    list_ci_projects,
    mark_ci_setup_action_required,
    mark_ci_financial_simulation_ready,
    mark_ci_setup_ready,
    record_ci_design_candidates,
    require_ci_project,
    saved_ci_design_candidates,
)
from solar_battery.ci_scenario_analysis import (
    CiScenarioAnalysisError,
    analyze_ci_internal_report_source,
    analyze_ci_physical_scenarios,
    analyze_ci_three_case_comparison,
    validate_ci_design_candidates,
)
from solar_battery.ci_tariff_analysis import (
    CiTariffAnalysisError,
    MAX_CI_NEM12_UPLOAD_BYTES,
    analyze_ci_nem12,
    load_ci_tariff_profile,
)
from solar_battery.ci_workspace_readiness import ci_workspace_readiness_contract
from solar_battery.durable_cockpit.identity import LocalIdentityProvider
from solar_battery.durable_cockpit.object_store import ObjectStore


router = APIRouter(tags=["commercial-industrial"])


@router.get("/commercial-industrial/workspace-readiness")
def get_ci_workspace_readiness() -> dict[str, object]:
    return ci_workspace_readiness_contract()


@router.get("/commercial-industrial/projects")
def get_ci_projects(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    with session_factory() as session:
        return {
            "contract_version": "ci_project_registry_v1",
            "projects": list_ci_projects(session, actor=actor),
        }


@router.post(
    "/commercial-industrial/projects",
    status_code=status.HTTP_201_CREATED,
)
def post_ci_project(
    payload: CiProjectCreateRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                project = create_ci_project(
                    session, display_name=payload.display_name, actor=actor
                )
        return {"contract_version": "ci_project_v1", **project}
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/evidence-intake/inspect"
)
async def inspect_ci_project_evidence_uploads(
    project_id: UUID,
    bill: Annotated[UploadFile, File(...)],
    nem12: Annotated[UploadFile, File(...)],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
    bill_review_payload: Annotated[str | None, Form()] = None,
) -> dict[str, object]:
    actor = identity_provider.current()
    bill_bytes = await bill.read(MAX_CI_BILL_UPLOAD_BYTES + 1)
    nem12_bytes = await nem12.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        bill_review = (
            CiBillReviewRequest.model_validate_json(bill_review_payload).model_dump(
                mode="json"
            )
            if bill_review_payload is not None
            else None
        )
        with session_factory() as session:
            require_ci_project(session, project_id=project_id, actor=actor)
        result = inspect_ci_evidence_pair(
            bill_bytes,
            nem12_bytes,
            bill_review=bill_review,
            files_persisted=True,
        )
        bill_source = CiEvidenceSource(
            bill.filename or "bill.pdf",
            bill.content_type or "application/pdf",
            bill_bytes,
        )
        interval_source = CiEvidenceSource(
            nem12.filename or "interval.csv",
            nem12.content_type or "text/csv",
            nem12_bytes,
        )
        bill_object, interval_object = store_ci_project_evidence_files(
            object_store,
            project_id=project_id,
            bill=bill_source,
            interval=interval_source,
        )
        try:
            with session_factory() as session:
                with session.begin():
                    old_keys = record_ci_project_evidence(
                        session,
                        project_id=project_id,
                        actor=actor,
                        bill=bill_source,
                        interval=interval_source,
                        bill_object=bill_object,
                        interval_object=interval_object,
                        inspection_result=result,
                    )
                    if result["intake_status"] == "ready_for_profile_review":
                        mark_ci_setup_ready(
                            session, project_id=project_id, actor=actor
                        )
                    else:
                        mark_ci_setup_action_required(
                            session, project_id=project_id, actor=actor
                        )
        except Exception:
            object_store.delete(bill_object.storage_key)
            object_store.delete(interval_object.storage_key)
            raise
        for old_key in old_keys:
            object_store.delete(old_key)
        return result
    except (CiEvidenceIntakeError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": getattr(exc, "code", "bill_review_invalid"),
                "message": str(exc),
            },
        ) from exc
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.get(
    "/commercial-industrial/projects/{project_id}/evidence-intake"
)
def get_ci_project_evidence(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            return ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/evidence-intake/review"
)
def review_saved_ci_project_evidence(
    project_id: UUID,
    payload: CiBillReviewRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            bill_source, interval_source = load_ci_project_evidence_sources(
                session,
                object_store,
                project_id=project_id,
                actor=actor,
            )
        result = inspect_ci_evidence_pair(
            bill_source.data,
            interval_source.data,
            bill_review=payload.model_dump(mode="json"),
            files_persisted=True,
        )
        with session_factory() as session:
            with session.begin():
                update_ci_project_evidence_inspection(
                    session,
                    project_id=project_id,
                    actor=actor,
                    inspection_result=result,
                )
                if result["intake_status"] == "ready_for_profile_review":
                    mark_ci_setup_ready(session, project_id=project_id, actor=actor)
                else:
                    mark_ci_setup_action_required(
                        session, project_id=project_id, actor=actor
                    )
        return result
    except CiEvidenceIntakeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/design-candidates"
)
def post_ci_design_candidates(
    project_id: UUID,
    payload: CiDesignCandidatesRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Setup & catalog before validating system designs.",
                )
        result = validate_ci_design_candidates(payload.scenarios)
        with session_factory() as session:
            with session.begin():
                record_ci_design_candidates(
                    session,
                    project_id=project_id,
                    candidate_count=int(result["candidate_count"]),
                    candidates=list(result["candidates"]),
                    actor=actor,
                )
        return result
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.get(
    "/commercial-industrial/projects/{project_id}/design-candidates"
)
def get_ci_design_candidates(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
        if candidates is None:
            return {
                "contract_version": "ci_saved_design_state_v1",
                "status": "not_saved",
                "design": None,
            }
        return {
            "contract_version": "ci_saved_design_state_v1",
            "status": "ready",
            "design": validate_ci_design_candidates(candidates),
        }
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/design-feasibility"
)
def post_ci_design_feasibility(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Setup & catalog before running system feasibility.",
                )
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
            if candidates is None:
                raise CiProjectError(
                    "ci_project_design_required",
                    "Save and validate the system design before running feasibility.",
                )
            _, interval = load_ci_project_evidence_sources(
                session,
                object_store,
                project_id=project_id,
                actor=actor,
            )
        interval_sha256 = hashlib.sha256(interval.data).hexdigest()
        candidates_sha256 = design_candidates_sha256(candidates)
        result = analyze_ci_design_feasibility(
            interval.data, scenarios=candidates
        )
        with session_factory() as session:
            with session.begin():
                record_ci_design_feasibility_result(
                    session,
                    project_id=project_id,
                    actor=actor,
                    expected_interval_sha256=interval_sha256,
                    expected_design_candidates_sha256=candidates_sha256,
                    result=result,
                )
        return result
    except CiEvidenceIntakeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.get(
    "/commercial-industrial/projects/{project_id}/design-feasibility"
)
def get_ci_design_feasibility(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            return ci_design_feasibility_state(
                session, project_id=project_id, actor=actor
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/design-feasibility/interval-activity"
)
def post_ci_interval_activity(
    project_id: UUID,
    payload: CiIntervalActivityRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Setup & catalog before loading interval activity.",
                )
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
            if candidates is None:
                raise CiProjectError(
                    "ci_project_design_required",
                    "Save and validate the system design before loading interval activity.",
                )
            _, interval = load_ci_project_evidence_sources(
                session,
                object_store,
                project_id=project_id,
                actor=actor,
            )
        return analyze_ci_interval_activity(
            interval.data,
            scenarios=candidates,
            scenario_id=payload.scenario_id,
            start_date=payload.start_date,
            days=payload.days,
        )
    except CiEvidenceIntakeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/annual-financial-simulation"
)
async def post_ci_annual_financial_simulation(
    project_id: UUID,
    file: Annotated[UploadFile, File(...)],
    payload: Annotated[str, Form(...)],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        request = CiAnnualFinancialSimulationRequest.model_validate_json(payload)
        profile = load_ci_tariff_profile()
        with session_factory() as session:
            result = simulate_ci_annual_financial_scenario(
                session,
                project_id=project_id,
                actor=actor,
                upload_bytes=upload_bytes,
                profile=profile,
                request=request.model_dump(),
            )
        with session_factory() as session:
            with session.begin():
                mark_ci_financial_simulation_ready(
                    session, project_id=project_id, actor=actor
                )
        return result
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc
    except (
        CiFinancialSolutionError,
        CiPricingCatalogError,
        CiScenarioAnalysisError,
        CiTariffAnalysisError,
        ValidationError,
    ) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "ci_annual_financial_simulation_invalid",
                "message": str(exc),
            },
        ) from exc


@router.post("/commercial-industrial/evidence-intake/inspect")
async def inspect_ci_evidence_uploads(
    bill: Annotated[UploadFile, File(...)],
    nem12: Annotated[UploadFile, File(...)],
    identity_provider: Annotated[
        LocalIdentityProvider, Depends(get_identity_provider)
    ],
) -> dict[str, object]:
    identity_provider.current()
    bill_bytes = await bill.read(MAX_CI_BILL_UPLOAD_BYTES + 1)
    nem12_bytes = await nem12.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        return inspect_ci_evidence_pair(bill_bytes, nem12_bytes)
    except CiEvidenceIntakeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc


@router.get("/commercial-industrial/component-cost-library")
def get_ci_component_cost_library() -> dict[str, object]:
    return ci_component_cost_library()


@router.get("/commercial-industrial/pricing-catalog")
def get_ci_pricing_catalog(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    with session_factory() as session:
        return {
            "response_kind": "ci_pricing_catalog_versions",
            "versions": list_ci_pricing_versions(
                session,
                workspace_id=actor.workspace_id,
                owner_id=actor.owner_id,
            ),
        }


@router.post(
    "/commercial-industrial/pricing-catalog/drafts",
    status_code=status.HTTP_201_CREATED,
)
def post_ci_pricing_catalog_draft(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    with session_factory() as session:
        with session.begin():
            return create_ci_pricing_draft(
                session,
                workspace_id=actor.workspace_id,
                owner_id=actor.owner_id,
                actor_id=actor.actor_id,
            )


@router.put("/commercial-industrial/pricing-catalog/drafts/{version_id}")
def put_ci_pricing_catalog_draft(
    version_id: UUID,
    payload: CiPricingCatalogReplaceRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                return replace_ci_pricing_draft(
                    session,
                    version_id=version_id,
                    catalog=payload.catalog,
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                )
    except CiPricingCatalogError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "ci_pricing_catalog_invalid", "message": str(exc)},
        ) from exc


@router.post("/commercial-industrial/pricing-catalog/drafts/{version_id}/publish")
def post_ci_pricing_catalog_publish(
    version_id: UUID,
    payload: CiPricingCatalogPublishRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                return publish_ci_pricing_catalog(
                    session,
                    version_id=version_id,
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                    actor_id=actor.actor_id,
                    expected_hash=payload.expected_catalog_hash,
                )
    except CiPricingCatalogError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "ci_pricing_catalog_invalid", "message": str(exc)},
        ) from exc


@router.get("/commercial-industrial/financial-solutions")
def get_ci_financial_solutions(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    with session_factory() as session:
        return {
            "response_kind": "ci_financial_solution_list",
            "solutions": list_ci_financial_solutions(
                session,
                workspace_id=actor.workspace_id,
                owner_id=actor.owner_id,
            ),
        }


@router.post(
    "/commercial-industrial/financial-solutions",
    status_code=status.HTTP_201_CREATED,
)
async def post_ci_financial_solution(
    file: Annotated[UploadFile, File(...)],
    payload: Annotated[str, Form(...)],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        request = CiFinancialSolutionRequest.model_validate_json(payload)
        upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
        if request.source_physical_scenario.get("scenario_id") != request.scenario_id:
            raise CiFinancialSolutionError("physical scenario identity does not match")
        authored_inputs = request.source_physical_scenario.get("authored_inputs")
        if not isinstance(authored_inputs, dict):
            raise CiFinancialSolutionError("physical scenario inputs are missing")
        profile = load_ci_tariff_profile()
        analysis = analyze_ci_physical_scenarios(
            upload_bytes,
            profile=profile,
            scenarios=[
                {
                    "scenario_id": request.scenario_id,
                    "label": request.label,
                    **authored_inputs,
                }
            ],
        )
        authoritative_scenario = analysis["scenarios"][0]
        with session_factory() as session:
            with session.begin():
                return save_ci_financial_solution(
                    session,
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                    actor_id=actor.actor_id,
                    label=request.label,
                    scenario_id=request.scenario_id,
                    source_physical_scenario=authoritative_scenario,
                    assumptions=request.assumptions.model_dump(),
                    pricing_catalog_version_id=request.pricing_catalog_version_id,
                    product_ids=request.product_ids,
                    installation_item_ids=request.installation_item_ids,
                )
    except (
        CiFinancialSolutionError,
        CiPricingCatalogError,
        CiScenarioAnalysisError,
        CiTariffAnalysisError,
        ValidationError,
    ) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "ci_financial_solution_invalid", "message": str(exc)},
        ) from exc


@router.patch("/commercial-industrial/financial-solutions/{solution_id}/star")
def patch_ci_financial_solution_star(
    solution_id: UUID,
    payload: CiFinancialSolutionStarRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                return set_ci_financial_solution_starred(
                    session,
                    solution_id=solution_id,
                    starred=payload.starred,
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                    actor_id=actor.actor_id,
                )
    except CiFinancialSolutionError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ci_financial_solution_not_found", "message": str(exc)},
        ) from exc


@router.get("/commercial-industrial/internal-review-report")
def get_ci_internal_review_report(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    object_store: Annotated[ObjectStore, Depends(get_object_store)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            artifact = latest_ci_internal_report(
                session,
                object_store=object_store,
                workspace_id=actor.workspace_id,
                owner_id=actor.owner_id,
            )
    except CiInternalReportError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    return {
        "response_kind": "ci_internal_review_report_state",
        "artifact": artifact,
    }


@router.post(
    "/commercial-industrial/internal-review-report",
    status_code=status.HTTP_201_CREATED,
)
async def post_ci_internal_review_report(
    file: Annotated[UploadFile, File(...)],
    payload: Annotated[str, Form(...)],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    object_store: Annotated[ObjectStore, Depends(get_object_store)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        request = CiInternalReportRequest.model_validate_json(payload)
        profile = load_ci_tariff_profile()
        source = analyze_ci_internal_report_source(
            upload_bytes,
            profile=profile,
            scenarios=request.scenarios,
            pv_only_scenario_id=request.pv_only_scenario_id,
            pv_battery_scenario_id=request.pv_battery_scenario_id,
        )
        with session_factory() as session:
            with session.begin():
                return prepare_ci_internal_report(
                    session,
                    object_store=object_store,
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                    actor_id=actor.actor_id,
                    financial_solution_id=request.financial_solution_id,
                    source=source,
                )
    except (
        CiTariffAnalysisError,
        CiScenarioAnalysisError,
        CiInternalReportError,
        ValidationError,
    ) as exc:
        code = getattr(exc, "code", "ci_internal_report_invalid")
        raise HTTPException(
            status_code=(
                status.HTTP_409_CONFLICT
                if code in {"profile_unavailable", "profile_invalid"}
                else status.HTTP_422_UNPROCESSABLE_ENTITY
            ),
            detail={"code": code, "message": str(exc)},
        ) from exc


@router.get(
    "/commercial-industrial/internal-review-report/{artifact_id}.{artifact_kind}"
)
def download_ci_internal_review_report(
    artifact_id: UUID,
    artifact_kind: Literal["html", "pdf"],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    object_store: Annotated[ObjectStore, Depends(get_object_store)],
    session_factory=Depends(get_durable_session_factory),
) -> Response:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            data, content_type, filename = download_ci_internal_report(
                session,
                object_store=object_store,
                artifact_id=artifact_id,
                artifact_kind=artifact_kind,
                workspace_id=actor.workspace_id,
                owner_id=actor.owner_id,
            )
    except CiInternalReportError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/commercial-industrial/powercor-llvt2-analysis")
async def analyze_powercor_llvt2_upload(
    file: Annotated[UploadFile, File(...)],
    identity_provider: Annotated[
        LocalIdentityProvider, Depends(get_identity_provider)
    ],
) -> dict[str, object]:
    identity_provider.current()
    upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        profile = load_ci_tariff_profile()
        return analyze_ci_nem12(upload_bytes, profile=profile)
    except CiTariffAnalysisError as exc:
        raise _analysis_http_error(exc) from exc


@router.post("/commercial-industrial/powercor-llvt2-physical-scenarios")
async def analyze_powercor_llvt2_physical_scenarios(
    file: Annotated[UploadFile, File(...)],
    scenarios: Annotated[str, Form(...)],
    identity_provider: Annotated[
        LocalIdentityProvider, Depends(get_identity_provider)
    ],
) -> dict[str, object]:
    identity_provider.current()
    upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        try:
            scenario_payload = json.loads(scenarios)
        except (json.JSONDecodeError, TypeError) as exc:
            raise CiScenarioAnalysisError("scenario_contract_invalid") from exc
        profile = load_ci_tariff_profile()
        return analyze_ci_physical_scenarios(
            upload_bytes,
            profile=profile,
            scenarios=scenario_payload,
        )
    except (CiTariffAnalysisError, CiScenarioAnalysisError) as exc:
        raise _analysis_http_error(exc) from exc


@router.post("/commercial-industrial/powercor-llvt2-three-case-comparison")
async def analyze_powercor_llvt2_three_case_comparison(
    file: Annotated[UploadFile, File(...)],
    scenarios: Annotated[str, Form(...)],
    pv_only_scenario_id: Annotated[str, Form(...)],
    pv_battery_scenario_id: Annotated[str, Form(...)],
    identity_provider: Annotated[
        LocalIdentityProvider, Depends(get_identity_provider)
    ],
) -> dict[str, object]:
    identity_provider.current()
    upload_bytes = await file.read(MAX_CI_NEM12_UPLOAD_BYTES + 1)
    try:
        try:
            scenario_payload = json.loads(scenarios)
        except (json.JSONDecodeError, TypeError) as exc:
            raise CiScenarioAnalysisError("comparison_contract_invalid") from exc
        profile = load_ci_tariff_profile()
        return analyze_ci_three_case_comparison(
            upload_bytes,
            profile=profile,
            scenarios=scenario_payload,
            pv_only_scenario_id=pv_only_scenario_id,
            pv_battery_scenario_id=pv_battery_scenario_id,
        )
    except (CiTariffAnalysisError, CiScenarioAnalysisError) as exc:
        raise _analysis_http_error(exc) from exc


def _analysis_http_error(
    exc: CiTariffAnalysisError | CiScenarioAnalysisError,
) -> HTTPException:
    return HTTPException(
        status_code=(
            status.HTTP_409_CONFLICT
            if exc.code in {"profile_unavailable", "profile_invalid"}
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        ),
        detail={"code": exc.code, "message": str(exc)},
    )


def _project_http_error(exc: CiProjectError) -> HTTPException:
    return HTTPException(
        status_code=(
            status.HTTP_404_NOT_FOUND
            if exc.code == "ci_project_not_found"
            else status.HTTP_409_CONFLICT
            if exc.code == "ci_project_setup_required"
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        ),
        detail={"code": exc.code, "message": str(exc)},
    )
