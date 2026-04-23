import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface FileViewerProps {
  filePath: string;
}

export function FileViewer({ filePath }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    invoke<string>("cmd_read_file", { path: filePath })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [filePath]);

  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;

  return (
    <div className="file-viewer">
      <div className="file-viewer__header">
        <span className="file-viewer__filename">{filename}</span>
        <span className="file-viewer__path" title={filePath}>{filePath}</span>
      </div>
      <div className="file-viewer__body">
        {loading && (
          <div className="file-viewer__status">Loading…</div>
        )}
        {error && (
          <div className="file-viewer__status file-viewer__status--error">{error}</div>
        )}
        {content !== null && !loading && (
          <div className="file-viewer__content">
            <div className="file-viewer__line-numbers" aria-hidden="true">
              {content.split("\n").map((_, i) => (
                <div key={i} className="file-viewer__line-number">{i + 1}</div>
              ))}
            </div>
            <pre className="file-viewer__code">{content}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
