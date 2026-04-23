import { useState } from "react";
import { SessionHistory } from "./SessionHistory";

interface SessionSidebarProps {
  projectPath: string | null;
  onNewSession?: () => void;
}

export function SessionSidebar({ projectPath, onNewSession }: SessionSidebarProps) {
  const [sessionsOpen, setSessionsOpen] = useState(true);

  return (
    <div className="sidebar session-sidebar">
      <div
        className="sidebar-section"
        style={{
          flex: 1,
          minHeight: 0,
        }}
      >
        <div
          className="sidebar-section-header"
          style={{ cursor: "pointer" }}
          onClick={() => setSessionsOpen((o) => !o)}
        >
          <span>Sessions</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {onNewSession && (
              <button
                className="sidebar-new-session-btn"
                onClick={(e) => { e.stopPropagation(); onNewSession(); }}
                title="New session"
              >
                +
              </button>
            )}
            <span className={`chevron${sessionsOpen ? " open" : ""}`}>›</span>
          </div>
        </div>
        {sessionsOpen && (
          <div className="sidebar-section-content">
            <SessionHistory projectPath={projectPath} />
          </div>
        )}
      </div>
    </div>
  );
}
