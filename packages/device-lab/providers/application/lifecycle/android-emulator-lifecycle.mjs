/** Compose the direct variant without capturing native getters before their phase.
 * @template Result
 * @template {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorProcessHandle} [Child=import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorProcessHandle]
 * @param {import('../../ports/lifecycle/android-emulator-lifecycle.mjs').AndroidEmulatorLifecyclePorts<Result, Child>} ports
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

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} discovery
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice} device
     * @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorRuntime} runtime */
    async function rollbackStartedAndroidEmulator(discovery, device, runtime) {
        const serial = ports.androidSerial(device);
        const adb = discovery.adb && serial
            ? ports.run(discovery.adb, ["-s", serial, "emu", "kill"])
            : null;
        const processTree = await ports.terminateOwnedRuntimeProcessTree(ports.refreshOwnedRuntimeProcessIdentity(runtime), "Android Emulator superseded startup", { timeoutMs: 3000 });
        return {
            ok: Boolean(adb?.status === 0 || processTree.exited),
            adb: adb ? { status: adb.status, stdout: adb.stdout, stderr: adb.stderr } : null,
            processTree,
        };
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args */
    async function create(args) {
        const { backend, name: deviceName, deviceId, avdName, port, systemImage, deviceProfile, createAvd = false, headless = true } = args;
        if (backend !== "android-emulator") return undefined;

        const id = deviceId || ports.androidDeviceId(deviceName);
        let allocation = ports.resolveAndroidEmulatorPort(ports.ownerId(), id, port);
        if (!allocation.ok) {
            const detail = allocation.detail ? `: ${allocation.detail}` : allocation.allowed ? ` (${allocation.allowed})` : "";
            return ports.textResult(false, `${allocation.error}${detail}`);
        }
        const livePorts = ports.liveAndroidEmulatorPortsForAllocation();
        if (!livePorts.ok) return ports.textResult(false, `${livePorts.error}: ${livePorts.detail}`);
        if (livePorts.ports.has(allocation.port)) {
            allocation = ports.resolveAndroidEmulatorPort(ports.ownerId(), id, port, livePorts.ports);
            if (!allocation.ok) {
                const detail = allocation.detail ? `: ${allocation.detail}` : "";
                return ports.textResult(false, `${allocation.error}${detail}`);
            }
        }
        const devices = ports.readAndroidDevices();
        if (devices.some((device) => device.id === id)) {
            return ports.textResult(false, `Device already exists for this owner: ${id}`);
        }

        const resolvedAvdName = avdName || `${ports.ownerAvdPrefix()}${ports.slug(deviceName)}`;
        const shouldCreateAvd = Boolean(createAvd);
        const avdRoot = shouldCreateAvd ? ports.androidAvdHome() : null;
        if (shouldCreateAvd && !ports.isOwnedAvdName(resolvedAvdName)) {
            return ports.textResult(false, `Refusing to create non-owned Android AVD name: ${resolvedAvdName}`);
        }
        if (shouldCreateAvd && !ports.isSafeProvisionedAvdName(resolvedAvdName)) {
            return ports.textResult(false, "Android AVD name contains unsupported characters for provider execution");
        }
        if (shouldCreateAvd) {
            const discovery = ports.androidDiscovery();
            if (!discovery.provisioningAvailable) {
                return ports.textResult(false, `Android AVD provisioning missing prerequisites: ${discovery.provisioningMissing.join(", ")}`);
            }
            if (!systemImage) return ports.textResult(false, "Android AVD provisioning requires systemImage");
            if (!ports.isSafeSystemImage(systemImage)) return ports.textResult(false, "Android AVD systemImage must be a system-images package identifier");
            if (deviceProfile && !ports.isSafeDeviceProfile(deviceProfile)) return ports.textResult(false, "Android AVD deviceProfile contains unsupported characters for provider execution");
            if (ports.listOwnedAndroidAvdArtifacts(ports.ownerId(), { root: avdRoot })
                .some((artifact) => artifact.name === resolvedAvdName)) {
                return ports.textResult(false, "Refusing Android AVD creation because owner-scoped artifacts already exist");
            }
            const avdArgs = ["create", "avd", "--name", resolvedAvdName, "--package", systemImage, "--force"];
            if (deviceProfile) avdArgs.push("--device", deviceProfile);
            const r = ports.runWithInput(discovery.avdmanager, avdArgs, "no\n", { timeout: 300_000 });
            if (r.status !== 0) {
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, { avdName: resolvedAvdName }),
                });
                if (!rollback.ok) {
                    return ports.textResult(false, `Android AVD create failed and partial artifact cleanup failed: ${rollback.error}`);
                }
                return ports.fail(r);
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
            serial: `emulator-${allocation.port}`,
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
                    return ports.textResult(false, "Owner device state update failed; Android AVD rollback blocked because liveness is unverified");
                }
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, device),
                });
                if (!rollback.ok) {
                    return ports.textResult(false, `Owner device state update failed; Android AVD rollback failed: ${rollback.error}`);
                }
            }
            throw error;
        }
        if (!claim.ok) {
            if (shouldCreateAvd && claim.existing?.avdName !== resolvedAvdName) {
                const discovery = ports.androidDiscovery();
                if (!ports.androidAvdIsInactive(discovery, device)) {
                    return ports.textResult(false, "Device identity conflict for this owner; Android AVD rollback blocked because liveness is unverified");
                }
                const rollback = ports.deleteOwnedAndroidAvd(resolvedAvdName, {
                    avdRoot,
                    verifyInactive: () => ports.androidAvdIsInactive(discovery, device),
                });
                if (!rollback.ok) {
                    return ports.textResult(false, `Device identity conflict for this owner (${claim.field}: ${claim.value}); Android AVD rollback failed: ${rollback.error}`);
                }
            }
            return ports.textResult(false, `Device identity already exists for this owner (${claim.field}: ${claim.value})`);
        }
        return ports.jsonResult({ device: ports.publicAndroidDevice(device) });
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args */
    async function start(args) {
        const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
        const device = ports.findAndroidDevice(deviceId);
        if (!device) return undefined;

        const discovery = ports.androidDiscovery();
        if (!discovery.available) {
            return ports.textResult(false, `Android backend missing prerequisites: ${discovery.missing.join(", ")}`);
        }
        if (!ports.isOwnedAvdName(device.avdName)) {
            return ports.textResult(false, `Refusing to start non-owned Android AVD name: ${device.avdName}`);
        }

        const livePorts = ports.liveAndroidEmulatorPortsForAllocation(discovery);
        if (!livePorts.ok) return ports.textResult(false, `${livePorts.error}: ${livePorts.detail}`);
        if (device.port && livePorts.ports.has(device.port)) {
            return ports.textResult(false, `android-emulator-port-conflict: port-${device.port}-already-in-use`);
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
        if (!claim.matched) return ports.androidLifecycleConflict(deviceId, "start-claim", claim);

        const emulatorArgs = ["-avd", device.avdName, ...(device.port ? ["-port", String(device.port)] : []), ...ports.androidEmulatorStartArgs(device, args)];
        let child;
        try {
            child = await ports.spawnAndroidEmulator(discovery, device, emulatorArgs);
        } catch (error) {
            ports.transitionAndroidDevice(deviceId, claimed, device);
            return ports.textResult(false, `Android Emulator failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
            return ports.textResult(false, JSON.stringify({
                ok: false,
                error: "android-emulator-process-identity-unavailable",
                backend: "android-emulator",
                deviceId,
                termination,
                stateReverted: termination.ok && state.matched,
                runtimeStatePreserved: !termination.ok && state.matched,
            }));
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
            return ports.androidLifecycleConflict(deviceId, "start-runtime", started, rollback);
        }

        if (!waitForBoot) return ports.jsonResult({ device: ports.publicAndroidDevice(starting), boot: { ready: false, skipped: true } });

        const boot = await ports.waitForAndroidBoot(discovery, starting, bootTimeoutMs, child);
        if (boot.reason === "emulator-process-exited") {
            const rollback = await rollbackStartedAndroidEmulator(discovery, device, runtime);
            const reverted = ports.transitionAndroidDevice(deviceId, starting, device);
            return ports.textResult(false, JSON.stringify({
                ok: false,
                error: "android-emulator-process-exited-during-boot",
                backend: "android-emulator",
                deviceId,
                boot,
                rollback,
                stateReverted: reverted.matched,
            }));
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
            return ports.androidLifecycleConflict(deviceId, "start-complete", transition, rollback);
        }
        return ports.jsonResult({ device: ports.publicAndroidDevice(completed), boot });
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args */
    async function stop(args) {
        const { deviceId } = args;
        const device = ports.findAndroidDevice(deviceId);
        if (!device) return undefined;
        const claim = claimAndroidLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return ports.androidLifecycleConflict(deviceId, "stop-claim", claim.transition);

        const discovery = ports.androidDiscovery();
        const serial = ports.androidSerial(device);
        const recorderSignal = ports.signalOwnedRuntimeProcess(device.recording, "SIGINT");
        if (device.recording?.active && discovery.adb && serial) {
            ports.run(discovery.adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"]);
        }
        if (recorderSignal.signaled) {
            await ports.waitForProcessExit((/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorRuntime} */ (device.recording)).pid, 1000);
        }
        if (discovery.adb && serial) {
            const state = ports.run(discovery.adb, ["-s", serial, "get-state"]);
            if (state.status === 0) {
                const stopped = ports.run(discovery.adb, ["-s", serial, "emu", "kill"]);
                if (stopped.status !== 0) {
                    abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                    return ports.fail(stopped);
                }
            }
        }
        const runtimeStop = device.runtime
            ? await ports.terminateOwnedRuntimeProcessTree(ports.refreshOwnedRuntimeProcessIdentity(device.runtime), "Android Emulator", { timeoutMs: 3000 })
            : null;
        if (runtimeStop && !runtimeStop.exited) {
            abortAndroidLifecycle(deviceId, claim.lifecycle, device);
            return ports.textResult(false, JSON.stringify({
                ok: false,
                error: "android-emulator-process-stop-failed",
                backend: "android-emulator",
                deviceId,
                runtimeStop,
            }));
        }
        const current = currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return ports.androidLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
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
        if (!transition.matched) return ports.androidLifecycleConflict(deviceId, "stop", transition);
        return ports.jsonResult({ device: ports.publicAndroidDevice(updated) });
    }

    /** @param {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorLifecycleInput} args */
    async function remove(args) {
        const { deviceId, force = false, deleteAvd = false } = args;
        const devices = ports.readAndroidDevices();
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return undefined;
        if (!force && device.status !== "stopped") {
            return ports.textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
        }
        /** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery | null} */
        let discovery = null;
        if (deleteAvd) {
            if (!ports.isOwnedAvdName(device.avdName)) {
                return ports.textResult(false, `Refusing to delete non-owned Android AVD name: ${device.avdName}`);
            }
            discovery = ports.androidDiscovery();
            if (!discovery.adb) {
                return ports.textResult(false, "Android AVD cleanup missing prerequisite: adb");
            }
        }
        const claim = claimAndroidLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return ports.androidLifecycleConflict(deviceId, "delete-claim", claim.transition);
        /** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDevice | null} */
        let deleteCurrent = null;
        if (force) {
            discovery ||= ports.androidDiscovery();
            const serial = ports.androidSerial(device);
            /** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorCommandResult | null} */
            let adbStop = null;
            let adbLive = false;
            if (discovery.adb && serial) {
                const state = ports.run(discovery.adb, ["-s", serial, "get-state"]);
                adbLive = state.status === 0;
                if (state.status === 0) {
                    const stopped = ports.run(discovery.adb, ["-s", serial, "emu", "kill"]);
                    adbStop = { status: stopped.status, stdout: stopped.stdout, stderr: stopped.stderr };
                }
            }
            const needsStop = device.status !== "stopped" || adbLive;
            if (needsStop) {
                const runtimeStop = device.runtime
                    ? await ports.terminateOwnedRuntimeProcessTree(ports.refreshOwnedRuntimeProcessIdentity(device.runtime), "Android Emulator", { timeoutMs: 3000 })
                    : null;
                const runtimePid = device.runtime?.pid || device.pid;
                const adbProcessExited = adbStop?.status === 0 && runtimePid
                    ? await ports.waitForProcessExit(runtimePid, 3000)
                    : false;
                const runtimeStopped = runtimeStop?.exited === true || adbProcessExited;
                const adbStopped = adbStop?.status === 0;
                if ((runtimeStop && !runtimeStopped) || (!runtimeStop && !adbStopped)) {
                    const restored = abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                    return ports.textResult(false, JSON.stringify({
                        ok: false,
                        error: "android-emulator-force-delete-stop-failed",
                        backend: "android-emulator",
                        deviceId,
                        adbStop,
                        runtimeStop,
                        stateReverted: restored.matched,
                    }));
                }
                const current = currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
                if (!current) return ports.androidLifecycleConflict(deviceId, "delete-stop", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
                const stopped = {
                    ...current,
                    status: "stopped",
                    pid: null,
                    runtime: null,
                    bootReady: false,
                    lifecycle: null,
                    updatedAt: ports.wallTimestamp(),
                };
                const stoppedTransition = ports.transitionAndroidDevice(deviceId, current, stopped);
                if (!stoppedTransition.matched) return ports.androidLifecycleConflict(deviceId, "delete-stop", stoppedTransition);
                deleteCurrent = stopped;
            }
        }
        if (deleteAvd) {
            if (!ports.androidAvdIsInactive(/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} */ (discovery), deleteCurrent || device)) {
                if (!deleteCurrent) abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return ports.textResult(false, "android-avd-active-or-liveness-unverified");
            }
            const avdRoot = ports.approvedAndroidAvdRoot(device.avdRoot);
            if (!avdRoot) {
                if (!deleteCurrent) abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return ports.textResult(false, "android-avd-root-unavailable");
            }
            const deletion = ports.deleteOwnedAndroidAvd(device.avdName, {
                avdRoot,
                verifyInactive: () => ports.androidAvdIsInactive(/** @type {import("../../ports/lifecycle/android-emulator-lifecycle.mjs").AndroidEmulatorDiscovery} */ (discovery), deleteCurrent || device),
            });
            if (!deletion.ok) {
                if (!deleteCurrent) abortAndroidLifecycle(deviceId, claim.lifecycle, device);
                return ports.textResult(false, `Android AVD artifact cleanup failed: ${deletion.error}`);
            }
        }
        const current = deleteCurrent || currentAndroidLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return ports.androidLifecycleConflict(deviceId, "delete", { found: Boolean(ports.findAndroidDevice(deviceId)), matched: false });
        const transition = ports.transitionAndroidDevice(deviceId, current, null);
        if (!transition.matched) return ports.androidLifecycleConflict(deviceId, "delete", transition);
        return ports.jsonResult({ deleted: deviceId, avdDeleted: Boolean(deleteAvd) });
    }

    return { create, start, stop, delete: remove };
}
