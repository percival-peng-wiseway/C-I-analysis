import assert from "node:assert/strict";
import test from "node:test";
import { canRetryContainerFailure } from "./container-retry.ts";

test("calculation POST is not repeated after an ambiguous disconnect", () => {
  for (const operation of ["tariff_replay_run", "dispatch_run", "finance_run"]) {
    assert.equal(canRetryContainerFailure("POST", operation, "container_unavailable"), false);
    assert.equal(canRetryContainerFailure("POST", operation, "container_provisioning"), true);
    assert.equal(canRetryContainerFailure("POST", operation, "container_start_timeout"), false);
  }
});

test("reads and transactional PUT retain infrastructure recovery", () => {
  for (const method of ["GET", "HEAD", "PUT"]) {
    assert.equal(canRetryContainerFailure(method, "api_request", "container_unavailable"), true);
    assert.equal(canRetryContainerFailure(method, "api_request", "container_provisioning"), true);
    assert.equal(canRetryContainerFailure(method, "api_request", "backend_unconfigured"), false);
  }
});

test("unapproved operations and business errors are never retried", () => {
  assert.equal(canRetryContainerFailure("POST", "api_request", "container_provisioning"), false);
  assert.equal(canRetryContainerFailure("DELETE", "api_request", "container_unavailable"), false);
  assert.equal(canRetryContainerFailure("POST", "tariff_replay_run", "solver_failed"), false);
});
