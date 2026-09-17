import { describe, expect, it } from "vitest";

import {
    confirmHyperVBootstrapContainment,
    discoverHyperVBootstrapAddresses,
    planHyperVBootstrapTeardown,
    selectHyperVBootstrapAddresses,
} from "../hyper-v-windows/lifecycle/vm-network-reconcile.js";
import type {
    HyperVBootstrapAdapterExpectation,
    HyperVBootstrapHostObservation,
} from "../hyper-v-windows/lifecycle/vm-network-contracts.js";
import {
    parseHyperVInterfaceIndex,
    parseHyperVMacAddress,
    parseIPv4Address,
    parseIPv4PrefixLength,
    type HyperVMacAddress,
    type HyperVNetIPAddress,
    type HyperVNetNeighbor,
    type HyperVVMNetworkAdapter,
} from "../hyper-v-windows/low-level/index.js";

const BOOTSTRAP_MAC = parseHyperVMacAddress("06:15:5d:01:1a:2c");
const OTHER_MAC = parseHyperVMacAddress("06:15:5d:99:99:99");
const EXPECTATION: HyperVBootstrapAdapterExpectation = {
    adapterName: "CCC Bootstrap DHCP",
    switchName: "Default Switch",
    managementInterfaceAlias: "vEthernet (Default Switch)",
};

function adapter(overrides: Partial<HyperVVMNetworkAdapter> = {}): HyperVVMNetworkAdapter {
    return {
        vmId: null,
        vmName: "ccc-device",
        name: "CCC Bootstrap DHCP",
        switchId: null,
        switchName: "Default Switch",
        status: "Ok",
        managementOperatingSystem: false,
        macAddress: BOOTSTRAP_MAC,
        ipAddresses: [],
        ...overrides,
    };
}

function hostAddress(address: string, prefixLength: number, interfaceIndex = 12, interfaceAlias = ""): HyperVNetIPAddress {
    return {
        interfaceIndex: parseHyperVInterfaceIndex(interfaceIndex),
        address: parseIPv4Address(address),
        prefixLength: parseIPv4PrefixLength(prefixLength),
        prefixOrigin: "Dhcp",
        suffixOrigin: "Dhcp",
        addressState: "Preferred",
        interfaceAlias,
    };
}

function neighbor(address: string, linkLayerAddress: HyperVMacAddress | null, interfaceIndex = 12, state = "Reachable"): HyperVNetNeighbor {
    return {
        interfaceIndex: parseHyperVInterfaceIndex(interfaceIndex),
        address: parseIPv4Address(address),
        linkLayerAddress,
        state,
    };
}

function observation(overrides: Partial<HyperVBootstrapHostObservation> = {}): HyperVBootstrapHostObservation {
    return {
        vmAdapters: [adapter()],
        managementAdapters: [adapter({ managementOperatingSystem: true, ipAddresses: ["172.20.0.1"] })],
        hostIPv4Addresses: [hostAddress("172.20.0.1", 20)],
        neighbors: [],
        ...overrides,
    };
}

// The selection rules below were the contract of Select-CccBootstrapIpv4Address and
// Test-CccSameIpv4Prefix in Ccc.HyperV.Linux.psm1, whose only prior coverage was an asset
// hash. Each row states a rule that the PowerShell enforced and this port must keep.
describe("bootstrap address selection", () => {
    const hostPrefixes = [{
        octets: [172, 20, 0, 1] as const,
        address: "172.20.0.1",
        prefixLength: parseIPv4PrefixLength(20),
        interfaceIndex: 12,
    }];

    it.each([
        ["keeps an address on the host's network", ["172.20.0.9"], ["172.20.0.9"]],
        ["drops an address outside the host's prefix", ["10.1.2.3"], []],
        ["drops the host's own address", ["172.20.0.1"], []],
        ["drops a malformed address", ["172.20.0"], []],
        ["deduplicates repeats", ["172.20.0.9", "172.20.0.9"], ["172.20.0.9"]],
        ["orders results independently of input order", ["172.20.0.9", "172.20.0.3"], ["172.20.0.3", "172.20.0.9"]],
        ["keeps an address that shares only the partial prefix byte", ["172.20.15.7"], ["172.20.15.7"]],
        // /20 covers 172.20.0.0-172.20.15.255, so this one is outside it by one byte.
        ["drops an address just outside the partial prefix byte", ["172.20.16.7"], []],
    ])("%s", (_label, candidates, expected) => {
        expect(selectHyperVBootstrapAddresses(candidates, hostPrefixes)).toEqual(expected);
    });

    // These three must be dropped by the exclusion rule itself, so each is paired with a host
    // prefix that would otherwise match it. The link-local case is the one that actually
    // happens: while DHCP is still coming up both the guest and the host sit on 169.254/16,
    // so the prefix check alone would accept the guest's address and report a booting guest
    // as reachable at an address nothing can route to.
    it.each([
        ["the unspecified range", "0.0.0.9", "0.0.0.1", 8],
        ["loopback", "127.0.0.9", "127.0.0.1", 8],
        ["link-local", "169.254.1.2", "169.254.0.1", 16],
    ])("drops %s even when the host itself is on that network", (_label, candidate, hostAddressText, prefixLength) => {
        const octets = hostAddressText.split(".").map(Number);
        expect(selectHyperVBootstrapAddresses([candidate], [{
            octets,
            address: hostAddressText,
            prefixLength: parseIPv4PrefixLength(prefixLength),
            interfaceIndex: 12,
        }])).toEqual([]);
    });

    it("caps the result at eight addresses", () => {
        const candidates = Array.from({ length: 20 }, (_value, index) => `172.20.0.${index + 2}`);
        expect(selectHyperVBootstrapAddresses(candidates, hostPrefixes)).toHaveLength(8);
    });

    // The PowerShell threw here -- [Net.IPAddress]::Parse rejects an octet above 255 -- and
    // the throw failed the whole discovery pass, losing the good addresses with the bad one.
    it("skips an out-of-range octet instead of losing the whole answer", () => {
        expect(selectHyperVBootstrapAddresses(["999.20.0.9", "172.20.0.9"], hostPrefixes)).toEqual(["172.20.0.9"]);
    });
});

describe("bootstrap address discovery", () => {
    it("reports the guest's own address when it has one", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({ vmAdapters: [adapter({ ipAddresses: ["172.20.0.9"] })] }),
            EXPECTATION,
        )).toEqual({ addresses: ["172.20.0.9"], diagnosticCode: null });
    });

    // The two sources answer at different times: the neighbour table learns the address from
    // traffic before integration services are up to report it, so a discovery that used only
    // the guest's own report would not find a guest that is already reachable.
    it("reports an address the host learned by neighbour discovery alone", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({ neighbors: [neighbor("172.20.0.9", BOOTSTRAP_MAC)] }),
            EXPECTATION,
        )).toEqual({ addresses: ["172.20.0.9"], diagnosticCode: null });
    });

    it("ignores a neighbour entry belonging to a different adapter", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({ neighbors: [neighbor("172.20.0.9", OTHER_MAC)] }),
            EXPECTATION,
        )).toEqual({ addresses: [], diagnosticCode: null });
    });

    // The same address on a different interface is a different network, where it may belong
    // to something else entirely.
    it("ignores a neighbour entry learned on an unrelated interface", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({ neighbors: [neighbor("172.20.0.9", BOOTSTRAP_MAC, 99)] }),
            EXPECTATION,
        )).toEqual({ addresses: [], diagnosticCode: null });
    });

    it("merges both sources without reporting the shared address twice", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({
                vmAdapters: [adapter({ ipAddresses: ["172.20.0.9"] })],
                neighbors: [neighbor("172.20.0.9", BOOTSTRAP_MAC), neighbor("172.20.0.3", BOOTSTRAP_MAC)],
            }),
            EXPECTATION,
        )).toEqual({ addresses: ["172.20.0.3", "172.20.0.9"], diagnosticCode: null });
    });

    // A guest that is still booting has an adapter and no address. That is the ordinary state
    // of every device create, so it must not be reported as a failure.
    it("reports no addresses and no failure while the guest is still booting", () => {
        expect(discoverHyperVBootstrapAddresses(observation(), EXPECTATION))
            .toEqual({ addresses: [], diagnosticCode: null });
    });

    it("reports no addresses and no failure once the adapter has been torn down", () => {
        expect(discoverHyperVBootstrapAddresses(observation({ vmAdapters: [] }), EXPECTATION))
            .toEqual({ addresses: [], diagnosticCode: null });
    });

    it.each([
        [
            "two adapters answer to the bootstrap name",
            { vmAdapters: [adapter(), adapter()] },
            "hyper-v-bootstrap-network-adapter-ambiguous",
        ],
        [
            "the adapter sits on an unexpected switch",
            { vmAdapters: [adapter({ switchName: "ccc-internal" })] },
            "hyper-v-bootstrap-network-adapter-identity-mismatch",
        ],
        [
            "the host has no address on the bootstrap network",
            { managementAdapters: [], hostIPv4Addresses: [] },
            "hyper-v-bootstrap-host-prefix-inspection-failed",
        ],
    ])("declines when %s", (_label, overrides, diagnosticCode) => {
        expect(discoverHyperVBootstrapAddresses(observation(overrides), EXPECTATION))
            .toEqual({ addresses: [], diagnosticCode });
    });

    // The management adapter read is not always available. The host's own interface alias
    // names the same interface, and without that route discovery would fail outright rather
    // than degrade -- which is what the PowerShell being replaced already avoided.
    it("still finds the host network by interface alias when the management read is empty", () => {
        expect(discoverHyperVBootstrapAddresses(
            observation({
                vmAdapters: [adapter({ ipAddresses: ["172.20.0.9"] })],
                managementAdapters: [],
                hostIPv4Addresses: [hostAddress("172.20.0.1", 20, 12, "vEthernet (Default Switch)")],
            }),
            EXPECTATION,
        )).toEqual({ addresses: ["172.20.0.9"], diagnosticCode: null });
    });
});

describe("bootstrap teardown planning", () => {
    it("names the exact identity to remove when everything agrees", () => {
        expect(planHyperVBootstrapTeardown(observation(), EXPECTATION, BOOTSTRAP_MAC)).toEqual({
            kind: "remove",
            adapterName: "CCC Bootstrap DHCP",
            macAddress: BOOTSTRAP_MAC,
        });
    });

    // Teardown runs after the guest is finalized and must be safe to repeat, including after
    // a crash between the removal and the record of it.
    it.each([
        ["the adapter is already gone", { vmAdapters: [] }],
        ["only an adapter with a different address remains", { vmAdapters: [adapter({ macAddress: OTHER_MAC })] }],
        ["the remaining adapter has no address at all", { vmAdapters: [adapter({ macAddress: null })] }],
        ["only an adapter with a different name remains", { vmAdapters: [adapter({ name: "CCC Device Network" })] }],
    ])("removes nothing when %s", (_label, overrides) => {
        expect(planHyperVBootstrapTeardown(observation(overrides), EXPECTATION, BOOTSTRAP_MAC))
            .toEqual({ kind: "already-absent" });
    });

    it.each([
        [
            "two adapters carry the same name and address",
            { vmAdapters: [adapter(), adapter()] },
            "hyper-v-bootstrap-network-adapter-ambiguous",
        ],
        [
            "the adapter sits on an unexpected switch",
            { vmAdapters: [adapter({ switchName: "ccc-internal" })] },
            "hyper-v-bootstrap-network-adapter-identity-mismatch",
        ],
    ])("refuses rather than guessing when %s", (_label, overrides, diagnosticCode) => {
        expect(planHyperVBootstrapTeardown(observation(overrides), EXPECTATION, BOOTSTRAP_MAC))
            .toEqual({ kind: "refuse", diagnosticCode });
    });
});

describe("bootstrap containment", () => {
    it("confirms the address is free once nothing carries it", () => {
        expect(confirmHyperVBootstrapContainment([adapter({ macAddress: OTHER_MAC })], BOOTSTRAP_MAC))
            .toEqual({ kind: "contained" });
    });

    // Checked host-wide, not per VM: the point is that the next device deriving this same
    // address will not collide with something still holding it.
    it("reports a breach when another VM still carries the address", () => {
        expect(confirmHyperVBootstrapContainment(
            [adapter({ vmName: "some-other-vm", name: "Network Adapter" })],
            BOOTSTRAP_MAC,
        )).toEqual({ kind: "breached", diagnosticCode: "hyper-v-bootstrap-network-containment-failed" });
    });
});
