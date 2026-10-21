import { androidLifecycleRefused, androidLifecycleConflict } from "../../domain/lifecycle/android-emulator-lifecycle.mjs";

/** @param {boolean} adbAvailable
 * @param {number} timeoutMs
 * @param {import('../../ports/lifecycle/android-emulator-lifecycle.mjs').AndroidEmulatorBootConfirmationPorts} ports
 * @returns {Promise<import('../../ports/lifecycle/android-emulator-lifecycle.mjs').AndroidEmulatorBoot>} */
export async function confirmAndroidEmulatorBoot(adbAvailable, timeoutMs, ports) {
    if (!adbAvailable) return { ready: false, skipped: true, reason: "adb missing" };
    const deadline = ports.now() + Math.max(0, timeoutMs);
    while (ports.now() <= deadline) {
        const processExit = ports.processExit();
        if (processExit) return { ready: false, skipped: false, reason: "emulator-process-exited", ...processExit };
        const ready = ports.probeBootCompleted();
        await ports.sleep(0);
        const processExitAfterPoll = ports.processExit();
        if (processExitAfterPoll) return { ready: false, skipped: false, reason: "emulator-process-exited", ...processExitAfterPoll };
        if (ready) return { ready: true };
        await ports.sleep(250);
    }
    return { ready: false, skipped: false, reason: "timeout" };
}

/** Compose the direct variant without capturing native getters before their phase.
 * @template {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorProcessHandle} [Child=import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorProcessHandle]
 * @param {import('../../ports/lifecycle/android-emulator-lifecycle.mjs').AndroidEmulatorLifecyclePorts<Child>} ports
 */
export function createAndroidEmulatorLifecycle(ports) {
    /** @param {string | undefined} deviceId
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} device
     * @param {string} operation */
    function claimAndroidLifecycle(deviceId, device, operation) {
        const lifecycle = {
            runtimeId: ports.runtimeId(),
            operation,
            claimedAt: ports.wallTimestamp(),
        };
        const claimed = {
            ...device,
            status: operation === "delete" ? "deleting" : operation === "stop" ? "stopping" : device.status,
            lifecycle,
            updatedAt: ports.wallTimestamp(),
        };
        return { lifecycle, claimed, transition: ports.transitionAndroidDevice(deviceId, device, claimed) };
    }

    /** @param {string | undefined} deviceId
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleClaim} lifecycle */
    function currentAndroidLifecycleDevice(deviceId, lifecycle) {
        const current = ports.findAndroidDevice(deviceId);
        return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
    }

    /** @param {string | undefined} deviceId
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleClaim} lifecycle
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} original */
    function abortAndroidLifecycle(deviceId, lifecycle, original) {
        const current = currentAndroidLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean(ports.findAndroidDevice(deviceId)) };
        const restored = {
            ...current,
            status: original.status,
            updatedAt: ports.wallTimestamp(),
        };
        if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
        else delete restored.lifecycle;
        return ports.transitionAndroidDevice(deviceId, current, restored);
    }

    /** Native reads alone become unavailable; repository/claim errors stay storage errors.
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} discovery
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} device
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorStopBudget} budget
     * @returns {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorStopObservation} */
    function observeStop(discovery, device, budget) {
        if (budget.remaining() <= 0) return { kind: "unavailable", reason: "deadline-exhausted" };
        let observation;
        try {
            observation = ports.observeAndroidEmulator(discovery, device, budget);
        } catch {
            return { kind: "unavailable", reason: "observation-failed" };
        }
        return budget.remaining() > 0 ? observation : { kind: "unavailable", reason: "deadline-exhausted" };
    }

    /** @param {string | undefined} deviceId
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleClaim} lifecycle
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} discovery
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} device
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorStopBudget} budget
     * @returns {Promise<{kind:"confirmed"}|{kind:"conflict"}|{kind:"unconfirmed",reason:import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorStopFailureReason}>} */
    async function confirmStopped(deviceId, lifecycle, discovery, device, budget) {
        while (budget.remaining() > 0) {
            if (!currentAndroidLifecycleDevice(deviceId, lifecycle)) return { kind: "conflict" };
            const observation = observeStop(discovery, device, budget);
            if (!currentAndroidLifecycleDevice(deviceId, lifecycle)) return { kind: "conflict" };
            if (observation.kind === "unavailable") return { kind: "unconfirmed", reason: observation.reason };
            if (budget.remaining() <= 0) return { kind: "unconfirmed", reason: "deadline-exhausted" };
            if (!observation.serialPresent && !observation.processActive) return { kind: "confirmed" };
            await budget.pause();
        }
        return { kind: "unconfirmed", reason: "deadline-exhausted" };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} discovery
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} device
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorRuntime} runtime */
    async function rollbackStartedAndroidEmulator(discovery, device, runtime) {
        const adb = ports.stopAndroidEmulator(discovery, device);
        const processTree = await ports.terminateOwnedRuntimeProcessTree(ports.refreshOwnedRuntimeProcessIdentity(runtime), "Android Emulator superseded startup", { timeoutMs: 3000 });
        return {
            ok: Boolean(adb?.ok || processTree.exited),
            adb: adb ? adb.diagnostic : null,
            processTree,
        };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args
     * @returns {Promise<import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleOutcome|undefined>} */
    async function create(args) {
        const { backend, name: deviceName, deviceId, avdName, port, systemImage, deviceProfile, createAvd = false, headless = true } = args;
        if (backend !== "android-emulator") return undefined;

        const id = deviceId || ports.androidDeviceId(deviceName);
        let allocation = ports.resolveAndroidEmulatorPort(ports.ownerId(), id, port);
        if (!allocation.ok) {
            const detail = allocation.detail ? `: ${allocation.detail}` : allocation.allowed ? ` (${allocation.allowed})` : "";
            return androidLifecycleRefused(`${allocation.error}${detail}`);
        }
        const livePorts = ports.liveAndroidEmulatorPortsForAllocation();
        if (!livePorts.ok) return androidLifecycleRefused(`${livePorts.error}: ${livePorts.detail}`);
        if (livePorts.ports.has(allocation.port)) {
            allocation = ports.resolveAndroidEmulatorPort(ports.ownerId(), id, port, livePorts.ports);
            if (!allocation.ok) {
                const detail = allocation.detail ? `: ${allocation.detail}` : "";
                return androidLifecycleRefused(`${allocation.error}${detail}`);
            }
        }
        const devices = ports.readAndroidDevices();
        if (devices.some((device) => device.id === id)) {
            return androidLifecycleRefused(`Device already exists for this owner: ${id}`);
        }

        const resolvedAvdName = avdName || `${ports.ownerAvdPrefix()}${ports.slug(deviceName)}`;
        const shouldCreateAvd = Boolean(createAvd);
        const avdRoot = shouldCreateAvd ? ports.androidAvdHome() : null;
        if (shouldCreateAvd && !ports.isOwnedAvdName(resolvedAvdName)) {
            return androidLifecycleRefused(`Refusing to create non-owned Android AVD name: ${resolvedAvdName}`);
        }
        if (shouldCreateAvd && !ports.isSafeProvisionedAvdName(resolvedAvdName)) {
            return androidLifecycleRefused("Android AVD name contains unsupported characters for provider execution");
        }
        if (shouldCreateAvd) {
            const discovery = ports.androidDiscovery();
            if (!discovery.provisioningAvailable) {
                return androidLifecycleRefused(`Android AVD provisioning missing prerequisites: ${discovery.provisioningMissing.join(", ")}`);
            }
            if (!systemImage) return androidLifecycleRefused("Android AVD provisioning requires systemImage");
            if (!ports.isSafeSystemImage(systemImage)) return androidLifecycleRefused("Android AVD systemImage must be a system-images package identifier");
            if (deviceProfile && !ports.isSafeDeviceProfile(deviceProfile)) return androidLifecycleRefused("Android AVD deviceProfile contains unsupported characters for provider execution");
            if (ports.listOwnedAndroidAvdArtifacts(ports.ownerId(), { root: avdRoot })
                .some((artifact) => artifact.name === resolvedAvdName)) {
                return androidLifecycleRefused("Refusing Android AVD creation because owner-scoped artifacts already exist");
            }
            const r = ports.provisionAndroidAvd(discovery, { avdName: resolvedAvdName, systemImage, deviceProfile });
            if (!r.ok) {
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, { avdName: resolvedAvdName }),
                });
                if (!rollback.ok) {
                    return androidLifecycleRefused(`Android AVD create failed and partial artifact cleanup failed: ${rollback.error}`);
                }
                return { kind: "native-failure", diagnostic: r.diagnostic };
            }
        }

        const device = {
            id,
            name: deviceName,
            backend,
            kind: "mobile",
            platform: "android",
            ownerId: ports.ownerId(),
            avdName: resolvedAvdName,
            avdRoot,
            systemImage: systemImage || null,
            deviceProfile: deviceProfile || null,
            provisioned: shouldCreateAvd,
            port: allocation.port,
            headless: headless !== false,
            serial: ports.androidEmulatorSerial(allocation.port),
            appiumPort: ports.appiumPortForDevice(id),
            appium: null,
            status: "stopped",
            creatable: true,
            createdAt: ports.wallTimestamp(),
            updatedAt: ports.wallTimestamp(),
        };
        let claim;
        try {
            claim = ports.claimAndroidDevice(device);
        } catch (error) {
            if (shouldCreateAvd) {
                const discovery = ports.androidDiscovery();
                if (!ports.androidAvdIsInactive(discovery, device)) {
                    return androidLifecycleRefused("Owner device state update failed; Android AVD rollback blocked because liveness is unverified");
                }
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, device),
                });
                if (!rollback.ok) {
                    return androidLifecycleRefused(`Owner device state update failed; Android AVD rollback failed: ${rollback.error}`);
                }
            }
            throw error;
        }
        if (!claim.ok) {
            if (shouldCreateAvd && claim.existing?.avdName !== resolvedAvdName) {
                const discovery = ports.androidDiscovery();
                if (!ports.androidAvdIsInactive(discovery, device)) {
                    return androidLifecycleRefused("Device identity conflict for this owner; Android AVD rollback blocked because liveness is unverified");
                }
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, device),
                });
                if (!rollback.ok) {
                    return androidLifecycleRefused(`Device identity conflict for this owner (${claim.field}: ${claim.value}); Android AVD rollback failed: ${rollback.error}`);
                }
            }
            return androidLifecycleRefused(`Device identity already exists for this owner (${claim.field}: ${claim.value})`);
        }
        return { kind: "created", device };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args
     * @returns {Promise<import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleOutcome|undefined>} */
    async function start(args) {
        const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
        const device = ports.findAndroidDevice(deviceId);
        if (!device) return undefined;

        const discovery = ports.androidDiscovery();
        if (!discovery.available) {
            return androidLifecycleRefused(`Android backend missing prerequisites: ${discovery.missing.join(", ")}`);
        }
        if (!ports.isOwnedAvdName(device.avdName)) {
            return androidLifecycleRefused(`Refusing to start non-owned Android AVD name: ${device.avdName}`);
        }

        const livePorts = ports.liveAndroidEmulatorPortsForAllocation(discovery);
        if (!livePorts.ok) return androidLifecycleRefused(`${livePorts.error}: ${livePorts.detail}`);
        if (device.port && livePorts.ports.has(device.port)) {
            return androidLifecycleRefused(`android-emulator-port-conflict: port-${device.port}-already-in-use`);
        }

        const lifecycle = {
            runtimeId: ports.runtimeId(),
            operation: "start",
            claimedAt: ports.wallTimestamp(),
        };
        const claimed = {
            ...device,
            status: "starting",
            lifecycle,
            updatedAt: ports.wallTimestamp(),
        };
        const claim = ports.transitionAndroidDevice(deviceId, device, claimed);
        if (!claim.matched) return androidLifecycleConflict(deviceId, "start-claim", claim);

        let child;
        try {
            child = await ports.launchAndroidEmulator(discovery, device, args);
        } catch (error) {
            ports.transitionAndroidDevice(deviceId, claimed, device);
            return androidLifecycleRefused(`Android Emulator failed to start: ${error instanceof Error ? error.message : String(error)}`);
        }
        const processIdentity = await ports.waitForProcessIdentity(child.pid, 1000);
        if (!processIdentity) {
            const termination = await ports.terminateFreshAndroidEmulatorProcessTree(child);
            const unresolved = {
                ...claimed,
                pid: child.pid,
                runtime: {
                    runtimeId: lifecycle.runtimeId,
                    pid: child.pid,
                    processIdentity: null,
                    identityUnavailable: true,
                    provider: "android-emulator",
                    startedAt: ports.wallTimestamp(),
                },
                updatedAt: ports.wallTimestamp(),
            };
            const state = termination.ok
                ? ports.transitionAndroidDevice(deviceId, claimed, device)
                : ports.transitionAndroidDevice(deviceId, claimed, unresolved);
            return { kind: "identity-unavailable",
                deviceId,
                termination,
                stateReverted: termination.ok && state.matched,
                runtimeStatePreserved: !termination.ok && state.matched,
            };
        }
        const runtime = {
            runtimeId: lifecycle.runtimeId,
            pid: child.pid,
            processIdentity,
            startedAt: ports.wallTimestamp(),
            provider: "android-emulator",
        };
        const starting = {
            ...claimed,
            pid: child.pid,
            runtime,
            lifecycle: { ...lifecycle, startedAt: runtime.startedAt },
            updatedAt: ports.wallTimestamp(),
        };
        const started = ports.transitionAndroidDevice(deviceId, claimed, starting);
        if (!started.matched) {
            const rollback = await rollbackStartedAndroidEmulator(discovery, device, runtime);
            return androidLifecycleConflict(deviceId, "start-runtime", started, rollback);
        }

        if (!waitForBoot) return { kind: "started", device: starting, boot: { ready: false, skipped: true } };

        const boot = await ports.waitForAndroidBoot(discovery, starting, bootTimeoutMs, child);
        if (boot.reason === "emulator-process-exited") {
            const rollback = await rollbackStartedAndroidEmulator(discovery, device, runtime);
            const reverted = ports.transitionAndroidDevice(deviceId, starting, device);
            return { kind: "boot-process-exited",
                deviceId,
                boot,
                rollback,
                stateReverted: reverted.matched,
            };
        }
        const completed = {
            ...starting,
            status: boot.ready ? "running" : "starting",
            bootReady: boot.ready,
            lastBootCheck: boot,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionAndroidDevice(deviceId, starting, completed);
        if (!transition.matched) {
            const rollback = await rollbackStartedAndroidEmulator(discovery, device, runtime);
            return androidLifecycleConflict(deviceId, "start-complete", transition, rollback);
        }
        return { kind: "started", device: completed, boot };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args
     * @returns {Promise<import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleOutcome|undefined>} */
    async function stop(args) {
        const { deviceId } = args;
        const device = ports.findAndroidDevice(deviceId);
        if (!device) return undefined;
        const claim = claimAndroidLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return androidLifecycleConflict(deviceId, "stop-claim", claim.transition);

        const discovery = ports.androidDiscovery();
        const budget = ports.stopBudget(30000, 250);
        const admission = observeStop(discovery, device, budget);
        if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        if (admission.kind === "unavailable" || budget.remaining() <= 0) {
            const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "stop-unconfirmed", deviceId, reason: admission.kind === "unavailable" ? admission.reason : "deadline-exhausted", stateReverted: restored.matched };
        }
        const recorderSignal = ports.signalAndroidRecorder(device.recording);
        if (device.recording?.active && admission.serialPresent) {
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            if (budget.remaining() <= 0) {
                const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "stop-unconfirmed", deviceId, reason: "deadline-exhausted", stateReverted: restored.matched };
            }
            const recorderStop = ports.stopAndroidRecorder(discovery, device, budget);
            if (recorderStop && !recorderStop.ok) {
                abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "native-failure", diagnostic: recorderStop.diagnostic };
            }
        }
        if (recorderSignal.signaled) {
            await ports.waitForProcessExit((/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorRuntime} */ (device.recording)).pid, 1000);
        }
        if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        if (budget.remaining() <= 0) {
            const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "stop-unconfirmed", deviceId, reason: "deadline-exhausted", stateReverted: restored.matched };
        }
        if (admission.serialPresent) {
            const stopped = ports.stopAndroidEmulator(discovery, device, budget);
            if (stopped && !stopped.ok) {
                abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "native-failure", diagnostic: stopped.diagnostic };
            }
        }
        if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        const runtime = device.runtime ? ports.refreshOwnedRuntimeProcessIdentity(device.runtime) : null;
        if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        const runtimeStop = runtime
            ? await ports.terminateOwnedRuntimeProcessTree(runtime, "Android Emulator", { timeoutMs: 3000 })
            : null;
        if (runtimeStop && !runtimeStop.exited) {
            abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "runtime-stop-failed", deviceId, runtimeStop };
        }
        const confirmation = await confirmStopped(deviceId, claim.lifecycle, discovery, device, budget);
        if (confirmation.kind === "conflict") return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        if (confirmation.kind === "unconfirmed") {
            const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "stop-unconfirmed", deviceId, reason: confirmation.reason, stateReverted: restored.matched };
        }
        const current = currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        if (budget.remaining() <= 0) {
            const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "stop-unconfirmed", deviceId, reason: "deadline-exhausted", stateReverted: restored.matched };
        }
        const updated = {
            ...current,
            status: "stopped",
            pid: null,
            runtime: null,
            lifecycle: null,
            appium: null,
            recording: null,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionAndroidDevice(deviceId, current, updated);
        if (!transition.matched) return androidLifecycleConflict(deviceId, "stop", transition);
        return { kind: "stopped", device: updated };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args
     * @returns {Promise<import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleOutcome|undefined>} */
    async function remove(args) {
        const { deviceId, force = false, deleteAvd = false } = args;
        const devices = ports.readAndroidDevices();
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return undefined;
        if (!force && device.status !== "stopped") {
            return androidLifecycleRefused(`Refusing to delete ${deviceId} while status is ${device.status}`);
        }
        /** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery | null} */
        let discovery = null;
        if (deleteAvd) {
            if (!ports.isOwnedAvdName(device.avdName)) {
                return androidLifecycleRefused(`Refusing to delete non-owned Android AVD name: ${device.avdName}`);
            }
            discovery = ports.androidDiscovery();
            if (!discovery.adbAvailable) {
                return androidLifecycleRefused("Android AVD cleanup missing prerequisite: adb");
            }
        }
        const claim = claimAndroidLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return androidLifecycleConflict(deviceId, "delete-claim", claim.transition);
        /** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice | null} */
        let deleteCurrent = null;
        if (force) {
            discovery ||= ports.androidDiscovery();
            const budget = ports.stopBudget(30000, 250);
            const admission = observeStop(discovery, device, budget);
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            if (admission.kind === "unavailable" || budget.remaining() <= 0) {
                const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "force-delete-stop-failed", deviceId, adbStop: null, runtimeStop: null, reason: admission.kind === "unavailable" ? admission.reason : "deadline-exhausted", stateReverted: restored.matched };
            }
            const adbStop = admission.serialPresent ? ports.stopAndroidEmulator(discovery, device, budget) : null;
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            const runtime = device.runtime ? ports.refreshOwnedRuntimeProcessIdentity(device.runtime) : null;
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            const runtimeStop = runtime
                ? await ports.terminateOwnedRuntimeProcessTree(runtime, "Android Emulator", { timeoutMs: 3000 })
                : null;
            if ((adbStop && !adbStop.ok) || (runtimeStop && !runtimeStop.exited)) {
                const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "force-delete-stop-failed", deviceId, adbStop: adbStop?.diagnostic ?? null, runtimeStop, stateReverted: restored.matched };
            }
            const confirmation = await confirmStopped(deviceId, claim.lifecycle, discovery, device, budget);
            if (confirmation.kind === "conflict") return androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            if (confirmation.kind === "unconfirmed") {
                const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "force-delete-stop-failed", deviceId, adbStop: adbStop?.diagnostic ?? null, runtimeStop, reason: confirmation.reason, stateReverted: restored.matched };
            }
            const current = currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            if (budget.remaining() <= 0) {
                const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return { kind: "force-delete-stop-failed", deviceId, adbStop: adbStop?.diagnostic ?? null, runtimeStop, reason: "deadline-exhausted", stateReverted: restored.matched };
            }
            const stopped = {
                ...current,
                status: "stopped",
                pid: null,
                runtime: null,
                bootReady: false,
                updatedAt: ports.wallTimestamp(),
            };
            const stoppedTransition = ports.transitionAndroidDevice(deviceId, current, stopped);
            if (!stoppedTransition.matched) return androidLifecycleConflict(deviceId, "delete-stop", stoppedTransition);
            deleteCurrent = stopped;
        }
        if (deleteAvd) {
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "delete", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            if (!ports.androidAvdIsInactive(/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} */ (discovery), deleteCurrent || device)) {
                abortAndroidLifecycle(deviceId, claim.lifecycle, deleteCurrent ? { ...deleteCurrent, lifecycle: null } : device);
                return androidLifecycleRefused("android-avd-active-or-liveness-unverified");
            }
            const avdRoot = ports.approvedAndroidAvdRoot(device.avdRoot);
            if (!avdRoot) {
                abortAndroidLifecycle(deviceId, claim.lifecycle, deleteCurrent ? { ...deleteCurrent, lifecycle: null } : device);
                return androidLifecycleRefused("android-avd-root-unavailable");
            }
            if (!currentAndroidLifecycleDevice(deviceId, claim.lifecycle)) return androidLifecycleConflict(deviceId, "delete", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
            const deletion = ports.deleteOwnedAndroidAvd(device.avdName, {
                avdRoot,
                verifyInactive: () => ports.androidAvdIsInactive(/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} */ (discovery), deleteCurrent || device),
            });
            if (!deletion.ok) {
                abortAndroidLifecycle(deviceId, claim.lifecycle, deleteCurrent ? { ...deleteCurrent, lifecycle: null } : device);
                return androidLifecycleRefused(`Android AVD artifact cleanup failed: ${deletion.error}`);
            }
        }
        const current = currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return androidLifecycleConflict(deviceId, "delete", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        const transition = ports.transitionAndroidDevice(deviceId, current, null);
        if (!transition.matched) return androidLifecycleConflict(deviceId, "delete", transition);
        return { kind: "deleted", deviceId, avdDeleted: Boolean(deleteAvd) };
    }

    return { create, start, stop, delete: remove };
}
