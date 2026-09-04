import { describe, expect, it, vi } from "vitest";

import {
  assertCiProjectTariffProfile,
  assertCiProjectTariffProfileState,
  fetchCiProjectTariffProfile,
  saveCiProjectTariffProfile,
  type CiProjectTariffProfile,
  type CiProjectTariffProfileState,
} from "./ci-tariff-profile";

describe("project tariff profile API", () => {
  it("loads a fail-closed suggested profile", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(state("not_available")), { status: 200 }));

    await expect(fetchCiProjectTariffProfile("project / one", fetcher)).resolves.toMatchObject({ status: "not_available" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/commercial-industrial/projects/project%20%2F%20one/tariff-profile");
  });

  it("accepts an unavailable state without bill evidence or a suggestion", () => {
    expect(assertCiProjectTariffProfileState({ ...state("not_available"), suggested_profile: null })).toMatchObject({ status: "not_available", suggested_profile: null });
  });

  it("accepts a stale saved profile but rejects an overnight window", () => {
    expect(assertCiProjectTariffProfileState(state("stale"))).toMatchObject({ status: "stale", profile });
    const overnight = structuredClone(profile);
    overnight.windows.incentive_demand = { start: "22:00", end: "07:00" };
    expect(() => assertCiProjectTariffProfile(overnight)).toThrow("Imported JSON");
  });

  it("saves a draft or approves the same authored profile", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(state("approved")), { status: 200 }));

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: true }, fetcher)).resolves.toMatchObject({ status: "approved" });
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ profile, approve_for_calculation: true });
  });

  it("retries one recoverable container 503 with the same PUT body", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          error_code: "container_provisioning",
          message: "The analysis service is starting. Try again shortly.",
          request_id: "req-starting",
        }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
      }
      return new Response(JSON.stringify(state("approved")), { status: 200 });
    });

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: true }, fetcher)).resolves.toMatchObject({ status: "approved" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  });

  it.each([
    ["backend_unconfigured", "The analysis service is not configured."],
    ["access_unconfigured", "Cloudflare Access is not configured."],
  ])("does not retry configuration failure %s", async (errorCode, message) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error_code: errorCode,
      message,
      request_id: "req-config",
    }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "0" } }));

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: true }, fetcher))
      .rejects.toThrow(`${message} Request ID: req-config.`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries one interrupted network request", async () => {
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(state("draft")), { status: 200 });
    });

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: false }, fetcher)).resolves.toMatchObject({ status: "draft" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports the final container failure message and request ID after one retry", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error_code: "container_unavailable",
      message: "The analysis connection was interrupted before completion could be confirmed. Wait a moment, then try again.",
      request_id: "req-final",
    }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "0" } }));

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: true }, fetcher))
      .rejects.toThrow("The analysis connection was interrupted before completion could be confirmed. Wait a moment, then try again. Request ID: req-final.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed state and imported JSON", () => {
    const malformed = structuredClone(profile);
    malformed.windows.retail_energy.end = malformed.windows.retail_energy.start;

    expect(() => assertCiProjectTariffProfileState({ ...state("draft"), profile: malformed })).toThrow("unsafe contract");
    expect(() => assertCiProjectTariffProfile(malformed)).toThrow("Imported JSON");
    expect(() => assertCiProjectTariffProfile({ ...profile, unsupported_rate_basis: "guess" })).toThrow("Imported JSON");
    expect(() => assertCiProjectTariffProfile({ ...profile, factors: { mlf: 0.001, dlf: 1 } })).toThrow("Imported JSON");
  });

  it("accepts an older project profile that omitted the source-bill adjustment", () => {
    const legacyProfile = structuredClone(profile);
    delete legacyProfile.additional_bill_adjustment_aud;

    expect(assertCiProjectTariffProfile(legacyProfile)).toEqual(legacyProfile);
  });

  it("surfaces a backend approval blocker", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ detail: { code: "tariff_profile_approval_blocked", message: "Bill review is required before approval." } }), { status: 422 }));

    await expect(saveCiProjectTariffProfile("project-1", { profile, approveForCalculation: true }, fetcher)).rejects.toThrow("Bill review is required before approval.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function state(status: CiProjectTariffProfileState["status"]): CiProjectTariffProfileState {
  const saved = status !== "not_available";
  return {
    contract_version: "ci_project_tariff_profile_state_v1",
    status,
    updated_at: saved ? "2026-09-02T00:00:00Z" : null,
    approved_at: status === "approved" ? "2026-09-02T00:00:00Z" : null,
    profile_sha256: saved ? "a".repeat(64) : null,
    profile: saved ? profile : null,
    suggested_profile: profile,
    evidence_basis: null,
    blockers: status === "approved" ? [] : [{ code: "tariff_profile_approval_required", message: "Review and approve the tariff profile." }],
  };
}

const profile: CiProjectTariffProfile = {
  contract_version: "ci_project_tariff_profile_v1",
  display_label: "LLVT2 reviewed tariff",
  network_tariff_code: "LLVT2",
  additional_bill_adjustment_aud: 0,
  rates: {
    retail_peak_c_per_kwh: 10,
    retail_off_peak_c_per_kwh: 8,
    incentive_demand_aud_per_kva_month: 4,
    rolling_demand_aud_per_kva_month: 3,
    network_peak_c_per_kwh: 5,
    network_off_peak_c_per_kwh: 2,
    aemo_ancillary_c_per_kwh: 0.1,
    aemo_participant_c_per_kwh: 0.2,
    aemo_frc_c_per_day: 1,
    environmental_c_per_kwh: 0.3,
    environmental_certificate_fraction: 1,
    metering_aud_per_day: 2,
    value_added_c_per_day: 3,
  },
  factors: { mlf: 1, dlf: 1 },
  windows: {
    retail_energy: { start: "07:00", end: "23:00" },
    network_energy: { start: "07:00", end: "19:00" },
    rolling_demand: { start: "07:00", end: "19:00" },
    incentive_demand: { start: "16:00", end: "19:00" },
  },
  minimum_chargeable_rolling_kva: 0,
};
