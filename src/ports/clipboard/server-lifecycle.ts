import type { ClipboardHealthResult, ClipboardPortRecord } from "../../domain/clipboard/server-lifecycle.js";

export interface ClipboardServerLifecyclePorts<Lock, Child, Guard, Requester> {
    readPortFile(path?: string): ClipboardPortRecord | null;
    portFilePath(): string;
    portRecordMatches(record: ClipboardPortRecord, path: string): boolean;
    startupLockPath(): string;
    tryAcquireStartupLock(path: string): Lock | null;
    recoverDeadStartupLock(path: string): boolean;
    releaseStartupLock(lock: Lock): undefined;
    checkHealth(port: number, expectedToken: string, bindAddress: string): Promise<ClipboardHealthResult>;
    requestShutdown(port: number, token?: string): Promise<boolean>;
    withGlobalGuard<T>(operation: (guard: Guard) => Promise<T>): Promise<T>;
    hasOtherSessions(requester?: Requester): boolean;
    portMayHaveBindUsers(path: string, guard: Guard): boolean;
    preparePublication(path: string, guard: Guard): ((record: ClipboardPortRecord) => unknown) | null;
    markRetired(record: ClipboardPortRecord, path: string, guard: Guard): void;
    warnUpgradeDeferred(): undefined;
    /** Monotonic elapsed time in milliseconds. */
    now(): number;
    sleep(milliseconds: number): Promise<unknown>;
    daemonScriptPath(): string;
    launchDaemon(script: string, publish: (record: ClipboardPortRecord) => unknown): Promise<Child>;
    unrefDaemon(child: Child): undefined;
}
