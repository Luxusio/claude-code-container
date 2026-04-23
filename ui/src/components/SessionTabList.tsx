import { useSessionStore } from "../store/sessions";
import { usePty } from "../hooks/usePty";

const STATUS_LABEL: Record<string, string> = {
  idle: "대기",
  in_progress: "진행중",
  permission_request: "권한 요청",
  completed: "작업 완료",
};

const STATUS_COLOR: Record<string, string> = {
  idle: "var(--text-3)",
  in_progress: "var(--accent)",
  permission_request: "var(--yellow)",
  completed: "var(--green)",
};

export function SessionTabList() {
  const { sessions, activeSessionId, setActiveSession, removeSession } = useSessionStore();
  const { closePty } = usePty();

  const activeSessions = sessions.filter((s) => !s.archived);

  const handleClose = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try { await closePty(id); } catch { /* already closed */ }
    removeSession(id);
  };

  if (activeSessions.length === 0) {
    return <div className="session-tab-list session-tab-list--empty">No active sessions</div>;
  }

  return (
    <ul className="session-tab-list">
      {activeSessions.map((s) => {
        const status = s.status ?? "idle";
        return (
          <li
            key={s.id}
            className={`session-tab-list__item${activeSessionId === s.id ? " active" : ""}`}
            onClick={() => setActiveSession(s.id)}
            title={`${s.projectPath} — ${STATUS_LABEL[status] ?? status}`}
          >
            <span
              className="session-tab-list__dot"
              style={{ background: STATUS_COLOR[status] ?? "var(--text-3)" }}
              aria-label={STATUS_LABEL[status]}
            />
            <span className="session-tab-list__label">{s.title}</span>
            <button
              className="session-tab-list__close"
              onClick={(e) => handleClose(e, s.id)}
              aria-label="Close session"
            >
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}
