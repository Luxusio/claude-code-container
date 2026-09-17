import {
    confirmHyperVBootstrapContainment,
    discoverHyperVBootstrapAddresses,
    planHyperVBootstrapTeardown,
    type HyperVBootstrapAdapterExpectation,
    type HyperVBootstrapNetworkObservation,
} from "../../../hyper-v-windows/lifecycle/index.js";
import {
    parseHyperVMacAddress,
    parseHyperVVirtualMachineName,
    parseHyperVVirtualSwitchName,
    parseHyperVVMNetworkAdapterName,
    type HyperVMacAddress,
    type HyperVVirtualMachineSelector,
    type HyperVWindowsNetworkClient,
} from "../../../hyper-v-windows/low-level/index.js";

// Device Lab's names for the two adapters it puts on a Linux guest, and the switch the
// bootstrap one rides. These are consumer policy and live here rather than in the library,
// which knows only that an adapter has a name and a switch.
const BOOTSTRAP_ADAPTER_NAME = "CCC Bootstrap DHCP";
const BOOTSTRAP_SWITCH_NAME = "Default Switch";
const BOOTSTRAP_EXPECTATION: HyperVBootstrapAdapterExpectation = {
    adapterName: BOOTSTRAP_ADAPTER_NAME,
    switchName: BOOTSTRAP_SWITCH_NAME,
    managementInterfaceAlias: `vEthernet (${BOOTSTRAP_SWITCH_NAME})`,
};

export type DeviceLabHyperVOwnedVm = {
    readonly vmId: string;
    readonly vmName: string;
    readonly ownershipMarker: string;
};

// Mirrors the legacy observations exactly. The broker maps these into public device status
// today, so their shape and their diagnostic spellings are a compatibility surface.
export type DeviceLabHyperVBootstrapNetworkObservation = {
    readonly ok: true;
    readonly addresses: readonly string[];
    readonly diagnosticCode: string | null;
};

export type DeviceLabHyperVBootstrapCleanupObservation = {
    readonly ok: true;
    readonly removed: boolean;
    readonly alreadyMissing: boolean;
};

export class DeviceLabHyperVVmNetworkAdapterError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = "DeviceLabHyperVVmNetworkAdapterError";
        this.code = code;
    }
}

/**
 * Derives the bootstrap address from the device's managed one.
 *
 * Device Lab assigns the managed adapter an address in the locally administered `02:` range
 * and gives the bootstrap adapter the same address under `06:`, so one device's two adapters
 * are always distinguishable and the bootstrap address is always recoverable from what the
 * device record already stores.
 */
export function deviceLabHyperVBootstrapMacAddress(managedMacAddress: string): HyperVMacAddress {
    const managed = String(managedMacAddress || "").toLowerCase();
    if (!/^02(?::[0-9a-f]{2}){5}$/.test(managed)) {
        throw new DeviceLabHyperVVmNetworkAdapterError("hyper-v-mac-address-invalid");
    }
    return parseHyperVMacAddress(`06${managed.slice(2)}`);
}

/**
 * Proves the VM is the one this owner, device and incarnation created, before anything reads
 * or removes its adapters.
 *
 * This is the typed equivalent of the ownership prelude the generated PowerShell opened with,
 * and it is not optional: the operations behind it remove an adapter from a VM by identity,
 * and a VM that merely has the right id is not necessarily still the right VM -- an id can be
 * reused by a later incarnation whose adapters must not be touched.
 */
async function resolveOwnedVm(
    client: HyperVWindowsNetworkClient,
    vm: DeviceLabHyperVOwnedVm,
): Promise<HyperVVirtualMachineSelector> {
    const name = parseHyperVVirtualMachineName(vm.vmName);
    const matches = await client.getVMsByExactNames({ names: [name] });
    const match = matches.length === 1 ? matches[0] : null;
    if (!match || match.id !== vm.vmId.toLowerCase() || match.notes !== vm.ownershipMarker) {
        throw new DeviceLabHyperVVmNetworkAdapterError("hyper-v-vm-ownership-mismatch");
    }
    return { kind: "id", id: match.id };
}

async function observe(
    client: HyperVWindowsNetworkClient,
    selector: HyperVVirtualMachineSelector,
): Promise<HyperVBootstrapNetworkObservation> {
    const switchName = parseHyperVVirtualSwitchName(BOOTSTRAP_SWITCH_NAME);
    const [vmAdapters, managementAdapters, hostIPv4Addresses] = await Promise.all([
        client.getVMNetworkAdapters({ selector }),
        client.getManagementNetworkAdapters({ managementSwitchName: switchName }),
        client.getNetIPAddresses({ kind: "all-ipv4" }),
    ]);
    // Neighbours are read per interface, and which interfaces matter is only known once the
    // host's own addresses on this network are known -- so this read cannot join the batch
    // above. Reading the whole table instead would be one round trip fewer and an unbounded
    // answer about networks this decision has no business seeing.
    const interfaceIndexes = [...new Set(hostIPv4Addresses
        .filter((entry) => managementAdapters.some((adapter) => adapter.ipAddresses.includes(entry.address))
            || entry.interfaceAlias === BOOTSTRAP_EXPECTATION.managementInterfaceAlias)
        .map((entry) => entry.interfaceIndex))];
    const neighborBatches = await Promise.all(
        interfaceIndexes.map((interfaceIndex) => client.getNetNeighbors({ interfaceIndex })),
    );
    return {
        vmAdapters,
        managementAdapters,
        hostIPv4Addresses,
        neighbors: neighborBatches.flat(),
    };
}

/**
 * Reports where the device's bootstrap adapter can be reached, for one probe attempt.
 *
 * Called repeatedly while a guest boots, so it must be cheap to repeat and must distinguish
 * "not there yet" from "something is wrong": an empty answer with no diagnostic is the
 * ordinary state of a booting guest and the caller keeps waiting on it.
 */
export async function discoverDeviceLabHyperVBootstrapNetwork(
    client: HyperVWindowsNetworkClient,
    vm: DeviceLabHyperVOwnedVm,
): Promise<DeviceLabHyperVBootstrapNetworkObservation> {
    const selector = await resolveOwnedVm(client, vm);
    const outcome = discoverHyperVBootstrapAddresses(await observe(client, selector), BOOTSTRAP_EXPECTATION);
    return { ok: true, addresses: outcome.addresses, diagnosticCode: outcome.diagnosticCode };
}

/**
 * Removes the device's bootstrap adapter once the guest no longer needs DHCP.
 *
 * Succeeds when the adapter is already gone, so that it is safe to repeat after a crash
 * between the removal and the record of it, and fails when any adapter on the host still
 * carries the bootstrap address -- the address has to be free before the next device derives
 * the same one.
 */
export async function teardownDeviceLabHyperVBootstrapNetwork(
    client: HyperVWindowsNetworkClient,
    vm: DeviceLabHyperVOwnedVm,
    managedMacAddress: string,
): Promise<DeviceLabHyperVBootstrapCleanupObservation> {
    const expectedMacAddress = deviceLabHyperVBootstrapMacAddress(managedMacAddress);
    const selector = await resolveOwnedVm(client, vm);
    const decision = planHyperVBootstrapTeardown(
        await observe(client, selector),
        BOOTSTRAP_EXPECTATION,
        expectedMacAddress,
    );
    if (decision.kind === "refuse") throw new DeviceLabHyperVVmNetworkAdapterError(decision.diagnosticCode);
    if (decision.kind === "remove") {
        await client.removeVMNetworkAdapter({
            selector,
            adapterName: parseHyperVVMNetworkAdapterName(decision.adapterName),
            macAddress: decision.macAddress,
        });
    }

    // Host-wide, and deliberately after the removal rather than instead of it: the question
    // is whether the address is free now, which nothing observed before the removal answers.
    const containment = confirmHyperVBootstrapContainment(
        await client.getAllVMNetworkAdapters(),
        expectedMacAddress,
    );
    if (containment.kind === "breached") {
        throw new DeviceLabHyperVVmNetworkAdapterError(containment.diagnosticCode);
    }
    return { ok: true, removed: decision.kind === "remove", alreadyMissing: decision.kind === "already-absent" };
}
