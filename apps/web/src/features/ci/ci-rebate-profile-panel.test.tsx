// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiProjectRebateProfile, CiProjectRebateProfileState } from "./api/ci-rebate-profile";
import { CiRebateProfilePanel } from "./ci-rebate-profile-panel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CiRebateProfilePanel", () => {
  it("keeps null evidence fields blank and reveals only the enabled program inputs", async () => {
    mockApi(state("not_configured"));
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Rebates & certificates" })).toBeTruthy();
    expect(screen.getByText("No rebates selected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clean Energy Regulator · STCs" }).getAttribute("href")).toBe("https://cer.gov.au/");
    expect(screen.queryByLabelText("Postcode zone rating")).toBeNull();

    await userEvent.click(screen.getByLabelText("Enable Solar STCs"));
    expect((screen.getByLabelText("Postcode zone rating") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("option", { name: "1.185" })).toBeTruthy();
    expect(screen.getByText(/STC current price and source/)).toBeTruthy();
    expect(screen.getByText(/STC postcode zone evidence/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save & use in Finance/ }).hasAttribute("disabled")).toBe(true);
  });

  it("saves an incomplete selection as draft without calculating money in the browser", async () => {
    const requests = mockApi(state("not_configured"));
    renderPanel();
    await screen.findByRole("heading", { name: "Rebates & certificates" });
    await userEvent.click(screen.getByLabelText("Enable Battery STCs"));
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText(/Rebate draft saved/)).toBeTruthy();
    const saved = requests.find((item) => item.method === "PUT");
    expect(saved).toBeTruthy();
    expect(saved?.body).toMatchObject({
      approve_for_calculation: false,
      profile: {
        programs: {
          battery_stc: { enabled: true, certified_usable_capacity_fraction: null },
        },
      },
    });
    expect(JSON.stringify(saved?.body)).not.toContain("certificate_quantity");
    expect(JSON.stringify(saved?.body)).not.toContain("rebate_aud");
  });

  it("submits a fully evidenced solar profile for backend approval", async () => {
    const initial = state("not_configured");
    initial.site_evidence = { detected_site_address: "10 Collins Street Melbourne VIC 3000", state_code: "VIC", postcode: "3000" };
    const requests = mockApi(initial);
    renderPanel();
    await screen.findByRole("heading", { name: "Rebates & certificates" });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("Enable Solar STCs"));
    await user.type(screen.getByLabelText("Site state"), "VIC");
    await user.type(screen.getByLabelText("Site postcode"), "3000");
    await user.type(screen.getByLabelText("Location source"), "Reviewed electricity bill");
    await user.click(screen.getByText("I have confirmed the project site"));
    await user.click(screen.getByLabelText("Solar STCs eligibility reviewed"));
    await user.type(screen.getByLabelText("Eligibility source"), "Accredited product and installer review");
    await user.type(screen.getByLabelText("Price source"), "Supplier net certificate quote");
    await user.selectOptions(screen.getByLabelText("Postcode zone rating"), "1.185");
    await user.type(screen.getByLabelText("Zone source"), "Approved postcode-zone table");

    const approve = screen.getByRole("button", { name: /Save & use in Finance/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
    await user.click(approve);
    expect(await screen.findByText(/approved for Finance/)).toBeTruthy();
    expect(requests.find((item) => item.method === "PUT")?.body).toMatchObject({ approve_for_calculation: true });
  });

  it("requires a stacking confirmation when multiple programs are selected", async () => {
    mockApi(state("not_configured"));
    renderPanel();
    await screen.findByRole("heading", { name: "Rebates & certificates" });
    await userEvent.click(screen.getByLabelText("Enable Solar STCs"));
    await userEvent.click(screen.getByLabelText("Enable Battery STCs"));
    expect(screen.getByText("Confirm the selected programs can be combined")).toBeTruthy();
    expect(screen.getByText(/program stacking confirmation/)).toBeTruthy();
  });

  it("blocks VEEC approval until the inverter kVA ratio and its evidence source are both entered", async () => {
    const veecProfile = structuredClone(profile);
    Object.assign(veecProfile, {
      site_state_code: "VIC",
      site_postcode: "3000",
      site_location_confirmed: true,
      site_location_source_label: "Reviewed electricity bill",
    });
    Object.assign(veecProfile.programs.vic_deemed_veec, {
      enabled: true,
      eligibility_confirmed: true,
      eligibility_source_label: "VEU Part 47 eligibility review",
      price_source_label: "Net certificate quote",
      victoria_region: "metropolitan",
    });
    const initial = state("draft", veecProfile);
    initial.site_evidence = { detected_site_address: "10 Collins Street Melbourne VIC 3000", state_code: "VIC", postcode: "3000" };
    const requests = mockApi(initial);
    renderPanel();
    await screen.findByRole("heading", { name: "Rebates & certificates" });

    const ratio = screen.getByLabelText("Inverter apparent power (kVA per kW AC)") as HTMLInputElement;
    const source = screen.getByLabelText("Inverter apparent power source") as HTMLInputElement;
    const approve = screen.getByRole("button", { name: /Save & use in Finance/ });
    expect(ratio.value).toBe("");
    expect(ratio.getAttribute("min")).toBe("1");
    expect(ratio.getAttribute("max")).toBe("10");
    expect(source.value).toBe("");
    expect(screen.getByText(/VEEC inverter apparent-power evidence/)).toBeTruthy();
    expect(approve.hasAttribute("disabled")).toBe(true);

    const user = userEvent.setup();
    await user.type(ratio, "1.25");
    expect(approve.hasAttribute("disabled")).toBe(true);
    await user.type(source, "Approved inverter datasheet");
    expect(approve.hasAttribute("disabled")).toBe(false);

    await user.click(approve);
    expect(await screen.findByText(/approved for Finance/)).toBeTruthy();
    expect(requests.find((item) => item.method === "PUT")?.body).toMatchObject({
      approve_for_calculation: true,
      profile: {
        programs: {
          vic_deemed_veec: {
            inverter_apparent_power_kva_per_kw_ac: 1.25,
            inverter_apparent_power_source_label: "Approved inverter datasheet",
          },
        },
      },
    });
  });

  it("does not carry an unsaved rebate draft into another project", async () => {
    const secondProfile = structuredClone(profile);
    secondProfile.site_state_code = "NSW";
    secondProfile.site_postcode = "2000";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const selected = String(input).includes("project-2") ? secondProfile : profile;
      return new Response(JSON.stringify(state("not_configured", selected)), { status: 200 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-1" /></QueryClientProvider>);
    await screen.findByRole("heading", { name: "Rebates & certificates" });
    await userEvent.click(screen.getByLabelText("Enable Solar STCs"));
    expect(screen.getByLabelText("Postcode zone rating")).toBeTruthy();

    view.rerender(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-2" /></QueryClientProvider>);
    await waitFor(() => expect((screen.getByLabelText("Site state") as HTMLInputElement).value).toBe("NSW"));
    expect((screen.getByLabelText("Site postcode") as HTMLInputElement).value).toBe("2000");
    expect(screen.queryByLabelText("Postcode zone rating")).toBeNull();
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><CiRebateProfilePanel projectId="project-1" /></QueryClientProvider>);
}

function mockApi(initial: CiProjectRebateProfileState) {
  const requests: Array<{ method: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as { profile: CiProjectRebateProfile; approve_for_calculation: boolean } : null;
    requests.push({ method, body });
    if (!body) return new Response(JSON.stringify(initial), { status: 200 });
    const next = state(body.approve_for_calculation ? "approved" : "draft", body.profile);
    return new Response(JSON.stringify(next), { status: 200 });
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
    blockers: status === "draft" ? [{ code: "rebate_profile_approval_required", message: "Review and approve the rebate profile." }] : [],
    ruleset: { ruleset_id: "au_ci_rebates_2026_v1", ruleset_sha256: "b".repeat(64), official_sources: [{ source_id: "cer-stc", label: "Clean Energy Regulator · STCs", url: "https://cer.gov.au/", status: "authoritative" }] },
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
