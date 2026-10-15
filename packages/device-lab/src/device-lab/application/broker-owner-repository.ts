import type { BrokerOwnerRepositoryPorts } from '../ports/broker-owner-repository.js';
import { assertUniqueOwnerDeviceIds, ownerIdentityConflict, ownerObject, ownerRecord } from '../domain/broker-owner-repository.js';
import { physicalOwnerConflict } from '../domain/broker-physical-devices.js';
import { recordingRuntimeMatches, recordingTargetMatches, recordingPublication, type BrokerRecordingTarget } from '../domain/broker-recording.js';
import { appiumRuntimeMatches, appiumRecordReplacement } from '../domain/broker-appium.js';
import { cleanupRecord } from '../domain/broker-owner-cleanup.js';
import { retainAfterWindowsConfigFailure } from '../domain/lifecycle/windows-sandbox-create.js';

export function createBrokerOwnerRepository(ports: BrokerOwnerRepositoryPorts) {
    function publish(owner: string, key: string, devices: unknown[]) {
        ports.validate(devices);
        ports.publish(owner, key, devices);
    }
    function mutate(owner: string, key: string, updater: (devices: unknown[]) => unknown[]) {
        return ports.withLock(owner, key, () => {
            const devices = updater(ports.read(owner, key));
            assertUniqueOwnerDeviceIds(devices);
            publish(owner, key, devices);
            return devices;
        });
    }
    function transitionLifecycle(owner: string, key: string, id: string, expected: unknown, replace: (current: Record<string, unknown>) => unknown) {
        return ports.withLock(owner, key, () => {
            const devices = ports.read(owner, key);
            const index = devices.findIndex(candidate => ownerRecord(candidate) && candidate.id === id);
            const selected = index < 0 ? null : devices[index];
            const current = ownerRecord(selected) ? selected : null;
            if (!current || !ports.equal(current, expected)) return { found: index >= 0, matched: false, device: current };
            const replacement = replace(current);
            const next = replacement === null ? devices.filter((_, candidateIndex) => candidateIndex !== index) : devices.map((candidate, candidateIndex) => candidateIndex === index ? replacement : candidate);
            assertUniqueOwnerDeviceIds(next);
            publish(owner, key, next);
            return { found: true, matched: true, device: replacement };
        });
    }
    function claim(owner: string, key: string, device: Record<string, unknown>, fields: Array<string | string[]>, beforePublish?: () => undefined) {
        return ports.withLock(owner, key, () => {
            const devices = ports.read(owner, key);
            const conflict = ownerIdentityConflict(devices, device, fields);
            if (conflict) return conflict;
            beforePublish?.();
            publish(owner, key, [...devices, device]);
            return { ok: true as const, device };
        });
    }
    function transitionSnapshot(owner: string, key: string, id: string, expected: Record<string, unknown>, replacement: Record<string, unknown>): {found:boolean;matched:boolean;device:Record<string,unknown>|null} {
        let found = false, matched = false;
        let current: Record<string, unknown> | null = null;
        mutate(owner, key, devices => devices.map(candidate => {
            if (!ownerRecord(candidate) || candidate.id !== id) return candidate;
            found = true;
            current = candidate;
            if (!ports.equal(candidate, expected)) return candidate;
            matched = true;
            current = replacement;
            return replacement;
        }));
        return { found, matched, device: current };
    }
    function claimOrReattachPhysical(owner: string, key: string, device: Record<string, unknown>, hardwareField: 'serial' | 'udid') {
        return ports.withLock(owner, key, () => {
            const devices = ports.read(owner, key);
            const { conflicts, allowed } = physicalOwnerConflict(devices, device, hardwareField);
            if (conflicts.length === 0) {
                publish(owner, key, [...devices, device]);
                return { ok: true as const, device, reattached: false };
            }
            if (!allowed) return { ok: false as const, error: 'owner-device-already-attached', existing: conflicts[0] || null };
            publish(owner, key, devices.map(candidate => candidate === conflicts[0] ? device : candidate));
            return { ok: true as const, device, reattached: true };
        });
    }
    function transitionRecording(owner: string, key: string, id: string, expected: unknown, replacement: Record<string, unknown> | null, target: BrokerRecordingTarget): {found:boolean;matched:boolean;currentRecording:unknown;device:Record<string,unknown>|null} {
        let found = false, matched = false;
        let currentRecording: unknown = null;
        let device: Record<string, unknown> | null = null;
        mutate(owner, key, devices => devices.map(candidate => {
            if (!ownerRecord(candidate) || candidate.id !== id) return candidate;
            found = true;
            currentRecording = candidate.recording ?? null;
            if (target.stateKey !== key || !recordingTargetMatches(target, candidate) || !recordingRuntimeMatches(expected, currentRecording)) return candidate;
            matched = true;
            device = recordingPublication(candidate, replacement, ports.timestamp());
            return device;
        }));
        return { found, matched, currentRecording, device };
    }
    function transitionAppium(owner: string, key: string, id: string, expected: unknown, replacement: Record<string, unknown> | null): {found:boolean;matched:boolean;currentAppium:unknown;device:Record<string,unknown>|null} {
        let found = false, matched = false;
        let currentAppium: unknown = null;
        let device: Record<string, unknown> | null = null;
        mutate(owner, key, devices => devices.map(candidate => {
            if (!ownerRecord(candidate) || candidate.id !== id) return candidate;
            found = true;
            currentAppium = candidate.appium ?? null;
            if (!appiumRuntimeMatches(expected, currentAppium)) return candidate;
            matched = true;
            const updatedAt = typeof replacement?.updatedAt === 'string' ? replacement.updatedAt : ports.timestamp();
            device = appiumRecordReplacement(candidate, replacement, updatedAt);
            return device;
        }));
        return { found, matched, currentAppium, device };
    }
    function mergeSnapshotRepair(owner: string, key: string, id: string, original: Record<string, unknown>, patch: Record<string, unknown>) {
        let updated = original;
        mutate(owner, key, devices => devices.map(candidate => {
            if (!ownerObject(candidate) || !('id' in candidate) || candidate.id !== id) return candidate;
            updated = { ...candidate, ...patch, updatedAt: ports.timestamp() };
            return updated;
        }));
        return updated;
    }
    function removeDevice(owner: string, key: string, id: string): undefined {
        mutate(owner, key, devices => devices.filter(candidate => !(ownerObject(candidate) && 'id' in candidate && candidate.id === id)));
        return undefined;
    }
    function updateDevice(owner: string, key: string, id: string, replace: (current: Record<string, unknown>) => unknown) {
        return mutate(owner, key, devices => devices.map(candidate => ownerObject(candidate) && candidate.id === id ? replace(candidate) : candidate));
    }
    function replayPublish(owner: string, key: string, id: string, replacement: Record<string, unknown> | null): undefined {
        mutate(owner, key, devices => replacement === null
            ? devices.filter(candidate => !cleanupRecord(candidate) || candidate.id !== id)
            : devices.map(candidate => !cleanupRecord(candidate) || candidate.id !== id ? candidate : { ...candidate, ...replacement }));
        return undefined;
    }
    function removeMatchingClaim(owner: string, key: string, id: unknown, createdAt: unknown) {
        return mutate(owner, key, devices => devices.filter(candidate => retainAfterWindowsConfigFailure(candidate, id, createdAt)));
    }
    return { mutate, transitionLifecycle, claim, transitionSnapshot, claimOrReattachPhysical, transitionRecording, transitionAppium, mergeSnapshotRepair, removeDevice, updateDevice, replayPublish, removeMatchingClaim };
}
