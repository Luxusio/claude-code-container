import { describe, expect, it } from "vitest";
import {
    createHyperVHostNetworkSpec,
    parseHyperVInterfaceIndex,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVNetworkAdapterName,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    parseIPv4Address,
    parseIPv4Cidr,
    type HyperVHostNetworkSpec,
    type HyperVWindowsNetworkClient,
} from "../hyper-v-windows/low-level/index.js";
import {
    executeHyperVHostNetworkAction,
    planHyperVHostNetworkCleanup,
    reconcileHyperVHostNetwork,
    type HyperVHostNetworkCleanupObservation,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkEnsureProvenance,
    type HyperVHostNetworkObservation,
    type HyperVHostNetworkReconciliationOutcome,
} from "../hyper-v-windows/lifecycle/index.js";

const SWITCH_NAME = parseHyperVVirtualSwitchName("ccc-internal");
const SWITCH_ID = parseHyperVVirtualSwitchId("11111111-2222-3333-4444-555555555555");
const SUCCESSOR_SWITCH_ID = parseHyperVVirtualSwitchId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
const NAT_NAME = parseHyperVNatName("ccc-nat");
const NAT_ID = parseHyperVNatInstanceId("ccc-nat-instance");
const SUCCESSOR_NAT_ID = parseHyperVNatInstanceId("ccc-nat-successor");
const INTERFACE_INDEX = parseHyperVInterfaceIndex(42);
const NOTES = "consumer-neutral-owner-evidence";

function network(): HyperVHostNetworkSpec {
    return createHyperVHostNetworkSpec({
        switchName: SWITCH_NAME,
        natName: NAT_NAME,
        cidr: "172.31.240.0/24",
        gateway: "172.31.240.1",
    });
}

function virtualSwitch(id = SWITCH_ID, notes = NOTES, switchType = "Internal") {
    return { id, name: SWITCH_NAME, notes, switchType };
}

function hostAdapter(status = "Up") {
    return {
        interfaceIndex: INTERFACE_INDEX,
        name: parseHyperVNetworkAdapterName("vEthernet (ccc-internal)"),
        status,
        interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
    };
}

function gateway(addressState = "Preferred") {
    return {
        interfaceIndex: INTERFACE_INDEX,
        address: parseIPv4Address("172.31.240.1"),
        prefixLength: network().prefixLength,
        prefixOrigin: "Manual",
        suffixOrigin: "Manual",
        addressState,
    };
}

function nat(instanceId = NAT_ID) {
    return { instanceId, name: NAT_NAME, internalAddressPrefix: network().cidr };
}

function observation(
    overrides: Partial<HyperVHostNetworkObservation> = {},
): HyperVHostNetworkObservation {
    return {
        privilege: "administrator",
        provenance: { kind: "fresh", expectedSwitchNotes: NOTES },
        virtualSwitches: [virtualSwitch()],
        hostAdapters: [hostAdapter()],
        ipv4Addresses: [gateway()],
        nats: [nat()],
        vmNetworkAdapters: [],
        ...overrides,
    };
}

function cleanupObservation(
    overrides: Partial<HyperVHostNetworkCleanupObservation> = {},
): HyperVHostNetworkCleanupObservation {
    return {
        privilege: "administrator",
        virtualSwitches: [virtualSwitch()],
        hostAdapters: [hostAdapter()],
        ipv4Addresses: [gateway()],
        nats: [nat()],
        vmNetworkAdapters: [],
        ...overrides,
    };
}

function cleanupProvenance(): HyperVHostNetworkCleanupProvenance {
    const desired = network();
    return {
        switch: { kind: "managed", identity: { id: SWITCH_ID, name: SWITCH_NAME } },
        gateway: {
            kind: "managed",
            identity: {
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
                address: desired.gateway,
                prefixLength: desired.prefixLength,
            },
        },
        nat: { kind: "managed", identity: { instanceId: NAT_ID, name: NAT_NAME } },
    };
}

function outcomeLabel(outcome: HyperVHostNetworkReconciliationOutcome): string {
    switch (outcome.kind) {
        case "settled": return `settled:${outcome.operation}`;
        case "conflict": return `conflict:${outcome.reason}`;
        case "needs-administrator": return `admin:${outcome.requiredAction}`;
        case "execute": return `execute:${outcome.action.kind}`;
        case "indeterminate": return `indeterminate:${outcome.reason}`;
        default: return assertNever(outcome);
    }
}

function assertNever(value: never): never {
    throw new Error(`unexpected:${String(value)}`);
}

describe("Hyper-V host-network ensure reconciliation", () => {
    it.each([
        {
            name: "nothing exists",
            overrides: { virtualSwitches: [], hostAdapters: [], ipv4Addresses: [], nats: [] },
            action: "create-switch",
        },
        {
            name: "the switch and adapter exist",
            overrides: { ipv4Addresses: [], nats: [] },
            action: "create-gateway",
        },
        {
            name: "the switch and gateway exist",
            overrides: { nats: [] },
            action: "create-nat",
        },
    ])("plans the next single primitive when $name", ({ overrides, action }) => {
        const outcome = reconcileHyperVHostNetwork(observation(overrides), network());

        expect(outcome.kind).toBe("execute");
        if (outcome.kind === "execute") expect(outcome.action.kind).toBe(action);
    });

    it("settles only after the exact switch, adapter, gateway, and NAT exist", () => {
        const outcome = reconcileHyperVHostNetwork(observation(), network());

        expect(outcomeLabel(outcome)).toBe("settled:ensure");
        if (outcome.kind === "settled" && outcome.operation === "ensure") {
            expect(outcome.identity).toEqual({
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
                interfaceIndex: INTERFACE_INDEX,
                natIdentity: { instanceId: NAT_ID, name: NAT_NAME },
            });
        }
    });

    it("returns no executable stale plan before UAC and replans the changed administrator observation", () => {
        const ordinary = reconcileHyperVHostNetwork(observation({
            privilege: "standard",
            virtualSwitches: [],
            hostAdapters: [],
            ipv4Addresses: [],
            nats: [],
        }), network());
        expect(ordinary).toEqual({
            kind: "needs-administrator",
            operation: "ensure",
            requiredAction: "create-switch",
        });
        expect("action" in ordinary).toBe(false);

        const elevatedFreshInspection = reconcileHyperVHostNetwork(observation({
            privilege: "administrator",
            ipv4Addresses: [],
            nats: [],
        }), network());
        expect(outcomeLabel(elevatedFreshInspection)).toBe("execute:create-gateway");
    });

    it("repairs notes only with persisted exact switch and NAT evidence", () => {
        const persisted = observation({
            provenance: {
                kind: "persisted",
                expectedSwitchNotes: NOTES,
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
                nat: { kind: "exact", identity: { instanceId: NAT_ID, name: NAT_NAME } },
            },
            virtualSwitches: [virtualSwitch(SWITCH_ID, "native-notes-to-repair")],
        });

        expect(outcomeLabel(reconcileHyperVHostNetwork(persisted, network())))
            .toBe("execute:repair-switch-notes");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            virtualSwitches: [virtualSwitch(SWITCH_ID, "foreign-notes")],
        }), network()))).toBe("conflict:switch-notes-conflict");
    });

    it("accepts only the exact identities supplied by recognized adoption", () => {
        const adopted = reconcileHyperVHostNetwork(observation({
            provenance: {
                kind: "recognized-adoption",
                expectedSwitchNotes: NOTES,
                switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
                nat: { kind: "exact", identity: { instanceId: NAT_ID, name: NAT_NAME } },
            },
        }), network());

        expect(outcomeLabel(adopted)).toBe("settled:ensure");
    });

    it("fences same-name switch and NAT successors against persisted identities", () => {
        const provenance: HyperVHostNetworkEnsureProvenance = {
            kind: "persisted",
            expectedSwitchNotes: NOTES,
            switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
            nat: { kind: "exact", identity: { instanceId: NAT_ID, name: NAT_NAME } },
        };

        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            provenance,
            virtualSwitches: [virtualSwitch(SUCCESSOR_SWITCH_ID)],
        }), network()))).toBe("conflict:switch-successor-conflict");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            provenance,
            nats: [nat(SUCCESSOR_NAT_ID)],
        }), network()))).toBe("conflict:nat-successor-conflict");
    });

    it("fails closed on unknown native strings and overlapping foreign subnets", () => {
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            virtualSwitches: [virtualSwitch(SWITCH_ID, NOTES, "FutureSwitchType")],
        }), network()))).toBe("conflict:switch-type-unsupported");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            hostAdapters: [hostAdapter("FutureAdapterStatus")],
        }), network()))).toBe("conflict:host-adapter-status-unsupported");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            ipv4Addresses: [gateway("FutureAddressState")],
        }), network()))).toBe("conflict:gateway-address-state-unsupported");

        const foreignPrefix = parseIPv4Cidr("172.31.240.128/25");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            nats: [nat(), {
                instanceId: parseHyperVNatInstanceId("foreign-nat-instance"),
                name: parseHyperVNatName("foreign-nat"),
                internalAddressPrefix: foreignPrefix,
            }],
        }), network()))).toBe("conflict:foreign-nat-subnet-overlap");
        expect(outcomeLabel(reconcileHyperVHostNetwork(observation({
            ipv4Addresses: [gateway(), {
                ...gateway(),
                interfaceIndex: parseHyperVInterfaceIndex(99),
                address: parseIPv4Address("172.31.240.99"),
            }],
        }), network()))).toBe("conflict:foreign-interface-subnet-overlap");
    });
});

describe("Hyper-V host-network cleanup reconciliation", () => {
    it("plans NAT, gateway, then switch removal from fresh observations", () => {
        const desired = network();
        const provenance = cleanupProvenance();
        const removeNat = planHyperVHostNetworkCleanup(cleanupObservation(), desired, provenance);
        const removeGateway = planHyperVHostNetworkCleanup(cleanupObservation({ nats: [] }), desired, provenance);
        const removeSwitch = planHyperVHostNetworkCleanup(cleanupObservation({ nats: [], ipv4Addresses: [] }), desired, provenance);
        const complete = planHyperVHostNetworkCleanup(cleanupObservation({
            nats: [], ipv4Addresses: [], virtualSwitches: [], hostAdapters: [],
        }), desired, provenance);

        expect(outcomeLabel(removeNat)).toBe("execute:remove-nat");
        expect(outcomeLabel(removeGateway)).toBe("execute:remove-gateway");
        expect(outcomeLabel(removeSwitch)).toBe("execute:remove-switch");
        expect(complete).toEqual({ kind: "settled", operation: "cleanup", disposition: "complete" });
    });

    it("withholds the cleanup action before UAC and replans from the elevated observation", () => {
        const desired = network();
        const provenance = cleanupProvenance();
        const ordinary = planHyperVHostNetworkCleanup(cleanupObservation({
            privilege: "standard",
        }), desired, provenance);
        expect(ordinary).toEqual({
            kind: "needs-administrator",
            operation: "cleanup",
            requiredAction: "remove-nat",
        });
        expect("action" in ordinary).toBe(false);

        const elevatedFreshInspection = planHyperVHostNetworkCleanup(cleanupObservation({
            privilege: "administrator",
            nats: [],
        }), desired, provenance);
        expect(outcomeLabel(elevatedFreshInspection)).toBe("execute:remove-gateway");
    });

    it("defers exact switch removal while any VM adapter remains attached", () => {
        const outcome = planHyperVHostNetworkCleanup(cleanupObservation({
            nats: [],
            ipv4Addresses: [],
            vmNetworkAdapters: [{
                vmId: parseHyperVVirtualMachineId("22222222-3333-4444-5555-666666666666"),
                vmName: "attached-vm",
                name: "Network Adapter",
                switchId: SWITCH_ID,
                switchName: SWITCH_NAME,
                status: "FutureStatusStillAttached",
                managementOperatingSystem: false,
            }],
        }), network(), cleanupProvenance());

        expect(outcome).toMatchObject({
            kind: "settled",
            operation: "cleanup",
            disposition: "deferred-switch-in-use",
            switchIdentity: { id: SWITCH_ID, name: SWITCH_NAME },
        });
    });

    it("fences same-name successors before destructive cleanup", () => {
        const switchSuccessor = planHyperVHostNetworkCleanup(cleanupObservation({
            nats: [],
            virtualSwitches: [virtualSwitch(SUCCESSOR_SWITCH_ID)],
        }), network(), cleanupProvenance());
        const natSuccessor = planHyperVHostNetworkCleanup(cleanupObservation({
            nats: [nat(SUCCESSOR_NAT_ID)],
        }), network(), cleanupProvenance());

        expect(outcomeLabel(switchSuccessor)).toBe("conflict:switch-successor-conflict");
        expect(outcomeLabel(natSuccessor)).toBe("conflict:nat-successor-conflict");
    });
});

describe("Hyper-V host-network prepared execution", () => {
    it("executes one primitive and never retries an unconfirmed mutation", async () => {
        let createSwitchCalls = 0;
        const client = fakeClient(async () => {
            createSwitchCalls += 1;
            throw new Error("response-lost");
        });
        const outcome = reconcileHyperVHostNetwork(observation({
            virtualSwitches: [], hostAdapters: [], ipv4Addresses: [], nats: [],
        }), network());
        if (outcome.kind !== "execute") throw new Error("expected execute outcome");

        await expect(executeHyperVHostNetworkAction(client, outcome)).resolves.toMatchObject({
            kind: "indeterminate",
            operation: "ensure",
            reason: "mutation-result-unconfirmed",
            actionKind: "create-switch",
        });
        expect(createSwitchCalls).toBe(1);
    });
});

function fakeClient(
    createSwitch: HyperVWindowsNetworkClient["createVMSwitch"],
): HyperVWindowsNetworkClient {
    return {
        getVMSwitches: async () => [],
        createVMSwitch: createSwitch,
        setVMSwitchNotes: async () => undefined,
        removeVMSwitch: async () => undefined,
        getAllVMNetworkAdapters: async () => [],
        getVMsByExactNames: async () => [],
        getHostNetworkAdapters: async () => [],
        getNetIPAddresses: async () => [],
        createNetIPAddress: async (request) => ({
            ...request,
            prefixOrigin: "Manual",
            suffixOrigin: "Manual",
            addressState: "Preferred",
        }),
        removeNetIPAddress: async () => undefined,
        getNetNats: async () => [],
        createNetNat: async (request) => ({
            instanceId: NAT_ID,
            name: request.name,
            internalAddressPrefix: request.internalAddressPrefix,
        }),
        removeNetNat: async () => undefined,
    };
}
