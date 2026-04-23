import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionHistory, type HistorySession } from "../hooks/useSessionHistory";
import { useSessionStore } from "../store/sessions";
import { useTabStore } from "../store/tabs";

interface DiffStat {
  additions: number;
  deletions: number;
}

function formatTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts.slice(0, 10);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return ts.slice(0, 10);
  }
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string;
  projectPath: string;
}

interface SessionHistoryProps {
  projectPath?: string | null;
}

export function SessionHistory({ projectPath }: SessionHistoryProps = {}) {
  const [activeTab, setActiveTab] = useState<"active" | "archive">("active");
  const { sessions, archiveSession, unarchiveSession } = useSessionHistory(projectPath);
  const { sessions: storeSessions, activeSessionId, addSession, setActiveSession } = useSessionStore();
  const { openTab } = useTabStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [diffStat, setDiffStat] = useState<DiffStat | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setDiffStat(null);
      return;
    }
    invoke<DiffStat>("cmd_worktree_diff_stat", { path: projectPath })
      .then(setDiffStat)
      .catch(() => setDiffStat(null));
  }, [projectPath]);

  // Backend already scopes to the bound project; just split by archived flag
  const activeSessions = sessions.filter((s) => !s.archived);
  const archivedSessions = sessions.filter((s) => s.archived);

  // Live in-memory sessions for this project that haven't produced a jsonl yet
  // — count them under "Active" so the sidebar reflects reality.
  const liveForProject = projectPath
    ? storeSessions.filter(
        (s) =>
          s.projectPath === projectPath &&
          !s.archived &&
          !sessions.some((h) => h.id === s.continueSessionId),
      )
    : [];
  const activeCount = activeSessions.length + liveForProject.length;

  // Only create session record — Terminal component owns PTY lifecycle
  const handleRestore = (sessionId: string, projectPath: string, pinned = false) => {
    const newId = crypto.randomUUID();
    const label = shortPath(projectPath) || "Restored";
    addSession({
      id: newId,
      projectPath,
      title: label,
      archived: false,
      createdAt: Date.now(),
      continueSessionId: sessionId,
    });
    openTab({ kind: "terminal", label, sessionId: newId }, pinned);
  };

  const closeMenu = () => setContextMenu(null);

  // Close menu on outside click, Escape, scroll, or window blur
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const handleScroll = () => closeMenu();
    const handleBlur = () => closeMenu();

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [contextMenu]);

  const handleContextMenu = (
    e: React.MouseEvent,
    session: HistorySession
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sessionId: session.id,
      projectPath: session.project_path,
    });
  };

  const handleRowClick = (e: React.MouseEvent, session: HistorySession) => {
    // Ignore right-clicks
    if (e.button !== 0) return;
    const pinned = e.ctrlKey || e.metaKey;
    // If this session is already open in the store, just switch to it
    const existing = storeSessions.find((s) => s.continueSessionId === session.id);
    if (existing) {
      setActiveSession(existing.id);
      openTab(
        { kind: "terminal", label: existing.title || shortPath(existing.projectPath) || "Session", sessionId: existing.id },
        pinned
      );
    } else {
      handleRestore(session.id, session.project_path, pinned);
    }
  };

  const handleContextMenuAction = async () => {
    if (!contextMenu) return;
    if (activeTab === "active") {
      await archiveSession(contextMenu.sessionId);
    } else {
      await unarchiveSession(contextMenu.sessionId);
    }
    closeMenu();
  };

  const displayed = activeTab === "active" ? activeSessions : archivedSessions;

  return (
    <div className="session-history">
      <div className="session-tabs">
        <button
          className={`session-tab-btn${activeTab === "active" ? " active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active ({activeCount})
        </button>
        <button
          className={`session-tab-btn${activeTab === "archive" ? " active" : ""}`}
          onClick={() => setActiveTab("archive")}
        >
          Archive ({archivedSessions.length})
        </button>
      </div>

      <div className="session-list">
        {activeTab === "active" &&
          liveForProject.map((s) => (
            <div
              key={s.id}
              className={`session-item session-item--live${s.id === activeSessionId ? " active" : " open"}`}
              onClick={() => setActiveSession(s.id)}
              title="Live session (not yet persisted)"
            >
              <div className="session-item__path">
                {s.title || shortPath(s.projectPath)}
                <span className="session-item__branch-tag">live</span>
              </div>
            </div>
          ))}
        {displayed.length === 0 && liveForProject.length === 0 ? (
          <div className="session-empty">No sessions</div>
        ) : (
          displayed.map((session) => {
            const isOpen = storeSessions.some((s) => s.continueSessionId === session.id);
            const isActive = storeSessions.some(
              (s) => s.continueSessionId === session.id && s.id === activeSessionId
            );
            return (
            <div
              key={session.id}
              className={`session-item${isActive ? " active" : isOpen ? " open" : ""}`}
              onClick={(e) => handleRowClick(e, session)}
              onContextMenu={(e) => handleContextMenu(e, session)}
            >
              <div className="session-item__path" title={session.project_path}>
                {shortPath(session.project_path)}
                {session.worktree_branch && (
                  <span
                    className="session-item__branch-tag"
                    title={`worktree: ${session.worktree_branch}`}
                  >
                    {session.worktree_branch}
                  </span>
                )}
              </div>

              <div className="session-item__footer">
                <span className="session-item__time">{formatTime(session.timestamp)}</span>
              </div>

              {session.summary && (
                <div className="session-item__summary" title={session.summary}>
                  {session.summary}
                </div>
              )}
            </div>
            );
          })
        )}
      </div>

      {/* Floating context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div
            className="session-context-menu__item"
            onClick={handleContextMenuAction}
          >
            {activeTab === "active" ? "Archive" : "Restore"}
          </div>
        </div>
      )}
    </div>
  );
}
