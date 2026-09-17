import type { HyperVVirtualMachineSelector, HyperVWindowsCallOptions } from "./contracts.js";

const virtualSwitchIdBrand: unique symbol = Symbol("HyperVVirtualSwitchId");
const virtualSwitchNameBrand: unique symbol = Symbol("HyperVVirtualSwitchName");
const natInstanceIdBrand: unique symbol = Symbol("HyperVNatInstanceId");
const natNameBrand: unique symbol = Symbol("HyperVNatName");
const interfaceIndexBrand: unique symbol = Symbol("HyperVInterfaceIndex");
const ipv4AddressBrand: unique symbol = Symbol("IPv4Address");
const ipv4CidrBrand: unique symbol = Symbol("IPv4Cidr");
const ipv4PrefixLengthBrand: unique symbol = Symbol("IPv4PrefixLength");
const virtualMachineNameBrand: unique symbol = Symbol("HyperVVirtualMachineName");
const virtualMachineIdBrand: unique symbol = Symbol("HyperVVirtualMachineId");
const networkAdapterNameBrand: unique symbol = Symbol("HyperVNetworkAdapterName");
const vmNetworkAdapterNameBrand: unique symbol = Symbol("HyperVVMNetworkAdapterName");
const macAddressBrand: unique symbol = Symbol("HyperVMacAddress");

type Opaque<Value, Token extends symbol> = Value & { readonly [Key in Token]: true };

export type HyperVVirtualSwitchId = Opaque<string, typeof virtualSwitchIdBrand>;
export type HyperVVirtualSwitchName = Opaque<string, typeof virtualSwitchNameBrand>;
export type HyperVNatInstanceId = Opaque<string, typeof natInstanceIdBrand>;
export type HyperVNatName = Opaque<string, typeof natNameBrand>;
export type HyperVInterfaceIndex = Opaque<number, typeof interfaceIndexBrand>;
export type IPv4Address = Opaque<string, typeof ipv4AddressBrand>;
export type IPv4Cidr = Opaque<string, typeof ipv4CidrBrand>;
export type IPv4PrefixLength = Opaque<number, typeof ipv4PrefixLengthBrand>;
export type HyperVVirtualMachineName = Opaque<string, typeof virtualMachineNameBrand>;
export type HyperVVirtualMachineId = Opaque<string, typeof virtualMachineIdBrand>;
export type HyperVNetworkAdapterName = Opaque<string, typeof networkAdapterNameBrand>;

// A VM's adapter name and a host adapter's name live in different namespaces and address
// different things; only one of them can name a target for Remove-VMNetworkAdapter. They are
// deliberately not assignable to each other. Note this brands the name a caller *commands*
// with. The name native *reports* on a decoded adapter stays an opaque string, because
// host-wide inventory must keep reporting adapters whose names this library would refuse.
export type HyperVVMNetworkAdapterName = Opaque<string, typeof vmNetworkAdapterNameBrand>;

// One canonical MAC value behind two external spellings. Native Hyper-V reports twelve
// uppercase hex characters; ccc carries its own as colon-separated lowercase. Reconciling
// those two by hand at each call site is how a destructive adapter removal silently selects
// the wrong adapter, so the canonical form is the only thing destructive code compares.
export type HyperVMacAddress = Opaque<string, typeof macAddressBrand>;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const IPV4_PATTERN = /^(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2})){3}$/;
const MAX_NATIVE_NAME_LENGTH = 100;
const MAX_NAT_NAME_LENGTH = 64;
const MAX_NAT_INSTANCE_ID_LENGTH = 256;

export class HyperVWindowsNetworkValueError extends TypeError {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = "HyperVWindowsNetworkValueError";
        this.code = code;
    }
}

function opaque<Value, Token extends symbol>(value: Value, _token: Token): Opaque<Value, Token> {
    return value as Opaque<Value, Token>;
}

function fail(code: string): never {
    throw new HyperVWindowsNetworkValueError(code);
}

function validNativeName(value: string, maximumLength = MAX_NATIVE_NAME_LENGTH): boolean {
    if (value.length === 0 || value.length > maximumLength) return false;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 0x20 || character === "*" || character === "?" || character === "[" || character === "]") {
            return false;
        }
    }
    return true;
}

function parseGuid(value: string, code: string): string {
    if (!GUID_PATTERN.test(value)) fail(code);
    return value.toLowerCase();
}

function ipv4Octets(value: string): readonly [number, number, number, number] | null {
    if (!IPV4_PATTERN.test(value)) return null;
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const first = parts[0];
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
    return [first, second, third, fourth];
}

function ipv4Number(value: string): number | null {
    const octets = ipv4Octets(value);
    if (!octets) return null;
    return (((octets[0] * 256) + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

function numberToIPv4(value: number): string {
    const first = Math.floor(value / 0x1000000);
    const second = Math.floor(value / 0x10000) % 0x100;
    const third = Math.floor(value / 0x100) % 0x100;
    const fourth = value % 0x100;
    return `${first}.${second}.${third}.${fourth}`;
}

export function parseHyperVVirtualSwitchId(value: string): HyperVVirtualSwitchId {
    return opaque(parseGuid(value, "hyper-v-virtual-switch-id-invalid"), virtualSwitchIdBrand);
}

export function parseHyperVVirtualSwitchName(value: string): HyperVVirtualSwitchName {
    if (!validNativeName(value, 64)) fail("hyper-v-virtual-switch-name-invalid");
    return opaque(value, virtualSwitchNameBrand);
}

export function parseHyperVNatInstanceId(value: string): HyperVNatInstanceId {
    if (value.length === 0 || value.length > MAX_NAT_INSTANCE_ID_LENGTH || /[\u0000-\u001f]/.test(value)) {
        fail("hyper-v-nat-instance-id-invalid");
    }
    return opaque(value, natInstanceIdBrand);
}

export function parseHyperVNatName(value: string): HyperVNatName {
    if (value.length === 0 || value.length > MAX_NAT_NAME_LENGTH || !NAT_NAME_PATTERN.test(value)) {
        fail("hyper-v-nat-name-invalid");
    }
    return opaque(value, natNameBrand);
}

export function parseHyperVInterfaceIndex(value: number): HyperVInterfaceIndex {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) {
        fail("hyper-v-interface-index-invalid");
    }
    return opaque(value, interfaceIndexBrand);
}

export function parseIPv4Address(value: string): IPv4Address {
    if (ipv4Number(value) === null) fail("ipv4-address-invalid");
    return opaque(value, ipv4AddressBrand);
}

export function parseIPv4PrefixLength(value: number): IPv4PrefixLength {
    if (!Number.isInteger(value) || value < 0 || value > 32) fail("ipv4-prefix-length-invalid");
    return opaque(value, ipv4PrefixLengthBrand);
}

type ParsedIPv4Cidr = {
    readonly cidr: IPv4Cidr;
    readonly networkAddress: IPv4Address;
    readonly prefixLength: IPv4PrefixLength;
};

function parseIPv4CidrParts(value: string): ParsedIPv4Cidr {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator !== value.lastIndexOf("/")) fail("ipv4-cidr-invalid");
    const addressText = value.slice(0, separator);
    const prefixText = value.slice(separator + 1);
    if (!/^(0|[1-9]\d?)$/.test(prefixText)) fail("ipv4-cidr-invalid");
    const addressNumber = ipv4Number(addressText);
    const prefixNumber = Number(prefixText);
    if (addressNumber === null || !Number.isInteger(prefixNumber) || prefixNumber < 0 || prefixNumber > 32) {
        fail("ipv4-cidr-invalid");
    }
    const blockSize = 2 ** (32 - prefixNumber);
    const networkNumber = Math.floor(addressNumber / blockSize) * blockSize;
    if (networkNumber !== addressNumber) fail("ipv4-cidr-not-canonical");
    const networkAddress = parseIPv4Address(numberToIPv4(networkNumber));
    const prefixLength = parseIPv4PrefixLength(prefixNumber);
    return {
        cidr: opaque(`${networkAddress}/${prefixLength}`, ipv4CidrBrand),
        networkAddress,
        prefixLength,
    };
}

export function parseIPv4Cidr(value: string): IPv4Cidr {
    return parseIPv4CidrParts(value).cidr;
}

export function parseHyperVVirtualMachineName(value: string): HyperVVirtualMachineName {
    if (!validNativeName(value)) fail("hyper-v-virtual-machine-name-invalid");
    return opaque(value, virtualMachineNameBrand);
}

export function parseHyperVVirtualMachineId(value: string): HyperVVirtualMachineId {
    return opaque(parseGuid(value, "hyper-v-virtual-machine-id-invalid"), virtualMachineIdBrand);
}

export function parseHyperVNetworkAdapterName(value: string): HyperVNetworkAdapterName {
    if (!validNativeName(value, 256)) fail("hyper-v-network-adapter-name-invalid");
    return opaque(value, networkAdapterNameBrand);
}

export function parseHyperVVMNetworkAdapterName(value: string): HyperVVMNetworkAdapterName {
    if (!validNativeName(value, 256)) fail("hyper-v-vm-network-adapter-name-invalid");
    return opaque(value, vmNetworkAdapterNameBrand);
}

// Native spells a MAC three ways depending on which cmdlet produced it: bare hex from
// `Get-VMNetworkAdapter`, hyphen groups from `Get-NetNeighbor`, and ccc's own records use
// colons. One tolerant parser covers all three, because the alternative — a parser per
// spelling — puts the choice of parser at the call site, which is the mistake this value
// exists to remove. Separators may not be mixed, so `00-15:5D...` is rejected rather than
// quietly accepted.
export function parseHyperVMacAddress(value: string): HyperVMacAddress {
    const separator = value.includes(":") ? ":" : value.includes("-") ? "-" : "";
    const digits = separator === "" ? value : value.split(separator).length === 6 ? value.split(separator).join("") : "";
    if (!/^[0-9a-fA-F]{12}$/.test(digits)) fail("hyper-v-mac-address-invalid");
    const canonical = digits.toLowerCase();
    // Hyper-V reports all zeroes for an adapter whose dynamic address is not yet assigned.
    // That is an absent address, not an address of zero, and callers must handle it as
    // absent before they get here rather than comparing against it.
    if (canonical === "000000000000") fail("hyper-v-mac-address-unassigned");
    return opaque(canonical, macAddressBrand);
}

export function hyperVMacAddressNativeHex(value: HyperVMacAddress): string {
    return value.toUpperCase();
}

export function hyperVMacAddressColonForm(value: HyperVMacAddress): string {
    return (value.match(/../g) ?? []).join(":");
}

export type HyperVHostNetworkSpec = {
    readonly switchName: HyperVVirtualSwitchName;
    readonly natName: HyperVNatName;
    readonly cidr: IPv4Cidr;
    readonly networkAddress: IPv4Address;
    readonly prefixLength: IPv4PrefixLength;
    readonly gateway: IPv4Address;
};

export function createHyperVHostNetworkSpec(input: {
    readonly switchName: HyperVVirtualSwitchName;
    readonly natName: HyperVNatName;
    readonly cidr: string;
    readonly gateway: string;
}): HyperVHostNetworkSpec {
    const parsedCidr = parseIPv4CidrParts(input.cidr);
    const gateway = parseIPv4Address(input.gateway);
    if (parsedCidr.prefixLength < 16 || parsedCidr.prefixLength > 30) {
        fail("hyper-v-host-network-prefix-length-unsupported");
    }
    const networkNumber = ipv4Number(parsedCidr.networkAddress);
    const gatewayNumber = ipv4Number(gateway);
    if (networkNumber === null || gatewayNumber === null) fail("hyper-v-host-network-address-invalid");
    const blockSize = 2 ** (32 - parsedCidr.prefixLength);
    const broadcastNumber = networkNumber + blockSize - 1;
    if (gatewayNumber <= networkNumber || gatewayNumber >= broadcastNumber) {
        fail("hyper-v-host-network-gateway-reserved-or-outside-cidr");
    }
    return {
        switchName: input.switchName,
        natName: input.natName,
        cidr: parsedCidr.cidr,
        networkAddress: parsedCidr.networkAddress,
        prefixLength: parsedCidr.prefixLength,
        gateway,
    };
}

export type HyperVVirtualSwitchIdentity = {
    readonly id: HyperVVirtualSwitchId;
    readonly name: HyperVVirtualSwitchName;
};

export type HyperVNatIdentity = {
    readonly instanceId: HyperVNatInstanceId;
    readonly name: HyperVNatName;
};

export type HyperVVirtualSwitchSelector =
    | { readonly kind: "all" }
    | { readonly kind: "id"; readonly id: HyperVVirtualSwitchId }
    | { readonly kind: "name"; readonly name: HyperVVirtualSwitchName };

export type HyperVNatSelector =
    | { readonly kind: "all" }
    | { readonly kind: "instance-id"; readonly instanceId: HyperVNatInstanceId }
    | { readonly kind: "name"; readonly name: HyperVNatName };

export type HyperVNetIPAddressSelector =
    | { readonly kind: "all-ipv4" }
    | { readonly kind: "interface"; readonly interfaceIndex: HyperVInterfaceIndex };

export type HyperVVirtualSwitch = HyperVVirtualSwitchIdentity & {
    readonly switchType: string;
    readonly notes: string;
};

export type HyperVVMNetworkAdapter = {
    readonly vmId: HyperVVirtualMachineId | null;
    readonly vmName: string | null;
    readonly name: string;
    readonly switchId: HyperVVirtualSwitchId | null;
    readonly switchName: string | null;
    readonly status: string;
    readonly managementOperatingSystem: boolean;
    // Absent until the adapter has an address: native reports all zeroes for a dynamic
    // address the VM has not yet been assigned, and an unparseable address is absent too
    // rather than a value, so that identity comparisons can never match on garbage.
    readonly macAddress: HyperVMacAddress | null;
    // Only the addresses the guest integration services report, IPv4 and IPv6 alike. The
    // library stays native-faithful here; which family and which subnet matter is a
    // reconciliation decision, not a decoding one.
    readonly ipAddresses: readonly string[];
};

export type HyperVExactNameVirtualMachine = {
    readonly id: HyperVVirtualMachineId;
    readonly name: HyperVVirtualMachineName;
    readonly notes: string;
};

export type HyperVHostNetworkAdapter = {
    readonly interfaceIndex: HyperVInterfaceIndex;
    readonly name: HyperVNetworkAdapterName;
    readonly status: string;
    readonly interfaceDescription: string;
};

export type HyperVNetIPAddress = {
    readonly interfaceIndex: HyperVInterfaceIndex;
    readonly address: IPv4Address;
    readonly prefixLength: IPv4PrefixLength;
    readonly prefixOrigin: string;
    readonly suffixOrigin: string;
    readonly addressState: string;
};

export type HyperVNetNat = HyperVNatIdentity & {
    readonly internalAddressPrefix: IPv4Cidr;
};

// One IPv4 neighbour-table entry. `state` stays an opaque native string: which states count
// as a usable answer is a reconciliation policy, not a decoding fact.
export type HyperVNetNeighbor = {
    readonly interfaceIndex: HyperVInterfaceIndex;
    readonly address: IPv4Address;
    readonly linkLayerAddress: HyperVMacAddress | null;
    readonly state: string;
};

// Reads a single VM's adapters rather than the whole host. The host-wide request stays
// selector-free, so asking for one VM's adapters is impossible without naming the VM.
export type HyperVGetVMNetworkAdaptersRequest = {
    readonly selector: HyperVVirtualMachineSelector;
};

// Reads the management operating system's adapter on one switch -- the host side of the
// connection, not any VM's side.
export type HyperVGetManagementNetworkAdaptersRequest = {
    readonly managementSwitchName: HyperVVirtualSwitchName;
};

export type HyperVGetNetNeighborsRequest = {
    readonly interfaceIndex: HyperVInterfaceIndex;
};

// The one destructive primitive in this slice. It names the VM, the adapter, and the address
// the adapter must already carry, and the native side removes only when all three identify
// exactly one adapter. Hyper-V permits two adapters on one VM to share a name, so a name
// alone cannot be an identity here.
export type HyperVRemoveVMNetworkAdapterRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly adapterName: HyperVVMNetworkAdapterName;
    readonly macAddress: HyperVMacAddress;
};

export type HyperVCreateVMSwitchRequest = {
    readonly name: HyperVVirtualSwitchName;
    readonly notes: string;
};

export type HyperVSetVMSwitchNotesRequest = {
    readonly identity: HyperVVirtualSwitchIdentity;
    readonly notes: string;
};

export type HyperVRemoveVMSwitchRequest = {
    readonly identity: HyperVVirtualSwitchIdentity;
};

export type HyperVExactNameVMInventoryRequest = {
    readonly names: readonly HyperVVirtualMachineName[];
};

export type HyperVGetHostNetworkAdaptersRequest = {
    readonly name: HyperVNetworkAdapterName;
};

export type HyperVCreateNetIPAddressRequest = {
    readonly interfaceIndex: HyperVInterfaceIndex;
    readonly address: IPv4Address;
    readonly prefixLength: IPv4PrefixLength;
};

export type HyperVRemoveNetIPAddressRequest = HyperVCreateNetIPAddressRequest;

export type HyperVCreateNetNatRequest = {
    readonly name: HyperVNatName;
    readonly internalAddressPrefix: IPv4Cidr;
};

export type HyperVRemoveNetNatRequest = {
    readonly identity: HyperVNatIdentity;
};

export type HyperVWindowsNetworkClient = {
    getVMSwitches(selector: HyperVVirtualSwitchSelector, options?: HyperVWindowsCallOptions): Promise<readonly HyperVVirtualSwitch[]>;
    createVMSwitch(request: HyperVCreateVMSwitchRequest, options?: HyperVWindowsCallOptions): Promise<HyperVVirtualSwitch>;
    setVMSwitchNotes(request: HyperVSetVMSwitchNotesRequest, options?: HyperVWindowsCallOptions): Promise<void>;
    removeVMSwitch(request: HyperVRemoveVMSwitchRequest, options?: HyperVWindowsCallOptions): Promise<void>;
    getAllVMNetworkAdapters(options?: HyperVWindowsCallOptions): Promise<readonly HyperVVMNetworkAdapter[]>;
    getVMNetworkAdapters(request: HyperVGetVMNetworkAdaptersRequest, options?: HyperVWindowsCallOptions): Promise<readonly HyperVVMNetworkAdapter[]>;
    getManagementNetworkAdapters(request: HyperVGetManagementNetworkAdaptersRequest, options?: HyperVWindowsCallOptions): Promise<readonly HyperVVMNetworkAdapter[]>;
    getNetNeighbors(request: HyperVGetNetNeighborsRequest, options?: HyperVWindowsCallOptions): Promise<readonly HyperVNetNeighbor[]>;
    removeVMNetworkAdapter(request: HyperVRemoveVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions): Promise<void>;
    getVMsByExactNames(request: HyperVExactNameVMInventoryRequest, options?: HyperVWindowsCallOptions): Promise<readonly HyperVExactNameVirtualMachine[]>;
    getHostNetworkAdapters(request: HyperVGetHostNetworkAdaptersRequest, options?: HyperVWindowsCallOptions): Promise<readonly HyperVHostNetworkAdapter[]>;
    getNetIPAddresses(selector: HyperVNetIPAddressSelector, options?: HyperVWindowsCallOptions): Promise<readonly HyperVNetIPAddress[]>;
    createNetIPAddress(request: HyperVCreateNetIPAddressRequest, options?: HyperVWindowsCallOptions): Promise<HyperVNetIPAddress>;
    removeNetIPAddress(request: HyperVRemoveNetIPAddressRequest, options?: HyperVWindowsCallOptions): Promise<void>;
    getNetNats(selector: HyperVNatSelector, options?: HyperVWindowsCallOptions): Promise<readonly HyperVNetNat[]>;
    createNetNat(request: HyperVCreateNetNatRequest, options?: HyperVWindowsCallOptions): Promise<HyperVNetNat>;
    removeNetNat(request: HyperVRemoveNetNatRequest, options?: HyperVWindowsCallOptions): Promise<void>;
};
