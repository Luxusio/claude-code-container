/** @typedef {`${number}-${number}-${number}T${string}Z`} IsoTimestamp */
/** @typedef {{runtimeId: string, operation: string, claimedAt: IsoTimestamp, singletonClaimId?: string | null}} WindowsSandboxLifecycle */
/** @typedef {{pid?: number | null, ok?: boolean, timeoutMs?: number, cancelPath?: string, error?: string, skipped?: boolean, processOwner?: string, startedBy?: string} | null | false | 0 | ''} WindowsSandboxWatchdogLaunch */
/** @typedef {{minimizeWatchdogPid?: number | null, ok?: boolean, pid?: number, skipped?: boolean, reason?: string, launchMode?: string, minimizeWatchdogLaunch?: WindowsSandboxWatchdogLaunch} | readonly (string | number | boolean | null)[] | null | false | 0 | ''} WindowsSandboxHelperSessionLaunch */
/**
 * Checked projections of existing records, not a new runtime state validator.
 * Unprojected fields survive the source's object spreads and exact native CAS.
 * @typedef {{
 *   id: string, status: string, sandboxId?: string | null, minimized?: boolean,
 *   helper?: unknown, configPath?: string, launchMode?: string, requestedSandboxId?: string,
 *   minimizeConfirmed?: boolean, minimizeWarning?: string | null,
 *   singletonClaimId?: string | null, lifecycle?: WindowsSandboxLifecycle | null,
 *   updatedAt?: IsoTimestamp, minimizeWatchdogLaunch?: WindowsSandboxWatchdogLaunch,
 *   helperSessionLaunch?: WindowsSandboxHelperSessionLaunch,
 *   recording?: {active?: boolean, runtimeId?: string, sessionId?: string} | null
 * }} WindowsSandboxLifecycleDevice
 */
/** @typedef {{claimId?: string | null, sandboxId?: string | null, ownerId?: string, deviceId?: string}} WindowsSandboxSingleton */
/** @typedef {{found: boolean, matched: boolean, currentDevice?: WindowsSandboxLifecycleDevice | null, device?: WindowsSandboxLifecycleDevice | null}} WindowsSandboxTransition */
/** @typedef {{attempted: boolean, ok: boolean, cancelPath: string, error?: string, pid?: number}} WindowsSandboxWatchdogCancellation */
/** @typedef {{ok: boolean, changed: boolean, cancellation: WindowsSandboxWatchdogCancellation | null | undefined, attempts: (WindowsSandboxWatchdogCancellation | null | undefined)[], device: WindowsSandboxLifecycleDevice}} WindowsSandboxWatchdogCleanup */
/** @param {unknown} value */
export function windowsSandboxStopGuidValid(value: unknown): boolean;
export type IsoTimestamp = `${number}-${number}-${number}T${string}Z`;
export type WindowsSandboxLifecycle = {
    runtimeId: string;
    operation: string;
    claimedAt: IsoTimestamp;
    singletonClaimId?: string | null;
};
export type WindowsSandboxWatchdogLaunch = {
    pid?: number | null;
    ok?: boolean;
    timeoutMs?: number;
    cancelPath?: string;
    error?: string;
    skipped?: boolean;
    processOwner?: string;
    startedBy?: string;
} | null | false | 0 | "";
export type WindowsSandboxHelperSessionLaunch = {
    minimizeWatchdogPid?: number | null;
    ok?: boolean;
    pid?: number;
    skipped?: boolean;
    reason?: string;
    launchMode?: string;
    minimizeWatchdogLaunch?: WindowsSandboxWatchdogLaunch;
} | readonly (string | number | boolean | null)[] | null | false | 0 | "";
/**
 * Checked projections of existing records, not a new runtime state validator.
 * Unprojected fields survive the source's object spreads and exact native CAS.
 */
export type WindowsSandboxLifecycleDevice = {
    id: string;
    status: string;
    sandboxId?: string | null;
    minimized?: boolean;
    helper?: unknown;
    configPath?: string;
    launchMode?: string;
    requestedSandboxId?: string;
    minimizeConfirmed?: boolean;
    minimizeWarning?: string | null;
    singletonClaimId?: string | null;
    lifecycle?: WindowsSandboxLifecycle | null;
    updatedAt?: IsoTimestamp;
    minimizeWatchdogLaunch?: WindowsSandboxWatchdogLaunch;
    helperSessionLaunch?: WindowsSandboxHelperSessionLaunch;
    recording?: {
        active?: boolean;
        runtimeId?: string;
        sessionId?: string;
    } | null;
};
export type WindowsSandboxSingleton = {
    claimId?: string | null;
    sandboxId?: string | null;
    ownerId?: string;
    deviceId?: string;
};
export type WindowsSandboxTransition = {
    found: boolean;
    matched: boolean;
    currentDevice?: WindowsSandboxLifecycleDevice | null;
    device?: WindowsSandboxLifecycleDevice | null;
};
export type WindowsSandboxWatchdogCancellation = {
    attempted: boolean;
    ok: boolean;
    cancelPath: string;
    error?: string;
    pid?: number;
};
export type WindowsSandboxWatchdogCleanup = {
    ok: boolean;
    changed: boolean;
    cancellation: WindowsSandboxWatchdogCancellation | null | undefined;
    attempts: (WindowsSandboxWatchdogCancellation | null | undefined)[];
    device: WindowsSandboxLifecycleDevice;
};
