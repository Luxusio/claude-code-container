import type { CleanupBackend, CleanupRecord, CleanupStopEffect, CleanupStopEffectsResult, OwnedCleanupRuntime } from "../domain/device-admin-cleanup.js";
export interface DeviceAdminCleanupPorts<Backend extends CleanupBackend> {
 readonly backends: readonly Backend[];
 resolveOwnerId(cwd: string, profile?: string): string;
 readDevices(ownerId: string, stateKey: string): CleanupRecord[];
 sameRecord(current: CleanupRecord, expected: CleanupRecord): boolean;
 withRecordLock<T>(ownerId: string, stateKey: string, deviceId: string, decide: () => T): T;
 appiumCleanupBlock(device: CleanupRecord): string | null;
 runtimeCleanupBlock(device: CleanupRecord): string | null;
 runtimeExited(runtime: OwnedCleanupRuntime): boolean;
 signalRuntime(runtime: Record<string, unknown>, signal: "SIGINT" | "SIGTERM"): { ok: boolean };
 waitForRuntimeExit(runtime: OwnedCleanupRuntime, timeoutMs: number): boolean;
 executeStopEffects(effects: readonly CleanupStopEffect[], timeoutMs: number): CleanupStopEffectsResult;
 timestamp(): string;
 hardwareId(backend: Backend, device: CleanupRecord): string | null;
 transitionRecord(ownerId: string, backend: Backend, expected: CleanupRecord, replacement: CleanupRecord): { matched: boolean };
 transitionPhysicalRecord(ownerId: string, backend: Backend, expected: CleanupRecord, replacement: CleanupRecord): boolean;
 releaseWindowsClaim(ownerId: string, backend: Backend, device: CleanupRecord): undefined;
}
export interface DeviceAdminAllProjectCleanupPorts<Backend extends CleanupBackend> extends DeviceAdminCleanupPorts<Backend> {
 enumerateOwnerIds(): string[];
}
