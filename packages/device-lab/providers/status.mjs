import { ownerId } from './context.mjs';
import { readPhysicalLeases } from './state/physical-lease-store.mjs';
import { normalizeDeviceTarget, presentDeviceTarget, presentDeviceTargets } from './application/device-observation.mjs';

const targetObservationPorts = {
    ownerId: () => ownerId(),
    now: () => Date.now(),
    readPhysicalLeases: backend => readPhysicalLeases(backend),
};

export function normalizeTargetStatus(target, options = {}) {
    return normalizeDeviceTarget(target, options, targetObservationPorts);
}

export function withTargetStatus(target, options = {}) {
    return presentDeviceTarget(target, options, targetObservationPorts);
}

// Display snapshots never become mutation-time lease authorization.
export function withTargetStatuses(targets, options = {}) {
    return presentDeviceTargets(targets, options, targetObservationPorts);
}
