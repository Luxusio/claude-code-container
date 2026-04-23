import { useState } from "react";
import { useTabStore } from "../store/tabs";

export function TabBar({
  paneId,
  tabIds,
  activeTabId,
}: {
  paneId: string;
  tabIds: string[];
  activeTabId: string | null;
}) {
  const { tabs, setActiveTab, closeTab, pinTab, reorderTab, moveTab, setFocusedPane } =
    useTabStore();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  if (tabIds.length === 0) return null;

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData("tabId", tabId);
    e.dataTransfer.setData("sourcePaneId", paneId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingTabId(tabId);
  };

  const handleDragEnd = () => {
    setDraggingTabId(null);
    setDropIndex(null);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };

  const handleDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const tabId = e.dataTransfer.getData("tabId");
    const sourcePaneId = e.dataTransfer.getData("sourcePaneId");
    if (!tabId) return;

    if (sourcePaneId === paneId) {
      const fromIdx = tabIds.indexOf(tabId);
      if (fromIdx !== -1 && fromIdx !== dropIdx) {
        reorderTab(paneId, fromIdx, dropIdx);
      }
    } else {
      moveTab(tabId, sourcePaneId, paneId, dropIdx);
    }
    setDropIndex(null);
    setDraggingTabId(null);
  };

  const handleBarDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // If dragging past the end, set drop index to the end
    setDropIndex(tabIds.length);
  };

  const handleBarDrop = (e: React.DragEvent) => {
    handleDrop(e, tabIds.length);
  };

  return (
    <div
      className="tab-bar"
      onDragOver={handleBarDragOver}
      onDrop={handleBarDrop}
      onDragLeave={() => setDropIndex(null)}
      onClick={() => setFocusedPane(paneId)}
    >
      {tabIds.map((tabId, index) => {
        const tab = tabs[tabId];
        if (!tab) return null;

        const isActive = tabId === activeTabId;
        const isDragging = tabId === draggingTabId;
        const classNames = [
          "tab-bar__tab",
          isActive ? "tab-bar__tab--active" : "",
          !tab.pinned ? "tab-bar__tab--preview" : "",
          isDragging ? "tab-bar__tab--dragging" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div key={tabId} style={{ display: "flex", alignItems: "stretch" }}>
            {dropIndex === index && (
              <div className="tab-bar__drop-indicator" />
            )}
            <div
              className={classNames}
              draggable
              onDragStart={(e) => handleDragStart(e, tabId)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onClick={() => setActiveTab(paneId, tabId)}
              onDoubleClick={() => {
                if (!tab.pinned) pinTab(tabId);
              }}
              title={tab.filePath ?? tab.label}
            >
              <span className="tab-bar__tab-icon">
                {tab.kind === "terminal" ? "\u2328" : "\uD83D\uDCC4"}
              </span>
              <span className="tab-bar__tab-label">{tab.label}</span>
              <button
                className="tab-bar__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tabId);
                }}
                title="Close tab"
              >
                x
              </button>
            </div>
          </div>
        );
      })}
      {dropIndex === tabIds.length && (
        <div className="tab-bar__drop-indicator" />
      )}
    </div>
  );
}
