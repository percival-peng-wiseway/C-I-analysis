// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CiBatterySolutionProfile, CiDeviceProfile, CiInverterSolutionProfile, CiSolarSolutionProfile } from "./api/ci-device-profile";
import { CiEquipmentProfiles } from "./ci-equipment-profiles";

const solar = { profile_id: "solar-selected", name: "Warehouse roof", version: 2, status: "published", manufacturer: "Configured solar brand", model: "PV model B", rated_power_w: 630 } as CiSolarSolutionProfile;
const battery = { profile_id: "battery-selected", name: "Warehouse storage", version: 3, status: "published", manufacturer: "Configured battery brand", model: "Storage model C" } as CiBatterySolutionProfile;
const inverter = { profile_id: "inverter-selected", name: "Warehouse PCS", version: 4, status: "published", manufacturer: "Configured inverter brand", model: "PCS model D" } as CiInverterSolutionProfile;
const selection = { device_profile_sha256: "a".repeat(64), solar_profile_id: solar.profile_id, battery_profile_id: battery.profile_id, inverter_profile_id: inverter.profile_id, solar_profile: solar, battery_profile: battery, inverter_profile: inverter };
const profile = { solution_profiles: {
  solar_profiles: [{ ...solar, profile_id: "other-default", name: "Different Settings default" }, solar],
  battery_profiles: [battery], inverter_profiles: [inverter],
} } as CiDeviceProfile;

afterEach(cleanup);

it("shows the exact profiles bound to the saved design, including a non-default selection", async () => {
  const onChange = vi.fn();
  render(<CiEquipmentProfiles disabled={false} onChange={onChange} profile={profile} selection={selection} />);
  expect(within(screen.getByRole("region", { name: "PV profile" })).getByText("Warehouse roof · v2")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Battery profile" })).getByText("Configured battery brand · Storage model C")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Hybrid inverter / PCS profile" })).getByText("Warehouse PCS · v4")).toBeTruthy();
  expect(screen.getAllByText("Matches Settings")).toHaveLength(3);
  expect(screen.queryByText("Different Settings default")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Change equipment profiles" }));
  expect(onChange).toHaveBeenCalledOnce();
});

it("keeps the applied snapshot visible and shows saved Settings edits until regeneration", () => {
  const { rerender } = render(<CiEquipmentProfiles disabled={false} onChange={vi.fn()} profile={profile} selection={selection} />);
  const edited = structuredClone(profile);
  Object.assign(edited.solution_profiles.solar_profiles[1], { name: "Updated roof", version: 5, rated_power_w: 650 });
  rerender(<CiEquipmentProfiles disabled={false} onChange={vi.fn()} profile={edited} selection={selection} />);
  expect(screen.getByText("Warehouse roof · v2")).toBeTruthy();
  expect(screen.getByText("Settings updated: Updated roof · v5. Regenerate solutions to apply it.")).toBeTruthy();
});

it("detects parameter edits even when the profile name and version stay the same", () => {
  const edited = structuredClone(profile);
  edited.solution_profiles.solar_profiles[1].rated_power_w = 650;
  render(<CiEquipmentProfiles disabled={false} onChange={vi.fn()} profile={edited} selection={selection} />);
  expect(screen.getByText("Settings updated: Warehouse roof · v2. Regenerate solutions to apply it.")).toBeTruthy();
});

it("does not claim Settings defaults were used when an older design has no profile binding", () => {
  render(<CiEquipmentProfiles disabled={false} onChange={vi.fn()} profile={profile} selection={null} />);
  expect(screen.getAllByText(/No profile recorded/)).toHaveLength(3);
  expect(screen.queryByText("Warehouse roof · v2")).toBeNull();
});

it("flags retired or missing profiles and leaves absent inverter evidence unfilled", () => {
  const edited = structuredClone(profile);
  edited.solution_profiles.solar_profiles = [];
  edited.solution_profiles.battery_profiles[0].status = "retired";
  render(<CiEquipmentProfiles disabled={false} onChange={vi.fn()} profile={edited} selection={{ ...selection, inverter_profile_id: undefined, inverter_profile: undefined }} />);
  expect(screen.getAllByText(/no longer published in Settings/)).toHaveLength(2);
  expect(within(screen.getByRole("region", { name: "Hybrid inverter / PCS profile" })).getByText(/No profile recorded/)).toBeTruthy();
});

it("prevents changing profiles during an active analysis", async () => {
  const onChange = vi.fn();
  render(<CiEquipmentProfiles disabled onChange={onChange} profile={profile} selection={selection} />);
  const button = screen.getByRole("button", { name: "Change equipment profiles" });
  expect(button).toHaveProperty("disabled", true);
  await userEvent.click(button);
  expect(onChange).not.toHaveBeenCalled();
});
