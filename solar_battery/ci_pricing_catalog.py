from __future__ import annotations

import hashlib
import json
import math
from uuid import UUID, uuid4

from sqlalchemy import desc, select

from solar_battery.durable_cockpit.orm import CiPricingCatalogVersionModel, utcnow


CONTRACT_VERSION = "ci_pricing_catalog_v1"
CATALOG_ID = "ci_solution_pricing"
PRICE_BASES = {
    "fixed",
    "per_kwh_capacity",
    "per_kw_discharge",
    "per_kw_pv_dc",
    "size_cost_table",
}
SIZE_METRICS = {
    "pv_kwp_dc",
    "pv_inverter_kw_ac",
    "battery_inverter_kw_ac",
    "battery_kwh",
    "battery_kw_discharge",
}


class CiPricingCatalogError(ValueError):
    pass


def blank_catalog() -> dict[str, object]:
    return {
        "contract_version": CONTRACT_VERSION,
        "catalog_id": CATALOG_ID,
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "products": [],
        "installation_items": [],
    }


def validate_catalog(catalog: dict[str, object], *, require_items: bool = True) -> list[str]:
    errors: list[str] = []
    if catalog.get("contract_version") != CONTRACT_VERSION:
        errors.append("contract_version is invalid")
    if catalog.get("catalog_id") != CATALOG_ID:
        errors.append("catalog_id is invalid")
    if catalog.get("currency") != "AUD":
        errors.append("currency must be AUD")
    if catalog.get("tax_basis") not in {"gst_inclusive", "gst_exclusive"}:
        errors.append("tax_basis must be gst_inclusive or gst_exclusive")
    all_ids: set[str] = set()
    item_count = 0
    for group in ("products", "installation_items"):
        items = catalog.get(group)
        if not isinstance(items, list):
            errors.append(f"{group} must be a list")
            continue
        for index, item in enumerate(items):
            item_count += 1
            prefix = f"{group}[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            item_id = str(item.get("item_id", "")).strip()
            label = str(item.get("label", "")).strip()
            if not item_id or item_id in all_ids:
                errors.append(f"{prefix}.item_id must be present and globally unique")
            all_ids.add(item_id)
            if not label or len(label) > 120:
                errors.append(f"{prefix}.label is invalid")
            if item.get("pricing_basis") not in PRICE_BASES:
                errors.append(f"{prefix}.pricing_basis is invalid")
            if item.get("pricing_basis") == "size_cost_table":
                _validate_cost_table(item, prefix, errors)
            else:
                try:
                    price = float(item.get("unit_price_aud"))
                    if not math.isfinite(price) or price < 0:
                        raise ValueError
                except (TypeError, ValueError):
                    errors.append(f"{prefix}.unit_price_aud must be non-negative")
            if item.get("effective_status") not in {"active", "inactive"}:
                errors.append(f"{prefix}.effective_status is invalid")
            if group == "products" and item.get("category") not in {
                "solar_pv", "battery", "pcs_inverter", "switchgear", "ems", "other"
            }:
                errors.append(f"{prefix}.category is invalid")
    if require_items and item_count == 0:
        errors.append("at least one product or installation item is required")
    return errors


def list_versions(session, *, workspace_id: str, owner_id: str) -> list[dict[str, object]]:
    rows = session.scalars(
        select(CiPricingCatalogVersionModel)
        .where(
            CiPricingCatalogVersionModel.workspace_id == workspace_id,
            CiPricingCatalogVersionModel.owner_id == owner_id,
        )
        .order_by(desc(CiPricingCatalogVersionModel.version_number))
    ).all()
    return [_serialize(row) for row in rows]


def create_draft(session, *, workspace_id: str, owner_id: str, actor_id: str) -> dict[str, object]:
    current = session.scalar(
        select(CiPricingCatalogVersionModel)
        .where(
            CiPricingCatalogVersionModel.workspace_id == workspace_id,
            CiPricingCatalogVersionModel.owner_id == owner_id,
        )
        .order_by(desc(CiPricingCatalogVersionModel.version_number))
    )
    if current is not None and current.status == "draft":
        return _serialize(current)
    payload = json.loads(json.dumps(current.catalog_json)) if current else blank_catalog()
    row = CiPricingCatalogVersionModel(
        id=uuid4(), workspace_id=workspace_id, owner_id=owner_id,
        version_number=(current.version_number + 1 if current else 1), status="draft",
        catalog_json=payload, catalog_hash=_digest(payload), created_by_actor_id=actor_id,
        created_at=utcnow(), published_at=None, published_by_actor_id=None,
    )
    session.add(row); session.flush()
    return _serialize(row)


def replace_draft(session, *, version_id: UUID, catalog: dict[str, object], workspace_id: str, owner_id: str) -> dict[str, object]:
    row = _owned(session, version_id, workspace_id, owner_id)
    if row.status != "draft":
        raise CiPricingCatalogError("only a draft catalog can be edited")
    errors = validate_catalog(catalog, require_items=False)
    if errors:
        raise CiPricingCatalogError("; ".join(errors))
    row.catalog_json = catalog
    row.catalog_hash = _digest(catalog)
    session.flush()
    return _serialize(row)


def publish(session, *, version_id: UUID, workspace_id: str, owner_id: str, actor_id: str, expected_hash: str) -> dict[str, object]:
    row = _owned(session, version_id, workspace_id, owner_id)
    if row.status != "draft" or row.catalog_hash != expected_hash:
        raise CiPricingCatalogError("draft changed; reload before publishing")
    errors = validate_catalog(row.catalog_json)
    if errors:
        raise CiPricingCatalogError("; ".join(errors))
    prior = session.scalars(
        select(CiPricingCatalogVersionModel).where(
            CiPricingCatalogVersionModel.workspace_id == workspace_id,
            CiPricingCatalogVersionModel.owner_id == owner_id,
            CiPricingCatalogVersionModel.status == "published",
        )
    ).all()
    for item in prior:
        item.status = "retired"
    row.status = "published"; row.published_at = utcnow(); row.published_by_actor_id = actor_id
    session.flush()
    return _serialize(row)


def resolve_price(session, *, version_id: UUID, product_ids: list[str], installation_item_ids: list[str], capacity_kwh: float, discharge_kw: float, pv_capacity_kw: float, workspace_id: str, owner_id: str, pv_inverter_kw: float = 0.0, battery_inverter_kw: float | None = None) -> dict[str, object]:
    row = _owned(session, version_id, workspace_id, owner_id)
    if row.status != "published":
        raise CiPricingCatalogError("new solutions require a published price catalog")
    selected = set(product_ids + installation_item_ids)
    if not selected:
        raise CiPricingCatalogError("select at least one product or installation price")
    lines = []
    available = {
        str(item["item_id"]): (group, item)
        for group in ("products", "installation_items")
        for item in row.catalog_json.get(group, [])
        if isinstance(item, dict) and item.get("effective_status") == "active"
    }
    for item_id in product_ids:
        if item_id not in available or available[item_id][0] != "products":
            raise CiPricingCatalogError(f"selected product price is unavailable: {item_id}")
    for item_id in installation_item_ids:
        if item_id not in available or available[item_id][0] != "installation_items":
            raise CiPricingCatalogError(
                f"selected installation price is unavailable: {item_id}"
            )
    for item_id in selected:
        group, item = available[item_id]
        basis = str(item["pricing_basis"])
        quantity = (
            1.0
            if basis == "fixed"
            else capacity_kwh
            if basis == "per_kwh_capacity"
            else discharge_kw
            if basis == "per_kw_discharge"
            else pv_capacity_kw
            if basis == "per_kw_pv_dc"
            else _size_quantity(
                str(item["size_metric"]),
                capacity_kwh=capacity_kwh,
                discharge_kw=discharge_kw,
                pv_capacity_kw=pv_capacity_kw,
                pv_inverter_kw=pv_inverter_kw,
                battery_inverter_kw=battery_inverter_kw,
            )
        )
        if basis == "size_cost_table":
            cost_row, resolution_method = _resolve_cost_table(
                item["cost_rows"], quantity
            )
            capital = cost_row["capital_cost_aud"]
            replacement = cost_row["replacement_cost_aud"]
            annual_om = cost_row["annual_om_cost_aud"]
            replacement_interval = item.get("replacement_interval_years")
            unit_price = None
        else:
            unit_price = float(item["unit_price_aud"])
            capital = unit_price * quantity
            replacement = 0.0
            annual_om = 0.0
            replacement_interval = None
            resolution_method = "unit_rate"
        lines.append({
            "item_id": item_id,
            "item_kind": "product" if group == "products" else "installation",
            "label": item["label"],
            "pricing_basis": basis,
            "size_metric": item.get("size_metric"),
            "unit_price_aud": unit_price,
            "quantity": quantity,
            "amount_aud": round(capital, 2),
            "replacement_cost_aud": round(replacement, 2),
            "annual_om_cost_aud": round(annual_om, 2),
            "replacement_interval_years": replacement_interval,
            "resolution_method": resolution_method,
        })
    lines.sort(key=lambda item: (str(item["item_kind"]), str(item["item_id"])))
    return {
        "catalog_version_id": str(row.id),
        "catalog_version_number": row.version_number,
        "catalog_hash": row.catalog_hash,
        "tax_basis": row.catalog_json["tax_basis"],
        "currency": "AUD",
        "lines": lines,
        "resolved_upfront_cost_aud": round(
            sum(float(item["amount_aud"]) for item in lines), 2
        ),
        "resolved_annual_om_cost_aud": round(
            sum(float(item["annual_om_cost_aud"]) for item in lines), 2
        ),
    }


def _validate_cost_table(
    item: dict[str, object], prefix: str, errors: list[str]
) -> None:
    if item.get("size_metric") not in SIZE_METRICS:
        errors.append(f"{prefix}.size_metric is invalid")
    rows = item.get("cost_rows")
    if not isinstance(rows, list) or len(rows) < 2:
        errors.append(f"{prefix}.cost_rows must contain at least two points")
        return
    sizes: set[float] = set()
    has_replacement = False
    for row_index, cost_row in enumerate(rows):
        row_prefix = f"{prefix}.cost_rows[{row_index}]"
        if not isinstance(cost_row, dict):
            errors.append(f"{row_prefix} must be an object")
            continue
        values: dict[str, float] = {}
        for key in (
            "size",
            "capital_cost_aud",
            "replacement_cost_aud",
            "annual_om_cost_aud",
        ):
            try:
                value = float(cost_row.get(key))
                if not math.isfinite(value) or value < 0:
                    raise ValueError
                values[key] = value
            except (TypeError, ValueError):
                errors.append(f"{row_prefix}.{key} must be non-negative")
        size = values.get("size")
        if size is not None:
            if size in sizes:
                errors.append(f"{prefix}.cost_rows sizes must be unique")
            sizes.add(size)
        has_replacement = has_replacement or values.get("replacement_cost_aud", 0) > 0
    interval = item.get("replacement_interval_years")
    if has_replacement and (
        isinstance(interval, bool)
        or not isinstance(interval, int)
        or not 1 <= interval <= 50
    ):
        errors.append(
            f"{prefix}.replacement_interval_years must be 1 to 50 when replacement cost is used"
        )
    if not has_replacement and interval is not None:
        errors.append(
            f"{prefix}.replacement_interval_years must be null without replacement cost"
        )


def _size_quantity(
    metric: str,
    *,
    capacity_kwh: float,
    discharge_kw: float,
    pv_capacity_kw: float,
    pv_inverter_kw: float,
    battery_inverter_kw: float | None = None,
) -> float:
    if metric == "pv_kwp_dc":
        return pv_capacity_kw
    if metric == "pv_inverter_kw_ac":
        return pv_inverter_kw
    if metric == "battery_inverter_kw_ac":
        if (
            isinstance(battery_inverter_kw, bool)
            or not isinstance(battery_inverter_kw, (float, int))
            or not math.isfinite(battery_inverter_kw)
            or battery_inverter_kw < 0
        ):
            raise CiPricingCatalogError("battery inverter pricing requires an explicit AC capacity")
        return float(battery_inverter_kw)
    if metric == "battery_kwh":
        return capacity_kwh
    if metric == "battery_kw_discharge":
        return discharge_kw
    raise CiPricingCatalogError("selected price table sizing metric is invalid")


def _resolve_cost_table(
    raw_rows: object, quantity: float
) -> tuple[dict[str, float], str]:
    if not isinstance(raw_rows, list) or len(raw_rows) < 2:
        raise CiPricingCatalogError("selected price table is invalid")
    rows = sorted(raw_rows, key=lambda item: float(item["size"]))
    if quantity == 0:
        return {
            "capital_cost_aud": 0.0,
            "replacement_cost_aud": 0.0,
            "annual_om_cost_aud": 0.0,
        }, "zero_size"
    exact = next(
        (row for row in rows if float(row["size"]) == float(quantity)),
        None,
    )
    if exact is not None:
        return {
            key: float(exact[key])
            for key in (
                "capital_cost_aud",
                "replacement_cost_aud",
                "annual_om_cost_aud",
            )
        }, "exact"
    lower = [row for row in rows if float(row["size"]) < quantity]
    upper = [row for row in rows if float(row["size"]) > quantity]
    if lower and upper:
        left, right = lower[-1], upper[0]
        method = "interpolated"
    elif not lower:
        left, right = rows[0], rows[1]
        method = "extrapolated"
    else:
        left, right = rows[-2], rows[-1]
        method = "extrapolated"
    left_size = float(left["size"])
    right_size = float(right["size"])
    ratio = (quantity - left_size) / (right_size - left_size)
    resolved = {
        key: float(left[key]) + ratio * (float(right[key]) - float(left[key]))
        for key in (
            "capital_cost_aud",
            "replacement_cost_aud",
            "annual_om_cost_aud",
        )
    }
    if any(value < 0 for value in resolved.values()):
        raise CiPricingCatalogError(
            "selected price table extrapolates to a negative cost"
        )
    return resolved, method


def _owned(session, version_id: UUID, workspace_id: str, owner_id: str) -> CiPricingCatalogVersionModel:
    row = session.get(CiPricingCatalogVersionModel, version_id)
    if row is None or row.workspace_id != workspace_id or row.owner_id != owner_id:
        raise CiPricingCatalogError("C&I price catalog version not found")
    return row


def _digest(payload: dict[str, object]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _serialize(row: CiPricingCatalogVersionModel) -> dict[str, object]:
    return {"catalog_version_id": str(row.id), "version_number": row.version_number, "status": row.status, "catalog": row.catalog_json, "catalog_hash": row.catalog_hash, "created_at": row.created_at.isoformat(), "published_at": row.published_at.isoformat() if row.published_at else None}
