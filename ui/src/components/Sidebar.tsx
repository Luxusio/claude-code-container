import { useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { SessionHistory } from "./SessionHistory";

interface SidebarProps {
  projectPath: string | null;
  onNewSession?: () => void;
}

export function Sidebar({ projectPath, onNewSession }: SidebarProps) {
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);

  return (
    <div className="sidebar">
      {/* Sessions section (top) — fixed height when open */}
      <div
        className="sidebar-section"
        style={{
          flexShrink: 0,
          height: sessionsOpen ? 230 : "auto",
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

      {/* Explorer section (bottom) — grows to fill remaining space */}
      <div className="sidebar-section grow">
        <div
          className="sidebar-section-header"
          style={{ cursor: "pointer" }}
          onClick={() => setExplorerOpen((o) => !o)}
        >
          <span>Explorer</span>
          <span className={`chevron${explorerOpen ? " open" : ""}`}>›</span>
        </div>
        {explorerOpen && (
          <div className="sidebar-section-content">
            <FileBrowser projectPath={projectPath} />
          </div>
        )}
      </div>
    </div>
  );
}
