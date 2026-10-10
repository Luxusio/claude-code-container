export type PhysicalRecord = Record<string, unknown>;
export interface CleanupRpcResult {
    status: number;
    payload: unknown;
}
export interface CleanupSignal {
    attempted?: boolean;
    ok: boolean;
    [key: string]: unknown;
}
export interface CleanupPublication {
    found: boolean;
    matched: boolean;
    device: unknown;
}
export interface CleanupLeaseGuard<Handle> {
    handle: Handle;
    attempted: boolean;
    preflight: CleanupRpcResult | null;
    canRestore: boolean;
}
export interface CleanupLeaseResult {
    attempted: boolean;
    ok: boolean;
    status?: number;
    payload?: unknown;
}
export interface CleanupRollback {
    attempted: boolean;
    ok: boolean;
    [key: string]: unknown;
}
export interface AuxiliaryCleanup {
    ok: boolean;
    changed: boolean;
    stateConflict?: boolean;
    appium: PhysicalRecord;
    recording: PhysicalRecord;
    minimizeWatchdog: PhysicalRecord;
}
export interface AuxiliaryOutcome {
    result: AuxiliaryCleanup;
    device: unknown;
    committed: boolean;
}
export interface CleanupCommandTarget {
    backend: string;
    stateKey: string;
    deviceId: string;
}
export function cleanupRecord(value: unknown): value is PhysicalRecord { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function isPhysicalState(stateKey: string) { return stateKey === "android-device" || stateKey === "ios-device"; }
export function deviceHasRuntimeMetadata(record: PhysicalRecord) { return record.appium != null || record.recording != null; }
export function shouldStopOwnerDevice(stateKey: string, status: unknown) { return !isPhysicalState(stateKey) && ["running", "booted", "started", "starting"].includes(String(status || "").toLowerCase()); }
export interface CleanupOptions {
    stopDevices: boolean;
    detachPhysical: boolean;
}
export interface CleanupDeviceOutcome {
    device: unknown;
    changed: boolean;
    result: PhysicalRecord;
}
export function cleanupFailureCount(outcome: PhysicalRecord) {
    let failed = 0;
    if (outcome.stateConflict)
        failed += 1;
    const stateWrite = cleanupRecord(outcome.stateWrite) ? outcome.stateWrite : null;
    if (stateWrite && !stateWrite.ok)
        failed += 1;
    const stop = cleanupRecord(outcome.stop) ? outcome.stop : null;
    if (stop?.attempted && !stop.ok)
        failed += 1;
    for (const name of ["appium", "recording", "physical"]) {
        const entry = cleanupRecord(outcome[name]) ? outcome[name] : null;
        const signal = entry && cleanupRecord(entry[name === "physical" ? "lease" : "signal"]) ? entry[name === "physical" ? "lease" : "signal"] : null;
        if (cleanupRecord(signal) && !signal.ok && (name === "recording" || signal.attempted))
            failed += 1;
    }
    return failed;
}
export function ownerCleanupSelection(params: unknown, stateKeys: readonly string[], aliases: ReadonlyMap<string, string>) {
    const input = cleanupRecord(params) ? params : {};
    const stopDevices = input.stopDevices !== false;
    const detachPhysical = input.detachPhysical !== false;
    const backend = typeof input.backend === 'string' ? stateKeys.includes(input.backend) ? input.backend : aliases.get(input.backend) : null;
    if (input.backend !== undefined && !backend) return { ok: false as const, allowed: [...stateKeys, ...aliases.keys()] };
    return { ok: true as const, stopDevices, detachPhysical, stateKeys: backend ? [backend] : stateKeys };
}
