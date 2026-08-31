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
              Follow measured import, post-system grid import, direct solar use and physical export for the selected candidate.
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
            <IntervalActivityPlot activity={activity} />
            {!activity.range.complete ? (
              <p className="mt-3 text-xs text-amber-800">This source contains only partial coverage inside the selected range; missing intervals are not filled.</p>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">Physical active power only · {activity.interval_minutes}-minute source basis · no tariff window or chargeable-demand interpretation.</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function IntervalActivityPlot({ activity }: { activity: CiIntervalActivityResult }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const points = activity.points;
  const width = 1080;
  const height = 390;
  const left = 64;
  const right = 18;
  const top = 22;
  const bottom = 58;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
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
  const line = (key: keyof Pick<CiIntervalActivityPoint, "measured_import_kw">) =>
    points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  const area = (key: keyof Pick<CiIntervalActivityPoint, "grid_import_kw" | "solar_to_load_kw" | "grid_export_kw">) => {
    const upper = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
    return `${upper} L${x(points.length - 1).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;
  };
  const xIndexes = tickIndexes(points.length, activity.range.requested_days === 1 ? 8 : 10);
  const selected = hovered === null ? null : points[hovered];

  return (
    <div>
      <div className="relative overflow-x-auto">
        <svg
          aria-label={`${activity.range.requested_days}-day interval activity chart for ${activity.scenario_label}`}
          className="min-w-[760px]"
          onPointerLeave={() => setHovered(null)}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const scaledX = (event.clientX - bounds.left) * width / bounds.width;
            const index = Math.round((scaledX - left) / plotWidth * (points.length - 1));
            setHovered(Math.max(0, Math.min(points.length - 1, index)));
          }}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <rect fill="#fbfcfe" height={plotHeight} rx="10" width={plotWidth} x={left} y={top} />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line stroke="#dbe3ec" x1={left} x2={width - right} y1={y(maximum * tick)} y2={y(maximum * tick)} />
              <text fill="#64748b" fontSize="11" textAnchor="end" x={left - 9} y={y(maximum * tick) + 4}>{formatNumber(maximum * tick, 0)}</text>
            </g>
          ))}
          <path d={area("grid_import_kw")} fill="#fde047" fillOpacity=".42" />
          <path d={area("solar_to_load_kw")} fill="#fb923c" fillOpacity=".5" />
          <path d={area("grid_export_kw")} fill="#e879f9" fillOpacity=".42" />
          <path d={line("measured_import_kw")} fill="none" stroke="#7c3aed" strokeDasharray="7 6" strokeWidth="2.5" />
          {xIndexes.map((index) => (
            <text fill="#64748b" fontSize="11" key={index} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} x={x(index)} y={height - 20}>
              {axisTime(points[index].timestamp, index, points.length)}
            </text>
          ))}
          <text fill="#475569" fontSize="11" x="12" y="17">kW</text>
          {hovered !== null ? (
            <g aria-hidden="true">
              <line stroke="#475569" strokeDasharray="3 4" x1={x(hovered)} x2={x(hovered)} y1={top} y2={top + plotHeight} />
              {[
                [selected?.measured_import_kw ?? 0, "#7c3aed"],
                [selected?.grid_import_kw ?? 0, "#ca8a04"],
                [selected?.solar_to_load_kw ?? 0, "#ea580c"],
                [selected?.grid_export_kw ?? 0, "#c026d3"],
              ].map(([value, color]) => <circle cx={x(hovered)} cy={y(value as number)} fill={color as string} key={`${value}-${color}`} r="4" stroke="white" strokeWidth="2" />)}
            </g>
          ) : null}
        </svg>
        {selected ? (
          <div className="pointer-events-none absolute right-3 top-3 min-w-[190px] rounded-lg border border-slate-200 bg-white/95 p-3 text-xs text-slate-700 shadow-lg backdrop-blur">
            <p className="font-semibold text-slate-950">{selected.time_label}</p>
            <TooltipRow color="#7c3aed" label="Measured import" value={selected.measured_import_kw} />
            <TooltipRow color="#ca8a04" label="Grid import" value={selected.grid_import_kw} />
            <TooltipRow color="#ea580c" label="Solar to load" value={selected.solar_to_load_kw} />
            <TooltipRow color="#c026d3" label="Grid export" value={selected.grid_export_kw} />
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
        <Legend color="#7c3aed" dashed label="Measured import" />
        <Legend color="#ca8a04" label="Grid import" />
        <Legend color="#ea580c" label="Solar to load" />
        <Legend color="#c026d3" label="Grid export" />
      </div>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return <div className="mt-1.5 flex items-center justify-between gap-4"><span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ backgroundColor: color }} />{label}</span><strong className="tabular-nums">{formatNumber(value)} kW</strong></div>;
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
function tickIndexes(count: number, maximum: number) {
  return Array.from(new Set(Array.from({ length: Math.min(maximum, count) }, (_, index) => Math.round(index * (count - 1) / Math.max(1, Math.min(maximum, count) - 1)))));
}
function axisTime(timestamp: string, index: number, count: number) {
  const value = new Date(timestamp);
  return new Intl.DateTimeFormat("en-AU", {
    day: index === 0 || index === count - 1 || value.getHours() === 0 ? "numeric" : undefined,
    month: index === 0 || index === count - 1 || value.getHours() === 0 ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}
function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }
