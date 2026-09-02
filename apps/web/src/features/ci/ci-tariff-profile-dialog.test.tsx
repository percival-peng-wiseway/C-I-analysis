// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { CiProjectTariffProfile, CiProjectTariffProfileState } from "./api/ci-tariff-profile";
import { CiTariffProfileDialog } from "./ci-tariff-profile-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("edits a suggested profile and explicitly requests calculation approval", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<CiTariffProfileDialog busy={false} detectedTariffCode="LLVT2" error={null} onClose={vi.fn()} onSave={onSave} open state={state} />);

  expect(screen.getByRole("dialog", { name: "Tariff profile" }).getAttribute("aria-modal")).toBe("true");
  expect(screen.getByText("Review and approve the tariff profile.")).toBeTruthy();
  expect((screen.getByLabelText("Retail peak rate") as HTMLInputElement).value).toBe("10");
  await user.clear(screen.getByLabelText("Retail peak rate"));
  await user.type(screen.getByLabelText("Retail peak rate"), "11.5");
  await user.click(screen.getByRole("button", { name: "Save & use in calculations" }));

  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ rates: expect.objectContaining({ retail_peak_c_per_kwh: 11.5 }) }), true);
});

it("imports JSON into the local draft and exports the validated profile", async () => {
  const user = userEvent.setup();
  const createObjectUrl = vi.fn(() => "blob:test");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<CiTariffProfileDialog busy={false} detectedTariffCode="LLVT2" error={null} onClose={vi.fn()} onSave={vi.fn()} open state={state} />);

  const imported = { ...profile, display_label: "Imported evidence-reviewed profile" };
  await user.upload(screen.getByLabelText("Import tariff profile JSON file"), new File([JSON.stringify(imported)], "tariff.json", { type: "application/json" }));
  await waitFor(() => expect((screen.getByLabelText("Display label") as HTMLInputElement).value).toBe("Imported evidence-reviewed profile"));
  expect(screen.getByText("Imported tariff.json into the unsaved draft.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Export JSON" }));
  expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
});

it("starts a stale working copy from the newly detected evidence suggestion", () => {
  const oldProfile = { ...profile, display_label: "Old bill tariff" };
  const newProfile = { ...profile, display_label: "New bill tariff" };
  render(<CiTariffProfileDialog
    busy={false}
    detectedTariffCode="LLVT2"
    error={null}
    onClose={vi.fn()}
    onSave={vi.fn()}
    open
    state={{
      ...state,
      status: "stale",
      updated_at: "2026-09-02T00:00:00Z",
      profile_sha256: "a".repeat(64),
      profile: oldProfile,
      suggested_profile: newProfile,
      blockers: [{ code: "tariff_profile_stale", message: "Review the new evidence." }],
    }}
  />);

  expect((screen.getByLabelText("Display label") as HTMLInputElement).value).toBe("New bill tariff");
});

const profile: CiProjectTariffProfile = {
  contract_version: "ci_project_tariff_profile_v1",
  display_label: "Detected LLVT2 tariff",
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

const state: CiProjectTariffProfileState = {
  contract_version: "ci_project_tariff_profile_state_v1",
  status: "not_available",
  updated_at: null,
  approved_at: null,
  profile_sha256: null,
  profile: null,
  suggested_profile: profile,
  evidence_basis: null,
  blockers: [{ code: "tariff_profile_approval_required", message: "Review and approve the tariff profile." }],
};
