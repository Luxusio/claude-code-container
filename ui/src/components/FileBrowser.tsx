import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

function getIcon(entry: FileEntry, expanded: boolean): string {
  if (entry.is_dir) return expanded ? "▾" : "▸";
  // File type icons via unicode
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs"].includes(ext)) return "·";
  if (["rs", "toml"].includes(ext)) return "·";
  if (["json", "yaml", "yml"].includes(ext)) return "·";
  if (["md", "txt"].includes(ext)) return "·";
  if (entry.name.startsWith(".")) return "·";
  return "·";
}

interface FileNodeProps {
  entry: FileEntry;
  depth: number;
}

function FileNode({ entry, depth }: FileNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const handleClick = useCallback(async () => {
    if (!entry.is_dir) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    try {
      const entries = await invoke<FileEntry[]>("cmd_list_files", { path: entry.path });
      setChildren(entries);
      setExpanded(true);
    } catch (err) {
      console.error("Failed to list files:", err);
    }
  }, [entry.is_dir, entry.path, expanded]);

  const indent = depth * 10;

  return (
    <>
      <div
        className={`file-entry${entry.is_dir ? " is-dir" : ""}`}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={handleClick}
      >
        <span className="icon">{getIcon(entry, expanded)}</span>
        <span className="name" title={entry.path}>{entry.name}</span>
      </div>
      {expanded &&
        children.map((child) => (
          <FileNode key={child.path} entry={child} depth={depth + 1} />
        ))}
    </>
  );
}

interface FileBrowserProps {
  projectPath: string | null;
}

export function FileBrowser({ projectPath }: FileBrowserProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (!projectPath) { setEntries([]); return; }
    invoke<FileEntry[]>("cmd_list_files", { path: projectPath })
      .then(setEntries)
      .catch(console.error);
  }, [projectPath]);

  if (!projectPath) {
    return <div className="file-browser-empty">No project open</div>;
  }

  return (
    <div className="file-browser">
      {entries.map((entry) => (
        <FileNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
