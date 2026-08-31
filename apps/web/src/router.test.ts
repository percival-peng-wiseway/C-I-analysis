import { describe, expect, it } from "vitest";

import { CI_RUNTIME_PATHS } from "./router";


describe("dedicated C&I runtime routes", () => {
  it("exposes only the C&I workspace entry points", () => {
    expect(CI_RUNTIME_PATHS).toEqual(["/", "/commercial-industrial"]);
    expect(CI_RUNTIME_PATHS).not.toContain("/projects");
    expect(CI_RUNTIME_PATHS).not.toContain("/library");
  });
});
