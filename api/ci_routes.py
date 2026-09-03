from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import ValidationError

from api.ci_schemas import (
    CiAnnualFinancialComparisonRequest,
    CiAnnualFinancialSimulationRequest,
    CiBillReviewRequest,
    CiDesignCandidatesRequest,
    CiCustomDesignCandidateRequest,
    CiDeviceProfileRequest,
    CiFinancialSolutionRequest,
    CiFinancialSolutionStarRequest,
    CiInternalReportRequest,
    CiIntervalActivityRequest,
    CiPricingCatalogPublishRequest,
    CiPricingCatalogReplaceRequest,
    CiProjectCreateRequest,
    CiProjectRebateProfileSaveRequest,
    CiProjectStcSettingsSaveRequest,
    CiProjectTariffProfileSaveRequest,
)
from api.dependencies import (
    get_durable_session_factory,
    get_identity_provider,
    get_object_store,
)
from solar_battery.ci_component_cost_library import ci_component_cost_library
from solar_battery.ci_annual_financial_demo import (
    analyze_ci_annual_financial_demo,
)
from solar_battery.ci_annual_financial_comparison import (
    compare_ci_annual_financial_scenarios,
    preview_ci_design_candidate_prices,
)
from solar_battery.ci_annual_financial_simulation import (
    simulate_ci_annual_financial_scenario,
)
from solar_battery.ci_evidence_intake import (
    CiEvidenceIntakeError,
    MAX_CI_BILL_UPLOAD_BYTES,
    enrich_ci_evidence_tariff_summary,
    extract_ci_site_address,
    inspect_ci_evidence_pair,
)
from solar_battery.ci_design_feasibility import (
    analyze_ci_design_feasibility,
    analyze_ci_interval_activity,
)
from solar_battery.ci_design_context import (
    CI_DESIGN_CONTEXT_V2_CONTRACT_VERSION,
    legacy_ci_design_context,
    validate_ci_design_context,
)
from solar_battery.ci_device_profile import (
    ci_device_profile_state,
    device_profile_sha256,
    save_ci_device_profile,
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
    update_ci_project_evidence_inspection_if_current,
)
from solar_battery.ci_project_site_material import (
    CI_PROJECT_SITE_MATERIAL_CONTRACT_VERSION,
    MAX_CI_SITE_PHOTO_BYTES,
    CiSitePhotoSource,
    add_ci_project_site_photo,
    list_ci_project_site_photos,
    load_ci_project_site_photo,
    remove_ci_project_site_photo,
)
from solar_battery.ci_project_feasibility import (
    canonical_sha256,
    ci_design_feasibility_state,
    design_candidates_sha256,
    record_ci_design_feasibility_result,
)
from solar_battery.ci_project_annual_financial import (
    ci_annual_financial_state,
    record_ci_annual_financial_result,
)
from solar_battery.ci_project_tariff_replay import (
    ci_tariff_replay_state,
    record_ci_tariff_replay_result,
    tariff_profile_sha256,
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
    saved_ci_design_context,
)
from solar_battery.ci_scenario_analysis import (
    CiScenarioAnalysisError,
    analyze_ci_internal_report_source,
    analyze_ci_physical_scenarios,
    analyze_ci_three_case_comparison,
    validate_ci_design_candidates,
)
from solar_battery.ci_project_tariff_profile import (
    approved_ci_project_tariff_calculation_profile,
    ci_project_tariff_profile_state,
    save_ci_project_tariff_profile,
)
from solar_battery.ci_project_rebate_profile import (
    approved_ci_project_rebate_calculation_profile,
    ci_project_rebate_profile_state,
    rebate_calculation_profile_sha256,
    rebate_profile_has_enabled_program,
    save_ci_project_rebate_profile,
    save_ci_project_stc_settings,
)
from solar_battery.ci_solution_generator import (
    generate_ci_custom_solution,
    generate_ci_solutions,
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


@router.get("/commercial-industrial/settings/device-profile")
def get_ci_device_profile(
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            return ci_device_profile_state(session, actor=actor)
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.put("/commercial-industrial/settings/device-profile")
def put_ci_device_profile(
    payload: CiDeviceProfileRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                return save_ci_device_profile(
                    session,
                    actor=actor,
                    profile=payload.model_dump(exclude_none=True),
                )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


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


@router.get("/commercial-industrial/projects/{project_id}/tariff-profile")
def get_ci_project_tariff_profile(
    project_id: UUID,
    response: Response,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    response.headers["Cache-Control"] = "no-store"
    try:
        with session_factory() as session:
            return ci_project_tariff_profile_state(
                session,
                project_id=project_id,
                actor=actor,
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.put("/commercial-industrial/projects/{project_id}/tariff-profile")
def put_ci_project_tariff_profile(
    project_id: UUID,
    payload: CiProjectTariffProfileSaveRequest,
    response: Response,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    response.headers["Cache-Control"] = "no-store"
    try:
        bill_bytes: bytes | None = None
        interval_bytes: bytes | None = None
        if payload.approve_for_calculation:
            with session_factory() as session:
                bill, interval = load_ci_project_evidence_sources(
                    session,
                    object_store,
                    project_id=project_id,
                    actor=actor,
                )
                bill_bytes = bill.data
                interval_bytes = interval.data
        with session_factory() as session:
            with session.begin():
                return save_ci_project_tariff_profile(
                    session,
                    project_id=project_id,
                    actor=actor,
                    profile=payload.profile,
                    approve_for_calculation=payload.approve_for_calculation,
                    bill_bytes=bill_bytes,
                    interval_bytes=interval_bytes,
                )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.get("/commercial-industrial/projects/{project_id}/rebate-profile")
def get_ci_project_rebate_profile(
    project_id: UUID,
    response: Response,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    response.headers["Cache-Control"] = "no-store"
    try:
        with session_factory() as session:
            return ci_project_rebate_profile_state(
                session,
                project_id=project_id,
                actor=actor,
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.put("/commercial-industrial/projects/{project_id}/rebate-profile")
def put_ci_project_rebate_profile(
    project_id: UUID,
    payload: CiProjectRebateProfileSaveRequest,
    response: Response,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    response.headers["Cache-Control"] = "no-store"
    try:
        with session_factory() as session:
            with session.begin():
                return save_ci_project_rebate_profile(
                    session,
                    project_id=project_id,
                    actor=actor,
                    profile=payload.profile,
                    approve_for_calculation=payload.approve_for_calculation,
                )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.put(
    "/commercial-industrial/projects/{project_id}/rebate-profile/stc-settings"
)
def put_ci_project_stc_settings(
    project_id: UUID,
    payload: CiProjectStcSettingsSaveRequest,
    response: Response,
    identity_provider: Annotated[
        LocalIdentityProvider, Depends(get_identity_provider)
    ],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    response.headers["Cache-Control"] = "no-store"
    try:
        with session_factory() as session:
            with session.begin():
                return save_ci_project_stc_settings(
                    session,
                    project_id=project_id,
                    actor=actor,
                    solar_stc_enabled=payload.solar_stc_enabled,
                    solar_stc_price_aud_ex_gst=payload.solar_stc_price_aud_ex_gst,
                    battery_stc_enabled=payload.battery_stc_enabled,
                    battery_stc_price_aud_ex_gst=payload.battery_stc_price_aud_ex_gst,
                )
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
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            state = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
        evidence = state.get("evidence")
        inspection = evidence.get("inspection") if isinstance(evidence, dict) else None
        bill_result = inspection.get("bill") if isinstance(inspection, dict) else None
        if (
            isinstance(inspection, dict)
            and inspection.get("contract_version")
            in {
                "ci_evidence_intake_v7",
                "ci_evidence_intake_v8",
                "ci_evidence_intake_v9",
            }
            and isinstance(bill_result, dict)
        ):
            try:
                with session_factory() as session:
                    bill_source, interval_source = load_ci_project_evidence_sources(
                        session,
                        object_store,
                        project_id=project_id,
                        actor=actor,
                    )
            except CiProjectError:
                return state
            upgraded = dict(inspection)
            if "site_address" not in bill_result:
                try:
                    site_address = extract_ci_site_address(bill_source.data)
                except CiEvidenceIntakeError:
                    site_address = None
                if site_address is not None:
                    upgraded["contract_version"] = "ci_evidence_intake_v8"
                    upgraded["bill"] = {**bill_result, "site_address": site_address}
                    upgraded["privacy"] = {
                        **dict(inspection.get("privacy", {})),
                        "customer_identifiers_returned": True,
                    }
            try:
                upgraded = enrich_ci_evidence_tariff_summary(
                    upgraded, interval_source.data
                )
            except CiEvidenceIntakeError:
                pass
            if upgraded != inspection:
                expected_saved_at = evidence.get("saved_at")
                with session_factory() as session:
                    with session.begin():
                        if isinstance(expected_saved_at, str):
                            update_ci_project_evidence_inspection_if_current(
                                session,
                                project_id=project_id,
                                actor=actor,
                                expected_saved_at=expected_saved_at,
                                inspection_result=upgraded,
                            )
                with session_factory() as session:
                    state = ci_project_evidence_state(
                        session, project_id=project_id, actor=actor
                    )
        return state
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.get("/commercial-industrial/projects/{project_id}/site-material")
def get_ci_project_site_material(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            photos = list_ci_project_site_photos(
                session, project_id=project_id, actor=actor
            )
        return {
            "contract_version": CI_PROJECT_SITE_MATERIAL_CONTRACT_VERSION,
            "photos": photos,
        }
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/site-material",
    status_code=status.HTTP_201_CREATED,
)
async def post_ci_project_site_material(
    project_id: UUID,
    photo: Annotated[UploadFile, File(...)],
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    actor = identity_provider.current()
    photo_bytes = await photo.read(MAX_CI_SITE_PHOTO_BYTES + 1)
    storage_key: str | None = None
    try:
        with session_factory() as session:
            with session.begin():
                saved_photo, storage_key = add_ci_project_site_photo(
                    session,
                    object_store,
                    project_id=project_id,
                    actor=actor,
                    source=CiSitePhotoSource(
                        filename=photo.filename or "site-photo",
                        content_type=photo.content_type or "application/octet-stream",
                        data=photo_bytes,
                    ),
                )
        return {
            "contract_version": CI_PROJECT_SITE_MATERIAL_CONTRACT_VERSION,
            "photo": saved_photo,
        }
    except CiProjectError as exc:
        if storage_key is not None:
            object_store.delete(storage_key)
        raise _project_http_error(exc) from exc
    except Exception:
        if storage_key is not None:
            object_store.delete(storage_key)
        raise


@router.get(
    "/commercial-industrial/projects/{project_id}/site-material/{photo_id}/content"
)
def get_ci_project_site_material_content(
    project_id: UUID,
    photo_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> Response:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            data, content_type = load_ci_project_site_photo(
                session,
                object_store,
                project_id=project_id,
                photo_id=photo_id,
                actor=actor,
            )
        return Response(
            content=data,
            media_type=content_type,
            headers={"Cache-Control": "private, max-age=300"},
        )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.delete(
    "/commercial-industrial/projects/{project_id}/site-material/{photo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_ci_project_site_material(
    project_id: UUID,
    photo_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> Response:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            with session.begin():
                storage_key = remove_ci_project_site_photo(
                    session,
                    project_id=project_id,
                    photo_id=photo_id,
                    actor=actor,
                )
        object_store.delete(storage_key)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
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
        device_profile = None
        device_profile_digest = None
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Setup & catalog before validating system designs.",
                )
            if payload.generation_request is not None:
                device_state = ci_device_profile_state(session, actor=actor)
                device_profile = (
                    device_state["profile"]
                    if device_state["status"] == "ready"
                    else device_state["suggested_profile"]
                )
                device_profile_digest = (
                    str(device_state["profile_sha256"])
                    if device_state["status"] == "ready"
                    else None
                )
        generation_summary = None
        if payload.generation_request is not None:
            if not isinstance(device_profile, dict):
                raise CiProjectError(
                    "ci_solution_generation_invalid",
                    "A device profile is required to generate solutions.",
                )
            generated = generate_ci_solutions(
                payload.generation_request.model_dump(),
                device_profile=device_profile,
                device_profile_sha256=device_profile_digest,
            )
            validated = validate_ci_design_candidates(generated["candidates"])
            design_context = validate_ci_design_context(
                generated["design_context"]
            )
            generation_summary = generated["generation_summary"]
        else:
            validated = validate_ci_design_candidates(payload.scenarios)
            if (
                isinstance(payload.design_context, dict)
                and payload.design_context.get("contract_version")
                == CI_DESIGN_CONTEXT_V2_CONTRACT_VERSION
            ):
                raise CiProjectError(
                    "ci_design_context_invalid",
                    "Profile-bound design context must be created by the server-side Solution Generator.",
                )
            design_context = validate_ci_design_context(
                payload.design_context
                if payload.design_context is not None
                else legacy_ci_design_context(list(validated["candidates"]))
            )
        result = {
            **validated,
            "design_context": design_context,
        }
        if generation_summary is not None:
            result["generation_summary"] = generation_summary
        with session_factory() as session:
            with session.begin():
                record_ci_design_candidates(
                    session,
                    project_id=project_id,
                    candidate_count=int(result["candidate_count"]),
                    candidates=list(result["candidates"]),
                    design_context=design_context,
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
            design_context = saved_ci_design_context(
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
            "design": {
                **validate_ci_design_candidates(candidates),
                "design_context": (
                    validate_ci_design_context(design_context)
                    if design_context is not None
                    else None
                ),
            },
        }
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/design-candidates/custom"
)
def post_ci_custom_design_candidate(
    project_id: UUID,
    payload: CiCustomDesignCandidateRequest,
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
                    "Complete Setup & catalog before adding a custom system design.",
                )
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
            design_context = saved_ci_design_context(
                session, project_id=project_id, actor=actor
            )
        if candidates is None or design_context is None:
            raise CiProjectError(
                "ci_solution_generation_invalid",
                "Generate and save the profile-bound solution set before adding "
                "a custom solution.",
            )
        context = validate_ci_design_context(design_context)
        generated = generate_ci_custom_solution(
            payload.model_dump(), design_context=context
        )
        candidate = generated["candidate"]
        if not isinstance(candidate, dict):
            raise CiProjectError(
                "ci_solution_generation_invalid",
                "The custom solution could not be created safely.",
            )
        scenario_id = str(candidate["scenario_id"])
        if any(item.get("scenario_id") == scenario_id for item in candidates):
            raise CiProjectError(
                "ci_solution_generation_invalid",
                "This technical configuration already exists. Enter its quotation "
                "in the existing row.",
            )
        validated = validate_ci_design_candidates([*candidates, candidate])
        result = {
            **validated,
            "design_context": context,
            "added_scenario_id": scenario_id,
            "quoted_net_capex_aud_ex_gst": generated[
                "quoted_net_capex_aud_ex_gst"
            ],
            "normalization": generated["normalization"],
        }
        with session_factory() as session:
            with session.begin():
                record_ci_design_candidates(
                    session,
                    project_id=project_id,
                    candidate_count=int(result["candidate_count"]),
                    candidates=list(result["candidates"]),
                    design_context=context,
                    actor=actor,
                )
        return result
    except (CiProjectError, CiScenarioAnalysisError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise _analysis_http_error(exc) from exc


@router.get(
    "/commercial-industrial/projects/{project_id}/design-price-preview"
)
def get_ci_design_price_preview(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    """Price every saved feasible design using approved project assumptions."""
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Evidence before pricing the generated solutions.",
                )
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
            if candidates is None:
                raise CiProjectError(
                    "ci_project_design_required",
                    "Generate the solution space before calculating Net CAPEX.",
                )
            device_state = ci_device_profile_state(session, actor=actor)
            if device_state["status"] != "ready":
                raise CiProjectError(
                    "ci_device_profile_required",
                    "Save the workspace Device profile in Settings before calculating Net CAPEX.",
                )
            rebate_state = ci_project_rebate_profile_state(
                session,
                project_id=project_id,
                actor=actor,
            )
            if _rebate_profile_blocks_finance(rebate_state):
                raise CiProjectError(
                    "ci_project_rebate_profile_required",
                    "Review and approve the enabled project rebate programs before calculating Net CAPEX.",
                )
            rebate_profile = approved_ci_project_rebate_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            result = preview_ci_design_candidate_prices(
                candidates=candidates,
                device_profile=device_state["profile"],
                rebate_profile=rebate_profile,
            )
        result["project_id"] = str(project_id)
        return result
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


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


@router.get(
    "/commercial-industrial/projects/{project_id}/tariff-replay"
)
def get_ci_project_tariff_replay(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    """Restore the latest tariff replay when its evidence is still current."""
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            active_profile = approved_ci_project_tariff_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            return ci_tariff_replay_state(
                session,
                project_id=project_id,
                actor=actor,
                active_tariff_profile=active_profile,
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/tariff-replay"
)
def post_ci_project_tariff_replay(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
    object_store: ObjectStore = Depends(get_object_store),
) -> dict[str, object]:
    """Replay every saved design against the approved evidence-bound tariff."""
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Evidence before running tariff replay.",
                )
            candidates = saved_ci_design_candidates(
                session, project_id=project_id, actor=actor
            )
            feasibility = ci_design_feasibility_state(
                session, project_id=project_id, actor=actor
            )
            evidence = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
            if candidates is None:
                raise CiProjectError(
                    "ci_project_design_required",
                    "Generate the solution space before running tariff replay.",
                )
            if feasibility["status"] != "ready":
                raise CiProjectError(
                    "ci_project_dispatch_required",
                    "Run Dispatch for the current solution space before tariff replay.",
                )
            saved_evidence = evidence.get("evidence")
            inspection = (
                saved_evidence.get("inspection")
                if isinstance(saved_evidence, dict)
                else None
            )
            bill = inspection.get("bill") if isinstance(inspection, dict) else None
            nem12 = inspection.get("nem12") if isinstance(inspection, dict) else None
            bill_approved = isinstance(bill, dict) and bill.get(
                "review_status"
            ) in {"not_required", "analyst_confirmed"}
            tariff_identified = isinstance(bill, dict) and bool(
                bill.get("network_tariff_code")
            )
            interval_ready = isinstance(nem12, dict) and (
                nem12.get("full_tariff_analysis_ready") is True
            )
            if not (bill_approved and tariff_identified and interval_ready):
                raise CiProjectError(
                    "ci_project_tariff_evidence_required",
                    "Tariff replay requires an approved bill with a network tariff code and aligned E1, B1, Q1 and K1 NEM12 streams.",
                )
            _, interval = load_ci_project_evidence_sources(
                session,
                object_store,
                project_id=project_id,
                actor=actor,
            )
            expected_interval_sha256 = hashlib.sha256(interval.data).hexdigest()
            expected_design_sha256 = design_candidates_sha256(candidates)
        with session_factory() as session:
            profile = approved_ci_project_tariff_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
        if profile is None:
            raise CiProjectError(
                "ci_project_tariff_profile_required",
                "Review and approve the project tariff table before running Finance Analysis.",
            )
        expected_profile_sha256 = tariff_profile_sha256(profile)
        result = analyze_ci_physical_scenarios(
            interval.data,
            profile=profile,
            scenarios=candidates,
        )
        with session_factory() as session:
            with session.begin():
                current_profile = approved_ci_project_tariff_calculation_profile(
                    session,
                    project_id=project_id,
                    actor=actor,
                )
                if current_profile is None or tariff_profile_sha256(
                    current_profile
                ) != expected_profile_sha256:
                    raise CiProjectError(
                        "ci_project_tariff_profile_changed",
                        "The approved tariff changed while replay was running. Run it again.",
                    )
                record_ci_tariff_replay_result(
                    session,
                    project_id=project_id,
                    actor=actor,
                    expected_interval_sha256=expected_interval_sha256,
                    expected_design_candidates_sha256=expected_design_sha256,
                    expected_tariff_profile_sha256=expected_profile_sha256,
                    active_tariff_profile=current_profile,
                    result=result,
                )
        return result
    except (CiEvidenceIntakeError, CiProjectError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except (CiTariffAnalysisError, CiScenarioAnalysisError) as exc:
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
        with session_factory() as session:
            profile = approved_ci_project_tariff_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            if profile is None:
                raise CiProjectError(
                    "ci_project_tariff_profile_required",
                    "Review and approve the project tariff table before running Finance Analysis.",
                )
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


@router.get(
    "/commercial-industrial/projects/{project_id}/annual-financial-comparison"
)
def get_ci_annual_financial_comparison(
    project_id: UUID,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            profile = approved_ci_project_tariff_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            rebate_state = ci_project_rebate_profile_state(
                session,
                project_id=project_id,
                actor=actor,
            )
            rebate_profile = approved_ci_project_rebate_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            device_state = ci_device_profile_state(session, actor=actor)
            tariff_state = ci_tariff_replay_state(
                session,
                project_id=project_id,
                actor=actor,
                active_tariff_profile=profile,
            )
            active_tariff_result = (
                tariff_state["result"]
                if tariff_state["status"] == "ready"
                else None
            )
            return ci_annual_financial_state(
                session,
                project_id=project_id,
                actor=actor,
                active_tariff_replay_result=active_tariff_result,
                active_device_profile=(
                    device_state["profile"]
                    if device_state["status"] == "ready"
                    else None
                ),
                active_rebate_profile_sha256=(
                    rebate_calculation_profile_sha256(rebate_profile)
                    if rebate_profile is not None
                    else None
                ),
                rebate_profile_blocks_finance=(
                    _rebate_profile_blocks_finance(rebate_state)
                ),
            )
    except CiProjectError as exc:
        raise _project_http_error(exc) from exc


@router.post(
    "/commercial-industrial/projects/{project_id}/annual-financial-comparison"
)
def post_ci_annual_financial_comparison(
    project_id: UUID,
    payload: CiAnnualFinancialComparisonRequest,
    identity_provider: Annotated[LocalIdentityProvider, Depends(get_identity_provider)],
    session_factory=Depends(get_durable_session_factory),
) -> dict[str, object]:
    actor = identity_provider.current()
    try:
        with session_factory() as session:
            profile = approved_ci_project_tariff_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            if profile is None:
                raise CiProjectError(
                    "ci_project_tariff_profile_required",
                    "Review and approve the project tariff table before running Finance Analysis.",
                )
            rebate_state = ci_project_rebate_profile_state(
                session,
                project_id=project_id,
                actor=actor,
            )
            if _rebate_profile_blocks_finance(rebate_state):
                raise CiProjectError(
                    "ci_project_rebate_profile_required",
                    "Review and approve the enabled project rebate programs before running Finance Analysis.",
                )
            rebate_profile = approved_ci_project_rebate_calculation_profile(
                session,
                project_id=project_id,
                actor=actor,
            )
            expected_rebate_profile_sha256 = (
                rebate_calculation_profile_sha256(rebate_profile)
                if rebate_profile is not None
                else None
            )
            project = require_ci_project(session, project_id=project_id, actor=actor)
            if project.setup_status != "ready":
                raise CiProjectError(
                    "ci_project_setup_required",
                    "Complete Setup & catalog before running annual finance.",
                )
            tariff_state = ci_tariff_replay_state(
                session,
                project_id=project_id,
                actor=actor,
                active_tariff_profile=profile,
            )
            if tariff_state["status"] != "ready":
                raise CiProjectError(
                    "ci_project_tariff_replay_required",
                    "Run Tariff replay before starting Annual finance.",
                )
            tariff_result = tariff_state["result"]
            expected_tariff_result_sha256 = canonical_sha256(tariff_result)
            expected_tariff_profile_sha256 = tariff_profile_sha256(profile)
            device_state = ci_device_profile_state(session, actor=actor)
            device_profile = (
                device_state["profile"]
                if device_state["status"] == "ready"
                else None
            )
            if payload.pricing_mode == "device_profile" and device_profile is None:
                raise CiProjectError(
                    "ci_device_profile_required",
                    "Save the workspace Device profile in Settings before calculating all solutions.",
                )
            expected_device_profile_sha256 = (
                device_profile_sha256(device_profile)
                if payload.pricing_mode == "device_profile"
                and device_profile is not None
                else None
            )
        result = compare_ci_annual_financial_scenarios(
            tariff_replay_result=tariff_result,
            request=payload.model_dump(),
            device_profile=device_profile,
            rebate_profile=rebate_profile,
        )
        result["project_id"] = str(project_id)
        with session_factory() as session:
            with session.begin():
                current_profile = approved_ci_project_tariff_calculation_profile(
                    session,
                    project_id=project_id,
                    actor=actor,
                )
                if (
                    current_profile is None
                    or tariff_profile_sha256(current_profile)
                    != expected_tariff_profile_sha256
                ):
                    raise CiProjectError(
                        "ci_project_annual_financial_inputs_changed",
                        "The approved tariff changed while finance was running. Run finance again.",
                    )
                current_tariff_state = ci_tariff_replay_state(
                    session,
                    project_id=project_id,
                    actor=actor,
                    active_tariff_profile=current_profile,
                )
                current_tariff_result = (
                    current_tariff_state.get("result")
                    if current_tariff_state.get("status") == "ready"
                    else None
                )
                if (
                    not isinstance(current_tariff_result, dict)
                    or canonical_sha256(current_tariff_result)
                    != expected_tariff_result_sha256
                ):
                    raise CiProjectError(
                        "ci_project_annual_financial_inputs_changed",
                        "Tariff replay changed while finance was running. Run finance again.",
                    )
                if expected_device_profile_sha256 is not None:
                    current_device_state = ci_device_profile_state(
                        session,
                        actor=actor,
                    )
                    current_device_profile = (
                        current_device_state.get("profile")
                        if current_device_state.get("status") == "ready"
                        else None
                    )
                    if (
                        not isinstance(current_device_profile, dict)
                        or device_profile_sha256(current_device_profile)
                        != expected_device_profile_sha256
                    ):
                        raise CiProjectError(
                            "ci_project_annual_financial_inputs_changed",
                            "The Device profile changed while finance was running. Run finance again.",
                        )
                current_rebate_state = ci_project_rebate_profile_state(
                    session,
                    project_id=project_id,
                    actor=actor,
                )
                current_rebate_profile = (
                    approved_ci_project_rebate_calculation_profile(
                        session,
                        project_id=project_id,
                        actor=actor,
                        for_update=True,
                    )
                )
                current_rebate_profile_sha256 = (
                    rebate_calculation_profile_sha256(current_rebate_profile)
                    if current_rebate_profile is not None
                    else None
                )
                if (
                    _rebate_profile_blocks_finance(current_rebate_state)
                    or current_rebate_profile_sha256
                    != expected_rebate_profile_sha256
                ):
                    raise CiProjectError(
                        "ci_project_annual_financial_inputs_changed",
                        "The project rebate profile changed while finance was running. Run finance again.",
                    )
                record_ci_annual_financial_result(
                    session,
                    project_id=project_id,
                    actor=actor,
                    expected_tariff_replay_result_sha256=(
                        expected_tariff_result_sha256
                    ),
                    expected_rebate_profile_sha256=(
                        expected_rebate_profile_sha256
                    ),
                    active_tariff_replay_result=current_tariff_result,
                    result=result,
                )
        return result
    except (CiEvidenceIntakeError, CiProjectError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except (
        CiFinancialSolutionError,
        CiScenarioAnalysisError,
        CiTariffAnalysisError,
    ) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "ci_annual_financial_comparison_invalid",
                "message": str(exc),
            },
        ) from exc


@router.get(
    "/commercial-industrial/projects/{project_id}/annual-financial-demo"
)
def get_ci_annual_financial_demo(
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
                    "Complete Setup & catalog before opening the annual finance demo.",
                )
            evidence = ci_project_evidence_state(
                session, project_id=project_id, actor=actor
            )
            _, interval = load_ci_project_evidence_sources(
                session,
                object_store,
                project_id=project_id,
                actor=actor,
            )
        saved = evidence.get("evidence")
        inspection = saved.get("inspection") if isinstance(saved, dict) else None
        if not isinstance(inspection, dict):
            raise CiProjectError(
                "ci_annual_financial_demo_bill_required",
                "A verified electricity bill is required for the finance demo.",
            )
        result = analyze_ci_annual_financial_demo(
            upload_bytes=interval.data,
            inspection_result=inspection,
        )
        result["project_id"] = str(project_id)
        return result
    except (CiEvidenceIntakeError, CiProjectError) as exc:
        if isinstance(exc, CiProjectError):
            raise _project_http_error(exc) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except CiFinancialSolutionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "ci_annual_financial_demo_invalid",
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
            if exc.code in {
                "ci_project_not_found",
                "ci_project_site_material_not_found",
            }
            else status.HTTP_409_CONFLICT
            if exc.code
            in {
                "ci_project_setup_required",
                "ci_project_evidence_inputs_changed",
                "ci_project_tariff_profile_changed",
                "ci_project_rebate_profile_required",
                "ci_project_annual_financial_inputs_changed",
            }
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        ),
        detail={"code": exc.code, "message": str(exc)},
    )


def _rebate_profile_blocks_finance(state: dict[str, object]) -> bool:
    return (
        state.get("status") in {"draft", "stale"}
        and rebate_profile_has_enabled_program(state.get("profile"))
    )
