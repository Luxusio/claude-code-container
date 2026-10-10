import { createHyperVNetworkTrust } from "../../application/hyper-v-network-trust.js";
import type { HyperVHostNetworkEffects, HyperVHostNetworkPorts } from "../../ports/hyper-v-network-trust.js";
export { DeviceLabHyperVNetworkAdapterError } from "../../domain/hyper-v-network-trust.js";
import {
    createHyperVWindowsNetworkClient,
    executeHyperVHostNetworkAction,
    HyperVWindowsError,
    parseHyperVNetworkAdapterName,
    type HyperVHostNetworkCleanupObservation,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkEnsureProvenance,
    type HyperVHostNetworkExecutionResult,
    type HyperVHostNetworkObservation,
    type HyperVHostNetworkReconciliationOutcome,
    type HyperVHostNetworkSpec,
    type HyperVWindowsNetworkClient,
} from "@ccc/hyper-v/index.js";
import { createDeviceLabHyperVWindowsExecutor, type DeviceLabHyperVWindowsClientOptions, } from "./lifecycle-adapter.js";
// Why an administrator transaction was opened. The broker writes it on its elevation log lines
// so a UAC prompt can be attributed; it never changes what the transaction may do.
export type DeviceLabHyperVAdministratorPurpose = "ensure" | "cleanup";
export type WithAdministratorHyperVWindowsNetworkClient = <Result>(operation: (client: HyperVWindowsNetworkClient) => Result | Promise<Result>, purpose?: DeviceLabHyperVAdministratorPurpose) => Promise<Result>;
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
    readonly deadlineAt?: number;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly onConfirmedAction?: (action: DeviceLabHyperVHostNetworkEnsureCompletedAction, observation: HyperVHostNetworkObservation) => void | Promise<void>;
};
export type DeviceLabHyperVHostNetworkCleanupOptions = {
    readonly client: HyperVWindowsNetworkClient;
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkCleanupProvenance;
    readonly withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient;
    readonly onConfirmedAction?: (action: DeviceLabHyperVHostNetworkCleanupCompletedAction, observation: HyperVHostNetworkCleanupObservation) => void | Promise<void>;
};
export type DeviceLabHyperVHostNetworkCompletedAction = Extract<HyperVHostNetworkExecutionResult, {
    readonly kind: "mutation-completed";
}>;
export type DeviceLabHyperVHostNetworkEnsureCompletedAction = Extract<DeviceLabHyperVHostNetworkCompletedAction, {
    readonly operation: "ensure";
}>;
export type DeviceLabHyperVHostNetworkCleanupCompletedAction = Extract<DeviceLabHyperVHostNetworkCompletedAction, {
    readonly operation: "cleanup";
}>;
type DeviceLabHyperVHostNetworkEnsureOutcome = Exclude<HyperVHostNetworkReconciliationOutcome<"ensure">, {
    readonly kind: "execute";
}>;
type DeviceLabHyperVHostNetworkCleanupOutcome = Exclude<HyperVHostNetworkReconciliationOutcome<"cleanup">, {
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
export function createDeviceLabHyperVWindowsNetworkClient(options: DeviceLabHyperVWindowsClientOptions): HyperVWindowsNetworkClient {
    return createHyperVWindowsNetworkClient(createDeviceLabHyperVWindowsExecutor(options));
}
async function inspectHostFabric(client: HyperVWindowsNetworkClient, network: HyperVHostNetworkSpec) {
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
export async function inspectDeviceLabHyperVHostNetwork(client: HyperVWindowsNetworkClient, options: DeviceLabHyperVHostNetworkInspectionOptions): Promise<HyperVHostNetworkObservation> {
    return {
        privilege: options.privilege,
        provenance: options.provenance,
        ...await inspectHostFabric(client, options.network),
    };
}
export async function inspectDeviceLabHyperVHostNetworkCleanup(client: HyperVWindowsNetworkClient, options: DeviceLabHyperVHostNetworkCleanupInspectionOptions): Promise<HyperVHostNetworkCleanupObservation> {
    return {
        privilege: options.privilege,
        ...await inspectHostFabric(client, options.network),
    };
}
const ELEVATED_MUTATION_PROVEN_NOT_STARTED = new Set([
    "hyper-v-network-elevation-cancelled", "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-executable-rejected", "hyper-v-network-elevation-relay-spawn-failed",
    "hyper-v-network-elevation-handshake-timeout", "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required", "hyper-v-network-elevation-deadline-exceeded",
    "hyper-v-network-elevation-protocol-invalid", "hyper-v-network-elevation-scope-closed",
    "hyper-v-network-elevation-suppressed",
]);
export function createDeviceLabHyperVHostNetworkEffects(client: HyperVWindowsNetworkClient): HyperVHostNetworkEffects {
    return {
        observe: network => inspectHostFabric(client, network),
        execute: action => action.operation === "ensure"
            ? executeHyperVHostNetworkAction(client, action)
            : executeHyperVHostNetworkAction(client, action),
        exactVirtualMachines: names => client.getVMsByExactNames({ names }),
    };
}
export function createDeviceLabHyperVHostNetworkPorts(
    client: HyperVWindowsNetworkClient,
    withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
): HyperVHostNetworkPorts {
    return {
        kind: "host",
        standard: createDeviceLabHyperVHostNetworkEffects(client),
        withAdministrator: (operation, purpose) => withAdministratorClient(scopedClient => operation(createDeviceLabHyperVHostNetworkEffects(scopedClient)), purpose),
        now,
        pause: sleep,
        mutationNeverStarted: cause => cause instanceof HyperVWindowsError
            && cause.category === "transport" && ELEVATED_MUTATION_PROVEN_NOT_STARTED.has(cause.code),
    };
}
export function ensureDeviceLabHyperVHostNetwork(options: DeviceLabHyperVHostNetworkEnsureOptions): Promise<DeviceLabHyperVHostNetworkEnsureTransactionResult> {
    const application = createHyperVNetworkTrust(createDeviceLabHyperVHostNetworkPorts(options.client, options.withAdministratorClient, options.now ?? Date.now, options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))));
    return application.ensureHost({
        network: options.network,
        provenance: options.provenance,
        deadlineAt: options.deadlineAt ?? Number.POSITIVE_INFINITY,
        confirmed: async (action, observation) => { await options.onConfirmedAction?.(action, observation); },
    });
}
export function cleanupDeviceLabHyperVHostNetwork(options: DeviceLabHyperVHostNetworkCleanupOptions): Promise<DeviceLabHyperVHostNetworkCleanupTransactionResult> {
    const application = createHyperVNetworkTrust(createDeviceLabHyperVHostNetworkPorts(options.client, options.withAdministratorClient, Date.now, milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds))));
    return application.cleanupHost({
        network: options.network,
        provenance: options.provenance,
        confirmed: async (action, observation) => { await options.onConfirmedAction?.(action, observation); },
    });
}
