import { validateAttachParams, validateAppleTrustParams, detachedPhysicalDeviceCanReattach, appleTrustFacts, physicalStopReplacement, type AttachParams, type PhysicalStopRequest, type AttachOutcome, type DetachOutcome, type TrustOutcome, type PhysicalStopOutcome } from '../domain/broker-physical-devices.js';
import { cleanupRecord, type PhysicalRecord, type CleanupLeaseGuard, type CleanupPublication, type CleanupLeaseResult } from '../domain/broker-owner-cleanup.js';
import type { BrokerPhysicalDevicesPorts, AndroidInventory } from '../ports/broker-physical-devices.js';
export function createBrokerPhysicalDevicesApplication<Handle, Receipt>(ports: BrokerPhysicalDevicesPorts<Handle, Receipt>) {
    function existingPhysicalDevice(ownerId: string, stateKey: string, deviceId: string, hardwareId: string, field: 'serial' | 'udid') {
        return ports.read(ownerId, stateKey).find((device): device is PhysicalRecord => cleanupRecord(device) && (device.id === deviceId || device[field] === hardwareId));
    }
    function resolveSingleUsbAndroidTarget(parsed: AttachParams): {ok:true;target:string;inventory:AndroidInventory} | ({ok:false} & Extract<AttachOutcome<Receipt>, {kind:'attach-refused'}>) {
        const inventory = ports.androidInventory();
        if (!inventory.ok)
            return {
                ok: false, kind:'attach-refused',category:'provider-failed', error: "adb-inventory-failed", inventory
            };
        const candidates = inventory.devices.filter((device) => device.connection === "usb" && device.attachable);
        if (candidates.length === 1)
            return {
                ok: true, target: candidates[0].serial, inventory
            };
        return {ok:false,kind:'attach-refused',category:candidates.length === 0 ? 'missing' : 'conflict',
            error:candidates.length === 0 ? 'android-device-not-visible' : 'android-device-selection-required',
            backend:parsed.backend,connection:parsed.connection,hostDevices:inventory.devices,candidates,
            selectionReason:candidates.length === 0 ? 'no-attachable-usb' : 'multiple-attachable-usb'};

    }
    function brokerAttachAndroid(ownerId: string, parsed: AttachParams): AttachOutcome<Receipt> {
        if (parsed.connection === "wifi" && !parsed.host && !parsed.serial) {
            return {kind:'attach-refused',category:'invalid',error: "missing-android-wifi-target"};
        }
        let initialInventory: AndroidInventory | null = null;
        const resolvedUsbTarget = parsed.connection === "usb" && !parsed.serial
            ? resolveSingleUsbAndroidTarget(parsed)
            : null;
        if (resolvedUsbTarget && !resolvedUsbTarget.ok)
            return resolvedUsbTarget;
        if (resolvedUsbTarget?.ok)
            initialInventory = resolvedUsbTarget.inventory;
        const target = parsed.connection === "wifi"
            ? (parsed.serial?.includes(":") ? parsed.serial : `${parsed.host || parsed.serial}:${parsed.port || 5555}`)
            : (parsed.serial || (resolvedUsbTarget?.ok ? resolvedUsbTarget.target : null));
        if (!target || target.startsWith("emulator-")) {
            return {kind:'attach-refused',category:'invalid',error: target?.startsWith("emulator-") ? "android-emulator-not-physical-device" : "missing-android-serial"};
        }
        const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, target, "serial");
        if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, target, "serial")) {
            return {kind:'attach-refused',category:'conflict',error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: target};
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
        if (lease.kind !== 'claimed') return {kind:'lease-refused',failure:lease};
        const leaseRecord = lease.lease;
        const releaseLease = () => ports.releaseClaim(ownerId, {
            backend: parsed.backend,
            hardwareId: target,
            deviceId: parsed.deviceId,
            claimId: leaseRecord?.claimId,
            claimNonce: leaseClaimNonce,
        });
        if (parsed.connection === "wifi") {
            const connect = ports.connectAndroid(target);
            if (!connect.ok) {
                releaseLease();
                return {kind:'attach-refused',category:'provider-failed',error: "adb-connect-failed", command: connect};
            }
        }
        const inventory = initialInventory || ports.androidInventory();
        if (!inventory.ok) {
            releaseLease();
            return {kind:'attach-refused',category:'provider-failed',error: "adb-inventory-failed", inventory};
        }
        const hostDevice = inventory.devices.find((device) => device.serial === target);
        if (!hostDevice) {
            releaseLease();
            return {kind:'attach-refused',category:'missing',error: "android-device-not-visible", hardwareId: target, inventory};
        }
        if (hostDevice.state !== "device") {
            releaseLease();
            return {kind:'attach-refused',category:'conflict',error: "android-device-not-attachable", hardwareId: target, state: hostDevice.state};
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
                return {kind:'attach-refused',category:'conflict',error: claim.error, existing: claim.existing};
            }
        }
        catch (error) {
            releaseLease();
            return {kind:'attach-refused',category:'state-write-failed',error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error)};
        }
        const heartbeat = ports.heartbeat(ownerId, parsed.backend, target, parsed.deviceId, leaseRecord, leaseClaimNonce);
        return {kind:'attached',device, lease: leaseRecord, heartbeat, provider: "adb", inventory};
    }
    function brokerAttachIos(ownerId: string, parsed: AttachParams): AttachOutcome<Receipt> {
        if (!parsed.udid)
            return {kind:'attach-refused',category:'invalid',error: "missing-ios-udid"};
        const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, parsed.udid, "udid");
        if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, parsed.udid, "udid")) {
            return {kind:'attach-refused',category:'conflict',error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: parsed.udid};
        }
        const inventory = ports.appleInventory();
        if (inventory.kind === 'failed')
            return {kind:'attach-refused',category:'provider-failed',error: "xctrace-inventory-failed", command: inventory, diagnostic: appleTrustFacts("status", parsed.udid, null)};
        const hostDevice = inventory.devices.find((device) => device.udid === parsed.udid);
        if (!hostDevice)
            return {kind:'attach-refused',category:'missing',error: "ios-device-not-visible", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustFacts("status", parsed.udid, null)};
        if (hostDevice.availability === "unavailable") {
            return {kind:'attach-refused',category:'conflict',error: "ios-device-not-attachable", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustFacts("status", parsed.udid, hostDevice)};
        }
        if (parsed.connection === "wifi" && hostDevice.connection !== "wifi") {
            return {kind:'attach-refused',category:'conflict',error: "ios-wifi-device-not-network-visible", hardwareId: parsed.udid, inventoryObservation:inventory, diagnostic: appleTrustFacts("connect", parsed.udid, hostDevice)};
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
        if (lease.kind !== 'claimed') return {kind:'lease-refused',failure:lease};
        const leaseRecord = lease.lease;
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
                return {kind:'attach-refused',category:'conflict',error: claim.error, existing: claim.existing};
            }
        }
        catch (error) {
            releaseLease();
            return {kind:'attach-refused',category:'state-write-failed',error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error)};
        }
        const heartbeat = ports.heartbeat(ownerId, parsed.backend, parsed.udid, parsed.deviceId, leaseRecord, leaseClaimNonce);
        return {kind:'attached',device, lease: leaseRecord, heartbeat, provider: "xcrun", inventory, command:inventory};
    }
    function trust(ownerId: string, params: unknown): TrustOutcome<Receipt> {
        const parsed = validateAppleTrustParams(params);
        if (!parsed.ok)
            return {kind:'trust-refused',category:'invalid',error:parsed.error,...(parsed.allowed ? {allowed:parsed.allowed} : {})};
        const inventory = ports.appleInventory();
        if (inventory.kind === 'failed') {
            return {kind:'trust-refused',category:'provider-failed',inventoryObservation:inventory,error: inventory.reason === "missing-executable" ? "ios-wireless-missing-xcrun" : "xctrace-inventory-failed",
                    diagnostic: {
                        ownerId,
                        ...appleTrustFacts(parsed.action, parsed.udid, null),
                    },};
        }
        const devices = inventory.devices;
        const selected = parsed.udid ? devices.find((device) => device.udid === parsed.udid) || null : null;
        const diagnostic = {
            ownerId,
            ...appleTrustFacts(parsed.action, parsed.udid, selected),
            inventory: {
                devices,
                count: devices.length,
            },
        };
        if (parsed.action === "status") {
            return {kind:'trust-observed',inventoryObservation:inventory,diagnostic};
        }
        if (selected?.connection === "wifi" && selected.availability !== "unavailable" && parsed.action === "connect") {
            return {kind:'trust-observed',inventoryObservation:inventory,diagnostic:{...diagnostic, alreadyNetworkVisible: true, manualRequired: false}};
        }
        return {kind:'trust-refused',category:'conflict',inventoryObservation:inventory,error: "ios-apple-pairing-manual-required",
                diagnostic,};
    }
    function attach(ownerId: string, params: unknown): AttachOutcome<Receipt> {
        const parsed = validateAttachParams(params, ports.deriveDeviceId);
        if (!parsed.ok)
            return {kind:'attach-refused',category:'invalid',error:parsed.error,...(parsed.allowed ? {allowed:parsed.allowed} : {})};
        return parsed.backend === 'android-device' ? brokerAttachAndroid(ownerId, parsed) : brokerAttachIos(ownerId, parsed);
    }
    function detach(ownerId: string, params: unknown): DetachOutcome<Receipt> {
        const parsed = validateAttachParams(params, ports.deriveDeviceId);
        if (!parsed.ok) return {kind:'detach-refused',category:'invalid',error:parsed.error,...(parsed.allowed ? {allowed:parsed.allowed} : {})};
        if (!cleanupRecord(params) || typeof params.deviceId !== 'string' || !params.deviceId.trim())
            return {kind:'detach-refused',category:'invalid',error:'invalid-device-id'};
        const device = ports.read(ownerId, parsed.stateKey).find((candidate):candidate is PhysicalRecord => cleanupRecord(candidate) && candidate.id === parsed.deviceId);
        if (!device) return {kind:'detach-refused',category:'missing',error:'owner-device-not-found',deviceId:parsed.deviceId};
        const request = {backend:parsed.backend,stateKey:parsed.stateKey,deviceId:parsed.deviceId,force:false,dryRun:false};
        return ports.withDetachLease<DetachOutcome<Receipt>>(ownerId, parsed, device, guard => {
            if (guard.admission.kind === 'refused') return {kind:'detach-refused',category:guard.admission.failure.kind === 'conflict' ? 'conflict' : 'provider-failed',
                error:'physical-lease-release-failed',ownerId,backend:parsed.backend,deviceId:parsed.deviceId,
                release:{kind:'refused',attempted:guard.attempted,ok:false,failure:guard.admission.failure}};
            const auxiliary = ports.auxiliary(ownerId, request, device);
            if (!auxiliary.result.ok) return {kind:'detach-refused',category:'provider-failed',error:'auxiliary-runtime-cleanup-failed',
                ownerId,backend:parsed.backend,deviceId:parsed.deviceId,device:auxiliary.device || device,auxiliaryCleanup:auxiliary.result,detached:false};
            const cleaned = auxiliary.device || device;
            const release:CleanupLeaseResult|null = guard.canRestore && guard.admission.kind === 'exact' ? ports.releaseLease(ownerId,guard)
                : guard.admission.kind === 'missing' ? {kind:'missing',attempted:true,ok:true,failure:guard.admission.failure} : null;
            try { ports.removeDevice(ownerId,parsed.stateKey,parsed.deviceId); }
            catch (error) {
                const rollback = guard.canRestore && release?.kind === 'released' ? ports.restoreLease(ownerId,guard)
                    : {kind:'not-needed' as const,attempted:false as const,ok:true as const};
                return {kind:'detach-refused',category:rollback.ok ? 'state-write-failed' : 'provider-failed',
                    error:rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed',ownerId,backend:parsed.backend,deviceId:parsed.deviceId,
                    detail:error instanceof Error ? error.message : String(error),device:cleaned,detached:false,release,leaseRollback:rollback,auxiliaryCleanup:auxiliary.result};
            }
            return {kind:'detached',deviceId:parsed.deviceId,device:cleaned,release,auxiliaryCleanup:auxiliary.result};
        });
    }
    function stop(ownerId:string, parsed:PhysicalStopRequest, selectedDevice:unknown, expected:unknown):PhysicalStopOutcome<Receipt> {
        if (parsed.dryRun) return {kind:'stop-preview'};
        if (!cleanupRecord(selectedDevice)) return {kind:'stop-refused',category:'missing',error:'owner-device-not-found',ownerId,backend:parsed.backend,deviceId:parsed.deviceId};
        return ports.withLeaseGuard(ownerId,parsed.stateKey,selectedDevice,guard => stopWithGuard(ownerId,parsed,selectedDevice,expected,guard));
    }
    function stopWithGuard(ownerId:string, parsed:PhysicalStopRequest, selectedDevice:PhysicalRecord, expected:unknown, guard:CleanupLeaseGuard<Handle>):PhysicalStopOutcome<Receipt> {
        if (guard.admission.kind === 'refused') {
            const lease = ports.releaseLease(ownerId,guard);
            return {kind:'stop-refused',category:lease.kind === 'refused' && lease.failure.kind === 'conflict' ? 'conflict' : 'provider-failed',
                error:'physical-lease-cleanup-failed',ownerId,backend:parsed.backend,deviceId:parsed.deviceId,physicalLeaseCleanup:lease,invoked:false,dryRun:false};
        }
        const auxiliary = ports.auxiliary(ownerId,parsed,expected);
        if (auxiliary.committed) expected = ports.clone(auxiliary.device);
        if (!auxiliary.result.ok) return {kind:'stop-refused',category:'provider-failed',error:'auxiliary-runtime-cleanup-failed',
            device:auxiliary.device,auxiliaryCleanup:auxiliary.result,invoked:false,dryRun:false,
            mutatesHost:auxiliary.result.changed || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true};
        const execution = ports.observePhysicalStop(parsed.backend);
        const success = execution.ok;
        const lease = success ? ports.releaseLease(ownerId,guard) : null;
        if (lease && !lease.ok) return {kind:'stop-refused',category:lease.failure.kind === 'conflict' ? 'conflict' : 'provider-failed',
            error:'physical-lease-cleanup-failed',ownerId,backend:parsed.backend,deviceId:parsed.deviceId,physicalLeaseCleanup:lease,
            execution,invoked:true,dryRun:false,mutatesHost:auxiliary.result.changed};
        let publication:CleanupPublication|null = null;
        let updatedDevice:unknown = selectedDevice;
        try {
            if (success) {
                publication = ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,physicalStopReplacement(cleanupRecord(expected) ? expected : {},ports.timestamp()));
                updatedDevice = publication.device;
            }
        } catch (error) {
            if (!guard.canRestore || lease?.kind !== 'released') throw error;
            const rollback = ports.restoreLease(ownerId,guard);
            return {kind:'stop-refused',category:rollback.ok ? 'state-write-failed' : 'provider-failed',
                error:rollback.ok ? 'owner-state-write-failed' : 'physical-lease-rollback-failed',ownerId,backend:parsed.backend,deviceId:parsed.deviceId,
                detail:'physical-device-state-transition-failed',device:auxiliary.device || selectedDevice,physicalLeaseCleanup:lease,leaseRollback:rollback,
                auxiliaryCleanup:auxiliary.result,execution,invoked:true,dryRun:false,mutatesHost:auxiliary.result.changed};
        }
        return {kind:'stop-observed',success,device:updatedDevice,auxiliaryCleanup:auxiliary.result,release:lease,execution,invoked:true,dryRun:false,
            mutatesHost:success,publicationMatched:!publication || publication.matched,...(publication ? {found:publication.found} : {})};
    }
    return {attach,detach,trust,stop};
}
