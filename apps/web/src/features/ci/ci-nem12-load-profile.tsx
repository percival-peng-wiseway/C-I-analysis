import { Download } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiEvidenceIntakeResult } from "@/features/ci/api/ci-evidence-intake";

type Heatmap = CiEvidenceIntakeResult["annual_demand_heatmap"];
type HeatmapYear = Heatmap["years"][number];
type HeatmapDay = HeatmapYear["days"][number];
type ProfileView = "average" | "annual";
type DayFilter = "all" | "weekdays" | "weekends";
type SeasonFilter = "whole_year" | "summer" | "autumn" | "winter" | "spring";

const WIDTH = 1180;
const HEIGHT = 420;
const LEFT = 62;
const RIGHT = 22;
const TOP = 22;
const BOTTOM = 48;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CiNem12LoadProfile({ heatmap }: { heatmap: Heatmap }) {
  const defaultYear = useMemo(() => preferredYear(heatmap.years), [heatmap.years]);
  const [view, setView] = useState<ProfileView>("average");
  const [selectedYear, setSelectedYear] = useState(defaultYear.year);
  const [dayFilter, setDayFilter] = useState<DayFilter>("all");
  const [season, setSeason] = useState<SeasonFilter>("whole_year");
  const year = heatmap.years.find((item) => item.year === selectedYear) ?? defaultYear;
  const filteredDays = useMemo(
    () => year.days.filter((day) => matchesDayFilter(day.date, dayFilter) && matchesSeason(day.date, season)),
    [dayFilter, season, year.days],
  );
  const summary = useMemo(() => profileSummary(view === "average" ? filteredDays : year.days), [filteredDays, view, year.days]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-4 border-b border-slate-200 bg-slate-50/40 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h3">NEM12 load profile</CardTitle>
            <Badge variant="outline">Measured {heatmap.unit}</Badge>
          </div>
          <CardDescription className="mt-1">Average-day shape and annual demand pattern from the uploaded interval data.</CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[11px] font-medium text-slate-500">
            Calendar year
            <select
              aria-label="Load profile calendar year"
              className="min-w-28 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
              onChange={(event) => setSelectedYear(Number(event.target.value))}
              value={year.year}
            >
              {heatmap.years.map((item) => <option key={item.year} value={item.year}>{item.year}</option>)}
            </select>
          </label>
          {view === "average" ? (
            <>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                Days
                <select aria-label="Load profile days" className="min-w-32 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onChange={(event) => setDayFilter(event.target.value as DayFilter)} value={dayFilter}>
                  <option value="all">All days</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekends">Weekends</option>
                </select>
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                Season
                <select aria-label="Load profile season" className="min-w-32 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onChange={(event) => setSeason(event.target.value as SeasonFilter)} value={season}>
                  <option value="whole_year">Whole year</option>
                  <option value="summer">Dec–Feb</option>
                  <option value="autumn">Mar–May</option>
                  <option value="winter">Jun–Aug</option>
                  <option value="spring">Sep–Nov</option>
                </select>
              </label>
            </>
          ) : null}
          <button
            aria-label="Download filtered NEM12 profile CSV"
            className="grid size-10 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800"
            onClick={() => downloadProfileCsv(view === "average" ? filteredDays : year.days, heatmap.interval_minutes, heatmap.unit, year.year)}
            title="Download visible NEM12 data"
            type="button"
          >
            <Download className="size-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex border-b border-slate-200 px-5 pt-4">
          <ProfileTab active={view === "average"} label="Average day" onClick={() => setView("average")} />
          <ProfileTab active={view === "annual"} label="Annual" onClick={() => setView("annual")} />
        </div>
        <div className="grid gap-3 border-b border-slate-100 px-5 py-4 sm:grid-cols-3">
          <ProfileFact label="Measured coverage" value={view === "average" ? `${filteredDays.length} days` : `${year.day_count} days`} />
          <ProfileFact label="Average demand" value={summary.average === null ? "No readings" : `${formatNumber(summary.average)} ${heatmap.unit}`} />
          <ProfileFact label="Maximum demand" value={summary.maximum === null ? "No readings" : `${formatNumber(summary.maximum)} ${heatmap.unit}`} />
        </div>
        <div className="p-5">
          {view === "average" ? (
            filteredDays.length ? <AverageDayChart days={filteredDays} intervalMinutes={heatmap.interval_minutes} unit={heatmap.unit} /> : <EmptyProfile />
          ) : (
            <AnnualProfileChart days={year.days} unit={heatmap.unit} year={year.year} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`border-b-2 px-4 pb-3 text-sm font-semibold transition ${active ? "border-cyan-600 text-cyan-800" : "border-transparent text-slate-500 hover:text-slate-900"}`} onClick={onClick} type="button">
      {label}
    </button>
  );
}

function AverageDayChart({ days, intervalMinutes, unit }: { days: HeatmapDay[]; intervalMinutes: number; unit: Heatmap["unit"] }) {
  const profile = useMemo(() => averageDayProfile(days), [days]);
  const maximum = niceMaximum(profile.globalMaximum);
  const sampledDays = useMemo(() => evenlySample(days, 180), [days]);
  const yTicks = axisTicks(maximum);
  const xTicks = [0, 6, 12, 18, 24];
  const percentileArea = areaPath(profile.p90, profile.p10, maximum);
  const peakIndex = profile.maximumByInterval.reduce<number>((best, value, index, values) => (value ?? -1) > (values[best] ?? -1) ? index : best, 0);
  const peakValue = profile.maximumByInterval[peakIndex] ?? null;
  const peakX = profileX(peakIndex, profile.maximumByInterval.length);
  const peakY = peakValue === null ? TOP : demandY(peakValue, maximum);

  return (
    <figure>
      <div className="overflow-x-auto">
        <svg aria-label={`Average day NEM12 load profile for ${days.length} days in ${unit}`} className="h-auto min-w-[820px] w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <title>Average day measured load profile</title>
          {yTicks.map((tick) => <ChartGridLine key={tick} maximum={maximum} tick={tick} unit={unit} />)}
          {xTicks.map((hour) => {
            const x = LEFT + (hour / 24) * PLOT_WIDTH;
            return <g key={hour}><line stroke="#e2e8f0" x1={x} x2={x} y1={TOP} y2={TOP + PLOT_HEIGHT} /><text fill="#64748b" fontSize="11" textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"} x={x} y={HEIGHT - 16}>{String(hour % 24).padStart(2, "0")}:00</text></g>;
          })}
          {sampledDays.map((day) => <path d={linePath(day.interval_demand, maximum)} fill="none" key={day.date} stroke="#94a3b8" strokeOpacity="0.16" strokeWidth="1" />)}
          {percentileArea ? <path d={percentileArea} fill="#67e8f9" fillOpacity="0.22" /> : null}
          <path d={linePath(profile.p90, maximum)} fill="none" stroke="#22d3ee" strokeDasharray="5 5" strokeWidth="1.5" />
          <path d={linePath(profile.average, maximum)} fill="none" stroke="#0891b2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
          <path aria-label="Maximum demand by interval" d={linePath(profile.maximumByInterval, maximum)} fill="none" role="img" stroke="#0f172a" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5"><title>Maximum measured demand at each interval of the selected days</title></path>
          {peakValue !== null ? <g><circle cx={peakX} cy={peakY} fill="#0f172a" r="4.5" stroke="white" strokeWidth="2" /><text fill="#0f172a" fontSize="11" fontWeight="700" textAnchor={peakX > LEFT + PLOT_WIDTH * 0.76 ? "end" : "start"} x={peakX + (peakX > LEFT + PLOT_WIDTH * 0.76 ? -9 : 9)} y={Math.max(TOP + 13, peakY - 9)}>{formatNumber(peakValue)} {unit} · {intervalLabel(peakIndex, intervalMinutes)}</text></g> : null}
        </svg>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
        <span>{intervalMinutes}-minute readings · average uses every selected day</span>
        <span className="flex flex-wrap items-center gap-4"><Legend colour="#94a3b8" label={sampledDays.length < days.length ? `${sampledDays.length} sampled daily traces` : "Daily traces"} /><Legend colour="#67e8f9" label="P10–P90 range" /><Legend colour="#0891b2" label="Average" /><Legend colour="#0f172a" label="Maximum by interval" /></span>
      </figcaption>
    </figure>
  );
}

function AnnualProfileChart({ days, unit, year }: { days: HeatmapDay[]; unit: Heatmap["unit"]; year: number }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const annual = useMemo(() => days.map((day) => ({ date: day.date, ...daySummary(day) })), [days]);
  const maximum = niceMaximum(Math.max(0, ...annual.map((day) => day.maximum ?? 0)));
  const yTicks = axisTicks(maximum);
  const hover = hoveredIndex === null ? null : annual[hoveredIndex] ?? null;
  const updateHover = (event: MouseEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setHoveredIndex(Math.min(annual.length - 1, Math.round(ratio * Math.max(0, annual.length - 1))));
  };

  return (
    <figure>
      <div className="overflow-x-auto">
        <svg aria-label={`${year} annual NEM12 load profile in ${unit}`} className="h-auto min-w-[820px] w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <title>{year} annual measured load profile</title>
          {yTicks.map((tick) => <ChartGridLine key={tick} maximum={maximum} tick={tick} unit={unit} />)}
          {monthMarkers(annual).map(({ index, label }) => {
            const x = annualX(index, annual.length);
            return <g key={`${label}-${index}`}><line stroke="#e2e8f0" x1={x} x2={x} y1={TOP} y2={TOP + PLOT_HEIGHT} /><text fill="#64748b" fontSize="11" textAnchor="start" x={x + 3} y={HEIGHT - 16}>{label}</text></g>;
          })}
          {annual.map((day, index) => day.minimum === null || day.maximum === null ? null : <line key={day.date} stroke="#67e8f9" strokeOpacity="0.5" strokeWidth={Math.max(1, PLOT_WIDTH / Math.max(1, annual.length) * 0.72)} x1={annualX(index, annual.length)} x2={annualX(index, annual.length)} y1={demandY(day.maximum, maximum)} y2={demandY(day.minimum, maximum)} />)}
          <path d={annualLinePath(annual.map((day) => day.average), maximum)} fill="none" stroke="#0891b2" strokeLinejoin="round" strokeWidth="2.5" />
          <path d={annualLinePath(annual.map((day) => day.maximum), maximum)} fill="none" stroke="#0e7490" strokeOpacity="0.75" strokeWidth="1" />
          {hoveredIndex !== null ? <line stroke="#0f172a" strokeDasharray="4 4" x1={annualX(hoveredIndex, annual.length)} x2={annualX(hoveredIndex, annual.length)} y1={TOP} y2={TOP + PLOT_HEIGHT} /> : null}
          <rect fill="transparent" height={PLOT_HEIGHT} onMouseLeave={() => setHoveredIndex(null)} onMouseMove={updateHover} width={PLOT_WIDTH} x={LEFT} y={TOP} />
        </svg>
      </div>
      <figcaption className="mt-3 flex min-h-5 flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
        <span>{hover ? `${hover.date} · average ${formatMaybe(hover.average, unit)} · maximum ${formatMaybe(hover.maximum, unit)}` : "Hover over the chart to inspect a measured day."}</span>
        <span className="flex items-center gap-4"><Legend colour="#67e8f9" label="Daily interval range" /><Legend colour="#0891b2" label="Daily average" /><Legend colour="#0e7490" label="Daily maximum" /></span>
      </figcaption>
    </figure>
  );
}

function ChartGridLine({ maximum, tick, unit }: { maximum: number; tick: number; unit: Heatmap["unit"] }) {
  const y = demandY(tick, maximum);
  return <g><line stroke="#cbd5e1" x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} /><text fill="#64748b" fontSize="11" textAnchor="end" x={LEFT - 9} y={y + 4}>{formatNumber(tick)} {unit}</text></g>;
}

function ProfileFact({ label, value }: { label: string; value: string }) {
  return <div><span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{label}</span><strong className="mt-1 block text-base font-semibold text-slate-950">{value}</strong></div>;
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded-full" style={{ backgroundColor: colour }} />{label}</span>;
}

function EmptyProfile() {
  return <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">No measured days match these filters.</div>;
}

function averageDayProfile(days: HeatmapDay[]) {
  const intervalCount = days[0]?.interval_demand.length ?? 0;
  const columns = Array.from({ length: intervalCount }, (_, index) => days.map((day) => day.interval_demand[index]).filter((value): value is number => value !== null));
  const average = columns.map((values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
  const p10 = columns.map((values) => percentile(values, 0.1));
  const p90 = columns.map((values) => percentile(values, 0.9));
  const maximumByInterval = columns.map((values) => values.length ? Math.max(...values) : null);
  return { average, p10, p90, maximumByInterval, globalMaximum: Math.max(0, ...days.flatMap((day) => day.interval_demand.filter((value): value is number => value !== null))) };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.round((ordered.length - 1) * ratio)]!;
}

function linePath(values: Array<number | null>, maximum: number) {
  return values.map((value, index) => value === null ? "" : `${index === 0 || values[index - 1] === null ? "M" : "L"}${profileX(index, values.length).toFixed(2)} ${demandY(value, maximum).toFixed(2)}`).join(" ");
}

function areaPath(upper: Array<number | null>, lower: Array<number | null>, maximum: number) {
  if (!upper.length || upper.some((value) => value === null) || lower.some((value) => value === null)) return "";
  const upperPoints = upper.map((value, index) => `${profileX(index, upper.length).toFixed(2)} ${demandY(value!, maximum).toFixed(2)}`);
  const lowerPoints = lower.map((value, index) => `${profileX(index, lower.length).toFixed(2)} ${demandY(value!, maximum).toFixed(2)}`).reverse();
  return `M${upperPoints.join(" L")} L${lowerPoints.join(" L")} Z`;
}

function annualLinePath(values: Array<number | null>, maximum: number) {
  return values.map((value, index) => value === null ? "" : `${index === 0 || values[index - 1] === null ? "M" : "L"}${annualX(index, values.length).toFixed(2)} ${demandY(value, maximum).toFixed(2)}`).join(" ");
}

function profileX(index: number, count: number) {
  return LEFT + (index / Math.max(1, count - 1)) * PLOT_WIDTH;
}

function annualX(index: number, count: number) {
  return LEFT + (index / Math.max(1, count - 1)) * PLOT_WIDTH;
}

function demandY(value: number, maximum: number) {
  return TOP + PLOT_HEIGHT - (value / Math.max(1, maximum)) * PLOT_HEIGHT;
}

function axisTicks(maximum: number) {
  return Array.from({ length: 5 }, (_, index) => (maximum / 4) * index);
}

function niceMaximum(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function daySummary(day: HeatmapDay) {
  const values = day.interval_demand.filter((value): value is number => value !== null);
  return values.length ? { minimum: Math.min(...values), maximum: Math.max(...values), average: values.reduce((total, value) => total + value, 0) / values.length } : { minimum: null, maximum: null, average: null };
}

function profileSummary(days: HeatmapDay[]) {
  const values = days.flatMap((day) => day.interval_demand.filter((value): value is number => value !== null));
  return values.length ? { average: values.reduce((total, value) => total + value, 0) / values.length, maximum: Math.max(...values) } : { average: null, maximum: null };
}

function evenlySample<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.floor((index * (items.length - 1)) / (limit - 1))]!);
}

function matchesDayFilter(date: string, filter: DayFilter) {
  if (filter === "all") return true;
  const day = weekday(date);
  return filter === "weekdays" ? day >= 1 && day <= 5 : day === 0 || day === 6;
}

function matchesSeason(date: string, season: SeasonFilter) {
  if (season === "whole_year") return true;
  const month = Number(date.slice(5, 7));
  if (season === "summer") return month === 12 || month <= 2;
  if (season === "autumn") return month >= 3 && month <= 5;
  if (season === "winter") return month >= 6 && month <= 8;
  return month >= 9 && month <= 11;
}

function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function monthMarkers(days: Array<{ date: string }>) {
  const markers: Array<{ index: number; label: string }> = [];
  let previousMonth = -1;
  days.forEach((day, index) => {
    const month = Number(day.date.slice(5, 7)) - 1;
    if (month !== previousMonth) markers.push({ index, label: MONTHS[month] ?? "" });
    previousMonth = month;
  });
  return markers;
}

function preferredYear(years: HeatmapYear[]) {
  return [...years].sort((left, right) => right.day_count - left.day_count || right.year - left.year)[0]!;
}

function downloadProfileCsv(days: HeatmapDay[], intervalMinutes: number, unit: Heatmap["unit"], year: number) {
  const rows = [["date", "interval_start", `measured_demand_${unit}`]];
  for (const day of days) day.interval_demand.forEach((value, index) => rows.push([day.date, intervalLabel(index, intervalMinutes), value === null ? "" : String(value)]));
  const blob = new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nem12-load-profile-${year}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function intervalLabel(index: number, intervalMinutes: number) {
  const totalMinutes = index * intervalMinutes;
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function formatMaybe(value: number | null, unit: Heatmap["unit"]) {
  return value === null ? "no reading" : `${formatNumber(value)} ${unit}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
}
