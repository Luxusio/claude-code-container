import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteHeartbeat, RemoteSshChannel, RemoteSyncObservation } from "../../domain/remote-services.js";
import { remoteExec, remoteSetup, remoteCheck, remoteTerminate, remoteRefreshSessionShell } from "../../remote.js";

export function remoteServiceContracts(ports: RemoteServicesPorts<symbol>): void {
    const exec: (path: string, host?: string, args?: string[]) => Promise<void> = remoteExec;
    const setup: () => Promise<void> = remoteSetup;
    const check: (path: string) => Promise<void> = remoteCheck;
    const terminate: (path: string) => Promise<void> = remoteTerminate;
    const channel: RemoteSshChannel = ports.startInteractiveSession({ config: { host: "host", user: "user", remotePath: "" }, containerId: "a".repeat(64), projectId: "project", arguments: ["literal"], environment: [["SAFE", "value"]] });
    const heartbeat: RemoteHeartbeat = ports.startHeartbeat(() => {}, 30_000);
    const body: string = remoteRefreshSessionShell("name", "token", 300, true, "a".repeat(64));
    // @ts-expect-error local claim removal must finish before cleanup returns
    const asyncRemoval: RemoteServicesPorts["removeSessionLock"] = async () => undefined;
    // @ts-expect-error synchronous cleanup lock cannot defer policy to an asynchronous callback
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error the channel exposes signal forwarding, not native process authority
    const pid: number = channel.pid;
    const { releaseReservation, ...missingRelease } = ports;
    // @ts-expect-error reservation lifetime requires its release capability
    const incomplete: RemoteServicesPorts<symbol> = missingRelease;
    const observation = ports.observeSync("session");
    const boundedObservation: RemoteSyncObservation<symbol> = ports.observeSync("session", "a".repeat(64), 4321.9);
    const observationWithoutEndpoint: RemoteSyncObservation<symbol> = ports.observeSync("session", undefined, 1);
    // @ts-expect-error a remaining timeout is numeric, not native options owned by composition
    ports.observeSync("session", undefined, { timeout: 1000 });
    // @ts-expect-error observation remains synchronous so a deferred query cannot escape the wait budget
    const asyncObservation: RemoteServicesPorts<symbol>["observeSync"] = async () => ({ kind: "unavailable" });
    if (observation.kind === "observed") {
        // @ts-expect-error application can forward opaque evidence but cannot read native result fields
        const status: number = observation.evidence.status;
        ports.report({ kind: "sync-existing", observation });
        void status;
    }
    void [exec, setup, check, terminate, channel, heartbeat, body, asyncRemoval, pid, releaseReservation, incomplete, boundedObservation, observationWithoutEndpoint, asyncObservation];
}
