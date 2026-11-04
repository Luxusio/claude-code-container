import type { ClipboardHealthResult, ClipboardPortRecord, ClipboardSessionPresence, ClipboardUpgradeDeferral, ClipboardUpgradeDeferralReason } from "../../domain/clipboard/server-lifecycle.js";

export type ClipboardPublication = ((record: ClipboardPortRecord) => unknown) & { dispose?(): void };
export type ClipboardPublicationPreparation =
    | { readonly kind: "ready"; readonly publish: ClipboardPublication }
    | { readonly kind: "deferred"; readonly reason: ClipboardUpgradeDeferralReason };

export interface ClipboardServerLifecyclePorts<Lock, Child, Guard, Requester> {
    readonly generation?: string;
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
    observeOtherSessions?(requester?: Requester): ClipboardSessionPresence;
    portMayHaveBindUsers(path: string, guard: Guard): boolean;
    preparePublication(path: string, guard: Guard): ClipboardPublicationPreparation;
    markRetired(record: ClipboardPortRecord, path: string, guard: Guard): void;
    warnUpgradeDeferred(detail: ClipboardUpgradeDeferral): undefined;
    /** Monotonic elapsed time in milliseconds. */
    now(): number;
    sleep(milliseconds: number): Promise<unknown>;
    daemonScriptPath(): string;
    launchDaemon(script: string, publish: (record: ClipboardPortRecord) => unknown): Promise<Child>;
    unrefDaemon(child: Child): undefined;
}
