import type { BrokerAppiumResponse, BrokerAppiumBudget } from "../domain/broker-appium.js";

export type BrokerAppiumCommand = {
    mode: "exec" | "detached"; provider: string; executable: string; args: string[];
    env?: Record<string, string | undefined>; cwd?: string;
};
export type BrokerAppiumExecution = {
    status?: number | null; error?: string; pid?: number; processIdentity?: unknown;
    [field: string]: unknown;
};
export type BrokerAppiumHttpResponse = { ok: boolean; status: number | null; body: unknown };
export type BrokerAppiumVerification =
    | { ok: true; serverUrl: string; port?: number; [field: string]: unknown }
    | { ok: false; error: string; [field: string]: unknown };
export type BrokerAppiumTermination = { ok: boolean; error?: string; stale?: boolean; [field: string]: unknown };
export type BrokerAppiumTransition = {
    found: boolean; matched: boolean; currentAppium: unknown; device: Record<string, unknown> | null;
};
export type BrokerAppiumRuntimePaths = {
    packageRoot: string; sourcePackage: string; sourceLock: string;
    runtimeRoot: string; executable: string; entry: string; markerFile: string;
};

/** Native capabilities; callbacks delimit locks, never replace an Appium operation. */
export interface BrokerAppiumPorts {
    commandTimeoutMs: number;
    commandOutputLimit: number;
    platform: string;
    usesDefaultCommandRunner: boolean;
    strictAppiumPortOwnership: boolean;
    injectedExecutable: string | undefined;
    nodeExecutable: string;
    readDevices(ownerId: string, stateKey: string): unknown[];
    stateFailure(error: unknown, target: { backend: string; stateKey: string }): BrokerAppiumResponse;
    notFound(ownerId: string, backend: string, deviceId: string): BrokerAppiumResponse;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: Record<string, unknown> | null): BrokerAppiumTransition;
    withDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T | Promise<T>, budget?: BrokerAppiumBudget): Promise<T>;
    heartbeat(ownerId: string, target: { backend: string; stateKey: string; device: Record<string, unknown> }, deviceId: string, budget?: BrokerAppiumBudget): BrokerAppiumResponse | null;
    isLockTimeout(error: unknown): boolean;
    lockFailure(ownerId: string, backend: string, deviceId: string, error: unknown): BrokerAppiumResponse;
    isProcessIdentityCurrent(identity: unknown, pid: number): boolean;
    verifyListener(appium: unknown): BrokerAppiumVerification;
    terminateRuntime(appium: unknown): Promise<BrokerAppiumTermination>;
    terminatePortListener(port: number): BrokerAppiumTermination;
    portListener(port: number): unknown;
    portSeed(ownerId: string, backend: string, deviceId: string): number;
    resolveIosTarget(ownerId: string, device: unknown): { ok: true; target: string } | { ok: false; error: string; missing?: unknown };
    http(url: string, options: { method?: string; body?: unknown; timeoutMs?: number }): Promise<BrokerAppiumHttpResponse>;
    execute(command: BrokerAppiumCommand, budget: { timeoutMs: number; outputLimit: number }): BrokerAppiumExecution;
    launch(command: BrokerAppiumCommand): Promise<BrokerAppiumExecution>;
    commandEnvironment(backend: string): Record<string, string | undefined> | undefined;
    providerExecutable(name: string): string | null;
    resolveExecutable(name: string): string | null;
    runtimePaths(): BrokerAppiumRuntimePaths;
    readManifest(path: string, kind: "package" | "lock"): string | null;
    stateErrorCode(error: unknown): string | null;
    ensureRuntimeDirectory(): undefined;
    inspectRuntimeDirectory(): boolean;
    inspectNodeModules(): boolean;
    entryIsValid(entry: string): boolean;
    readMarker(path: string): unknown;
    writeManifest(kind: "package" | "lock", text: string): undefined;
    removeMarker(path: string): undefined;
    writeMarker(path: string, marker: { manifestHash: string; installedAt: string; packageRoot: string }): undefined;
    manifestDigest(packageText: string, lockText: string): string;
    withInstallLock<T>(operation: () => T, options: { waitMs: number; staleMs: number }): T;
    timestamp(): string;
    now(): number;
    monotonicNow(): number;
    runtimeId(): string;
    sleep(milliseconds: number): Promise<void>;
}
