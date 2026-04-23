import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";

interface GitFileDiff {
  old_content: string;
  new_content: string;
  status: string;
}

interface DiffViewerProps {
  projectPath: string;
  filePath: string;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function DiffViewer({ projectPath, filePath }: DiffViewerProps) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [splitView, setSplitView] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDiff(null);
    invoke<GitFileDiff>("cmd_git_file_diff", { projectPath, filePath })
      .then((d) => {
        setDiff(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [projectPath, filePath]);

  const filename = basename(filePath);

  return (
    <div className="diff-viewer">
      <div className="diff-viewer__header">
        <span className="diff-viewer__filename">{filename}</span>
        {diff?.status && (
          <span className="diff-viewer__status">{diff.status || "·"}</span>
        )}
        <span className="diff-viewer__path" title={filePath}>{filePath}</span>
        <button
          className="diff-viewer__toggle"
          onClick={() => setSplitView((v) => !v)}
          title={splitView ? "Switch to unified view" : "Switch to split view"}
        >
          {splitView ? "Split" : "Unified"}
        </button>
      </div>
      <div className="diff-viewer__body">
        {loading && <div className="diff-viewer__status-msg">Loading diff…</div>}
        {error && <div className="diff-viewer__status-msg diff-viewer__status-msg--error">{error}</div>}
        {diff && !loading && (
          <ReactDiffViewer
            oldValue={diff.old_content}
            newValue={diff.new_content}
            splitView={splitView}
            compareMethod={DiffMethod.WORDS}
            useDarkTheme
            styles={{
              variables: {
                dark: {
                  diffViewerBackground: "var(--bg-1, #1e1e1e)",
                  diffViewerColor: "var(--text-1, #d4d4d4)",
                  gutterBackground: "var(--bg-2, #252526)",
                  gutterBackgroundDark: "var(--bg-2, #252526)",
                },
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
