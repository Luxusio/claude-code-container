import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useSessionStore, SessionStatus } from "../store/sessions";

/**
 * useSessionEvents — subscribes to `session_status_<id>` Tauri events for
 * every live session in the store and updates session.status in real time.
 */
export function useSessionEvents() {
  const sessions = useSessionStore((s) => s.sessions);
  const setSessionStatus = useSessionStore((s) => s.setSessionStatus);

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      for (const session of sessions) {
        const eventName = `session_status_${session.id}`;
        const unlisten = await listen<SessionStatus>(eventName, (event) => {
          setSessionStatus(session.id, event.payload);
        });
        if (cancelled) { unlisten(); continue; }
        unlistens.push(unlisten);
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [sessions.map((s) => s.id).join(","), setSessionStatus]);
}
