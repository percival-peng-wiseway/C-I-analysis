from __future__ import annotations

from calendar import monthrange
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FutureTimeoutError
from concurrent.futures.process import BrokenProcessPool
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
import logging
import math
import multiprocessing
import os
import pickle
import signal
from threading import Lock
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from solar_battery.ci_tariff_analysis import (
    CiTariffAnalysisError,
    analyze_ci_nem12,
    calculate_ci_tariff_charges,
    validated_ci_nem12_evidence,
)
from solar_battery.ci_peak_shaving_optimizer import (
    CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
    CI_REACTIVE_SUPPORT_CONTRACT_VERSION,
    CiBatterySpec,
    CiBillingPeriod,
    CiDemandCharge,
    CiOptimizerConfig,
    CiOptimizerInterval,
    CiOptimizerProblem,
    CiOptimizerStatus,
    CiReactiveSupportSpec,
    execute_ci_peak_shaving_rolling,
)
from solar_battery.models import CleanedInterval
from solar_battery.peak_shaving import PeakShavingPeriodInput
from solar_battery.solar_profile import build_pv_profile


CI_PHYSICAL_SCENARIO_CONTRACT_VERSION = "ci_physical_scenario_review_v6"
CI_PHYSICAL_SCENARIO_CALCULATION_REVISION = (
    "ci_physical_scenario_planner_primary_seed_v2"
)
CI_DISPATCH_REVIEW_PROJECTION_CONTRACT_VERSION = (
    "ci_dispatch_review_projection_v2"
)
CI_THREE_CASE_COMPARISON_CONTRACT_VERSION = "ci_three_case_peak_day_comparison_v2"
CI_OPTIMIZER_RUN_SNAPSHOT_CONTRACT_VERSION = "ci_optimizer_run_snapshot_v2"
CI_OPTIMIZER_RUN_SNAPSHOT_CALCULATION_REVISION = (
    "ci_optimizer_run_snapshot_planner_primary_seed_v2"
)
CI_OPTIMIZER_AUDIT_PROJECTION_CONTRACT_VERSION = "ci_optimizer_audit_projection_v2"
CI_PV_ONLY_EXACT_ID = "ci_pv_only_shared_pq_v1"
MIN_SOLUTIONS = 1
MAX_SOLUTIONS = 200
MAX_BATTERY_SYSTEMS = 15
MAX_PV_SYSTEMS = 20
DEFAULT_SCENARIO_PROCESS_WORKERS = 1
MAX_SCENARIO_PROCESS_WORKERS = 3
DEFAULT_SCENARIO_PROCESS_TIMEOUT_SECONDS = 600.0
MIN_SCENARIO_PROCESS_TIMEOUT_SECONDS = 30.0
MAX_SCENARIO_PROCESS_TIMEOUT_SECONDS = 3600.0
SCENARIO_PROCESS_TERMINATION_GRACE_SECONDS = 2.0

_LOGGER = logging.getLogger(__name__)
_SCENARIO_ANALYSIS_PROCESS_LOCK = Lock()
_SCENARIO_PROCESS_POOL_LOCK = Lock()
_SCENARIO_PROCESS_POOL_DISABLED = False

_COORDINATOR_RESULT_READY = "ready"
_COORDINATOR_RESULT_SCENARIO_ERROR = "scenario_error"
_COORDINATOR_RESULT_TARIFF_ERROR = "tariff_error"
_COORDINATOR_RESULT_EXECUTION_ERROR = "execution_error"

_SAFE_MESSAGES = {
    "scenario_contract_invalid": (
        "Provide one to 200 complete PV and battery solutions using at most 20 PV systems and 15 battery systems."
    ),
    "scenario_horizon_invalid": (
        "The evidence-bound NEM12 file does not provide exactly 12 monthly review periods."
    ),
    "scenario_execution_failed": "The physical scenario review could not be completed safely.",
    "annual_value_unavailable": (
        "The active tariff profile does not contain the evidence required for annual financial values."
    ),
    "comparison_contract_invalid": (
        "Select one explicit PV-only scenario and one explicit PV-and-battery scenario."
    ),
    "comparison_pair_invalid": (
        "The selected scenarios are not an exact PV-matched pair for battery comparison."
    ),
}


class CiScenarioAnalysisError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(_SAFE_MESSAGES[code])
        self.code = code

    def __reduce__(self):
        return (self.__class__, (self.code,))


class _ScenarioProcessPoolUnavailable(RuntimeError):
    pass


class _ScenarioProcessPoolBroken(RuntimeError):
    pass


class _ScenarioProcessExecutionFailed(RuntimeError):
    pass


class _ScenarioProcessPoolTimedOut(RuntimeError):
    pass


@dataclass(frozen=True)
class _Scenario:
    scenario_id: str
    label: str
    battery_system_id: str
    battery_technology_id: str
    control_profile_id: str
    pv_system_id: str
    pv_profile_id: str
    pv_capacity_kwp_dc: float
    pv_inverter_capacity_kw_ac: float
    shared_ac_headroom_kw: float
    reactive_support_enabled: bool
    reactive_support_max_kvar: float
    shared_inverter_apparent_power_limit_kva: float | None
    reactive_capability_curve: str
    reactive_capability_provenance: str
    reactive_overcompensation_permitted: bool
    pv_annual_specific_yield_kwh_per_kw: float
    pv_derating_factor: float
    nominal_capacity_kwh: float
    max_charge_kw: float
    max_discharge_kw: float
    charge_efficiency: float
    discharge_efficiency: float
    min_soc_fraction: float
    max_soc_fraction: float
    initial_soc_fraction: float
    allow_grid_charging: bool
    grid_emissions_factor_kg_co2e_per_kwh: float


@dataclass(frozen=True)
class _ScenarioExecution:
    scenario: _Scenario
    public_result: dict[str, object]
    rows: tuple[dict[str, object], ...]
    dispatch: tuple[dict[str, object], ...]


@dataclass(frozen=True)
class _CompiledTariffWindow:
    start: time
    end: time
    use_meter_aest: bool
    excluded_dates: frozenset[date]


@dataclass(frozen=True)
class _TariffRowMembership:
    """Compact, reusable tariff classification for every analysis interval."""

    annual_period: bytes
    billing_period: bytes
    retail_energy_peak: bytes
    network_energy_peak: bytes
    annual_rolling_demand: bytes
    incentive_demand: bytes
    local_months: bytes
    optimizer_import_rates: tuple[float, ...]


def analyze_ci_physical_scenarios(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
) -> dict[str, object]:
    """Compare analyst-authored batteries using physical evidence only.

    Production configurations run the *entire* calculation in a disposable
    coordinator process.  The parent API process owns the wall-clock deadline
    and can terminate the coordinator (and its solver children on POSIX) even
    when parsing, tariff reconstruction or a native solver call stops making
    progress.  The one-worker configuration remains inline for local tests and
    runtimes that explicitly choose the legacy serial execution mode.
    """

    if _configured_scenario_process_workers() <= 1:
        return _analyze_ci_physical_scenarios_core(
            upload_bytes,
            profile=profile,
            scenarios=scenarios,
        )
    return _execute_physical_analysis_in_coordinator(
        upload_bytes,
        profile=profile,
        scenarios=scenarios,
    )


def _analyze_ci_physical_scenarios_core(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
) -> dict[str, object]:
    """Execute the complete physical analysis inside the selected process."""

    started_at = monotonic()
    authored = _validated_scenarios(scenarios)
    _LOGGER.info(
        "ci_scenario_analysis stage=prepare_start scenarios=%d",
        len(authored),
    )
    parsed = validated_ci_nem12_evidence(upload_bytes, profile=profile)
    tariff_result = analyze_ci_nem12(
        upload_bytes,
        profile=profile,
        _validated_evidence=parsed,
    )
    periods, interval_evidence = _build_periods(parsed["streams"], profile)
    tariff_membership = _compile_tariff_row_membership(
        periods,
        interval_evidence,
        profile,
    )
    _LOGGER.info(
        "ci_scenario_analysis stage=prepare_complete scenarios=%d elapsed_s=%.3f",
        len(authored),
        monotonic() - started_at,
    )
    annual_tariff_baseline_cache: dict[str, object] = {}
    pv_generation_cache: dict[tuple[object, ...], tuple[float, ...]] = {}

    results = _execute_authored_scenarios(
        authored,
        periods,
        interval_evidence,
        tariff_membership,
        profile,
        annual_tariff_baseline_cache,
        pv_generation_cache,
    )
    _LOGGER.info(
        "ci_scenario_analysis stage=complete scenarios=%d elapsed_s=%.3f",
        len(authored),
        monotonic() - started_at,
    )
    return _physical_scenario_result(tariff_result=tariff_result, results=results)


def _execute_physical_analysis_in_coordinator(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
) -> dict[str, object]:
    """Run one complete request behind a hard, parent-owned deadline."""

    started_at = monotonic()
    timeout_seconds = _configured_scenario_process_timeout_seconds()
    deadline = started_at + timeout_seconds
    _LOGGER.info(
        "ci_scenario_analysis stage=coordinator_wait timeout_s=%.1f",
        timeout_seconds,
    )
    acquired = _SCENARIO_ANALYSIS_PROCESS_LOCK.acquire(
        timeout=max(0.0, deadline - monotonic())
    )
    if not acquired:
        _LOGGER.warning("ci_scenario_analysis stage=coordinator_lock_timeout")
        raise CiScenarioAnalysisError("scenario_execution_failed")

    executor: ProcessPoolExecutor | None = None
    futures: list[Any] = []
    try:
        try:
            executor = ProcessPoolExecutor(
                max_workers=1,
                mp_context=multiprocessing.get_context("spawn"),
                initializer=_start_analysis_process_group,
            )
            futures.append(
                executor.submit(
                    _run_physical_analysis_coordinator,
                    upload_bytes,
                    profile=profile,
                    scenarios=scenarios,
                )
            )
        except (OSError, RuntimeError) as exc:
            raise _ScenarioProcessPoolUnavailable(
                "the analysis coordinator process could not be started"
            ) from exc

        _LOGGER.info(
            "ci_scenario_analysis stage=coordinator_started elapsed_s=%.3f",
            monotonic() - started_at,
        )
        remaining_seconds = deadline - monotonic()
        if remaining_seconds <= 0.0:
            raise FutureTimeoutError()
        try:
            outcome = futures[0].result(timeout=remaining_seconds)
        except FutureTimeoutError:
            raise
        except BrokenProcessPool as exc:
            raise _ScenarioProcessPoolBroken(
                "the analysis coordinator terminated unexpectedly"
            ) from exc
        except (pickle.PicklingError, EOFError, OSError) as exc:
            raise _ScenarioProcessPoolUnavailable(
                "analysis inputs or outputs could not cross the process boundary"
            ) from exc
        except Exception as exc:
            raise _ScenarioProcessExecutionFailed(
                "the analysis coordinator returned an unexpected failure"
            ) from exc

        if monotonic() > deadline:
            raise FutureTimeoutError()
        executor.shutdown(wait=False)
        executor = None
        result = _unwrap_physical_analysis_coordinator_outcome(outcome)
        _LOGGER.info(
            "ci_scenario_analysis stage=coordinator_complete elapsed_s=%.3f",
            monotonic() - started_at,
        )
        return result
    except FutureTimeoutError as exc:
        _LOGGER.warning(
            "ci_scenario_analysis stage=coordinator_timeout timeout_s=%.1f",
            timeout_seconds,
        )
        _abort_analysis_coordinator(executor, futures)
        executor = None
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc
    except (CiScenarioAnalysisError, CiTariffAnalysisError):
        _abort_analysis_coordinator(executor, futures)
        executor = None
        raise
    except (
        _ScenarioProcessPoolUnavailable,
        _ScenarioProcessPoolBroken,
        _ScenarioProcessExecutionFailed,
    ) as exc:
        _abort_analysis_coordinator(executor, futures)
        executor = None
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc
    except Exception as exc:
        _abort_analysis_coordinator(executor, futures)
        executor = None
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc
    finally:
        if executor is not None:
            _abort_analysis_coordinator(executor, futures)
        _SCENARIO_ANALYSIS_PROCESS_LOCK.release()


def _run_physical_analysis_coordinator(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
) -> tuple[str, object]:
    """Return only pickle-safe values across the coordinator boundary."""

    try:
        return (
            _COORDINATOR_RESULT_READY,
            _analyze_ci_physical_scenarios_core(
                upload_bytes,
                profile=profile,
                scenarios=scenarios,
            ),
        )
    except CiScenarioAnalysisError as exc:
        return (_COORDINATOR_RESULT_SCENARIO_ERROR, exc.code)
    except CiTariffAnalysisError as exc:
        return (_COORDINATOR_RESULT_TARIFF_ERROR, exc.code)
    except Exception as exc:
        _LOGGER.warning(
            "ci_scenario_analysis stage=coordinator_execution_failed error_type=%s",
            type(exc).__name__,
        )
        return (_COORDINATOR_RESULT_EXECUTION_ERROR, None)


def _unwrap_physical_analysis_coordinator_outcome(
    outcome: object,
) -> dict[str, object]:
    """Reconstruct expected domain errors without pickling exception objects."""

    if not isinstance(outcome, tuple) or len(outcome) != 2:
        raise _ScenarioProcessExecutionFailed(
            "the analysis coordinator returned an invalid result envelope"
        )
    outcome_type, payload = outcome
    if outcome_type == _COORDINATOR_RESULT_READY:
        if not isinstance(payload, dict):
            raise _ScenarioProcessExecutionFailed(
                "the analysis coordinator returned an invalid result"
            )
        return payload
    if outcome_type == _COORDINATOR_RESULT_SCENARIO_ERROR:
        if not isinstance(payload, str) or payload not in _SAFE_MESSAGES:
            raise _ScenarioProcessExecutionFailed(
                "the analysis coordinator returned an invalid scenario error"
            )
        raise CiScenarioAnalysisError(payload)
    if outcome_type == _COORDINATOR_RESULT_TARIFF_ERROR:
        if not isinstance(payload, str):
            raise _ScenarioProcessExecutionFailed(
                "the analysis coordinator returned an invalid tariff error"
            )
        try:
            error = CiTariffAnalysisError(payload)
        except (KeyError, TypeError) as exc:
            raise _ScenarioProcessExecutionFailed(
                "the analysis coordinator returned an invalid tariff error"
            ) from exc
        raise error
    if outcome_type == _COORDINATOR_RESULT_EXECUTION_ERROR and payload is None:
        raise _ScenarioProcessExecutionFailed(
            "the analysis coordinator returned an unexpected failure"
        )
    raise _ScenarioProcessExecutionFailed(
        "the analysis coordinator returned an unknown result envelope"
    )


def _start_analysis_process_group() -> None:
    """Give a production coordinator its own POSIX process group."""

    if os.name != "posix":
        return
    if not hasattr(os, "setsid"):
        raise RuntimeError(
            "POSIX process-group isolation is unavailable for analysis"
        )
    try:
        os.setsid()
    except OSError as exc:
        # Never enter the core analysis without a group that the parent can
        # terminate together with every nested solver process.
        raise RuntimeError(
            "POSIX process-group isolation could not be established"
        ) from exc


def _execute_authored_scenarios(
    authored: tuple[_Scenario, ...],
    periods: tuple[PeakShavingPeriodInput, ...],
    interval_evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    annual_tariff_baseline_cache: dict[str, object],
    pv_generation_cache: dict[tuple[object, ...], tuple[float, ...]],
) -> list[dict[str, object]]:
    """Run only the requested scenarios, with bounded process isolation.

    HiGHS has a process-global scheduler.  Independent spawned processes keep
    one deterministic solver thread per process while allowing standard-4 to
    solve a bounded number of battery scenarios concurrently. PV-only rows
    remain in the coordinator because they do not invoke HiGHS.
    """

    workers = _configured_scenario_process_workers()
    indexed_battery = tuple(
        (index, scenario)
        for index, scenario in enumerate(authored)
        if scenario.nominal_capacity_kwh > 0.0
    )
    if workers <= 1 or not indexed_battery:
        return [
            _run_scenario(
                item,
                periods,
                interval_evidence,
                tariff_membership,
                profile,
                annual_tariff_baseline_cache,
                pv_generation_cache,
            )
            for item in authored
        ]
    if _scenario_process_pool_disabled():
        raise CiScenarioAnalysisError("scenario_execution_failed")

    results_by_index: dict[int, dict[str, object]] = {}
    for index, scenario in enumerate(authored):
        if scenario.nominal_capacity_kwh == 0.0:
            results_by_index[index] = _run_scenario(
                scenario,
                periods,
                interval_evidence,
                tariff_membership,
                profile,
                annual_tariff_baseline_cache,
                pv_generation_cache,
            )

    try:
        parallel_results = _execute_battery_scenarios_in_processes(
            indexed_battery,
            periods,
            interval_evidence,
            tariff_membership,
            profile,
            worker_count=min(workers, len(indexed_battery)),
        )
    except _ScenarioProcessPoolUnavailable as exc:
        _LOGGER.warning(
            "C&I scenario process pool unavailable; failing closed",
            exc_info=True,
        )
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc
    except _ScenarioProcessPoolTimedOut as exc:
        _LOGGER.warning(
            "ci_scenario_analysis stage=pool_timeout scenarios=%d workers=%d",
            len(indexed_battery),
            min(workers, len(indexed_battery)),
        )
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc
    except _ScenarioProcessPoolBroken as exc:
        # A native solver failure must not take down the API process. Discard
        # every partial result and retry exactly once in a fresh isolated
        # single-worker process before failing closed.
        _LOGGER.warning(
            "C&I scenario process pool unavailable; retrying in isolation",
            exc_info=True,
        )
        try:
            parallel_results = _execute_battery_scenarios_in_processes(
                indexed_battery,
                periods,
                interval_evidence,
                tariff_membership,
                profile,
                worker_count=1,
            )
        except (
            _ScenarioProcessPoolUnavailable,
            _ScenarioProcessPoolBroken,
            _ScenarioProcessExecutionFailed,
            _ScenarioProcessPoolTimedOut,
        ) as retry_exc:
            raise CiScenarioAnalysisError("scenario_execution_failed") from retry_exc
    except _ScenarioProcessExecutionFailed as exc:
        raise CiScenarioAnalysisError("scenario_execution_failed") from exc

    expected_indexes = {index for index, _scenario in indexed_battery}
    if set(parallel_results) != expected_indexes:
        raise CiScenarioAnalysisError("scenario_execution_failed")
    results_by_index.update(parallel_results)

    return [results_by_index[index] for index in range(len(authored))]


def _configured_scenario_process_workers() -> int:
    value = os.getenv(
        "CI_SCENARIO_PROCESS_WORKERS",
        str(DEFAULT_SCENARIO_PROCESS_WORKERS),
    )
    try:
        workers = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SCENARIO_PROCESS_WORKERS
    if not 1 <= workers <= MAX_SCENARIO_PROCESS_WORKERS:
        return DEFAULT_SCENARIO_PROCESS_WORKERS
    return workers


def _configured_scenario_process_timeout_seconds() -> float:
    value = os.getenv(
        "CI_SCENARIO_PROCESS_TIMEOUT_SECONDS",
        str(DEFAULT_SCENARIO_PROCESS_TIMEOUT_SECONDS),
    )
    try:
        timeout_seconds = float(value)
    except (TypeError, ValueError):
        return DEFAULT_SCENARIO_PROCESS_TIMEOUT_SECONDS
    if (
        not math.isfinite(timeout_seconds)
        or not MIN_SCENARIO_PROCESS_TIMEOUT_SECONDS
        <= timeout_seconds
        <= MAX_SCENARIO_PROCESS_TIMEOUT_SECONDS
    ):
        return DEFAULT_SCENARIO_PROCESS_TIMEOUT_SECONDS
    return timeout_seconds


def _scenario_process_pool_disabled() -> bool:
    # The boolean assignment is atomic in supported CPython versions. Avoid
    # blocking here because pool acquisition itself has the watchdog deadline.
    return _SCENARIO_PROCESS_POOL_DISABLED


def _execute_battery_scenarios_in_processes(
    indexed_scenarios: tuple[tuple[int, _Scenario], ...],
    periods: tuple[PeakShavingPeriodInput, ...],
    interval_evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    *,
    worker_count: int,
) -> dict[int, dict[str, object]]:
    global _SCENARIO_PROCESS_POOL_DISABLED

    started_at = monotonic()
    timeout_seconds = _configured_scenario_process_timeout_seconds()
    deadline = started_at + timeout_seconds
    chunks: list[list[tuple[int, _Scenario]]] = [
        [] for _ in range(worker_count)
    ]
    for offset, item in enumerate(indexed_scenarios):
        chunks[offset % worker_count].append(item)

    _LOGGER.info(
        "ci_scenario_analysis stage=pool_wait scenarios=%d workers=%d timeout_s=%.1f",
        len(indexed_scenarios),
        worker_count,
        timeout_seconds,
    )
    # Pool creation and execution share one wall-clock deadline. This prevents
    # concurrent requests from waiting forever behind a wedged native solver.
    acquired = _SCENARIO_PROCESS_POOL_LOCK.acquire(
        timeout=max(0.0, deadline - monotonic())
    )
    if not acquired:
        raise _ScenarioProcessPoolTimedOut(
            "the scenario process pool lock exceeded its deadline"
        )

    executor: ProcessPoolExecutor | None = None
    futures: list[Any] = []
    try:
        if _SCENARIO_PROCESS_POOL_DISABLED:
            raise _ScenarioProcessPoolUnavailable(
                "process execution was disabled after an earlier capability failure"
            )
        try:
            executor = ProcessPoolExecutor(
                max_workers=worker_count,
                mp_context=multiprocessing.get_context("spawn"),
            )
        except (OSError, RuntimeError) as exc:
            _SCENARIO_PROCESS_POOL_DISABLED = True
            raise _ScenarioProcessPoolUnavailable(
                "the process pool could not be created"
            ) from exc

        for chunk in chunks:
            if not chunk:
                continue
            try:
                futures.append(
                    executor.submit(
                        _execute_scenario_chunk,
                        tuple(chunk),
                        periods,
                        interval_evidence,
                        tariff_membership,
                        profile,
                    )
                )
            except BrokenProcessPool as exc:
                raise _ScenarioProcessPoolBroken(
                    "the process pool broke while scheduling work"
                ) from exc
            except (OSError, RuntimeError) as exc:
                _SCENARIO_PROCESS_POOL_DISABLED = True
                raise _ScenarioProcessPoolUnavailable(
                    "the process pool could not schedule work"
                ) from exc

        _LOGGER.info(
            "ci_scenario_analysis stage=pool_started scenarios=%d workers=%d elapsed_s=%.3f",
            len(indexed_scenarios),
            worker_count,
            monotonic() - started_at,
        )
        results: dict[int, dict[str, object]] = {}
        for completed_chunks, future in enumerate(futures, start=1):
            remaining_seconds = deadline - monotonic()
            if remaining_seconds <= 0.0:
                raise FutureTimeoutError()
            try:
                rows = future.result(timeout=remaining_seconds)
            except FutureTimeoutError as exc:
                raise _ScenarioProcessPoolTimedOut(
                    "the scenario process pool exceeded its deadline"
                ) from exc
            except CiScenarioAnalysisError:
                raise
            except BrokenProcessPool as exc:
                raise _ScenarioProcessPoolBroken(
                    "a scenario process terminated unexpectedly"
                ) from exc
            except (pickle.PicklingError, EOFError, OSError) as exc:
                _SCENARIO_PROCESS_POOL_DISABLED = True
                raise _ScenarioProcessPoolUnavailable(
                    "scenario inputs or outputs could not cross the process boundary"
                ) from exc
            except Exception as exc:
                raise _ScenarioProcessExecutionFailed(
                    "a scenario process returned an unexpected failure"
                ) from exc
            results.update(rows)
            _LOGGER.info(
                "ci_scenario_analysis stage=pool_chunk_complete completed=%d total=%d elapsed_s=%.3f",
                completed_chunks,
                len(futures),
                monotonic() - started_at,
            )

        if monotonic() > deadline:
            raise FutureTimeoutError()
        # Every submitted result has crossed the process boundary. Do not let
        # executor teardown extend the request beyond the watchdog deadline.
        executor.shutdown(wait=False)
        executor = None
        _LOGGER.info(
            "ci_scenario_analysis stage=pool_complete scenarios=%d workers=%d elapsed_s=%.3f",
            len(indexed_scenarios),
            worker_count,
            monotonic() - started_at,
        )
        return results
    except FutureTimeoutError as exc:
        _abort_scenario_process_pool(executor, futures)
        executor = None
        raise _ScenarioProcessPoolTimedOut(
            "the scenario process pool exceeded its deadline"
        ) from exc
    except (
        CiScenarioAnalysisError,
        _ScenarioProcessPoolUnavailable,
        _ScenarioProcessPoolBroken,
        _ScenarioProcessPoolTimedOut,
        _ScenarioProcessExecutionFailed,
    ):
        _abort_scenario_process_pool(executor, futures)
        executor = None
        raise
    except Exception as exc:
        _abort_scenario_process_pool(executor, futures)
        executor = None
        raise _ScenarioProcessExecutionFailed(
            "the scenario process pool could not close cleanly"
        ) from exc
    finally:
        if executor is not None:
            _abort_scenario_process_pool(executor, futures)
        _SCENARIO_PROCESS_POOL_LOCK.release()


def _abort_analysis_coordinator(
    executor: ProcessPoolExecutor | None,
    futures: list[Any],
) -> None:
    """Stop the coordinator and its nested solver workers within four seconds."""

    for future in futures:
        try:
            future.cancel()
        except Exception:
            pass
    if executor is None:
        return

    process_map = getattr(executor, "_processes", None)
    processes = (
        tuple(process_map.values()) if isinstance(process_map, dict) else ()
    )
    process_groups: dict[int, int] = {}
    if os.name == "posix" and hasattr(os, "getpgid"):
        for process in processes:
            process_id = getattr(process, "pid", None)
            if not isinstance(process_id, int) or process_id <= 0:
                continue
            try:
                process_group = os.getpgid(process_id)
            except (OSError, ProcessLookupError):
                continue
            if process_group == process_id:
                process_groups[id(process)] = process_group

    try:
        executor.shutdown(wait=False, cancel_futures=True)
    except Exception:
        _LOGGER.warning(
            "ci_scenario_analysis stage=coordinator_abort_shutdown_failed",
            exc_info=True,
        )

    for process in processes:
        process_group = process_groups.get(id(process))
        try:
            if process_group is not None:
                os.killpg(process_group, signal.SIGTERM)
            elif process.is_alive():
                process.terminate()
        except (OSError, ProcessLookupError):
            pass
        except Exception:
            _LOGGER.warning(
                "ci_scenario_analysis stage=coordinator_terminate_failed",
                exc_info=True,
            )
    _join_scenario_processes(
        processes,
        timeout_seconds=SCENARIO_PROCESS_TERMINATION_GRACE_SECONDS,
    )
    for process in processes:
        process_group = process_groups.get(id(process))
        try:
            if process_group is not None:
                os.killpg(process_group, signal.SIGKILL)
            elif process.is_alive():
                process.kill()
        except (OSError, ProcessLookupError):
            pass
        except Exception:
            _LOGGER.warning(
                "ci_scenario_analysis stage=coordinator_kill_failed",
                exc_info=True,
            )
    _join_scenario_processes(
        processes,
        timeout_seconds=SCENARIO_PROCESS_TERMINATION_GRACE_SECONDS,
    )


def _abort_scenario_process_pool(
    executor: ProcessPoolExecutor | None,
    futures: list[Any],
) -> None:
    """Cancel queued work and forcibly stop running Python 3.12 workers."""

    for future in futures:
        try:
            future.cancel()
        except Exception:
            pass
    if executor is None:
        return

    process_map = getattr(executor, "_processes", None)
    processes = (
        tuple(process_map.values()) if isinstance(process_map, dict) else ()
    )
    try:
        executor.shutdown(wait=False, cancel_futures=True)
    except Exception:
        _LOGGER.warning(
            "ci_scenario_analysis stage=pool_abort_shutdown_failed",
            exc_info=True,
        )

    for process in processes:
        try:
            if process.is_alive():
                process.terminate()
        except Exception:
            _LOGGER.warning(
                "ci_scenario_analysis stage=pool_terminate_failed",
                exc_info=True,
            )
    _join_scenario_processes(
        processes,
        timeout_seconds=SCENARIO_PROCESS_TERMINATION_GRACE_SECONDS,
    )
    for process in processes:
        try:
            if process.is_alive():
                process.kill()
        except Exception:
            _LOGGER.warning(
                "ci_scenario_analysis stage=pool_kill_failed",
                exc_info=True,
            )
    _join_scenario_processes(
        processes,
        timeout_seconds=SCENARIO_PROCESS_TERMINATION_GRACE_SECONDS,
    )


def _join_scenario_processes(
    processes: tuple[Any, ...],
    *,
    timeout_seconds: float,
) -> None:
    deadline = monotonic() + timeout_seconds
    for process in processes:
        try:
            process.join(timeout=max(0.0, deadline - monotonic()))
        except Exception:
            _LOGGER.warning(
                "ci_scenario_analysis stage=pool_join_failed",
                exc_info=True,
            )


def _execute_scenario_chunk(
    indexed_scenarios: tuple[tuple[int, _Scenario], ...],
    periods: tuple[PeakShavingPeriodInput, ...],
    interval_evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
) -> list[tuple[int, dict[str, object]]]:
    started_at = monotonic()
    _LOGGER.info(
        "ci_scenario_analysis stage=chunk_start scenarios=%d",
        len(indexed_scenarios),
    )
    annual_tariff_baseline_cache: dict[str, object] = {}
    pv_generation_cache: dict[tuple[object, ...], tuple[float, ...]] = {}
    results = [
        (
            index,
            _run_scenario(
                scenario,
                periods,
                interval_evidence,
                tariff_membership,
                profile,
                annual_tariff_baseline_cache,
                pv_generation_cache,
            ),
        )
        for index, scenario in indexed_scenarios
    ]
    _LOGGER.info(
        "ci_scenario_analysis stage=chunk_complete scenarios=%d elapsed_s=%.3f",
        len(indexed_scenarios),
        monotonic() - started_at,
    )
    return results


def validate_ci_design_candidates(scenarios: object) -> dict[str, object]:
    """Validate an authored C&I search space without making tariff claims.

    This is intentionally narrower than physical scenario execution.  It uses
    the same Python-owned input contract and physical parameter guardrails, but
    does not infer dispatch feasibility, savings, ranking or recommendation.
    """
    authored = _validated_scenarios(scenarios)
    return {
        "contract_version": "ci_design_candidate_validation_v1",
        "status": "ready",
        "validation_basis": "python_scenario_input_contract_v1",
        "candidate_count": len(authored),
        "candidates": [asdict(item) for item in authored],
        "dispatch_evaluated": False,
        "tariff_evaluated": False,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "disclaimer": (
            "These candidates satisfy the repository input and physical-parameter "
            "guardrails only. NEM12 dispatch and tariff outcomes are not evaluated."
        ),
    }


def _physical_scenario_result(
    *, tariff_result: dict[str, object], results: list[dict[str, object]]
) -> dict[str, object]:
    ranked = rank_ci_physical_scenario_results(results)

    return {
        "contract_version": CI_PHYSICAL_SCENARIO_CONTRACT_VERSION,
        "calculation_revision": CI_PHYSICAL_SCENARIO_CALCULATION_REVISION,
        "analysis_status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "currency_values_permitted": True,
        "profile": tariff_result["profile"],
        "baseline": {
            "raw_rolling_demand_kva": tariff_result["demand_evidence"][
                "rolling_demand_kva"
            ],
            "chargeable_rolling_demand_kva": tariff_result["demand_evidence"][
                "chargeable_rolling_demand_kva"
            ],
            "incentive_demand_kva": tariff_result["demand_evidence"][
                "incentive_demand_kva"
            ],
            "billing_period_max_kva": tariff_result["demand_evidence"][
                "billing_period_max_kva"
            ],
            "billing_period_max_kw": tariff_result["demand_evidence"][
                "billing_period_max_kw"
            ],
        },
        "ranking_basis": (
            "Lowest post-dispatch raw rolling kVA, then smaller authored PV and "
            "battery capacity; this is a physical review order, not a recommendation."
        ),
        "scenarios": ranked,
        "report_preview": {
            "status": "ready",
            "output_kind": "in_app_evidence_preview",
            "download_available": False,
            "sections": [
                "Evidence-bound baseline",
                "Analyst-authored battery assumptions",
                "Analyst-authored PV assumptions",
                "12-month PV and battery physical comparison",
                "Peak-day dispatch and SOC evidence",
                "kW/kVA/PF model boundaries",
            ],
            "disclaimer": (
                "Internal physical review only. No tariff savings, cost, payback, "
                "eligibility, recommendation or customer claim is calculated."
            ),
        },
        "assumptions": [
            "Battery inputs were explicitly authored for this request and are not product defaults.",
            "PV uses the selected normalized shape scaled to the explicitly authored annual specific yield and derating factor.",
            "PV-to-battery charging is DC-coupled and does not consume the shared bidirectional AC-port headroom.",
            "Reactive support is Python-owned, explicitly authored, never exceeds measured site reactive import, and is customer-facing disabled.",
            "A circular P-Q capability is an editable analyst assumption, not a Fox equipment fact or guarantee; exact nonlinear replay validates every interval.",
            "The repository-owned HiGHS planner and 48-hour/24-hour rolling replay are the dispatch authority.",
            "The active evidence profile and bill reconciliation must pass before scenarios run.",
        ],
    }


def rank_ci_physical_scenario_results(
    results: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Return the authoritative physical-review order and rewrite contiguous ranks."""

    ranked = sorted(
        results,
        key=lambda item: (
            item["post_dispatch"]["raw_rolling_demand_kva"],
            item["authored_inputs"]["pv_capacity_kwp_dc"],
            item["authored_inputs"]["nominal_capacity_kwh"],
            item["scenario_id"],
        ),
    )
    for rank, item in enumerate(ranked, start=1):
        item["physical_review_rank"] = rank
    return ranked


def analyze_ci_three_case_comparison(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
    pv_only_scenario_id: object,
    pv_battery_scenario_id: object,
) -> dict[str, object]:
    """Return one explicitly paired, aligned no-system/PV/PV+battery review day."""
    authored = _validated_scenarios(scenarios)
    pv_only, pv_battery = _validated_comparison_pair(
        authored,
        pv_only_scenario_id=pv_only_scenario_id,
        pv_battery_scenario_id=pv_battery_scenario_id,
    )

    parsed = validated_ci_nem12_evidence(upload_bytes, profile=profile)
    tariff_result = analyze_ci_nem12(
        upload_bytes,
        profile=profile,
        _validated_evidence=parsed,
    )
    periods, interval_evidence = _build_periods(parsed["streams"], profile)
    tariff_membership = _compile_tariff_row_membership(
        periods,
        interval_evidence,
        profile,
    )
    annual_tariff_baseline_cache: dict[str, object] = {}
    pv_generation_cache: dict[tuple[object, ...], tuple[float, ...]] = {}
    pv_only_execution = _execute_scenario(
        pv_only,
        periods,
        interval_evidence,
        tariff_membership,
        profile,
        annual_tariff_baseline_cache,
        pv_generation_cache,
    )
    pv_battery_execution = _execute_scenario(
        pv_battery,
        periods,
        interval_evidence,
        tariff_membership,
        profile,
        annual_tariff_baseline_cache,
        pv_generation_cache,
    )
    return _three_case_comparison_projection(
        tariff_result=tariff_result,
        profile=profile,
        pv_only=pv_only_execution,
        pv_battery=pv_battery_execution,
    )


def analyze_ci_internal_report_source(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    scenarios: object,
    pv_only_scenario_id: object,
    pv_battery_scenario_id: object,
) -> dict[str, object]:
    """Build report sources from one authoritative execution of each scenario."""
    authored = _validated_scenarios(scenarios)
    pv_only, pv_battery = _validated_comparison_pair(
        authored,
        pv_only_scenario_id=pv_only_scenario_id,
        pv_battery_scenario_id=pv_battery_scenario_id,
    )
    parsed = validated_ci_nem12_evidence(upload_bytes, profile=profile)
    tariff_result = analyze_ci_nem12(
        upload_bytes,
        profile=profile,
        _validated_evidence=parsed,
    )
    periods, interval_evidence = _build_periods(parsed["streams"], profile)
    tariff_membership = _compile_tariff_row_membership(
        periods,
        interval_evidence,
        profile,
    )
    annual_tariff_baseline_cache: dict[str, object] = {}
    pv_generation_cache: dict[tuple[object, ...], tuple[float, ...]] = {}
    executions = {
        item.scenario_id: _execute_scenario(
            item,
            periods,
            interval_evidence,
            tariff_membership,
            profile,
            annual_tariff_baseline_cache,
            pv_generation_cache,
        )
        for item in authored
    }
    physical_result = _physical_scenario_result(
        tariff_result=tariff_result,
        results=[item.public_result for item in executions.values()],
    )
    comparison = _three_case_comparison_projection(
        tariff_result=tariff_result,
        profile=profile,
        pv_only=executions[pv_only.scenario_id],
        pv_battery=executions[pv_battery.scenario_id],
    )
    return {
        "contract_version": "ci_internal_report_source_v1",
        "analysis": tariff_result,
        "physical_result": physical_result,
        "comparison": comparison,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }


def _validated_comparison_pair(
    authored: tuple[_Scenario, ...],
    *,
    pv_only_scenario_id: object,
    pv_battery_scenario_id: object,
) -> tuple[_Scenario, _Scenario]:
    if (
        not isinstance(pv_only_scenario_id, str)
        or not pv_only_scenario_id.strip()
        or not isinstance(pv_battery_scenario_id, str)
        or not pv_battery_scenario_id.strip()
        or pv_only_scenario_id == pv_battery_scenario_id
    ):
        raise CiScenarioAnalysisError("comparison_contract_invalid")
    by_id = {item.scenario_id: item for item in authored}
    try:
        pv_only = by_id[pv_only_scenario_id]
        pv_battery = by_id[pv_battery_scenario_id]
    except KeyError as exc:
        raise CiScenarioAnalysisError("comparison_contract_invalid") from exc
    if (
        pv_only.nominal_capacity_kwh != 0
        or pv_only.pv_capacity_kwp_dc <= 0
        or pv_battery.nominal_capacity_kwh <= 0
        or pv_battery.pv_capacity_kwp_dc <= 0
    ):
        raise CiScenarioAnalysisError("comparison_pair_invalid")
    pv_pair_fields = (
        "pv_system_id",
        "pv_profile_id",
        "pv_capacity_kwp_dc",
        "pv_inverter_capacity_kw_ac",
        "shared_ac_headroom_kw",
        "reactive_support_enabled",
        "reactive_support_max_kvar",
        "shared_inverter_apparent_power_limit_kva",
        "reactive_capability_curve",
        "reactive_capability_provenance",
        "reactive_overcompensation_permitted",
        "pv_annual_specific_yield_kwh_per_kw",
        "pv_derating_factor",
    )
    if any(
        getattr(pv_only, field) != getattr(pv_battery, field)
        for field in pv_pair_fields
    ):
        raise CiScenarioAnalysisError("comparison_pair_invalid")
    return pv_only, pv_battery


def _run_scenario(
    scenario: _Scenario,
    periods: tuple[PeakShavingPeriodInput, ...],
    evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    annual_tariff_baseline_cache: dict[str, object] | None = None,
    pv_generation_cache: (
        dict[tuple[object, ...], tuple[float, ...]] | None
    ) = None,
) -> dict[str, object]:
    return _execute_scenario(
        scenario,
        periods,
        evidence,
        tariff_membership,
        profile,
        annual_tariff_baseline_cache,
        pv_generation_cache,
    ).public_result


def _execute_scenario(
    scenario: _Scenario,
    periods: tuple[PeakShavingPeriodInput, ...],
    evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    annual_tariff_baseline_cache: dict[str, object] | None = None,
    pv_generation_cache: (
        dict[tuple[object, ...], tuple[float, ...]] | None
    ) = None,
) -> _ScenarioExecution:
    flat_intervals = tuple(
        interval for period in periods for interval in period.intervals
    )
    _validate_tariff_row_membership(tariff_membership, len(flat_intervals))
    pv_cache_key = (
        scenario.pv_profile_id,
        scenario.pv_capacity_kwp_dc,
        scenario.pv_annual_specific_yield_kwh_per_kw,
        scenario.pv_derating_factor,
    )
    cached_raw_pv_kw = (
        pv_generation_cache.get(pv_cache_key)
        if pv_generation_cache is not None
        else None
    )
    if cached_raw_pv_kw is not None:
        raw_pv_kw = cached_raw_pv_kw
    else:
        pv_per_kw_kwh = build_pv_profile(
            tuple(interval.timestamp for interval in flat_intervals),
            scenario.pv_annual_specific_yield_kwh_per_kw,
        )
        raw_pv_kw = tuple(
            per_kw_kwh
            * scenario.pv_capacity_kwp_dc
            * scenario.pv_derating_factor
            / (interval.interval_minutes / 60)
            for interval, per_kw_kwh in zip(
                flat_intervals, pv_per_kw_kwh, strict=True
            )
        )
        if pv_generation_cache is not None:
            pv_generation_cache[pv_cache_key] = raw_pv_kw
    if scenario.nominal_capacity_kwh == 0:
        dispatch_rows = []
        for index, interval in enumerate(flat_intervals):
            source_kvar = float(evidence[interval.timestamp]["kvar"])
            apparent_active_limit = (
                scenario.shared_inverter_apparent_power_limit_kva
                if scenario.reactive_support_enabled
                else scenario.shared_ac_headroom_kw
            )
            if apparent_active_limit is None:
                raise CiScenarioAnalysisError("scenario_contract_invalid")
            pv_to_ac = min(
                raw_pv_kw[index],
                scenario.shared_ac_headroom_kw,
                apparent_active_limit,
            )
            reactive_support = _pv_only_reactive_support(
                scenario,
                site_reactive_kvar=source_kvar,
                shared_active_kw=pv_to_ac,
            )
            grid_import = max(0.0, interval.load_kw_avg - pv_to_ac)
            post_kvar = source_kvar - reactive_support
            dispatch_rows.append(
                {
                    "timestamp": interval.timestamp,
                    "grid_import_kw": grid_import,
                    "pv_export_kw": max(0.0, pv_to_ac - interval.load_kw_avg),
                    "pv_to_ac_kw": pv_to_ac,
                    "shared_ac_port_kw": pv_to_ac,
                    "site_reactive_import_kvar": source_kvar,
                    "inverter_reactive_support_kvar": reactive_support,
                    "post_grid_reactive_kvar": post_kvar,
                    "exact_grid_import_kva": math.hypot(grid_import, post_kvar),
                    "shared_inverter_apparent_power_kva": math.hypot(
                        pv_to_ac, reactive_support
                    ),
                }
            )
        dispatch = tuple(dispatch_rows)
        optimizer_snapshot = None
        optimizer_audit = None
        planned_demand_limits_kva: list[dict[str, object]] = []
        selected_monthly_thresholds = [None] * len(periods)
    else:
        problem = _optimizer_problem(
            scenario,
            periods,
            flat_intervals,
            raw_pv_kw,
            evidence,
            tariff_membership,
            profile,
        )
        try:
            rolling = execute_ci_peak_shaving_rolling(problem)
        except (RuntimeError, ValueError) as exc:
            raise CiScenarioAnalysisError("scenario_execution_failed") from exc
        if rolling.status not in {
            CiOptimizerStatus.OPTIMAL_LP_EXACT,
            CiOptimizerStatus.OPTIMAL_MILP,
            CiOptimizerStatus.BOUNDED_OPTIMAL,
        } or len(rolling.intervals) != len(flat_intervals):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        dispatch = tuple(
            {
                "timestamp": row.timestamp,
                "grid_import_kw": row.grid_import_kw,
                "pv_export_kw": row.pv_export_kw,
                "pv_to_ac_kw": row.pv_to_ac_kw,
                "grid_charge_kw": row.grid_charge_kw,
                "pv_charge_kw": row.pv_charge_kw,
                "discharge_kw": row.discharge_kw,
                "soc_start_kwh": row.soc_start_kwh,
                "soc_end_kwh": row.soc_end_kwh,
                "shared_ac_port_kw": row.shared_ac_port_kw,
                "site_reactive_import_kvar": row.site_reactive_import_kvar,
                "inverter_reactive_support_kvar": (
                    row.inverter_reactive_support_kvar
                ),
                "post_grid_reactive_kvar": row.post_grid_reactive_kvar,
                "exact_grid_import_kva": row.exact_grid_import_kva,
                "shared_inverter_apparent_power_kva": (
                    row.shared_inverter_apparent_power_kva
                ),
            }
            for row in rolling.intervals
        )
        optimizer_snapshot, optimizer_audit = _optimizer_snapshot(
            problem,
            rolling,
            scenario,
            profile,
        )
        planned_demand_limits_kva = _planned_demand_limits_kva(
            problem,
            rolling,
            profile,
        )
        planner_limits_by_component = dict(
            rolling.annual_planner_demand_limits
        )
        selected_monthly_thresholds = [
            planner_limits_by_component.get(
                f"incentive_kva:{period.period_id}"
            )
            for period in periods
        ]

    rows: list[dict[str, object]] = []
    for row in dispatch:
        source = evidence[row["timestamp"]]
        post_kw = max(0.0, float(row["grid_import_kw"]))
        kvar = float(source["kvar"])
        post_kvar = float(row.get("post_grid_reactive_kvar", kvar))
        rows.append(
            {
                **source,
                "post_kw": post_kw,
                "post_export_kw": float(source["baseline_export_kw"])
                + float(row["pv_export_kw"]),
                "baseline_kva": math.hypot(
                    float(source["baseline_kw"]), kvar
                ),
                "site_import_kvar": kvar,
                "reactive_support_kvar": float(
                    row.get("inverter_reactive_support_kvar", 0.0)
                ),
                "post_grid_kvar": post_kvar,
                "post_kva": math.hypot(post_kw, post_kvar),
            }
        )
    incentive_rows = [
        row
        for row, in_billing_period, in_incentive_window in zip(
            rows,
            tariff_membership.billing_period,
            tariff_membership.incentive_demand,
            strict=True,
        )
        if in_billing_period and in_incentive_window
    ]
    rolling_rows = [row for row in rows if row["rolling_window"]]
    bill_rows = [
        row
        for row, included in zip(
            rows,
            tariff_membership.billing_period,
            strict=True,
        )
        if included
    ]
    if not rolling_rows or (bill_rows and not incentive_rows):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    raw_rolling = max(float(row["post_kva"]) for row in rolling_rows)
    chargeable = max(
        raw_rolling, float(profile["minimum_chargeable_rolling_kva"])
    )
    if bill_rows:
        baseline_peak_kw = max(float(row["baseline_kw"]) for row in bill_rows)
        post_peak_kw = max(float(row["post_kw"]) for row in bill_rows)
        billing_peak_change_kw = post_peak_kw - baseline_peak_kw
        billing_projection = {
            "incentive_demand_kva": (
                round(max(float(row["post_kva"]) for row in incentive_rows), 3)
                if incentive_rows
                else None
            ),
            "billing_period_max_kva": round(
                max(float(row["post_kva"]) for row in bill_rows), 3
            ),
            "billing_period_max_kw": round(post_peak_kw, 3),
            "billing_period_peak_kw_reduction": round(
                baseline_peak_kw - post_peak_kw, 3
            ),
            "billing_period_peak_effect": (
                "increase"
                if billing_peak_change_kw > 0
                else "reduction"
                if billing_peak_change_kw < 0
                else "unchanged"
            ),
            "billing_period_peak_change_kw": round(abs(billing_peak_change_kw), 3),
            "billing_period_projection_status": "evaluated",
        }
    else:
        billing_projection = {
            "incentive_demand_kva": None,
            "billing_period_max_kva": None,
            "billing_period_max_kw": None,
            "billing_period_peak_kw_reduction": None,
            "billing_period_peak_effect": "not_evaluated_disjoint_analysis_period",
            "billing_period_peak_change_kw": None,
            "billing_period_projection_status": (
                "not_evaluated_disjoint_analysis_period"
            ),
        }
    delivered_pv_kwh = sum(
        (float(row["pv_to_ac_kw"]) + float(row.get("pv_charge_kw", 0.0)))
        * interval.interval_minutes
        / 60
        for row, interval in zip(dispatch, flat_intervals, strict=True)
    )
    raw_pv_kwh = sum(
        value * interval.interval_minutes / 60
        for value, interval in zip(raw_pv_kw, flat_intervals, strict=True)
    )
    result: dict[str, object] = {
        "scenario_id": scenario.scenario_id,
        "label": scenario.label,
        "physical_review_rank": 0,
        "authored_inputs": {
            key: value
            for key, value in asdict(scenario).items()
            if key not in {"scenario_id", "label"}
        },
        "post_dispatch": {
            "authority_source": (
                CI_PEAK_SHAVING_ROLLING_REPLAY_ID
                if optimizer_snapshot is not None
                else CI_PV_ONLY_EXACT_ID
            ),
            "pv_generation_kwh": round(delivered_pv_kwh, 3),
            "pv_curtailed_kwh": round(max(0.0, raw_pv_kwh - delivered_pv_kwh), 3),
            "raw_rolling_demand_kva": round(raw_rolling, 3),
            "chargeable_rolling_demand_kva": round(chargeable, 3),
            "maximum_reactive_support_kvar": round(
                max(float(row["reactive_support_kvar"]) for row in rows), 6
            ),
            "maximum_post_grid_reactive_kvar": round(
                max(float(row["post_grid_kvar"]) for row in rows), 6
            ),
            "maximum_shared_inverter_apparent_power_kva": round(
                max(
                    float(row.get("shared_inverter_apparent_power_kva", 0.0))
                    for row in dispatch
                ),
                6,
            ),
            **billing_projection,
        },
        "dispatch_review_projection": _dispatch_review_projection(
            rows=rows,
            dispatch=dispatch,
            authority_source=(
                CI_PEAK_SHAVING_ROLLING_REPLAY_ID
                if optimizer_snapshot is not None
                else CI_PV_ONLY_EXACT_ID
            ),
            optimizer_snapshot=optimizer_snapshot,
        ),
        "annual_tariff_value": _annual_tariff_value(
            rows,
            tariff_membership,
            profile,
            baseline_cache=annual_tariff_baseline_cache,
        ),
        "planned_demand_limits_kva": planned_demand_limits_kva,
        "selected_monthly_thresholds_kw": selected_monthly_thresholds,
        "optimizer_run_snapshot": optimizer_snapshot,
        "optimizer_audit_projection": optimizer_audit,
    }
    return _ScenarioExecution(
        scenario=scenario,
        public_result=result,
        rows=tuple(rows),
        dispatch=dispatch,
    )


def _three_case_comparison_projection(
    *,
    tariff_result: dict[str, object],
    profile: dict[str, Any],
    pv_only: _ScenarioExecution,
    pv_battery: _ScenarioExecution,
) -> dict[str, object]:
    if not (
        len(pv_only.rows)
        == len(pv_only.dispatch)
        == len(pv_battery.rows)
        == len(pv_battery.dispatch)
    ):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    battery_rolling = [row for row in pv_battery.rows if row["rolling_window"]]
    if not battery_rolling:
        raise CiScenarioAnalysisError("scenario_execution_failed")
    selected_peak = min(
        battery_rolling,
        key=lambda row: (-float(row["post_kva"]), row["meter_start"]),
    )
    selected_local_start = selected_peak["local_start"]
    if not isinstance(selected_local_start, datetime):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    selected_date = selected_local_start.date()
    points: list[dict[str, object]] = []
    for pv_row, pv_dispatch, battery_row, battery_dispatch in zip(
        pv_only.rows,
        pv_only.dispatch,
        pv_battery.rows,
        pv_battery.dispatch,
        strict=True,
    ):
        if (
            pv_dispatch["timestamp"] != battery_dispatch["timestamp"]
            or pv_row["meter_start"] != battery_row["meter_start"]
            or pv_row["local_start"] != battery_row["local_start"]
            or float(pv_row["baseline_kw"]) != float(battery_row["baseline_kw"])
            or float(pv_row["baseline_kva"]) != float(battery_row["baseline_kva"])
        ):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        local_start = battery_row["local_start"]
        if not isinstance(local_start, datetime):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        if local_start.date() != selected_date:
            continue
        point = {
            "interval_timestamp": battery_dispatch["timestamp"].isoformat(),
            "local_timestamp": local_start.isoformat(),
            "local_time_label": local_start.strftime("%H:%M %Z"),
            "no_system": {
                "import_kw": round(float(battery_row["baseline_kw"]), 6),
                "import_kva": round(float(battery_row["baseline_kva"]), 6),
                "site_reactive_import_kvar": round(
                    float(battery_row["site_import_kvar"]), 6
                ),
                "reactive_support_kvar": 0.0,
                "post_grid_reactive_kvar": round(
                    float(battery_row["site_import_kvar"]), 6
                ),
                "grid_charge_kw": 0.0,
                "pv_charge_kw": 0.0,
                "battery_discharge_kw": 0.0,
                "soc_end_kwh": None,
            },
            "pv_only": {
                "import_kw": round(float(pv_row["post_kw"]), 6),
                "import_kva": round(float(pv_row["post_kva"]), 6),
                "site_reactive_import_kvar": round(
                    float(pv_row["site_import_kvar"]), 6
                ),
                "reactive_support_kvar": round(
                    float(pv_row["reactive_support_kvar"]), 6
                ),
                "post_grid_reactive_kvar": round(
                    float(pv_row["post_grid_kvar"]), 6
                ),
                "grid_charge_kw": 0.0,
                "pv_charge_kw": 0.0,
                "battery_discharge_kw": 0.0,
                "soc_end_kwh": None,
            },
            "pv_battery": {
                "import_kw": round(float(battery_row["post_kw"]), 6),
                "import_kva": round(float(battery_row["post_kva"]), 6),
                "site_reactive_import_kvar": round(
                    float(battery_row["site_import_kvar"]), 6
                ),
                "reactive_support_kvar": round(
                    float(battery_row["reactive_support_kvar"]), 6
                ),
                "post_grid_reactive_kvar": round(
                    float(battery_row["post_grid_kvar"]), 6
                ),
                "grid_charge_kw": round(
                    float(battery_dispatch.get("grid_charge_kw", 0.0)), 6
                ),
                "pv_charge_kw": round(
                    float(battery_dispatch.get("pv_charge_kw", 0.0)), 6
                ),
                "battery_discharge_kw": round(
                    float(battery_dispatch.get("discharge_kw", 0.0)), 6
                ),
                "soc_end_kwh": round(float(battery_dispatch["soc_end_kwh"]), 6),
            },
        }
        if not all(
            math.isfinite(float(value))
            for case in (point["no_system"], point["pv_only"], point["pv_battery"])
            for value in case.values()
            if value is not None
        ) or any(
            float(value) < 0
            for case in (point["no_system"], point["pv_only"], point["pv_battery"])
            for value in case.values()
            if value is not None
        ):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        points.append(point)
    if not points or len(points) > 100:
        raise CiScenarioAnalysisError("scenario_execution_failed")

    battery_result = pv_battery.public_result
    pv_result = pv_only.public_result
    battery_projection = battery_result["dispatch_review_projection"]
    pv_projection = pv_result["dispatch_review_projection"]
    battery_snapshot = battery_result["optimizer_run_snapshot"]
    if not (
        isinstance(battery_projection, dict)
        and isinstance(pv_projection, dict)
        and isinstance(battery_snapshot, dict)
        and _is_sha256(battery_snapshot.get("snapshot_sha256"))
    ):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    demand_evidence = tariff_result["demand_evidence"]
    if not isinstance(demand_evidence, dict):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    without_digest = {
        "contract_version": CI_THREE_CASE_COMPARISON_CONTRACT_VERSION,
        "status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "selection_basis": (
            "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp"
        ),
        "pairing_basis": "explicit_consultant_selected_exact_pv_match",
        "common_local_date": selected_date.isoformat(),
        "selected_peak_interval_timestamp": selected_peak["meter_start"].isoformat(),
        "coverage": {
            "interval_minutes": 15,
            "interval_count": len(points),
            "start_local_timestamp": points[0]["local_timestamp"],
            "end_local_timestamp": points[-1]["local_timestamp"],
            "timestamps_aligned": True,
        },
        "units": {
            "active_power": "kW",
            "apparent_power": "kVA",
            "reactive_power": "kvar",
            "stored_energy": "kWh",
        },
        "cases": [
            {
                "case_id": "no_system",
                "label": "No system",
                "scenario_id": None,
                "authority_source": "ci_evidence_bound_baseline_v1",
                "soc_status": "not_applicable_no_battery",
                "projection_sha256": None,
                "optimizer_snapshot_sha256": None,
                "interval_dispatch_sha256": None,
            },
            {
                "case_id": "pv_only",
                "label": pv_only.scenario.label,
                "scenario_id": pv_only.scenario.scenario_id,
                "authority_source": CI_PV_ONLY_EXACT_ID,
                "soc_status": "not_applicable_no_battery",
                "projection_sha256": pv_projection["projection_sha256"],
                "optimizer_snapshot_sha256": None,
                "interval_dispatch_sha256": None,
            },
            {
                "case_id": "pv_battery",
                "label": pv_battery.scenario.label,
                "scenario_id": pv_battery.scenario.scenario_id,
                "authority_source": CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
                "soc_status": "available",
                "projection_sha256": battery_projection["projection_sha256"],
                "optimizer_snapshot_sha256": battery_snapshot["snapshot_sha256"],
                "interval_dispatch_sha256": battery_projection[
                    "interval_dispatch_sha256"
                ],
            },
        ],
        "baseline": {
            "raw_rolling_demand_kva": demand_evidence["rolling_demand_kva"],
            "chargeable_rolling_demand_kva": demand_evidence[
                "chargeable_rolling_demand_kva"
            ],
            "incentive_demand_kva": demand_evidence["incentive_demand_kva"],
            "billing_period_max_kva": demand_evidence["billing_period_max_kva"],
            "billing_period_max_kw": demand_evidence["billing_period_max_kw"],
        },
        "provenance": {
            "source_contract_version": CI_PHYSICAL_SCENARIO_CONTRACT_VERSION,
            "profile_id": profile["profile_id"],
            "profile_source_version": profile["source_version"],
            "source_nem12_sha256": profile["expected_nem12_sha256"],
            "pv_only_scenario_sha256": _canonical_sha256(asdict(pv_only.scenario)),
            "pv_battery_scenario_sha256": _canonical_sha256(
                asdict(pv_battery.scenario)
            ),
        },
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "eligibility_permitted": False,
        "report_available": False,
        "download_available": False,
        "delivery_permitted": False,
        "points": points,
    }
    return {
        **without_digest,
        "comparison_sha256": _canonical_sha256(without_digest),
    }


def _dispatch_review_projection(
    *,
    rows: list[dict[str, object]],
    dispatch: tuple[dict[str, object], ...],
    authority_source: str,
    optimizer_snapshot: dict[str, object] | None,
) -> dict[str, object]:
    if len(rows) != len(dispatch):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    rolling_rows = [row for row in rows if row["rolling_window"]]
    if not rolling_rows:
        raise CiScenarioAnalysisError("scenario_execution_failed")
    peak_row = min(
        rolling_rows,
        key=lambda row: (
            -float(row["post_kva"]),
            row["meter_start"],
        ),
    )
    peak_local_start = peak_row["local_start"]
    if not isinstance(peak_local_start, datetime):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    peak_local_date = peak_local_start.date()
    point_rows: list[dict[str, object]] = []
    for row, dispatch_row in zip(rows, dispatch, strict=True):
        local_start = row["local_start"]
        if not isinstance(local_start, datetime):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        if local_start.date() != peak_local_date:
            continue
        point_rows.append(
            {
                "interval_timestamp": dispatch_row["timestamp"].isoformat(),
                "local_timestamp": local_start.isoformat(),
                "local_time_label": local_start.strftime("%H:%M %Z"),
                "baseline_import_kw": round(float(row["baseline_kw"]), 6),
                "post_dispatch_import_kw": round(float(row["post_kw"]), 6),
                "baseline_kva": round(float(row["baseline_kva"]), 6),
                "post_dispatch_kva": round(float(row["post_kva"]), 6),
                "site_reactive_import_kvar": round(
                    float(row["site_import_kvar"]), 6
                ),
                "inverter_reactive_support_kvar": round(
                    float(row["reactive_support_kvar"]), 6
                ),
                "post_grid_reactive_kvar": round(
                    float(row["post_grid_kvar"]), 6
                ),
                "grid_charge_kw": round(
                    float(dispatch_row.get("grid_charge_kw", 0.0)), 6
                ),
                "pv_charge_kw": round(
                    float(dispatch_row.get("pv_charge_kw", 0.0)), 6
                ),
                "battery_discharge_kw": round(
                    float(dispatch_row.get("discharge_kw", 0.0)), 6
                ),
                "soc_end_kwh": (
                    round(float(dispatch_row["soc_end_kwh"]), 6)
                    if "soc_end_kwh" in dispatch_row
                    else None
                ),
            }
        )
    if not point_rows or len(point_rows) > 100:
        raise CiScenarioAnalysisError("scenario_execution_failed")

    has_battery = optimizer_snapshot is not None
    if has_battery and any(point["soc_end_kwh"] is None for point in point_rows):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    result_projection = (
        optimizer_snapshot.get("result_projection", {})
        if optimizer_snapshot is not None
        else {}
    )
    if not isinstance(result_projection, dict):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    optimizer_snapshot_sha256 = (
        optimizer_snapshot.get("snapshot_sha256")
        if optimizer_snapshot is not None
        else None
    )
    interval_dispatch_sha256 = (
        result_projection.get("interval_dispatch_sha256")
        if optimizer_snapshot is not None
        else None
    )
    if has_battery and (
        authority_source != CI_PEAK_SHAVING_ROLLING_REPLAY_ID
        or not _is_sha256(optimizer_snapshot_sha256)
        or not _is_sha256(interval_dispatch_sha256)
    ):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    if not has_battery and authority_source != CI_PV_ONLY_EXACT_ID:
        raise CiScenarioAnalysisError("scenario_execution_failed")
    for point in point_rows:
        numeric_values = (
            point["baseline_import_kw"],
            point["post_dispatch_import_kw"],
            point["baseline_kva"],
            point["post_dispatch_kva"],
            point["site_reactive_import_kvar"],
            point["inverter_reactive_support_kvar"],
            point["post_grid_reactive_kvar"],
            point["grid_charge_kw"],
            point["pv_charge_kw"],
            point["battery_discharge_kw"],
        )
        if not all(math.isfinite(float(value)) for value in numeric_values):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        if point["soc_end_kwh"] is not None and not math.isfinite(
            float(point["soc_end_kwh"])
        ):
            raise CiScenarioAnalysisError("scenario_execution_failed")
        if any(
            float(point[key]) < 0
            for key in (
                "grid_charge_kw",
                "pv_charge_kw",
                "battery_discharge_kw",
            )
        ):
            raise CiScenarioAnalysisError("scenario_execution_failed")
    if not has_battery and any(
        point["soc_end_kwh"] is not None
        or any(
            float(point[key]) != 0.0
            for key in (
                "grid_charge_kw",
                "pv_charge_kw",
                "battery_discharge_kw",
            )
        )
        for point in point_rows
    ):
        raise CiScenarioAnalysisError("scenario_execution_failed")
    projection_without_hash = {
        "contract_version": CI_DISPATCH_REVIEW_PROJECTION_CONTRACT_VERSION,
        "status": "ready",
        "selection_basis": (
            "maximum_post_dispatch_rolling_kva_earliest_timestamp"
        ),
        "peak_local_date": peak_local_date.isoformat(),
        "peak_interval": {
            "interval_timestamp": peak_row["meter_start"].isoformat(),
            "local_timestamp": peak_local_start.isoformat(),
            "baseline_import_kw": round(float(peak_row["baseline_kw"]), 6),
            "post_dispatch_import_kw": round(float(peak_row["post_kw"]), 6),
            "baseline_kva": round(float(peak_row["baseline_kva"]), 6),
            "post_dispatch_kva": round(float(peak_row["post_kva"]), 6),
        },
        "coverage": {
            "interval_minutes": 15,
            "interval_count": len(point_rows),
            "start_local_timestamp": point_rows[0]["local_timestamp"],
            "end_local_timestamp": point_rows[-1]["local_timestamp"],
        },
        "units": {
            "active_power": "kW",
            "apparent_power": "kVA",
            "reactive_power": "kvar",
            "stored_energy": "kWh",
        },
        "soc_status": (
            "available" if has_battery else "not_applicable_no_battery"
        ),
        "authority_source": authority_source,
        "optimizer_snapshot_sha256": optimizer_snapshot_sha256,
        "interval_dispatch_sha256": interval_dispatch_sha256,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "points": point_rows,
    }
    return {
        **projection_without_hash,
        "projection_sha256": _canonical_sha256(projection_without_hash),
    }


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _pv_only_reactive_support(
    scenario: _Scenario,
    *,
    site_reactive_kvar: float,
    shared_active_kw: float,
) -> float:
    if not scenario.reactive_support_enabled:
        return 0.0
    apparent_limit = scenario.shared_inverter_apparent_power_limit_kva
    if apparent_limit is None or abs(shared_active_kw) > apparent_limit + 1e-9:
        raise CiScenarioAnalysisError("scenario_execution_failed")
    envelope_limit = math.sqrt(
        max(0.0, apparent_limit * apparent_limit - shared_active_kw**2)
    )
    return min(
        site_reactive_kvar,
        scenario.reactive_support_max_kvar,
        envelope_limit,
    )


def _optimizer_problem(
    scenario: _Scenario,
    periods: tuple[PeakShavingPeriodInput, ...],
    flat_intervals: tuple[CleanedInterval, ...],
    raw_pv_kw: tuple[float, ...],
    evidence: dict[datetime, dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
) -> CiOptimizerProblem:
    optimizer_intervals = tuple(
        CiOptimizerInterval(
            timestamp=interval.timestamp,
            duration_hours=interval.interval_minutes / 60,
            load_kw=interval.load_kw_avg,
            pv_kw=raw_pv_kw[index],
            reactive_kvar=float(evidence[interval.timestamp]["kvar"]),
            import_rate_aud_per_kwh=(
                tariff_membership.optimizer_import_rates[index]
            ),
            export_credit_aud_per_kwh=_optimizer_export_credit(profile),
        )
        for index, interval in enumerate(flat_intervals)
    )
    period_indexes: list[tuple[int, ...]] = []
    offset = 0
    for period in periods:
        indexes = tuple(range(offset, offset + len(period.intervals)))
        period_indexes.append(indexes)
        offset += len(indexes)
    rates = profile["rates"]
    demand_charges: list[CiDemandCharge] = []
    rolling_indexes = tuple(
        index
        for index, interval in enumerate(flat_intervals)
        if bool(evidence[interval.timestamp]["rolling_window"])
    )
    annual_rolling_rate = (
        float(rates["rolling_demand_aud_per_kva_month"]) * 12
    )
    if annual_rolling_rate > 0.0:
        demand_charges.append(
            CiDemandCharge(
                "annual_rolling_kva",
                annual_rolling_rate,
                rolling_indexes,
                basis="kva",
                minimum_chargeable=float(
                    profile["minimum_chargeable_rolling_kva"]
                ),
            )
        )
    annual_model = profile.get("annual_financial_model")
    if not isinstance(annual_model, dict):
        raise CiScenarioAnalysisError("annual_value_unavailable")
    incentive_months = set(annual_model["incentive_demand_months"])
    incentive_rate = float(
        annual_model["incentive_demand_aud_per_kva_month"]
    )
    for period, indexes in zip(periods, period_indexes, strict=True):
        selected = tuple(
            index
            for index in indexes
            if tariff_membership.local_months[index] in incentive_months
            and tariff_membership.incentive_demand[index]
        )
        if selected and incentive_rate > 0.0:
            demand_charges.append(
                CiDemandCharge(
                    f"incentive_kva:{period.period_id}",
                    incentive_rate,
                    selected,
                    basis="kva",
                )
            )
    try:
        return CiOptimizerProblem(
            intervals=optimizer_intervals,
            battery=CiBatterySpec(
                nominal_capacity_kwh=scenario.nominal_capacity_kwh,
                min_soc_fraction=scenario.min_soc_fraction,
                max_soc_fraction=scenario.max_soc_fraction,
                max_charge_kw=scenario.max_charge_kw,
                max_discharge_kw=scenario.max_discharge_kw,
                ac_round_trip_efficiency=(
                    scenario.charge_efficiency * scenario.discharge_efficiency
                ),
                initial_soc_fraction=scenario.initial_soc_fraction,
                terminal_soc_fraction=scenario.initial_soc_fraction,
            ),
            demand_charges=tuple(demand_charges),
            billing_periods=tuple(
                CiBillingPeriod(period.period_id, indexes)
                for period, indexes in zip(periods, period_indexes, strict=True)
            ),
            shared_ac_headroom_kw=scenario.shared_ac_headroom_kw,
            reactive_support=CiReactiveSupportSpec(
                enabled=scenario.reactive_support_enabled,
                max_reactive_support_kvar=scenario.reactive_support_max_kvar,
                inverter_apparent_power_limit_kva=(
                    scenario.shared_inverter_apparent_power_limit_kva
                ),
                capability_curve=scenario.reactive_capability_curve,
                provenance=scenario.reactive_capability_provenance,
                overcompensation_permitted=(
                    scenario.reactive_overcompensation_permitted
                ),
            ),
            config=CiOptimizerConfig(
                allow_grid_charging=scenario.allow_grid_charging,
                time_limit_seconds=120.0,
            ),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise CiScenarioAnalysisError("scenario_contract_invalid") from exc


def _optimizer_import_rate(
    row: dict[str, object], profile: dict[str, Any]
) -> float:
    retail_peak = _row_in_window(row, profile["retail_energy_window"])
    network_peak = _row_in_window(row, profile["network_energy_window"])
    return _optimizer_import_rate_from_membership(
        retail_peak=retail_peak,
        network_peak=network_peak,
        profile=profile,
    )


def _optimizer_import_rate_from_membership(
    *,
    retail_peak: bool,
    network_peak: bool,
    profile: dict[str, Any],
) -> float:
    rates = profile["rates"]
    factors = profile["factors"]
    retail_key = (
        "retail_peak_c_per_kwh"
        if retail_peak
        else "retail_off_peak_c_per_kwh"
    )
    network_key = (
        "network_peak_c_per_kwh"
        if network_peak
        else "network_off_peak_c_per_kwh"
    )
    retail = float(rates[retail_key]) * float(factors["mlf"]) * float(
        factors["dlf"]
    )
    network = float(rates[network_key])
    regulated = (
        float(rates["aemo_ancillary_c_per_kwh"])
        + float(rates["aemo_participant_c_per_kwh"])
    ) * float(factors["dlf"])
    environmental = sum(
        float(item["rate_c_per_kwh"])
        * float(item["certificate_fraction"])
        * float(factors["dlf"])
        for item in rates["environmental"]
    )
    return (retail + network + regulated + environmental) / 100


def _optimizer_export_credit(_profile: dict[str, Any]) -> float:
    """Match dispatch to the approved tariff replay's zero export value.

    The current C&I tariff contract records B1 exports but has no approved
    feed-in or export-credit rate. AEMO import charges are avoided when onsite
    PV reduces imports; they are not revenue earned by excess exports.
    """

    return 0.0


def _optimizer_snapshot(
    problem: CiOptimizerProblem,
    rolling,
    scenario: _Scenario,
    profile: dict[str, Any],
) -> tuple[dict[str, object], dict[str, object]]:
    interval_audit_rows = [
        [
            row.timestamp.isoformat(),
            row.grid_import_kw,
            row.pv_export_kw,
            row.pv_to_ac_kw,
            row.grid_charge_kw,
            row.pv_charge_kw,
            row.discharge_kw,
            row.soc_start_kwh,
            row.soc_end_kwh,
            row.shared_ac_port_kw,
            row.site_reactive_import_kvar,
            row.inverter_reactive_support_kvar,
            row.post_grid_reactive_kvar,
            row.exact_grid_import_kva,
            row.shared_inverter_apparent_power_kva,
        ]
        for row in rolling.intervals
    ]
    duration_by_timestamp = {
        row.timestamp: row.duration_hours for row in problem.intervals
    }
    dispatch_totals = {
        "grid_import_kwh": round(
            sum(
                row.grid_import_kw * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
        "pv_export_kwh": round(
            sum(
                row.pv_export_kw * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
        "grid_charge_kwh": round(
            sum(
                row.grid_charge_kw * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
        "pv_charge_kwh": round(
            sum(
                row.pv_charge_kw * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
        "discharge_kwh": round(
            sum(
                row.discharge_kw * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
        "reactive_support_kvarh": round(
            sum(
                row.inverter_reactive_support_kvar
                * duration_by_timestamp[row.timestamp]
                for row in rolling.intervals
            ),
            6,
        ),
    }
    input_projection = {
        "interval_count": len(problem.intervals),
        "period_ids": [period.period_id for period in problem.billing_periods],
        "start_timestamp": problem.intervals[0].timestamp.isoformat(),
        "end_timestamp": problem.intervals[-1].timestamp.isoformat(),
        "scenario_sha256": _canonical_sha256(asdict(scenario)),
        "tariff_profile_sha256": _canonical_sha256(profile),
        "interval_inputs_sha256": _canonical_sha256(
            [
                [
                    row.timestamp.isoformat(),
                    row.duration_hours,
                    row.load_kw,
                    row.pv_kw,
                    row.reactive_kvar,
                    row.import_rate_aud_per_kwh,
                    row.export_credit_aud_per_kwh,
                ]
                for row in problem.intervals
            ]
        ),
    }
    snapshot_without_hash = {
        "contract_version": CI_OPTIMIZER_RUN_SNAPSHOT_CONTRACT_VERSION,
        "calculation_revision": (
            CI_OPTIMIZER_RUN_SNAPSHOT_CALCULATION_REVISION
        ),
        "algorithm_id": rolling.algorithm_id,
        "solver_version": rolling.solver_version,
        "status": rolling.status.value,
        "planner_status": rolling.planner_status.value,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "input_projection": input_projection,
        "physical_assumptions": {
            "battery": asdict(problem.battery),
            "shared_ac_headroom_kw": problem.shared_ac_headroom_kw,
            "reactive_support": {
                "contract_version": CI_REACTIVE_SUPPORT_CONTRACT_VERSION,
                **asdict(problem.reactive_support),
            },
            "allow_grid_charging": problem.config.allow_grid_charging,
            "rolling_horizon_hours": 48,
            "rolling_commit_hours": 24,
        },
        "result_projection": {
            "idle_baseline_bill_aud": rolling.idle_baseline_bill_aud,
            "exact_replay_bill_aud": rolling.exact_replay_bill_aud,
            "optimization_exactness_gap_aud": (
                rolling.optimization_exactness_gap_aud
            ),
            "bill_reconciliation_difference_aud": (
                rolling.bill_reconciliation_difference_aud
            ),
            "demand_charges": [asdict(row) for row in rolling.demand_charges],
            "planned_demand_limits_kva": _planned_demand_limits_kva(
                problem,
                rolling,
                profile,
            ),
            "billing_periods": [asdict(row) for row in rolling.billing_periods],
            "dispatch_totals": dispatch_totals,
            "minimum_soc_kwh": min(row.soc_end_kwh for row in rolling.intervals),
            "maximum_soc_kwh": max(row.soc_end_kwh for row in rolling.intervals),
            "minimum_shared_ac_port_kw": min(
                row.shared_ac_port_kw for row in rolling.intervals
            ),
            "maximum_shared_ac_port_kw": max(
                row.shared_ac_port_kw for row in rolling.intervals
            ),
            "maximum_reactive_support_kvar": max(
                row.inverter_reactive_support_kvar for row in rolling.intervals
            ),
            "maximum_post_grid_reactive_kvar": max(
                row.post_grid_reactive_kvar for row in rolling.intervals
            ),
            "maximum_exact_grid_import_kva": max(
                row.exact_grid_import_kva for row in rolling.intervals
            ),
            "maximum_shared_inverter_apparent_power_kva": max(
                row.shared_inverter_apparent_power_kva
                for row in rolling.intervals
            ),
            "interval_dispatch_sha256": _canonical_sha256(interval_audit_rows),
            "interval_count": len(rolling.intervals),
            "window_count": len(rolling.windows),
        },
        "corrections": list(rolling.corrections),
        "disclosures": list(rolling.disclosures),
    }
    snapshot_sha256 = _canonical_sha256(snapshot_without_hash)
    snapshot = {**snapshot_without_hash, "snapshot_sha256": snapshot_sha256}
    audit = {
        "contract_version": CI_OPTIMIZER_AUDIT_PROJECTION_CONTRACT_VERSION,
        "snapshot_sha256": snapshot_sha256,
        "algorithm_id": rolling.algorithm_id,
        "status": rolling.status.value,
        "planner_status": rolling.planner_status.value,
        "solver_version": rolling.solver_version,
        "interval_count": len(rolling.intervals),
        "window_count": len(rolling.windows),
        "dispatch_totals": dispatch_totals,
        "reactive_support": {
            "contract_version": CI_REACTIVE_SUPPORT_CONTRACT_VERSION,
            **asdict(problem.reactive_support),
        },
        "maximum_reactive_support_kvar": max(
            row.inverter_reactive_support_kvar for row in rolling.intervals
        ),
        "maximum_post_grid_reactive_kvar": max(
            row.post_grid_reactive_kvar for row in rolling.intervals
        ),
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }
    return snapshot, audit


def _planned_demand_limits_kva(
    problem: CiOptimizerProblem,
    rolling,
    profile: dict[str, Any],
) -> list[dict[str, object]]:
    """Project annual-planner ceilings without substituting replay peaks."""

    planner_limits = dict(rolling.annual_planner_demand_limits)
    rates = profile["rates"]
    annual_model = profile["annual_financial_model"]
    annual_rate = float(rates["rolling_demand_aud_per_kva_month"]) * 12
    incentive_rate = float(
        annual_model["incentive_demand_aud_per_kva_month"]
    )
    incentive_months = set(annual_model["incentive_demand_months"])
    expected_components = [
        ("annual_rolling_kva", None, annual_rate),
        *[
            (
                f"incentive_kva:{period.period_id}",
                period.period_id,
                incentive_rate,
            )
            for period in problem.billing_periods
            if int(period.period_id.split("-")[1]) in incentive_months
        ],
    ]
    return [
        {
            "component_id": component_id,
            "billing_period_id": billing_period_id,
            "rate_aud_per_kva": rate,
            "planner_limit_kva": (
                planner_limits.get(component_id) if rate > 0.0 else None
            ),
        }
        for component_id, billing_period_id, rate in expected_components
    ]


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
    ).hexdigest()


def _annual_tariff_value(
    rows: list[dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    *,
    baseline_cache: dict[str, object] | None = None,
) -> dict[str, object]:
    model = profile.get("annual_financial_model")
    if not isinstance(model, dict) or model.get("method") != "representative_year_repeat_v1":
        raise CiScenarioAnalysisError("annual_value_unavailable")
    raw_months = model.get("incentive_demand_months")
    if (
        not isinstance(raw_months, list)
        or not raw_months
        or any(
            isinstance(month, bool)
            or not isinstance(month, int)
            or not 1 <= month <= 12
            for month in raw_months
        )
        or len(set(raw_months)) != len(raw_months)
    ):
        raise CiScenarioAnalysisError("annual_value_unavailable")
    try:
        incentive_rate = float(model["incentive_demand_aud_per_kva_month"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CiScenarioAnalysisError("annual_value_unavailable") from exc
    if not math.isfinite(incentive_rate) or incentive_rate < 0:
        raise CiScenarioAnalysisError("annual_value_unavailable")

    scenario_quantities = _annual_tariff_quantities(
        rows,
        tariff_membership,
        profile,
        demand_key="post_kva",
        import_kw_key="post_kw",
        export_kw_key="post_export_kw",
        incentive_months=set(raw_months),
    )
    analysis_period = _analysis_period(profile)
    rolling_start = date.fromisoformat(analysis_period["start_date"])
    rolling_end = date.fromisoformat(analysis_period["end_date"])
    days = (rolling_end - rolling_start).days + 1
    overrides = {"incentive_demand_aud_per_kva_month": incentive_rate}
    cache_key = "annual_tariff_baseline_v1"
    cached_baseline = (
        baseline_cache.get(cache_key) if baseline_cache is not None else None
    )
    if isinstance(cached_baseline, dict):
        baseline = cached_baseline
    else:
        baseline_quantities = _annual_tariff_quantities(
            rows,
            tariff_membership,
            profile,
            demand_key="baseline_kva",
            import_kw_key="baseline_kw",
            export_kw_key="baseline_export_kw",
            incentive_months=set(raw_months),
        )
        baseline = calculate_ci_tariff_charges(
            baseline_quantities,
            profile,
            days=days,
            rate_overrides=overrides,
            include_bill_adjustment=False,
        )
        if baseline_cache is not None:
            baseline_cache[cache_key] = baseline
    scenario = calculate_ci_tariff_charges(
        scenario_quantities,
        profile,
        days=days,
        rate_overrides=overrides,
        include_bill_adjustment=False,
    )
    baseline_categories = {
        key: round(float(value), 2)
        for key, value in baseline["categories"].items()
    }
    scenario_categories = {
        key: round(float(value), 2)
        for key, value in scenario["categories"].items()
    }
    category_savings = {
        key: round(
            baseline_categories[key] - scenario_categories[key],
            2,
        )
        for key in baseline_categories
    }
    return {
        "calculation_method": "representative_year_repeat_v1",
        "period_start": rolling_start.isoformat(),
        "period_end": rolling_end.isoformat(),
        "rate_basis": "active_bill_rates_with_evidence_bound_seasonal_incentive",
        "baseline_cost_ex_gst_aud": baseline["subtotal_ex_gst_aud"],
        "scenario_cost_ex_gst_aud": scenario["subtotal_ex_gst_aud"],
        "first_year_value_ex_gst_aud": round(
            float(baseline["subtotal_ex_gst_aud"])
            - float(scenario["subtotal_ex_gst_aud"]),
            2,
        ),
        "baseline_cost_inc_gst_aud": baseline["total_inc_gst_aud"],
        "scenario_cost_inc_gst_aud": scenario["total_inc_gst_aud"],
        "first_year_value_inc_gst_aud": round(
            float(baseline["total_inc_gst_aud"])
            - float(scenario["total_inc_gst_aud"]),
            2,
        ),
        "baseline_categories_ex_gst_aud": baseline_categories,
        "scenario_categories_ex_gst_aud": scenario_categories,
        "category_savings_ex_gst_aud": category_savings,
        "customer_facing_permission": False,
    }


def _annual_tariff_quantities(
    rows: list[dict[str, object]],
    tariff_membership: _TariffRowMembership,
    profile: dict[str, Any],
    *,
    demand_key: str,
    import_kw_key: str,
    export_kw_key: str,
    incentive_months: set[int],
) -> dict[str, float]:
    _validate_tariff_row_membership(tariff_membership, len(rows))
    rolling_start = date.fromisoformat(
        _analysis_period(profile)["start_date"]
    )
    annual_rows = [
        row
        for row, included in zip(
            rows,
            tariff_membership.annual_period,
            strict=True,
        )
        if included
    ]
    if not annual_rows:
        raise CiScenarioAnalysisError("annual_value_unavailable")
    import_kwh = sum(float(row[import_kw_key]) * 0.25 for row in annual_rows)
    export_kwh = sum(
        float(row[export_kw_key]) * 0.25 for row in annual_rows
    )
    retail_peak_kwh = sum(
        float(row[import_kw_key]) * 0.25
        for row, in_annual_period, is_peak in zip(
            rows,
            tariff_membership.annual_period,
            tariff_membership.retail_energy_peak,
            strict=True,
        )
        if in_annual_period and is_peak
    )
    network_peak_kwh = sum(
        float(row[import_kw_key]) * 0.25
        for row, in_annual_period, is_peak in zip(
            rows,
            tariff_membership.annual_period,
            tariff_membership.network_energy_peak,
            strict=True,
        )
        if in_annual_period and is_peak
    )
    rolling_rows = [
        row
        for row, in_annual_period, in_demand_window in zip(
            rows,
            tariff_membership.annual_period,
            tariff_membership.annual_rolling_demand,
            strict=True,
        )
        if in_annual_period and in_demand_window
    ]
    incentive_rows = [
        row
        for row, in_annual_period, local_month, in_demand_window in zip(
            rows,
            tariff_membership.annual_period,
            tariff_membership.local_months,
            tariff_membership.incentive_demand,
            strict=True,
        )
        if in_annual_period
        and local_month in incentive_months
        and in_demand_window
    ]
    if not rolling_rows or not incentive_rows:
        raise CiScenarioAnalysisError("annual_value_unavailable")
    chargeable_rolling = max(
        max(float(row[demand_key]) for row in rolling_rows),
        float(profile["minimum_chargeable_rolling_kva"]),
    )
    monthly_incentive: dict[str, float] = {}
    for row in incentive_rows:
        key = _annual_period_id(row["meter_date"], rolling_start)
        monthly_incentive[key] = max(
            monthly_incentive.get(key, 0.0), float(row[demand_key])
        )
    return {
        "import_kwh": import_kwh,
        "export_kwh": export_kwh,
        "retail_peak_kwh": retail_peak_kwh,
        "retail_off_peak_kwh": import_kwh - retail_peak_kwh,
        "network_peak_kwh": network_peak_kwh,
        "network_off_peak_kwh": import_kwh - network_peak_kwh,
        "rolling_demand_kva": chargeable_rolling * 12,
        "incentive_demand_kva": sum(monthly_incentive.values()),
    }


def _compile_tariff_row_membership(
    periods: tuple[PeakShavingPeriodInput, ...],
    evidence: dict[datetime, dict[str, object]],
    profile: dict[str, Any],
) -> _TariffRowMembership:
    """Classify tariff windows once before scenarios enter the hot path."""

    analysis_period = _analysis_period(profile)
    annual_start = date.fromisoformat(analysis_period["start_date"])
    annual_end = date.fromisoformat(analysis_period["end_date"])
    billing_start = date.fromisoformat(profile["billing_period"]["start_date"])
    billing_end = date.fromisoformat(profile["billing_period"]["end_date"])
    retail_window = _compile_tariff_window(profile["retail_energy_window"])
    network_window = _compile_tariff_window(profile["network_energy_window"])
    rolling_window = _compile_tariff_window(profile["rolling_demand_window"])
    incentive_window = _compile_tariff_window(
        profile["incentive_demand_window"]
    )

    annual_membership = bytearray()
    billing_membership = bytearray()
    retail_membership = bytearray()
    network_membership = bytearray()
    rolling_membership = bytearray()
    incentive_membership = bytearray()
    local_months = bytearray()
    import_rates: list[float] = []
    import_rate_cache: dict[tuple[bool, bool], float] = {}

    for period in periods:
        for interval in period.intervals:
            row = evidence[interval.timestamp]
            meter_day = row["meter_date"]
            local_start = row["local_start"]
            retail_peak = _row_in_compiled_window(row, retail_window)
            network_peak = _row_in_compiled_window(row, network_window)
            rate_key = (retail_peak, network_peak)
            if rate_key not in import_rate_cache:
                import_rate_cache[rate_key] = (
                    _optimizer_import_rate_from_membership(
                        retail_peak=retail_peak,
                        network_peak=network_peak,
                        profile=profile,
                    )
                )
            annual_membership.append(annual_start <= meter_day <= annual_end)
            billing_membership.append(
                billing_start <= meter_day <= billing_end
            )
            retail_membership.append(retail_peak)
            network_membership.append(network_peak)
            rolling_membership.append(
                _row_in_compiled_window(row, rolling_window)
            )
            incentive_membership.append(
                _row_in_compiled_window(row, incentive_window)
            )
            local_months.append(local_start.month)
            import_rates.append(import_rate_cache[rate_key])

    return _TariffRowMembership(
        annual_period=bytes(annual_membership),
        billing_period=bytes(billing_membership),
        retail_energy_peak=bytes(retail_membership),
        network_energy_peak=bytes(network_membership),
        annual_rolling_demand=bytes(rolling_membership),
        incentive_demand=bytes(incentive_membership),
        local_months=bytes(local_months),
        optimizer_import_rates=tuple(import_rates),
    )


def _compile_tariff_window(window: dict[str, Any]) -> _CompiledTariffWindow:
    return _CompiledTariffWindow(
        start=time.fromisoformat(window["start"]),
        end=time.fromisoformat(window["end"]),
        use_meter_aest=window.get("time_basis") == "meter_aest",
        excluded_dates=frozenset(
            date.fromisoformat(value) for value in window["excluded_dates"]
        ),
    )


def _row_in_compiled_window(
    row: dict[str, object],
    window: _CompiledTariffWindow,
) -> bool:
    classified = (
        row["meter_start"]
        if window.use_meter_aest
        else row["local_start"]
    )
    classified_date = classified.date()
    classified_time = classified.timetz().replace(tzinfo=None)
    return (
        classified_date.weekday() < 5
        and classified_date not in window.excluded_dates
        and window.start <= classified_time < window.end
    )


def _row_in_window(row: dict[str, object], window: dict[str, Any]) -> bool:
    return _row_in_compiled_window(row, _compile_tariff_window(window))


def _validate_tariff_row_membership(
    membership: _TariffRowMembership,
    expected_rows: int,
) -> None:
    lengths = (
        len(membership.annual_period),
        len(membership.billing_period),
        len(membership.retail_energy_peak),
        len(membership.network_energy_peak),
        len(membership.annual_rolling_demand),
        len(membership.incentive_demand),
        len(membership.local_months),
        len(membership.optimizer_import_rates),
    )
    if any(length != expected_rows for length in lengths):
        raise CiScenarioAnalysisError("scenario_execution_failed")


def _analysis_period(profile: dict[str, Any]) -> dict[str, str]:
    return profile.get("analysis_period", profile["rolling_period"])


def _annual_period_id(day: date, anchor: date) -> str:
    month_offset = (day.year - anchor.year) * 12 + day.month - anchor.month
    if day < _shift_month(anchor, month_offset):
        month_offset -= 1
    if not 0 <= month_offset < 12:
        raise CiScenarioAnalysisError("scenario_horizon_invalid")
    return _shift_month(anchor, month_offset).strftime("%Y-%m")


def _shift_month(anchor: date, offset: int) -> date:
    absolute_month = anchor.year * 12 + anchor.month - 1 + offset
    year, zero_based_month = divmod(absolute_month, 12)
    month = zero_based_month + 1
    return date(year, month, min(anchor.day, monthrange(year, month)[1]))


def _validated_scenarios(value: object) -> tuple[_Scenario, ...]:
    if not isinstance(value, list) or not MIN_SOLUTIONS <= len(value) <= MAX_SOLUTIONS:
        raise CiScenarioAnalysisError("scenario_contract_invalid")
    results: list[_Scenario] = []
    try:
        for raw in value:
            if not isinstance(raw, dict):
                raise ValueError
            scenario_id = _text(raw, "scenario_id")
            label = _text(raw, "label")
            scenario = _Scenario(
                scenario_id=scenario_id,
                label=label,
                battery_system_id=_text(raw, "battery_system_id"),
                battery_technology_id=_supported_choice(
                    raw,
                    "battery_technology_id",
                    {"generic_li_ion_ac"},
                ),
                control_profile_id=_supported_choice(
                    raw,
                    "control_profile_id",
                    {"demand_peak_shaving"},
                ),
                pv_system_id=_text(raw, "pv_system_id"),
                pv_profile_id=_supported_choice(
                    raw,
                    "pv_profile_id",
                    {"generic_normalized_solar_shape_v1"},
                ),
                pv_capacity_kwp_dc=_non_negative(raw, "pv_capacity_kwp_dc"),
                pv_inverter_capacity_kw_ac=_non_negative(
                    raw,
                    "pv_inverter_capacity_kw_ac",
                ),
                shared_ac_headroom_kw=_positive(raw, "shared_ac_headroom_kw"),
                reactive_support_enabled=raw["reactive_support_enabled"],
                reactive_support_max_kvar=_non_negative(
                    raw, "reactive_support_max_kvar"
                ),
                shared_inverter_apparent_power_limit_kva=(
                    None
                    if raw["shared_inverter_apparent_power_limit_kva"] is None
                    else _positive(
                        raw, "shared_inverter_apparent_power_limit_kva"
                    )
                ),
                reactive_capability_curve=_supported_choice(
                    raw, "reactive_capability_curve", {"circular_pq"}
                ),
                reactive_capability_provenance=_supported_choice(
                    raw,
                    "reactive_capability_provenance",
                    {"analyst_assumption"},
                ),
                reactive_overcompensation_permitted=raw[
                    "reactive_overcompensation_permitted"
                ],
                pv_annual_specific_yield_kwh_per_kw=_positive(
                    raw,
                    "pv_annual_specific_yield_kwh_per_kw",
                ),
                pv_derating_factor=_fraction(raw, "pv_derating_factor"),
                nominal_capacity_kwh=_non_negative(raw, "nominal_capacity_kwh"),
                max_charge_kw=_non_negative(raw, "max_charge_kw"),
                max_discharge_kw=_non_negative(raw, "max_discharge_kw"),
                charge_efficiency=_fraction(raw, "charge_efficiency"),
                discharge_efficiency=_fraction(raw, "discharge_efficiency"),
                min_soc_fraction=_bounded(raw, "min_soc_fraction"),
                max_soc_fraction=_bounded(raw, "max_soc_fraction"),
                initial_soc_fraction=_bounded(raw, "initial_soc_fraction"),
                allow_grid_charging=raw["allow_grid_charging"],
                grid_emissions_factor_kg_co2e_per_kwh=_bounded_number(
                    {
                        **raw,
                        "grid_emissions_factor_kg_co2e_per_kwh": raw.get(
                            "grid_emissions_factor_kg_co2e_per_kwh", 0.79
                        ),
                    },
                    "grid_emissions_factor_kg_co2e_per_kwh",
                    maximum=5,
                ),
            )
            if not isinstance(scenario.allow_grid_charging, bool) or not isinstance(
                scenario.reactive_support_enabled, bool
            ):
                raise ValueError
            CiReactiveSupportSpec(
                enabled=scenario.reactive_support_enabled,
                max_reactive_support_kvar=scenario.reactive_support_max_kvar,
                inverter_apparent_power_limit_kva=(
                    scenario.shared_inverter_apparent_power_limit_kva
                ),
                capability_curve=scenario.reactive_capability_curve,
                provenance=scenario.reactive_capability_provenance,
                overcompensation_permitted=(
                    scenario.reactive_overcompensation_permitted
                ),
            )
            if (scenario.pv_capacity_kwp_dc == 0) != (
                scenario.pv_inverter_capacity_kw_ac == 0
            ):
                raise ValueError
            battery_zero = scenario.nominal_capacity_kwh == 0
            if any(
                (value == 0) != battery_zero
                for value in (scenario.max_charge_kw, scenario.max_discharge_kw)
            ):
                raise ValueError
            if not (
                0 <= scenario.min_soc_fraction
                < scenario.max_soc_fraction
                <= 1
                and scenario.min_soc_fraction
                <= scenario.initial_soc_fraction
                <= scenario.max_soc_fraction
            ):
                raise ValueError
            if not battery_zero and (
                scenario.initial_soc_fraction != scenario.max_soc_fraction
                or scenario.max_charge_kw != scenario.max_discharge_kw
            ):
                raise ValueError
            results.append(scenario)
        if len({item.scenario_id for item in results}) != len(results):
            raise ValueError
        if len({item.battery_system_id for item in results}) > MAX_BATTERY_SYSTEMS:
            raise ValueError
        if len({item.pv_system_id for item in results}) > MAX_PV_SYSTEMS:
            raise ValueError
        battery_signatures: dict[str, tuple[object, ...]] = {}
        pv_signatures: dict[str, tuple[object, ...]] = {}
        pairs: set[tuple[str, str]] = set()
        for item in results:
            battery_signature = (
                item.battery_technology_id,
                item.control_profile_id,
                item.nominal_capacity_kwh,
                item.max_charge_kw,
                item.max_discharge_kw,
                item.charge_efficiency,
                item.discharge_efficiency,
                item.min_soc_fraction,
                item.max_soc_fraction,
                item.initial_soc_fraction,
                item.allow_grid_charging,
            )
            pv_signature = (
                item.pv_profile_id,
                item.pv_capacity_kwp_dc,
                item.pv_inverter_capacity_kw_ac,
                item.shared_ac_headroom_kw,
                item.reactive_support_enabled,
                item.reactive_support_max_kvar,
                item.shared_inverter_apparent_power_limit_kva,
                item.reactive_capability_curve,
                item.reactive_capability_provenance,
                item.reactive_overcompensation_permitted,
                item.pv_annual_specific_yield_kwh_per_kw,
                item.pv_derating_factor,
            )
            if item.battery_system_id in battery_signatures and battery_signatures[item.battery_system_id] != battery_signature:
                raise ValueError
            if item.pv_system_id in pv_signatures and pv_signatures[item.pv_system_id] != pv_signature:
                raise ValueError
            pair = (item.pv_system_id, item.battery_system_id)
            if pair in pairs:
                raise ValueError
            battery_signatures[item.battery_system_id] = battery_signature
            pv_signatures[item.pv_system_id] = pv_signature
            pairs.add(pair)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise CiScenarioAnalysisError("scenario_contract_invalid") from exc
    return tuple(results)


def _text(raw: dict[str, Any], key: str) -> str:
    value = raw[key]
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80:
        raise ValueError
    return value.strip()


def _number(raw: dict[str, Any], key: str) -> float:
    value = raw[key]
    if isinstance(value, bool):
        raise ValueError
    result = float(value)
    if not math.isfinite(result):
        raise ValueError
    return result


def _supported_choice(
    raw: dict[str, Any],
    key: str,
    supported: set[str],
) -> str:
    value = raw[key]
    if not isinstance(value, str) or value not in supported:
        raise ValueError
    return value


def _positive(raw: dict[str, Any], key: str) -> float:
    value = _number(raw, key)
    if value <= 0:
        raise ValueError
    return value


def _non_negative(raw: dict[str, Any], key: str) -> float:
    value = _number(raw, key)
    if value < 0:
        raise ValueError
    return value


def _fraction(raw: dict[str, Any], key: str) -> float:
    value = _number(raw, key)
    if not 0 < value <= 1:
        raise ValueError
    return value


def _bounded(raw: dict[str, Any], key: str) -> float:
    value = _number(raw, key)
    if not 0 <= value <= 1:
        raise ValueError
    return value


def _bounded_number(
    raw: dict[str, Any], key: str, *, maximum: float
) -> float:
    value = _number(raw, key)
    if not 0 <= value <= maximum:
        raise ValueError
    return value


def _build_periods(
    streams: dict[str, dict[date, list[float]]],
    profile: dict[str, Any],
) -> tuple[tuple[PeakShavingPeriodInput, ...], dict[datetime, dict[str, object]]]:
    local_timezone = ZoneInfo(profile["timezone_name"])
    fixed_aest = timezone(timedelta(hours=10))
    window = profile["rolling_demand_window"]
    start = time.fromisoformat(window["start"])
    end = time.fromisoformat(window["end"])
    excluded = {date.fromisoformat(value) for value in window["excluded_dates"]}
    analysis_period = _analysis_period(profile)
    rolling_start = date.fromisoformat(analysis_period["start_date"])
    rolling_end = date.fromisoformat(analysis_period["end_date"])
    if rolling_end != _shift_month(rolling_start, 12) - timedelta(days=1):
        raise CiScenarioAnalysisError("scenario_horizon_invalid")
    grouped: dict[str, list[tuple[CleanedInterval, bool]]] = {}
    evidence: dict[datetime, dict[str, object]] = {}
    for meter_day in sorted(streams["E1"]):
        if not rolling_start <= meter_day <= rolling_end:
            continue
        for index in range(0, 288, 3):
            timestamp = datetime.combine(meter_day, time.min, fixed_aest) + timedelta(
                minutes=index * 5
            )
            local_start = timestamp.astimezone(local_timezone)
            in_window = (
                local_start.date().weekday() < 5
                and local_start.date() not in excluded
                and start <= local_start.timetz().replace(tzinfo=None) < end
            )
            interval = CleanedInterval(
                timestamp=timestamp,
                interval_minutes=15,
                load_kwh=sum(streams["E1"][meter_day][index : index + 3]),
                source_status="measured",
                source_stream_id="evidence_bound_active_import",
                source_date=meter_day,
            )
            period_id = _annual_period_id(meter_day, rolling_start)
            grouped.setdefault(period_id, []).append((interval, in_window))
            evidence[timestamp] = {
                "meter_date": meter_day,
                "meter_start": timestamp,
                "local_start": local_start,
                "kvar": sum(streams["Q1"][meter_day][index : index + 3]) * 4,
                "baseline_kw": interval.load_kw_avg,
                "baseline_export_kw": sum(
                    streams["B1"][meter_day][index : index + 3]
                )
                * 4,
                "rolling_window": in_window,
            }
    if len(grouped) != 12:
        raise CiScenarioAnalysisError("scenario_horizon_invalid")
    periods = tuple(
        PeakShavingPeriodInput(
            period_id=period_id,
            intervals=tuple(item[0] for item in rows),
            demand_window=tuple(item[1] for item in rows),
        )
        for period_id, rows in sorted(grouped.items())
    )
    return periods, evidence
