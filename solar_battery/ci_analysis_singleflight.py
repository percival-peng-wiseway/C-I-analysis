from __future__ import annotations

from concurrent.futures import Future, TimeoutError
from threading import Lock
from typing import Callable, TypeVar

from solar_battery.ci_projects import CiProjectError


_Result = TypeVar("_Result")
_lock = Lock()
_running: dict[tuple[str, ...], Future] = {}


def run_ci_analysis_once(
    key: tuple[str, ...],
    operation: Callable[[], _Result],
    *,
    wait_seconds: float = 720,
) -> _Result:
    """Join identical in-flight requests in this API process.

    The caller binds the key to tenant, project, selected scenarios, source
    hashes and persistence mode, and publishes only after committing its
    checkpoint. This is not a result cache: completed/failed entries are
    removed, and durable snapshot validation remains authoritative.
    """
    with _lock:
        pending = _running.get(key)
        owner = pending is None
        if pending is None:
            pending = Future()
            _running[key] = pending
    if not owner:
        try:
            return pending.result(timeout=wait_seconds)
        except TimeoutError as exc:
            # An operation can itself raise TimeoutError. Preserve that failure
            # instead of misreporting an already-finished operation as running.
            if pending.done():
                return pending.result()
            raise CiProjectError(
                "ci_analysis_in_progress",
                "This analysis is still running. Check its saved progress before trying again.",
            ) from exc
    try:
        result = operation()
        pending.set_result(result)
        return result
    except BaseException as exc:
        pending.set_exception(exc)
        raise
    finally:
        with _lock:
            if _running.get(key) is pending:
                del _running[key]
