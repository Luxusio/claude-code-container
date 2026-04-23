import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "cmd_load_ui_state") return "";
    if (cmd === "cmd_save_ui_state") return undefined;
    throw new Error(`unexpected invoke: ${cmd}`);
  }),
}));

import { useProjectStore } from "../projects";

function reset() {
  useProjectStore.setState({
    projects: [],
    expandedProjectIds: new Set(),
    hydrated: false,
  });
}

describe("projects store", () => {
  beforeEach(reset);

  it("addProject de-duplicates by path", () => {
    const a = useProjectStore.getState().addProject("/x/proj");
    const b = useProjectStore.getState().addProject("/x/proj");
    expect(a).not.toBeNull();
    expect(b?.id).toBe(a?.id);
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it("addProject derives name from basename and marks it expanded", () => {
    const p = useProjectStore.getState().addProject("/root/my-app/");
    expect(p?.name).toBe("my-app");
    expect(useProjectStore.getState().expandedProjectIds.has(p!.id)).toBe(true);
  });

  it("removeProject removes the project and its expanded flag", () => {
    const p = useProjectStore.getState().addProject("/x/proj")!;
    useProjectStore.getState().removeProject(p.id);
    const st = useProjectStore.getState();
    expect(st.projects).toHaveLength(0);
    expect(st.expandedProjectIds.has(p.id)).toBe(false);
  });

  it("toggleExpanded flips membership", () => {
    const p = useProjectStore.getState().addProject("/x/proj")!;
    useProjectStore.getState().toggleExpanded(p.id);
    expect(useProjectStore.getState().expandedProjectIds.has(p.id)).toBe(false);
    useProjectStore.getState().toggleExpanded(p.id);
    expect(useProjectStore.getState().expandedProjectIds.has(p.id)).toBe(true);
  });

  it("findByPath returns the matching project", () => {
    const p = useProjectStore.getState().addProject("/x/proj")!;
    expect(useProjectStore.getState().findByPath("/x/proj")?.id).toBe(p.id);
    expect(useProjectStore.getState().findByPath("/nope")).toBeUndefined();
  });
});
