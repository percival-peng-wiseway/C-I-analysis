export interface CiSolarResource {
  version: "ci_solar_resource_v1";
  status: "ready" | "fallback" | "missing_key" | "location_review" | "service_unavailable";
  message: string;
  address: string;
  queried_at: string;
  annual_specific_yield_kwh_per_kw: number;
  tilt_degrees: number;
  azimuth_degrees: number;
  latitude: number | null;
  longitude: number | null;
  matched_address: string | null;
  monthly_kwh_per_kwp: number[];
  source: string;
  customer_facing_permission: false;
}

export async function refreshCiSolarResource(projectId: string, tilt: number, azimuth: number): Promise<CiSolarResource> {
  const response = await fetch(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/solar-resource`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tilt_degrees: tilt, azimuth_degrees: azimuth }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.detail?.message ?? "Solar resource lookup failed. Please retry.");
  return payload as CiSolarResource;
}
