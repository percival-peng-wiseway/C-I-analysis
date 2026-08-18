import type { ReactNode } from "react";
import {
  BatteryCharging,
  BookOpenCheck,
  Building2,
  DatabaseZap,
  CircleDollarSign,
  LayoutDashboard,
  ShieldCheck,
  SunMedium,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { useCiWorkspace, type CiWorkspaceStage } from "./ci-workspace-context";

const modules: Array<{ stage: CiWorkspaceStage; label: string; icon: typeof LayoutDashboard }> = [
  { stage: "overview", label: "Project overview", icon: LayoutDashboard },
  { stage: "setup", label: "Setup & catalog", icon: DatabaseZap },
  { stage: "system_design", label: "System design", icon: SunMedium },
  { stage: "financial_simulation", label: "Annual finance", icon: CircleDollarSign },
];

export function CiProductShell({ children }: { children: ReactNode }) {
  const workspace = useCiWorkspace();
  return (
    <div className="ci-app min-h-screen bg-slate-50 text-slate-950">
      <header className="ci-app-header border-b border-white/10 bg-[#071525] text-white">
        <div className="mx-auto flex max-w-[1720px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link className="flex items-center gap-3" onClick={workspace.openOverview} to="/">
            <span className="relative grid size-10 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-cyan-300 to-emerald-300 text-slate-950 shadow-lg shadow-cyan-950/30">
              <Building2 className="size-4" />
              <BatteryCharging className="absolute -bottom-1 -right-1 size-4 rounded-full bg-[#071525] p-0.5 text-cyan-200" />
            </span>
            <span><span className="block text-sm font-semibold tracking-wide">E3 C&amp;I Analyzer</span><span className="block text-xs text-slate-400">Project feasibility studio</span></span>
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 sm:inline-flex"><BookOpenCheck className="size-3.5 text-cyan-200" />Python calculation authority</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100"><ShieldCheck className="size-3.5" />Internal review</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-w-0 grid-cols-[minmax(0,1fr)] max-w-[1720px] lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-white lg:min-h-[calc(100vh-65px)] lg:border-b-0 lg:border-r">
          <div className="border-b border-slate-200 px-5 py-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Active project</p>
            <p className="mt-2 truncate text-sm font-semibold">{workspace.activeProject?.displayName ?? "No project selected"}</p>
            <p className="mt-1 text-xs text-slate-500">Files and results are saved locally</p>
          </div>
          <nav aria-label="C&I workspace" className="flex gap-1 overflow-x-auto p-3 lg:block lg:space-y-1 lg:overflow-visible lg:p-4">
            {modules.map((module, index) => {
              const Icon = module.icon;
              const disabled = module.stage !== "overview" && (
                !workspace.activeProject ||
                (module.stage === "system_design" && !workspace.activeProject.setupReady) ||
                (module.stage === "financial_simulation" && !workspace.activeProject.designReady)
              );
              return (
                <button
                  aria-current={workspace.stage === module.stage ? "page" : undefined}
                  className="ci-module-link group flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium lg:w-full"
                  disabled={disabled}
                  key={module.stage}
                  onClick={() => workspace.setStage(module.stage)}
                  type="button"
                >
                  <span className="grid size-7 place-items-center rounded-lg bg-slate-100 text-slate-500"><Icon className="size-3.5" /></span>
                  <span>{module.label}</span><span className="ml-auto hidden text-[10px] tabular-nums text-slate-300 lg:inline">0{index + 1}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
