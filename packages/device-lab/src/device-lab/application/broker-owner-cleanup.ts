import { cleanupRecord, isPhysicalState, deviceHasRuntimeMetadata, shouldStopOwnerDevice, cleanupFailureCount, ownerCleanupSelection, type PhysicalRecord, type CleanupLeaseGuard, type CleanupOptions, type CleanupDeviceOutcome, type CleanupCommandTarget, type AuxiliaryOutcome, type CleanupDeviceReport, type CleanupBackendReport, type OwnerCleanupOutcome } from '../domain/broker-owner-cleanup.js';
import type { BrokerOwnerCleanupPorts } from '../ports/broker-owner-cleanup.js';
export function createBrokerOwnerCleanupApplication<Handle, Prepared, Receipt>(ports: BrokerOwnerCleanupPorts<Handle, Prepared, Receipt>) {
    function auxiliary(ownerId: string, parsed: CleanupCommandTarget, expected: unknown): AuxiliaryOutcome {
        const observed = ports.read(ownerId, parsed.stateKey).find((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === parsed.deviceId);
        if (!observed || !ports.equal(observed, expected))
            return {
                result: {
                    ok: false, changed: false, stateConflict: true, appium: {
                        cleared: false
                    }, recording: {
                        cleared: false
                    }, minimizeWatchdog: {
                        cleared: false
                    }
                },
                device: observed || null,
                committed: false,
            };
        const record = observed;
        const appiumSignal = record.appium != null ? ports.terminateAppium(record.appium) : null;
        const recording = cleanupRecord(record.recording) ? record.recording : null;
        const recordingSignal = recording ? ports.signalRecording(recording) : null;
        const minimizeWatchdog = cleanupRecord(record.minimizeWatchdog) ? record.minimizeWatchdog : null;
        const minimizeWatchdogOwned = minimizeWatchdog?.processOwner === 'host-broker'
            && minimizeWatchdog?.startedBy === 'broker.windows-sandbox.minimize-watchdog';
        const cancellation = minimizeWatchdogOwned ? ports.cancelWatchdog(ownerId, parsed.deviceId) : null;
        const appiumCleared = Boolean(appiumSignal?.ok), recordingCleared = Boolean(recordingSignal?.ok), watchdogCleared = Boolean(cancellation?.ok);
        const changed = appiumCleared || recordingCleared || watchdogCleared;
        const transition = changed ? ports.publish(ownerId, parsed.stateKey, parsed.deviceId, expected, {
            ...record,
            ...(appiumCleared ? {
                appium: null
            } : {}),
            ...(recordingCleared ? {
                recording: null
            } : {}),
            ...(watchdogCleared ? {
                minimizeWatchdog: null
            } : {}),
            updatedAt: ports.timestamp(),
        }) : {
            found: true, matched: true, device: observed
        };
        const stateConflict = !transition.matched;
        return {
            result: {
                ok: (!appiumSignal || appiumCleared) && (!recordingSignal || recordingCleared) && (!cancellation || watchdogCleared) && !stateConflict,
                changed: changed && !stateConflict,
                ...(stateConflict ? {
                    stateConflict: true
                } : {}),
                appium: appiumSignal ? {
                    cleared: appiumCleared, signal: appiumSignal
                } : {
                    cleared: false
                },
                recording: recordingSignal ? {
                    cleared: recordingCleared, signal: recordingSignal
                } : {
                    cleared: false
                },
                minimizeWatchdog: cancellation ? {
                    cleared: watchdogCleared, cancellation
                } : {
                    cleared: false, ...(minimizeWatchdog ? {
                        skipped: true, reason: 'not-broker-owned'
                    } : {})
                },
            },
            device: transition.device,
            committed: changed && transition.matched,
        };
    }
    function cleanupDevice(ownerId: string, stateKey: string, device: unknown, options: CleanupOptions, guard?: CleanupLeaseGuard<Handle>): CleanupDeviceOutcome<Receipt> {
        if (!cleanupRecord(device))
            return {
                device, changed: false, result: {
                    skipped: true, reason: 'invalid-device-record'
                }
            };
        const id = typeof device.id === 'string' ? device.id : null;
        const backend = ports.stateBackends.get(stateKey) || stateKey;
        const result: CleanupDeviceReport<Receipt> = {
            stateKey, backend, deviceId: id, changed: false
        };
        const physical = isPhysicalState(stateKey);
        if (physical && options.detachPhysical && !guard)
            return ports.withLeaseGuard(ownerId, stateKey, device, lease => cleanupDevice(ownerId, stateKey, device, options, lease));
        if (guard?.admission.kind === 'refused') {
            result.physical = {
                detached: false, poweredOff: false, disconnected: false, lease: ports.releaseLease(ownerId, guard)
            };
            return {
                device, changed: false, result
            };
        }
        const updated = {
            ...device
        };
        let changed = false;
        if (device.appium != null) {
            const signal = ports.terminateAppium(device.appium);
            if (signal.ok) {
                updated.appium = null;
                changed = true;
            }
            result.appium = {
                cleared: signal.ok, signal
            };
        }
        if (device.recording != null) {
            const signal = ports.signalRecording(cleanupRecord(device.recording) ? device.recording : {});
            if (signal.ok) {
                updated.recording = null;
                changed = true;
            }
            result.recording = {
                cleared: signal.ok, signal
            };
        }
        if (physical && options.detachPhysical && guard) {
            const lease = ports.releaseLease(ownerId, guard);
            if (lease.ok && updated.status !== 'detached') {
                updated.status = 'detached';
                changed = true;
            }
            result.physical = {
                detached: lease.ok, poweredOff: false, disconnected: false, lease
            };
        }
        else if (options.stopDevices && id && shouldStopOwnerDevice(stateKey, device.status)) {
            const prepared = ports.prepareStop(ownerId, {
                backend, stateKey, deviceId: id
            }, device);
            if (prepared.kind === 'unavailable')
                result.stop = {
                    attempted: false, ok: false, error: prepared.error, missing: prepared.missing
                };
            else {
                const observation = ports.runPreparedStop(prepared.handle);
                const ok = observation.ok;
                result.stop = {
                    attempted: true, ok, observation
                };
                if (ok) {
                    updated.status = 'stopped';
                    if (stateKey === 'windows')
                        ports.releaseWindows(ownerId, device, observation);
                    changed = true;
                }
            }
        }
        if (changed)
            updated.updatedAt = ports.timestamp();
        result.changed = changed;
        if (!changed && !deviceHasRuntimeMetadata(device))
            result.skipped = true;
        return {
            device: changed ? updated : device, changed, result
        };
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
                    const outcome = await ports.withDeviceOperation(ownerId, stateKey, deviceId, () => {
                        const latest = ports.read(ownerId, stateKey).find((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === deviceId);
                        if (!latest)
                            return {
                                changed: false, result: {
                                    stateKey, backend: ports.stateBackends.get(stateKey) || stateKey, deviceId, skipped: true, reason: 'device-no-longer-present'
                                }
                            };
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
                                            ...runtime.result, stateWrite: {
                                                ok: false, error: rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed', detail: error instanceof Error ? error.message : String(error), leaseRollback: rollback
                                            }
                                        }
                                    };
                                }
                            }
                            return {
                                changed: runtime.changed && persisted, result: {
                                    ...runtime.result, ...(stateConflict || !persisted ? {
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
        cleanup, cleanupDevice, auxiliary
    };
}
