interface TerminalHeaderProps {
  projectPath: string;
  sessionId: string;
  onClose?: () => void;
}

function truncatePath(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return path;
  return "…/" + parts.slice(-3).join("/");
}

function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function TerminalHeader({ projectPath, onClose }: TerminalHeaderProps) {
  return (
    <div className="terminal-header">
      <div className="terminal-header__left">
        <span className="terminal-header__status" title="Running" />
        <span className="terminal-header__project">{projectName(projectPath)}</span>
        <span className="terminal-header__path" title={projectPath}>
          {truncatePath(projectPath)}
        </span>
      </div>
      <div className="terminal-header__right">
        {onClose && (
          <button className="terminal-header__close" onClick={onClose} title="Close terminal">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
