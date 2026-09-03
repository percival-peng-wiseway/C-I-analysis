import { describe, expect, it } from "vitest";

import { createCiQueryClient } from "./ci-query-client";

describe("createCiQueryClient", () => {
  it("keeps restored module snapshots static until explicitly invalidated", () => {
    const queries = createCiQueryClient().getDefaultOptions().queries;

    expect(queries?.staleTime).toBe(Infinity);
    expect(queries?.gcTime).toBe(Infinity);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(false);
  });
});
