from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from solar_battery.ci_analysis_singleflight import run_ci_analysis_once
from solar_battery.ci_projects import CiProjectError


def test_identical_inflight_requests_compute_once_and_share_committed_result(monkeypatch):
    import solar_battery.ci_analysis_singleflight as singleflight

    started, joined, release = Event(), Event(), Event()
    calls = []
    result = {"committed": True}
    original_result = singleflight.Future.result

    def observed_result(self, timeout=None):
        joined.set()
        return original_result(self, timeout=timeout)

    monkeypatch.setattr(singleflight.Future, "result", observed_result)

    def compute():
        calls.append("compute")
        started.set()
        assert release.wait(5)
        return result

    def duplicate():
        return run_ci_analysis_once(("same",), lambda: pytest.fail("duplicate solve"))

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run_ci_analysis_once, ("same",), compute)
        assert started.wait(5)
        second = pool.submit(duplicate)
        assert joined.wait(5)
        # A follower's short wait must expire without starting another solve.
        with pytest.raises(CiProjectError, match="still running"):
            run_ci_analysis_once(("same",), compute, wait_seconds=0.01)
        release.set()
        assert first.result(timeout=5) is result
        assert second.result(timeout=5) is result
    assert calls == ["compute"]
    # Completion is not an unvalidated result cache.
    assert run_ci_analysis_once(("same",), lambda: "new") == "new"


def test_different_provenance_keys_do_not_join():
    started, release = Event(), Event()

    def compute():
        started.set()
        assert release.wait(5)
        return "first"

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(run_ci_analysis_once, ("tenant-a", "profile-a"), compute)
        assert started.wait(5)
        assert run_ci_analysis_once(("tenant-b", "profile-a"), lambda: "b") == "b"
        assert run_ci_analysis_once(("tenant-a", "profile-b"), lambda: "c") == "c"
        release.set()
        assert first.result(timeout=5) == "first"


def test_failure_is_shared_then_removed(monkeypatch):
    import solar_battery.ci_analysis_singleflight as singleflight

    started, waiting, release = Event(), Event(), Event()
    original_result = singleflight.Future.result

    def observed_result(self, timeout=None):
        waiting.set()
        return original_result(self, timeout=timeout)

    monkeypatch.setattr(singleflight.Future, "result", observed_result)

    def compute():
        started.set()
        assert release.wait(5)
        raise TimeoutError("solver failed")

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run_ci_analysis_once, ("failure",), compute)
        assert started.wait(5)
        second = pool.submit(run_ci_analysis_once, ("failure",), lambda: pytest.fail("duplicate"))
        assert waiting.wait(5)
        release.set()
        for future in (first, second):
            with pytest.raises(TimeoutError, match="solver failed"):
                future.result(timeout=5)
    assert run_ci_analysis_once(("failure",), lambda: "recovered") == "recovered"
