/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').IsoTimestamp} IsoTimestamp */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxLifecycleDevice} Device */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxSingleton} Singleton */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxTransition} Transition */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxWatchdogCancellation} WatchdogCancellation */

/**
 * Native binding and failure evidence are opaque inward. No executable, argv,
 * process result, state root or wire envelope belongs to this contract.
 * @template {object} Binding
 * @template {object} NativeResult
 * @typedef {{
 *   readSingleton: () => Singleton | null,
 *   sameSingletonOwner: (singleton: Singleton | null, device: Device, sandboxId?: string | null) => boolean,
 *   newRuntimeId: () => string,
 *   wallTimestamp: () => IsoTimestamp,
 *   transitionDevice: (deviceId: string, expected: Device, replacement: Device) => Transition,
 *   findDevice: (deviceId: string) => Device | undefined,
 *   claimSingleton: (device: Device, sandboxId: string, claimId: string) => {ok: true, lock: Singleton} | {ok: false, error: string},
 *   releaseSingleton: (device: Device, claimId?: string | null) => boolean,
 *   singletonGenerationMatches: (device: Device) => boolean,
 *   watchdogCancelPath: (device: Device) => string,
 *   cancelWatchdog: (cancelPath: string) => WatchdogCancellation | null | undefined,
 *   discoverRuntime: () => {available: boolean, missing: string[], binding: Binding},
 *   stopOwnedRuntime: (binding: Binding, device: Device, timeoutMs: number) => {ok: boolean, evidence: NativeResult}
 * }} WindowsSandboxStopPorts
 */
export {};
