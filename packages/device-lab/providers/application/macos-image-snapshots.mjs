import { macosProviderInstanceReferenced, macosSshConfig } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
import { macosImageProviderRefusal, macosCloneSourceRefusal, selectMacosSnapshot, macosRestoreCandidate, defineMacosImageDevice } from "../domain/macos-image-snapshots.mjs";
import { recordingGenerationMatches } from "../domain/runtime-generation.mjs";
/** @param {string} message @returns {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome} */
function refused(message) { return {kind: "refused", message}; }
/** @param {object} value @returns {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome} */
function completedOutcome(value) { return {kind: "completed", value}; }
/** @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation} observation
 * @returns {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome} */
function failed(observation) { return {kind: "failed", evidence: observation.evidence}; }
/** @param {import("../ports/macos-image-snapshots.mjs").MacosImageSnapshotsPorts} ports
 * @param {import("./lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeLifecycle} lifecycle */
export function createMacosImageSnapshots(ports, lifecycle) {
    /** @param {string | undefined} deviceId
     * @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleClaim} claim
     * @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRuntime | null | undefined} recording */
    function currentRecordingDevice(deviceId, claim, recording) {
        const current = lifecycle.currentLifecycleDevice(deviceId, claim);
        return current && recordingGenerationMatches(recording, current.recording) ? current : null;
    }
    /** @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice} device @param {string} name
     * @returns {{ok:true,plan:import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativePlan & {selectedProvider:"tart"}}|{ok:false,error:import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome}} */
    function requireTart(device, name) {
        const plan = ports.providerPlan(device);
        const refusal = macosImageProviderRefusal(plan, device, name);
        if (refusal) {
            return {
                ok: false,
                error: refused(refusal)
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
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args @param {string} [admittedDeviceId]
     * @returns {Promise<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome | undefined>} */
    async function clone(args, admittedDeviceId) {
        const name = "device_base_image_clone";
        const { backend = "macos-vm", name: deviceName, sourceDeviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, force = false } = args;
        if (backend !== "macos-vm") {
            return undefined;
        }
        if (Object.hasOwn(args, "deviceId")) {
            return refused("macOS VM creation does not accept deviceId");
        }
        const id = admittedDeviceId ?? ports.deviceId();
        const devices = ports.read();
        if (devices.some((device) => device.id === id || macosProviderInstanceReferenced(device, `ccc-${ports.owner()}-${id}`))) {
            return refused(`Device already exists for this owner: ${id}`);
        }
        if (!sourceDeviceId && !sourceImage) {
            return refused(`${name} requires sourceDeviceId or sourceImage`);
        }
        const sourceDevice = sourceDeviceId ? ports.find(sourceDeviceId) : null;
        if (sourceDeviceId && !sourceDevice) {
            return refused(`Unknown source macOS device: ${sourceDeviceId}`);
        }
        const sourceRefusal = macosCloneSourceRefusal(sourceDevice, sourceDeviceId, force);
        if (sourceRefusal) {
            return refused(sourceRefusal);
        }
        const sourceProvider = sourceDevice?.provider || provider;
        const sourceRef = sourceDevice?.providerInstance || sourceImage;
        const sshKeyPolicy = ports.validateSshKey(sshKeyPath);
        if (!sshKeyPolicy.ok) {
            return refused(sshKeyPolicy.message);
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
        if (sourceDevice && sourceClaim) {
            try {
                if (sourceDevice.status !== "stopped" && force) {
                    const sourcePlan = requireTart(sourceDevice, name);
                    if (!sourcePlan.ok) {
                        lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                        return sourcePlan.error;
                    }
                    if (!sourcePlan.plan.stopAvailable) {
                        lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                        return refused(`macOS VM stop is unavailable for clone source ${sourceDevice.id}`);
                    }
                    const stop = ports.stopInstance(sourcePlan.plan);
                    if (!stop.ok) {
                        const aborted = lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                        return aborted.matched ? failed(stop) : lifecycle.conflict(sourceDevice.id, "clone-source-stop", aborted);
                    }
                    sourceCompletionUpdates = {
                        status: "stopped",
                        runtime: null,
                        bootReady: false,
                        lastBootCheck: null
                    };
                }
                const recordingCleanup = await lifecycle.stopRecording(sourceDevice);
                if (!currentRecordingDevice(sourceDevice.id, sourceClaim.lifecycle, sourceDevice.recording)) {
                    const aborted = lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates);
                    return lifecycle.conflict(sourceDevice.id, "clone-source-recording", aborted);
                }
                if (!recordingCleanup.ok) {
                    return lifecycle.recordingCleanupIncomplete(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates, recordingCleanup.reason);
                }
                sourceCompletionUpdates = { ...sourceCompletionUpdates, recording: null };
            }
            catch (error) {
                const recordingOwned = Boolean(currentRecordingDevice(sourceDevice.id, sourceClaim.lifecycle, sourceDevice.recording));
                const aborted = lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates);
                if (!recordingOwned || !aborted.matched) return lifecycle.conflict(sourceDevice.id, "clone-source-recording", aborted);
                throw error;
            }
        }
        const target = tart.plan.providerInstance;
        const clone = lifecycle.clone(tart.plan, sourceRef, target);
        const r = clone.result;
        if (!r.ok) {
            if (sourceClaim && sourceDevice) {
                lifecycle.abortLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates);
            }
            return lifecycle.cloneFailure(r, clone.cleanup, target);
        }
        if (sourceClaim && sourceDevice) {
            const currentSource = currentRecordingDevice(sourceDevice.id, sourceClaim.lifecycle, sourceDevice.recording);
            if (!currentSource) {
                const rollback = ports.deleteInstance(tart.plan, target);
                return lifecycle.conflict(sourceDevice.id, "clone-source-complete", {
                    found: Boolean(ports.find(sourceDevice.id)), matched: false
                }, {
                    ok: rollback.ok,
                    target,
                    native: rollback.evidence
                });
            }
            const completedSource = lifecycle.replacement(currentSource, null, sourceCompletionUpdates);
            const sourceTransition = ports.transition(sourceDevice.id, currentSource, completedSource);
            if (!sourceTransition.matched) {
                const rollback = ports.deleteInstance(tart.plan, target);
                return lifecycle.conflict(sourceDevice.id, "clone-source-complete", sourceTransition, {
                    ok: rollback.ok,
                    target,
                    native: rollback.evidence
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
            const rollback = ports.deleteInstance(tart.plan, target);
            if (!rollback.ok) {
                return refused(`Owner device state update failed; macOS VM rollback failed: ${ports.imageDiagnostic(rollback, "output")}`);
            }
            throw error;
        }
        if (!claim.ok) {
            if (claim.existing?.provider !== cloned.provider || claim.existing?.providerInstance !== target) {
                const rollback = ports.deleteInstance(tart.plan, target);
                if (!rollback.ok) {
                    return refused(`Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${ports.imageDiagnostic(rollback, "output")}`);
                }
            }
            return refused(`Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
        }
        return completedOutcome({ operation: "base-image-clone", device: cloned, native: r.evidence });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args
     * @returns {Promise<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome>} */
    async function createSnapshot(args) {
        const name = "device_snapshot_create";
        const { deviceId, snapshotName, force = false } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return refused(`Unknown macOS device: ${deviceId}`);
        }
        if (!snapshotName) {
            return refused("device_snapshot_create requires snapshotName");
        }
        if (device.status !== "stopped" && !force) {
            return refused(`Refusing to snapshot ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
        }
        const snapshotId = ports.snapshotId(snapshotName);
        if ((device.snapshots || []).some((snapshot) => snapshot.id === snapshotId || snapshot.name === snapshotName)) {
            return refused(`Snapshot already exists for ${deviceId}: ${snapshotName}`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        if (force && device.status !== "stopped" && !tart.plan.stopAvailable) {
            return refused(`macOS VM stop is unavailable for snapshot source ${deviceId}`);
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-create");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-create-claim", claim.transition);
        }
        /** @type {Partial<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice>} */
        let completionUpdates = {};
        try {
            if (force && device.status !== "stopped" && tart.plan.stopAvailable) {
                const stop = ports.stopInstance(tart.plan);
                if (!stop.ok) {
                    const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
                    return aborted.matched ? failed(stop) : lifecycle.conflict(deviceId, "snapshot-create-stop", aborted);
                }
                completionUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null
                };
            }
            const recordingCleanup = await lifecycle.stopRecording(device);
            if (!currentRecordingDevice(deviceId, claim.lifecycle, device.recording)) {
                const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
                return lifecycle.conflict(deviceId, "snapshot-create-recording", aborted);
            }
            if (!recordingCleanup.ok) {
                return lifecycle.recordingCleanupIncomplete(deviceId, claim.lifecycle, device, completionUpdates, recordingCleanup.reason);
            }
            completionUpdates = { ...completionUpdates, recording: null };
        }
        catch (error) {
            const recordingOwned = Boolean(currentRecordingDevice(deviceId, claim.lifecycle, device.recording));
            const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
            if (!recordingOwned || !aborted.matched) return lifecycle.conflict(deviceId, "snapshot-create-recording", aborted);
            throw error;
        }
        const snapshotInstance = `${tart.plan.providerInstance}-${snapshotId}`;
        const clone = lifecycle.clone(tart.plan, tart.plan.providerInstance, snapshotInstance);
        const r = clone.result;
        if (!r.ok) {
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
        const current = currentRecordingDevice(deviceId, claim.lifecycle, device.recording);
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
        return completedOutcome({ device: transition.device, snapshot, native: r.evidence });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args
     * @returns {Promise<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome>} */
    async function restoreSnapshot(args) {
        const name = "device_snapshot_restore";
        const { deviceId, snapshotName, snapshotId, force = false } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return refused(`Unknown macOS device: ${deviceId}`);
        }
        const snapshot = selectMacosSnapshot(device, snapshotName, snapshotId || (snapshotName ? ports.snapshotId(snapshotName) : null));
        if (!snapshot) {
            return refused(`Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
        }
        if (device.status !== "stopped" && !force) {
            return refused(`Refusing to restore ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        if (force && device.status !== "stopped" && !tart.plan.stopAvailable) {
            return refused(`macOS VM stop is unavailable for snapshot restore ${deviceId}`);
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-restore");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-restore-claim", claim.transition);
        }
        /** @type {Partial<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice>} */
        let completionUpdates = {};
        try {
            if (force && device.status !== "stopped" && tart.plan.stopAvailable) {
                const stop = ports.stopInstance(tart.plan);
                if (!stop.ok) {
                    const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
                    return aborted.matched ? failed(stop) : lifecycle.conflict(deviceId, "snapshot-restore-stop", aborted);
                }
                completionUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null
                };
            }
            const recordingCleanup = await lifecycle.stopRecording(device);
            if (!currentRecordingDevice(deviceId, claim.lifecycle, device.recording)) {
                const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
                return lifecycle.conflict(deviceId, "snapshot-restore-recording", aborted);
            }
            if (!recordingCleanup.ok) {
                return lifecycle.recordingCleanupIncomplete(deviceId, claim.lifecycle, device, completionUpdates, recordingCleanup.reason);
            }
            completionUpdates = { ...completionUpdates, recording: null };
        }
        catch (error) {
            const recordingOwned = Boolean(currentRecordingDevice(deviceId, claim.lifecycle, device.recording));
            const aborted = lifecycle.abortLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
            if (!recordingOwned || !aborted.matched) return lifecycle.conflict(deviceId, "snapshot-restore-recording", aborted);
            throw error;
        }
        const pendingRecovery = device.restoreRecovery;
        const matchingCandidate = macosRestoreCandidate(device, snapshot);
        const resumesPendingCandidate = Boolean(matchingCandidate);
        const restoreCandidate = matchingCandidate || `${tart.plan.providerInstance}-restore-${snapshot.id}-${ports.runtimeId()}`;
        let expectedRecording = device.recording;
        if (!resumesPendingCandidate) {
            const clone = lifecycle.clone(tart.plan, snapshot.providerInstance, restoreCandidate);
            const restore = clone.result;
            if (!restore.ok) {
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
            const prepared = currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording);
            if (!prepared) {
                const rollback = lifecycle.rollbackCreated(deviceId, tart.plan, restoreCandidate);
                return lifecycle.conflict(deviceId, "snapshot-restore-candidate", {
                    found: Boolean(ports.find(deviceId)), matched: false
                }, rollback);
            }
            const registered = ports.transition(deviceId, prepared, lifecycle.replacement(prepared, claim.lifecycle, {
                ...completionUpdates,
                restoreRecovery: recovery
            }));
            if (!registered.matched) {
                const rollback = lifecycle.rollbackCreated(deviceId, tart.plan, restoreCandidate);
                return lifecycle.conflict(deviceId, "snapshot-restore-candidate", registered, rollback);
            }
            expectedRecording = null;
        }
        /** @type {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmNativeObservation | null} */
        let activate = null;
        if (pendingRecovery?.phase !== "activated" || !resumesPendingCandidate) {
            if (!currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording)) {
                return lifecycle.conflict(deviceId, "snapshot-restore-primary", {
                    found: Boolean(ports.find(deviceId)), matched: false
                }, {
                    ok: false,
                    attempted: false,
                    reason: "restore-candidate-preserved",
                    candidateProviderInstance: restoreCandidate
                });
            }
            const remove = ports.deleteInstance(tart.plan, tart.plan.providerInstance);
            if (!currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording)) {
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
            if (!activate.ok) {
                const current = currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording);
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
                const recovery = {
                    ...(current.restoreRecovery || {}),
                    snapshotId: snapshot.id,
                    snapshotName: snapshot.name,
                    candidateProviderInstance: restoreCandidate,
                    failedAt: ports.timestamp(),
                    error: !remove.ok
                        ? `primary delete: ${ports.imageDiagnostic(remove, "operation")}; activation: ${ports.imageDiagnostic(activate, "operation")}`
                        : ports.imageDiagnostic(activate, "operation")
                };
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
                const evidence = activationClone.cleanup
                    ? lifecycle.cloneFailureEvidence(activate, activationClone.cleanup, tart.plan.providerInstance)
                    : null;
                return { kind: "restore-failed", cloneEvidence: evidence, error: recovery.error, candidate: restoreCandidate };
            }
            const current = currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording);
            if (!current) {
                return lifecycle.conflict(deviceId, "snapshot-restore-activate", {
                    found: Boolean(ports.find(deviceId)), matched: false
                }, {
                    ok: false,
                    attempted: false,
                    reason: "restore-candidate-preserved",
                    candidateProviderInstance: restoreCandidate
                });
            }
            const activated = ports.transition(deviceId, current, lifecycle.replacement(current, claim.lifecycle, {
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
            expectedRecording = null;
        }
        const cleanupOwner = currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording);
        if (!cleanupOwner) {
            return lifecycle.conflict(deviceId, "snapshot-restore", {
                found: Boolean(ports.find(deviceId)), matched: false
            }, {
                ok: false,
                attempted: false,
                reason: "restore-candidate-preserved",
                candidateProviderInstance: restoreCandidate
            });
        }
        const trackedRecovery = cleanupOwner.restoreRecovery;
        const cleanupResults = [restoreCandidate, ...(trackedRecovery?.supersededCandidateProviderInstances || [])]
            .map((instance) => ({
            instance, result: ports.deleteInstance(tart.plan, instance)
        }));
        const failedCleanups = cleanupResults.filter(({ result }) => !result.ok);
        const cleanup = failedCleanups[0]?.result || cleanupResults[0].result;
        const current = currentRecordingDevice(deviceId, claim.lifecycle, expectedRecording);
        if (!current) {
            return lifecycle.conflict(deviceId, "snapshot-restore", {
                found: Boolean(ports.find(deviceId)), matched: false
            }, failedCleanups.length === 0 ? null : {
                ok: false,
                attempted: true,
                reason: "restore-candidate-cleanup-failed",
                candidateProviderInstance: failedCleanups[0].instance,
                nativeStatus: cleanup.evidence
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
                error: ports.imageDiagnostic(cleanup, "cleanup")
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
                nativeStatus: cleanup.evidence
            });
        }
        return completedOutcome({ device: transition.device, snapshot, native: activate?.evidence || null, ...(activate ? {} : {resumedActivation: true}) });
    }
    /** @param {import("../ports/macos-image-snapshots.mjs").MacosImageInput} args
     * @returns {Promise<import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmLifecycleOutcome>} */
    async function deleteSnapshot(args) {
        const name = "device_snapshot_delete";
        const { deviceId, snapshotName, snapshotId } = args;
        const device = ports.find(deviceId);
        if (!device) {
            return refused(`Unknown macOS device: ${deviceId}`);
        }
        const snapshot = selectMacosSnapshot(device, snapshotName, snapshotId || (snapshotName ? ports.snapshotId(snapshotName) : null));
        if (!snapshot) {
            return refused(`Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
        }
        const tart = requireTart(device, name);
        if (!tart.ok) {
            return tart.error;
        }
        const claim = lifecycle.claimLifecycle(deviceId, device, "snapshot-delete");
        if (!claim.transition.matched) {
            return lifecycle.conflict(deviceId, "snapshot-delete-claim", claim.transition);
        }
        const r = ports.deleteInstance(tart.plan, snapshot.providerInstance);
        if (!r.ok) {
            lifecycle.abortLifecycle(deviceId, claim.lifecycle, device);
            return failed(r);
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
        return completedOutcome({ device: transition.device, deleted: snapshot.id, native: r.evidence });
    }
    return {
        clone, createSnapshot, restoreSnapshot, deleteSnapshot
    };
}
