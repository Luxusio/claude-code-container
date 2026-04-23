import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ContainerInfo {
  name: string;
  status: string;
  id: string;
}

interface SidecarResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Injection seam for tests: default uses Tauri `invoke`, tests pass a stub.
 */
export type SidecarCaller = (req: { cmd: string; name?: string }) => Promise<SidecarResponse<unknown>>;

const defaultCaller: SidecarCaller = async (req) =>
  invoke<SidecarResponse<unknown>>("cmd_sidecar_cmd", { request: req });

interface Props {
  caller?: SidecarCaller;
}

export function ContainerPanel({ caller = defaultCaller }: Props) {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await caller({ cmd: "list_containers" });
      if (!res.ok) {
        setError(res.error ?? "unknown error");
        setContainers([]);
        return;
      }
      setContainers((res.data as ContainerInfo[]) ?? []);
    } catch (e) {
      setError(String(e));
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, [caller]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (cmd: "stop_container" | "remove_container", name: string) => {
    setError(null);
    const res = await caller({ cmd, name });
    if (!res.ok) {
      setError(res.error ?? `${cmd} failed`);
      return;
    }
    await refresh();
  };

  return (
    <div className="container-panel" data-testid="container-panel">
      <div className="container-panel__header">
        <span>Containers</span>
        <button
          className="sidebar-new-session-btn"
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh containers"
        >
          ⟳
        </button>
      </div>

      {loading && <div className="container-panel__status">Loading…</div>}
      {error && (
        <div className="container-panel__status container-panel__status--error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && containers.length === 0 && (
        <div className="container-panel__empty">No ccc containers.</div>
      )}

      <ul className="container-panel__list">
        {containers.map((c) => (
          <li key={c.id || c.name} className="container-panel__item" data-testid="container-row">
            <div className="container-panel__info">
              <span className="container-panel__name">{c.name}</span>
              <span className="container-panel__status-text">{c.status}</span>
            </div>
            <div className="container-panel__actions">
              <button
                onClick={() => void act("stop_container", c.name)}
                title="Stop"
                aria-label={`Stop ${c.name}`}
              >
                ■
              </button>
              <button
                onClick={() => void act("remove_container", c.name)}
                className="project-node__action--danger"
                title="Remove"
                aria-label={`Remove ${c.name}`}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
