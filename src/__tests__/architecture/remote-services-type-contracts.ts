import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteHeartbeat, RemoteSshChannel } from "../../domain/remote-services.js";
import { remoteExec, remoteSetup, remoteCheck, remoteTerminate, remoteRefreshSessionShell } from "../../remote.js";
export function remoteServiceContracts(ports: RemoteServicesPorts): void {
    const exec: (path: string, host?: string, args?: string[]) => Promise<void> = remoteExec;
    const setup: () => Promise<void> = remoteSetup;
    const check: (path: string) => Promise<void> = remoteCheck;
    const terminate: (path: string) => Promise<void> = remoteTerminate;
    const channel: RemoteSshChannel = ports.startInteractiveSsh({ host: "host", user: "user", remotePath: "" }, "trusted-command");
    const heartbeat: RemoteHeartbeat = ports.startHeartbeat(() => {}, 30_000);
    const body: string = remoteRefreshSessionShell("name", "token", 300, true, "a".repeat(64));
    // @ts-expect-error cleanup and config publication must complete synchronously
    const asyncRemoval: RemoteServicesPorts["removeSessionLock"] = async () => undefined;
    // @ts-expect-error synchronous stop critical section cannot delegate async policy
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error opaque interactive channel is not a native process/PID contract
    const pid: number = channel.pid;
    const { runRelease, ...missingRelease } = ports;
    // @ts-expect-error lease release effect cannot be omitted or defaulted
    const incomplete: RemoteServicesPorts = missingRelease;
    void [exec, setup, check, terminate, channel, heartbeat, body, asyncRemoval, pid, runRelease, incomplete];
}
