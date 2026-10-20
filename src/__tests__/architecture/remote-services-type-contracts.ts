import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteHeartbeat, RemoteSshChannel, RemoteSyncBinding, RemoteSyncInventory, RemoteExecutionOutcome, RemoteSyncEnsureOutcome, RemoteSyncWaitOutcome, RemoteTerminateOutcome, RemotePrompt, RemoteSleep } from "../../domain/remote-services.js";
import { createRemoteServices } from "../../application/remote-services.js";
import { createRemoteSync } from "../../application/remote-sync.js";
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
    const observation = ports.observeSyncInventory();
    const boundedObservation: RemoteSyncInventory<symbol> = ports.observeSyncInventory(4321.9);
    // @ts-expect-error a remaining timeout is numeric, not native options owned by composition
    ports.observeSyncInventory({ timeout: 1000 });
    // @ts-expect-error observation remains synchronous so a deferred query cannot escape the wait budget
    const asyncObservation: RemoteServicesPorts<symbol>["observeSyncInventory"] = async () => ({ kind: "unknown", evidence: Symbol() });
    if (observation.kind === "known" && observation.sessions[0]) {
        const observed = observation.sessions[0];
        // @ts-expect-error application can forward opaque evidence but cannot read native result fields
        const status: number = observed.evidence.status;
        ports.report({ kind: "sync-existing", observation: observed });
        void status;
    }
    const binding: RemoteSyncBinding = { localPath: "/project", user: "user", host: "host", projectId: "project", containerId: "a".repeat(64) };
    const sync = createRemoteSync(ports);
    const captured: Promise<RemoteSyncEnsureOutcome<symbol>> = sync.ensureSync(binding);
    const waited: Promise<RemoteSyncWaitOutcome<symbol>> = sync.waitForSync({ identifier: "sync_" + "a".repeat(43), name: "name", binding });
    const services = createRemoteServices(ports);
    const execution: Promise<RemoteExecutionOutcome<symbol>> = services.remoteExec("path");
    const termination: Promise<RemoteTerminateOutcome<symbol>> = services.remoteTerminate("path");
    const reader: RemotePrompt = ports.prompt({ kind: "cleanup" });
    const timer: RemoteSleep = ports.sleep(1000);
    // @ts-expect-error application policy cannot request process termination
    ports.exit(1);
    // @ts-expect-error application policy cannot signal its embedding process
    ports.resignalSelf("SIGTERM");
    // @ts-expect-error expected failures are outcomes, not outward Error construction
    ports.fail("sync-timeout");
    // @ts-expect-error reusable execution returns a finite result rather than process authority
    const processEnding: Promise<void> = services.remoteExec("path");
    void [waited, execution, termination, reader, timer, processEnding];
    // @ts-expect-error waiting must retain the captured identifier and binding rather than a mutable name
    sync.waitForSync("session");
    // @ts-expect-error exact authority includes the remote container ID
    sync.ensureSync({ localPath: "/project", user: "user", host: "host", projectId: "project" });
    const terminateResult = ports.terminateSync("sync_" + "a".repeat(43));
    if (!terminateResult.ok) {
        // @ts-expect-error checked effects retain opaque native evidence
        const nativeStatus: number = terminateResult.evidence.status;
        void nativeStatus;
    }
    void [exec, setup, check, terminate, channel, heartbeat, body, asyncRemoval, pid, releaseReservation, incomplete, boundedObservation, asyncObservation, captured];
}
