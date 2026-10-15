export type PhysicalRecord = Record<string, unknown>;
import type { LeaseFailure, PhysicalLeaseRecord } from './broker-physical-leases.js';
export type OwnerCleanupOutcome<Receipt> = {kind:'invalid-backend';error:string;allowed:string[]} |
    {kind:'cleaned';ownerId:string;cleaned:true;stopDevices:boolean;detachPhysical:boolean;changedDevices:number;failed:number;results:CleanupBackendReport<Receipt>[];authority:'host-broker'};
export interface CleanupStopObservation<Receipt> {ok:boolean;operationKind:'runtime-stop'|'metadata-only';receipt:Receipt}
export type CleanupStopOutcome<Receipt> = (
    {attempted:false;ok:false;error:string;missing?:string[]} |
    {attempted:true;ok:boolean;observation:CleanupStopObservation<Receipt>}
) & {changed:boolean;auxiliary?:AuxiliaryCleanup;stateConflict?:boolean};
export interface CleanupSignal {
    attempted?: boolean;
    ok: boolean;
    [key: string]: unknown;
}
export interface CleanupTermination {
    ok: boolean;
    ended: boolean;
    receipt: CleanupSignal;
}
export interface CleanupPublication {
    found: boolean;
    matched: boolean;
    device: unknown;
}
export interface CleanupLeaseGuard<Handle> {
    handle:Handle;
    attempted:boolean;
    admission:{kind:'exact'}|{kind:'missing';failure:LeaseFailure}|{kind:'no-identity'}|{kind:'refused';failure:LeaseFailure};
    canRestore:boolean;
}
export type CleanupLeaseResult =
    {kind:'released';attempted:true;ok:true;lease:PhysicalLeaseRecord} |
    {kind:'missing';attempted:true;ok:true;failure:LeaseFailure} |
    {kind:'no-identity';attempted:false;ok:true} |
    {kind:'refused';attempted:boolean;ok:false;failure:LeaseFailure};
export type CleanupRollback =
    {kind:'not-needed';attempted:false;ok:true} |
    {kind:'restored';attempted:true;ok:true;lease:PhysicalLeaseRecord;heartbeat:unknown} |
    {kind:'occupied';attempted:true;ok:false;error:string;lease:PhysicalLeaseRecord|null} |
    {kind:'write-failed';attempted:true;ok:false;error:string;detail:string};
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
export interface CleanupDeviceReport<Receipt> extends PhysicalRecord {
    stop?: {attempted:false;ok:false;error:string;missing?:string[]} | {attempted:true;ok:boolean;observation:CleanupStopObservation<Receipt>};
    physical?: {detached:boolean;poweredOff:false;disconnected:false;lease:CleanupLeaseResult};
    stateWrite?: {ok:false;error:string;detail:string;leaseRollback:CleanupRollback};
}
export interface CleanupBackendReport<Receipt> {
    stateKey:string;ok:boolean;error?:string;changed?:boolean;devices?:CleanupDeviceReport<Receipt>[];
}
export interface CleanupDeviceOutcome<Receipt> {
    device: unknown;
    changed: boolean;
    result: CleanupDeviceReport<Receipt>;
}
export function cleanupFailureCount(outcome: PhysicalRecord) {
    let failed = outcome.stateConflict ? 1 : 0;
    const stateWrite = cleanupRecord(outcome.stateWrite) ? outcome.stateWrite : null;
    if (stateWrite && !stateWrite.ok) failed += 1;
    let auxiliaryFailures = 0;
    for (const name of ["appium", "recording", "physical", "minimizeWatchdog"]) {
        const entry = cleanupRecord(outcome[name]) ? outcome[name] : null;
        const field = name === "physical" ? "lease" : name === "minimizeWatchdog" ? "cancellation" : "signal";
        const signal = entry && cleanupRecord(entry[field]) ? entry[field] : null;
        if (signal && !signal.ok) {
            failed += 1;
            if (name !== "physical") auxiliaryFailures += 1;
        }
    }
    const stop = cleanupRecord(outcome.stop) ? outcome.stop : null;
    if (stop && !stop.ok) {
        const alreadyReported = Boolean(outcome.stateConflict)
            || (!stop.attempted && stop.error === "auxiliary-runtime-cleanup-failed" && auxiliaryFailures > 0);
        if (!alreadyReported) failed += 1;
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
