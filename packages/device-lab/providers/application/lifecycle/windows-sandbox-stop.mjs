import { windowsSandboxStopGuidValid } from "../../domain/lifecycle/windows-sandbox-stop.mjs";
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxLifecycleDevice} Device */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxLifecycle} Lifecycle */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxTransition} Transition */
/** @typedef {import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxWatchdogCleanup} WatchdogCleanup */
/** @typedef {{lifecycle: Lifecycle, claimed: Device, transition: Transition}} Claim */
/** @template {object} NativeResult
 * @typedef {{ok: true, device: Device, watchdogCleanup: WatchdogCleanup} | {ok: false, error?: string, result?: NativeResult, device?: Device, watchdogCleanup?: WatchdogCleanup}} DeviceStopResult */
/** @template {object} NativeResult
 * @typedef {{kind: 'unhandled'} | {kind: 'completed', device: Device} | {kind: 'conflict', operation: string, transition: Transition} | {kind: 'refused', error?: string} | {kind: 'native-failure', evidence: NativeResult}} WindowsSandboxStopOutcome */

/**
 * Synchronous direct stop policy and the shared existing lifecycle helpers.
 * Every effect is required; native authority, locks and response conversion stay
 * at composition. There is no new observation, retry or async transaction gap.
 * @template {object} Binding
 * @template {object} NativeResult
 * @param {import('../../ports/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxStopPorts<Binding, NativeResult>} ports
 */
export function createWindowsSandboxStop(ports) {
    for (const name of /** @type {const} */ (["readSingleton", "sameSingletonOwner", "newRuntimeId", "wallTimestamp", "transitionDevice", "findDevice", "claimSingleton", "releaseSingleton", "singletonGenerationMatches", "watchdogCancelPath", "cancelWatchdog", "discoverRuntime", "stopOwnedRuntime"])) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`Windows Sandbox stop requires ${name}`);
    }
    /** @param {string} deviceId @param {Device} device @param {'start' | 'stop' | 'delete'} operation @returns {Claim} */
    function claimLifecycle(deviceId, device, operation) {
        const singleton = ports.readSingleton();
        const singletonClaimId = ports.sameSingletonOwner(singleton, device, device?.sandboxId) ? singleton?.claimId : null;
        const lifecycle = {
            runtimeId: ports.newRuntimeId(),
            operation,
            claimedAt: ports.wallTimestamp(),
            ...(singletonClaimId ? { singletonClaimId } : {}),
        };
        const claimed = {
            ...device,
            status: operation === "delete" ? "deleting" : operation === "stop" ? "stopping" : "starting",
            lifecycle,
            ...(singletonClaimId ? { singletonClaimId } : {}),
            updatedAt: ports.wallTimestamp(),
        };
        return { lifecycle, claimed, transition: ports.transitionDevice(deviceId, device, claimed) };
    }

    /** @param {string} deviceId @param {Lifecycle} lifecycle */
    function currentLifecycleDevice(deviceId, lifecycle) {
        const current = ports.findDevice(deviceId);
        return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
    }

    /** @param {string} deviceId @param {Lifecycle} lifecycle @param {Device} original @param {Partial<Device> | null} [updates] */
    function abortLifecycle(deviceId, lifecycle, original, updates = null) {
        const current = currentLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean(ports.findDevice(deviceId)) };
        const restored = {
            ...current,
            ...(updates || {}),
            status: original.status,
            updatedAt: ports.wallTimestamp(),
        };
        if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
        else delete restored.lifecycle;
        if (Object.prototype.hasOwnProperty.call(original, "singletonClaimId")) restored.singletonClaimId = original.singletonClaimId;
        else delete restored.singletonClaimId;
        return ports.transitionDevice(deviceId, current, restored);
    }

    /** @param {string} deviceId @param {Claim} claim @param {Device} original
         * @returns {{ok: true, claim: Claim} | {ok: false, error?: string, conflict?: Transition}} */
    function bindLifecycleSingleton(deviceId, claim, original) {
        if (original.status === "stopped" || claim.lifecycle.singletonClaimId) return { ok: true, claim };
        if (!windowsSandboxStopGuidValid(original.sandboxId)) {
            return { ok: false, error: `Windows Sandbox device ${original.id} is running but has no valid GUID sandboxId` };
        }
        const singleton = ports.claimSingleton(original, /** @type {string} */ (original.sandboxId), claim.lifecycle.runtimeId);
        if (!singleton.ok) return { ok: false, error: singleton.error };
        const lifecycle = { ...claim.lifecycle, singletonClaimId: singleton.lock.claimId };
        const claimed = {
            ...claim.claimed,
            singletonClaimId: singleton.lock.claimId,
            lifecycle,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionDevice(deviceId, claim.claimed, claimed);
        if (!transition.matched) {
            ports.releaseSingleton({ ...original, singletonClaimId: singleton.lock.claimId }, singleton.lock.claimId);
            return { ok: false, conflict: transition };
        }
        return { ok: true, claim: { ...claim, lifecycle, claimed } };
    }

    /** @param {Device} device @returns {WatchdogCleanup} */
    function cleanupWatchdogs(device) {
        const candidates = [
            /** @type {{pid?: number | null}} */ (device?.minimizeWatchdogLaunch)?.pid,
            /** @type {{minimizeWatchdogPid?: number | null}} */ (device?.helperSessionLaunch)?.minimizeWatchdogPid,
        ].filter((pid, index, values) => Number.isInteger(pid) && /** @type {number} */ (pid) > 0 && values.indexOf(pid) === index);
        const hasWatchdog = candidates.length > 0 || device?.minimizeWatchdogLaunch != null;
        const cancelPath = ports.watchdogCancelPath(device);
        const cancellation = hasWatchdog ? ports.cancelWatchdog(cancelPath) : { attempted: false, ok: true, cancelPath };
        if (!cancellation?.ok) return { ok: false, changed: false, cancellation, attempts: [cancellation], device };

        const helperSessionLaunch = device?.helperSessionLaunch && typeof device.helperSessionLaunch === "object"
            ? { ...device.helperSessionLaunch, minimizeWatchdogPid: null }
            : device?.helperSessionLaunch;
        return {
            ok: true,
            changed: hasWatchdog,
            cancellation,
            attempts: cancellation.attempted ? [cancellation] : [],
            device: {
                ...device,
                minimizeWatchdogLaunch: null,
                ...(helperSessionLaunch ? { helperSessionLaunch } : {}),
            },
        };
    }

    /** @param {Device} device @returns {DeviceStopResult<NativeResult>} */
    function stopDevice(device) {
        if (device.status === "stopped") {
            const singleton = ports.readSingleton();
            if (singleton?.claimId === device.singletonClaimId
                && windowsSandboxStopGuidValid(singleton?.sandboxId)
                && ports.sameSingletonOwner(singleton, device, /** @type {NonNullable<typeof singleton>} */ (singleton).sandboxId)) {
                device = {
                    ...device,
                    status: "running",
                    sandboxId: /** @type {NonNullable<typeof singleton>} */ (singleton).sandboxId,
                };
            }
        }
        if (device.status !== "stopped" && !ports.singletonGenerationMatches(device)) {
            return {
                ok: false,
                error: `Windows Sandbox singleton generation is unavailable for ${device.id}; runtime was not stopped`,
            };
        }
        const watchdogCleanup = cleanupWatchdogs(device);
        if (!watchdogCleanup.ok) {
            return {
                ok: false,
                error: `Failed to stop Windows Sandbox minimize watchdog for ${device.id}: ${watchdogCleanup.attempts.filter((attempt) => !attempt?.ok).map((attempt) => attempt?.error || `pid ${attempt?.pid}`).join(", ")}`,
                watchdogCleanup,
            };
        }
        if (watchdogCleanup.changed) {
            device = watchdogCleanup.device;
        }
        if (device.status === "stopped") {
            const updated = {
                ...device,
                status: "stopped",
                recording: null,
                minimizeWatchdogLaunch: null,
                updatedAt: ports.wallTimestamp(),
            };
            return { ok: true, device: updated, watchdogCleanup };
        }

        const discovery = ports.discoverRuntime();
        if (!discovery.available) {
            return {
                ok: false,
                error: `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`,
                device,
            };
        }

        if (!windowsSandboxStopGuidValid(device.sandboxId)) {
            return {
                ok: false,
                error: `Windows Sandbox device ${device.id} is running but has no valid GUID sandboxId`,
                device,
            };
        }

        const r = ports.stopOwnedRuntime(discovery.binding, device, 60000);
        if (!r.ok) {
            return { ok: false, result: r.evidence, device };
        }

        const updated = {
            ...device,
            status: "stopped",
            recording: null,
            minimizeWatchdogLaunch: null,
            updatedAt: ports.wallTimestamp(),
        };
        return { ok: true, device: updated, watchdogCleanup };
    }

    /** @param {string} deviceId @returns {WindowsSandboxStopOutcome<NativeResult>} */
    function stop(deviceId) {
        const device = ports.findDevice(deviceId);
        if (!device) return { kind: "unhandled" };

        let claim = claimLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return { kind: "conflict", operation: "stop-claim", transition: claim.transition };
        const singleton = bindLifecycleSingleton(deviceId, claim, device);
        if (!singleton.ok) {
            abortLifecycle(deviceId, claim.lifecycle, device);
            if (singleton.conflict) return { kind: "conflict", operation: "stop-singleton", transition: singleton.conflict };
            return { kind: "refused", error: singleton.error };
        }
        claim = singleton.claim;
        const stopped = stopDevice({ ...claim.claimed, status: device.status });
        if (!stopped.ok) {
            abortLifecycle(deviceId, claim.lifecycle, device, stopped.device ? {
                minimizeWatchdogLaunch: stopped.device.minimizeWatchdogLaunch,
                ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                    ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                    : {}),
            } : null);
            if (stopped.result) return { kind: "native-failure", evidence: stopped.result };
            return { kind: "refused", error: stopped.error || `Failed to stop Windows Sandbox device ${deviceId}` };
        }
        const current = currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) {
            ports.releaseSingleton(stopped.device, claim.lifecycle.singletonClaimId);
            return { kind: "conflict", operation: "stop", transition: { found: Boolean(ports.findDevice(deviceId)), matched: false } };
        }
        const updated = {
            ...current,
            ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                : {}),
            lifecycle: null,
            singletonClaimId: null,
            status: "stopped",
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionDevice(deviceId, current, updated);
        ports.releaseSingleton(stopped.device, claim.lifecycle.singletonClaimId);
        if (!transition.matched) return { kind: "conflict", operation: "stop", transition: transition };
        return { kind: "completed", device: updated };
    }

    return { stop, claimLifecycle, currentLifecycleDevice, abortLifecycle, bindLifecycleSingleton, cleanupWatchdogs, stopDevice };
}
