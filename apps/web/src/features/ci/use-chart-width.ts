import { useEffect, useState } from "react";

/** Size the plot's coordinate space to its card, keeping labels legible without a scrollbar. */
export function useChartWidth(fallback = 920) {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element) return;
    const update = () => {
      const measured = element.clientWidth;
      if (measured > 0) setWidth(Math.max(240, Math.floor(measured)));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}
