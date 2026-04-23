import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export function usePty() {
  const createPty = (
    sessionId: string,
    projectPath: string,
    cols?: number,
    rows?: number
  ): Promise<string> => {
    return invoke<string>("cmd_pty_create", {
      opts: {
        id: sessionId,
        project_path: projectPath,
        session_id: null,
        cols: cols ?? 220,
        rows: rows ?? 50,
      },
    });
  };

  const createPtyWithContinue = (
    sessionId: string,
    projectPath: string,
    continueSessionId: string,
    cols?: number,
    rows?: number
  ): Promise<string> => {
    return invoke<string>("cmd_pty_create", {
      opts: {
        id: sessionId,
        project_path: projectPath,
        session_id: continueSessionId,
        cols: cols ?? 220,
        rows: rows ?? 50,
      },
    });
  };

  const writePty = (sessionId: string, data: string): Promise<void> => {
    return invoke<void>("cmd_pty_write", { id: sessionId, data });
  };

  const resizePty = (
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<void> => {
    return invoke<void>("cmd_pty_resize", { id: sessionId, cols, rows });
  };

  const closePty = (sessionId: string): Promise<void> => {
    return invoke<void>("cmd_pty_close", { id: sessionId });
  };

  const onPtyData = (
    sessionId: string,
    cb: (data: string) => void
  ): Promise<UnlistenFn> => {
    return listen<string>(`pty_data_${sessionId}`, (event) => {
      cb(event.payload);
    });
  };

  const onPtyClosed = (
    sessionId: string,
    cb: () => void
  ): Promise<UnlistenFn> => {
    return listen<void>(`pty_closed_${sessionId}`, () => {
      cb();
    });
  };

  return {
    createPty,
    createPtyWithContinue,
    writePty,
    resizePty,
    closePty,
    onPtyData,
    onPtyClosed,
  };
}
