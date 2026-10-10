import { macosSshConfig } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
import { macosImageProviderRefusal, macosCloneSourceRefusal, selectMacosSnapshot, macosRestoreCandidate, defineMacosImageDevice } from "../domain/macos-image-snapshots.mjs";
/** @template {import("../ports/macos-image-snapshots.mjs").MacosImageResult} Result
 * @param {import("../ports/macos-image-snapshots.mjs").MacosImageSnapshotsPorts<Result>} ports
 * @param {import("./lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycle<Result>} lifecycle */
export function createMacosImageSnapshots(ports, lifecycle) {
    /** @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice} device @param {string} name
     * @returns {{ok:true,plan:import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmProviderPlan & {selectedProvider:"tart"}}|{ok:false,error:Result}} */
    function requireTart(device, name) {
        const plan = ports.providerPlan(device);
        const refusal = macosImageProviderRefusal(plan, device, name);
        if (refusal) {
            return {
                ok: false,
                error: ports.textResult(false, refusal)
            };
        }
        return {
            ok: true,
            plan: {
                ...plan, selectedProvider: "tart"
            }
        };
    }
    /** @param {Parameters<typeof defineMacosImageDevice>[0]} options */
    function defineDevice(options) {
        return defineMacosImageDevice(options, {
            ownerId: ports.owner(), helper: ports.helperMetadata({
                id: options.id, ssh: options.ssh
            }),
            createdAt: ports.timestamp(), updatedAt: ports.timestamp()
        });
    }
    /** @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmProviderPlan} plan @param {string} instance */
    function deleteInstance(plan, instance) {
        return ports.providerCommand(plan.providerCommand, ["delete", instance], "delete");
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args */
    async function clone(args) {
        const name = "device_base_image_clone";
        const { backend = "macos-vm", name: deviceName, deviceId, sourceDeviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, force = false } = args;
        if (backend !== "macos-vm") {
            return undefined;
        }
        if (!sourceDeviceId && !sourceImage) {
            return ports.textResult(false, `${name} requires sourceDeviceId or sourceImage`);
        }
        const sourceDevice = sourceDeviceId ? ports.find(sourceDeviceId) : null;
        if (sourceDeviceId && !sourceDevice) {
            return ports.textResult(false, `Unknown source macOS device: ${sourceDeviceId}`);
        }
        const sourceRefusal = macosCloneSourceRefusal(sourceDevice, sourceDeviceId, force);
        if (sourceRefusal) {
            return ports.textResult(false, sourceRefusal);
        }
        const sourceProvider = sourceDevice?.provider || provider;
        const sourceRef = sourceDevice?.providerInstance || sourceImage;
        const id = deviceId || ports.deviceId(deviceName);
        const devices = ports.read();
        if (devices.some((device) => device.id === id)) {
            return ports.textResult(false, `Device already exists for this owner: ${id}`);
        }
        const sshKeyPolicy = ports.validateSshKey(sshKeyPath);
        if (!sshKeyPolicy.ok) {
            return ports.textResult(false, sshKeyPolicy.message);
        }
        const ssh = macosSshConfig({
            sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider: sourceProvider, image: sourceImage || sourceDevice?.image || sourceRef
        });
        const device = defineDevice({
            id,
            name: deviceName,
            provider: sourceProvider,
            image: sourceImage || sourceDevice?.image || sourceRef,
            memoryMb: sourceDevice?.memoryMb || memoryMb,
            cpus: sourceDevice?.cpus || cpus,
            ssh,
            extra: {
                clonedFrom: sourceDeviceId ? {
                    deviceId: sourceDeviceId, providerInstance: sourceRef
                } : {
                    image: sourceImage
                },
                provisioning: "image-cloned"
            }
        });
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        /** @type {ReturnType<typeof lifecycle.claimLifecycle>|null} */
        let sourceClaim = null;
        /** @type {Partial<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice>} */
        let sourceCompletionUpdates = {};
        if (sourceDevice) {
            sourceClaim = lifecycle.claimLifecycle(sourceDevice.id, sourceDevice, sourceDevice.status !== "stopped" ? "clone-source-stop" : "clone-source");
            if (!sourceClaim.transition.matched) {
                return lifecycle.conflict(sourceDevice.id, "clone-source-claim", sourceClaim.transition);
            }
        }
        if (sourceDevice && sourceClaim && sourceDevice.status !== "stopped" && force) {
            const sourcePlan = requireTart(sourceDevice, name);
            if (!sourcePlan.ok) {
                lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                return sourcePlan.error;
            }
            if (!sourcePlan.plan.stopCommand) {
                lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                return ports.textResult(false, `macOS VM stop is unavailable for clone source ${sourceDevice.id}`);
            }
            if (sourcePlan.plan.stopCommand) {
                const stop = ports.providerCommand(sourcePlan.plan.stopCommand.command, sourcePlan.plan.stopCommand.args, "stop");
                if (stop.status !== 0) {
                    lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                    return ports.fail(stop);
                }
                const recorderSignal = ports.signalRecording(sourceDevice.recording, "SIGINT");
                if (recorderSignal.signaled) {
                    await ports.waitRecordingExit(sourceDevice.recording, 1000);
                }
                sourceCompletionUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null,
                    recording: null
                };
            }
        }
        const target = tart.plan.providerInstance;
        const clone = lifecycle.clone(tart.plan, sourceRef, target);
        const r = clone.result;
        if (r.status !== 0) {
            if (sourceClaim && sourceDevice) {
                lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates);
            }
            return lifecycle.cloneFailure(r, clone.cleanup, target);
        }
        if (sourceClaim && sourceDevice) {
            const currentSource = lifecycle.currentLifecycleDevice(sourceDevice.id, sourceClaim.lifecycle);
            if (!currentSource) {
                const rollback = deleteInstance(tart.plan, target);
                return lifecycle.conflict(sourceDevice.id, "clone-source-complete", {
                    found: Boolean(ports.find(sourceDevice.id)), matched: false
                }, {
                    ok: rollback.status === 0,
                    target,
                    status: rollback.status,
                    stdout: rollback.stdout,
                    stderr: rollback.stderr
                });
            }
            const completedSource = lifecycle.replacement(currentSource, null, sourceCompletionUpdates);
            const sourceTransition = ports.transition(sourceDevice.id, currentSource, completedSource);
            if (!sourceTransition.matched) {
                const rollback = deleteInstance(tart.plan, target);
                return lifecycle.conflict(sourceDevice.id, "clone-source-complete", sourceTransition, {
                    ok: rollback.status === 0,
                    target,
                    status: rollback.status,
                    stdout: rollback.stdout,
                    stderr: rollback.stderr
                });
            }
        }
        const cloned = {
            ...device,
            provider: tart.plan.selectedProvider,
            providerInstance: target,
            providerResourceManaged: true,
            clonedAt: ports.timestamp()
        };
        let claim;
        try {
            claim = ports.claim(cloned);
        }
        catch (error) {
            const rollback = ports.providerCommand(tart.plan.providerCommand, ["delete", target], "delete");
            if (rollback.status !== 0) {
                return ports.textResult(false, `Owner device state update failed; macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
            }
            throw error;
        }
        if (!claim.ok) {
            if (claim.existing?.provider !== cloned.provider || claim.existing?.providerInstance !== target) {
                const rollback = ports.providerCommand(tart.plan.providerCommand, ["delete", target], "delete");
                if (rollback.status !== 0) {
                    return ports.textResult(false, `Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                }
            }
            return ports.textResult(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
        }
        return ports.jsonResult({
            operation: "base-image-clone",
            device: ports.publicDevice(cloned),
            stdout: r.stdout,
            stderr: r.stderr,
            status: r.status
        });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args */
    async function createSnapshot(args) {
        const name = "device_snapshot_create";
        const { deviceId, snapshotName, force = false } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return ports.textResult(false, `Unknown macOS device: ${deviceId}`);
        }
        if (!snapshotName) {
            return ports.textResult(false, "device_snapshot_create requires snapshotName");
        }
        if (device.status !== "stopped" && !force) {
            return ports.textResult(false, `Refusing to snapshot ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
        }
        const snapshotId = ports.snapshotId(snapshotName);
        if ((device.snapshots || []).some((snapshot) => snapshot.id === snapshotId || snapshot.name === snapshotName)) {
            return ports.textResult(false, `Snapshot already exists for ${deviceId}: ${snapshotName}`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        if (force && device.status !== "stopped" && !tart.plan.stopCommand) {
            return ports.textResult(false, `macOS VM stop is unavailable for snapshot source ${deviceId}`);
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-create");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-create-claim", claim.transition);
        }
        /** @type {Partial<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice>} */
        let completionUpdates = {};
        if (force && device.status !== "stopped" && tart.plan.stopCommand) {
            const stop = ports.providerCommand(tart.plan.stopCommand.command, tart.plan.stopCommand.args, "stop");
            if (stop.status !== 0) {
                lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
                return ports.fail(stop);
            }
            const recorderSignal = ports.signalRecording(device.recording, "SIGINT");
            if (recorderSignal.signaled) {
                await ports.waitRecordingExit(device.recording, 1000);
            }
            completionUpdates = {
                status: "stopped",
                runtime: null,
                bootReady: false,
                lastBootCheck: null,
                recording: null
            };
        }
        const snapshotInstance = `${tart.plan.providerInstance}-${snapshotId}`;
        const clone = lifecycle.clone(tart.plan, tart.plan.providerInstance, snapshotInstance);
        const r = clone.result;
        if (r.status !== 0) {
            lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
            return lifecycle.cloneFailure(r, clone.cleanup, snapshotInstance);
        }
        const snapshot = {
            id: snapshotId,
            name: snapshotName,
            provider: tart.plan.selectedProvider,
            providerInstance: snapshotInstance,
            sourceProviderInstance: tart.plan.providerInstance,
            createdAt: ports.timestamp()
        };
        const current = lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) {
            const rollback = lifecycle.rollbackCreated(deviceId, tart.plan, snapshotInstance);
            return lifecycle.conflict(deviceId, "snapshot-create", {
                found: Boolean(ports.find(deviceId)), matched: false
            }, rollback);
        }
        const completed = lifecycle.replacement(current, null, {
            ...completionUpdates,
            provider: tart.plan.selectedProvider,
            providerInstance: tart.plan.providerInstance,
            status: "stopped",
            snapshots: [...(current.snapshots || []), snapshot]
        });
        const transition = ports.transition(deviceId, current, completed);
        if (!transition.matched) {
            const rollback = lifecycle.rollbackCreated(deviceId, tart.plan, snapshotInstance);
            return lifecycle.conflict(deviceId, "snapshot-create", transition, rollback);
        }
        return ports.jsonResult({
            device: ports.publicDevice(transition.device), snapshot, stdout: r.stdout, stderr: r.stderr, status: r.status
        });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args */
    async function restoreSnapshot(args) {
        const name = "device_snapshot_restore";
        const { deviceId, snapshotName, snapshotId, force = false } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return ports.textResult(false, `Unknown macOS device: ${deviceId}`);
        }
        const snapshot = selectMacosSnapshot(device, snapshotName, snapshotId || (snapshotName ? ports.snapshotId(snapshotName) : null));
        if (!snapshot) {
            return ports.textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
        }
        if (device.status !== "stopped" && !force) {
            return ports.textResult(false, `Refusing to restore ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        if (force && device.status !== "stopped" && !tart.plan.stopCommand) {
            return ports.textResult(false, `macOS VM stop is unavailable for snapshot restore ${deviceId}`);
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-restore");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-restore-claim", claim.transition);
        }
        /** @type {Partial<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice>} */
        let completionUpdates = {};
        if (force && device.status !== "stopped" && tart.plan.stopCommand) {
            const stop = ports.providerCommand(tart.plan.stopCommand.command, tart.plan.stopCommand.args, "stop");
            if (stop.status !== 0) {
                lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
                return ports.fail(stop);
            }
            const recorderSignal = ports.signalRecording(device.recording, "SIGINT");
            if (recorderSignal.signaled) {
                await ports.waitRecordingExit(device.recording, 1000);
            }
            completionUpdates = {
                status: "stopped",
                runtime: null,
                bootReady: false,
                lastBootCheck: null,
                recording: null
            };
        }
        const pendingRecovery = device.restoreRecovery;
        const matchingCandidate = macosRestoreCandidate(device, snapshot);
        const resumesPendingCandidate = Boolean(matchingCandidate);
        const restoreCandidate = matchingCandidate || `${tart.plan.providerInstance}-restore-${snapshot.id}-${ports.runtimeId()}`;
        /** @type {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmCommandResult} */
        let restore = {
            status: 0, stdout: "", stderr: ""
        };
        if (!resumesPendingCandidate) {
            const clone = lifecycle.clone(tart.plan, snapshot.providerInstance, restoreCandidate);
            restore = clone.result;
            if (restore.status !== 0) {
                lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
                return lifecycle.cloneFailure(restore, clone.cleanup, restoreCandidate);
            }
            const recovery = {
                snapshotId: snapshot.id,
                snapshotName: snapshot.name,
                candidateProviderInstance: restoreCandidate,
                supersededCandidateProviderInstances: pendingRecovery?.candidateProviderInstance
                    ? [pendingRecovery.candidateProviderInstance, ...(pendingRecovery.supersededCandidateProviderInstances || [])]
                    : [],
                phase: "prepared",
                preparedAt: ports.timestamp()
            };
            const registered = lifecycle.transitionCurrent(deviceId, claim.lifecycle, (current) => lifecycle.replacement(current, claim.lifecycle, {
                ...completionUpdates,
                restoreRecovery: recovery
            }));
            if (!registered.matched) {
                const rollback = lifecycle.rollbackCreated(deviceId, tart.plan, restoreCandidate);
                return lifecycle.conflict(deviceId, "snapshot-restore-candidate", registered, rollback);
            }
        }
        /** @type {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmCommandResult} */
        let activate = {
            status: 0, stdout: "", stderr: ""
        };
        if (pendingRecovery?.phase !== "activated" || !resumesPendingCandidate) {
            const remove = ports.providerCommand(tart.plan.providerCommand, ["delete", tart.plan.providerInstance], "delete");
            if (!lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle)) {
                return lifecycle.conflict(deviceId, "snapshot-restore-primary", {
                    found: Boolean(ports.find(deviceId)), matched: false
                }, {
                    ok: false,
                    attempted: false,
                    reason: "restore-candidate-preserved",
                    candidateProviderInstance: restoreCandidate
                });
            }
            const activationClone = lifecycle.clone(tart.plan, restoreCandidate, tart.plan.providerInstance);
            activate = activationClone.result;
            if (activate.status !== 0) {
                const recovery = {
                    ...(lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle)?.restoreRecovery || {}),
                    snapshotId: snapshot.id,
                    snapshotName: snapshot.name,
                    candidateProviderInstance: restoreCandidate,
                    failedAt: ports.timestamp(),
                    error: remove.status !== 0
                        ? `primary delete: ${remove.stderr || remove.stdout || `exit ${remove.status}`}; activation: ${activate.stderr || activate.stdout || `exit ${activate.status}`}`
                        : activate.stderr || activate.stdout || `exit ${activate.status}`
                };
                const current = lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle);
                if (!current) {
                    return lifecycle.conflict(deviceId, "snapshot-restore-recovery", {
                        found: Boolean(ports.find(deviceId)), matched: false
                    }, {
                        ok: false,
                        attempted: false,
                        reason: "restore-candidate-preserved",
                        candidateProviderInstance: restoreCandidate
                    });
                }
                const failed = lifecycle.replacement(current, null, {
                    ...completionUpdates,
                    status: "stopped",
                    restoreRecovery: recovery
                });
                const transition = ports.transition(deviceId, current, failed);
                if (!transition.matched) {
                    return lifecycle.conflict(deviceId, "snapshot-restore-recovery", transition, {
                        ok: false,
                        attempted: false,
                        reason: "restore-candidate-preserved",
                        candidateProviderInstance: restoreCandidate
                    });
                }
                if (activationClone.cleanup) {
                    return ports.textResult(false, `${(lifecycle.cloneFailure(activate, activationClone.cleanup, tart.plan.providerInstance).content || [])[0]?.text || `Error: ${recovery.error}`}. Restore candidate preserved: ${restoreCandidate}`);
                }
                return ports.textResult(false, `Error: ${recovery.error}. Restore candidate preserved: ${restoreCandidate}`);
            }
            const activated = lifecycle.transitionCurrent(deviceId, claim.lifecycle, (current) => lifecycle.replacement(current, claim.lifecycle, {
                ...completionUpdates,
                status: "stopped",
                restoreRecovery: {
                    ...current.restoreRecovery,
                    phase: "activated",
                    activatedAt: ports.timestamp()
                }
            }));
            if (!activated.matched) {
                return lifecycle.conflict(deviceId, "snapshot-restore-activate", activated, {
                    ok: false,
                    attempted: false,
                    reason: "restore-candidate-preserved",
                    candidateProviderInstance: restoreCandidate
                });
            }
        }
        const trackedRecovery = lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle)?.restoreRecovery;
        const cleanupResults = [restoreCandidate, ...(trackedRecovery?.supersededCandidateProviderInstances || [])]
            .map((instance) => ({
            instance, result: deleteInstance(tart.plan, instance)
        }));
        const failedCleanups = cleanupResults.filter(({ result }) => result.status !== 0);
        const cleanup = failedCleanups[0]?.result || cleanupResults[0].result;
        const current = lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) {
            return lifecycle.conflict(deviceId, "snapshot-restore", {
                found: Boolean(ports.find(deviceId)), matched: false
            }, failedCleanups.length === 0 ? null : {
                ok: false,
                attempted: true,
                reason: "restore-candidate-cleanup-failed",
                candidateProviderInstance: failedCleanups[0].instance,
                status: cleanup.status
            });
        }
        const completed = lifecycle.replacement(current, null, {
            ...completionUpdates,
            provider: tart.plan.selectedProvider,
            providerInstance: tart.plan.providerInstance,
            status: "stopped",
            restoreRecovery: failedCleanups.length === 0 ? null : {
                snapshotId: snapshot.id,
                snapshotName: snapshot.name,
                candidateProviderInstance: failedCleanups[0].instance,
                supersededCandidateProviderInstances: failedCleanups.slice(1).map(({ instance }) => instance),
                failedAt: ports.timestamp(),
                error: cleanup.stderr || cleanup.stdout || `cleanup exit ${cleanup.status}`
            },
            restoredFrom: {
                id: snapshot.id, name: snapshot.name, providerInstance: snapshot.providerInstance, restoredAt: ports.timestamp()
            }
        });
        const transition = ports.transition(deviceId, current, completed);
        if (!transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-restore", transition, failedCleanups.length === 0 ? null : {
                ok: false,
                attempted: true,
                reason: "restore-candidate-cleanup-failed",
                candidateProviderInstance: failedCleanups[0].instance,
                status: cleanup.status
            });
        }
        return ports.jsonResult({
            device: ports.publicDevice(transition.device), snapshot, stdout: activate.stdout, stderr: activate.stderr, status: activate.status
        });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args */
    async function deleteSnapshot(args) {
        const name = "device_snapshot_delete";
        const { deviceId, snapshotName, snapshotId } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return ports.textResult(false, `Unknown macOS device: ${deviceId}`);
        }
        const snapshot = selectMacosSnapshot(device, snapshotName, snapshotId || (snapshotName ? ports.snapshotId(snapshotName) : null));
        if (!snapshot) {
            return ports.textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-delete");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-delete-claim", claim.transition);
        }
        const r = ports.providerCommand(tart.plan.providerCommand, ["delete", snapshot.providerInstance], "delete");
        if (r.status !== 0) {
            lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
            return ports.fail(r);
        }
        const current = lifecycle.currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) {
            return lifecycle.conflict(deviceId, "snapshot-delete", {
                found: Boolean(ports.find(deviceId)), matched: false
            });
        }
        const completed = lifecycle.replacement(current, null, {
            snapshots: (current.snapshots || []).filter((candidate) => candidate.id !== snapshot.id)
        });
        const transition = ports.transition(deviceId, current, completed);
        if (!transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-delete", transition);
        }
        return ports.jsonResult({
            device: ports.publicDevice(transition.device), deleted: snapshot.id, stdout: r.stdout, stderr: r.stderr, status: r.status
        });
    }
    return {
        clone, createSnapshot, restoreSnapshot, deleteSnapshot
    };
}
