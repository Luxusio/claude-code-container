import type {
    HyperVHostNetworkExecutionResult,
    HyperVHostNetworkReconciliationOutcome,
    HyperVHostNetworkObservation,
    HyperVHostNetworkCleanupObservation,
} from "@ccc/hyper-v/index.js";
export type HyperVNetworkAllocation = {
    ownerId: string;
    deviceId: string;
    incarnationId?: string;
    address: string;
    macAddress: string;
    allocatedAt: string;
};
type HyperVNetworkStateBase = {
    version: 1;
    switchName: string;
    switchId: string;
    marker: string;
    natName: string;
    prefix: string;
    gateway: string;
    outboundPolicy: "nat";
    managedSwitch: boolean;
    managedGateway: boolean;
    allocations: HyperVNetworkAllocation[];
};
export type HyperVNetworkState = HyperVNetworkStateBase & ({
    managedNat: true;
    natInstanceId: string;
} | {
    managedNat: false;
    natInstanceId?: string;
});
export type HyperVNetworkIntent = {
    version: 1;
    token: string;
    switchName: string;
    natName: string;
    marker: string;
    prefix: string;
    gateway: string;
    createdAt: string;
    ownershipOrigin?: "adopted";
    ownershipEvidence?: HyperVNetworkIntentOwnershipEvidence;
};
export type HyperVNetworkIntentOwnershipEvidence = {
    switch?: {
        switchName: string;
        switchId: string;
        marker: string;
    };
    gateway?: {
        switchName: string;
        switchId: string;
        marker: string;
        prefix: string;
        gateway: string;
    };
    nat?: {
        natName: string;
        natInstanceId: string;
        marker: string;
        prefix: string;
    };
};
export type HyperVNetworkRelease = {
    ok: boolean;
    released: boolean;
    statePresent: boolean;
    remaining: number;
    managedSwitch?: boolean;
    managedGateway?: boolean;
    managedNat?: boolean;
    switchName?: string;
    switchId?: string;
    natName?: string;
    marker?: string;
    natInstanceId?: string;
    stateRevision?: string;
    preservedManagedFabric?: boolean;
    error?: string;
};
export type HyperVNetworkReleaseOptions = {
    /**
     * Release the exact allocation but retain a verified CCC-managed switch,
     * gateway and NAT for a subsequent device. The default remains destructive
     * cleanup when the final allocation disappears.
     */
    readonly preserveManagedFabric?: boolean;
};
export type HyperVGuestTrustIdentity = {
    readonly encodedKey: string;
    readonly publicKey: string;
    readonly fingerprint: string;
};
export function parseKnownHostLine(text: string, address: string): string | null {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1)
        return null;
    const match = /^(\S+) ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,256})?$/.exec(lines[0]);
    return match && match[1] === address ? match[2] : null;
}
export type DeviceLabHyperVHostNetworkCompletedAction = Extract<HyperVHostNetworkExecutionResult, {
    readonly kind: "mutation-completed";
}>;
export type DeviceLabHyperVHostNetworkEnsureCompletedAction = Extract<DeviceLabHyperVHostNetworkCompletedAction, {
    readonly operation: "ensure";
}>;
export type DeviceLabHyperVHostNetworkCleanupCompletedAction = Extract<DeviceLabHyperVHostNetworkCompletedAction, {
    readonly operation: "cleanup";
}>;
export type DeviceLabHyperVHostNetworkEnsureOutcome = Exclude<HyperVHostNetworkReconciliationOutcome<"ensure">, {
    readonly kind: "execute";
}>;
export type DeviceLabHyperVHostNetworkCleanupOutcome = Exclude<HyperVHostNetworkReconciliationOutcome<"cleanup">, {
    readonly kind: "execute";
}>;
export type DeviceLabHyperVHostNetworkEnsureTransactionResult = {
    readonly outcome: DeviceLabHyperVHostNetworkEnsureOutcome;
    readonly completedActions: readonly DeviceLabHyperVHostNetworkEnsureCompletedAction[];
};
export type DeviceLabHyperVHostNetworkCleanupTransactionResult = {
    readonly outcome: DeviceLabHyperVHostNetworkCleanupOutcome;
    readonly completedActions: readonly DeviceLabHyperVHostNetworkCleanupCompletedAction[];
};
export type DeviceLabHyperVHostNetworkTransactionResult = DeviceLabHyperVHostNetworkEnsureTransactionResult | DeviceLabHyperVHostNetworkCleanupTransactionResult;
export class DeviceLabHyperVNetworkAdapterError extends Error {
    readonly code: "hyper-v-network-adapter-standard-plan-executable" | "hyper-v-network-adapter-administrator-plan-needs-administrator" | "hyper-v-network-adapter-action-operation-mismatch" | "hyper-v-network-adapter-mutation-bound-exceeded";
    constructor(code: DeviceLabHyperVNetworkAdapterError["code"]) {
        super(code);
        this.name = "DeviceLabHyperVNetworkAdapterError";
        this.code = code;
    }
}
export function confirmedEnsureOutcome(outcome: DeviceLabHyperVHostNetworkEnsureOutcome, completedActions: readonly DeviceLabHyperVHostNetworkEnsureCompletedAction[]): DeviceLabHyperVHostNetworkEnsureOutcome {
    if (outcome.kind !== "settled")
        return outcome;
    for (const completed of completedActions) {
        switch (completed.actionKind) {
            case "create-switch":
            case "repair-switch-notes":
                if (completed.switchIdentity.id !== outcome.identity.switchIdentity.id
                    || completed.switchIdentity.name !== outcome.identity.switchIdentity.name) {
                    return { kind: "conflict", operation: "ensure", reason: "switch-successor-conflict" };
                }
                break;
            case "create-gateway":
                if (completed.gatewayIdentity.interfaceIndex !== outcome.identity.interfaceIndex) {
                    return { kind: "conflict", operation: "ensure", reason: "gateway-conflict" };
                }
                break;
            case "create-nat":
                if (completed.natIdentity.instanceId !== outcome.identity.natIdentity.instanceId
                    || completed.natIdentity.name !== outcome.identity.natIdentity.name) {
                    return { kind: "conflict", operation: "ensure", reason: "nat-successor-conflict" };
                }
                break;
        }
    }
    return outcome;
}
export function ensureReceiptConflict(observation: HyperVHostNetworkObservation, completedActions: readonly DeviceLabHyperVHostNetworkEnsureCompletedAction[]): DeviceLabHyperVHostNetworkEnsureOutcome | null {
    for (const completed of completedActions) {
        switch (completed.actionKind) {
            case "create-switch":
            case "repair-switch-notes": {
                const exact = observation.virtualSwitches.filter((candidate) => candidate.id === completed.switchIdentity.id
                    && candidate.name === completed.switchIdentity.name);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "switch-successor-conflict" };
                }
                break;
            }
            case "create-gateway": {
                const exact = observation.ipv4Addresses.filter((candidate) => candidate.interfaceIndex === completed.gatewayIdentity.interfaceIndex
                    && candidate.address === completed.gatewayIdentity.address
                    && candidate.prefixLength === completed.gatewayIdentity.prefixLength);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "gateway-conflict" };
                }
                break;
            }
            case "create-nat": {
                const exact = observation.nats.filter((candidate) => candidate.instanceId === completed.natIdentity.instanceId
                    && candidate.name === completed.natIdentity.name);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "nat-successor-conflict" };
                }
                break;
            }
        }
    }
    return null;
}
export function observationWithConfirmedEnsureReceipts(observation: HyperVHostNetworkObservation, completedActions: readonly DeviceLabHyperVHostNetworkEnsureCompletedAction[]): HyperVHostNetworkObservation {
    let confirmedSwitch: Extract<DeviceLabHyperVHostNetworkEnsureCompletedAction, {
        readonly actionKind: "create-switch" | "repair-switch-notes";
    }> | undefined;
    let createdNat: Extract<DeviceLabHyperVHostNetworkEnsureCompletedAction, {
        readonly actionKind: "create-nat";
    }> | undefined;
    for (const action of completedActions) {
        if (action.actionKind === "create-switch" || action.actionKind === "repair-switch-notes") {
            confirmedSwitch = action;
        }
        if (action.actionKind === "create-nat")
            createdNat = action;
    }
    if ((!confirmedSwitch && !createdNat) || observation.provenance.kind === "fresh")
        return observation;
    return {
        ...observation,
        provenance: {
            ...observation.provenance,
            ...(confirmedSwitch ? { switchIdentity: confirmedSwitch.switchIdentity } : {}),
            ...(createdNat
                ? { nat: { kind: "exact" as const, identity: createdNat.natIdentity } }
                : {}),
        },
    };
}
export function cleanupReceiptConflict(observation: HyperVHostNetworkCleanupObservation, completedActions: readonly DeviceLabHyperVHostNetworkCleanupCompletedAction[]): DeviceLabHyperVHostNetworkCleanupOutcome | null {
    for (const completed of completedActions) {
        switch (completed.actionKind) {
            case "remove-switch": {
                const removedSwitchReappeared = observation.virtualSwitches.some((candidate) => candidate.id === completed.switchIdentity.id
                    && candidate.name === completed.switchIdentity.name);
                if (removedSwitchReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "switch-successor-conflict" };
                }
                break;
            }
            case "remove-gateway": {
                const removedGatewayReappeared = observation.ipv4Addresses.some((candidate) => candidate.interfaceIndex === completed.gatewayIdentity.interfaceIndex
                    && candidate.address === completed.gatewayIdentity.address
                    && candidate.prefixLength === completed.gatewayIdentity.prefixLength);
                if (removedGatewayReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "gateway-conflict" };
                }
                break;
            }
            case "remove-nat": {
                const removedNatReappeared = observation.nats.some((candidate) => candidate.instanceId === completed.natIdentity.instanceId
                    && candidate.name === completed.natIdentity.name);
                if (removedNatReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "nat-successor-conflict" };
                }
                break;
            }
        }
    }
    return null;
}
export function isRetryableEnsureObservation(outcome: HyperVHostNetworkReconciliationOutcome): boolean {
    return outcome.kind === "indeterminate"
        && (outcome.reason === "host-adapter-missing" || outcome.reason === "gateway-transitioning");
}
export type HyperVNetworkObservation = {
    ok: boolean;
    switchName: string;
    switchId: string;
    marker?: string;
    natName: string;
    natInstanceId: string;
    prefix: string;
    gateway: string;
    interfaceIndex: number;
    createdSwitch: boolean;
    createdGateway?: boolean;
    createdNat: boolean;
};
export type HyperVNetworkCleanupObservation = {
    ok: boolean;
    removedSwitch: boolean;
    removedNat: boolean;
    removedGateway: boolean;
    alreadyMissing: boolean;
    deferred?: boolean;
    reason?: "hyper-v-network-switch-in-use";
};
export type HyperVNetworkAllocationIdentity = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
};
export type HyperVNetworkAllocationObservation = HyperVNetworkAllocationIdentity & {
    vmName: string;
    present: boolean;
    vmId?: string;
};
export type HyperVNetworkAllocationsObservation = {
    ok: true;
    allocations: HyperVNetworkAllocationObservation[];
};
/** Semantic native network requests; process preparation stays in the adapter. */
export type HyperVNetworkEnsureRequest = {
    switchName: string; natName: string; prefix: string; gateway: string; prefixLength: number; marker: string;
    allowExistingNat?: boolean; allowCccOwnedNetworkAdoption?: boolean; allowPersistedCccIdentityRepair?: boolean;
    expectedSwitchId?: string; expectedNatInstanceId?: string;
};
export type HyperVNetworkCleanupRequest = HyperVNetworkEnsureRequest & {removeNat?: boolean; removeSwitch?: boolean; removeGateway?: boolean};
export type HyperVNetworkNativeAttempt = {privilege: "standard" | "administrator"; timeoutMs: number; deadlineUnixMs?: number};
export type HyperVNetworkNativeObservation<T> =
    | {kind: "completed"; observation: T | null; receipt: unknown}
    | {kind: "failed"; diagnostic: string | undefined; access: "administrator-required" | "unspecified"; receipt: unknown}
    | {kind: "preparation-failed"; cause: unknown};
export type HyperVNetworkAllocationRequest = {
    readonly ownerId: string;
    readonly deviceId: string;
    readonly incarnationId: string;
};
export type HyperVNetworkEnsureFailure = {
    kind: "refused";
    reason: "missing-provider" | "invalid-incarnation" | "state-conflict" | "reconciliation-failed" | "provider-failed" | "invalid-observation" | "allocation-missing" | "cleanup-failed";
    error: string; detail?: string; receipt?: unknown; preserveEvidence?: boolean;
};
export type HyperVNetworkFabricResult = {
    kind: "fabric-ready"; switchName: string; gateway: string; prefix: string; outboundPolicy: "nat";
} | HyperVNetworkEnsureFailure;
export type HyperVNetworkAllocationResult = {
    kind: "allocated"; switchName: string; address: string; macAddress: string; gateway: string; prefix: string; outboundPolicy: "nat";
} | HyperVNetworkEnsureFailure;
export function validHyperVIncarnationId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
export function isHyperVCccNetworkIdentity(marker: unknown, natName: unknown): marker is string {
    if (marker === "ccc-device-lab:hyper-v-network:v1")
        return natName === "CCCDeviceLab";
    if (typeof marker !== "string" || typeof natName !== "string")
        return false;
    const token = /^ccc-device-lab:hyper-v-network:([a-f0-9]{24})$/.exec(marker)?.[1];
    return Boolean(token) && natName === `CCCDeviceLab-${token}`;
}
export type HyperVOwnerDevicesReader = (ownerId: string, backend: "windows-vm" | "linux-vm") => unknown[];
export function hyperVNetworkAllocationReferenced(allocation: HyperVNetworkAllocation, readDevices: HyperVOwnerDevicesReader): boolean {
    const backends: readonly ("windows-vm" | "linux-vm")[] = ["windows-vm", "linux-vm"];
    const matchingDevices = backends.flatMap(backend => readDevices(allocation.ownerId, backend).filter((candidate): candidate is {
        id: unknown;
        incarnationId?: unknown;
    } => candidate !== null
        && typeof candidate === "object" && !Array.isArray(candidate)
        && "id" in candidate && candidate.id === allocation.deviceId));
    const incarnations = matchingDevices.map(device => {
        if (!validHyperVIncarnationId(device.incarnationId))
            throw new Error("hyper-v-network-owner-state-incarnation-unverifiable");
        return device.incarnationId;
    });
    if (new Set(incarnations).size > 1)
        throw new Error("hyper-v-network-owner-state-incarnation-conflict");
    return incarnations[0] === allocation.incarnationId;
}
export function networkAddressCandidates(gateway: string, digest: {
    first: number;
    second: number;
}): string[] {
    const start = digest.first % 241;
    let step = (digest.second % 240) + 1;
    while (step % 241 === 0)
        step += 1;
    const subnet = gateway.slice(0, gateway.lastIndexOf(".") + 1);
    return Array.from({ length: 241 }, (_, index) => `${subnet}${10 + ((start + index * step) % 241)}`);
}
