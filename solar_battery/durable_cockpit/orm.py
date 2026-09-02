from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Uuid,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


class CiProjectModel(Base):
    __tablename__ = "ci_projects"
    __table_args__ = (
        Index(
            "ix_ci_projects_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    current_stage: Mapped[str] = mapped_column(
        String(32), nullable=False, default="setup"
    )
    setup_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="input_required"
    )
    design_candidate_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    design_candidates_json: Mapped[list[dict[str, object]] | None] = mapped_column(
        JSON
    )
    design_context_json: Mapped[dict[str, object] | None] = mapped_column(JSON)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectEvidenceModel(Base):
    __tablename__ = "ci_project_evidence"
    __table_args__ = (
        Index(
            "ix_ci_project_evidence_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    bill_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    bill_content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    bill_object_store_key: Mapped[str] = mapped_column(String(255), nullable=False)
    bill_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    bill_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    interval_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    interval_content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    interval_object_store_key: Mapped[str] = mapped_column(String(255), nullable=False)
    interval_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    interval_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    inspection_result_json: Mapped[dict[str, object]] = mapped_column(
        JSON, nullable=False
    )
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectSiteMaterialModel(Base):
    __tablename__ = "ci_project_site_material"
    __table_args__ = (
        Index(
            "ix_ci_project_site_material_scope_project_created",
            "workspace_id",
            "owner_id",
            "project_id",
            "created_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    object_store_key: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectFeasibilityResultModel(Base):
    __tablename__ = "ci_project_feasibility_results"
    __table_args__ = (
        Index(
            "ix_ci_project_feasibility_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    result_contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    interval_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    design_candidates_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    result_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    result_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectTariffReplayResultModel(Base):
    __tablename__ = "ci_project_tariff_replay_results"
    __table_args__ = (
        Index(
            "ix_ci_project_tariff_replay_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    result_contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    interval_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    design_candidates_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    tariff_profile_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    result_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    result_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectTariffProfileModel(Base):
    __tablename__ = "ci_project_tariff_profiles"
    __table_args__ = (
        Index(
            "ix_ci_project_tariff_profiles_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    profile_contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    approval_status: Mapped[str] = mapped_column(String(32), nullable=False)
    source_bill_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_interval_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_tariff_facts_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    calculation_profile_sha256: Mapped[str | None] = mapped_column(String(64))
    calculation_profile_json: Mapped[dict[str, object] | None] = mapped_column(JSON)
    approved_by_actor_id: Mapped[str | None] = mapped_column(String(120))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiProjectAnnualFinancialResultModel(Base):
    __tablename__ = "ci_project_annual_financial_results"
    __table_args__ = (
        Index(
            "ix_ci_project_annual_financial_scope_updated",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    project_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    result_contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    tariff_replay_result_sha256: Mapped[str] = mapped_column(
        String(64), nullable=False
    )
    result_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    result_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiDeviceProfileModel(Base):
    __tablename__ = "ci_device_profiles"
    __table_args__ = (
        Index(
            "uq_ci_device_profiles_scope",
            "workspace_id",
            "owner_id",
            unique=True,
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    profile_contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiFinancialSolutionModel(Base):
    __tablename__ = "ci_financial_solutions"
    __table_args__ = (
        Index(
            "ix_ci_financial_solutions_scope",
            "workspace_id",
            "owner_id",
            "updated_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    scenario_id: Mapped[str] = mapped_column(String(120), nullable=False)
    source_physical_scenario_sha256: Mapped[str] = mapped_column(
        String(64), nullable=False
    )
    optimizer_run_snapshot_sha256: Mapped[str | None] = mapped_column(String(64))
    optimizer_run_snapshot_json: Mapped[dict | None] = mapped_column(JSON)
    optimizer_audit_projection_json: Mapped[dict | None] = mapped_column(JSON)
    assumptions_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    metrics_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    starred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiInternalReportArtifactModel(Base):
    __tablename__ = "ci_internal_report_artifacts"
    __table_args__ = (
        Index(
            "uq_ci_internal_report_source",
            "workspace_id",
            "owner_id",
            "source_fingerprint",
            unique=True,
        ),
        Index(
            "ix_ci_internal_report_scope_created",
            "workspace_id",
            "owner_id",
            "created_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    financial_solution_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey("ci_financial_solutions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    report_contract_version: Mapped[str] = mapped_column(String(120), nullable=False)
    renderer_contract_version: Mapped[str] = mapped_column(String(120), nullable=False)
    source_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    source_nem12_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_physical_scenario_sha256: Mapped[str] = mapped_column(
        String(64), nullable=False
    )
    optimizer_run_snapshot_sha256: Mapped[str] = mapped_column(
        String(64), nullable=False
    )
    comparison_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    report_contract_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    html_object_store_key: Mapped[str] = mapped_column(String(255), nullable=False)
    html_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    html_byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    pdf_object_store_key: Mapped[str] = mapped_column(String(255), nullable=False)
    pdf_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    pdf_byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    pdf_renderer_id: Mapped[str] = mapped_column(String(120), nullable=False)
    pdf_renderer_version: Mapped[str] = mapped_column(String(120), nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CiPricingCatalogVersionModel(Base):
    __tablename__ = "ci_pricing_catalog_versions"
    __table_args__ = (
        Index(
            "uq_ci_pricing_catalog_version",
            "workspace_id",
            "owner_id",
            "version_number",
            unique=True,
        ),
        Index(
            "ix_ci_pricing_catalog_scope",
            "workspace_id",
            "owner_id",
            "created_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    catalog_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    catalog_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by_actor_id: Mapped[str | None] = mapped_column(String(120))
