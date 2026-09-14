import type {
    HyperVCreateNetIPAddressRequest,
    HyperVCreateNetNatRequest,
    HyperVCreateVMSwitchRequest,
    HyperVHostNetworkAdapter,
    HyperVHostNetworkSpec,
    HyperVNatIdentity,
    HyperVNetNat,
    HyperVRemoveNetIPAddressRequest,
    HyperVRemoveNetNatRequest,
    HyperVRemoveVMSwitchRequest,
    HyperVSetVMSwitchNotesRequest,
    HyperVVirtualSwitch,
    HyperVVirtualSwitchIdentity,
    HyperVWindowsCallOptions,
    HyperVWindowsNetworkClient,
} from "../low-level/index.js";
import { parseHyperVNetworkAdapterName } from "../low-level/index.js";
import type {
    HyperVHostNetworkCleanupObservation,
    HyperVHostNetworkCleanupProvenance,
    HyperVHostNetworkConflictOutcome,
    HyperVHostNetworkEnsureProvenance,
    HyperVHostNetworkIndeterminateOutcome,
    HyperVHostNetworkNeedsAdministratorOutcome,
    HyperVHostNetworkObservation,
    HyperVHostNetworkSettledOutcome,
} from "./network-contracts.js";

const preparedActionBrand: unique symbol = Symbol("HyperVPreparedHostNetworkAction");

type HyperVUnpreparedHostNetworkAction =
    | { readonly kind: "create-switch"; readonly request: HyperVCreateVMSwitchRequest }
    | { readonly kind: "repair-switch-notes"; readonly request: HyperVSetVMSwitchNotesRequest }
    | { readonly kind: "create-gateway"; readonly request: HyperVCreateNetIPAddressRequest }
    | { readonly kind: "create-nat"; readonly request: HyperVCreateNetNatRequest }
    | { readonly kind: "remove-nat"; readonly request: HyperVRemoveNetNatRequest }
    | { readonly kind: "remove-gateway"; readonly request: HyperVRemoveNetIPAddressRequest }
    | { readonly kind: "remove-switch"; readonly request: HyperVRemoveVMSwitchRequest };

type HyperVPreparedHostNetworkAction = HyperVUnpreparedHostNetworkAction
    & { readonly [preparedActionBrand]: true };

export type HyperVHostNetworkExecuteOutcome = {
    readonly kind: "execute";
    readonly operation: "ensure" | "cleanup";
    readonly action: HyperVPreparedHostNetworkAction;
};

export type HyperVHostNetworkReconciliationOutcome =
    | HyperVHostNetworkSettledOutcome
    | HyperVHostNetworkConflictOutcome
    | HyperVHostNetworkNeedsAdministratorOutcome
    | HyperVHostNetworkExecuteOutcome
    | HyperVHostNetworkIndeterminateOutcome;

export type HyperVHostNetworkExecutionResult =
    | {
        readonly kind: "mutation-completed";
        readonly operation: "ensure";
        readonly actionKind: "create-switch" | "repair-switch-notes";
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
    }
    | {
        readonly kind: "mutation-completed";
        readonly operation: "ensure";
        readonly actionKind: "create-gateway";
        readonly gatewayIdentity: HyperVCreateNetIPAddressRequest;
    }
    | {
        readonly kind: "mutation-completed";
        readonly operation: "ensure";
        readonly actionKind: "create-nat";
        readonly natIdentity: HyperVNatIdentity;
    }
    | {
        readonly kind: "mutation-completed";
        readonly operation: "cleanup";
        readonly actionKind: "remove-switch";
        readonly switchIdentity: HyperVVirtualSwitchIdentity;
    }
    | {
        readonly kind: "mutation-completed";
        readonly operation: "cleanup";
        readonly actionKind: "remove-gateway";
        readonly gatewayIdentity: HyperVRemoveNetIPAddressRequest;
    }
    | {
        readonly kind: "mutation-completed";
        readonly operation: "cleanup";
        readonly actionKind: "remove-nat";
        readonly natIdentity: HyperVNatIdentity;
    }
    | HyperVHostNetworkIndeterminateOutcome;

function assertNever(value: never): never {
    throw new Error(`hyper-v-host-network-unhandled:${String(value)}`);
}

function conflict(
    operation: "ensure" | "cleanup",
    reason: HyperVHostNetworkConflictOutcome["reason"],
): HyperVHostNetworkConflictOutcome {
    return { kind: "conflict", operation, reason };
}

function prepared(action: HyperVUnpreparedHostNetworkAction): HyperVPreparedHostNetworkAction {
    return { ...action, [preparedActionBrand]: true };
}

function actionOutcome(
    privilege: "standard" | "administrator",
    operation: "ensure" | "cleanup",
    action: HyperVUnpreparedHostNetworkAction,
): HyperVHostNetworkNeedsAdministratorOutcome | HyperVHostNetworkExecuteOutcome {
    if (privilege === "standard") {
        return { kind: "needs-administrator", operation, requiredAction: action.kind };
    }
    return { kind: "execute", operation, action: prepared(action) };
}

function expectedSwitchIdentity(
    provenance: HyperVHostNetworkEnsureProvenance,
): HyperVVirtualSwitchIdentity | null {
    switch (provenance.kind) {
        case "fresh": return null;
        case "recognized-adoption": return provenance.switchIdentity;
        case "persisted": return provenance.switchIdentity;
        default: return assertNever(provenance);
    }
}

function expectedNatIdentity(provenance: HyperVHostNetworkEnsureProvenance): HyperVNatIdentity | null {
    switch (provenance.kind) {
        case "fresh": return null;
        case "recognized-adoption":
        case "persisted":
            switch (provenance.nat.kind) {
                case "exact": return provenance.nat.identity;
                case "absent":
                case "unrecorded": return null;
                default: return assertNever(provenance.nat);
            }
        default: return assertNever(provenance);
    }
}

function natEvidenceKind(
    provenance: HyperVHostNetworkEnsureProvenance,
): "fresh" | "absent" | "unrecorded" | "exact" {
    switch (provenance.kind) {
        case "fresh": return "fresh";
        case "recognized-adoption": return provenance.nat.kind;
        case "persisted": return provenance.nat.kind;
        default: return assertNever(provenance);
    }
}

function notesRepairIsProven(provenance: HyperVHostNetworkEnsureProvenance): boolean {
    return provenance.kind === "persisted" && provenance.nat.kind === "exact";
}

function singleNamedSwitch(
    switches: readonly HyperVVirtualSwitch[],
    network: HyperVHostNetworkSpec,
): { readonly kind: "found"; readonly value: HyperVVirtualSwitch }
    | { readonly kind: "absent" }
    | HyperVHostNetworkConflictOutcome {
    const named = switches.filter((candidate) => candidate.name === network.switchName);
    if (named.length > 1) return conflict("ensure", "switch-ambiguous");
    const value = named[0];
    return value ? { kind: "found", value } : { kind: "absent" };
}

function singleNamedNat(
    nats: readonly HyperVNetNat[],
    network: HyperVHostNetworkSpec,
    operation: "ensure" | "cleanup",
): { readonly kind: "found"; readonly value: HyperVNetNat }
    | { readonly kind: "absent" }
    | HyperVHostNetworkConflictOutcome {
    const named = nats.filter((candidate) => candidate.name === network.natName);
    if (named.length > 1) return conflict(operation, "nat-ambiguous");
    const value = named[0];
    return value ? { kind: "found", value } : { kind: "absent" };
}

function ipv4Number(address: string): number | null {
    const parts = address.split(".").map(Number);
    const first = parts[0];
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    if (parts.length !== 4
        || first === undefined || second === undefined || third === undefined || fourth === undefined
        || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((first * 256) + second) * 256 + third) * 256 + fourth;
}

function cidrParts(cidr: string): { readonly address: number; readonly prefixLength: number } | null {
    const separator = cidr.indexOf("/");
    if (separator < 1 || separator !== cidr.lastIndexOf("/")) return null;
    const address = ipv4Number(cidr.slice(0, separator));
    const prefixLength = Number(cidr.slice(separator + 1));
    if (address === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return null;
    return { address, prefixLength };
}

function prefixesOverlap(
    leftCidr: string,
    rightAddress: string,
    rightPrefixLength: number,
): boolean {
    const left = cidrParts(leftCidr);
    const right = ipv4Number(rightAddress);
    if (!left || right === null || rightPrefixLength < 0 || rightPrefixLength > 32) return true;
    const comparedPrefixLength = Math.min(left.prefixLength, rightPrefixLength);
    const blockSize = 2 ** (32 - comparedPrefixLength);
    return Math.floor(left.address / blockSize) === Math.floor(right / blockSize);
}

function cidrsOverlap(leftCidr: string, rightCidr: string): boolean {
    const right = cidrParts(rightCidr);
    if (!right) return true;
    const separator = rightCidr.indexOf("/");
    return prefixesOverlap(leftCidr, rightCidr.slice(0, separator), right.prefixLength);
}

function foreignSubnetConflict(
    observation: Pick<HyperVHostNetworkObservation, "nats" | "ipv4Addresses">,
    network: HyperVHostNetworkSpec,
    expectedInterface: HyperVHostNetworkAdapter | null,
): HyperVHostNetworkConflictOutcome | null {
    const natOverlap = observation.nats.some((nat) => nat.name !== network.natName
        && cidrsOverlap(network.cidr, nat.internalAddressPrefix));
    if (natOverlap) return conflict("ensure", "foreign-nat-subnet-overlap");

    const interfaceOverlap = observation.ipv4Addresses.some((address) => {
        if (expectedInterface && address.interfaceIndex === expectedInterface.interfaceIndex) return false;
        if (address.address === "127.0.0.1" || String(address.address).startsWith("169.254.")) return false;
        return prefixesOverlap(network.cidr, address.address, address.prefixLength);
    });
    return interfaceOverlap ? conflict("ensure", "foreign-interface-subnet-overlap") : null;
}

function hostAdapter(
    observation: Pick<HyperVHostNetworkObservation, "hostAdapters">,
    network: HyperVHostNetworkSpec,
): { readonly kind: "found"; readonly value: HyperVHostNetworkAdapter }
    | { readonly kind: "absent" }
    | HyperVHostNetworkConflictOutcome {
    const expectedName = parseHyperVNetworkAdapterName(`vEthernet (${network.switchName})`);
    const adapters = observation.hostAdapters.filter((candidate) => candidate.name === expectedName);
    if (adapters.length > 1) return conflict("ensure", "host-adapter-ambiguous");
    const adapter = adapters[0];
    if (!adapter) return { kind: "absent" };
    if (adapter.status !== "Up") return conflict("ensure", "host-adapter-status-unsupported");
    return { kind: "found", value: adapter };
}

export function reconcileHyperVHostNetwork(
    observation: HyperVHostNetworkObservation,
    network: HyperVHostNetworkSpec,
): HyperVHostNetworkReconciliationOutcome {
    const namedSwitchResult = singleNamedSwitch(observation.virtualSwitches, network);
    if (namedSwitchResult.kind === "conflict") return namedSwitchResult;
    const namedSwitch = namedSwitchResult.kind === "found" ? namedSwitchResult.value : null;
    const expectedSwitch = expectedSwitchIdentity(observation.provenance);
    if (expectedSwitch && expectedSwitch.name !== network.switchName) {
        return conflict("ensure", "switch-identity-conflict");
    }
    const switchByExpectedId = expectedSwitch
        ? observation.virtualSwitches.filter((candidate) => candidate.id === expectedSwitch.id)
        : [];
    if (switchByExpectedId.length > 1
        || (switchByExpectedId.length === 1 && switchByExpectedId[0]?.name !== network.switchName)) {
        return conflict("ensure", "switch-identity-conflict");
    }
    if (namedSwitch && expectedSwitch && namedSwitch.id !== expectedSwitch.id) {
        return conflict("ensure", "switch-successor-conflict");
    }
    if (namedSwitch && namedSwitch.switchType !== "Internal") {
        return conflict("ensure", "switch-type-unsupported");
    }

    const absentAdapter: { readonly kind: "absent" } = { kind: "absent" };
    const adapterResult = namedSwitch ? hostAdapter(observation, network) : absentAdapter;
    if (adapterResult.kind === "conflict") return adapterResult;
    const adapter = adapterResult.kind === "found" ? adapterResult.value : null;
    const namedNatResult = singleNamedNat(observation.nats, network, "ensure");
    if (namedNatResult.kind === "conflict") return namedNatResult;
    const namedNat = namedNatResult.kind === "found" ? namedNatResult.value : null;
    const expectedNat = expectedNatIdentity(observation.provenance);
    if (expectedNat && expectedNat.name !== network.natName) {
        return conflict("ensure", "nat-identity-conflict");
    }
    const natByExpectedId = expectedNat
        ? observation.nats.filter((candidate) => candidate.instanceId === expectedNat.instanceId)
        : [];
    if (natByExpectedId.length > 1
        || (natByExpectedId.length === 1 && natByExpectedId[0]?.name !== network.natName)) {
        return conflict("ensure", "nat-identity-conflict");
    }
    if (namedNat && expectedNat && namedNat.instanceId !== expectedNat.instanceId) {
        return conflict("ensure", "nat-successor-conflict");
    }
    if (namedNat && natEvidenceKind(observation.provenance) === "absent") {
        return conflict("ensure", "nat-identity-conflict");
    }
    if (namedNat && namedNat.internalAddressPrefix !== network.cidr) {
        return conflict("ensure", "nat-prefix-conflict");
    }
    if (namedNat && observation.provenance.kind === "fresh" && !namedSwitch) {
        return conflict("ensure", "nat-identity-conflict");
    }

    const subnetConflict = foreignSubnetConflict(observation, network, adapter);
    if (subnetConflict) return subnetConflict;

    const notesMismatch = namedSwitch !== null
        && namedSwitch.notes !== observation.provenance.expectedSwitchNotes;
    if (notesMismatch && !notesRepairIsProven(observation.provenance)) {
        return conflict("ensure", observation.provenance.kind === "persisted"
            ? "switch-notes-repair-unproven"
            : "switch-notes-conflict");
    }
    if (notesMismatch) {
        if (!namedSwitch || !namedNat || !expectedNat || namedNat.instanceId !== expectedNat.instanceId) {
            return conflict("ensure", "switch-notes-repair-unproven");
        }
        return actionOutcome(observation.privilege, "ensure", {
            kind: "repair-switch-notes",
            request: {
                identity: { id: namedSwitch.id, name: namedSwitch.name },
                notes: observation.provenance.expectedSwitchNotes,
            },
        });
    }

    if (!namedSwitch) {
        return actionOutcome(observation.privilege, "ensure", {
            kind: "create-switch",
            request: { name: network.switchName, notes: observation.provenance.expectedSwitchNotes },
        });
    }
    if (!adapter) {
        return { kind: "indeterminate", operation: "ensure", reason: "host-adapter-missing" };
    }

    const gatewayMatches = observation.ipv4Addresses.filter((address) =>
        address.interfaceIndex === adapter.interfaceIndex
        && address.address === network.gateway
        && address.prefixLength === network.prefixLength);
    if (gatewayMatches.length > 1) return conflict("ensure", "gateway-conflict");
    const gateway = gatewayMatches[0];
    if (gateway) {
        if (gateway.addressState === "Tentative") {
            return { kind: "indeterminate", operation: "ensure", reason: "gateway-transitioning" };
        }
        if (gateway.addressState !== "Preferred") {
            return conflict("ensure", "gateway-address-state-unsupported");
        }
    } else {
        const conflictingAddress = observation.ipv4Addresses.some((address) =>
            address.interfaceIndex === adapter.interfaceIndex
            && address.prefixOrigin !== "WellKnown"
            && address.address !== "169.254.0.0");
        if (conflictingAddress) return conflict("ensure", "gateway-conflict");
        return actionOutcome(observation.privilege, "ensure", {
            kind: "create-gateway",
            request: {
                interfaceIndex: adapter.interfaceIndex,
                address: network.gateway,
                prefixLength: network.prefixLength,
            },
        });
    }

    if (!namedNat) {
        return actionOutcome(observation.privilege, "ensure", {
            kind: "create-nat",
            request: { name: network.natName, internalAddressPrefix: network.cidr },
        });
    }
    return {
        kind: "settled",
        operation: "ensure",
        identity: {
            switchIdentity: { id: namedSwitch.id, name: namedSwitch.name },
            interfaceIndex: adapter.interfaceIndex,
            natIdentity: { instanceId: namedNat.instanceId, name: namedNat.name },
        },
    };
}

function cleanupExpectedSwitch(
    provenance: HyperVHostNetworkCleanupProvenance,
): HyperVVirtualSwitchIdentity | null | "conflict" {
    const switchIdentity = provenance.switch.kind === "managed" ? provenance.switch.identity : null;
    const gatewaySwitchIdentity = provenance.gateway.kind === "managed"
        ? provenance.gateway.identity.switchIdentity
        : null;
    if (switchIdentity && gatewaySwitchIdentity
        && (switchIdentity.id !== gatewaySwitchIdentity.id || switchIdentity.name !== gatewaySwitchIdentity.name)) {
        return "conflict";
    }
    return switchIdentity ?? gatewaySwitchIdentity;
}

export function planHyperVHostNetworkCleanup(
    observation: HyperVHostNetworkCleanupObservation,
    network: HyperVHostNetworkSpec,
    provenance: HyperVHostNetworkCleanupProvenance,
): HyperVHostNetworkReconciliationOutcome {
    const expectedSwitch = cleanupExpectedSwitch(provenance);
    if (expectedSwitch === "conflict" || (expectedSwitch && expectedSwitch.name !== network.switchName)) {
        return conflict("cleanup", "switch-identity-conflict");
    }
    const namedSwitchResult = singleNamedSwitch(observation.virtualSwitches, network);
    if (namedSwitchResult.kind === "conflict") return { ...namedSwitchResult, operation: "cleanup" };
    const namedSwitch = namedSwitchResult.kind === "found" ? namedSwitchResult.value : null;
    const byId = expectedSwitch
        ? observation.virtualSwitches.filter((candidate) => candidate.id === expectedSwitch.id)
        : [];
    if (byId.length > 1 || (byId.length === 1 && byId[0]?.name !== network.switchName)) {
        return conflict("cleanup", "switch-identity-conflict");
    }
    if (namedSwitch && expectedSwitch && namedSwitch.id !== expectedSwitch.id) {
        return conflict("cleanup", "switch-successor-conflict");
    }
    if (namedSwitch && namedSwitch.switchType !== "Internal") {
        return conflict("cleanup", "switch-type-unsupported");
    }

    if (namedSwitch
        && (provenance.switch.kind === "managed"
            || provenance.gateway.kind === "managed"
            || provenance.nat.kind === "managed")) {
        const attachments = observation.vmNetworkAdapters.filter((adapter) =>
            adapter.switchId === namedSwitch.id || adapter.switchName === namedSwitch.name);
        if (attachments.length > 0) {
            return {
                kind: "settled",
                operation: "cleanup",
                disposition: "deferred-switch-in-use",
                switchIdentity: { id: namedSwitch.id, name: namedSwitch.name },
                attachments,
            };
        }
    }

    if (provenance.nat.kind === "managed") {
        const expectedNat = provenance.nat.identity;
        if (expectedNat.name !== network.natName) return conflict("cleanup", "nat-identity-conflict");
        const namedNatResult = singleNamedNat(observation.nats, network, "cleanup");
        if (namedNatResult.kind === "conflict") return namedNatResult;
        const namedNat = namedNatResult.kind === "found" ? namedNatResult.value : null;
        const byId = observation.nats.filter((candidate) => candidate.instanceId === expectedNat.instanceId);
        if (byId.length > 1 || (byId.length === 1 && byId[0]?.name !== network.natName)) {
            return conflict("cleanup", "nat-identity-conflict");
        }
        if (namedNat && namedNat.instanceId !== expectedNat.instanceId) {
            return conflict("cleanup", "nat-successor-conflict");
        }
        if (namedNat && namedNat.internalAddressPrefix !== network.cidr) {
            return conflict("cleanup", "nat-prefix-conflict");
        }
        if (namedNat) {
            return actionOutcome(observation.privilege, "cleanup", {
                kind: "remove-nat",
                request: { identity: { instanceId: namedNat.instanceId, name: namedNat.name } },
            });
        }
    }

    if (provenance.gateway.kind === "managed" && namedSwitch) {
        const expectedName = parseHyperVNetworkAdapterName(`vEthernet (${network.switchName})`);
        const adapters = observation.hostAdapters.filter((candidate) => candidate.name === expectedName);
        if (adapters.length > 1) return conflict("cleanup", "host-adapter-ambiguous");
        const adapter = adapters[0];
        if (adapter) {
            const gateway = provenance.gateway.identity;
            const matches = observation.ipv4Addresses.filter((address) =>
                address.interfaceIndex === adapter.interfaceIndex
                && address.address === gateway.address
                && address.prefixLength === gateway.prefixLength);
            if (matches.length > 1) return conflict("cleanup", "gateway-conflict");
            if (matches.length === 1) {
                return actionOutcome(observation.privilege, "cleanup", {
                    kind: "remove-gateway",
                    request: {
                        interfaceIndex: adapter.interfaceIndex,
                        address: gateway.address,
                        prefixLength: gateway.prefixLength,
                    },
                });
            }
        }
    }

    if (provenance.switch.kind === "managed" && namedSwitch) {
        return actionOutcome(observation.privilege, "cleanup", {
            kind: "remove-switch",
            request: { identity: { id: namedSwitch.id, name: namedSwitch.name } },
        });
    }

    return { kind: "settled", operation: "cleanup", disposition: "complete" };
}

export async function executeHyperVHostNetworkAction(
    client: HyperVWindowsNetworkClient,
    outcome: HyperVHostNetworkExecuteOutcome,
    options?: HyperVWindowsCallOptions,
): Promise<HyperVHostNetworkExecutionResult> {
    try {
        switch (outcome.action.kind) {
            case "create-switch": {
                const created = await client.createVMSwitch(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "ensure",
                    actionKind: "create-switch",
                    switchIdentity: { id: created.id, name: created.name },
                };
            }
            case "repair-switch-notes":
                await client.setVMSwitchNotes(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "ensure",
                    actionKind: "repair-switch-notes",
                    switchIdentity: outcome.action.request.identity,
                };
            case "create-gateway": {
                const created = await client.createNetIPAddress(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "ensure",
                    actionKind: "create-gateway",
                    gatewayIdentity: {
                        interfaceIndex: created.interfaceIndex,
                        address: created.address,
                        prefixLength: created.prefixLength,
                    },
                };
            }
            case "create-nat": {
                const created = await client.createNetNat(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "ensure",
                    actionKind: "create-nat",
                    natIdentity: { instanceId: created.instanceId, name: created.name },
                };
            }
            case "remove-nat":
                await client.removeNetNat(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "cleanup",
                    actionKind: "remove-nat",
                    natIdentity: outcome.action.request.identity,
                };
            case "remove-gateway":
                await client.removeNetIPAddress(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "cleanup",
                    actionKind: "remove-gateway",
                    gatewayIdentity: outcome.action.request,
                };
            case "remove-switch":
                await client.removeVMSwitch(outcome.action.request, options);
                return {
                    kind: "mutation-completed",
                    operation: "cleanup",
                    actionKind: "remove-switch",
                    switchIdentity: outcome.action.request.identity,
                };
            default: return assertNever(outcome.action);
        }
    } catch (cause) {
        return {
            kind: "indeterminate",
            operation: outcome.operation,
            reason: "mutation-result-unconfirmed",
            actionKind: outcome.action.kind,
            cause,
        };
    }
}
