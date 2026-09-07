import { CalendarRange, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchCiIntervalActivity,
  type CiDesignFeasibilityResult,
  type CiFeasibilityScenario,
  type CiIntervalActivityDays,
  type CiIntervalActivityPoint,
  type CiIntervalActivityResult,
} from "@/features/ci/api/ci-design-feasibility";

type ActivityLoader = typeof fetchCiIntervalActivity;

export function CiIntervalActivityChart({
  loadActivity = fetchCiIntervalActivity,
  projectId,
  result,
  scenario,
}: {
  loadActivity?: ActivityLoader;
  projectId: string;
  result: CiDesignFeasibilityResult;
  scenario: CiFeasibilityScenario;
}) {
  const coverageStart = dateOnly(result.coverage.start_timestamp);
  const coverageEnd = dateOnly(result.coverage.end_timestamp);
  const [days, setDays] = useState<CiIntervalActivityDays>(3);
  const [startDate, setStartDate] = useState(() =>
    clampStartDate(addDays(result.baseline.peak_date, -1), coverageStart, coverageEnd, 3),
  );
  const [activity, setActivity] = useState<CiIntervalActivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const maximumStart = useMemo(
    () => maximumStartDate(coverageStart, coverageEnd, days),
    [coverageEnd, coverageStart, days],
  );

  useEffect(() => {
    const boundedStart = clampStartDate(startDate, coverageStart, coverageEnd, days);
    if (boundedStart !== startDate) {
      setStartDate(boundedStart);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    loadActivity(projectId, {
      scenario_id: scenario.scenario_id,
      start_date: startDate,
      days,
    }).then((payload) => {
      if (active) setActivity(payload);
    }).catch((reason: unknown) => {
      if (active) {
        setActivity(null);
        setError(reason instanceof Error ? reason.message : "Interval activity is unavailable.");
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [coverageEnd, coverageStart, days, loadActivity, projectId, scenario.scenario_id, startDate]);

  const chooseDays = (value: CiIntervalActivityDays) => {
    setDays(value);
    setStartDate((current) => clampStartDate(current, coverageStart, coverageEnd, value));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <CardTitle as="h3">Interval activity</CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Grid and solar flows, with battery charging and discharging shown separately.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-slate-600">
              Start date
              <span className="mt-1 flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-900">
                <CalendarRange className="size-4 text-slate-500" />
                <input
                  aria-label="Interval activity start date"
                  className="bg-transparent outline-none"
                  max={maximumStart}
                  min={coverageStart}
                  onChange={(event) => setStartDate(event.target.value)}
                  type="date"
                  value={startDate}
                />
              </span>
            </label>
            <div aria-label="Interval activity duration" className="flex rounded-lg border border-border bg-slate-50 p-1" role="group">
              {([1, 3, 7] as const).map((value) => (
                <button
                  aria-pressed={days === value}
                  className={`rounded-md px-3 py-2 text-xs font-semibold transition ${days === value ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                  key={value}
                  onClick={() => chooseDays(value)}
                  type="button"
                >
                  {value} day{value === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid min-h-[300px] place-items-center rounded-xl bg-slate-50 text-sm text-slate-600">
            <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />Loading interval flows…</span>
          </div>
        ) : error ? (
          <div className="flex min-h-[180px] items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
            <TriangleAlert className="size-4 shrink-0" />{error}
          </div>
        ) : activity ? (
          <>
            <IntervalActivityPlot key={`${activity.scenario_id}-${activity.range.effective_start_timestamp}-${days}`} activity={activity} />
            {!activity.range.complete ? (
              <p className="mt-3 text-xs text-amber-800">This source contains only partial coverage inside the selected range; missing intervals are not filled.</p>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">{activity.interval_minutes}-minute average power · PV self-consumption simulation · no grid charging or tariff optimisation.</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const flowSeries = [
  { key: "measured_import_kw", label: "Measured import", color: "#7c3aed", dashed: true },
  { key: "grid_import_kw", label: "Grid import", color: "#0891b2", dashed: false },
  { key: "solar_to_load_kw", label: "Solar to load", color: "#d97706", dashed: false },
  { key: "grid_export_kw", label: "Grid export", color: "#c026d3", dashed: false },
] as const;

export function IntervalActivityPlot({ activity }: { activity: CiIntervalActivityResult }) {
  const [hovered, setHovered] = useState(0);
  const points = activity.points;
  const hasBattery = points.every((point) => point.battery_charge_kw !== undefined && point.battery_discharge_kw !== undefined);
  const width = 1080;
  const height = hasBattery ? 560 : 370;
  const left = 64;
  const right = 18;
  const top = 32;
  const plotWidth = width - left - right;
  const plotHeight = 260;
  const batteryTop = 354;
  const batteryHeight = 134;
  const batteryZero = batteryTop + batteryHeight / 2;
  const batteryMaximum = Math.max(1, ...points.flatMap((point) => [point.battery_charge_kw ?? 0, point.battery_discharge_kw ?? 0])) * 1.15;
  const batteryY = (value: number) => batteryZero - value / batteryMaximum * batteryHeight / 2;
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [
      point.measured_import_kw,
      point.grid_import_kw,
      point.solar_to_load_kw,
      point.grid_export_kw,
    ]),
  ) * 1.08;
  const x = (index: number) => left + plotWidth * index / Math.max(1, points.length - 1);
  const y = (value: number) => top + plotHeight * (1 - value / maximum);
  const line = (key: typeof flowSeries[number]["key"]) =>
    points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  const xIndexes = meterTickIndexes(points, activity.range.requested_days);
  const selectedIndex = Math.min(hovered, points.length - 1);
  const selected = points[selectedIndex];
  const meterLabel = activity.time_basis === "fixed_aest_meter_time" ? "AEST · UTC+10" : "Source meter time";

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>Meter time · {meterLabel}</span>
        <span>Independent power curves · not stacked</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-100">
        <svg
          aria-label={`${activity.range.requested_days}-day interval activity chart for ${activity.scenario_label}`}
          className="block w-full min-w-[640px]"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const scaledX = (event.clientX - bounds.left) * width / bounds.width;
            const index = Math.round((scaledX - left) / plotWidth * (points.length - 1));
            setHovered(Math.max(0, Math.min(points.length - 1, index)));
          }}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <title>Grid and solar power{hasBattery ? "; battery discharge above zero, charge below zero" : ""}. {meterLabel}.</title>
          <rect fill="#fbfcfe" height={plotHeight} rx="10" width={plotWidth} x={left} y={top} />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line stroke="#dbe3ec" x1={left} x2={width - right} y1={y(maximum * tick)} y2={y(maximum * tick)} />
              <text fill="#64748b" fontSize="11" textAnchor="end" x={left - 9} y={y(maximum * tick) + 4}>{formatNumber(maximum * tick, 0)}</text>
            </g>
          ))}
          {flowSeries.map((series) => (
            <path data-series={series.key} d={line(series.key)} fill="none" key={series.key} stroke={series.color} strokeDasharray={series.dashed ? "7 6" : undefined} strokeWidth={series.key === "grid_import_kw" ? "3" : "2"} strokeLinejoin="round" />
          ))}
          {hasBattery ? (
            <g aria-label="Battery power: discharge positive, charge negative">
              <text fill="#334155" fontSize="13" fontWeight="600" x={left} y={batteryTop - 16}>Battery power</text>
              <text fill="#64748b" fontSize="11" textAnchor="end" x={width - right} y={batteryTop - 16}>+ Discharge / − Charge</text>
              <rect fill="#f8fafc" height={batteryHeight} width={plotWidth} x={left} y={batteryTop} rx="8" />
              {[-1, 0, 1].map((tick) => (
                <g key={tick}>
                  <line stroke={tick === 0 ? "#94a3b8" : "#e2e8f0"} x1={left} x2={width - right} y1={batteryY(tick * batteryMaximum)} y2={batteryY(tick * batteryMaximum)} />
                  <text fill="#64748b" fontSize="11" textAnchor="end" x={left - 9} y={batteryY(tick * batteryMaximum) + 4}>{tick > 0 ? "+" : ""}{formatNumber(tick * batteryMaximum, 1)}</text>
                </g>
              ))}
              {points.map((point, index) => {
                const barWidth = Math.max(0.6, plotWidth / points.length * 0.72);
                const barX = Math.max(left, Math.min(width - right - barWidth, x(index) - barWidth / 2));
                return <g key={point.timestamp}>
                  <rect data-series="battery_discharge_kw" fill="#059669" height={batteryZero - batteryY(point.battery_discharge_kw!)} width={barWidth} x={barX} y={batteryY(point.battery_discharge_kw!)} />
                  <rect data-series="battery_charge_kw" fill="#f59e0b" height={batteryY(-point.battery_charge_kw!) - batteryZero} width={barWidth} x={barX} y={batteryZero} />
                </g>;
              })}
              <text fill="#475569" fontSize="11" x="12" y={batteryTop - 16}>kW</text>
            </g>
          ) : null}
          {xIndexes.map((index) => (
            <text fill="#64748b" fontSize="11" key={index} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} x={x(index)} y={height - 20}>
              {formatIntervalMeterTime(points[index].timestamp, index === 0 || index === points.length - 1 || points[index].timestamp.slice(11, 16) === "00:00")}
            </text>
          ))}
          <text fill="#475569" fontSize="11" x="12" y="17">kW</text>
          {selected ? (
            <g aria-hidden="true">
              <line stroke="#94a3b8" strokeDasharray="3 4" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={hasBattery ? batteryTop + batteryHeight : top + plotHeight} />
              {flowSeries.map((series) => <circle cx={x(selectedIndex)} cy={y(selected[series.key])} fill={series.color} key={series.key} r="4" stroke="white" strokeWidth="2" />)}
            </g>
          ) : null}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
        {flowSeries.map(({ key, ...series }) => <Legend key={key} {...series} />)}
        {hasBattery ? <><Legend color="#059669" label="Battery discharge" /><Legend color="#f59e0b" label="Battery charge" /></> : null}
      </div>
      {selected ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <strong className="text-slate-900">{formatIntervalMeterTime(selected.timestamp, true)} · {meterLabel}</strong>
            <span className="text-slate-500">Hover or use the slider to inspect an interval</span>
          </div>
          <input aria-label="Inspect interval" aria-valuetext={`${formatIntervalMeterTime(selected.timestamp, true)} ${meterLabel}`} className="my-3 block w-full accent-cyan-600" max={points.length - 1} min={0} onChange={(event) => setHovered(Number(event.target.value))} step={1} type="range" value={selectedIndex} />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            {flowSeries.map(({ key, ...series }) => <TooltipRow key={key} {...series} value={selected[key]} />)}
            {hasBattery ? <><TooltipRow color="#059669" label="Battery discharge" value={selected.battery_discharge_kw!} /><TooltipRow color="#f59e0b" label="Battery charge" value={selected.battery_charge_kw!} /></> : null}
          </div>
        </div>
      ) : null}
      {!hasBattery ? <p className="mt-3 text-xs text-slate-500">Battery interval data is unavailable from this server.</p> : null}
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return <div className="min-w-0 text-xs"><span className="flex items-center gap-2 text-slate-500"><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />{label}</span><strong className="mt-1 block text-base tabular-nums text-slate-900">{formatNumber(value)} kW</strong></div>;
}

function Legend({ color, dashed = false, label }: { color: string; dashed?: boolean; label: string }) {
  return <span className="flex items-center gap-2"><span className={`h-0.5 w-6 ${dashed ? "border-t-2 border-dashed bg-transparent" : ""}`} style={dashed ? { borderColor: color } : { backgroundColor: color }} />{label}</span>;
}

function dateOnly(timestamp: string) { return timestamp.slice(0, 10); }
function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
function maximumStartDate(start: string, end: string, days: CiIntervalActivityDays) {
  const candidate = addDays(end, -(days - 1));
  return candidate < start ? start : candidate;
}
function clampStartDate(value: string, start: string, end: string, days: CiIntervalActivityDays) {
  const maximum = maximumStartDate(start, end, days);
  if (value < start) return start;
  if (value > maximum) return maximum;
  return value;
}
function meterTickIndexes(points: CiIntervalActivityPoint[], days: CiIntervalActivityDays) {
  const hourStep = days === 1 ? 6 : days === 3 ? 12 : 24;
  const indexes = points.flatMap((point, index) => {
    const hour = Number(point.timestamp.slice(11, 13));
    return point.timestamp.slice(14, 16) === "00" && hour % hourStep === 0 ? [index] : [];
  });
  // Keep the final interval without crowding a nearby midnight label.
  return [...new Set([0, ...indexes.filter((index) => index > 0 && index < points.length - 1 - points.length * 0.08), points.length - 1])];
}
export function formatIntervalMeterTime(timestamp: string, includeDate = false) {
  // Format the source wall clock, not the browser's local/DST clock. The API
  // selects calendar days in this same meter-time basis.
  const value = new Date(`${timestamp.slice(0, 19)}Z`);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    day: includeDate ? "numeric" : undefined,
    month: includeDate ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}
function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }
