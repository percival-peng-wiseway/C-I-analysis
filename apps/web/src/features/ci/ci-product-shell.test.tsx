// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCiProject, listCiProjects, deleteCiProject, restoreCiProject, type CiProject } from "./api/ci-projects";
import { CiProductShell } from "./ci-product-shell";
import { CiWorkspaceProvider, useCiWorkspace } from "./ci-workspace-context";

vi.mock("./api/ci-projects", () => ({
  ciProjectsQueryKey: ["ci-projects"],
  ciDeletedProjectsQueryKey: ["ci-deleted-projects"],
  deleteCiProject: vi.fn(),
  restoreCiProject: vi.fn(),
  listCiProjects: vi.fn(),
  createCiProject: vi.fn(),
}));

vi.mock("./ci-settings-panel", () => ({
  CiSettingsPanel: ({ onClose }: { onClose: () => void }) => <div aria-label="Settings" role="dialog"><button onClick={onClose} type="button">Close settings</button></div>,
}));

const project: CiProject = {
  project_id: "shell-demo-1",
  display_name: "Warehouse North",
  current_stage: "system_design",
  setup_status: "ready",
  design_status: "ready",
  design_candidate_count: 6,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
const otherProject: CiProject = { ...project, project_id: "shell-demo-2", display_name: "Factory South", design_candidate_count: 2 };

function WorkspaceProbe() {
  const workspace = useCiWorkspace();
  return <main id="analysis-content"><output aria-label="Current workspace">{workspace.activeProject?.displayName} / {workspace.stage}</output></main>;
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(<QueryClientProvider client={queryClient}><CiWorkspaceProvider><CiProductShell><WorkspaceProbe /></CiProductShell></CiWorkspaceProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(listCiProjects).mockResolvedValue([project, otherProject]);
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.resetAllMocks(); });

describe("C&I application navigation", () => {
  it("confirms recoverable deletion, switches away from the deleted project and restores it", async () => {
    const user = userEvent.setup();
    let trashed = false;
    vi.mocked(listCiProjects).mockImplementation(async (_fetcher, deletedOnly) => deletedOnly ? (trashed ? [project] : []) : [project, otherProject]);
    vi.mocked(deleteCiProject).mockImplementation(async () => { trashed = true; });
    vi.mocked(restoreCiProject).mockImplementation(async () => { trashed = false; return project; });
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByLabelText("Switch project"));
    await user.click(screen.getByRole("button", { name: "Delete project Warehouse North" }));
    expect(deleteCiProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(deleteCiProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete project Warehouse North" }));
    await user.click(screen.getByRole("button", { name: "Move to deleted" }));
    await screen.findByRole("heading", { name: "Factory South" });
    expect(screen.queryByRole("button", { name: "Open project Warehouse North" })).toBeNull();
    expect(deleteCiProject).toHaveBeenCalledWith("shell-demo-1");
    await user.click(screen.getByRole("button", { name: /^Deleted$/ }));
    await user.click(await screen.findByRole("button", { name: "Restore project Warehouse North" }));
    await waitFor(() => expect(restoreCiProject).toHaveBeenCalledWith("shell-demo-1"));
    await user.click(screen.getByRole("button", { name: /^Projects$/ }));
    await screen.findByRole("button", { name: "Open project Warehouse North" });
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Factory South / evidence");
  });

  it("clears the active workspace and its stored selection when the last project is deleted", async () => {
    vi.mocked(listCiProjects).mockResolvedValue([project]);
    vi.mocked(deleteCiProject).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByLabelText("Switch project"));
    await user.click(screen.getByRole("button", { name: "Delete project Warehouse North" }));
    await user.click(screen.getByRole("button", { name: "Move to deleted" }));
    await screen.findByRole("heading", { name: "Select or create a project" });
    expect(window.sessionStorage.getItem("e3-ci-active-workspace-v1")).toBeNull();
    expect(screen.getByRole("button", { name: "Solution Generator" })).toHaveProperty("disabled", true);
  });

  it("keeps the project visible if deletion fails", async () => {
    vi.mocked(deleteCiProject).mockRejectedValue(new Error("Server unavailable"));
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByLabelText("Switch project"));
    await user.click(screen.getByRole("button", { name: "Delete project Warehouse North" }));
    await user.click(screen.getByRole("button", { name: "Move to deleted" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Server unavailable");
    expect(screen.getByRole("button", { name: "Open project Warehouse North" })).toBeTruthy();
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Warehouse North / evidence");
  });

  it("shows a compact workflow navigation and actual saved project counts", async () => {
    renderShell();
    expect(await screen.findByRole("heading", { name: "Warehouse North" })).toBeTruthy();
    const modules = screen.getByRole("navigation", { name: "Analysis modules" });
    expect(within(modules).getAllByRole("button")).toHaveLength(4);
    expect(within(modules).getByRole("button", { name: "Evidence" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("6 saved solutions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open project calculation Handbook" })).toBeTruthy();
  });

  it("filters projects locally without switching the active project or fetching again", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByLabelText("Switch project"));
    await user.type(screen.getByRole("searchbox", { name: "Find a project" }), "south");
    expect(screen.queryByRole("button", { name: "Open project Warehouse North" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open project Factory South" })).toBeTruthy();
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Warehouse North / evidence");
    await user.clear(screen.getByRole("searchbox", { name: "Find a project" }));
    await user.type(screen.getByRole("searchbox", { name: "Find a project" }), "missing");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("No projects match");
    await user.click(screen.getByRole("button", { name: "Clear project filter" }));
    expect(screen.getByRole("button", { name: "Open project Warehouse North" })).toBeTruthy();
    expect(listCiProjects).toHaveBeenCalledTimes(1);
    expect(createCiProject).not.toHaveBeenCalled();
  });

  it("switches modules and returns to Evidence from the brand without reloading the registry", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Warehouse North / dispatch");
    expect(screen.getByRole("button", { name: "Scenario Analysis" }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "E3 C&I Analyzer" }));
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Warehouse North / evidence");
    expect(listCiProjects).toHaveBeenCalledTimes(1);
    expect(createCiProject).not.toHaveBeenCalled();
  });

  it("creates a project through the registry and clears its previous filter", async () => {
    const user = userEvent.setup();
    vi.mocked(createCiProject).mockResolvedValue({ ...project, project_id: "shell-demo-new", display_name: "New depot", design_candidate_count: 0, setup_status: "input_required", design_status: "input_required" });
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByLabelText("Switch project"));
    await user.type(screen.getByRole("searchbox", { name: "Find a project" }), "north");
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Project name"), "  New depot  ");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("heading", { name: "New depot" })).toBeTruthy();
    expect(createCiProject).toHaveBeenCalledWith("New depot");
    await user.click(screen.getByLabelText("Switch project"));
    expect((screen.getByRole("searchbox", { name: "Find a project" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Current workspace").textContent).toBe("New depot / evidence");
  });

  it("opens Settings without changing the selected module", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole("heading", { name: "Warehouse North" });
    await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Warehouse North / tariff_replay");
  });
});
