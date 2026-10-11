import type { BrokerAppiumBudget } from "../domain/broker-appium.js";

import type {BrokerAppiumExecution, BrokerAppiumHttpResponse, BrokerAppiumVerification, BrokerAppiumTermination, BrokerAppiumRefusal} from "../domain/broker-appium.js";
export type {BrokerAppiumExecution, BrokerAppiumHttpResponse, BrokerAppiumVerification, BrokerAppiumTermination} from "../domain/broker-appium.js";
export type BrokerAppiumTransition = {
    found: boolean; matched: boolean; currentAppium: unknown; device: Record<string, unknown> | null;
};
export type BrokerAppiumInstrumentationStep = "force-stop-server" | "force-stop-test" | "uninstall-server" | "uninstall-test" | "uninstall-settings";
export type BrokerAppiumRuntimeCapture<Runtime> = {kind: "injected" | "managed"; handle: Runtime};

/** Native capabilities; callbacks delimit locks, never replace an Appium operation. */
export interface BrokerAppiumPorts<Runtime> {
    commandTimeoutMs: number;
    usesDefaultCommandRunner: boolean;
    strictAppiumPortOwnership: boolean;
    readDevices(ownerId: string, stateKey: string): unknown[];
    stateFailure(error: unknown, target: { backend: string; stateKey: string }): BrokerAppiumRefusal;
    notFound(ownerId: string, backend: string, deviceId: string): BrokerAppiumRefusal;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: Record<string, unknown> | null): BrokerAppiumTransition;
    withDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T | Promise<T>, budget?: BrokerAppiumBudget): Promise<T>;
    heartbeat(ownerId: string, target: { backend: string; stateKey: string; device: Record<string, unknown> }, deviceId: string, budget?: BrokerAppiumBudget): BrokerAppiumRefusal | null;
    isLockTimeout(error: unknown): boolean;
    lockFailure(ownerId: string, backend: string, deviceId: string, error: unknown): BrokerAppiumRefusal;
    isProcessIdentityCurrent(identity: unknown, pid: number): boolean;
    verifyListener(appium: unknown): BrokerAppiumVerification;
    terminateRuntime(appium: unknown): Promise<BrokerAppiumTermination>;
    terminatePortListener(port: number): BrokerAppiumTermination;
    portListener(port: number): unknown;
    portSeed(ownerId: string, backend: string, deviceId: string): number;
    resolveIosTarget(ownerId: string, device: unknown): { ok: true; target: string } | { ok: false; error: string; missing?: unknown };
    http(url: string, options: { method?: string; body?: unknown; timeoutMs?: number }): Promise<BrokerAppiumHttpResponse>;
    captureRuntime(): BrokerAppiumRuntimeCapture<Runtime>;
    runtimeReceipt(runtime: Runtime): unknown;
    launchServer(runtime: Runtime, request: {backend: string; port: number; timeoutMs: number}): Promise<BrokerAppiumExecution>;
    installAvailable(runtime: Runtime): boolean;
    installRuntime(runtime: Runtime, timeoutMs: number): BrokerAppiumExecution;
    instrumentationAvailable(): boolean;
    resetInstrumentation(serial: string, step: BrokerAppiumInstrumentationStep): BrokerAppiumExecution;
    instrumentationReceipt(serial: string): unknown;
    readManifest(runtime: Runtime, kind: "package" | "lock"): string | null;
    stateErrorCode(error: unknown): string | null;
    isMissingFile(error: unknown): boolean;
    ensureRuntimeDirectory(runtime: Runtime): undefined;
    inspectRuntimeDirectory(runtime: Runtime): boolean;
    inspectNodeModules(runtime: Runtime): boolean;
    entryIsValid(runtime: Runtime): boolean;
    readMarker(runtime: Runtime): unknown;
    writeManifest(runtime: Runtime, kind: "package" | "lock", text: string): undefined;
    removeMarker(runtime: Runtime): undefined;
    writeMarker(runtime: Runtime, marker: {manifestHash: string; installedAt: string}): undefined;
    manifestDigest(packageText: string, lockText: string): string;
    withInstallLock<T>(operation: () => T, options: { waitMs: number; staleMs: number }): T;
    timestamp(): string;
    now(): number;
    monotonicNow(): number;
    runtimeId(): string;
    sleep(milliseconds: number): Promise<void>;
}
