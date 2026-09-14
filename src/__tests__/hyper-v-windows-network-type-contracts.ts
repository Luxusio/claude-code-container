import {
    createHyperVHostNetworkSpec,
    parseHyperVInterfaceIndex,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    parseIPv4Address,
    parseIPv4Cidr,
    parseIPv4PrefixLength,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkReconciliationOutcome,
    type HyperVWindowsNetworkClient,
} from "../hyper-v-windows/index.js";

const switchName = parseHyperVVirtualSwitchName("CCC Device Lab");
const switchId = parseHyperVVirtualSwitchId("11111111-2222-3333-4444-555555555555");
const virtualMachineId = parseHyperVVirtualMachineId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
const natName = parseHyperVNatName("CCCDeviceLab-0123456789abcdef01234567");
const natInstanceId = parseHyperVNatInstanceId("ccc-network-instance-1");
const interfaceIndex = parseHyperVInterfaceIndex(42);
const address = parseIPv4Address("172.29.0.1");
const prefixLength = parseIPv4PrefixLength(24);
const cidr = parseIPv4Cidr("172.29.0.0/24");

const spec = createHyperVHostNetworkSpec({
    switchName,
    natName,
    cidr: "172.29.0.0/24",
    gateway: "172.29.0.1",
});

declare const client: HyperVWindowsNetworkClient;

function acceptCleanupProvenance(_value: HyperVHostNetworkCleanupProvenance): void {}

function handleEveryOutcome(outcome: HyperVHostNetworkReconciliationOutcome): string {
    switch (outcome.kind) {
        case "settled": return "settled";
        case "conflict": return "conflict";
        case "needs-administrator": return "needs-administrator";
        case "execute": return "execute";
        case "indeterminate": return "indeterminate";
    }
}

function rejectIncompleteHandling(outcome: HyperVHostNetworkReconciliationOutcome): string {
    switch (outcome.kind) {
        case "settled": return "settled";
        case "conflict": return "conflict";
        case "needs-administrator": return "needs-administrator";
        case "execute": return "execute";
        default: {
            // @ts-expect-error indeterminate remains, so this branch is deliberately not exhaustive
            const missing: never = outcome;
            return missing;
        }
    }
}

if (false) {
    void client.removeVMSwitch({ identity: { id: switchId, name: switchName } });
    void client.removeNetNat({ identity: { instanceId: natInstanceId, name: natName } });
    void client.createNetIPAddress({ interfaceIndex, address, prefixLength });

    // @ts-expect-error raw strings cannot cross the switch mutation boundary
    void client.removeVMSwitch({ identity: { id: "11111111-2222-3333-4444-555555555555", name: switchName } });

    // @ts-expect-error a NAT instance id is not a virtual-switch id
    void client.removeVMSwitch({ identity: { id: natInstanceId, name: switchName } });

    // @ts-expect-error a VM id is not a virtual-switch id
    void client.removeVMSwitch({ identity: { id: virtualMachineId, name: switchName } });

    // @ts-expect-error a NAT name is not a virtual-switch name
    void client.removeVMSwitch({ identity: { id: switchId, name: natName } });

    // @ts-expect-error an IPv4 address is not an interface index
    void client.createNetIPAddress({ interfaceIndex: address, address, prefixLength });

    // @ts-expect-error a parsed CIDR aggregate is not an IPv4 address
    void client.createNetIPAddress({ interfaceIndex, address: cidr, prefixLength });

    acceptCleanupProvenance({
        // @ts-expect-error managed cleanup evidence must carry an exact identity
        switch: { kind: "managed" },
        gateway: { kind: "unmanaged" },
        nat: { kind: "unmanaged" },
    });
}

void spec;
void handleEveryOutcome;
void rejectIncompleteHandling;
