import { create } from "zustand";

export type SessionStatus = 'idle' | 'in_progress' | 'permission_request' | 'completed';

export interface Session {
  id: string;
  projectPath: string;
  title: string;
  archived: boolean;
  createdAt: number;
  /** If set, Terminal will call ccc --continue <continueSessionId> */
  continueSessionId?: string;
  /** Live status derived from jsonl event stream */
  status?: SessionStatus;
}

interface SessionState {
  sessions: Session[];
  activeSessionId: string | null;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  removeSessionsForProject: (projectPath: string) => string[];
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    })),

  removeSession: (id) =>
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id);
      const newActive =
        state.activeSessionId === id
          ? remaining.length > 0
            ? remaining[remaining.length - 1].id
            : null
          : state.activeSessionId;
      return { sessions: remaining, activeSessionId: newActive };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  archiveSession: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, archived: true } : s
      ),
    })),

  unarchiveSession: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, archived: false } : s
      ),
    })),

  setSessionStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status } : s
      ),
    })),

  removeSessionsForProject: (projectPath) => {
    const ids = get().sessions.filter((s) => s.projectPath === projectPath).map((s) => s.id);
    set((state) => {
      const remaining = state.sessions.filter((s) => s.projectPath !== projectPath);
      const stillActive =
        state.activeSessionId && remaining.some((s) => s.id === state.activeSessionId)
          ? state.activeSessionId
          : remaining.length > 0
            ? remaining[remaining.length - 1].id
            : null;
      return { sessions: remaining, activeSessionId: stillActive };
    });
    return ids;
  },
}));

/** Resolve the active session's project path, or null if no session is active. */
export function useActiveProjectPath(): string | null {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  if (!activeId) return null;
  return sessions.find((s) => s.id === activeId)?.projectPath ?? null;
}
