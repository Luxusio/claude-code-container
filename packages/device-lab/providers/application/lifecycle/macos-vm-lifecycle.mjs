import { macosProviderInstanceReferenced, managedProviderResource, snapshotProviderInstances, restoreRecoveryProviderInstances, macosSshConfig } from "../../domain/lifecycle/macos-vm-lifecycle.mjs";
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice} MacosVmDevice */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleInput} MacosVmLifecycleInput */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleClaim} MacosVmLifecycleClaim */
/** @typedef {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmProviderPlan} MacosVmProviderPlan */

/** Complete direct policy; only trusted native leaves enter this composition.
 * @template Result
 * @template {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmProcessHandle} Child
 * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecyclePorts<Result, Child>} ports
 */
export function createMacosVmLifecycleApplication(ports) {
    /** @param {string | undefined} deviceId
     * @param {string} operation
     * @param {{found: boolean, matched?: boolean}} transition
     * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRollback | null} [rollback] */
    function macosLifecycleConflict(deviceId, operation, transition, rollback = null) {
        return (0, ports.textResult)(false, JSON.stringify({
            ok: false,
            error: "owner-device-state-conflict",
            backend: "macos-vm",
            deviceId,
            operation,
            found: transition.found,
            ...(rollback ? { rollback } : {}),
        }));
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
            if (!plan.stopCommand) {
                return { error: (0, ports.textResult)(false, `Cannot recover stale macOS VM start lifecycle for ${deviceId}: provider stop is unavailable`) };
            }
            const stopped = (0, ports.providerCommand)(plan.stopCommand.command, plan.stopCommand.args, "stop");
            if (stopped.status !== 0) {
                return { error: (0, ports.textResult)(false, `Cannot recover stale macOS VM start lifecycle for ${deviceId}: ${stopped.stderr || stopped.stdout || stopped.error?.message || `exit ${stopped.status}`}`) };
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
     * @param {MacosVmProviderPlan} plan */
    function rollbackStartedMacosVm(deviceId, lifecycle, plan) {
        const current = (0, ports.find)(deviceId);
        if (current?.lifecycle?.runtimeId !== lifecycle.runtimeId && current?.providerInstance === plan.providerInstance) {
            return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: plan.providerInstance };
        }
        if (!plan.stopCommand || !plan.providerInstance) {
            return { ok: false, attempted: false, reason: "provider-stop-command-unavailable", providerInstance: plan.providerInstance || null };
        }
        const stopped = (0, ports.providerCommand)(plan.stopCommand.command, plan.stopCommand.args, "stop");
        return {
            ok: stopped.status === 0,
            attempted: true,
            providerInstance: plan.providerInstance,
            status: stopped.status,
            stdout: stopped.stdout,
            stderr: stopped.stderr,
        };
    }

    /** @param {string | undefined} deviceId
     * @param {MacosVmProviderPlan} plan
     * @param {string} instance */
    function rollbackCreatedMacosResource(deviceId, plan, instance) {
        const current = (0, ports.find)(deviceId);
        if (macosProviderInstanceReferenced(current, instance)) {
            return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: instance };
        }
        const deleted = deleteInstance(plan, instance);
        return {
            ok: deleted.status === 0,
            attempted: true,
            providerInstance: instance,
            status: deleted.status,
            stdout: deleted.stdout,
            stderr: deleted.stderr,
        };
    }

    /** @param {MacosVmProviderPlan} plan
     * @param {string} source
     * @param {string} target */
    function runTartClone(plan, source, target) {
        const result = (0, ports.providerCommand)(plan.providerCommand, ["clone", source, target], "clone");
        const cleanup = result.status !== 0 && (0, ports.commandTimedOut)(result)
            ? deleteInstance(plan, target)
            : null;
        return { result, cleanup };
    }

    /** @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmCommandResult} result
     * @param {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmCommandResult | null} cleanup
     * @param {string} target */
    function tartCloneFailure(result, cleanup, target) {
        if (!cleanup) return (0, ports.fail)(result);
        return (0, ports.textResult)(false, JSON.stringify({
            ok: false,
            error: "macos-tart-clone-failed",
            target,
            timedOut: true,
            command: {
                status: result.status,
                signal: result.signal || null,
                detail: result.stderr || result.stdout || result.error?.message || "clone timed out",
            },
            cleanup: {
                ok: cleanup.status === 0,
                status: cleanup.status,
                signal: cleanup.signal || null,
                detail: cleanup.stderr || cleanup.stdout || cleanup.error?.message || null,
            },
        }));
    }

    /** @param {MacosVmProviderPlan} plan @param {string} instance */
    function deleteInstance(plan, instance) {
        return (0, ports.providerCommand)(plan.providerCommand, ["delete", instance], "delete");
    }

    /** @param {{id: string, name?: string, provider: string, image: string, memoryMb: number, cpus: number, ssh: import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmSsh | null, extra?: Partial<MacosVmDevice>}} options */
    function macosDeviceDefinition({ id, name, provider, image, memoryMb, cpus, ssh, extra = {} }) {
        return {
            id,
            name,
            backend: "macos-vm",
            kind: "desktop",
            platform: "macos",
            ownerId: (0, ports.owner)(),
            provider,
            image,
            memoryMb,
            cpus,
            providerInstance: `ccc-${(0, ports.owner)()}-${id}`,
            ssh,
            helper: (0, ports.helperMetadata)({ id, ssh }),
            status: "stopped",
            creatable: true,
            snapshots: [],
            recording: null,
            ...extra,
            createdAt: (0, ports.timestamp)(),
            updatedAt: (0, ports.timestamp)(),
        };
    }

    /** @param {MacosVmLifecycleInput} args */
    function createImage(args) {
        const name = "device_base_image_create";
        const { backend = "macos-vm", name: deviceName, deviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, headless = false, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword } = args;
        if (backend !== "macos-vm") return undefined;
        if (!sourceImage) return (0, ports.textResult)(false, `${name} requires sourceImage`);

        const id = deviceId || (0, ports.deviceId)(deviceName);
        const devices = (0, ports.read)();
        if (devices.some((device) => device.id === id)) {
            return (0, ports.textResult)(false, `Device already exists for this owner: ${id}`);
        }
        const sshKeyPolicy = (0, ports.validateSshKey)(sshKeyPath);
        if (!sshKeyPolicy.ok) return (0, ports.textResult)(false, sshKeyPolicy.message);

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
        const target = (/** @type {MacosVmProviderPlan} */ (tart.plan)).providerInstance;
        const clone = runTartClone((/** @type {MacosVmProviderPlan} */ (tart.plan)), sourceImage, target);
        const r = clone.result;
        if (r.status !== 0) return tartCloneFailure(r, clone.cleanup, target);

        const created = {
            ...device,
            provider: (/** @type {MacosVmProviderPlan} */ (tart.plan)).selectedProvider,
            providerInstance: target,
            providerResourceManaged: true,
            imageCreatedAt: (0, ports.timestamp)(),
        };
        let claim;
        try {
            claim = (0, ports.claim)(created);
        } catch (error) {
            const rollback = (0, ports.providerCommand)((/** @type {MacosVmProviderPlan} */ (tart.plan)).providerCommand, ["delete", target], "delete");
            if (rollback.status !== 0) {
                return (0, ports.textResult)(false, `Owner device state update failed; macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
            }
            throw error;
        }
        if (!claim.ok) {
            if (claim.existing?.provider !== created.provider || claim.existing?.providerInstance !== target) {
                const rollback = (0, ports.providerCommand)((/** @type {MacosVmProviderPlan} */ (tart.plan)).providerCommand, ["delete", target], "delete");
                if (rollback.status !== 0) {
                    return (0, ports.textResult)(false, `Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                }
            }
            return (0, ports.textResult)(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
        }
        return (0, ports.jsonResult)({
            operation: "base-image-create",
            device: (0, ports.publicDevice)(created),
            stdout: r.stdout,
            stderr: r.stderr,
            status: r.status,
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
            return (0, ports.textResult)(false, `Device already exists for this owner: ${id}`);
        }
        const sshKeyPolicy = (0, ports.validateSshKey)(sshKeyPath);
        if (!sshKeyPolicy.ok) return (0, ports.textResult)(false, sshKeyPolicy.message);
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
            return (0, ports.textResult)(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
        }
        return (0, ports.jsonResult)({ device: (0, ports.publicDevice)(device) });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function start(args) {
        const { deviceId, headless, waitForBoot = true, bootTimeoutMs = 300000 } = args;
        const startDeadlineAt = (0, ports.now)() + (Number.isFinite(bootTimeoutMs) ? Math.min(600000, Math.max(1000, bootTimeoutMs)) : 300000);
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (device.status !== "stopped" || device.lifecycle) {
            return (0, ports.textResult)(false, `Refusing to start ${deviceId} while status is ${device.status}${device.lifecycle ? ` and lifecycle operation ${device.lifecycle.operation || "unknown"} is active` : ""}`);
        }
        const keyPolicy = (0, ports.validateSshKey)(device.ssh?.keyPath);
        if (!keyPolicy.ok) return (0, ports.textResult)(false, keyPolicy.message);
        const safeDevice = device.ssh?.keyPath && keyPolicy.path !== device.ssh.keyPath
            ? { ...device, ssh: { ...device.ssh, keyPath: keyPolicy.path } }
            : device;
        const startDevice = headless === undefined ? safeDevice : { ...safeDevice, headless: Boolean(headless) };

        const plan = (0, ports.providerPlan)(startDevice);
        if (!plan.available) {
            return (0, ports.textResult)(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
        }

        const claim = claimMacosLifecycle(deviceId, device, "start", {
            provider: plan.selectedProvider,
            providerInstance: plan.providerInstance,
            ssh: startDevice.ssh,
            headless: startDevice.headless,
        });
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "start-claim", claim.transition);

        const startCommand = /** @type {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmCommand} */ (plan.selectedProvider === "tart" && plan.providerCommand
            ? {
                command: plan.providerCommand,
                args: (0, ports.tartStartArgs)(plan.providerInstance, {
                    ...startDevice,
                    softnet: startDevice.softnet !== false && (0, ports.supportsFeature)(plan.providerCommand, "--with-softnet"),
                }),
            }
            : plan.startCommand);

        const child = (0, ports.spawn)(startCommand.command, startCommand.args);
        const startError = await (0, ports.waitProviderStart)(child, "macOS VM provider start");
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
            return (0, ports.textResult)(false, JSON.stringify({ ok: false, error: "macos-boot-not-ready", device: (0, ports.publicDevice)(updated), boot }));
        }
        if (!provision.ok) {
            return (0, ports.textResult)(false, JSON.stringify({
                ok: false,
                error: provision.error,
                command: provision.command,
                device: (0, ports.publicDevice)(updated),
                helper: provision.provisioning,
                providerStart: startedDevice.runtime,
                boot,
            }));
        }
        return (0, ports.jsonResult)({ device: (0, ports.publicDevice)(updated), helper: provision.provisioning, providerStart: startedDevice.runtime, boot });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function stop(args) {
        const { deviceId } = args;
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (device.lifecycle) {
            return (0, ports.textResult)(false, `Refusing to stop ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
        }
        const claim = claimMacosLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "stop-claim", claim.transition);

        const plan = (0, ports.providerPlan)(device);
        if (device.status !== "stopped" && (!plan.available || !plan.stopCommand)) {
            abortMacosLifecycle(deviceId, claim.lifecycle, device);
            return (0, ports.textResult)(false, `macOS VM stop is unavailable for ${deviceId}: ${plan.missing?.join(", ") || "provider stop command missing"}`);
        }
        if (plan.stopCommand && device.providerInstance && device.status !== "stopped") {
            const r = (0, ports.providerCommand)(plan.stopCommand.command, plan.stopCommand.args, "stop");
            if (r.status !== 0) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return (0, ports.fail)(r);
            }
        }

        const recorderSignal = (0, ports.signalRecording)(device.recording, "SIGINT");
        if (device.recording?.active) {
            const bridge = (0, ports.sshBridge)(device, "device_record_video_stop");
            if (!bridge.error) {
                (0, ports.helperCommand)((/** @type {{ssh: string}} */ (bridge.discovery)).ssh, [...(0, ports.sshBaseArgs)(device), /** @type {string} */ (bridge.target), `pkill -INT -f ${(0, ports.shellQuote)(`screencapture.*${device.recording.remotePath}`)} || true`], undefined, (0, ports.sshCommandOptions)(device));
            }
        }
        if (recorderSignal.signaled) {
            await (0, ports.waitRecordingExit)((/** @type {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRuntime} */ (device.recording)).pid, 1000);
        }
        const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return macosLifecycleConflict(deviceId, "stop", { found: Boolean((0, ports.find)(deviceId)), matched: false });
        const stopped = macosLifecycleReplacement(current, null, {
            status: "stopped",
            runtime: null,
            bootReady: false,
            lastBootCheck: null,
            recording: null,
        });
        const transition = (0, ports.transition)(deviceId, current, stopped);
        if (!transition.matched) return macosLifecycleConflict(deviceId, "stop", transition);
        return (0, ports.jsonResult)({ device: (0, ports.publicDevice)(/** @type {MacosVmDevice} */ (transition.device)) });
    }

    /** @param {MacosVmLifecycleInput} args */
    async function remove(args) {
        const name = "device_delete";
        const { deviceId, force = false } = args;
        const device = (0, ports.find)(deviceId);
        if (!device) return undefined;
        if (!force && device.status !== "stopped") {
            return (0, ports.textResult)(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
        }
        if (device.lifecycle) {
            return (0, ports.textResult)(false, `Refusing to delete ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
        }
        const claim = claimMacosLifecycle(deviceId, device, "delete");
        if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "delete-claim", claim.transition);
        let forcedStopPlan = null;
        let forcedStopUpdates = {};
        if (force && device.status !== "stopped") {
            const plan = (0, ports.providerPlan)(device);
            if (!plan.available) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return (0, ports.textResult)(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
            }
            if (plan.stopCommand) {
                const stop = (0, ports.providerCommand)(plan.stopCommand.command, plan.stopCommand.args, "stop");
                if (stop.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return (0, ports.fail)(stop);
                }
                forcedStopPlan = plan;
                const recorderSignal = (0, ports.signalRecording)(device.recording, "SIGINT");
                if (recorderSignal.signaled) await (0, ports.waitRecordingExit)((/** @type {import("../../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRuntime} */ (device.recording)).pid, 1000);
                forcedStopUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null,
                    recording: null,
                };
            }
        }
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
                const deleted = deleteInstance((/** @type {MacosVmProviderPlan} */ (tart.plan)), resource.instance);
                if (deleted.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device, forcedStopUpdates);
                    return (0, ports.fail)(deleted);
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
        return (0, ports.jsonResult)({ deleted: deviceId, providerDeleted });
    }

    return { create, createImage, start, stop, delete: remove, conflict: macosLifecycleConflict,
        recoverStale: recoverStaleMacosLifecycle, claimLifecycle: claimMacosLifecycle,
        currentLifecycleDevice: currentMacosLifecycleDevice, abortLifecycle: abortMacosLifecycle,
        transitionCurrent: transitionCurrentMacosLifecycle, rollbackStarted: rollbackStartedMacosVm,
        rollbackCreated: rollbackCreatedMacosResource, clone: runTartClone, cloneFailure: tartCloneFailure,
        replacement: macosLifecycleReplacement };
}
