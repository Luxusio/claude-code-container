import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: string;
  path: string;
  name: string;
  addedAt: number;
}

interface PersistedState {
  projects?: Project[];
  expandedProjectIds?: string[];
}

function basenameOf(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

interface ProjectState {
  projects: Project[];
  expandedProjectIds: Set<string>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addProject: (path: string) => Project | null;
  removeProject: (id: string) => void;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  findByPath: (path: string) => Project | undefined;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(state: ProjectState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload: PersistedState = {
      projects: state.projects,
      expandedProjectIds: Array.from(state.expandedProjectIds),
    };
    invoke<void>("cmd_save_ui_state", { json: JSON.stringify(payload, null, 2) }).catch((e) =>
      console.error("[projects] save failed", e)
    );
  }, 200);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  expandedProjectIds: new Set(),
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await invoke<string>("cmd_load_ui_state");
      const parsed: PersistedState = raw ? JSON.parse(raw) : {};
      set({
        projects: parsed.projects ?? [],
        expandedProjectIds: new Set(parsed.expandedProjectIds ?? []),
        hydrated: true,
      });
    } catch (e) {
      console.error("[projects] hydrate failed", e);
      set({ hydrated: true });
    }
  },

  addProject: (path) => {
    const existing = get().projects.find((p) => p.path === path);
    if (existing) return existing;
    const project: Project = {
      id: crypto.randomUUID(),
      path,
      name: basenameOf(path) || path,
      addedAt: Date.now(),
    };
    set((state) => {
      const next = {
        ...state,
        projects: [...state.projects, project],
        expandedProjectIds: new Set([...state.expandedProjectIds, project.id]),
      };
      persist(next);
      return next;
    });
    return project;
  },

  removeProject: (id) => {
    set((state) => {
      const next = {
        ...state,
        projects: state.projects.filter((p) => p.id !== id),
        expandedProjectIds: new Set(
          [...state.expandedProjectIds].filter((x) => x !== id)
        ),
      };
      persist(next);
      return next;
    });
  },

  toggleExpanded: (id) => {
    set((state) => {
      const next = new Set(state.expandedProjectIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const merged = { ...state, expandedProjectIds: next };
      persist(merged);
      return merged;
    });
  },

  setExpanded: (id, expanded) => {
    set((state) => {
      const next = new Set(state.expandedProjectIds);
      if (expanded) next.add(id);
      else next.delete(id);
      const merged = { ...state, expandedProjectIds: next };
      persist(merged);
      return merged;
    });
  },

  findByPath: (path) => get().projects.find((p) => p.path === path),
}));
