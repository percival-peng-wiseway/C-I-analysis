import { afterEach, expect, it, vi } from "vitest";
import { assertCalculationGuide, fetchCalculationGuide } from "./ci-calculation-guide";
import { guideFixture } from "./ci-calculation-guide.test-data";

afterEach(() => vi.unstubAllGlobals());
it("loads the guide without a project or a calculation write", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(guideFixture())));
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchCalculationGuide()).toEqual(guideFixture());
  expect(fetcher).toHaveBeenCalledWith("/api/commercial-industrial/calculation-guide", {cache: "no-store", headers: {Accept: "application/json"}});
});
it("rejects incomplete guide payloads", () => {
  for (const payload of [null, {}, {...guideFixture(), chapters: []}, {...guideFixture(), disclosure: ""}, {...guideFixture(), example: {label: "x", inputs: [["only one"]]}}]) {
    expect(() => assertCalculationGuide(payload)).toThrow();
  }
});
it("rejects failed requests without inventing example content", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", {status: 500})));
  await expect(fetchCalculationGuide()).rejects.toThrow("could not be loaded");
});
