import { describe, expect, it, vi } from "vitest";

import {
  deleteCiProjectSitePhoto,
  fetchCiProjectSiteMaterial,
  uploadCiProjectSitePhoto,
} from "./ci-site-material";

const savedPhoto = {
  photo_id: "123e4567-e89b-12d3-a456-426614174000",
  filename: "north-roof.jpg",
  content_type: "image/jpeg",
  size_bytes: 123,
  created_at: "2026-08-19T01:02:03+00:00",
  content_url: "/api/commercial-industrial/projects/project-1/site-material/123e4567-e89b-12d3-a456-426614174000/content",
};

describe("C&I project site material API", () => {
  it("loads saved project photos", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/site-material");
      return new Response(JSON.stringify({
        contract_version: "ci_project_site_material_v1",
        photos: [savedPhoto],
      }), { status: 200 });
    });

    await expect(fetchCiProjectSiteMaterial("project-1", fetcher as typeof fetch)).resolves.toMatchObject({
      photos: [{ filename: "north-roof.jpg" }],
    });
  });

  it("uploads one photo as project-owned multipart data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/site-material");
      expect(init?.method).toBe("POST");
      expect((init?.body as FormData).get("photo")).toBeInstanceOf(File);
      return new Response(JSON.stringify({
        contract_version: "ci_project_site_material_v1",
        photo: savedPhoto,
      }), { status: 201 });
    });

    await expect(uploadCiProjectSitePhoto(
      "project-1",
      new File(["roof"], "north-roof.jpg", { type: "image/jpeg" }),
      fetcher as typeof fetch,
    )).resolves.toMatchObject({ filename: "north-roof.jpg" });
  });

  it("deletes a saved project photo", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/site-material/123e4567-e89b-12d3-a456-426614174000");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    await expect(deleteCiProjectSitePhoto(
      "project-1",
      savedPhoto.photo_id,
      fetcher as typeof fetch,
    )).resolves.toBeUndefined();
  });
});
