import { describe, expect, it, vi } from "vitest";

import {
    createHyperVHostNetworkSpec,
    HyperVWindowsError,
    parseHyperVInterfaceIndex,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVNetworkAdapterName,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    type HyperVHostNetworkAdapter,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkEnsureProvenance,
    type HyperVNetIPAddress,
    type HyperVNetNat,
    type HyperVVirtualSwitch,
    type HyperVVMNetworkAdapter,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutor,
    type HyperVWindowsNetworkClient,
} from "../hyper-v-windows/index.js";
import {
    cleanupDeviceLabHyperVHostNetwork,
    createDeviceLabHyperVWindowsNetworkClient,
    ensureDeviceLabHyperVHostNetwork,
    inspectDeviceLabHyperVHostNetwork,
    type WithAdministratorHyperVWindowsNetworkClient,
} from "../device-lab/broker/hyper-v/network-adapter.js";

const SWITCH_NAME = parseHyperVVirtualSwitchName("CCC Device Lab");
const SWITCH_ID = parseHyperVVirtualSwitchId("11111111-2222-3333-4444-555555555555");
const SUCCESSOR_SWITCH_ID = parseHyperVVirtualSwitchId("99999999-8888-7777-6666-555555555555");
const NAT_NAME = parseHyperVNatName("CCCDeviceLab-0123456789abcdef01234567");
const NAT_ID = parseHyperVNatInstanceId("nat-instance-1");
const INTERFACE_INDEX = parseHyperVInterfaceIndex(42);
const VM_ID = parseHyperVVirtualMachineId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
const NETWORK = createHyperVHostNetworkSpec({
    switchName: SWITCH_NAME,
    natName: NAT_NAME,
    cidr: "172.29.0.0/24",
    gateway: "172.29.0.1",
});
const NOTES = "ccc-device-lab:hyper-v-network:0123456789abcdef01234567";
const FRESH: HyperVHostNetworkEnsureProvenance = {
    kind: "fresh",
    expectedSwitchNotes: NOTES,
};

type MemoryState = {
    virtualSwitches: HyperVVirtualSwitch[];
    hostAdapters: HyperVHostNetworkAdapter[];
    ipv4Addresses: HyperVNetIPAddress[];
    nats: HyperVNetNat[];
    vmNetworkAdapters: HyperVVMNetworkAdapter[];
    actions: string[];
    reads: string[];
};

function emptyState(): MemoryState {
    return {
        virtualSwitches: [],
        hostAdapters: [],
        ipv4Addresses: [],
        nats: [],
        vmNetworkAdapters: [],
        actions: [],
        reads: [],
    };
}

function addSettledHostFabric(state: MemoryState): void {
    state.virtualSwitches.push({ id: SWITCH_ID, name: SWITCH_NAME, switchType: "Internal", notes: NOTES });
    state.hostAdapters.push({
        interfaceIndex: INTERFACE_INDEX,
        name: parseHyperVNetworkAdapterName(`vEthernet (${SWITCH_NAME})`),
        status: "Up",
        interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
    });
    state.ipv4Addresses.push({
        interfaceIndex: INTERFACE_INDEX,
        address: NETWORK.gateway,
        prefixLength: NETWORK.prefixLength,
        prefixOrigin: "Manual",
        suffixOrigin: "Manual",
        addressState: "Preferred",
    });
    state.nats.push({ instanceId: NAT_ID, name: NAT_NAME, internalAddressPrefix: NETWORK.cidr });
}

function memoryClient(
    state: MemoryState,
    options: {
        readonly mutationAppliedThenLost?: string;
        readonly replaceCreatedSwitchBeforeConfirmation?: boolean;
        readonly attachVmAfterMutation?: string;
    } = {},
): HyperVWindowsNetworkClient {
    function recordMutation(kind: string): void {
        state.actions.push(kind);
        if (options.attachVmAfterMutation === kind) {
            state.vmNetworkAdapters.push({
                vmId: VM_ID,
                vmName: "late-attached-vm",
                name: "Network Adapter",
                switchId: SWITCH_ID,
                switchName: SWITCH_NAME,
                status: "Ok",
                managementOperatingSystem: false,
            });
        }
        if (options.mutationAppliedThenLost === kind) throw new Error("response-lost-after-native-mutation");
    }

    return {
        async getVMSwitches(selector) {
            state.reads.push(`switch:${selector.kind}`);
            switch (selector.kind) {
                case "all": return [...state.virtualSwitches];
                case "id": return state.virtualSwitches.filter((item) => item.id === selector.id);
                case "name": return state.virtualSwitches.filter((item) => item.name === selector.name);
            }
        },
        async createVMSwitch(request) {
            const value: HyperVVirtualSwitch = {
                id: SWITCH_ID,
                name: request.name,
                switchType: "Internal",
                notes: request.notes,
            };
            state.virtualSwitches.push(value);
            state.hostAdapters.push({
                interfaceIndex: INTERFACE_INDEX,
                name: parseHyperVNetworkAdapterName(`vEthernet (${request.name})`),
                status: "Up",
                interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
            });
            recordMutation("create-switch");
            if (options.replaceCreatedSwitchBeforeConfirmation) {
                state.virtualSwitches.splice(0, 1, { ...value, id: SUCCESSOR_SWITCH_ID });
            }
            return value;
        },
        async setVMSwitchNotes(request) {
            const value = state.virtualSwitches.find((item) => item.id === request.identity.id);
            if (value) {
                state.virtualSwitches.splice(state.virtualSwitches.indexOf(value), 1, { ...value, notes: request.notes });
            }
            recordMutation("repair-switch-notes");
        },
        async removeVMSwitch(request) {
            const index = state.virtualSwitches.findIndex((item) => item.id === request.identity.id);
            if (index >= 0) state.virtualSwitches.splice(index, 1);
            recordMutation("remove-switch");
        },
        async getAllVMNetworkAdapters() {
            state.reads.push("vm-adapters:all");
            return [...state.vmNetworkAdapters];
        },
        async getVMsByExactNames() {
            return [];
        },
        async getHostNetworkAdapters(request) {
            state.reads.push(`host-adapter:${request.name}`);
            return state.hostAdapters.filter((item) => item.name === request.name);
        },
        async getNetIPAddresses(selector) {
            state.reads.push(`ip:${selector.kind}`);
            return selector.kind === "all-ipv4"
                ? [...state.ipv4Addresses]
                : state.ipv4Addresses.filter((item) => item.interfaceIndex === selector.interfaceIndex);
        },
        async createNetIPAddress(request) {
            const value: HyperVNetIPAddress = {
                ...request,
                prefixOrigin: "Manual",
                suffixOrigin: "Manual",
                addressState: "Preferred",
            };
            state.ipv4Addresses.push(value);
            recordMutation("create-gateway");
            return value;
        },
        async removeNetIPAddress(request) {
            const index = state.ipv4Addresses.findIndex((item) =>
                item.interfaceIndex === request.interfaceIndex
                && item.address === request.address
                && item.prefixLength === request.prefixLength);
            if (index >= 0) state.ipv4Addresses.splice(index, 1);
            recordMutation("remove-gateway");
        },
        async getNetNats(selector) {
            state.reads.push(`nat:${selector.kind}`);
            switch (selector.kind) {
                case "all": return [...state.nats];
                case "instance-id": return state.nats.filter((item) => item.instanceId === selector.instanceId);
                case "name": return state.nats.filter((item) => item.name === selector.name);
            }
        },
        async createNetNat(request) {
            const value: HyperVNetNat = {
                instanceId: NAT_ID,
                name: request.name,
                internalAddressPrefix: request.internalAddressPrefix,
            };
            state.nats.push(value);
            recordMutation("create-nat");
            return value;
        },
        async removeNetNat(request) {
            const index = state.nats.findIndex((item) => item.instanceId === request.identity.instanceId);
            if (index >= 0) state.nats.splice(index, 1);
            recordMutation("remove-nat");
        },
    };
}

function administratorScope(
    client: HyperVWindowsNetworkClient,
    onEnter: () => void = () => undefined,
): { readonly scope: WithAdministratorHyperVWindowsNetworkClient; readonly count: () => number } {
    let count = 0;
    const scope: WithAdministratorHyperVWindowsNetworkClient = async <Result>(operation: (
        client: HyperVWindowsNetworkClient,
    ) => Result | Promise<Result>) => {
        count += 1;
        onEnter();
        return operation(client);
    };
    return { scope, count: () => count };
}

function managedCleanup(): HyperVHostNetworkCleanupProvenance {
    return {
        switch: { kind: "managed", identity: { id: SWITCH_ID, name: SWITCH_NAME } },
        gateway: {
            kind: "managed",
            identity: {
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
                address: NETWORK.gateway,
                prefixLength: NETWORK.prefixLength,
            },
        },
        nat: { kind: "managed", identity: { instanceId: NAT_ID, name: NAT_NAME } },
    };
}

describe("Device Lab Hyper-V network adapter", () => {
    it("inspects only the exact switch/host-adapter target plus bounded host collections", async () => {
        const state = emptyState();
        addSettledHostFabric(state);

        const observation = await inspectDeviceLabHyperVHostNetwork(memoryClient(state), {
            network: NETWORK,
            provenance: FRESH,
            privilege: "standard",
        });

        expect(observation.virtualSwitches).toHaveLength(1);
        expect(state.reads).toEqual([
            "switch:name",
            `host-adapter:vEthernet (${SWITCH_NAME})`,
            "ip:all-ipv4",
            "nat:all",
            "vm-adapters:all",
        ]);
    });

    it("does not mutate or elevate when ordinary inspection is settled or conflicted", async () => {
        const settledState = emptyState();
        addSettledHostFabric(settledState);
        const settledAdministrator = administratorScope(memoryClient(settledState));
        const settled = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(settledState),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: settledAdministrator.scope,
        });
        expect(settled.outcome.kind).toBe("settled");
        expect(settled.completedActions).toEqual([]);
        expect(settledState.actions).toEqual([]);
        expect(settledAdministrator.count()).toBe(0);

        const conflictState = emptyState();
        conflictState.virtualSwitches.push({
            id: SWITCH_ID,
            name: SWITCH_NAME,
            switchType: "External",
            notes: NOTES,
        });
        const conflictAdministrator = administratorScope(memoryClient(conflictState));
        const conflict = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(conflictState),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: conflictAdministrator.scope,
        });
        expect(conflict.outcome).toMatchObject({ kind: "conflict", reason: "switch-type-unsupported" });
        expect(conflict.completedActions).toEqual([]);
        expect(conflictState.actions).toEqual([]);
        expect(conflictAdministrator.count()).toBe(0);
    });

    it("uses one administrator callback for the complete multi-step ensure", async () => {
        const state = emptyState();
        const administrator = administratorScope(memoryClient(state));

        const result = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome.kind).toBe("settled");
        expect(result.completedActions).toEqual([
            {
                kind: "mutation-completed",
                operation: "ensure",
                actionKind: "create-switch",
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
            },
            {
                kind: "mutation-completed",
                operation: "ensure",
                actionKind: "create-gateway",
                gatewayIdentity: {
                    interfaceIndex: INTERFACE_INDEX,
                    address: NETWORK.gateway,
                    prefixLength: NETWORK.prefixLength,
                },
            },
            {
                kind: "mutation-completed",
                operation: "ensure",
                actionKind: "create-nat",
                natIdentity: { instanceId: NAT_ID, name: NAT_NAME },
            },
        ]);
        expect(administrator.count()).toBe(1);
        expect(state.actions).toEqual(["create-switch", "create-gateway", "create-nat"]);
        expect(state.reads.filter((entry) => entry === "switch:name")).toHaveLength(5);
    });

    it("discards the pre-UAC plan and replans from fresh administrator observations", async () => {
        const state = emptyState();
        const administrator = administratorScope(memoryClient(state), () => addSettledHostFabric(state));

        const result = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome.kind).toBe("settled");
        expect(result.completedActions).toEqual([]);
        expect(administrator.count()).toBe(1);
        expect(state.actions).toEqual([]);
    });

    it("stops immediately when a mutation was applied but its response was lost", async () => {
        const state = emptyState();
        const administrator = administratorScope(memoryClient(state, { mutationAppliedThenLost: "create-switch" }));

        const result = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome).toMatchObject({
            kind: "indeterminate",
            reason: "mutation-result-unconfirmed",
            actionKind: "create-switch",
        });
        expect(result.completedActions).toEqual([]);
        expect(state.actions).toEqual(["create-switch"]);
        expect(state.virtualSwitches).toHaveLength(1);
        expect(state.ipv4Addresses).toEqual([]);
        expect(state.nats).toEqual([]);
    });

    it.each([
        ["create-switch", (state: MemoryState) => state],
        ["create-gateway", (state: MemoryState) => {
            addSettledHostFabric(state);
            state.ipv4Addresses.length = 0;
            state.nats.length = 0;
            return state;
        }],
        ["create-nat", (state: MemoryState) => {
            addSettledHostFabric(state);
            state.nats.length = 0;
            return state;
        }],
    ] as const)("converges after a lost %s response without repeating the mutation", async (lostAction, arrange) => {
        const state = arrange(emptyState());
        const failingAdministrator = administratorScope(memoryClient(state, { mutationAppliedThenLost: lostAction }));
        const first = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: failingAdministrator.scope,
        });
        expect(first.outcome).toMatchObject({
            kind: "indeterminate",
            reason: "mutation-result-unconfirmed",
            actionKind: lostAction,
        });

        const recoveryAdministrator = administratorScope(memoryClient(state));
        const recovered = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: recoveryAdministrator.scope,
        });
        expect(recovered.outcome.kind).toBe("settled");
        expect(state.actions.filter((action) => action === lostAction)).toHaveLength(1);
    });

    it("preserves a pre-mutation UAC cancellation instead of retrying or flattening it", async () => {
        const state = emptyState();
        const administratorClient: HyperVWindowsNetworkClient = {
            ...memoryClient(state),
            async createVMSwitch() {
                throw new HyperVWindowsError({
                    category: "transport",
                    operation: "New-VMSwitch",
                    code: "hyper-v-network-elevation-cancelled",
                });
            },
        };
        const administrator = administratorScope(administratorClient);

        await expect(ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        })).rejects.toMatchObject({
            category: "transport",
            operation: "New-VMSwitch",
            code: "hyper-v-network-elevation-cancelled",
        });
        expect(administrator.count()).toBe(1);
        expect(state.actions).toEqual([]);
    });

    it("keeps an ambiguous elevated relay failure indeterminate after one attempted action", async () => {
        const state = emptyState();
        const administratorClient: HyperVWindowsNetworkClient = {
            ...memoryClient(state),
            async createVMSwitch() {
                throw new HyperVWindowsError({
                    category: "transport",
                    operation: "New-VMSwitch",
                    code: "hyper-v-network-elevation-relay-failed",
                });
            },
        };
        const administrator = administratorScope(administratorClient);

        const result = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        });
        expect(result.outcome).toMatchObject({
            kind: "indeterminate",
            reason: "mutation-result-unconfirmed",
            actionKind: "create-switch",
            cause: { code: "hyper-v-network-elevation-relay-failed" },
        });
        expect(result.completedActions).toEqual([]);
        expect(administrator.count()).toBe(1);
    });

    it("rejects a same-name switch successor that replaced the confirmed create result", async () => {
        const state = emptyState();
        const administratorClient = memoryClient(state, { replaceCreatedSwitchBeforeConfirmation: true });
        const administrator = administratorScope(administratorClient);

        const transaction = await ensureDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: FRESH,
            withAdministratorClient: administrator.scope,
        });

        expect(transaction.outcome).toEqual({
            kind: "conflict",
            operation: "ensure",
            reason: "switch-successor-conflict",
        });
        expect(transaction.completedActions).toHaveLength(1);
        expect(transaction.completedActions[0]).toMatchObject({
            actionKind: "create-switch",
            switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
        });
        expect(state.virtualSwitches[0]?.id).toBe(SUCCESSOR_SWITCH_ID);
        expect(state.ipv4Addresses).toEqual([]);
        expect(state.nats).toEqual([]);
    });

    it("cleans up in NAT, gateway, switch order inside one administrator callback", async () => {
        const state = emptyState();
        addSettledHostFabric(state);
        const administrator = administratorScope(memoryClient(state));

        const result = await cleanupDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: managedCleanup(),
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome).toEqual({ kind: "settled", operation: "cleanup", disposition: "complete" });
        expect(result.completedActions).toEqual([
            {
                kind: "mutation-completed",
                operation: "cleanup",
                actionKind: "remove-nat",
                natIdentity: { instanceId: NAT_ID, name: NAT_NAME },
            },
            {
                kind: "mutation-completed",
                operation: "cleanup",
                actionKind: "remove-gateway",
                gatewayIdentity: {
                    interfaceIndex: INTERFACE_INDEX,
                    address: NETWORK.gateway,
                    prefixLength: NETWORK.prefixLength,
                },
            },
            {
                kind: "mutation-completed",
                operation: "cleanup",
                actionKind: "remove-switch",
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
            },
        ]);
        expect(administrator.count()).toBe(1);
        expect(state.actions).toEqual(["remove-nat", "remove-gateway", "remove-switch"]);
    });

    it("keeps switch-in-use cleanup deferred without requesting administrator access", async () => {
        const state = emptyState();
        addSettledHostFabric(state);
        state.vmNetworkAdapters.push({
            vmId: VM_ID,
            vmName: "attached-vm",
            name: "Network Adapter",
            switchId: SWITCH_ID,
            switchName: SWITCH_NAME,
            status: "Ok",
            managementOperatingSystem: false,
        });
        const administrator = administratorScope(memoryClient(state));

        const result = await cleanupDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: managedCleanup(),
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome).toMatchObject({
            kind: "settled",
            operation: "cleanup",
            disposition: "deferred-switch-in-use",
        });
        expect(result.completedActions).toEqual([]);
        expect(state.actions).toEqual([]);
        expect(state.nats).toHaveLength(1);
        expect(state.ipv4Addresses).toHaveLength(1);
        expect(administrator.count()).toBe(0);
    });

    it("stops cleanup before gateway removal when a VM attaches after NAT removal", async () => {
        const state = emptyState();
        addSettledHostFabric(state);
        const administrator = administratorScope(memoryClient(state, { attachVmAfterMutation: "remove-nat" }));

        const result = await cleanupDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: managedCleanup(),
            withAdministratorClient: administrator.scope,
        });

        expect(result.outcome).toMatchObject({
            kind: "settled",
            operation: "cleanup",
            disposition: "deferred-switch-in-use",
        });
        expect(result.completedActions).toEqual([{
            kind: "mutation-completed",
            operation: "cleanup",
            actionKind: "remove-nat",
            natIdentity: { instanceId: NAT_ID, name: NAT_NAME },
        }]);
        expect(state.actions).toEqual(["remove-nat"]);
        expect(state.ipv4Addresses).toHaveLength(1);
        expect(state.virtualSwitches).toHaveLength(1);
    });

    it.each([
        ["remove-nat", (state: MemoryState) => state],
        ["remove-gateway", (state: MemoryState) => {
            state.nats.length = 0;
            return state;
        }],
        ["remove-switch", (state: MemoryState) => {
            state.nats.length = 0;
            state.ipv4Addresses.length = 0;
            return state;
        }],
    ] as const)("converges after a lost %s response without deleting a successor", async (lostAction, arrange) => {
        const state = emptyState();
        addSettledHostFabric(state);
        arrange(state);
        const failingAdministrator = administratorScope(memoryClient(state, { mutationAppliedThenLost: lostAction }));
        const first = await cleanupDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: managedCleanup(),
            withAdministratorClient: failingAdministrator.scope,
        });
        expect(first.outcome).toMatchObject({
            kind: "indeterminate",
            reason: "mutation-result-unconfirmed",
            actionKind: lostAction,
        });

        const recoveryAdministrator = administratorScope(memoryClient(state));
        const recovered = await cleanupDeviceLabHyperVHostNetwork({
            client: memoryClient(state),
            network: NETWORK,
            provenance: managedCleanup(),
            withAdministratorClient: recoveryAdministrator.scope,
        });
        expect(recovered.outcome).toEqual({ kind: "settled", operation: "cleanup", disposition: "complete" });
        expect(state.actions.filter((action) => action === lostAction)).toHaveLength(1);
    });

    it("builds the network client through the shared executor and honors a supplied session", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const session: HyperVWindowsExecutor = {
            execute(request) {
                requests.push(request);
                return {
                    status: 0,
                    stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [] }),
                };
            },
        };
        const run = vi.fn(() => ({ status: 0, stdout: "" }));
        const client = createDeviceLabHyperVWindowsNetworkClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1_000,
            run,
            session,
        });

        await expect(client.getVMSwitches({ kind: "name", name: SWITCH_NAME })).resolves.toEqual([]);
        expect(requests).toEqual([{
            schemaVersion: 1,
            operation: "Get-VMSwitch",
            selector: { kind: "name", name: SWITCH_NAME },
        }]);
        expect(run).not.toHaveBeenCalled();
    });
});
