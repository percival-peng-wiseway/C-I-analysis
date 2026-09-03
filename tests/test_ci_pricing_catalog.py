from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from uuid import UUID

from solar_battery.ci_pricing_catalog import (
    _resolve_cost_table,
    create_draft,
    publish,
    replace_draft,
    resolve_price,
)
from solar_battery.durable_cockpit.orm import Base


def test_size_cost_table_resolves_independent_pv_sizing_list() -> None:
    cost_rows = [
        {"size": 80.0, "capital_cost_aud": 42400.0, "replacement_cost_aud": 42400.0, "annual_om_cost_aud": 0.0},
        {"size": 90.0, "capital_cost_aud": 47700.0, "replacement_cost_aud": 47700.0, "annual_om_cost_aud": 0.0},
        {"size": 99.0, "capital_cost_aud": 52470.0, "replacement_cost_aud": 52470.0, "annual_om_cost_aud": 0.0},
        {"size": 99.38, "capital_cost_aud": 52671.4, "replacement_cost_aud": 52671.4, "annual_om_cost_aud": 0.0},
    ]

    resolved = {
        size: _resolve_cost_table(cost_rows, size)
        for size in (0.0, 50.0, 75.0, 100.0, 125.0)
    }

    assert [round(resolved[size][0]["capital_cost_aud"], 2) for size in resolved] == [
        0.0,
        26500.0,
        39750.0,
        53000.0,
        66250.0,
    ]
    assert resolved[0.0][1] == "zero_size"
    assert all(resolved[size][1] == "extrapolated" for size in (50.0, 75.0, 100.0, 125.0))


def test_size_cost_table_interpolates_quantity_just_above_authored_row() -> None:
    cost_rows = [
        {"size": 100.0, "capital_cost_aud": 1000.0, "replacement_cost_aud": 500.0, "annual_om_cost_aud": 100.0},
        {"size": 200.0, "capital_cost_aud": 2000.0, "replacement_cost_aud": 1000.0, "annual_om_cost_aud": 200.0},
    ]

    resolved, method = _resolve_cost_table(cost_rows, 100.0000009)

    assert method == "interpolated"
    assert resolved["capital_cost_aud"] > 1000.0


def test_versioned_catalog_resolves_product_and_installation_prices() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    draft = create_draft(session, workspace_id="w", owner_id="o", actor_id="a")
    catalog = draft["catalog"] | {
        "products": [
            {"item_id": "battery", "label": "Battery", "category": "battery", "pricing_basis": "per_kwh_capacity", "unit_price_aud": 200.0, "effective_status": "active"},
            {"item_id": "solar", "label": "Solar PV", "category": "solar_pv", "pricing_basis": "per_kw_pv_dc", "unit_price_aud": 500.0, "effective_status": "active"},
            {
                "item_id": "battery-table",
                "label": "Battery exact sizes",
                "category": "battery",
                "pricing_basis": "size_cost_table",
                "size_metric": "battery_kwh",
                "replacement_interval_years": 8,
                "cost_rows": [
                    {"size": 500.0, "capital_cost_aud": 90000.0, "replacement_cost_aud": 45000.0, "annual_om_cost_aud": 1200.0},
                    {"size": 750.0, "capital_cost_aud": 125000.0, "replacement_cost_aud": 60000.0, "annual_om_cost_aud": 1500.0},
                ],
                "effective_status": "active",
            },
        ],
        "installation_items": [{"item_id": "install", "label": "Install", "pricing_basis": "per_kw_discharge", "unit_price_aud": 100.0, "effective_status": "active"}],
    }
    version_id = UUID(draft["catalog_version_id"])
    updated = replace_draft(session, version_id=version_id, catalog=catalog, workspace_id="w", owner_id="o")
    published = publish(session, version_id=version_id, workspace_id="w", owner_id="o", actor_id="a", expected_hash=updated["catalog_hash"])
    resolved = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["battery"], installation_item_ids=["install"], capacity_kwh=500.0, discharge_kw=250.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert resolved["resolved_upfront_cost_aud"] == 125000.0
    assert {line["item_kind"] for line in resolved["lines"]} == {"product", "installation"}

    pv_resolved = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["solar"], installation_item_ids=[], capacity_kwh=500.0, discharge_kw=250.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert pv_resolved["resolved_upfront_cost_aud"] == 50000.0
    assert pv_resolved["lines"][0]["quantity"] == 100.0

    table_resolved = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["battery-table"], installation_item_ids=[], capacity_kwh=500.0, discharge_kw=250.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert table_resolved["resolved_upfront_cost_aud"] == 90000.0
    assert table_resolved["resolved_annual_om_cost_aud"] == 1200.0
    assert table_resolved["lines"][0]["replacement_cost_aud"] == 45000.0
    assert table_resolved["lines"][0]["replacement_interval_years"] == 8

    interpolated = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["battery-table"], installation_item_ids=[], capacity_kwh=600.0, discharge_kw=250.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert interpolated["resolved_upfront_cost_aud"] == 104000.0
    assert interpolated["resolved_annual_om_cost_aud"] == 1320.0
    assert interpolated["lines"][0]["resolution_method"] == "interpolated"

    extrapolated = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["battery-table"], installation_item_ids=[], capacity_kwh=1000.0, discharge_kw=250.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert extrapolated["resolved_upfront_cost_aud"] == 160000.0
    assert extrapolated["lines"][0]["resolution_method"] == "extrapolated"

    zero = resolve_price(session, version_id=UUID(published["catalog_version_id"]), product_ids=["battery-table"], installation_item_ids=[], capacity_kwh=0.0, discharge_kw=0.0, pv_capacity_kw=100.0, workspace_id="w", owner_id="o")
    assert zero["resolved_upfront_cost_aud"] == 0.0
    assert zero["lines"][0]["resolution_method"] == "zero_size"


def test_inverter_cost_table_resolves_from_authored_ac_capacity() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    draft = create_draft(session, workspace_id="w", owner_id="o", actor_id="a")
    catalog = draft["catalog"] | {
        "products": [{
            "item_id": "inverter",
            "label": "Provided inverter",
            "category": "pcs_inverter",
            "pricing_basis": "size_cost_table",
            "size_metric": "pv_inverter_kw_ac",
            "replacement_interval_years": 15,
            "cost_rows": [
                {"size": 80.0, "capital_cost_aud": 9000.0, "replacement_cost_aud": 9000.0, "annual_om_cost_aud": 0.0},
                {"size": 100.0, "capital_cost_aud": 9500.0, "replacement_cost_aud": 9500.0, "annual_om_cost_aud": 0.0},
                {"size": 125.0, "capital_cost_aud": 10000.0, "replacement_cost_aud": 10000.0, "annual_om_cost_aud": 0.0},
            ],
            "effective_status": "active",
        }],
        "installation_items": [],
    }
    version_id = UUID(draft["catalog_version_id"])
    updated = replace_draft(session, version_id=version_id, catalog=catalog, workspace_id="w", owner_id="o")
    published = publish(session, version_id=version_id, workspace_id="w", owner_id="o", actor_id="a", expected_hash=updated["catalog_hash"])
    resolved = resolve_price(
        session,
        version_id=UUID(published["catalog_version_id"]),
        product_ids=["inverter"],
        installation_item_ids=[],
        capacity_kwh=0.0,
        discharge_kw=0.0,
        pv_capacity_kw=125.0,
        pv_inverter_kw=100.0,
        workspace_id="w",
        owner_id="o",
    )
    assert resolved["resolved_upfront_cost_aud"] == 9500.0
    assert resolved["lines"][0]["quantity"] == 100.0
