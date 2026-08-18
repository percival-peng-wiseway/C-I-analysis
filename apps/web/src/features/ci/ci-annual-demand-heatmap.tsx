import { useMemo, useState, type MouseEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiEvidenceIntakeResult } from "@/features/ci/api/ci-evidence-intake";

type Heatmap = CiEvidenceIntakeResult["annual_demand_heatmap"];
type HeatmapYear = Heatmap["years"][number];

const COLOURS = [
  "#064e3b",
  "#047857",
  "#059669",
  "#10b981",
  "#34d399",
  "#84cc16",
  "#a3e635",
  "#facc15",
  "#f59e0b",
  "#fb923c",
  "#f97316",
  "#ef4444",
  "#dc2626",
  "#991b1b",
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CHART_WIDTH = 1180;
const CHART_HEIGHT = 620;
const LEFT = 54;
const TOP = 28;
const RIGHT = 18;
const BOTTOM = 42;

export function CiAnnualDemandHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const defaultYear = useMemo(() => preferredYear(heatmap.years), [heatmap.years]);
  const [selectedYear, setSelectedYear] = useState(defaultYear.year);
  const year = heatmap.years.find((item) => item.year === selectedYear) ?? defaultYear;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3">{heatmap.interval_minutes}-minute demand heatmap</CardTitle>
            <Badge variant="outline">Measured {heatmap.unit}</Badge>
          </div>
          <CardDescription className="mt-1">
            {heatmap.source_streams.join(",") === "E1,Q1"
              ? "Aligned E1 and Q1 are combined into 15-minute apparent demand."
              : heatmap.source_streams[0] === "E1"
                ? "E1 active import is aggregated into 15-minute active demand because aligned Q1 reactive data is unavailable."
                : `The source export's reported ${heatmap.unit} values are shown at their original ${heatmap.interval_minutes}-minute resolution.`} Green shows lower demand, yellow shows the middle range and red shows the highest demand.
          </CardDescription>
        </div>
        <label className="grid min-w-36 gap-1 text-xs font-medium text-muted-foreground">
          Calendar year
          <select
            aria-label="Demand heatmap calendar year"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground"
            onChange={(event) => setSelectedYear(Number(event.target.value))}
            value={year.year}
          >
            {heatmap.years.map((item) => (
              <option key={item.year} value={item.year}>{item.year}</option>
            ))}
          </select>
        </label>
      </CardHeader>
      <CardContent>
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          {heatmap.time_basis === "source_local_time_unverified"
            ? "Source-resolution view only — 30-minute readings are not upsampled into 15-minute billing demand, and the source timezone has not been independently verified."
            : heatmap.metric === "measured_apparent_demand"
            ? "Measured demand only — tariff billing windows and chargeable-demand rules are not applied before profile approval."
            : "Active-demand view only — kVA and power factor are not inferred without aligned Q1. Tariff billing windows and chargeable-demand rules are not applied."}
        </div>
        <div className="mb-4 grid gap-3 text-sm sm:grid-cols-3">
          <HeatmapFact label="Coverage" value={`${year.coverage_start} to ${year.coverage_end}`} />
          <HeatmapFact label={`Maximum ${heatmap.interval_minutes}-minute demand`} value={`${formatNumber(year.maximum_interval_demand)} ${heatmap.unit}`} />
          <HeatmapFact label={`Average ${heatmap.interval_minutes}-minute demand`} value={`${formatNumber(year.average_interval_demand)} ${heatmap.unit}`} />
        </div>
        <AnnualHeatmapSvg heatmap={heatmap} maximum={heatmap.shared_scale_maximum_demand} unit={heatmap.unit} year={year} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>
            {year.complete_calendar_year ? "Complete calendar year" : `Partial calendar year · ${year.day_count} days`} · {heatmap.interval_minutes}-minute intervals · {heatmap.time_basis === "fixed_aest_meter_time" ? "fixed AEST meter time" : "source local time (unverified)"}{year.missing_interval_count ? ` · ${year.missing_interval_count} missing readings` : ""}
          </p>
          <HeatLegend maximum={heatmap.shared_scale_maximum_demand} unit={heatmap.unit} />
        </div>
      </CardContent>
    </Card>
  );
}

function AnnualHeatmapSvg({ heatmap, maximum, unit, year }: { heatmap: Heatmap; maximum: number; unit: Heatmap["unit"]; year: HeatmapYear }) {
  const [hovered, setHovered] = useState<{ date: string; interval: number; amount: number | null } | null>(null);
  const plotWidth = CHART_WIDTH - LEFT - RIGHT;
  const plotHeight = CHART_HEIGHT - TOP - BOTTOM;
  const calendarDays = isLeapYear(year.year) ? 366 : 365;
  const cellWidth = plotWidth / calendarDays;
  const intervalsPerDay = 1440 / heatmap.interval_minutes;
  const cellHeight = plotHeight / intervalsPerDay;
  const demandPaths = useMemo(
    () => buildDemandPaths(year, maximum, cellWidth, cellHeight),
    [cellHeight, cellWidth, maximum, year],
  );
  const daysByCalendarIndex = useMemo(
    () => new Map(year.days.map((day) => [dayOfYear(day.date), day])),
    [year.days],
  );
  const updateHover = (event: MouseEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const dayIndex = Math.min(calendarDays - 1, Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * calendarDays)));
    const interval = Math.min(intervalsPerDay - 1, Math.max(0, Math.floor(((event.clientY - bounds.top) / bounds.height) * intervalsPerDay)));
    const day = daysByCalendarIndex.get(dayIndex);
    setHovered(day ? { date: day.date, interval, amount: day.interval_demand[interval] } : null);
  };

  return (
    <figure>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-2">
        <svg
          aria-label={`${year.year} ${heatmap.interval_minutes}-minute measured-demand heatmap, ${heatmap.source_streams.join(" and ")} ${heatmap.metric === "measured_apparent_demand" ? "apparent" : "active"} demand in ${unit}`}
          className="h-auto min-w-[980px] w-full"
          role="img"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        >
          <title>{`${year.year} ${heatmap.interval_minutes}-minute ${heatmap.metric === "measured_apparent_demand" ? "measured apparent-demand" : "measured active-demand"} heatmap`}</title>
          {MONTHS.map((month, monthIndex) => {
            const x = LEFT + (dayOfYear(`${year.year}-${String(monthIndex + 1).padStart(2, "0")}-01`) / calendarDays) * plotWidth;
            return (
              <g key={month}>
                <line stroke="#d1d5db" strokeWidth="0.8" x1={x} x2={x} y1={TOP - 3} y2={CHART_HEIGHT - BOTTOM} />
                <text fill="#334155" fontSize="10" x={x + 3} y="17">{month}</text>
              </g>
            );
          })}
          {[0, intervalsPerDay / 4, intervalsPerDay / 2, intervalsPerDay * 3 / 4].map((interval) => (
            <text fill="#334155" fontSize="9" key={interval} textAnchor="end" x={LEFT - 6} y={TOP + (interval + 0.7) * cellHeight}>
              {intervalLabel(interval, heatmap.interval_minutes)}
            </text>
          ))}
          {demandPaths.map(({ colour, path }) => <path d={path} fill={colour} key={colour} />)}
          <rect
            fill="transparent"
            height={plotHeight}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={updateHover}
            width={plotWidth}
            x={LEFT}
            y={TOP}
          />
          <text fill="#334155" fontSize="10" textAnchor="middle" x={LEFT + plotWidth / 2} y={CHART_HEIGHT - 7}>Calendar date</text>
          <text fill="#334155" fontSize="10" textAnchor="middle" transform={`rotate(-90 10 ${TOP + plotHeight / 2})`} x="10" y={TOP + plotHeight / 2}>{heatmap.interval_minutes}-minute interval</text>
        </svg>
      </div>
      <figcaption className="mt-2 min-h-4 text-xs text-muted-foreground">
        {hovered
          ? `${hovered.date} ${intervalRange(hovered.interval, heatmap.interval_minutes)} · ${hovered.amount === null ? "No reading" : `${formatNumber(hovered.amount)} ${unit}`}`
          : `Hover over the chart to see the date, ${heatmap.interval_minutes}-minute interval and exact measured ${unit}.`}
      </figcaption>
    </figure>
  );
}

function preferredYear(years: HeatmapYear[]) {
  return [...years].sort((left, right) => right.day_count - left.day_count || right.year - left.year)[0]!;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function dayOfYear(date: string) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);
}

function intervalLabel(interval: number, intervalMinutes: number) {
  const totalMinutes = interval * intervalMinutes;
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function intervalRange(interval: number, intervalMinutes: number) {
  return `${intervalLabel(interval, intervalMinutes)}–${intervalLabel((interval + 1) % (1440 / intervalMinutes), intervalMinutes)}`;
}

function heatColour(value: number, maximum: number) {
  if (maximum <= 0 || value <= 0) return COLOURS[0];
  const colourIndex = Math.min(COLOURS.length - 1, Math.max(1, Math.ceil((value / maximum) * (COLOURS.length - 1))));
  return COLOURS[colourIndex];
}

function buildDemandPaths(year: HeatmapYear, maximum: number, cellWidth: number, cellHeight: number) {
  const commands = new Map(COLOURS.map((colour) => [colour, [] as string[]]));
  const width = Math.max(0.7, cellWidth - 0.12).toFixed(2);
  const height = Math.max(0.8, cellHeight - 0.2).toFixed(2);
  for (const day of year.days) {
    const x = (LEFT + dayOfYear(day.date) * cellWidth).toFixed(2);
    day.interval_demand.forEach((amount, interval) => {
      if (amount === null) return;
      const colour = heatColour(amount, maximum);
      const y = (TOP + interval * cellHeight).toFixed(2);
      commands.get(colour)!.push(`M${x} ${y}h${width}v${height}h-${width}Z`);
    });
  }
  return COLOURS.map((colour) => ({ colour, path: commands.get(colour)!.join("") })).filter((item) => item.path);
}

function HeatLegend({ maximum, unit }: { maximum: number; unit: Heatmap["unit"] }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div
      aria-label={`Shared green-yellow-red demand colour scale from 0 to ${formatNumber(maximum)} ${unit} for every year`}
      className="w-full max-w-[360px]"
      role="img"
    >
      <div
        aria-hidden="true"
        className="h-3 rounded-sm border border-black/10"
        style={{ background: `linear-gradient(to right, ${COLOURS.join(", ")})` }}
      />
      <div aria-hidden="true" className="mt-1 flex justify-between gap-2 tabular-nums">
        {ticks.map((ratio) => (
          <span key={ratio}>{formatNumber(maximum * ratio)}{ratio === 1 ? ` ${unit}` : ""}</span>
        ))}
      </div>
    </div>
  );
}

function HeatmapFact({ label, value }: { label: string; value: string }) {
  return <p className="rounded-lg bg-emerald-50/60 p-3"><span className="block text-xs text-muted-foreground">{label}</span><strong className="mt-0.5 block font-medium">{value}</strong></p>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value);
}
