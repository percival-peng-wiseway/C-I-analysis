import { describe, expect, it, vi } from "vitest";

import {
  assertCiProjectRebateProfile,
  assertCiProjectRebateProfileState,
  ciProjectRebateProfileQueryKey,
  fetchCiProjectRebateProfile,
  saveCiProjectRebateProfile,
  type CiProjectRebateProfile,
  type CiProjectRebateProfileState,
} from "./ci-rebate-profile";

describe("project rebate profile API", () => {
  it("loads a null-safe suggestion without caching it", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(state("not_configured")), { status: 200 }));

    await expect(fetchCiProjectRebateProfile("project / one", fetcher)).resolves.toMatchObject({
      status: "not_configured",
      profile: null,
      suggested_profile: {
        site_state_code: "",
        site_postcode: "",
        programs: {
          solar_stc: { postcode_zone_rating: null },
          battery_stc: { certified_usable_capacity_fraction: null },
          vic_deemed_veec: {
            victoria_region: null,
            inverter_apparent_power_kva_per_kw_ac: null,
            inverter_apparent_power_source_label: "",
          },
        },
      },
      site_evidence: { detected_site_address: null, state_code: null, postcode: null },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/commercial-industrial/projects/project%20%2F%20one/rebate-profile");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", headers: { Accept: "application/json" } });
    expect(ciProjectRebateProfileQueryKey("project / one")).toEqual(["ci-project-rebate-profile", "project / one"]);
  });

  it.each([false, true])("saves the same authored profile with approval set to %s", async (approveForCalculation) => {
    const responseState = state(approveForCalculation ? "approved" : "draft");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(responseState), { status: 200 }));

    await expect(saveCiProjectRebateProfile(
      "project-1",
      { profile, approveForCalculation },
      fetcher,
    )).resolves.toMatchObject({ status: responseState.status });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/commercial-industrial/projects/project-1/rebate-profile");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      profile,
      approve_for_calculation: approveForCalculation,
    });
  });

  it("strictly rejects unknown fields, invalid dates, numbers, enums and hashes", () => {
    expect(() => assertCiProjectRebateProfile({ ...profile, unsupported_program: true })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      target_certificate_date: "2026-02-30",
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      programs: {
        ...profile.programs,
        solar_stc: { ...profile.programs.solar_stc, postcode_zone_rating: 1.5 },
      },
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      programs: {
        ...profile.programs,
        battery_stc: { ...profile.programs.battery_stc, certified_usable_capacity_fraction: 0 },
      },
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      programs: {
        ...profile.programs,
        vic_deemed_veec: { ...profile.programs.vic_deemed_veec, victoria_region: "outer_metro" },
      },
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      programs: {
        ...profile.programs,
        vic_deemed_veec: { ...profile.programs.vic_deemed_veec, inverter_apparent_power_kva_per_kw_ac: 0.999 },
      },
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({
      ...profile,
      programs: {
        ...profile.programs,
        vic_deemed_veec: { ...profile.programs.vic_deemed_veec, inverter_apparent_power_kva_per_kw_ac: 10.001 },
      },
    })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfileState({ ...state("draft"), ruleset: { ...ruleset, ruleset_sha256: "unsafe" } })).toThrow("unsafe contract");
    expect(() => assertCiProjectRebateProfileState({ ...state("draft"), unexpected: true })).toThrow("unsafe contract");
    expect(() => assertCiProjectRebateProfile({ ...profile, site_state_code: "Victoria" })).toThrow("Imported JSON");
    expect(() => assertCiProjectRebateProfile({ ...profile, site_postcode: "300" })).toThrow("Imported JSON");
  });

  it("accepts an auditable VEEC inverter kVA ratio and strictly requires both contract fields", () => {
    const valid = structuredClone(profile);
    valid.programs.vic_deemed_veec.inverter_apparent_power_kva_per_kw_ac = 1.25;
    valid.programs.vic_deemed_veec.inverter_apparent_power_source_label = "Approved inverter datasheet";

    expect(assertCiProjectRebateProfile(valid)).toMatchObject({
      programs: {
        vic_deemed_veec: {
          inverter_apparent_power_kva_per_kw_ac: 1.25,
          inverter_apparent_power_source_label: "Approved inverter datasheet",
        },
      },
    });

    const missingRatio = structuredClone(valid);
    delete (missingRatio.programs.vic_deemed_veec as unknown as Record<string, unknown>).inverter_apparent_power_kva_per_kw_ac;
    expect(() => assertCiProjectRebateProfile(missingRatio)).toThrow("Imported JSON");

    const missingSource = structuredClone(valid);
    delete (missingSource.programs.vic_deemed_veec as unknown as Record<string, unknown>).inverter_apparent_power_source_label;
    expect(() => assertCiProjectRebateProfile(missingSource)).toThrow("Imported JSON");
  });

  it("requires saved profile state to be internally consistent", () => {
    expect(assertCiProjectRebateProfileState(state("stale"))).toMatchObject({ status: "stale", profile });
    expect(() => assertCiProjectRebateProfileState({
      ...state("draft"),
      profile: null,
    })).toThrow("unsafe contract");
    expect(() => assertCiProjectRebateProfileState({
      ...state("not_configured"),
      profile,
      profile_sha256: "a".repeat(64),
    })).toThrow("unsafe contract");
  });

  it("surfaces backend approval blockers and falls back safely", async () => {
    const blockedFetcher = vi.fn(async () => new Response(JSON.stringify({
      detail: { code: "rebate_profile_approval_blocked", message: "Confirm rebate evidence before approval." },
    }), { status: 422 }));
    const invalidFetcher = vi.fn(async () => new Response(JSON.stringify({
      detail: [{ loc: ["body", "profile"], msg: "Invalid rebate profile." }],
    }), { status: 422 }));

    await expect(saveCiProjectRebateProfile(
      "project-1",
      { profile, approveForCalculation: true },
      blockedFetcher,
    )).rejects.toThrow("Confirm rebate evidence before approval.");
    await expect(saveCiProjectRebateProfile(
      "project-1",
      { profile, approveForCalculation: false },
      invalidFetcher,
    )).rejects.toThrow("Invalid rebate profile.");
  });
});

function state(status: CiProjectRebateProfileState["status"]): CiProjectRebateProfileState {
  const saved = status !== "not_configured";
  return {
    contract_version: "ci_project_rebate_profile_state_v1",
    status,
    updated_at: saved ? "2026-09-02T00:00:00Z" : null,
    approved_at: status === "approved" ? "2026-09-02T00:00:00Z" : null,
    profile_sha256: saved ? "a".repeat(64) : null,
    profile: saved ? profile : null,
    suggested_profile: profile,
    site_evidence: { detected_site_address: null, state_code: null, postcode: null },
    blockers: status === "approved" ? [] : [{ code: "rebate_profile_approval_required", message: "Review and approve the rebate profile." }],
    ruleset,
  };
}

const commonProgram = {
  enabled: false,
  eligibility_confirmed: false,
  eligibility_source_label: "",
  certificate_price_aud_ex_gst: 39,
  price_source_label: "",
  price_as_of_date: "2026-09-02",
};

const profile: CiProjectRebateProfile = {
  contract_version: "ci_project_rebate_profile_v1",
  target_certificate_date: "2026-09-02",
  site_state_code: "",
  site_postcode: "",
  site_location_confirmed: false,
  site_location_source_label: "",
  stacking_confirmed: false,
  programs: {
    solar_stc: {
      ...commonProgram,
      postcode_zone_rating: null,
      zone_source_label: "",
    },
    battery_stc: {
      ...commonProgram,
      certified_usable_capacity_fraction: null,
      capacity_source_label: "",
    },
    vic_deemed_veec: {
      ...commonProgram,
      certificate_price_aud_ex_gst: 70,
      victoria_region: null,
      inverter_apparent_power_kva_per_kw_ac: null,
      inverter_apparent_power_source_label: "",
    },
  },
};

const ruleset = {
  ruleset_id: "australian-ci-rebates-2026-09-02",
  ruleset_sha256: "b".repeat(64),
  official_sources: [
    {
      source_id: "cer-stc",
      label: "Clean Energy Regulator STC guidance",
      url: "https://cer.gov.au/schemes/renewable-energy-target/small-scale-renewable-energy-scheme",
      status: "authoritative" as const,
    },
    {
      source_id: "battery-stc-proposal",
      label: "Battery STC proposal",
      url: "https://cer.gov.au/",
      status: "proposal_not_enabled" as const,
    },
  ],
};
