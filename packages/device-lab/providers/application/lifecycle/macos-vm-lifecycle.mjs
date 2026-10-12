import { defineMacosImageDevice } from "../../domain/macos-image-snapshots.mjs";
import { macosProviderInstanceReferenced, managedProviderResource, snapshotProviderInstances, restoreRecoveryProviderInstances, macosSshConfig } from "../../domain/lifecycle/macos-vm-lifecycle.mjs";
import { recordingGenerationMatches } from "../../domain/runtime-generation.mjs";
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice} MacosVmDevice */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleInput} MacosVmLifecycleInput */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleClaim} MacosVmLifecycleClaim */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativePlan} MacosVmNativePlan */

/** @param {string} message @returns {import('../../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycleOutcome} */
function refused(message) { return {kind:'refused',message}; }
/** @param {object} value @returns {import('../../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycleOutcome} */
function completedOutcome(value) { return {kind:'completed',value}; }
/** @param {object} value @returns {import('../../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycleOutcome} */
function problem(value) { return {kind:'problem',value}; }
/** @param {import('../../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmNativeObservation} observation @returns {import('../../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycleOutcome} */
function failed(observation) { return {kind:'failed',evidence:observation.evidence}; }

/** Complete direct policy; only trusted native leaves enter this composition.
 * @template {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmProcessHandle} Child
 * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecyclePorts<Child>} ports
 */
export function createMacosVmLifecycleApplication(ports) {
    /** @param {string | undefined} deviceId
     * @param {string} operation
     * @param {{found: boolean, matched?: boolean}} transition
     * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRollback | null} [rollback] */
    function macosLifecycleConflict(deviceId, operation, transition, rollback = null) {
        return problem({
            ok: false,
            error: "owner-device-state-conflict",
            backend: "macos-vm",
            deviceId,
            operation,
            found: transition.found,
            ...(rollback ? { rollback } : {}),
        });
    }

    /** @param {MacosVmDevice} device
     * @param {MacosVmLifecycleClaim | null} lifecycle
     * @param {Partial<MacosVmDevice>} [updates] */
    function macosLifecycleReplacement(device, lifecycle, updates = {}) {
        const replacement = {
            ...device,
            ...updates,
            updatedAt: (0, ports.timestamp)(),
        };
        if (lifecycle) replacement.lifecycle = lifecycle;
        else delete replacement.lifecycle;
        return replacement;
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmDevice} device
     * @param {string} operation
     * @param {Partial<MacosVmDevice>} [updates] */
    function claimMacosLifecycle(deviceId, device, operation, updates = {}) {
        const lifecycle = {
            runtimeId: (0, ports.runtimeId)(),
            operation,
            claimedAt: (0, ports.timestamp)(),
            previousStatus: device.status,
        };
        const claimed = macosLifecycleReplacement(device, lifecycle, {
            ...updates,
            status: operation === "delete"
                ? "deleting"
                : operation === "stop" || operation === "clone-source-stop"
                    ? "stopping"
                    : operation === "start"
                        ? "starting"
                        : device.status,
        });
        const transition = (0, ports.transition)(deviceId, device, claimed);
        return {
            lifecycle,
            claimed: transition.matched ? (0, ports.find)(deviceId) : claimed,
            transition,
        };
    }

    /** @param {MacosVmLifecycleClaim | null | undefined} lifecycle */
    function staleMacosLifecycle(lifecycle) {
        if (!lifecycle) return false;
        const claimedAt = (0, ports.parseLifecycleClaimedAt)(lifecycle.claimedAt || "");
        return !Number.isFinite(claimedAt) || (0, ports.now)() - claimedAt >= (0, ports.claimTtlMs)();
    }

    /** @param {string} deviceId */
    function recoverStaleMacosLifecycle(deviceId) {
        const device = (0, ports.find)(deviceId);
        if (!device?.lifecycle || !staleMacosLifecycle(device.lifecycle)) return { device };

        const lifecycle = device.lifecycle;
        if (lifecycle.operation === "start") {
            const plan = (0, ports.providerPlan)(device);
            if (!plan.stopAvailable) {
                return { error: refused( `Cannot recover stale macOS VM start lifecycle for ${deviceId}: provider stop is unavailable`) };
            }
            const stopped = ports.stopInstance(plan);
            if (!stopped.ok) {
                return { error: refused( `Cannot recover stale macOS VM start lifecycle for ${deviceId}: ${stopped.detail}`) };
            }
        }

        const previousStatus = typeof lifecycle.previousStatus === "string"
            ? lifecycle.previousStatus
            : lifecycle.operation === "start"
                ? "stopped"
                : device.runtime
                    ? "running"
                    : "stopped";
        const recovered = macosLifecycleReplacement(device, null, {
            status: previousStatus,
            ...(lifecycle.operation === "start" ? {
                runtime: null,
                bootReady: false,
                lastBootCheck: null,
            } : {}),
            lastLifecycleRecovery: {
                runtimeId: lifecycle.runtimeId || null,
                operation: lifecycle.operation || "unknown",
                claimedAt: lifecycle.claimedAt || null,
                recoveredAt: (0, ports.timestamp)(),
            },
        });
        const transition = (0, ports.transition)(deviceId, device, recovered);
        if (!transition.matched) {
            return { error: macosLifecycleConflict(deviceId, "stale-lifecycle-recovery", transition) };
        }
        return { device: transition.device };
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmLifecycleClaim} lifecycle */
    function currentMacosLifecycleDevice(deviceId, lifecycle) {
        const current = (0, ports.find)(deviceId);
        return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmLifecycleClaim} lifecycle
     * @param {MacosVmDevice} original
     * @param {Partial<MacosVmDevice>} [updates] */
    function abortMacosLifecycle(deviceId, lifecycle, original, updates = {}) {
        const current = currentMacosLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean((0, ports.find)(deviceId)) };
        const restored = macosLifecycleReplacement(current, original.lifecycle || null, {
            ...updates,
            status: updates.status ?? original.status,
        });
        return (0, ports.transition)(deviceId, current, restored);
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmLifecycleClaim} lifecycle
     * @param {(current: MacosVmDevice) => MacosVmDevice} updater */
    function transitionCurrentMacosLifecycle(deviceId, lifecycle, updater) {
        const current = currentMacosLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean((0, ports.find)(deviceId)) };
        return (0, ports.transition)(deviceId, current, updater(current));
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmLifecycleClaim} lifecycle
     * @param {MacosVmNativePlan} plan */
    function rollbackStartedMacosVm(deviceId, lifecycle, plan) {
        const current = (0, ports.find)(deviceId);
        if (current?.lifecycle?.runtimeId !== lifecycle.runtimeId && current?.providerInstance === plan.providerInstance) {
            return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: plan.providerInstance };
        }
        if (!plan.stopAvailable || !plan.providerInstance) {
            return { ok: false, attempted: false, reason: "provider-stop-command-unavailable", providerInstance: plan.providerInstance || null };
        }
        const stopped = ports.stopInstance(plan);
        return {
            ok: stopped.ok,
            attempted: true,
            providerInstance: plan.providerInstance,
            evidence: stopped.evidence,
        };
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmNativePlan} plan
     * @param {string} instance */
    function rollbackCreatedMacosResource(deviceId, plan, instance) {
        const current = (0, ports.find)(deviceId);
        if (macosProviderInstanceReferenced(current, instance)) {
            return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: instance };
        }
        const deleted = deleteInstance(plan, instance);
        return {
            ok: deleted.ok,
            attempted: true,
            providerInstance: instance,
            evidence: deleted.evidence,
        };
    }

    /** @param {MacosVmNativePlan} plan
     * @param {string | null | undefined} source
     * @param {string} target */
    function runTartClone(plan, source, target) {
        const result = ports.cloneInstance(plan, source, target);
        const cleanup = !result.ok && result.timedOut
            ? deleteInstance(plan, target)
            : null;
        return { result, cleanup };
    }

    /** @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation} result
     * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation | null} cleanup
     * @param {string} target */
    function tartCloneFailure(result, cleanup, target) {
        return {kind:'clone-failed',evidence:{ target, command: result, cleanup }};
    }

    /** @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation} command
     * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation|null} cleanup
     * @param {string} target
     * @returns {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosNativeCloneFailureEvidence} */
    function cloneFailureEvidence(command, cleanup, target) { return { target, command, cleanup }; }

    /** @param {MacosVmNativePlan} plan @param {string} instance */
    function deleteInstance(plan, instance) {
        return ports.deleteInstance(plan, instance);
    }

    /** @param {{id: string, name?: string, provider: string, image: string, memoryMb: number, cpus: number, ssh: import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmSsh | null, extra?: Partial<MacosVmDevice>}} options */
    function macosDeviceDefinition({ id, name, provider, image, memoryMb, cpus, ssh, extra = {} }) {
        return defineMacosImageDevice({ id, name, provider, image, memoryMb, cpus, ssh, extra }, {
            ownerId: (0, ports.owner)(),
            helper: (0, ports.helperMetadata)({ id, ssh }),
            createdAt: (0, ports.timestamp)(),
            updatedAt: (0, ports.timestamp)(),
        });
    }

    /** @param {MacosVmLifecycleInput} args */
    function createImage(args) {
        const name = "device_base_image_create";
        const { backend = "macos-vm", name: deviceName, deviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, headless = false, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword } = args;
        if (backend !== "macos-vm") return undefined;
        if (!sourceImage) return refused(`${name} requires sourceImage`);

        const id = deviceId || (0, ports.deviceId)(deviceName);
        const devices = (0, ports.read)();
        if (devices.some((device) => device.id === id)) {
            return refused( `Device already exists for this owner: ${id}`);
        }
        const sshKeyPolicy = (0, ports.validateSshKey)(sshKeyPath);
        if (!sshKeyPolicy.ok) return refused( sshKeyPolicy.message);

        const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider, image: sourceImage });
        const device = macosDeviceDefinition({
            id,
            name: deviceName,
            provider,
            image: sourceImage,
            memoryMb,
            cpus,
            ssh,
            extra: {
                imageSource: sourceImage,
                headless,
                provisioning: "image-created",
            },
        });
        const tart = (0, ports.tartPlan)(device, name);
        if (tart.error) return tart.error;
        const target = (/** @type {MacosVmNativePlan} */ (tart.plan)).providerInstance;
        const clone = runTartClone((/** @type {MacosVmNativePlan} */ (tart.plan)), sourceImage, target);
        const r = clone.result;
        if (!r.ok) return tartCloneFailure(r, clone.cleanup, target);

        const created = {
            ...device,
            provider: (/** @type {MacosVmNativePlan} */ (tart.plan)).selectedProvider,
            providerInstance: target,
            providerResourceManaged: true,
            imageCreatedAt: (0, ports.timestamp)(),
        };
        let claim;
        try {
            claim = (0, ports.claim)(created);
        } catch (error) {
            const rollback = ports.deleteInstance(/** @type {MacosVmNativePlan} */ (tart.plan), target);
            if (!rollback.ok) {
                return refused( `Owner device state update failed; macOS VM rollback failed: ${rollback.detail}`);
            }
            throw error;
        }
        if (!claim.ok) {
            if (claim.existing?.provider !== created.provider || claim.existing?.providerInstance !== target) {
                const rollback = ports.deleteInstance(/** @type {MacosVmNativePlan} */ (tart.plan), target);
                if (!rollback.ok) {
                    return refused( `Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${rollback.detail}`);
                }
            }
            return {kind:'identity-conflict',field:claim.field,value:claim.value};
        }
        return completedOutcome({
            operation: "base-image-create",
            device: created,
            native: r.evidence,
        });
    }

    /** @param {MacosVmLifecycleInput} args */
    function create(args) {
        if (args.backend === "macos-vm" && (args.sourceImage || args.image)) {
            const imageArgs = { ...args, sourceImage: args.sourceImage || args.image };
            // Preserve the recursive original entry prelude before image provisioning.
            for (const candidate of [imageArgs?.deviceId, imageArgs?.sourceDeviceId]) {
                if (typeof candidate !== "string") continue;
                const recovery = recoverStaleMacosLifecycle(candidate);
                if (recovery.error) return recovery.error;
            }
            return createImage(imageArgs);
        }
        const { backend, name: deviceName, deviceId, provider = "auto", image = null, memoryMb = 4096, cpus = 4, headless = false, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword } = args;
        if (backend !== "macos-vm") return undefined;

        const id = deviceId || (0, ports.deviceId)(deviceName);
        const devices = (0, ports.read)();
        if (devices.some((device) => device.id === id)) {
            return refused( `Device already exists for this owner: ${id}`);
        }
        const sshKeyPolicy = (0, ports.validateSshKey)(sshKeyPath);
        if (!sshKeyPolicy.ok) return refused( sshKeyPolicy.message);
        const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider, image });

        const device = {
            id,
            name: deviceName,
            backend,
            kind: "desktop",
            platform: "macos",
            ownerId: (0, ports.owner)(),
            provider,
            image,
            memoryMb,
            cpus,
            headless: Boolean(headless),
            providerInstance: `ccc-${(0, ports.owner)()}-${id}`,
            ssh,
            helper: (0, ports.helperMetadata)({ id, ssh }),
            status: "stopped",
            creatable: true,
            createdAt: (0, ports.timestamp)(),
            updatedAt: (0, ports.timestamp)(),
        };
        const claim = (0, ports.claim)(device);
        if (!claim.ok) {
            return {kind:'identity-conflict',field:claim.field,value:claim.value};
        }
        return completedOutcome({ device: device });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function start(args) {
        const { deviceId, headless, waitForBoot = true, bootTimeoutMs = 300000 } = args;
        const startDeadlineAt = (0, ports.now)() + (Number.isFinite(bootTimeoutMs) ? Math.min(600000, Math.max(1000, bootTimeoutMs)) : 300000);
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (device.status !== "stopped" || device.lifecycle) {
            return refused( `Refusing to start ${deviceId} while status is ${device.status}${device.lifecycle ? ` and lifecycle operation ${device.lifecycle.operation || "unknown"} is active` : ""}`);
        }
        const keyPolicy = (0, ports.validateSshKey)(device.ssh?.keyPath);
        if (!keyPolicy.ok) return refused( keyPolicy.message);
        const safeDevice = device.ssh?.keyPath && keyPolicy.path !== device.ssh.keyPath
            ? { ...device, ssh: { ...device.ssh, keyPath: keyPolicy.path } }
            : device;
        const startDevice = headless === undefined ? safeDevice : { ...safeDevice, headless: Boolean(headless) };

        const plan = (0, ports.providerPlan)(startDevice);
        if (!plan.available) {
            return refused( `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
        }

        const claim = claimMacosLifecycle(deviceId, device, "start", {
            provider: plan.selectedProvider,
            providerInstance: plan.providerInstance,
            ssh: startDevice.ssh,
            headless: startDevice.headless,
        });
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "start-claim", claim.transition);

        const {child,startCommand} = ports.launchProvider(plan,startDevice);
        const startError = await (0, ports.waitProviderStart)(child);
        if (startError) {
            abortMacosLifecycle(deviceId, claim.lifecycle, device);
            return startError;
        }
        child.unref();

        /** @type {MacosVmDevice} */
        const startedDevice = {
            ...startDevice,
            provider: plan.selectedProvider,
            providerInstance: plan.providerInstance,
            status: waitForBoot ? "starting" : "running",
            runtime: {
                runtimeId: claim.lifecycle.runtimeId,
                providerPid: child.pid || null,
                startedAt: (0, ports.timestamp)(),
                startCommand,
                detached: true,
            },
        };
        const started = macosLifecycleReplacement(/** @type {MacosVmDevice} */ (claim.claimed), claim.lifecycle, {
            provider: plan.selectedProvider,
            providerInstance: plan.providerInstance,
            ssh: startedDevice.ssh,
            headless: startedDevice.headless,
            status: "starting",
            runtime: startedDevice.runtime,
        });
        const startedTransition = (0, ports.transition)(deviceId, claim.claimed, started);
        if (!startedTransition.matched) {
            const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
            return macosLifecycleConflict(deviceId, "start-runtime", startedTransition, rollback);
        }
        const persistedStarted = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
        if (!persistedStarted) {
            const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
            return macosLifecycleConflict(deviceId, "start-runtime-readback", { found: Boolean((0, ports.find)(deviceId)), matched: false }, rollback);
        }
        const boot = waitForBoot ? await (0, ports.waitBoot)(plan, bootTimeoutMs, startDeadlineAt) : { ready: false, skipped: true };
        startedDevice.status = boot.ready || boot.skipped ? "running" : "starting";
        startedDevice.bootReady = boot.ready;
        startedDevice.lastBootCheck = boot;
        if (boot.ready && boot.ip && startedDevice.ssh?.user && !startedDevice.ssh.host) {
            startedDevice.ssh = { ...startedDevice.ssh, host: boot.ip };
        }
        const provision = waitForBoot
            ? await (0, ports.waitGuestHelper)(startedDevice, startDeadlineAt)
            : (0, ports.provisionHelper)(startedDevice);
        const completed = macosLifecycleReplacement(persistedStarted, null, {
            provider: plan.selectedProvider,
            providerInstance: plan.providerInstance,
            ssh: startedDevice.ssh,
            headless: startedDevice.headless,
            helper: (0, ports.helperMetadata)({ ...startedDevice, helper: { ...(persistedStarted.helper || {}), provisioning: provision.provisioning } }),
            status: startedDevice.status,
            runtime: startedDevice.runtime,
            bootReady: startedDevice.bootReady,
            lastBootCheck: startedDevice.lastBootCheck,
        });
        const completedTransition = (0, ports.transition)(deviceId, persistedStarted, completed);
        if (!completedTransition.matched) {
            const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
            return macosLifecycleConflict(deviceId, "start-complete", completedTransition, rollback);
        }
        const updated = /** @type {MacosVmDevice} */ (completedTransition.device);
        if (waitForBoot && !boot.ready && !boot.skipped) {
            return problem({ ok: false, error: "macos-boot-not-ready", device: updated, boot });
        }
        if (!provision.ok) {
            return problem({
                ok: false,
                error: provision.error,
                command: provision.command,
                device: updated,
                helper: provision.provisioning,
                providerStart: startedDevice.runtime,
                boot,
            });
        }
        return completedOutcome({ device: updated, helper: provision.provisioning, providerStart: startedDevice.runtime, boot });
    }

    /** @param {MacosVmDevice} device */
    async function stopRecording(device) {
        const recording = device.recording;
        if (!recording) return { ok: true };
        const signal = (0, ports.signalRecording)(recording, "SIGINT");
        if (!signal.signaled && signal.exited !== true) return { ok: false, reason: signal.reason || "runtime-process-signal-refused" };
        if (signal.signaled && recording.active) {
            ports.interruptGuestRecording(device,recording);
        }
        const exited = await (0, ports.waitRecordingExit)(recording, 1000);
        return exited === true ? { ok: true } : { ok: false, reason: "runtime-process-exit-unconfirmed" };
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmLifecycleClaim} lifecycle
     * @param {MacosVmDevice} device
     * @param {Partial<MacosVmDevice>} updates
     * @param {string | undefined} reason */
    function recordingCleanupIncomplete(deviceId, lifecycle, device, updates, reason) {
        const restored = abortMacosLifecycle(deviceId, lifecycle, device, updates);
        if (!restored.matched) return macosLifecycleConflict(deviceId, "recording-cleanup", restored);
        return problem({
            ok: false, error: "macos-recording-cleanup-incomplete", deviceId, reason,
        });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function stop(args) {
        const { deviceId } = args;
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (device.lifecycle) {
            return refused( `Refusing to stop ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
        }
        const claim = claimMacosLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "stop-claim", claim.transition);

        const plan = (0, ports.providerPlan)(device);
        if (device.status !== "stopped" && (!plan.available || !plan.stopAvailable)) {
            abortMacosLifecycle(deviceId, claim.lifecycle, device);
            return refused( `macOS VM stop is unavailable for ${deviceId}: ${plan.missing?.join(", ") || "provider stop command missing"}`);
        }
        if (plan.stopAvailable && device.providerInstance && device.status !== "stopped") {
            const r = ports.stopInstance(plan);
            if (!r.ok) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return failed(r);
            }
        }

        const recordingCleanup = await stopRecording(device);
        if (!recordingCleanup.ok) {
            return recordingCleanupIncomplete(deviceId, claim.lifecycle, device, {
                status: "stopped", runtime: null, bootReady: false, lastBootCheck: null,
            }, recordingCleanup.reason);
        }
        const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return macosLifecycleConflict(deviceId, "stop", { found: Boolean((0, ports.find)(deviceId)), matched: false });
        if (!recordingGenerationMatches(device.recording, current.recording)) {
            return recordingCleanupIncomplete(deviceId, claim.lifecycle, device, {
                status: "stopped", runtime: null, bootReady: false, lastBootCheck: null,
            }, "recording-generation-changed");
        }
        const stopped = macosLifecycleReplacement(current, null, {
            status: "stopped",
            runtime: null,
            bootReady: false,
            lastBootCheck: null,
            recording: null,
        });
        const transition = (0, ports.transition)(deviceId, current, stopped);
        if (!transition.matched) return macosLifecycleConflict(deviceId, "stop", transition);
        return completedOutcome({ device: /** @type {MacosVmDevice} */ (transition.device) });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function remove(args) {
        const name = "device_delete";
        const { deviceId, force = false } = args;
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (!force && device.status !== "stopped") {
            return refused( `Refusing to delete ${deviceId} while status is ${device.status}`);
        }
        if (device.lifecycle) {
            return refused( `Refusing to delete ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
        }
        const claim = claimMacosLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "delete-claim", claim.transition);
        let forcedStopPlan = null;
        let forcedStopUpdates = {};
        if (force && device.status !== "stopped") {
            const plan = (0, ports.providerPlan)(device);
            if (!plan.available) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return refused( `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
            }
            if (plan.stopAvailable) {
                const stop = ports.stopInstance(plan);
                if (!stop.ok) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return failed(stop);
                }
                forcedStopPlan = plan;
                forcedStopUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null,
                };
            }
        }
        const recordingCleanup = await stopRecording(device);
        if (!recordingCleanup.ok) {
            return recordingCleanupIncomplete(deviceId, claim.lifecycle, device, forcedStopUpdates, recordingCleanup.reason);
        }
        const recordingOwner = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
        if (!recordingOwner) return macosLifecycleConflict(deviceId, "delete-recording-cleanup", { found: Boolean((0, ports.find)(deviceId)), matched: false });
        if (!recordingGenerationMatches(device.recording, recordingOwner.recording)) {
            return recordingCleanupIncomplete(deviceId, claim.lifecycle, device, forcedStopUpdates, "recording-generation-changed");
        }
        if (forcedStopPlan) forcedStopUpdates = { ...forcedStopUpdates, recording: null };
        /** @type {Array<{kind: string, id?: string, instance: string}>} */
        const managedInstances = [
            ...snapshotProviderInstances(device),
            ...restoreRecoveryProviderInstances(device),
            ...(managedProviderResource(device) && device.providerInstance ? [{ kind: "device", instance: device.providerInstance }] : []),
        ];
        const providerDeleted = [];
        if (managedInstances.length > 0) {
            const tart = forcedStopPlan?.selectedProvider === "tart" ? { plan: forcedStopPlan } : (0, ports.tartPlan)(device, name);
            if (tart.error) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device, forcedStopUpdates);
                return tart.error;
            }
            for (const resource of managedInstances) {
                if (!currentMacosLifecycleDevice(deviceId, claim.lifecycle)) {
                    return macosLifecycleConflict(deviceId, "delete-resource-ownership", { found: Boolean((0, ports.find)(deviceId)), matched: false });
                }
                const deleted = deleteInstance((/** @type {MacosVmNativePlan} */ (tart.plan)), resource.instance);
                if (!deleted.ok) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device, forcedStopUpdates);
                    return failed(deleted);
                }
                providerDeleted.push(resource.instance);
                if (resource.kind === "snapshot") {
                    const progress = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (item) => macosLifecycleReplacement(item, claim.lifecycle, {
                        snapshots: (item.snapshots || []).filter((snapshot) => snapshot.id !== resource.id),
                    }));
                    if (!progress.matched) return macosLifecycleConflict(deviceId, "delete-snapshot-progress", progress);
                } else if (resource.kind === "restore-recovery") {
                    const progress = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (item) => {
                        const remaining = /** @type {string[]} */ ([
                            item.restoreRecovery?.candidateProviderInstance,
                            ...(item.restoreRecovery?.supersededCandidateProviderInstances || []),
                        ].filter((instance) => instance && instance !== resource.instance));
                        return macosLifecycleReplacement(item, claim.lifecycle, {
                            restoreRecovery: remaining.length === 0 ? null : {
                                ...item.restoreRecovery,
                                candidateProviderInstance: remaining[0],
                                supersededCandidateProviderInstances: remaining.slice(1),
                            },
                        });
                    });
                    if (!progress.matched) return macosLifecycleConflict(deviceId, "delete-recovery-progress", progress);
                }
            }
        }
        const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return macosLifecycleConflict(deviceId, "delete", { found: Boolean((0, ports.find)(deviceId)), matched: false });
        const transition = (0, ports.transition)(deviceId, current, null);
        if (!transition.matched) return macosLifecycleConflict(deviceId, "delete", transition);
        return completedOutcome({ deleted: deviceId, providerDeleted });
    }

    return { create, createImage, start, stop, delete: remove, conflict: macosLifecycleConflict,
        recoverStale: recoverStaleMacosLifecycle, claimLifecycle: claimMacosLifecycle,
        currentLifecycleDevice: currentMacosLifecycleDevice, abortLifecycle: abortMacosLifecycle,
        transitionCurrent: transitionCurrentMacosLifecycle, rollbackStarted: rollbackStartedMacosVm,
        rollbackCreated: rollbackCreatedMacosResource, clone: runTartClone, cloneFailure: tartCloneFailure, cloneFailureEvidence,
        replacement: macosLifecycleReplacement };
}
