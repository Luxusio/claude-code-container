import {
    createHyperVWindowsNetworkClient,
    executeHyperVHostNetworkAction,
    HyperVWindowsError,
    parseHyperVNetworkAdapterName,
    planHyperVHostNetworkCleanup,
    reconcileHyperVHostNetwork,
    type HyperVHostNetworkCleanupObservation,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkEnsureProvenance,
    type HyperVHostNetworkExecutionResult,
    type HyperVHostNetworkObservation,
    type HyperVHostNetworkReconciliationOutcome,
    type HyperVHostNetworkSpec,
    type HyperVWindowsNetworkClient,
} from "../../../hyper-v-windows/index.js";
import {
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

const MAXIMUM_ENSURE_MUTATIONS = 4;
const MAXIMUM_CLEANUP_MUTATIONS = 3;
const MAXIMUM_TRANSIENT_OBSERVATIONS = 3;
const ELEVATED_MUTATION_PROVEN_NOT_STARTED = new Set([
    "hyper-v-network-elevation-cancelled",
    "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-handshake-timeout",
    "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required",
    "hyper-v-network-elevation-deadline-exceeded",
    "hyper-v-network-elevation-protocol-invalid",
    "hyper-v-network-elevation-scope-closed",
]);

function throwIfElevatedMutationNeverStarted(cause: unknown): void {
    if (cause instanceof HyperVWindowsError
        && cause.category === "transport"
        && ELEVATED_MUTATION_PROVEN_NOT_STARTED.has(cause.code)) {
        throw cause;
    }
}

export type WithAdministratorHyperVWindowsNetworkClient = <Result>(
    operation: (client: HyperVWindowsNetworkClient) => Result | Promise<Result>,
) => Promise<Result>;

export type DeviceLabHyperVHostNetworkInspectionOptions = {
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkEnsureProvenance;
    readonly privilege: "standard" | "administrator";
};

export type DeviceLabHyperVHostNetworkCleanupInspectionOptions = {
    readonly network: HyperVHostNetworkSpec;
    readonly privilege: "standard" | "administrator";
};

export type DeviceLabHyperVHostNetworkEnsureOptions = {
    readonly client: HyperVWindowsNetworkClient;
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkEnsureProvenance;
    readonly withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient;
};

export type DeviceLabHyperVHostNetworkCleanupOptions = {
    readonly client: HyperVWindowsNetworkClient;
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkCleanupProvenance;
    readonly withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient;
};

export type DeviceLabHyperVHostNetworkCompletedAction = Extract<
    HyperVHostNetworkExecutionResult,
    { readonly kind: "mutation-completed" }
>;

export type DeviceLabHyperVHostNetworkTransactionResult = {
    readonly outcome: HyperVHostNetworkReconciliationOutcome;
    readonly completedActions: readonly DeviceLabHyperVHostNetworkCompletedAction[];
};

export class DeviceLabHyperVNetworkAdapterError extends Error {
    readonly code:
        | "hyper-v-network-adapter-standard-plan-executable"
        | "hyper-v-network-adapter-administrator-plan-needs-administrator"
        | "hyper-v-network-adapter-action-operation-mismatch"
        | "hyper-v-network-adapter-mutation-bound-exceeded";

    constructor(code: DeviceLabHyperVNetworkAdapterError["code"]) {
        super(code);
        this.name = "DeviceLabHyperVNetworkAdapterError";
        this.code = code;
    }
}

function confirmedEnsureOutcome(
    outcome: HyperVHostNetworkReconciliationOutcome,
    completedActions: readonly DeviceLabHyperVHostNetworkCompletedAction[],
): HyperVHostNetworkReconciliationOutcome {
    if (outcome.kind !== "settled" || outcome.operation !== "ensure") return outcome;
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
            case "remove-switch":
            case "remove-gateway":
            case "remove-nat":
                throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
        }
    }
    return outcome;
}

function ensureReceiptConflict(
    observation: HyperVHostNetworkObservation,
    completedActions: readonly DeviceLabHyperVHostNetworkCompletedAction[],
): HyperVHostNetworkReconciliationOutcome | null {
    for (const completed of completedActions) {
        switch (completed.actionKind) {
            case "create-switch":
            case "repair-switch-notes": {
                const exact = observation.virtualSwitches.filter((candidate) =>
                    candidate.id === completed.switchIdentity.id
                    && candidate.name === completed.switchIdentity.name);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "switch-successor-conflict" };
                }
                break;
            }
            case "create-gateway": {
                const exact = observation.ipv4Addresses.filter((candidate) =>
                    candidate.interfaceIndex === completed.gatewayIdentity.interfaceIndex
                    && candidate.address === completed.gatewayIdentity.address
                    && candidate.prefixLength === completed.gatewayIdentity.prefixLength);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "gateway-conflict" };
                }
                break;
            }
            case "create-nat": {
                const exact = observation.nats.filter((candidate) =>
                    candidate.instanceId === completed.natIdentity.instanceId
                    && candidate.name === completed.natIdentity.name);
                if (exact.length !== 1) {
                    return { kind: "conflict", operation: "ensure", reason: "nat-successor-conflict" };
                }
                break;
            }
            case "remove-switch":
            case "remove-gateway":
            case "remove-nat":
                throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
        }
    }
    return null;
}

function cleanupReceiptConflict(
    observation: HyperVHostNetworkCleanupObservation,
    completedActions: readonly DeviceLabHyperVHostNetworkCompletedAction[],
): HyperVHostNetworkReconciliationOutcome | null {
    for (const completed of completedActions) {
        switch (completed.actionKind) {
            case "remove-switch": {
                const removedSwitchReappeared = observation.virtualSwitches.some((candidate) =>
                    candidate.id === completed.switchIdentity.id
                    && candidate.name === completed.switchIdentity.name);
                if (removedSwitchReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "switch-successor-conflict" };
                }
                break;
            }
            case "remove-gateway": {
                const removedGatewayReappeared = observation.ipv4Addresses.some((candidate) =>
                    candidate.interfaceIndex === completed.gatewayIdentity.interfaceIndex
                    && candidate.address === completed.gatewayIdentity.address
                    && candidate.prefixLength === completed.gatewayIdentity.prefixLength);
                if (removedGatewayReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "gateway-conflict" };
                }
                break;
            }
            case "remove-nat": {
                const removedNatReappeared = observation.nats.some((candidate) =>
                    candidate.instanceId === completed.natIdentity.instanceId
                    && candidate.name === completed.natIdentity.name);
                if (removedNatReappeared) {
                    return { kind: "conflict", operation: "cleanup", reason: "nat-successor-conflict" };
                }
                break;
            }
            case "create-switch":
            case "repair-switch-notes":
            case "create-gateway":
            case "create-nat":
                throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
        }
    }
    return null;
}

function isRetryableEnsureObservation(outcome: HyperVHostNetworkReconciliationOutcome): boolean {
    return outcome.kind === "indeterminate"
        && (outcome.reason === "host-adapter-missing" || outcome.reason === "gateway-transitioning");
}

async function reconcileEnsureWithoutMutation(
    client: HyperVWindowsNetworkClient,
    options: Pick<DeviceLabHyperVHostNetworkEnsureOptions, "network" | "provenance">,
): Promise<Exclude<HyperVHostNetworkReconciliationOutcome, { readonly kind: "execute" }>> {
    for (let observationCount = 1; observationCount <= MAXIMUM_TRANSIENT_OBSERVATIONS; observationCount += 1) {
        const observation = await inspectDeviceLabHyperVHostNetwork(client, {
            network: options.network,
            provenance: options.provenance,
            privilege: "standard",
        });
        const outcome = assertStandardDecision(reconcileHyperVHostNetwork(observation, options.network));
        if (!isRetryableEnsureObservation(outcome) || observationCount === MAXIMUM_TRANSIENT_OBSERVATIONS) {
            return outcome;
        }
    }
    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
}

export function createDeviceLabHyperVWindowsNetworkClient(
    options: DeviceLabHyperVWindowsClientOptions,
): HyperVWindowsNetworkClient {
    return createHyperVWindowsNetworkClient(createDeviceLabHyperVWindowsExecutor(options));
}

async function inspectHostFabric(
    client: HyperVWindowsNetworkClient,
    network: HyperVHostNetworkSpec,
) {
    const hostAdapterName = parseHyperVNetworkAdapterName(`vEthernet (${network.switchName})`);
    const [virtualSwitches, hostAdapters, ipv4Addresses, nats, vmNetworkAdapters] = await Promise.all([
        client.getVMSwitches({ kind: "name", name: network.switchName }),
        client.getHostNetworkAdapters({ name: hostAdapterName }),
        client.getNetIPAddresses({ kind: "all-ipv4" }),
        client.getNetNats({ kind: "all" }),
        client.getAllVMNetworkAdapters(),
    ]);
    return { virtualSwitches, hostAdapters, ipv4Addresses, nats, vmNetworkAdapters };
}

export async function inspectDeviceLabHyperVHostNetwork(
    client: HyperVWindowsNetworkClient,
    options: DeviceLabHyperVHostNetworkInspectionOptions,
): Promise<HyperVHostNetworkObservation> {
    return {
        privilege: options.privilege,
        provenance: options.provenance,
        ...await inspectHostFabric(client, options.network),
    };
}

export async function inspectDeviceLabHyperVHostNetworkCleanup(
    client: HyperVWindowsNetworkClient,
    options: DeviceLabHyperVHostNetworkCleanupInspectionOptions,
): Promise<HyperVHostNetworkCleanupObservation> {
    return {
        privilege: options.privilege,
        ...await inspectHostFabric(client, options.network),
    };
}

function assertStandardDecision(
    outcome: HyperVHostNetworkReconciliationOutcome,
): Exclude<HyperVHostNetworkReconciliationOutcome, { readonly kind: "execute" }> {
    if (outcome.kind === "execute") {
        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-standard-plan-executable");
    }
    return outcome;
}

async function reconcileEnsureAsAdministrator(
    client: HyperVWindowsNetworkClient,
    options: Pick<DeviceLabHyperVHostNetworkEnsureOptions, "network" | "provenance">,
): Promise<DeviceLabHyperVHostNetworkTransactionResult> {
    let mutations = 0;
    let transientObservations = 0;
    const completedActions: DeviceLabHyperVHostNetworkCompletedAction[] = [];
    while (true) {
        const observation = await inspectDeviceLabHyperVHostNetwork(client, {
            network: options.network,
            provenance: options.provenance,
            privilege: "administrator",
        });
        const receiptConflict = ensureReceiptConflict(observation, completedActions);
        if (receiptConflict) return { outcome: receiptConflict, completedActions: [...completedActions] };
        const outcome = reconcileHyperVHostNetwork(observation, options.network);
        switch (outcome.kind) {
            case "settled":
                return {
                    outcome: confirmedEnsureOutcome(outcome, completedActions),
                    completedActions: [...completedActions],
                };
            case "conflict":
                return { outcome, completedActions: [...completedActions] };
            case "indeterminate":
                if (isRetryableEnsureObservation(outcome)
                    && transientObservations + 1 < MAXIMUM_TRANSIENT_OBSERVATIONS) {
                    transientObservations += 1;
                    break;
                }
                return { outcome, completedActions: [...completedActions] };
            case "needs-administrator":
                throw new DeviceLabHyperVNetworkAdapterError(
                    "hyper-v-network-adapter-administrator-plan-needs-administrator",
                );
            case "execute": {
                if (mutations >= MAXIMUM_ENSURE_MUTATIONS) {
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
                }
                mutations += 1;
                const execution = await executeHyperVHostNetworkAction(client, outcome);
                if (execution.kind === "indeterminate") {
                    throwIfElevatedMutationNeverStarted(execution.cause);
                    return { outcome: execution, completedActions: [...completedActions] };
                }
                completedActions.push(execution);
                transientObservations = 0;
                break;
            }
        }
    }
}

export async function ensureDeviceLabHyperVHostNetwork(
    options: DeviceLabHyperVHostNetworkEnsureOptions,
): Promise<DeviceLabHyperVHostNetworkTransactionResult> {
    const outcome = await reconcileEnsureWithoutMutation(options.client, options);
    if (outcome.kind !== "needs-administrator") return { outcome, completedActions: [] };
    return options.withAdministratorClient((client) => reconcileEnsureAsAdministrator(client, options));
}

async function reconcileCleanupAsAdministrator(
    client: HyperVWindowsNetworkClient,
    options: Pick<DeviceLabHyperVHostNetworkCleanupOptions, "network" | "provenance">,
): Promise<DeviceLabHyperVHostNetworkTransactionResult> {
    let mutations = 0;
    const completedActions: DeviceLabHyperVHostNetworkCompletedAction[] = [];
    while (true) {
        const observation = await inspectDeviceLabHyperVHostNetworkCleanup(client, {
            network: options.network,
            privilege: "administrator",
        });
        const receiptConflict = cleanupReceiptConflict(observation, completedActions);
        if (receiptConflict) return { outcome: receiptConflict, completedActions: [...completedActions] };
        const outcome = planHyperVHostNetworkCleanup(observation, options.network, options.provenance);
        switch (outcome.kind) {
            case "settled":
            case "conflict":
            case "indeterminate":
                return { outcome, completedActions: [...completedActions] };
            case "needs-administrator":
                throw new DeviceLabHyperVNetworkAdapterError(
                    "hyper-v-network-adapter-administrator-plan-needs-administrator",
                );
            case "execute": {
                if (mutations >= MAXIMUM_CLEANUP_MUTATIONS) {
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
                }
                mutations += 1;
                const execution = await executeHyperVHostNetworkAction(client, outcome);
                if (execution.kind === "indeterminate") {
                    throwIfElevatedMutationNeverStarted(execution.cause);
                    return { outcome: execution, completedActions: [...completedActions] };
                }
                completedActions.push(execution);
                break;
            }
        }
    }
}

export async function cleanupDeviceLabHyperVHostNetwork(
    options: DeviceLabHyperVHostNetworkCleanupOptions,
): Promise<DeviceLabHyperVHostNetworkTransactionResult> {
    const observation = await inspectDeviceLabHyperVHostNetworkCleanup(options.client, {
        network: options.network,
        privilege: "standard",
    });
    const outcome = assertStandardDecision(
        planHyperVHostNetworkCleanup(observation, options.network, options.provenance),
    );
    if (outcome.kind !== "needs-administrator") return { outcome, completedActions: [] };
    return options.withAdministratorClient((client) => reconcileCleanupAsAdministrator(client, options));
}
