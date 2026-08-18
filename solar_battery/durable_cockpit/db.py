from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from solar_battery.durable_cockpit.settings import DurableCockpitSettings


def build_engine(settings: DurableCockpitSettings) -> Engine:
    connect_args = (
        {"check_same_thread": False}
        if settings.database_url.startswith("sqlite")
        else {}
    )
    return create_engine(
        settings.database_url,
        connect_args=connect_args,
        future=True,
        pool_pre_ping=not settings.database_url.startswith("sqlite"),
    )


def build_session_factory(settings: DurableCockpitSettings):
    engine = build_engine(settings)
    return sessionmaker(bind=engine, expire_on_commit=False)
