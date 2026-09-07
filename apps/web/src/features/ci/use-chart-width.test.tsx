// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChartWidth } from "./use-chart-width";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("follows card width, including late-mounted plots, and disconnects observers", () => {
  let measured = 420;
  let resize = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => measured);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  function Chart({ready}: {ready: boolean}) {
    const {ref, width} = useChartWidth();
    return ready ? <div ref={ref}><svg data-testid="plot" viewBox={`0 0 ${width} 250`} /></div> : <p>Not ready</p>;
  }
  const {rerender, unmount} = render(<Chart ready={false} />);
  rerender(<Chart ready />);
  expect(screen.getByTestId("plot").getAttribute("viewBox")).toBe("0 0 420 250");
  act(() => { measured = 1280; resize(); });
  expect(screen.getByTestId("plot").getAttribute("viewBox")).toBe("0 0 1280 250");
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("retains a safe fallback when measurements are unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  function Chart() {
    const {ref, width} = useChartWidth(720);
    return <div ref={ref}>{width}</div>;
  }
  render(<Chart />);
  expect(screen.getByText("720")).toBeTruthy();
});
