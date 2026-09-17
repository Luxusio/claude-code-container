import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVHostNetworkSpec,
    createHyperVWindowsNetworkClient,
    HyperVWindowsError,
    HyperVWindowsNetworkValueError,
    hyperVMacAddressColonForm,
    hyperVMacAddressNativeHex,
    parseHyperVInterfaceIndex,
    parseHyperVMacAddress,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVNetworkAdapterName,
    parseHyperVVirtualMachineName,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    parseHyperVVMNetworkAdapterName,
    parseIPv4Address,
    parseIPv4Cidr,
    parseIPv4PrefixLength,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsOperation,
} from "../hyper-v-windows/low-level/index.js";

const switchId = parseHyperVVirtualSwitchId("12345678-1234-1234-1234-123456789ABC");
const switchName = parseHyperVVirtualSwitchName("ccc-internal");
const natName = parseHyperVNatName("ccc-nat");
const natInstanceId = parseHyperVNatInstanceId("nat-instance-1");
const interfaceIndex = parseHyperVInterfaceIndex(42);
const gateway = parseIPv4Address("172.31.240.1");
const prefixLength = parseIPv4PrefixLength(24);
const cidr = parseIPv4Cidr("172.31.240.0/24");

const switchItem = {
    id: "12345678-1234-1234-1234-123456789ABC",
    name: "ccc-internal",
    switchType: "FutureInternalType",
    notes: "opaque-native-notes",
};
const addressItem = {
    interfaceIndex: 42,
    address: "172.31.240.1",
    prefixLength: 24,
    prefixOrigin: "FuturePrefixOrigin",
    suffixOrigin: "FutureSuffixOrigin",
    addressState: "FutureAddressState",
};
const natItem = {
    instanceId: "nat-instance-1",
    name: "ccc-nat",
    internalAddressPrefix: "172.31.240.0/24",
};

function response(
    operation: HyperVWindowsOperation,
    items: readonly unknown[] = [],
): HyperVWindowsExecutionResult {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    };
}

function executorUsing(
    execute: (request: HyperVWindowsExecutionRequest) => HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>,
): HyperVWindowsExecutor {
    return { execute };
}

describe("Hyper-V Windows network values", () => {
    it("constructs one canonical host-network aggregate", () => {
        expect(createHyperVHostNetworkSpec({
            switchName,
            natName,
            cidr: "172.31.240.0/24",
            gateway: "172.31.240.1",
        })).toEqual({
            switchName: "ccc-internal",
            natName: "ccc-nat",
            cidr: "172.31.240.0/24",
            networkAddress: "172.31.240.0",
            prefixLength: 24,
            gateway: "172.31.240.1",
        });
    });

    it.each([
        ["non-canonical CIDR", () => parseIPv4Cidr("172.31.240.1/24"), "ipv4-cidr-not-canonical"],
        ["invalid IPv4 octet", () => parseIPv4Address("172.31.240.999"), "ipv4-address-invalid"],
        ["unsupported host prefix", () => createHyperVHostNetworkSpec({ switchName, natName, cidr: "10.0.0.0/8", gateway: "10.0.0.1" }), "hyper-v-host-network-prefix-length-unsupported"],
        ["reserved gateway", () => createHyperVHostNetworkSpec({ switchName, natName, cidr: "172.31.240.0/24", gateway: "172.31.240.255" }), "hyper-v-host-network-gateway-reserved-or-outside-cidr"],
    ])("rejects %s with a named value error", (_label, action, code) => {
        expect(action).toThrowError(HyperVWindowsNetworkValueError);
        expect(action).toThrow(code);
    });
});

describe("Hyper-V Windows slice 2B primitives", () => {
    const adapterName = parseHyperVVMNetworkAdapterName("CCC Bootstrap DHCP");
    const bootstrapMac = parseHyperVMacAddress("06:15:5d:01:1a:2c");

    it("scopes an adapter read to one VM without changing the host-wide request", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => {
            requests.push(request);
            return response(request.operation, []);
        }));

        await client.getAllVMNetworkAdapters();
        await client.getVMNetworkAdapters({ selector: { kind: "id", id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" } });
        await client.getManagementNetworkAdapters({ managementSwitchName: parseHyperVVirtualSwitchName("Default Switch") });

        expect(requests).toEqual([
            // The host-wide read stays selector-free, so no caller can reach one VM's
            // adapters without saying which VM it means.
            { schemaVersion: 1, operation: "Get-VMNetworkAdapter" },
            { schemaVersion: 1, operation: "Get-VMNetworkAdapter", selector: { kind: "id", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } },
            { schemaVersion: 1, operation: "Get-VMNetworkAdapter", managementSwitchName: "Default Switch" },
        ]);
    });

    it("sends the neighbour read bounded to one interface", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => {
            requests.push(request);
            return response(request.operation, [{
                interfaceIndex: 42,
                address: "172.31.240.9",
                linkLayerAddress: "06-15-5D-01-1A-2C",
                state: "Reachable",
            }, {
                // An incomplete entry: a real row of the table with no usable address.
                interfaceIndex: 42,
                address: "172.31.240.10",
                linkLayerAddress: null,
                state: "Incomplete",
            }]);
        }));

        await expect(client.getNetNeighbors({ interfaceIndex })).resolves.toEqual([
            { interfaceIndex, address: "172.31.240.9", linkLayerAddress: bootstrapMac, state: "Reachable" },
            { interfaceIndex, address: "172.31.240.10", linkLayerAddress: null, state: "Incomplete" },
        ]);
        expect(requests).toEqual([{ schemaVersion: 1, operation: "Get-NetNeighbor", interfaceIndex: 42 }]);
    });

    it("names the VM, the adapter and the address on every removal", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => {
            requests.push(request);
            return response(request.operation, []);
        }));

        await client.removeVMNetworkAdapter({
            selector: { kind: "id", id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
            adapterName,
            macAddress: bootstrapMac,
        });

        // All three travel together. The native side re-resolves from them and refuses
        // unless they identify exactly one adapter, so a request that dropped any one of
        // them would be asking the host to guess.
        expect(requests).toEqual([{
            schemaVersion: 1,
            operation: "Remove-VMNetworkAdapter",
            selector: { kind: "id", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
            adapterName: "CCC Bootstrap DHCP",
            macAddress: "06155d011a2c",
        }]);
    });

    it.each([
        ["a missing selector", { adapterName, macAddress: bootstrapMac }],
        ["an unknown selector kind", { selector: { kind: "mac" }, adapterName, macAddress: bootstrapMac }],
        ["a malformed VM id", { selector: { kind: "id", id: "not-a-guid" }, adapterName, macAddress: bootstrapMac }],
        ["no adapter name", { selector: { kind: "id", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, macAddress: bootstrapMac }],
        ["no MAC address", { selector: { kind: "id", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, adapterName }],
        ["an extra field", { selector: { kind: "id", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, adapterName, macAddress: bootstrapMac, force: true }],
    ])("refuses a removal with %s before invoking the executor", async (_label, request) => {
        const execute = vi.fn(() => response("Remove-VMNetworkAdapter"));
        const client = createHyperVWindowsNetworkClient(executorUsing(execute));

        await expect(
            client.removeVMNetworkAdapter(request as never),
        ).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe("Hyper-V Windows MAC address value", () => {
    // Every spelling below is one native cmdlet's or one ccc record's idea of the same
    // address. They must land on one value, because destructive adapter selection compares
    // these and a spelling that compared unequal would silently match no adapter.
    it.each([
        ["Get-VMNetworkAdapter bare uppercase hex", "00155D011A2C"],
        ["bare lowercase hex", "00155d011a2c"],
        ["Get-NetNeighbor hyphen groups", "00-15-5D-01-1A-2C"],
        ["ccc colon form", "00:15:5d:01:1a:2c"],
        ["mixed case colon form", "00:15:5D:01:1a:2C"],
    ])("parses %s to the same canonical value", (_label, spelling) => {
        expect(parseHyperVMacAddress(spelling)).toBe(parseHyperVMacAddress("00155D011A2C"));
    });

    it("renders both external spellings from the canonical value", () => {
        const mac = parseHyperVMacAddress("00-15-5D-01-1A-2C");
        expect(hyperVMacAddressNativeHex(mac)).toBe("00155D011A2C");
        expect(hyperVMacAddressColonForm(mac)).toBe("00:15:5d:01:1a:2c");
    });

    it("round-trips every rendering back to the same value", () => {
        const mac = parseHyperVMacAddress("02:15:5d:01:1a:2c");
        expect(parseHyperVMacAddress(hyperVMacAddressNativeHex(mac))).toBe(mac);
        expect(parseHyperVMacAddress(hyperVMacAddressColonForm(mac))).toBe(mac);
    });

    it.each([
        ["too short", "00155D011A2", "hyper-v-mac-address-invalid"],
        ["too long", "00155D011A2CF", "hyper-v-mac-address-invalid"],
        ["non-hex", "00155D011AZZ", "hyper-v-mac-address-invalid"],
        ["empty", "", "hyper-v-mac-address-invalid"],
        ["wrong group count", "0015:5D01:1A2C", "hyper-v-mac-address-invalid"],
        ["mixed separators", "00-15:5D-01-1A-2C", "hyper-v-mac-address-invalid"],
        ["trailing separator", "00:15:5d:01:1a:2c:", "hyper-v-mac-address-invalid"],
        ["embedded whitespace", "00 15 5D 01 1A 2C", "hyper-v-mac-address-invalid"],
        // Hyper-V reports this for an adapter whose dynamic address is not yet assigned.
        // It must never become a value that a removal could match against.
        ["unassigned all-zero address", "000000000000", "hyper-v-mac-address-unassigned"],
    ])("rejects %s with a named value error", (_label, spelling, code) => {
        const action = () => parseHyperVMacAddress(spelling);
        expect(action).toThrowError(HyperVWindowsNetworkValueError);
        expect(action).toThrow(code);
    });
});

describe("Hyper-V Windows network low-level client", () => {
    it("maps each method to one operation-specific request without fake VM selectors", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const executor = executorUsing((request) => {
            requests.push(request);
            const items = request.operation === "New-VMSwitch" ? [switchItem]
                : request.operation === "New-NetIPAddress" ? [addressItem]
                    : request.operation === "New-NetNat" ? [natItem]
                        : [];
            return response(request.operation, items);
        });
        const client = createHyperVWindowsNetworkClient(executor);

        await client.getVMSwitches({ kind: "all" });
        await client.createVMSwitch({ name: switchName, notes: "marker" });
        await client.setVMSwitchNotes({ identity: { id: switchId, name: switchName }, notes: "repaired" });
        await client.removeVMSwitch({ identity: { id: switchId, name: switchName } });
        await client.getAllVMNetworkAdapters();
        await client.getVMsByExactNames({ names: [parseHyperVVirtualMachineName("vm-a")] });
        await client.getHostNetworkAdapters({ name: parseHyperVNetworkAdapterName("vEthernet (ccc-internal)") });
        await client.getNetIPAddresses({ kind: "all-ipv4" });
        await client.createNetIPAddress({ interfaceIndex, address: gateway, prefixLength });
        await client.removeNetIPAddress({ interfaceIndex, address: gateway, prefixLength });
        await client.getNetNats({ kind: "all" });
        await client.createNetNat({ name: natName, internalAddressPrefix: cidr });
        await client.removeNetNat({ identity: { instanceId: natInstanceId, name: natName } });

        expect(requests).toEqual([
            { schemaVersion: 1, operation: "Get-VMSwitch", selector: { kind: "all" } },
            { schemaVersion: 1, operation: "New-VMSwitch", name: "ccc-internal", notes: "marker" },
            { schemaVersion: 1, operation: "Set-VMSwitch", identity: { id: switchId, name: switchName }, notes: "repaired" },
            { schemaVersion: 1, operation: "Remove-VMSwitch", identity: { id: switchId, name: switchName } },
            { schemaVersion: 1, operation: "Get-VMNetworkAdapter" },
            { schemaVersion: 1, operation: "Get-VM", names: ["vm-a"] },
            { schemaVersion: 1, operation: "Get-NetAdapter", name: "vEthernet (ccc-internal)" },
            { schemaVersion: 1, operation: "Get-NetIPAddress", selector: { kind: "all-ipv4" } },
            { schemaVersion: 1, operation: "New-NetIPAddress", interfaceIndex: 42, address: "172.31.240.1", prefixLength: 24 },
            { schemaVersion: 1, operation: "Remove-NetIPAddress", interfaceIndex: 42, address: "172.31.240.1", prefixLength: 24 },
            { schemaVersion: 1, operation: "Get-NetNat", selector: { kind: "all" } },
            { schemaVersion: 1, operation: "New-NetNat", name: "ccc-nat", internalAddressPrefix: "172.31.240.0/24" },
            { schemaVersion: 1, operation: "Remove-NetNat", identity: { instanceId: "nat-instance-1", name: "ccc-nat" } },
        ]);
        for (const request of requests.slice(1)) {
            if (request.operation !== "Get-VM") expect(request).not.toHaveProperty("selector.kind", "id");
        }
    });

    it("strictly decodes bounded native records while preserving unknown strings", async () => {
        const outputs = new Map<HyperVWindowsOperation, readonly unknown[]>([
            ["Get-VMSwitch", [switchItem]],
            ["Get-VMNetworkAdapter", [{
                vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                vmName: "vm-a",
                name: "Network Adapter",
                switchId: switchItem.id,
                switchName: switchItem.name,
                status: "FutureStatus",
                managementOperatingSystem: false,
                macAddress: "00155D011A2C",
                ipAddresses: ["172.31.240.9", "fe80::1"],
            }]],
            ["Get-VM", [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "vm-a", notes: "opaque" }]],
            ["Get-NetAdapter", [{ interfaceIndex: 42, name: "vEthernet (ccc-internal)", status: "FutureStatus", interfaceDescription: "FutureDescription" }]],
            ["Get-NetIPAddress", [addressItem]],
            ["Get-NetNat", [natItem]],
        ]);
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => response(
            request.operation,
            outputs.get(request.operation) ?? [],
        )));

        await expect(client.getVMSwitches({ kind: "name", name: switchName })).resolves.toEqual([{
            ...switchItem,
            id: switchId,
        }]);
        await expect(client.getAllVMNetworkAdapters()).resolves.toEqual([
            expect.objectContaining({
                status: "FutureStatus",
                switchId,
                macAddress: parseHyperVMacAddress("00155D011A2C"),
                // Both families survive decoding unchanged: which one matters is a
                // reconciliation decision, not a decoding one.
                ipAddresses: ["172.31.240.9", "fe80::1"],
            }),
        ]);
        await expect(client.getVMsByExactNames({ names: [parseHyperVVirtualMachineName("vm-a")] })).resolves.toEqual([
            { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "vm-a", notes: "opaque" },
        ]);
        await expect(client.getHostNetworkAdapters({ name: parseHyperVNetworkAdapterName("vEthernet (ccc-internal)") })).resolves.toEqual([
            expect.objectContaining({ interfaceIndex, status: "FutureStatus" }),
        ]);
        await expect(client.getNetIPAddresses({ kind: "interface", interfaceIndex })).resolves.toEqual([
            expect.objectContaining({ address: gateway, prefixOrigin: "FuturePrefixOrigin" }),
        ]);
        await expect(client.getNetNats({ kind: "name", name: natName })).resolves.toEqual([natItem]);
    });

    // A VM adapter with no usable address is still a real adapter, and host-wide inventory
    // has to keep reporting it -- dropping the record would hide an adapter that is holding
    // a switch in use. Absent is the safe representation because no identity comparison can
    // match it, which is what keeps a removal from selecting an adapter by accident.
    it.each([
        ["not yet assigned by the host", "000000000000"],
        ["unparseable", "not-a-mac"],
        ["reported as absent", null],
    ])("decodes a VM adapter whose MAC is %s without dropping the adapter", async (_label, macAddress) => {
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => response(request.operation, [{
            vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            vmName: "vm-a",
            name: "Network Adapter",
            switchId: switchItem.id,
            switchName: switchItem.name,
            status: "Ok",
            managementOperatingSystem: false,
            macAddress,
            ipAddresses: [],
        }])));

        await expect(client.getAllVMNetworkAdapters()).resolves.toEqual([
            expect.objectContaining({ name: "Network Adapter", macAddress: null }),
        ]);
    });

    it("rejects invalid runtime input before invoking the executor", async () => {
        const execute = vi.fn(() => response("Get-VMSwitch"));
        const client = createHyperVWindowsNetworkClient(executorUsing(execute));

        await expect(client.getVMsByExactNames({ names: [
            parseHyperVVirtualMachineName("duplicate"),
            parseHyperVVirtualMachineName("duplicate"),
        ] })).rejects.toMatchObject({ category: "validation", code: "inventory-names-duplicate" });
        await expect(client.createVMSwitch({
            name: switchName,
            notes: "x\u0000",
        })).rejects.toMatchObject({ category: "validation", operation: "New-VMSwitch", code: "notes-invalid" });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong operation", response("Get-NetNat", [switchItem]), "response-envelope-invalid"],
        ["wrong schema", { status: 0, stdout: JSON.stringify({ schemaVersion: 2, operation: "Get-VMSwitch", ok: true, items: [] }) }, "response-envelope-invalid"],
        ["missing key", { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMSwitch", ok: true }) }, "response-envelope-invalid"],
        ["malformed JSON", { status: 0, stdout: "{" }, "response-malformed"],
        ["extra item key", response("Get-VMSwitch", [{ ...switchItem, extra: true }]), "result-shape-invalid"],
        ["invalid native range", response("Get-VMSwitch", [{ ...switchItem, id: "not-a-guid" }]), "result-shape-invalid"],
        ["status/envelope conflict", { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMSwitch", ok: true, items: [] }) }, "response-status-conflict"],
        ["oversized", { status: 0, stdout: "x".repeat(65 * 1024) }, "response-too-large"],
    ] as const)("fails closed on %s", async (_label, execution, code) => {
        const client = createHyperVWindowsNetworkClient(executorUsing(() => execution));
        const caught = await client.getVMSwitches({ kind: "all" }).catch((failure: unknown) => failure);

        expect(caught).toBeInstanceOf(HyperVWindowsError);
        expect(caught).toMatchObject({ category: "protocol", operation: "Get-VMSwitch", code });
    });

    it("preserves bounded native failures and closes executor failure modes", async () => {
        const native = createHyperVWindowsNetworkClient(executorUsing(() => ({
            status: 5,
            stdout: JSON.stringify({
                schemaVersion: 1,
                operation: "Get-VMSwitch",
                ok: false,
                errorCode: "PermissionDenied",
            }),
        })));
        await expect(native.getVMSwitches({ kind: "all" })).rejects.toMatchObject({
            category: "native",
            code: "PermissionDenied",
            nativeStatus: 5,
        });

        const thrown = createHyperVWindowsNetworkClient(executorUsing(() => {
            throw new Error("host path and secret must not escape");
        }));
        await expect(thrown.getVMSwitches({ kind: "all" })).rejects.toMatchObject({
            category: "transport",
            code: "executor-failed",
        });

        for (const [execution, code] of [
            [{ status: null, stdout: "", timedOut: true }, "timeout"],
            [{ status: null, stdout: "", cancelled: true }, "cancelled"],
        ] as const) {
            const client = createHyperVWindowsNetworkClient(executorUsing(() => execution));
            await expect(client.getVMSwitches({ kind: "all" })).rejects.toMatchObject({
                category: "transport",
                code,
            });
        }
    });

    it.each([
        ["switch", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.createVMSwitch({ name: switchName, notes: "marker" })],
        ["gateway", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.createNetIPAddress({ interfaceIndex, address: gateway, prefixLength })],
        ["NAT", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.createNetNat({ name: natName, internalAddressPrefix: cidr })],
    ])("requires exactly one %s create result", async (_label, invoke) => {
        for (const itemCount of [0, 2]) {
            const client = createHyperVWindowsNetworkClient(executorUsing((request) => response(
                request.operation,
                request.operation === "New-VMSwitch" ? Array(itemCount).fill(switchItem)
                    : request.operation === "New-NetIPAddress" ? Array(itemCount).fill(addressItem)
                        : Array(itemCount).fill(natItem),
            )));
            await expect(invoke(client)).rejects.toMatchObject({
                category: "protocol",
                code: "result-ambiguous",
            });
        }
    });

    it.each([
        ["switch", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.removeVMSwitch({ identity: { id: switchId, name: switchName } })],
        ["gateway", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.removeNetIPAddress({ interfaceIndex, address: gateway, prefixLength })],
        ["NAT", (client: ReturnType<typeof createHyperVWindowsNetworkClient>) => client.removeNetNat({ identity: { instanceId: natInstanceId, name: natName } })],
    ])("requires an empty %s removal result", async (_label, invoke) => {
        const client = createHyperVWindowsNetworkClient(executorUsing((request) => response(request.operation, [{}])));
        await expect(invoke(client)).rejects.toMatchObject({
            category: "protocol",
            code: "result-ambiguous",
        });
    });

    it("rejects unrequested and duplicate exact-name inventory observations", async () => {
        const name = parseHyperVVirtualMachineName("vm-a");
        const unrequested = createHyperVWindowsNetworkClient(executorUsing(() => response("Get-VM", [
            { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "vm-b", notes: "" },
        ])));
        await expect(unrequested.getVMsByExactNames({ names: [name] })).rejects.toMatchObject({
            category: "protocol",
            code: "inventory-result-unrequested",
        });

        const duplicate = createHyperVWindowsNetworkClient(executorUsing(() => response("Get-VM", [
            { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "vm-a", notes: "" },
            { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "vm-a", notes: "" },
        ])));
        await expect(duplicate.getVMsByExactNames({ names: [name] })).rejects.toMatchObject({
            category: "protocol",
            code: "inventory-result-duplicate",
        });
    });

    it("forwards only bounded elevation transport codes", async () => {
        const cancelled = createHyperVWindowsNetworkClient(executorUsing(() => ({
            status: null,
            stdout: "",
            error: "hyper-v-network-elevation-cancelled",
        })));
        await expect(cancelled.createVMSwitch({ name: switchName, notes: "marker" })).rejects.toMatchObject({
            category: "transport",
            code: "hyper-v-network-elevation-cancelled",
        });

        const arbitrary = createHyperVWindowsNetworkClient(executorUsing(() => ({
            status: null,
            stdout: "",
            error: "attacker-controlled-error",
        })));
        await expect(arbitrary.createVMSwitch({ name: switchName, notes: "marker" })).rejects.toMatchObject({
            category: "transport",
            code: "executor-failed",
        });

        // Session codes are a closed exported union, so they pass through and name the failure
        // that the real-host proof would otherwise report only as `executor-failed`.
        const sessionTimeout = createHyperVWindowsNetworkClient(executorUsing(() => ({
            status: null,
            stdout: "",
            error: "hyper-v-windows-session-timeout",
        })));
        await expect(sessionTimeout.getVMSwitches({ kind: "all" })).rejects.toMatchObject({
            category: "transport",
            code: "hyper-v-windows-session-timeout",
        });
    });
});

describe("Hyper-V Windows network PowerShell asset", () => {
    it("loads networking modules only from protected System32 roots and qualifies every network cmdlet", () => {
        const source = readFileSync(join(
            process.cwd(),
            "scripts",
            "host-control",
            "hyper-v",
            "Invoke-HyperVWindowsOperation.ps1",
        ), "utf8");

        expect(source).toContain('[Environment]::SystemDirectory');
        expect(source).toContain('@("WindowsPowerShell", "v1.0", "Modules")');
        expect(source).toContain('[IO.FileAttributes]::ReparsePoint');
        expect(source).toContain('$ModuleName -notin @("Hyper-V", "NetAdapter", "NetTCPIP", "NetNat")');
        expect(source).toContain('Import-HyperVWindowsTrustedModule "NetAdapter"');
        expect(source).toContain('Import-HyperVWindowsTrustedModule "NetTCPIP"');
        expect(source).toContain('Import-HyperVWindowsTrustedModule "NetNat"');

        for (const qualifiedCommand of [
            "Hyper-V\\Get-VMSwitch",
            "Hyper-V\\Get-VM -Name $RequestedNames",
            "Hyper-V\\New-VMSwitch",
            "Hyper-V\\Set-VMSwitch",
            "Hyper-V\\Remove-VMSwitch",
            "Hyper-V\\Get-VMNetworkAdapter -All",
            "NetAdapter\\Get-NetAdapter",
            "NetTCPIP\\Get-NetIPAddress",
            "NetTCPIP\\New-NetIPAddress",
            "NetTCPIP\\Remove-NetIPAddress",
            "NetNat\\Get-NetNat",
            "NetNat\\New-NetNat",
            "NetNat\\Remove-NetNat",
        ]) {
            expect(source).toContain(qualifiedCommand);
        }
        expect(source).not.toContain("Import-Module NetAdapter");
        expect(source).not.toContain("Import-Module NetTCPIP");
        expect(source).not.toContain("Import-Module NetNat");

        // New-NetIPAddress emits the created address once per policy store; ambiguity is more
        // than one distinct identity, and the ActiveStore object is the one reported.
        expect(source).not.toContain('if ($Created.Count -ne 1) { throw "net-ip-address-create-result-ambiguous" }');
        expect(source).toContain('if ($Created.Count -lt 1 -or $CreatedIdentities.Count -ne 1) { throw "net-ip-address-create-result-ambiguous" }');
        expect(source).toContain('Where-Object { [string]$_.Store -eq "ActiveStore" }');
        expect(source).toContain("-ErrorVariable +QueryErrors");
        expect(source).toContain('$QueryError.CategoryInfo.Category -ne "ObjectNotFound"');
        expect(source).toContain('"ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM"');
        expect(source).toContain('$RequestedNames -cnotcontains $MissingVmTarget');
    });
});
