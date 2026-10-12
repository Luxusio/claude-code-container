import { iosLifecycleClaimStatus, selectIosSimulatorMatches } from "../../domain/lifecycle/ios-simulator-lifecycle.mjs";
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorDevice} IosSimulatorDevice */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorDiscovery} IosSimulatorDiscovery */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorLifecycleClaim} IosSimulatorLifecycleClaim */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorTransition} IosSimulatorTransition */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorInventory} IosSimulatorInventory */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorAppium} IosSimulatorAppium */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorSettlement} IosSimulatorSettlement */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorBoot} IosSimulatorBoot */
/** @typedef {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorLifecycleInput} IosSimulatorLifecycleInput */
/** @param {import("../../ports/lifecycle/ios-simulator-lifecycle.mjs").IosSimulatorLifecyclePorts} ports
 */
export function createIosSimulatorLifecycle(ports) {
    /** @param {string | undefined} deviceId @param {string} operation @param {IosSimulatorTransition} transition @param {unknown} [rollback] */
    function iosLifecycleConflict(deviceId, operation, transition, rollback = null) {
        return { kind: /** @type {const} */ ("conflict"), payload: {
            ok: false,
            error: "owner-device-state-conflict",
            backend: "ios-simulator",
            deviceId,
            operation,
            found: transition.found,
            ...(rollback ? { rollback } : {}),
        } };
    }

    /** @param {string | undefined} deviceId @param {IosSimulatorDevice} device @param {string} operation */
    function claimIosLifecycle(deviceId, device, operation) {
        const lifecycle = {
            runtimeId: ports.runtimeId(),
            operation,
            claimedAt: ports.wallTimestamp(),
        };
        const claimed = {
            ...device,
            status: iosLifecycleClaimStatus(operation),
            lifecycle,
            updatedAt: ports.wallTimestamp(),
        };
        return { lifecycle, claimed, transition: ports.transitionIosDevice(deviceId, device, claimed) };
    }

    /** @param {string | undefined} deviceId @param {IosSimulatorLifecycleClaim} lifecycle */
    function currentIosLifecycleDevice(deviceId, lifecycle) {
        const current = ports.findIosDevice(deviceId);
        return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
    }

    /** @param {string | undefined} deviceId @param {IosSimulatorLifecycleClaim} lifecycle @param {IosSimulatorDevice} original @param {Partial<IosSimulatorDevice>} [actual] */
    function abortIosLifecycle(deviceId, lifecycle, original, actual = {}) {
        const current = currentIosLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean(ports.findIosDevice(deviceId)) };
        const restored = {
            ...current,
            status: original.status,
            ...actual,
            updatedAt: ports.wallTimestamp(),
        };
        if (Object.prototype.hasOwnProperty.call(actual, "lifecycle")) restored.lifecycle = actual.lifecycle;
        else if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
        else delete restored.lifecycle;
        return ports.transitionIosDevice(deviceId, current, restored);
    }

    /** @param {string | null} xcrun @param {IosSimulatorDevice} device @param {IosSimulatorInventory} [inventory] */
    function resolveOwnedSimulatorTarget(xcrun, device, inventory) {
        if (!ports.isOwnedSimulatorName(device?.simulatorName)) {
            return { error: `Refusing iOS Simulator operation for non-owned simulator name: ${device?.simulatorName}` };
        }
        const listed = inventory ?? ports.inventory(xcrun);
        if (listed.kind === "failed") {
            const detail = listed.message;
            return { error: `Unable to verify iOS Simulator ownership${detail ? `: ${detail}` : ""}` };
        }
        const matches = selectIosSimulatorMatches(listed.devices, device);
        if (matches.length !== 1) {
            return { error: `Unable to verify iOS Simulator ownership for ${device.id}: expected one host match, found ${matches.length}` };
        }
        const simulator = matches[0];
        if (simulator.name !== device.simulatorName || !ports.isOwnedSimulatorName(simulator.name) || typeof simulator.udid !== "string" || !simulator.udid) {
            return { error: `iOS Simulator ownership mismatch for ${device.id}: recorded ${device.simulatorName}, host ${simulator.name || "unknown"}` };
        }
        return { target: simulator.udid, simulator };
    }

    /** @param {IosSimulatorAppium | null | undefined} appium @param {string} label @returns {Promise<IosSimulatorSettlement>} */
    async function stopOwnedAppium(appium, label) {
        const ownsProcess = Boolean(appium?.runtimeId
            && appium.processOwner === "device-lab-mcp"
            && appium.startedBy === "direct-provider"
            && appium.serverPid
            && appium.processIdentity);
        if (!ownsProcess) {
            await ports.deleteAppiumSession(appium);
            return { exited: true, signaled: false, reason: "appium-process-identity-missing" };
        }
        const runtime = { ...appium, pid: /** @type {IosSimulatorAppium} */ (appium).serverPid };
        const observation = ports.inspectProcessIdentity(runtime.processIdentity, runtime.pid);
        if (observation.status === "exited") return { exited: true, signaled: false, reason: "runtime-process-exited" };
        if (observation.status !== "match") {
            const reason = observation.status === "mismatch"
                ? "runtime-process-identity-mismatch"
                : "runtime-process-identity-unavailable";
            return { exited: false, signaled: false, reason, error: `${label} process identity could not be verified: ${reason}` };
        }
        await ports.deleteAppiumSession(appium);
        return ports.terminateOwnedAppiumProcess(runtime, label);
    }


    /** @param {IosSimulatorLifecycleInput} args */
    async function create(args) {
        const { backend, name: deviceName, deviceId, simulatorName, deviceType, runtime, udid, createSimulator = false } = args;
        if (backend !== "ios-simulator") return undefined;

        const id = deviceId || ports.iosDeviceId(deviceName);
        const devices = ports.readIosDevices();
        if (devices.some((device) => device.id === id)) {
            return textOutcome(`Device already exists for this owner: ${id}`);
        }

        const simulatorDisplayName = simulatorName || `${ports.ownerSimulatorPrefix()}${ports.slug(deviceName)}`;
        let createdUdid = udid || null;
        let provisioning = "definition-only";
        if (createSimulator) {
            if (!ports.isOwnedSimulatorName(simulatorDisplayName)) {
                return textOutcome(`Refusing to create non-owned iOS Simulator name: ${simulatorDisplayName}`);
            }
            if (!deviceType || !runtime) {
                return textOutcome("iOS Simulator provisioning requires deviceType and runtime");
            }
            const discovery = ports.iosDiscovery();
            if (!discovery.available) return textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
            const r = ports.createSimulator(discovery.xcrun, simulatorDisplayName, deviceType, runtime);
            if (r.kind === "failed") return commandOutcome(r.receipt);
            createdUdid = r.udid;
            provisioning = "created";
        }

        const device = {
            id,
            name: deviceName,
            backend,
            kind: "mobile",
            platform: "ios",
            ownerId: ports.ownerId(),
            simulatorName: simulatorDisplayName,
            deviceType: deviceType || null,
            runtime: runtime || null,
            udid: createdUdid,
            appiumPort: ports.appiumPortForIosDevice(id),
            appium: null,
            status: "stopped",
            creatable: true,
            provisioning,
            createdAt: ports.wallTimestamp(),
            updatedAt: ports.wallTimestamp(),
        };
        let claim;
        try {
            claim = ports.claimIosDevice(device);
        } catch (error) {
            if (provisioning === "created" && createdUdid) {
                const discovery = ports.iosDiscovery();
                const rollback = ports.simulatorOperation(discovery.xcrun, "delete", createdUdid);
                if (rollback.kind === "failed") {
                    return textOutcome(`Owner device state update failed; iOS Simulator rollback failed: ${rollback.message}`);
                }
            }
            throw error;
        }
        if (!claim.ok) {
            if (provisioning === "created" && createdUdid && claim.existing?.udid !== createdUdid) {
                const discovery = ports.iosDiscovery();
                const rollback = ports.simulatorOperation(discovery.xcrun, "delete", createdUdid);
                if (rollback.kind === "failed") {
                    return textOutcome(`Device identity conflict for this owner (${claim.field}: ${claim.value}); iOS Simulator rollback failed: ${rollback.message}`);
                }
            }
            return textOutcome(`Device identity already exists for this owner (${claim.field}: ${claim.value})`);
        }
        return jsonOutcome({ device: ports.withTargetStatus(device) });
    }

    /** @param {IosSimulatorLifecycleInput} args */
    async function deleteDevice(args) {
        const { deviceId, force = false, deleteSimulator = false } = args;
        const devices = ports.readIosDevices();
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return undefined;
        if (device.recording && !force) {
            return textOutcome(`Refusing to delete ${deviceId} while a recording is active or pending finalization; stop the recording or retry with force=true`);
        }
        if (!force && device.status !== "stopped") {
            return textOutcome(`Refusing to delete ${deviceId} while status is ${device.status}`);
        }
        let discovery = null;
        let ownedTarget = null;
        if (deleteSimulator) {
            discovery = ports.iosDiscovery();
            if (!discovery.available) return textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
            ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error !== undefined) return textOutcome(ownedTarget.error);
        }
        const claim = claimIosLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return iosLifecycleConflict(deviceId, "delete-claim", claim.transition);
        /** @type {Partial<IosSimulatorDevice>} */
        const actual = { lifecycle: null };
        if (device.recording?.active) {
            const recorderSignal = ports.signalOwnedRuntimeProcess(device.recording, "SIGINT");
            if (!recorderSignal.signaled && recorderSignal.reason !== "runtime-process-exited") {
                abortIosLifecycle(deviceId, claim.lifecycle, device);
                return textOutcome(`iOS Simulator recording process could not be safely stopped for ${deviceId} (${recorderSignal.reason || "unknown"}); device was not deleted.`);
            }
            if (recorderSignal.signaled) {
                const exited = await ports.waitForProcessExit(device.recording.pid, 3000);
                if (!exited) {
                    abortIosLifecycle(deviceId, claim.lifecycle, device);
                    return textOutcome(`iOS Simulator recording did not exit within 3000ms for ${deviceId}; device was not deleted.`);
                }
            }
            actual.recording = { ...device.recording, active: false, endedAt: ports.wallTimestamp() };
        }

        const appiumStop = await stopOwnedAppium(device.appium, "iOS Simulator Appium");
        if (!appiumStop.exited) {
            abortIosLifecycle(deviceId, claim.lifecycle, device, actual);
            return textOutcome(`${appiumStop.error}; device was not deleted.`);
        }
        actual.appium = null;

        if (deleteSimulator) {
            if (force && device.status !== "stopped") {
                const shutdown = ports.simulatorOperation(/** @type {IosSimulatorDiscovery} */ (discovery).xcrun, "shutdown", /** @type {{target: string}} */ (ownedTarget).target);
                if (shutdown.kind === "succeeded") {
                    actual.status = "stopped";
                    actual.bootReady = false;
                }
            }
            const r = ports.simulatorOperation(/** @type {IosSimulatorDiscovery} */ (discovery).xcrun, "delete", /** @type {{target: string}} */ (ownedTarget).target);
            if (r.kind === "failed") {
                abortIosLifecycle(deviceId, claim.lifecycle, device, actual);
                return commandOutcome(r.receipt);
            }
        }

        if (device.recording?.stagingPath) {
            const discarded = ports.discardLocalOutputStage(device.recording.stagingPath, {
                label: "recording-local-path",
                stageParent: ports.iosRecordingDir(device),
                stagePrefix: ".recording-stage-",
            });
            if (!discarded.ok) {
                if (deleteSimulator) {
                    const current = currentIosLifecycleDevice(deviceId, claim.lifecycle);
                    if (!current) return iosLifecycleConflict(deviceId, "delete-after-simulator-delete", { found: Boolean(ports.findIosDevice(deviceId)), matched: false });
                    const transition = ports.transitionIosDevice(deviceId, current, null);
                    if (!transition.matched) return iosLifecycleConflict(deviceId, "delete-after-simulator-delete", transition);
                    return textOutcome(`${discarded.message}; simulator and device metadata were deleted, but the staged recording requires explicit recovery`);
                }
                abortIosLifecycle(deviceId, claim.lifecycle, device, actual);
                return textOutcome(`${discarded.message}; device metadata was preserved for explicit recovery`);
            }
        }

        const current = currentIosLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return iosLifecycleConflict(deviceId, "delete", { found: Boolean(ports.findIosDevice(deviceId)), matched: false });
        const transition = ports.transitionIosDevice(deviceId, current, null);
        if (!transition.matched) return iosLifecycleConflict(deviceId, "delete", transition);
        return jsonOutcome({ deleted: deviceId, simulatorDeleted: Boolean(deleteSimulator) });
    }

    /** @param {IosSimulatorLifecycleInput} args */
    async function start(args) {
        const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
        const device = ports.findIosDevice(deviceId);
        if (!device) return undefined;

        const discovery = ports.iosDiscovery();
        if (!discovery.available) {
            return textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
        }
        const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
        if (ownedTarget.error !== undefined) return textOutcome(ownedTarget.error);
        const target = ownedTarget.target;
        const claim = claimIosLifecycle(deviceId, device, "start");
        if (!claim.transition.matched) return iosLifecycleConflict(deviceId, "start-claim", claim.transition);
        const r = ports.simulatorOperation(discovery.xcrun, "boot", target);
        if (r.kind === "failed") {
            abortIosLifecycle(deviceId, claim.lifecycle, device);
            return commandOutcome(r.receipt);
        }

        /** @type {IosSimulatorBoot} */
        let boot = { ready: true, skipped: true };
        if (waitForBoot) {
            boot = ports.waitForBoot(discovery.xcrun, target, bootTimeoutMs);
        }

        const updated = {
            ...claim.claimed,
            status: boot.ready ? "booted" : "starting",
            bootReady: boot.ready,
            lastBootCheck: boot,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionIosDevice(deviceId, claim.claimed, updated);
        if (!transition.matched) {
            const shutdown = ports.simulatorOperation(discovery.xcrun, "shutdown", target);
            const rollback = { ok: shutdown.kind === "succeeded", receipt: shutdown.receipt };
            return iosLifecycleConflict(deviceId, "start-complete", transition, rollback);
        }
        return jsonOutcome({ device: ports.withTargetStatus(updated), boot });
    }

    /** @param {IosSimulatorLifecycleInput} args */
    async function stop(args) {
        const { deviceId } = args;
        const device = ports.findIosDevice(deviceId);
        if (!device) return undefined;

        const discovery = ports.iosDiscovery();
        let ownedTarget = null;
        if (!discovery.available && device.status !== "stopped") {
            return textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
        }
        if (discovery.available) {
            ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error !== undefined) return textOutcome(ownedTarget.error);
        }
        const claim = claimIosLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return iosLifecycleConflict(deviceId, "stop-claim", claim.transition);
        if (device.recording?.active) {
            const recorderSignal = ports.signalOwnedRuntimeProcess(device.recording, "SIGINT");
            if (!recorderSignal.signaled && recorderSignal.reason !== "runtime-process-exited") {
                abortIosLifecycle(deviceId, claim.lifecycle, device);
                return textOutcome(`iOS Simulator recording process could not be safely stopped for ${deviceId} (${recorderSignal.reason || "unknown"}); recording metadata was preserved.`);
            }
            if (recorderSignal.signaled) {
                const exited = await ports.waitForProcessExit(device.recording.pid, 3000);
                if (!exited) {
                    abortIosLifecycle(deviceId, claim.lifecycle, device);
                    return textOutcome(`iOS Simulator recording did not exit within 3000ms for ${deviceId}; recording metadata was preserved.`);
                }
            }
        }
        if (discovery.available) {
            const shutdown = ports.simulatorOperation(/** @type {IosSimulatorDiscovery} */ (discovery).xcrun, "shutdown", /** @type {{target: string}} */ (ownedTarget).target);
            if (shutdown.kind === "failed") {
                abortIosLifecycle(deviceId, claim.lifecycle, device);
                return commandOutcome(shutdown.receipt);
            }
        }
        const appiumStop = await stopOwnedAppium(device.appium, "iOS Simulator Appium");
        if (!appiumStop.exited) {
            abortIosLifecycle(deviceId, claim.lifecycle, device, {
                status: "stopped",
                lifecycle: null,
                ...(device.recording?.active
                    ? { recording: { ...device.recording, active: false, endedAt: ports.wallTimestamp() } }
                    : {}),
            });
            return textOutcome(appiumStop.error);
        }
        const current = currentIosLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return iosLifecycleConflict(deviceId, "stop", { found: Boolean(ports.findIosDevice(deviceId)), matched: false });
        const recording = current.recording?.active
            ? { ...current.recording, active: false, endedAt: ports.wallTimestamp() }
            : current.recording ?? null;
        const updated = {
            ...current,
            status: "stopped",
            lifecycle: null,
            appium: null,
            recording,
            updatedAt: ports.wallTimestamp(),
        };
        const transition = ports.transitionIosDevice(deviceId, current, updated);
        if (!transition.matched) return iosLifecycleConflict(deviceId, "stop", transition);
        return jsonOutcome({ device: ports.withTargetStatus(updated) });
    }

    return { create, start, stop, delete: deleteDevice };
}

/** @param {string | undefined} message */
function textOutcome(message) { return { kind: /** @type {const} */ ("text"), message }; }
/** @param {unknown} payload */
function jsonOutcome(payload) { return { kind: /** @type {const} */ ("json"), payload }; }
/** @param {unknown} receipt */
function commandOutcome(receipt) { return { kind: /** @type {const} */ ("command-failure"), receipt }; }
