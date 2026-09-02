import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CiWorkspaceReadinessContract } from "@/features/ci/api/ci-workspace-readiness";
import { CiGettingStarted } from "@/features/ci/ci-getting-started";

describe("C&I getting started", () => {
  it("explains the fail-closed evidence path while keeping pricing available", () => {
    const readiness = {
      availability: "unavailable",
      active_profile_id: null,
      active_profile_label: null,
    } as CiWorkspaceReadinessContract;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CiGettingStarted readiness={readiness} />
      </QueryClientProvider>,
    );

    expect(html).toContain("How to use this workspace");
    expect(html).toContain("Save project evidence");
    expect(html).toContain("tariff working copy");
    expect(html).toContain("Component &amp; pricing catalog");
    expect(html).toContain("A blank or unreconciled tariff is intentionally rejected");
  });
});
