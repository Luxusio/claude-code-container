import { validateAttachParams, validateAppleTrustParams, physicalParamError, detachedPhysicalDeviceCanReattach, appleTrustDiagnostic, commandSucceeded, physicalStopCommand, physicalStopReplacement, physicalFailureDetail, type AttachParams, type PhysicalStopRequest } from '../domain/broker-physical-devices.js';
import { cleanupRecord, type PhysicalRecord, type CleanupRpcResult, type CleanupLeaseGuard, type CleanupPublication } from '../domain/broker-owner-cleanup.js';
import type { BrokerPhysicalDevicesPorts, AndroidInventory } from '../ports/broker-physical-devices.js';
export function createBrokerPhysicalDevicesApplication<Handle>(ports: BrokerPhysicalDevicesPorts<Handle>) {
    function existingPhysicalDevice(ownerId: string, stateKey: string, deviceId: string, hardwareId: string, field: 'serial' | 'udid') {
        return ports.read(ownerId, stateKey).find((device): device is PhysicalRecord => cleanupRecord(device) && (device.id === deviceId || device[field] === hardwareId));
    }
    function resolveSingleUsbAndroidTarget(parsed: AttachParams): {
        ok: true;
        target: string;
        inventory: AndroidInventory;
    } | {
        ok: false;
        status: number;
        payload: Record<string, unknown>;
    } {
        const inventory = ports.androidInventory();
        if (!inventory.ok)
            return {
                ok: false, status: 502, payload: {
                    ok: false, error: "adb-inventory-failed", inventory
                }
            };
        const candidates = inventory.devices.filter((device) => device.connection === "usb" && device.attachable);
        if (candidates.length === 1)
            return {
                ok: true, target: candidates[0].serial, inventory
            };
        return {
            ok: false,
            status: candidates.length === 0 ? 404 : 409,
            payload: {
                ok: false,
                error: candidates.length === 0 ? "android-device-not-visible" : "android-device-selection-required",
                backend: parsed.backend,
                connection: parsed.connection,
                hostDevices: inventory.devices,
                candidates,
                message: candidates.length === 0
                    ? "No attachable USB Android device is visible to host adb."
                    : "Multiple attachable USB Android devices are visible; pass serial.",
            },
        };
    }
    function brokerAttachAndroid(ownerId: string, parsed: AttachParams) {
        if (parsed.connection === "wifi" && !parsed.host && !parsed.serial) {
            return {
                status: 400, payload: {
                    ok: false, error: "missing-android-wifi-target"
                }
            };
        }
        let initialInventory: AndroidInventory | null = null;
        const resolvedUsbTarget = parsed.connection === "usb" && !parsed.serial
            ? resolveSingleUsbAndroidTarget(parsed)
            : null;
        if (resolvedUsbTarget && !resolvedUsbTarget.ok)
            return {
                status: resolvedUsbTarget.status, payload: resolvedUsbTarget.payload
            };
        if (resolvedUsbTarget?.ok)
            initialInventory = resolvedUsbTarget.inventory;
        const target = parsed.connection === "wifi"
            ? (parsed.serial?.includes(":") ? parsed.serial : `${parsed.host || parsed.serial}:${parsed.port || 5555}`)
            : (parsed.serial || (resolvedUsbTarget?.ok ? resolvedUsbTarget.target : null));
        if (!target || target.startsWith("emulator-")) {
            return {
                status: 400, payload: {
                    ok: false, error: target?.startsWith("emulator-") ? "android-emulator-not-physical-device" : "missing-android-serial"
                }
            };
        }
        const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, target, "serial");
        if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, target, "serial")) {
            return {
                status: 409, payload: {
                    ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: target
                }
            };
        }
        const leaseClaimNonce = ports.nonce();
        const lease = ports.claimLease(ownerId, {
            backend: parsed.backend,
            hardwareId: target,
            deviceId: parsed.deviceId,
            connection: parsed.connection,
            claimNonce: leaseClaimNonce,
            transport: parsed.connection === "wifi" ? {
                type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555)
            } : {
                type: "usb"
            },
        });
        if (lease.status !== 200)
            return lease;
        const leasePayload = cleanupRecord(lease.payload) ? lease.payload : {};
        const leaseResult = cleanupRecord(leasePayload.result) ? leasePayload.result : {};
        const leaseRecord = cleanupRecord(leaseResult.lease) ? leaseResult.lease : undefined;
        const releaseLease = () => ports.releaseClaim(ownerId, {
            backend: parsed.backend,
            hardwareId: target,
            deviceId: parsed.deviceId,
            claimId: leaseRecord?.claimId,
            claimNonce: leaseClaimNonce,
        });
        if (parsed.connection === "wifi") {
            const connect = ports.connectAndroid(target);
            if (!commandSucceeded(connect)) {
                releaseLease();
                return {
                    status: 502, payload: {
                        ok: false, error: "adb-connect-failed", command: connect
                    }
                };
            }
        }
        const inventory = initialInventory || ports.androidInventory();
        if (!inventory.ok) {
            releaseLease();
            return {
                status: 502, payload: {
                    ok: false, error: "adb-inventory-failed", inventory
                }
            };
        }
        const hostDevice = inventory.devices.find((device) => device.serial === target);
        if (!hostDevice) {
            releaseLease();
            return {
                status: 404, payload: {
                    ok: false, error: "android-device-not-visible", hardwareId: target, inventory
                }
            };
        }
        if (hostDevice.state !== "device") {
            releaseLease();
            return {
                status: 409, payload: {
                    ok: false, error: "android-device-not-attachable", hardwareId: target, state: hostDevice.state
                }
            };
        }
        const now = ports.timestamp();
        const device = {
            id: parsed.deviceId,
            name: parsed.name || target,
            backend: "android-device",
            kind: "mobile",
            platform: "android",
            physical: true,
            ownerId,
            serial: target,
            connection: parsed.connection,
            transport: parsed.connection === "wifi" ? {
                type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555)
            } : {
                type: "usb", host: null, port: null
            },
            hostDetails: hostDevice.details,
            leaseClaimId: leaseRecord?.claimId,
            leaseClaimNonce,
            status: "attached",
            creatable: false,
            attachable: true,
            attachedAt: now,
            updatedAt: now,
        };
        try {
            const claim = ports.claimDevice(ownerId, parsed.stateKey, device, "serial");
            if (!claim.ok) {
                releaseLease();
                return {
                    status: 409, payload: {
                        ok: false, error: claim.error, existing: claim.existing
                    }
                };
            }
        }
        catch (error) {
            releaseLease();
            return {
                status: 500, payload: {
                    ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error)
                }
            };
        }
        const heartbeat = ports.heartbeat(ownerId, parsed.backend, target, parsed.deviceId, leaseRecord, leaseClaimNonce);
        return {
            status: 200, payload: {
                ok: true, result: {
                    device, lease: leaseResult.lease, heartbeat, provider: "adb", inventory
                }
            }
        };
    }
    function brokerAttachIos(ownerId: string, parsed: AttachParams) {
        if (!parsed.udid)
            return {
                status: 400, payload: {
                    ok: false, error: "missing-ios-udid"
                }
            };
        const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, parsed.udid, "udid");
        if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, parsed.udid, "udid")) {
            return {
                status: 409, payload: {
                    ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: parsed.udid
                }
            };
        }
        const inventory = ports.appleInventory();
        if (!commandSucceeded(inventory))
            return {
                status: 502, payload: {
                    ok: false, error: "xctrace-inventory-failed", command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, null, inventory)
                }
            };
        const hostDevice = ports.appleDevices(inventory.stdout || "").find((device) => device.udid === parsed.udid);
        if (!hostDevice)
            return {
                status: 404, payload: {
                    ok: false, error: "ios-device-not-visible", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, null, inventory)
                }
            };
        if (hostDevice.availability === "unavailable") {
            return {
                status: 409, payload: {
                    ok: false, error: "ios-device-not-attachable", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, hostDevice, inventory)
                }
            };
        }
        if (parsed.connection === "wifi" && hostDevice.connection !== "wifi") {
            return {
                status: 409, payload: {
                    ok: false, error: "ios-wifi-device-not-network-visible", hardwareId: parsed.udid, diagnostic: appleTrustDiagnostic("connect", parsed.udid, hostDevice, inventory)
                }
            };
        }
        const connection = parsed.connectionProvided ? parsed.connection : hostDevice.connection;
        const leaseClaimNonce = ports.nonce();
        const lease = ports.claimLease(ownerId, {
            backend: parsed.backend,
            hardwareId: parsed.udid,
            deviceId: parsed.deviceId,
            connection,
            claimNonce: leaseClaimNonce,
            transport: {
                type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace"
            },
        });
        if (lease.status !== 200)
            return lease;
        const leasePayload = cleanupRecord(lease.payload) ? lease.payload : {};
        const leaseResult = cleanupRecord(leasePayload.result) ? leasePayload.result : {};
        const leaseRecord = cleanupRecord(leaseResult.lease) ? leaseResult.lease : undefined;
        const releaseLease = () => ports.releaseClaim(ownerId, {
            backend: parsed.backend,
            hardwareId: parsed.udid,
            deviceId: parsed.deviceId,
            claimId: leaseRecord?.claimId,
            claimNonce: leaseClaimNonce,
        });
        const now = ports.timestamp();
        const device = {
            id: parsed.deviceId,
            name: parsed.name || hostDevice.name || parsed.udid,
            backend: "ios-device",
            kind: "mobile",
            platform: "ios",
            physical: true,
            ownerId,
            udid: parsed.udid,
            connection,
            transport: {
                type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace"
            },
            hostDetails: hostDevice,
            leaseClaimId: leaseRecord?.claimId,
            leaseClaimNonce,
            status: "attached",
            creatable: false,
            attachable: true,
            attachedAt: now,
            updatedAt: now,
        };
        try {
            const claim = ports.claimDevice(ownerId, parsed.stateKey, device, "udid");
            if (!claim.ok) {
                releaseLease();
                return {
                    status: 409, payload: {
                        ok: false, error: claim.error, existing: claim.existing
                    }
                };
            }
        }
        catch (error) {
            releaseLease();
            return {
                status: 500, payload: {
                    ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error)
                }
            };
        }
        const heartbeat = ports.heartbeat(ownerId, parsed.backend, parsed.udid, parsed.deviceId, leaseRecord, leaseClaimNonce);
        return {
            status: 200, payload: {
                ok: true, result: {
                    device, lease: leaseResult.lease, heartbeat, provider: "xcrun", inventory
                }
            }
        };
    }
    function trust(ownerId: string, params: unknown) {
        const parsed = validateAppleTrustParams(params);
        if (!parsed.ok)
            return physicalParamError(parsed);
        const inventory = ports.appleInventory();
        if (!commandSucceeded(inventory)) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: inventory.error === "executable-not-found" ? "ios-wireless-missing-xcrun" : "xctrace-inventory-failed",
                    result: {
                        ownerId,
                        ...appleTrustDiagnostic(parsed.action, parsed.udid, null, inventory),
                    },
                },
            };
        }
        const devices = ports.appleDevices(inventory.stdout || "");
        const selected = parsed.udid ? devices.find((device) => device.udid === parsed.udid) || null : null;
        const diagnostic = {
            ownerId,
            ...appleTrustDiagnostic(parsed.action, parsed.udid, selected, inventory),
            inventory: {
                devices,
                count: devices.length,
            },
        };
        if (parsed.action === "status") {
            return {
                status: 200, payload: {
                    ok: true, result: diagnostic
                }
            };
        }
        if (selected?.connection === "wifi" && selected.availability !== "unavailable" && parsed.action === "connect") {
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...diagnostic, alreadyNetworkVisible: true, manualRequired: false
                    }
                }
            };
        }
        return {
            status: 409,
            payload: {
                ok: false,
                error: "ios-apple-pairing-manual-required",
                result: diagnostic,
            },
        };
    }
    function attach(ownerId: string, params: unknown): CleanupRpcResult {
        const parsed = validateAttachParams(params, ports.deriveDeviceId);
        if (!parsed.ok)
            return physicalParamError(parsed);
        return parsed.backend === 'android-device' ? brokerAttachAndroid(ownerId, parsed) : brokerAttachIos(ownerId, parsed);
    }
    function detach(ownerId: string, params: unknown): CleanupRpcResult {
        const parsed = validateAttachParams(params, ports.deriveDeviceId);
        if (!parsed.ok)
            return physicalParamError(parsed);
        if (!cleanupRecord(params) || typeof params.deviceId !== 'string' || !params.deviceId.trim())
            return {
                status: 400, payload: {
                    ok: false, error: 'invalid-device-id'
                }
            };
        const device = ports.read(ownerId, parsed.stateKey).find((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === parsed.deviceId);
        if (!device)
            return {
                status: 404, payload: {
                    ok: false, error: 'owner-device-not-found', deviceId: parsed.deviceId
                }
            };
        const request = {
            backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, force: false, dryRun: false
        };
        return ports.withDetachLease(ownerId, parsed, device, guard => {
            const preflight = guard.preflight;
            if (preflight && preflight.status !== 200 && preflight.status !== 404)
                return {
                    status: preflight.status === 409 ? 409 : 502, payload: {
                        ok: false, error: 'physical-lease-release-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, release: preflight.payload
                    }
                };
            const auxiliary = ports.auxiliary(ownerId, request, device);
            if (auxiliary.result.ok === false)
                return {
                    status: 502, payload: {
                        ok: false, error: 'auxiliary-runtime-cleanup-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, result: {
                            device: ports.redact(auxiliary.device || device), auxiliaryCleanup: auxiliary.result, detached: false
                        }
                    }
                };
            const cleaned = auxiliary.device || device;
            const release = guard.canRestore && !preflight ? ports.releaseLease(ownerId, guard) : preflight;
            try {
                ports.removeDevice(ownerId, parsed.stateKey, parsed.deviceId);
            }
            catch (error) {
                const rollback = guard.canRestore && !preflight ? ports.restoreLease(ownerId, guard) : {
                    attempted: false, ok: true
                };
                return {
                    status: rollback.ok ? 500 : 502, payload: {
                        ok: false, error: rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: error instanceof Error ? error.message : String(error), result: {
                            device: ports.redact(cleaned), detached: false, release: release?.payload || null, leaseRollback: rollback, auxiliaryCleanup: auxiliary.result
                        }
                    }
                };
            }
            return {
                status: 200, payload: {
                    ok: true, result: {
                        detached: parsed.deviceId, device: ports.redact(cleaned), release: release?.payload || null, auxiliaryCleanup: auxiliary.result, physicalDevicePoweredOff: false, disconnected: false
                    }
                }
            };
        });
    }
    function stop(ownerId: string, parsed: PhysicalStopRequest, plan: PhysicalRecord, expected: unknown): CleanupRpcResult {
        if (parsed.dryRun)
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...plan, invoked: false, dryRun: true, execution: {
                            mode: 'dry-run', providerExecution: 'available', mutatesHost: false
                        }
                    }
                }
            };
        const device = cleanupRecord(plan.device) ? plan.device : null;
        if (!device)
            return {
                status: 404, payload: {
                    ok: false, error: 'owner-device-not-found', ownerId, backend: parsed.backend, deviceId: parsed.deviceId
                }
            };
        return ports.withLeaseGuard(ownerId, parsed.stateKey, device, guard => stopWithGuard(ownerId, parsed, plan, expected, guard));
    }
    function stopWithGuard(ownerId: string, parsed: PhysicalStopRequest, plan: PhysicalRecord, expected: unknown, guard: CleanupLeaseGuard<Handle>): CleanupRpcResult {
        if (guard.preflight && guard.preflight.status !== 404) {
            const lease = ports.releaseLease(ownerId, guard);
            return {
                status: lease.status === 409 ? 409 : 502, payload: {
                    ok: false, error: 'physical-lease-cleanup-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, result: {
                        ...plan, physicalLeaseCleanup: lease, invoked: false, dryRun: false
                    }
                }
            };
        }
        const auxiliary = ports.auxiliary(ownerId, parsed, expected);
        if (auxiliary.committed)
            expected = ports.clone(auxiliary.device);
        if (!auxiliary.result.ok)
            return {
                status: 502, payload: {
                    ok: false, error: 'auxiliary-runtime-cleanup-failed', result: {
                        ...plan, device: ports.redact(auxiliary.device), auxiliaryCleanup: auxiliary.result, invoked: false, dryRun: false, execution: {
                            mode: 'preflight', providerExecution: 'blocked', mutatesHost: auxiliary.result.changed === true || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true
                        }
                    }
                }
            };
        const command = physicalStopCommand(parsed.backend);
        const execution = ports.execute(command);
        const success = commandSucceeded(execution);
        const lease = success ? ports.releaseLease(ownerId, guard) : null;
        if (lease && !lease.ok)
            return {
                status: lease.status === 409 ? 409 : 502, payload: {
                    ok: false, error: 'physical-lease-cleanup-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, result: {
                        ...plan, physicalLeaseCleanup: lease, invoked: true, dryRun: false, execution: {
                            mode: execution.mode, providerExecution: 'executed', mutatesHost: auxiliary.result.changed === true, command: execution
                        }
                    }
                }
            };
        let publication: CleanupPublication | null = null;
        let updatedDevice = plan.device;
        try {
            if (success) {
                publication = ports.publish(ownerId, parsed.stateKey, parsed.deviceId, expected, physicalStopReplacement(cleanupRecord(expected) ? expected : {}, ports.timestamp()));
                updatedDevice = publication.device;
            }
        }
        catch (error) {
            if (!guard.canRestore || lease?.status !== 200)
                throw error;
            const rollback = ports.restoreLease(ownerId, guard);
            return {
                status: rollback.ok ? 500 : 502, payload: {
                    ok: false, error: rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: 'physical-device-state-transition-failed', result: {
                        ...plan, device: ports.redact(auxiliary.device || plan.device), physicalLeaseCleanup: lease, leaseRollback: rollback, invoked: true, dryRun: false, execution: {
                            mode: execution.mode, providerExecution: 'executed', mutatesHost: auxiliary.result.changed === true, command: execution
                        }
                    }
                }
            };
        }
        return {
            status: publication && !publication.matched ? 409 : success ? 200 : 502, payload: {
                ok: success && (!publication || publication.matched), ...(publication && !publication.matched ? {
                    error: 'owner-device-state-conflict', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, found: publication.found, ...(!success ? {
                        providerFailure: 'provider-command-failed'
                    } : {})
                } : {}), ...(success || publication && !publication.matched ? {} : {
                    error: 'provider-command-failed', detail: physicalFailureDetail(execution)
                }), result: {
                    ...plan, providerCommand: command, device: ports.redact(updatedDevice), auxiliaryCleanup: auxiliary.result, ...(lease ? {
                        physicalLeaseCleanup: lease
                    } : {}), invoked: true, dryRun: false, execution: {
                        mode: execution.mode, providerExecution: 'executed', mutatesHost: success, command: execution
                    }
                }
            }
        };
    }
    return {
        attach, detach, trust, stop
    };
}
