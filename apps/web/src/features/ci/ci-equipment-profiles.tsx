import { Button } from "@/components/ui/button";
import type { CiDeviceProfile } from "./api/ci-device-profile";
import type { CiDesignContextV2 } from "./api/ci-projects";

type EquipmentProfile = CiDeviceProfile["solution_profiles"]["solar_profiles"][number]
  | CiDeviceProfile["solution_profiles"]["battery_profiles"][number]
  | CiDeviceProfile["solution_profiles"]["inverter_profiles"][number];

export function CiEquipmentProfiles({ disabled, onChange, profile, selection }: {
  disabled: boolean;
  onChange: () => void;
  profile: CiDeviceProfile | null;
  selection: CiDesignContextV2["profile_selection"] | null;
}) {
  const items = [
    { label: "PV", id: selection?.solar_profile_id, saved: selection?.solar_profile, library: profile?.solution_profiles.solar_profiles },
    { label: "Battery", id: selection?.battery_profile_id, saved: selection?.battery_profile, library: profile?.solution_profiles.battery_profiles },
    { label: "Hybrid inverter / PCS", id: selection?.inverter_profile_id, saved: selection?.inverter_profile, library: profile?.solution_profiles.inverter_profiles },
  ];
  return <section aria-busy={disabled} aria-labelledby="equipment-profiles-title" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Equipment</p><h2 className="mt-1 text-lg font-semibold text-slate-950" id="equipment-profiles-title">Solution profiles</h2><p className="mt-1 text-sm text-slate-500">Profiles saved with this solution space. Choose published profiles from Settings in Solution Generator, then regenerate to apply changes.</p></div>
      <Button disabled={disabled} onClick={onChange} type="button" variant="outline">Change equipment profiles</Button>
    </div>
    <div className="mt-4 grid gap-3 lg:grid-cols-3">
      {items.map(({ label, id, saved, library }) => <EquipmentProfileCard key={label} label={label} saved={saved?.profile_id === id ? saved : undefined} current={library?.find((item) => item.profile_id === id)} libraryAvailable={Boolean(profile)} />)}
    </div>
  </section>;
}

function EquipmentProfileCard({ label, saved, current, libraryAvailable }: {
  label: string;
  saved: EquipmentProfile | undefined;
  current: EquipmentProfile | undefined;
  libraryAvailable: boolean;
}) {
  const changed = saved && current && Object.entries(saved).some(([key, value]) => current[key as keyof EquipmentProfile] !== value);
  return <section aria-label={`${label} profile`} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
    <p className="text-xs font-semibold text-slate-600">{label}</p>
    {saved ? <>
      <p className="mt-2 break-words text-sm font-semibold text-slate-950">{saved.name} · v{saved.version}</p>
      <p className="mt-1 break-words text-xs text-slate-600">{saved.manufacturer} · {saved.model}</p>
      <p className="mt-2 text-xs text-slate-500">Used by saved solutions</p>
      {!libraryAvailable ? <p className="mt-2 text-xs text-amber-800">Save the profile library in Settings to check for updates.</p>
        : !current || current.status !== "published" ? <p className="mt-2 text-xs text-amber-800">This profile is no longer published in Settings. Choose a published profile when regenerating.</p>
          : changed ? <p className="mt-2 text-xs text-amber-800">Settings updated: {current.name} · v{current.version}. Regenerate solutions to apply it.</p>
            : <p className="mt-2 text-xs text-emerald-700">Matches Settings</p>}
    </> : <p className="mt-2 text-sm text-amber-800">No profile recorded. Choose a published profile in Solution Generator and regenerate.</p>}
  </section>;
}
