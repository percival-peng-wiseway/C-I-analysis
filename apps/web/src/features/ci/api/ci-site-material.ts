export interface CiSitePhoto {
  photo_id: string;
  filename: string;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  size_bytes: number;
  created_at: string;
  content_url: string;
}

export interface CiProjectSiteMaterial {
  contract_version: "ci_project_site_material_v1";
  photos: CiSitePhoto[];
}

interface CiSavedSitePhoto {
  contract_version: "ci_project_site_material_v1";
  photo: CiSitePhoto;
}

export const ciProjectSiteMaterialQueryKey = (projectId: string) => ["ci-project-site-material", projectId] as const;

export async function fetchCiProjectSiteMaterial(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiProjectSiteMaterial> {
  const response = await fetcher(siteMaterialPath(projectId), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Project site photos could not be loaded (${response.status}).`);
  const payload = (await response.json()) as CiProjectSiteMaterial;
  if (payload.contract_version !== "ci_project_site_material_v1" || !Array.isArray(payload.photos) || payload.photos.some((photo) => !isSafePhoto(photo, projectId))) {
    throw new Error("Project site photos returned an unsafe or incomplete contract.");
  }
  return payload;
}

export async function uploadCiProjectSitePhoto(
  projectId: string,
  photo: File,
  fetcher: typeof fetch = fetch,
): Promise<CiSitePhoto> {
  const body = new FormData();
  body.append("photo", photo);
  const response = await fetcher(siteMaterialPath(projectId), {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Site photo upload failed with status ${response.status}.`);
  }
  const payload = (await response.json()) as CiSavedSitePhoto;
  if (payload.contract_version !== "ci_project_site_material_v1" || !isSafePhoto(payload.photo, projectId)) {
    throw new Error("Site photo upload returned an unsafe or incomplete contract.");
  }
  return payload.photo;
}

export async function deleteCiProjectSitePhoto(
  projectId: string,
  photoId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${siteMaterialPath(projectId)}/${encodeURIComponent(photoId)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Site photo deletion failed with status ${response.status}.`);
  }
}

function siteMaterialPath(projectId: string) {
  return `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/site-material`;
}

function isSafePhoto(value: CiSitePhoto | undefined, projectId: string): boolean {
  const expectedPrefix = `${siteMaterialPath(projectId)}/`;
  return Boolean(
    value &&
    typeof value.photo_id === "string" && /^[0-9a-f-]{36}$/i.test(value.photo_id) &&
    typeof value.filename === "string" && value.filename.length > 0 && value.filename.length <= 255 &&
    ["image/jpeg", "image/png", "image/webp"].includes(value.content_type) &&
    Number.isInteger(value.size_bytes) && value.size_bytes > 0 &&
    typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at)) &&
    typeof value.content_url === "string" && value.content_url.startsWith(expectedPrefix) && value.content_url.endsWith(`/${value.photo_id}/content`)
  );
}
