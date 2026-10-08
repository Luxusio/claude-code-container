import type { ClipboardHealthResult, ClipboardPortRecord } from "../../domain/clipboard/server-lifecycle.js";

export interface ClipboardServerLifecyclePorts<Lock, Child> {
    readPortFile(path?: string): ClipboardPortRecord | null;
    portFilePath(): string;
    startupLockPath(): string;
    tryAcquireStartupLock(path: string): Lock | null;
    recoverDeadStartupLock(path: string): boolean;
    releaseStartupLock(lock: Lock): undefined;
    checkHealth(port: number, expectedToken: string, bindAddress: string): Promise<ClipboardHealthResult>;
    requestShutdown(port: number, token?: string): Promise<boolean>;
    portMayHaveBindUsers(path: string): boolean;
    warnUpgradeDeferred(): undefined;
    now(): number;
    sleep(milliseconds: number): Promise<unknown>;
    daemonScriptPath(): string;
    launchDaemon(script: string): Child;
    unrefDaemon(child: Child): undefined;
}
