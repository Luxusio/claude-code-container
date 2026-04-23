import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore, type Session } from "../sessions";

function reset() {
  useSessionStore.setState({ sessions: [], activeSessionId: null });
}

function make(id: string, projectPath = "/proj", overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectPath,
    title: `s-${id}`,
    archived: false,
    createdAt: 0,
    ...overrides,
  };
}

describe("sessions store", () => {
  beforeEach(reset);

  it("addSession sets the new id as active", () => {
    useSessionStore.getState().addSession(make("a"));
    useSessionStore.getState().addSession(make("b"));
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(useSessionStore.getState().activeSessionId).toBe("b");
  });

  it("removeSession falls back to the last remaining session as active", () => {
    const s = useSessionStore.getState();
    s.addSession(make("a"));
    s.addSession(make("b"));
    s.addSession(make("c"));
    s.removeSession("c");
    expect(useSessionStore.getState().activeSessionId).toBe("b");
    s.removeSession("a");
    expect(useSessionStore.getState().activeSessionId).toBe("b");
    s.removeSession("b");
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it("setSessionStatus updates only the target session", () => {
    const s = useSessionStore.getState();
    s.addSession(make("a"));
    s.addSession(make("b"));
    s.setSessionStatus("a", "in_progress");
    const bs = useSessionStore.getState().sessions;
    expect(bs.find((x) => x.id === "a")?.status).toBe("in_progress");
    expect(bs.find((x) => x.id === "b")?.status).toBeUndefined();
  });

  it("archive/unarchive flips the flag", () => {
    const s = useSessionStore.getState();
    s.addSession(make("a"));
    s.archiveSession("a");
    expect(useSessionStore.getState().sessions[0].archived).toBe(true);
    s.unarchiveSession("a");
    expect(useSessionStore.getState().sessions[0].archived).toBe(false);
  });

  it("removeSessionsForProject removes matching sessions and returns their ids", () => {
    const s = useSessionStore.getState();
    s.addSession(make("a", "/p1"));
    s.addSession(make("b", "/p2"));
    s.addSession(make("c", "/p1"));
    const removed = s.removeSessionsForProject("/p1");
    expect(new Set(removed)).toEqual(new Set(["a", "c"]));
    const state = useSessionStore.getState();
    expect(state.sessions.map((x) => x.id)).toEqual(["b"]);
    expect(state.activeSessionId).toBe("b");
  });
});
