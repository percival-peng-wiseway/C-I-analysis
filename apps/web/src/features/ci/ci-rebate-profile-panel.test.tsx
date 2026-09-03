// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiProjectRebateProfile, CiProjectRebateProfileState } from "./api/ci-rebate-profile";
import { CiRebateProfilePanel } from "./ci-rebate-profile-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CiRebateProfilePanel", () => {
  it("shows only the Solar and Battery STC switches and prices", async () => {
    mockApi(state("not_configured"));
    renderPanel();

    await screen.findByRole("heading", { name: "Rebates & certificates" });
    expect(screen.getByLabelText("Include Solar STCs")).toBeTruthy();
    expect(screen.getByLabelText("Solar STCs price")).toHaveProperty("value", "39");
    expect(screen.getByLabelText("Include Battery STCs")).toBeTruthy();
    expect(screen.getByLabelText("Battery STCs price")).toHaveProperty("value", "39");
    expect(screen.queryByText(/VEEC/i)).toBeNull();
    expect(screen.queryByLabelText("Eligibility source")).toBeNull();
    expect(screen.queryByLabelText("Price as-of")).toBeNull();
    expect(screen.queryByLabelText("Site postcode")).toBeNull();
  });

  it("saves both switches and prices through the compact backend contract", async () => {
    const requests = mockApi(state("not_configured"));
    renderPanel();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Rebates & certificates" });

    await user.click(screen.getByLabelText("Include Solar STCs"));
    await user.clear(screen.getByLabelText("Solar STCs price"));
    await user.type(screen.getByLabelText("Solar STCs price"), "41.5");
    await user.click(screen.getByLabelText("Include Battery STCs"));
    await user.clear(screen.getByLabelText("Battery STCs price"));
    await user.type(screen.getByLabelText("Battery STCs price"), "38");
    await user.click(screen.getByRole("button", { name: "Save STC settings" }));

    expect(await screen.findByText(/Gross\/Net CAPEX prices have been refreshed/)).toBeTruthy();
    const saved = requests.find((item) => item.method === "PUT");
    expect(saved?.url.endsWith("/rebate-profile/stc-settings")).toBe(true);
    expect(saved?.body).toEqual({
      solar_stc_enabled: true,
      solar_stc_price_aud_ex_gst: 41.5,
      battery_stc_enabled: true,
      battery_stc_price_aud_ex_gst: 38,
    });
  });

  it("requires positive prices before saving", async () => {
    mockApi(state("not_configured"));
    renderPanel();
    await screen.findByRole("heading", { name: "Rebates & certificates" });

    await userEvent.click(screen.getByLabelText("Include Solar STCs"));
    await userEvent.clear(screen.getByLabelText("Solar STCs price"));
    expect(screen.getByText(/price greater than \$0 for each included/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save STC settings" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not carry an unsaved STC choice into another project", async () => {
    const secondProfile = structuredClone(profile);
    secondProfile.programs.battery_stc.enabled = true;
    secondProfile.programs.battery_stc.certificate_price_aud_ex_gst = 44;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const selected = String(input).includes("project-2") ? secondProfile : profile;
      return new Response(JSON.stringify(state("approved", selected)), { status: 200 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-1" /></QueryClientProvider>);
    await screen.findByRole("heading", { name: "Rebates & certificates" });
    await userEvent.click(screen.getByLabelText("Include Solar STCs"));

    view.rerender(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-2" /></QueryClientProvider>);
    await waitFor(() => expect((screen.getByLabelText("Include Battery STCs") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText("Include Solar STCs") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText("Battery STCs price")).toHaveProperty("value", "44");
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-1" /></QueryClientProvider>);
}

function mockApi(initial: CiProjectRebateProfileState) {
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ method, url: String(input), body });
    if (!body) return new Response(JSON.stringify(initial), { status: 200 });
    const nextProfile = structuredClone(initial.profile ?? initial.suggested_profile);
    nextProfile.programs.solar_stc.enabled = Boolean(body.solar_stc_enabled);
    nextProfile.programs.solar_stc.certificate_price_aud_ex_gst = Number(body.solar_stc_price_aud_ex_gst);
    nextProfile.programs.battery_stc.enabled = Boolean(body.battery_stc_enabled);
    nextProfile.programs.battery_stc.certificate_price_aud_ex_gst = Number(body.battery_stc_price_aud_ex_gst);
    return new Response(JSON.stringify(state("approved", nextProfile)), { status: 200 });
  }));
  return requests;
}

function state(status: CiProjectRebateProfileState["status"], savedProfile: CiProjectRebateProfile = profile): CiProjectRebateProfileState {
  const saved = status !== "not_configured";
  return {
    contract_version: "ci_project_rebate_profile_state_v1",
    status,
    updated_at: saved ? "2026-09-02T00:00:00Z" : null,
    approved_at: status === "approved" ? "2026-09-02T00:00:00Z" : null,
    profile_sha256: saved ? "a".repeat(64) : null,
    profile: saved ? savedProfile : null,
    suggested_profile: savedProfile,
    site_evidence: { detected_site_address: null, state_code: null, postcode: null },
    blockers: [],
    ruleset: {
      ruleset_id: "au_ci_rebates_2026_v1",
      ruleset_sha256: "b".repeat(64),
      official_sources: [{ source_id: "cer-stc", label: "Clean Energy Regulator STCs", url: "https://cer.gov.au/", status: "authoritative" }],
    },
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
    solar_stc: { ...commonProgram, postcode_zone_rating: null, zone_source_label: "" },
    battery_stc: { ...commonProgram, certified_usable_capacity_fraction: null, capacity_source_label: "" },
    vic_deemed_veec: { ...commonProgram, certificate_price_aud_ex_gst: 70, victoria_region: null, inverter_apparent_power_kva_per_kw_ac: null, inverter_apparent_power_source_label: "" },
  },
};
