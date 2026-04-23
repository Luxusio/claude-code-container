import { useState, useCallback, useRef } from "react";
import { type PaneNode, useTabStore } from "../store/tabs";
import { useSessionStore } from "../store/sessions";
import { TabBar } from "./TabBar";
import { FileViewer } from "./FileViewer";
import { DiffViewer } from "./DiffViewer";
import { Terminal } from "./Terminal";

/* ── Resize Handle ──────────────────────────────────────────── */

function ResizeHandle({
  splitId,
  direction,
}: {
  splitId: string;
  direction: "horizontal" | "vertical";
}) {
  const setSplitRatio = useTabStore((s) => s.setSplitRatio);
  const handleRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const parent = handleRef.current?.parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();
      const isHoriz = direction === "horizontal";

      const onMove = (ev: MouseEvent) => {
        const pos = isHoriz ? ev.clientX - rect.left : ev.clientY - rect.top;
        const total = isHoriz ? rect.width : rect.height;
        const ratio = pos / total;
        setSplitRatio(splitId, ratio);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = isHoriz ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [direction, splitId, setSplitRatio]
  );

  return (
    <div
      ref={handleRef}
      className={`split-pane__handle`}
      onMouseDown={onMouseDown}
    />
  );
}

/* ── Leaf Pane ──────────────────────────────────────────────── */

function LeafPane({
  paneId,
  tabIds,
  activeTabId,
}: {
  paneId: string;
  tabIds: string[];
  activeTabId: string | null;
}) {
  const { tabs, splitPane, moveTab, setFocusedPane } = useTabStore();
  const sessions = useSessionStore((s) => s.sessions);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const activeTab = activeTabId ? tabs[activeTabId] ?? null : null;

  // Find sessions whose terminal tabs are in THIS pane
  const terminalSessionIds = new Set(
    tabIds
      .map((tid) => tabs[tid])
      .filter((t) => t?.kind === "terminal" && t.sessionId)
      .map((t) => t.sessionId!)
  );

  const activeTerminalSessionId =
    activeTab?.kind === "terminal" ? activeTab.sessionId : null;

  const handleContentDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    if (x < 0.2) setDropZone("left");
    else if (x > 0.8) setDropZone("right");
    else if (y < 0.2) setDropZone("top");
    else if (y > 0.8) setDropZone("bottom");
    else setDropZone("center");
  };

  const handleContentDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the actual container
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropZone(null);
      setIsDragOver(false);
    }
  };

  const handleContentDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData("tabId");
    const sourcePaneId = e.dataTransfer.getData("sourcePaneId");
    if (!tabId) {
      setDropZone(null);
      setIsDragOver(false);
      return;
    }

    if (dropZone === "center" || dropZone === null) {
      if (sourcePaneId !== paneId) {
        moveTab(tabId, sourcePaneId, paneId);
      }
    } else {
      const dir: "horizontal" | "vertical" =
        dropZone === "left" || dropZone === "right" ? "horizontal" : "vertical";
      // If the tab is from another pane, first move it here, then split
      // Actually splitPane handles removing from source pane already if
      // we first move it. Simpler: if from another pane, move then split.
      // But splitPane only splits within the pane. So we need to move first.
      if (sourcePaneId !== paneId) {
        // Move tab to this pane first
        moveTab(tabId, sourcePaneId, paneId);
      }
      // Now split this pane with the tab
      // We need a small delay because moveTab updates state
      // Actually we can call splitPane directly since moveTab is sync in zustand
      // But after moveTab, the paneId might have been collapsed.
      // Safer: do it in one shot by using the store directly
      splitPane(paneId, dir, tabId);
    }
    setDropZone(null);
    setIsDragOver(false);
  };

  return (
    <div
      className="leaf-pane"
      onClick={() => setFocusedPane(paneId)}
    >
      <TabBar paneId={paneId} tabIds={tabIds} activeTabId={activeTabId} />

      {/* Content area */}
      <div
        className="leaf-pane__content"
        onDragOver={handleContentDragOver}
        onDragLeave={handleContentDragLeave}
        onDrop={handleContentDrop}
      >
        {/* Empty state */}
        {tabIds.length === 0 && (
          <div className="leaf-pane__empty">
            No active tab
          </div>
        )}

        {/* File viewer for active file tab */}
        {activeTab?.kind === "file" && activeTab.filePath && (
          <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}>
            <FileViewer filePath={activeTab.filePath} />
          </div>
        )}

        {/* Diff viewer for active diff tab */}
        {activeTab?.kind === "diff" && activeTab.filePath && activeTab.projectPath && (
          <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}>
            <DiffViewer projectPath={activeTab.projectPath} filePath={activeTab.filePath} />
          </div>
        )}

        {/* Terminals — always mounted for sessions in this pane, toggled via display */}
        {sessions
          .filter((s) => !s.archived && terminalSessionIds.has(s.id))
          .map((session) => (
            <div
              key={session.id}
              style={{
                display:
                  session.id === activeTerminalSessionId ? "flex" : "none",
                width: "100%",
                flex: 1,
                minHeight: 0,
                flexDirection: "column",
              }}
            >
              <Terminal
                sessionId={session.id}
                projectPath={session.projectPath}
                continueSessionId={session.continueSessionId}
              />
            </div>
          ))}

        {/* Drop zone overlay */}
        {isDragOver && (
          <div className={`leaf-pane__drop-overlay active`}>
            <div
              className={`leaf-pane__drop-zone leaf-pane__drop-zone--left${
                dropZone === "left" ? " highlight" : ""
              }`}
            />
            <div
              className={`leaf-pane__drop-zone leaf-pane__drop-zone--right${
                dropZone === "right" ? " highlight" : ""
              }`}
            />
            <div
              className={`leaf-pane__drop-zone leaf-pane__drop-zone--top${
                dropZone === "top" ? " highlight" : ""
              }`}
            />
            <div
              className={`leaf-pane__drop-zone leaf-pane__drop-zone--bottom${
                dropZone === "bottom" ? " highlight" : ""
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── SplitPane (recursive) ──────────────────────────────────── */

export function SplitPane({ node }: { node: PaneNode }) {
  if (node.type === "leaf") {
    return (
      <LeafPane
        paneId={node.id}
        tabIds={node.tabIds}
        activeTabId={node.activeTabId}
      />
    );
  }

  const isHorizontal = node.direction === "horizontal";

  return (
    <div className={`split-pane split-pane--${node.direction}`}>
      <div
        className="split-pane__child"
        style={{ [isHorizontal ? "width" : "height"]: `${node.ratio * 100}%` }}
      >
        <SplitPane node={node.children[0]} />
      </div>
      <ResizeHandle splitId={node.id} direction={node.direction} />
      <div className="split-pane__child" style={{ flex: 1 }}>
        <SplitPane node={node.children[1]} />
      </div>
    </div>
  );
}
