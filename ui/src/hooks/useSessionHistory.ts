import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface HistorySession {
  id: string;
  project_path: string;
  timestamp: string;
  summary: string;
  archived: boolean;
  jsonl_path: string;
  worktree_branch: string | null;
}

export function useSessionHistory(projectPath?: string | null) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<HistorySession[]>("cmd_list_sessions", {
        projectPath: projectPath ?? null,
      });
      setSessions(result);
    } catch (err) {
      console.error("Failed to list sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const archiveSession = useCallback(
    async (id: string) => {
      try {
        await invoke<void>("cmd_archive_session", { sessionId: id });
        await refresh();
      } catch (err) {
        console.error("Failed to archive session:", err);
      }
    },
    [refresh]
  );

  const unarchiveSession = useCallback(
    async (id: string) => {
      try {
        await invoke<void>("cmd_unarchive_session", { sessionId: id });
        await refresh();
      } catch (err) {
        console.error("Failed to unarchive session:", err);
      }
    },
    [refresh]
  );

  useEffect(() => {
    refresh();
  }, [refresh, projectPath]);

  return { sessions, loading, archiveSession, unarchiveSession, refresh };
}
