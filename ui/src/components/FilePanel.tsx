import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTabStore } from "../store/tabs";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface ChangedFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  status: string;
  additions: number;
  deletions: number;
}

function getIcon(entry: FileEntry, expanded: boolean): string {
  if (entry.is_dir) return expanded ? "▾" : "▸";
  return "·";
}

function basename(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function breadcrumb(projectPath: string, currentPath: string): string {
  if (currentPath === projectPath) return basename(projectPath);
  const rel = currentPath.startsWith(projectPath)
    ? currentPath.slice(projectPath.length).replace(/^[\\/]/, "")
    : currentPath;
  return rel || basename(projectPath);
}

function relPath(projectPath: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = projectPath.replace(/\\/g, "/").replace(/\/?$/, "/");
  return normalized.startsWith(base) ? normalized.slice(base.length) : normalized;
}

function statusColor(status: string): string {
  const s = status.replace(/\s/g, "");
  if (s === "M" || s === "MM") return "var(--status-modified, #d4a017)";
  if (s === "A" || s === "AM") return "var(--status-added, #4caf50)";
  if (s === "D") return "var(--status-deleted, #f44336)";
  if (s === "??" || s === "?") return "var(--text-3)";
  if (s === "R" || s === "RM") return "var(--status-modified, #d4a017)";
  return "var(--text-3)";
}

function statusLabel(status: string): string {
  const s = status.replace(/\s/g, "");
  if (s.startsWith("M")) return "M";
  if (s.startsWith("A")) return "A";
  if (s.startsWith("D")) return "D";
  if (s.startsWith("R")) return "R";
  if (s === "??" || s === "?") return "?";
  return s.slice(0, 1) || "?";
}

function DiffStatBadge({ entry }: { entry: ChangedFileEntry }) {
  const hasAdd = entry.additions > 0;
  const hasDel = entry.deletions > 0;
  if (!hasAdd && !hasDel) return null;
  return (
    <span className="diff-stat" style={{ marginLeft: "auto" }}>
      {hasAdd && <span className="diff-add">+{entry.additions}</span>}
      {hasDel && <span className="diff-del">-{entry.deletions}</span>}
    </span>
  );
}

// ── Tree view node (All files mode) ─────────────────────────

interface FileNodeProps {
  entry: FileEntry;
  depth: number;
  showHidden: boolean;
  onFileClick: (path: string, name: string, pinned: boolean) => void;
}

function FileNode({ entry, depth, showHidden, onFileClick }: FileNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      const pinned = e.ctrlKey || e.metaKey;
      if (!entry.is_dir) {
        onFileClick(entry.path, entry.name, pinned);
        return;
      }
      if (expanded) {
        setExpanded(false);
        return;
      }
      try {
        const entries = await invoke<FileEntry[]>("cmd_list_files", {
          path: entry.path,
        });
        const filtered = showHidden
          ? entries
          : entries.filter((e) => !e.name.startsWith("."));
        setChildren(filtered);
        setExpanded(true);
      } catch (err) {
        console.error("Failed to list files:", err);
      }
    },
    [entry, expanded, showHidden, onFileClick]
  );

  const indent = depth * 10;

  return (
    <>
      <div
        className={`file-entry${entry.is_dir ? " is-dir" : ""}`}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={handleClick}
        title={entry.path}
      >
        <span className="icon">{getIcon(entry, expanded)}</span>
        <span className="name">{entry.name}</span>
      </div>
      {expanded &&
        children.map((child) => (
          <FileNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            showHidden={showHidden}
            onFileClick={onFileClick}
          />
        ))}
    </>
  );
}

// ── Changed files tree ────────────────────────────────────────

interface ChangedDirNode {
  dirName: string; // relative dir label, e.g. "src/components"
  files: ChangedFileEntry[];
}

function buildChangedTree(
  projectPath: string,
  entries: ChangedFileEntry[]
): { roots: ChangedFileEntry[]; dirs: ChangedDirNode[] } {
  const roots: ChangedFileEntry[] = [];
  const dirMap = new Map<string, ChangedFileEntry[]>();

  for (const entry of entries) {
    const rel = relPath(projectPath, entry.path);
    const slashIdx = rel.lastIndexOf("/");
    if (slashIdx === -1) {
      // file at project root
      roots.push(entry);
    } else {
      const dir = rel.slice(0, slashIdx);
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir)!.push(entry);
    }
  }

  const dirs: ChangedDirNode[] = Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirName, files]) => ({ dirName, files }));

  return { roots, dirs };
}

interface ChangedDirNodeProps {
  node: ChangedDirNode;
  onFileClick: (path: string, name: string, pinned: boolean) => void;
}

function ChangedDirNodeView({ node, onFileClick }: ChangedDirNodeProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <>
      <div
        className="file-entry is-dir"
        style={{ paddingLeft: "8px" }}
        onClick={() => setExpanded((v) => !v)}
        title={node.dirName}
      >
        <span className="icon">{expanded ? "▾" : "▸"}</span>
        <span className="name">{node.dirName}</span>
      </div>
      {expanded &&
        node.files.map((f) => (
          <div
            key={f.path}
            className="file-entry"
            style={{ paddingLeft: "22px" }}
            title={f.path}
            onClick={(e) => onFileClick(f.path, f.name, e.ctrlKey || e.metaKey)}
          >
            <span className="icon">·</span>
            <span className="name">{f.name}</span>
            <DiffStatBadge entry={f} />
          </div>
        ))}
    </>
  );
}

// ── FilePanel ────────────────────────────────────────────────

interface FilePanelProps {
  projectPath: string | null;
}

export function FilePanel({ projectPath }: FilePanelProps) {
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [showHidden, setShowHidden] = useState(false);
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [flatEntries, setFlatEntries] = useState<FileEntry[]>([]);
  const [changedEntries, setChangedEntries] = useState<ChangedFileEntry[]>([]);
  const { openTab } = useTabStore();

  // When "All files" is checked, force tree view (flat backend skips hidden)
  const handleShowHiddenChange = (checked: boolean) => {
    setShowHidden(checked);
    if (checked) {
      setViewMode("tree");
    }
  };

  // Changed files (default / not showHidden)
  useEffect(() => {
    if (!projectPath || showHidden) {
      setChangedEntries([]);
      return;
    }
    invoke<ChangedFileEntry[]>("cmd_list_changed_files", { path: projectPath })
      .then(setChangedEntries)
      .catch((err) => {
        // Not a git repo or git not available — silently show empty
        console.warn("cmd_list_changed_files:", err);
        setChangedEntries([]);
      });
  }, [projectPath, showHidden]);

  // Load tree root entries (only when showHidden / All files mode)
  useEffect(() => {
    if (!projectPath || !showHidden) {
      setTreeEntries([]);
      return;
    }
    invoke<FileEntry[]>("cmd_list_files", { path: projectPath })
      .then((entries) => setTreeEntries(entries))
      .catch(console.error);
  }, [projectPath, showHidden]);

  // Load flat entries when switching to flat mode (only in default/changed mode)
  useEffect(() => {
    if (viewMode !== "flat" || !projectPath || showHidden) {
      setFlatEntries([]);
      return;
    }
    // flat view in changed-files mode just uses changedEntries directly
    setFlatEntries([]);
  }, [viewMode, projectPath, showHidden]);

  const handleFileClick = useCallback(
    (filePath: string, name: string, pinned: boolean) => {
      openTab({ kind: "file", label: name, filePath }, pinned);
    },
    [openTab]
  );

  const handleDiffClick = useCallback(
    (filePath: string, name: string, pinned: boolean) => {
      if (!projectPath) return;
      openTab({ kind: "diff", label: `Δ ${name}`, filePath, projectPath }, pinned);
    },
    [openTab, projectPath]
  );

  if (!projectPath) {
    return (
      <div className="file-panel">
        <div className="file-panel__empty">No project open</div>
      </div>
    );
  }

  const changedTree =
    !showHidden && viewMode === "tree"
      ? buildChangedTree(projectPath, changedEntries)
      : null;

  return (
    <div className="file-panel">
      {/* Header */}
      <div className="file-panel__header">
        <span className="file-panel__breadcrumb" title={projectPath}>
          {breadcrumb(projectPath, projectPath)}
        </span>
      </div>

      {/* Toolbar */}
      <div className="file-panel__toolbar">
        <div className="file-panel__view-toggle">
          <button
            className={`file-panel__toggle-btn${viewMode === "flat" ? " active" : ""}${showHidden ? " disabled" : ""}`}
            onClick={() => {
              if (!showHidden) setViewMode("flat");
            }}
            title={
              showHidden
                ? "Flat view unavailable when showing all files"
                : "Flat view"
            }
            disabled={showHidden}
          >
            Flat
          </button>
          <button
            className={`file-panel__toggle-btn${viewMode === "tree" ? " active" : ""}`}
            onClick={() => setViewMode("tree")}
            title="Tree view"
          >
            Tree
          </button>
        </div>
        <label className="file-panel__show-hidden">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => handleShowHiddenChange(e.target.checked)}
          />
          <span>All files</span>
        </label>
      </div>

      {/* File list */}
      <div className="file-panel__content">
        {showHidden ? (
          /* All files mode — full tree */
          <div className="file-browser">
            {treeEntries.length === 0 ? (
              <div className="file-browser-empty">No files</div>
            ) : (
              treeEntries.map((entry) => (
                <FileNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  showHidden={showHidden}
                  onFileClick={handleFileClick}
                />
              ))
            )}
          </div>
        ) : viewMode === "tree" ? (
          /* Default tree — changed files grouped by directory */
          <div className="file-browser">
            {changedEntries.length === 0 ? (
              <div className="file-browser-empty">No changed files</div>
            ) : (
              <>
                {changedTree!.roots.map((f) => (
                  <div
                    key={f.path}
                    className="file-entry"
                    style={{ paddingLeft: "8px" }}
                    title={f.path}
                    onClick={(e) =>
                      handleDiffClick(f.path, f.name, e.ctrlKey || e.metaKey)
                    }
                  >
                    <span className="icon">·</span>
                    <span className="name">{f.name}</span>
                    <DiffStatBadge entry={f} />
                  </div>
                ))}
                {changedTree!.dirs.map((node) => (
                  <ChangedDirNodeView
                    key={node.dirName}
                    node={node}
                    onFileClick={handleDiffClick}
                  />
                ))}
              </>
            )}
          </div>
        ) : (
          /* Default flat — changed files flat list */
          <div className="file-browser">
            {changedEntries.length === 0 ? (
              <div className="file-browser-empty">No changed files</div>
            ) : (
              changedEntries.map((entry) => (
                <div
                  key={entry.path}
                  className="file-entry"
                  style={{ paddingLeft: "8px" }}
                  title={entry.path}
                  onClick={(e) =>
                    handleDiffClick(
                      entry.path,
                      entry.name,
                      e.ctrlKey || e.metaKey
                    )
                  }
                >
                  <span className="icon">·</span>
                  <span className="name">{entry.name}</span>
                  <DiffStatBadge entry={entry} />
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
