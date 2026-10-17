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
function createStopPolicy(ports) {
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

/** @template {object} Binding @template {object} NativeResult
 * @param {import('../../ports/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxStopPorts<Binding, NativeResult>} ports */
export function createWindowsSandboxStop(ports) { return createStopPolicy(ports); }

/** @template {object} Binding
 * @template {object} NativeResult
 * @param {import('../../ports/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxLifecyclePorts<Binding, NativeResult>} ports */
export function createWindowsSandboxLifecycle(ports) {
    const policy = createStopPolicy(ports);
    const WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS = 60000;
    /** @param {Device} device */
    function runtimeSandboxId(device) { return windowsSandboxStopGuidValid(device?.sandboxId) ? /** @type {string} */ (device.sandboxId) : ports.newRuntimeId(); }
    /** @param {Binding} binding */
    function listRuntimeIds(binding) {
        return ports.listRuntime(binding, 10000);
    }
    /** @param {Binding} binding @param {Device} captured @param {string[]} ids @param {boolean} watchdogCleaned */
    function stopRuntimeIds(binding, captured, ids, watchdogCleaned) {
        /** @type {string[]} */ const stopped = [];
        /** @type {{id:string,result:NativeResult}[]} */ const failed = [];
        const targetMatches = ids.every(id => String(id).toLowerCase() === String(captured.sandboxId || "").toLowerCase());
        if (!watchdogCleaned || !targetMatches || !ports.singletonGenerationMatches(captured)) {
            return {ok:false,stopped,failed,refused:true};
        }
        for (const id of ids) {
            if (!ports.singletonGenerationMatches(captured)) return {ok:false,stopped,failed,refused:true};
            const observation = ports.stopRuntime(binding, id, 60000);
            if (observation.ok) stopped.push(id); else failed.push({id,result:observation.result});
        }
        return {ok:failed.length === 0,stopped,failed,refused:false};
    }
    /** Compensation cannot cancel a shared marker or stop a runtime after its singleton claim changes.
     * @param {Binding} binding @param {Device} captured @param {string[]} ids */
    function compensateRuntime(binding, captured, ids) {
        if (!ports.singletonGenerationMatches(captured)) {
            /** @type {WatchdogCleanup} */
            const watchdogCleanup = {
                ok:false,changed:false,device:captured,attempts:[],
                cancellation:{attempted:false,ok:false,cancelPath:"",error:"Windows Sandbox singleton generation changed; compensation was not attempted"},
            };
            /** @type {{id:string,result:NativeResult}[]} */ const failed=[];
            /** @type {string[]} */ const stopped=[];
            return {watchdogCleanup,cleanup:{ok:false,stopped,failed,refused:true}};
        }
        const watchdogCleanup=policy.cleanupWatchdogs(captured);
        return {watchdogCleanup,cleanup:stopRuntimeIds(binding,captured,ids,watchdogCleanup.ok)};
    }
    /** @param {Binding} binding @param {string} sandboxId @param {number} timeoutMs
     * @param {{previousIds:string[],requireNewRuntime:boolean}} options
     * @returns {Promise<import('../../ports/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxRegistration<NativeResult>>} */
    async function waitForRuntime(binding, sandboxId, timeoutMs, options) {
        if (ports.platform !== "win32") return {ok:true,skipped:true,sandboxId};
        const expected = String(sandboxId).toLowerCase();
        const previous = new Set(options.previousIds.map(id => String(id).toLowerCase()));
        const deadline = ports.monotonicNow() + Math.max(0,timeoutMs);
        /** @type {NativeResult|null} */ let lastResult=null;
        let lastObservationOk=false;
        /** @type {string[]} */ let lastIds=[];
        /** @type {string[]} */ let lastNewIds=[];
        while (true) {
            const remaining = Math.floor(deadline - ports.monotonicNow());
            if (remaining <= 0) break;
            const observation = ports.listRuntime(binding,Math.min(10000,remaining));
            lastResult=observation.result;
            lastObservationOk=observation.ok;
            if (observation.ok) {
                const ids=observation.ids;
                lastIds=ids; lastNewIds=ids.map(id=>String(id).toLowerCase()).filter(id=>!previous.has(id));
            }
            if (ports.monotonicNow() >= deadline) break;
            if (observation.ok) {
                const ids=observation.ids;
                if (options.requireNewRuntime) {
                    if(lastNewIds.includes(expected)) return {ok:true,sandboxId:expected,matchedRequested:true,result:lastResult,observedIds:ids,newIds:lastNewIds};
                    if(lastNewIds.length===1) return {ok:true,sandboxId:lastNewIds[0],requestedSandboxId:sandboxId,matchedRequested:false,result:lastResult,observedIds:ids,newIds:lastNewIds};
                    if(lastNewIds.length>1) return {ok:false,result:lastResult,lastObservationOk,observedIds:ids,newIds:lastNewIds,error:`Windows Sandbox launch produced multiple new runtimes: ${lastNewIds.join(", ")}`};
                } else {
                    if(ids.includes(expected)) return {ok:true,sandboxId:expected,matchedRequested:true,result:lastResult};
                    if(ids.length===1) return {ok:true,sandboxId:ids[0],requestedSandboxId:sandboxId,matchedRequested:false,result:lastResult};
                }
            }
            const pause = Math.min(500,deadline - ports.monotonicNow());
            if (pause <= 0) break;
            await ports.wait(pause);
        }
        return {ok:false,result:lastResult,lastObservationOk,observedIds:lastIds,newIds:lastNewIds,error:`Windows Sandbox runtime ${sandboxId} did not appear in wsb list within ${timeoutMs}ms`};
    }

    /** @param {Binding} binding @param {string} id @param {string} configPath @param {string} config @param {boolean} minimized
     * @param {import('../../ports/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxHelperMetadata} helper
     * @returns {{ok:boolean,result:NativeResult,launchMode:string,minimizeWatchdogLaunch?:Exclude<import('../../domain/lifecycle/windows-sandbox-stop.mjs').WindowsSandboxWatchdogLaunch,null|false|0|''>,minimizeWatchdogFailed:boolean,minimizeWatchdogWarning?:string}} */
    function launchRuntime(binding,id,configPath,config,minimized,helper) {
        if (ports.platform === "win32") {
            const startedAfter=ports.timestampBefore(2000);
            const handles=minimized ? ports.windowHandles() : null;
            const observation=ports.launchConfig(configPath,minimized,120000);
            const watchdog=minimized ? ports.launchWatchdog(startedAfter,helper.minimizeWatchdogCancelPath,180000,handles,helper.minimizeWatchdogResultPath) : null;
            return {
                ok:observation.ok,result:observation.result,launchMode:"wsb-file",
                minimizeWatchdogLaunch:watchdog ? watchdog.launch : {ok:true,skipped:true},
                minimizeWatchdogFailed:watchdog?.ok===false,minimizeWatchdogWarning:watchdog?.warning,
            };
        }
        const observation=ports.launchRuntime(binding,id,config,minimized,120000);
        return {ok:observation.ok,result:observation.result,launchMode:"wsb-cli-start",minimizeWatchdogFailed:false};
    }
    /** @param {{deviceId:string,minimized?:boolean}} args
     * @returns {Promise<import('./windows-sandbox-stop.mjs').WindowsSandboxLifecycleOutcome<NativeResult>>} */
    async function start(args) {
        const { deviceId } = args;
        const device = ports.findDevice(deviceId);
        if (!device) return {kind:"unhandled"};
        if (device.status !== "stopped") {
            return {kind:"refused",error:`Refusing to start ${deviceId} while status is ${device.status}`};
        }

        const discovery = ports.discoverRuntime();
        if (!discovery.available) {
            return {kind:"refused",error:`Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`};
        }

        const lifecycleClaim = policy.claimLifecycle(deviceId, device, "start");
        if (!lifecycleClaim.transition.matched) return {kind:"conflict",operation:"start-claim",transition:lifecycleClaim.transition};

        const helper = ports.helperMetadata(device);
        const configPath = ports.writeConfig(device);
        const config = ports.readConfig(configPath);
        ports.resetHelperMarkers(helper);
        const claimedSandboxId = runtimeSandboxId(device);
        const lock = ports.claimSingleton(device, claimedSandboxId, lifecycleClaim.lifecycle.runtimeId);
        if (!lock.ok) {
            policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
            return {kind:"refused",error:lock.error};
        }
        const starting = {
            ...lifecycleClaim.claimed,
            sandboxId: claimedSandboxId,
            singletonClaimId: lock.lock.claimId,
            lifecycle: { ...lifecycleClaim.lifecycle, singletonClaimId: lock.lock.claimId },
            updatedAt: ports.wallTimestamp(),
        };
        const lockTransition = ports.transitionDevice(deviceId, lifecycleClaim.claimed, starting);
        if (!lockTransition.matched) {
            ports.releaseSingleton({ ...device, sandboxId: claimedSandboxId }, lock.lock.claimId);
            return {kind:"conflict",operation:"start-lock",transition:lockTransition};
        }
        const minimized = typeof args.minimized === "boolean" ? args.minimized : device.minimized !== false;
        /** @type {string[]} */ let previousRuntimeIds = [];
        if (ports.platform === "win32") {
            const beforeLaunch = listRuntimeIds(discovery.binding);
            if (!beforeLaunch.ok) {
                ports.releaseSingleton(starting, lock.lock.claimId);
                policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                return {kind:"native-failure",evidence:beforeLaunch.result};
            }
            if (beforeLaunch.ids.length > 0) {
                ports.releaseSingleton(starting, lock.lock.claimId);
                policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                return {kind:"refused",error:`Windows Sandbox already has a running runtime before ${deviceId} start: ${beforeLaunch.ids.join(", ")}. Stop it before starting an owner-scoped device.`};
            }
            previousRuntimeIds = beforeLaunch.ids;
        }
        const r = launchRuntime(discovery.binding, claimedSandboxId, configPath, config, minimized, helper);
        if (!r.ok) {
            ports.releaseSingleton(starting, lock.lock.claimId);
            policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
            return {kind:"native-failure",evidence:r.result};
        }
        const registered = await waitForRuntime(discovery.binding, claimedSandboxId, WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS, {
            previousIds: previousRuntimeIds,
            requireNewRuntime: r.launchMode === "wsb-file",
        });
        if (!registered.ok) {
            const ambiguous = r.launchMode === "wsb-file" && registered.newIds.length > 1;
            const cleanupIds = ambiguous ? [] : r.launchMode === "wsb-file" ? registered.newIds : [claimedSandboxId];
            const {watchdogCleanup,cleanup} = compensateRuntime(discovery.binding, {
                ...starting, minimizeWatchdogLaunch:r.minimizeWatchdogLaunch,
            }, cleanupIds);
            let releaseLockAfterFailure = !ambiguous && cleanup.ok && cleanupIds.length === 0 && registered.lastObservationOk;
            /** @type {ReturnType<typeof listRuntimeIds>|null} */ let cleanupVerify = null;
            if (cleanupIds.length > 0) {
                if (cleanup.ok) {
                    releaseLockAfterFailure = true;
                } else if (!cleanup.refused) {
                    const verification = listRuntimeIds(discovery.binding);
                    cleanupVerify = verification;
                    releaseLockAfterFailure = verification.ok
                        && cleanupIds.every((id) => !verification.ids.includes(String(id).toLowerCase()));
                }
            }
            const runtimeGone = releaseLockAfterFailure;
            if (!watchdogCleanup.ok) {
                const current = policy.currentLifecycleDevice(deviceId, lifecycleClaim.lifecycle);
                if (current) ports.transitionDevice(deviceId, current, {
                    ...current,
                    minimizeWatchdogLaunch: r.minimizeWatchdogLaunch,
                    updatedAt: ports.wallTimestamp(),
                });
                releaseLockAfterFailure = false;
            }
            if (releaseLockAfterFailure) {
                ports.releaseSingleton(starting, lock.lock.claimId);
                policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
            }
            return {kind:"registration-failed",registration:registered,ambiguous,cleanupIds,cleanup,cleanupVerify,runtimeGone,releaseLockAfterFailure,watchdogCleanup};
        }
        const sandboxId = registered.sandboxId || claimedSandboxId;
        if (sandboxId !== claimedSandboxId) {
            const singletonUpdated = ports.updateSingletonRuntimeId(starting, claimedSandboxId, sandboxId, lock.lock.claimId);
            if (!singletonUpdated) {
                const {watchdogCleanup,cleanup} = compensateRuntime(discovery.binding, { ...starting, sandboxId, minimizeWatchdogLaunch:r.minimizeWatchdogLaunch }, [sandboxId]);
                if (cleanup.ok && watchdogCleanup.ok) policy.abortLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                return {
                    kind:"singleton-conflict",
                    deviceId,
                    runtimeStopped: cleanup.ok,
                    compensationRefused: cleanup.refused,
                    watchdogCleaned: watchdogCleanup.ok,
                };
            }
        }
        /** @type {{ok:boolean,warning?:string}|null} */ let minimizeConfirmation = null;
        if (r.minimizeWatchdogFailed) {
            minimizeConfirmation = {
                ok: false,
                warning: r.minimizeWatchdogWarning,
            };
        } else if (minimized && ports.platform === "win32") {
            minimizeConfirmation = await ports.waitForMinimizeConfirmation(helper.minimizeWatchdogResultPath);
        }
        const helperSessionLaunch = r.launchMode === "wsb-file"
            ? { ok: true, skipped: true, reason: "wsb-file launch creates the interactive Sandbox session", launchMode: r.launchMode, minimizeWatchdogLaunch: r.minimizeWatchdogLaunch }
            : ports.launchSession(discovery.binding, sandboxId, minimized);

        const updated = {
            ...starting,
            status: "running",
            sandboxId,
            ...(sandboxId !== claimedSandboxId ? { requestedSandboxId: claimedSandboxId } : {}),
            configPath,
            launchMode: r.launchMode,
            minimizeWatchdogLaunch: r.minimizeWatchdogLaunch,
            minimized,
            minimizeConfirmed: minimizeConfirmation?.ok === true,
            minimizeWarning: minimizeConfirmation?.ok === false ? minimizeConfirmation.warning : null,
            helper: ports.helperMetadata(starting),
            helperSessionLaunch,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionDevice(deviceId, starting, updated);
        if (!transition.matched) {
            const {watchdogCleanup,cleanup} = compensateRuntime(discovery.binding, { ...starting, sandboxId, minimizeWatchdogLaunch:r.minimizeWatchdogLaunch, helperSessionLaunch }, [sandboxId]);
            if (cleanup.ok && watchdogCleanup.ok) ports.releaseSingleton({ ...starting, sandboxId }, lock.lock.claimId);
            return {kind:"conflict",operation:"start-complete",transition,detail:{
                runtimeStopped: cleanup.ok,
                compensationRefused: cleanup.refused,
                watchdogCleaned: watchdogCleanup.ok,
                singletonReleased: cleanup.ok && watchdogCleanup.ok,
            }};
        }
        return {kind:"completed",device:updated};
    }

    /** @param {{deviceId:string,force?:boolean}} args
     * @returns {import('./windows-sandbox-stop.mjs').WindowsSandboxLifecycleOutcome<NativeResult>} */
    function deleteDevice(args) {
        const { deviceId, force = false } = args;
        const devices = ports.readDevices();
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return {kind:"unhandled"};
        if (!force && device.status !== "stopped") {
            return {kind:"refused",error:`Refusing to delete ${deviceId} while status is ${device.status}`};
        }
        let claim = policy.claimLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return {kind:"conflict",operation:"delete-claim",transition:claim.transition};
        const singleton = policy.bindLifecycleSingleton(deviceId, claim, device);
        if (!singleton.ok) {
            policy.abortLifecycle(deviceId, claim.lifecycle, device);
            if (singleton.conflict) return {kind:"conflict",operation:"delete-singleton",transition:singleton.conflict};
            return {kind:"refused",error:singleton.error};
        }
        claim = singleton.claim;
        const stopped = policy.stopDevice({ ...claim.claimed, status: device.status });
        if (!stopped.ok) {
            policy.abortLifecycle(deviceId, claim.lifecycle, device, stopped.device ? {
                minimizeWatchdogLaunch: stopped.device.minimizeWatchdogLaunch,
                ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                    ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                    : {}),
            } : null);
            if (stopped.result) return {kind:"native-failure",evidence:stopped.result};
            return {kind:"refused",error:stopped.error || `Failed to stop Windows Sandbox before deleting ${deviceId}`};
        }
        const current = policy.currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) {
            ports.releaseSingleton(stopped.device, claim.lifecycle.singletonClaimId);
            return {kind:"conflict",operation:"delete",transition:{found:Boolean(ports.findDevice(deviceId)),matched:false}};
        }
        const transition = ports.transitionDevice(deviceId, current, null);
        ports.releaseSingleton(stopped.device, claim.lifecycle.singletonClaimId);
        if (!transition.matched) return {kind:"conflict",operation:"delete",transition};
        ports.removeScratch(stopped.device);
        return {kind:"deleted",deleted:deviceId,scratchRemoved:ports.scratchDirectory(device)};
    }
    /** @param {{deviceId:string}} args
     * @returns {import('./windows-sandbox-stop.mjs').WindowsSandboxLifecycleOutcome<NativeResult>} */
    function stop(args) {
        return policy.stop(args.deviceId);
    }
    return {start,stop,delete:deleteDevice};
}
