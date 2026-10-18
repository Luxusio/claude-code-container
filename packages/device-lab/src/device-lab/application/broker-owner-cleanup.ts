import { recordingCopyPending } from "../domain/broker-recording.js";
import { cleanupRecord, isPhysicalState, deviceHasRuntimeMetadata, shouldStopOwnerDevice, cleanupFailureCount, ownerCleanupSelection, type PhysicalRecord, type CleanupLeaseGuard, type CleanupOptions, type CleanupDeviceOutcome, type CleanupCommandTarget, type AuxiliaryOutcome, type AuxiliaryCleanup, type CleanupSignal, type CleanupTermination, type CleanupDeviceReport, type CleanupBackendReport, type OwnerCleanupOutcome } from '../domain/broker-owner-cleanup.js';
import type { BrokerOwnerCleanupPorts, BrokerOwnerAuxiliaryAsyncPorts } from '../ports/broker-owner-cleanup.js';
export function createBrokerOwnerCleanupApplication<Handle, Receipt>(ports: BrokerOwnerCleanupPorts<Handle, Receipt>) {
    function readCurrent(ownerId: string, target: CleanupCommandTarget) {
        return ports.read(ownerId, target.stateKey).find((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === target.deviceId) || null;
    }
    function settledSignal(termination: CleanupTermination): CleanupSignal {
        return {...termination.receipt, ok: termination.ok && termination.ended};
    }
    function pendingRecordingSignal(recording: PhysicalRecord): CleanupSignal | null {
        return recordingCopyPending(recording)
            ? {attempted: false, ok: false, reason: 'recording-artifact-copy-pending'} : null;
    }
    function settledRecordingSignal(recording: PhysicalRecord, termination: CleanupTermination): CleanupSignal {
        const signal = settledSignal(termination);
        return signal.ok && recordingCopyPending({...recording, active: false, stoppedAt: ports.timestamp()})
            ? {...signal, ok: false, reason: 'recording-artifact-copy-pending'} : signal;
    }
    function cleanupRecording(recording: PhysicalRecord, stillCurrent: () => boolean): CleanupSignal {
        return pendingRecordingSignal(recording) || settledRecordingSignal(recording, ports.signalRecording(recording, stillCurrent));
    }
    function captureAuxiliary(ownerId: string, target: CleanupCommandTarget, expected: unknown) {
        let current = readCurrent(ownerId, target);
        const record = current;
        let stateConflict = !record || !ports.equal(record, expected);
        const stillCurrent = () => {
            if (stateConflict) return false;
            current = readCurrent(ownerId, target);
            stateConflict = !current || !ports.equal(current, expected);
            return !stateConflict;
        };
        const recording = record?.recording != null
            ? cleanupRecord(record.recording) ? record.recording : {} : null;
        const minimizeWatchdog = record && cleanupRecord(record.minimizeWatchdog) ? record.minimizeWatchdog : null;
        const minimizeWatchdogOwned = minimizeWatchdog?.processOwner === 'host-broker'
            && minimizeWatchdog?.startedBy === 'broker.windows-sandbox.minimize-watchdog';
        const cancelWatchdog = () => minimizeWatchdogOwned && stillCurrent() ? ports.cancelWatchdog(ownerId, target.deviceId) : null;
        function finish(appiumSignal: CleanupSignal | null, recordingSignal: CleanupSignal | null, cancellation: CleanupSignal | null) {
            stillCurrent();
            const appiumCleared = Boolean(appiumSignal?.ok), recordingCleared = Boolean(recordingSignal?.ok), watchdogCleared = Boolean(cancellation?.ok);
            const changed = (appiumCleared || recordingCleared || watchdogCleared) && !stateConflict;
            const result: AuxiliaryCleanup = {
                ok: (!appiumSignal || appiumCleared) && (!recordingSignal || recordingCleared) && (!cancellation || watchdogCleared) && !stateConflict,
                changed,
                ...(stateConflict ? {stateConflict: true} : {}),
                appium: appiumSignal ? {cleared: appiumCleared, signal: appiumSignal} : {cleared: false},
                recording: recordingSignal ? {cleared: recordingCleared, signal: recordingSignal} : {cleared: false},
                minimizeWatchdog: cancellation ? {cleared: watchdogCleared, cancellation} : {
                    cleared: false, ...(minimizeWatchdog && !minimizeWatchdogOwned ? {skipped: true, reason: 'not-broker-owned'} : {}),
                },
            };
            const device = changed ? {
                ...record,
                ...(appiumCleared ? {appium: null} : {}),
                ...(recordingCleared ? {recording: null} : {}),
                ...(watchdogCleared ? {minimizeWatchdog: null} : {}),
                updatedAt: ports.timestamp(),
            } : current;
            return {result, device, changed};
        }
        return {record, recording, stillCurrent, cancelWatchdog, finish};
    }
    function inspectAuxiliary(ownerId: string, target: CleanupCommandTarget, expected: unknown) {
        const inspection = captureAuxiliary(ownerId, target, expected);
        const appiumSignal = inspection.record?.appium != null && inspection.stillCurrent()
            ? settledSignal(ports.terminateAppium(inspection.record.appium, inspection.stillCurrent)) : null;
        const recordingSignal = inspection.recording && inspection.stillCurrent()
            ? cleanupRecording(inspection.recording, inspection.stillCurrent) : null;
        return inspection.finish(appiumSignal, recordingSignal, inspection.cancelWatchdog());
    }
    function publishAuxiliary(ownerId: string, target: CleanupCommandTarget, expected: unknown, pending: {result: AuxiliaryCleanup; device: unknown; changed: boolean}): AuxiliaryOutcome {
        if (!pending.changed) return {result: pending.result, device: pending.device, committed: false};
        const transition = ports.publish(ownerId, target.stateKey, target.deviceId, expected, pending.device);
        return {
            result: {...pending.result, ok: pending.result.ok && transition.matched, changed: transition.matched,
                ...(!transition.matched ? {stateConflict: true} : {})},
            device: transition.device,
            committed: transition.matched,
        };
    }
    function auxiliary(ownerId: string, target: CleanupCommandTarget, expected: unknown): AuxiliaryOutcome {
        return publishAuxiliary(ownerId, target, expected, inspectAuxiliary(ownerId, target, expected));
    }
    async function auxiliaryAsync(ownerId: string, target: CleanupCommandTarget, expected: unknown, effects: BrokerOwnerAuxiliaryAsyncPorts): Promise<AuxiliaryOutcome> {
        const inspection = captureAuxiliary(ownerId, target, expected);
        let appiumSignal: CleanupSignal | null = null;
        if (inspection.record?.appium != null && inspection.stillCurrent()) {
            const termination = await effects.terminateAppium(inspection.record.appium, inspection.stillCurrent);
            inspection.stillCurrent();
            appiumSignal = settledSignal(termination);
        }
        let recordingSignal: CleanupSignal | null = null;
        if (inspection.recording && inspection.stillCurrent()) {
            recordingSignal = pendingRecordingSignal(inspection.recording);
            if (!recordingSignal) {
                const termination = await effects.signalRecording(inspection.recording, inspection.stillCurrent);
                inspection.stillCurrent();
                recordingSignal = settledRecordingSignal(inspection.recording, termination);
            }
        }
        const pending = inspection.finish(appiumSignal, recordingSignal, inspection.cancelWatchdog());
        return publishAuxiliary(ownerId, target, expected, pending);
    }
    function cleanupDevice(ownerId: string, stateKey: string, device: unknown, options: CleanupOptions, guard?: CleanupLeaseGuard<Handle>): CleanupDeviceOutcome<Receipt> {
        if (!cleanupRecord(device) || typeof device.id !== 'string' || !device.id)
            return {device, changed: false, result: {skipped: true, reason: 'invalid-device-record'}};
        const deviceId = device.id;
        const backend = ports.stateBackends.get(stateKey) || stateKey;
        const target = {backend, stateKey, deviceId};
        const physical = isPhysicalState(stateKey);
        if (physical && options.detachPhysical && !guard)
            return ports.withLeaseGuard(ownerId, stateKey, device, lease => cleanupDevice(ownerId, stateKey, device, options, lease));
        if (guard?.admission.kind === 'refused') {
            return {device, changed: false, result: {stateKey, backend, deviceId, changed: false,
                physical: {detached: false, poweredOff: false, disconnected: false, lease: ports.releaseLease(ownerId, guard)}}};
        }
        const pending = inspectAuxiliary(ownerId, target, device);
        const result: CleanupDeviceReport<Receipt> = {
            stateKey, backend, deviceId, changed: pending.changed,
            ...(device.appium != null ? {appium: pending.result.appium} : {}),
            ...(device.recording != null ? {recording: pending.result.recording} : {}),
            ...(device.minimizeWatchdog != null ? {minimizeWatchdog: pending.result.minimizeWatchdog} : {}),
            ...(pending.result.stateConflict ? {stateConflict: true} : {}),
        };
        if (!pending.result.ok) return {device: pending.device, changed: pending.changed, result};
        const updated = cleanupRecord(pending.device) ? {...pending.device} : {...device};
        let changed = pending.changed;
        if (physical && options.detachPhysical && guard) {
            const current = readCurrent(ownerId, target);
            if (!current || !ports.equal(current, device)) return {
                device: current, changed: false, result: {...result, changed: false, stateConflict: true},
            };
            const lease = ports.releaseLease(ownerId, guard);
            if (lease.ok && updated.status !== 'detached') {
                updated.status = 'detached';
                changed = true;
            }
            result.physical = {detached: lease.ok, poweredOff: false, disconnected: false, lease};
        }
        if (changed) updated.updatedAt = ports.timestamp();
        result.changed = changed;
        if (!changed && !deviceHasRuntimeMetadata(device) && !device.minimizeWatchdog) result.skipped = true;
        return {device: changed ? updated : device, changed, result};
    }
    async function cleanup(ownerId: string, params: unknown): Promise<OwnerCleanupOutcome<Receipt>> {
        const selection = ownerCleanupSelection(params, ports.stateKeys, ports.backendAliases);
        if (!selection.ok) return {kind:'invalid-backend',error:'invalid-cleanup-backend',allowed:selection.allowed};
        const { stopDevices, detachPhysical, stateKeys } = selection;
        const results: CleanupBackendReport<Receipt>[] = [];
        let changedDevices = 0, failed = 0;
        for (const stateKey of stateKeys) {
            let backendChanged = false;
            const deviceResults: CleanupDeviceReport<Receipt>[] = [];
            let observedDevices: unknown[];
            try {
                observedDevices = ports.read(ownerId, stateKey);
            }
            catch (error) {
                failed += 1;
                results.push({
                    stateKey, ok: false, error: ports.stateErrorCode(error) || 'owner-devices-state-mutation-failed'
                });
                continue;
            }
            for (const observedDevice of observedDevices) {
                const deviceId = cleanupRecord(observedDevice) ? observedDevice.id : null;
                if (typeof deviceId !== 'string' || !deviceId) {
                    deviceResults.push(cleanupDevice(ownerId, stateKey, observedDevice, {
                        stopDevices, detachPhysical
                    }).result);
                    continue;
                }
                try {
                    const outcome = await ports.withDeviceOperation(ownerId, stateKey, deviceId, async () => {
                        const latest = ports.read(ownerId, stateKey).find((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === deviceId);
                        if (!latest)
                            return {
                                changed: false, result: {
                                    stateKey, backend: ports.stateBackends.get(stateKey) || stateKey, deviceId, skipped: true, reason: 'device-no-longer-present'
                                }
                            };
                        if (stopDevices && shouldStopOwnerDevice(stateKey, latest.status)) {
                            const backend = ports.stateBackends.get(stateKey) || stateKey;
                            const stopped = await ports.stopLocked(ownerId, {backend, stateKey, deviceId}, latest);
                            const stop = stopped.attempted
                                ? {attempted: true as const, ok: stopped.ok, observation: stopped.observation}
                                : {attempted: false as const, ok: false as const, error: stopped.error, ...(stopped.missing ? {missing: stopped.missing} : {})};
                            return {changed: stopped.changed, result: {
                                stateKey, backend, deviceId, changed: stopped.changed, stop,
                                ...(stopped.auxiliary && (latest.appium != null || stopped.auxiliary.appium.signal || stopped.auxiliary.appium.cleared) ? {appium: stopped.auxiliary.appium} : {}),
                                ...(stopped.auxiliary && (latest.recording != null || stopped.auxiliary.recording.signal || stopped.auxiliary.recording.cleared) ? {recording: stopped.auxiliary.recording} : {}),
                                ...(stopped.auxiliary && (latest.minimizeWatchdog != null || stopped.auxiliary.minimizeWatchdog.cancellation || stopped.auxiliary.minimizeWatchdog.cleared) ? {minimizeWatchdog: stopped.auxiliary.minimizeWatchdog} : {}),
                                ...(stopped.stateConflict || stopped.auxiliary?.stateConflict ? {stateConflict: true} : {}),
                            }};
                        }
                        const cleanupAndPersist = (guard?: CleanupLeaseGuard<Handle>): {changed:boolean;result:CleanupDeviceReport<Receipt>} => {
                            const runtime = cleanupDevice(ownerId, stateKey, latest, {
                                stopDevices, detachPhysical
                            }, guard);
                            let persisted = !runtime.changed, stateConflict = false;
                            if (runtime.changed) {
                                try {
                                    const publication = ports.publish(ownerId, stateKey, deviceId, latest, runtime.device);
                                    persisted = publication.matched;
                                    stateConflict = publication.found && !publication.matched;
                                }
                                catch (error) {
                                    const lease = runtime.result.physical?.lease;
                                    const rollback = guard?.canRestore && lease?.kind === 'released' ? ports.restoreLease(ownerId, guard) : {
                                        kind: 'not-needed' as const, attempted: false as const, ok: true as const
                                    };
                                    return {
                                        changed: false, result: {
                                            ...runtime.result, changed: false, stateWrite: {
                                                ok: false, error: rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed', detail: error instanceof Error ? error.message : String(error), leaseRollback: rollback
                                            }
                                        }
                                    };
                                }
                            }
                            return {
                                changed: runtime.changed && persisted, result: {
                                    ...runtime.result, changed: runtime.changed && persisted, ...(stateConflict || !persisted ? {
                                        stateConflict: true
                                    } : {})
                                }
                            };
                        };
                        return isPhysicalState(stateKey) && detachPhysical
                            ? ports.withLeaseGuard(ownerId, stateKey, latest, cleanupAndPersist) : cleanupAndPersist();
                    });
                    if (outcome.changed) {
                        backendChanged = true;
                        changedDevices += 1;
                    }
                    deviceResults.push(outcome.result);
                    failed += cleanupFailureCount(outcome.result);
                }
                catch (error) {
                    if (!ports.isDeviceLockTimeout(error))
                        throw error;
                    failed += 1;
                    deviceResults.push({
                        stateKey, backend: ports.stateBackends.get(stateKey) || stateKey, deviceId, changed: false, error: 'device-operation-lock-failed', detail: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            results.push({
                stateKey, ok: true, changed: backendChanged, devices: deviceResults
            });
        }
        return {kind:'cleaned',ownerId,cleaned:true,stopDevices,detachPhysical,changedDevices,failed,results,authority:'host-broker'};
    }
    return {
        cleanup, cleanupDevice, auxiliary, auxiliaryAsync
    };
}
