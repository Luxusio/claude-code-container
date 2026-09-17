import type {
    HyperVCreateNetIPAddressRequest,
    HyperVCreateNetNatRequest,
    HyperVCreateVMSwitchRequest,
    HyperVExactNameVMInventoryRequest,
    HyperVGetHostNetworkAdaptersRequest,
    HyperVGetManagementNetworkAdaptersRequest,
    HyperVGetNetNeighborsRequest,
    HyperVGetVMNetworkAdaptersRequest,
    HyperVNatSelector,
    HyperVNetIPAddressSelector,
    HyperVRemoveNetIPAddressRequest,
    HyperVRemoveNetNatRequest,
    HyperVRemoveVMNetworkAdapterRequest,
    HyperVRemoveVMSwitchRequest,
    HyperVSetVMSwitchNotesRequest,
    HyperVVirtualSwitchSelector,
} from "./network-contracts.js";

export const HYPER_V_WINDOWS_OPERATIONS = Object.freeze([
    "Get-VM",
    "Get-VMHardDiskDrive",
    "Get-VMDvdDrive",
    "Get-VMSnapshot",
    "Start-VM",
    "Stop-VM",
    "Remove-VM",
    "Checkpoint-VM",
    "Remove-VMSnapshot",
    "Restore-VMSnapshot",
    "Get-VMSwitch",
    "New-VMSwitch",
    "Set-VMSwitch",
    "Remove-VMSwitch",
    "Get-VMNetworkAdapter",
    "Remove-VMNetworkAdapter",
    "Get-NetAdapter",
    "Get-NetNeighbor",
    "Get-NetIPAddress",
    "New-NetIPAddress",
    "Remove-NetIPAddress",
    "Get-NetNat",
    "New-NetNat",
    "Remove-NetNat",
] as const);

export type HyperVWindowsOperation = typeof HYPER_V_WINDOWS_OPERATIONS[number];

export type HyperVVirtualMachineSelector =
    | { readonly kind: "id"; readonly id: string }
    | { readonly kind: "name"; readonly name: string };

// Snapshots are addressed the same way virtual machines are: by native id or by native name.
// Consumer naming conventions stay outside this library.
export type HyperVSnapshotSelector =
    | { readonly kind: "id"; readonly id: string }
    | { readonly kind: "name"; readonly name: string };

export type HyperVVirtualMachine = {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly status: string;
    readonly notes: string;
    readonly uptimeMilliseconds: number;
    readonly generation: number;
    readonly checkpointType: string;
};

export type HyperVHardDiskDrive = {
    readonly vmId: string;
    readonly vmName: string;
    readonly path: string | null;
    readonly controllerType: string;
    readonly controllerNumber: number;
    readonly controllerLocation: number;
    readonly diskNumber: number | null;
};

export type HyperVDvdDrive = {
    readonly vmId: string;
    readonly vmName: string;
    readonly path: string | null;
    readonly controllerType: string;
    readonly controllerNumber: number;
    readonly controllerLocation: number;
};

export type HyperVVirtualMachineSnapshot = {
    readonly id: string;
    readonly name: string;
    readonly vmId: string;
    readonly vmName: string;
    readonly snapshotType: string;
    readonly parentSnapshotId: string | null;
    readonly parentSnapshotName: string | null;
    readonly creationTimeMilliseconds: number;
};

type HyperVWindowsExecutionRequestBase<Operation extends HyperVWindowsOperation> = {
    readonly schemaVersion: 1;
    readonly operation: Operation;
    readonly selector: HyperVVirtualMachineSelector;
    readonly names?: never;
};

type HyperVWindowsHostExecutionRequestBase<Operation extends HyperVWindowsOperation> = {
    readonly schemaVersion: 1;
    readonly operation: Operation;
};

type HyperVWindowsHostExecutionRequestWithoutSelectorBase<Operation extends HyperVWindowsOperation> =
    HyperVWindowsHostExecutionRequestBase<Operation> & { readonly selector?: never };

export type HyperVWindowsExecutionRequest =
    | HyperVWindowsExecutionRequestBase<"Get-VM">
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VM"> & HyperVExactNameVMInventoryRequest)
    | HyperVWindowsExecutionRequestBase<"Get-VMHardDiskDrive">
    | HyperVWindowsExecutionRequestBase<"Get-VMDvdDrive">
    | HyperVWindowsExecutionRequestBase<"Get-VMSnapshot">
    | HyperVWindowsExecutionRequestBase<"Start-VM">
    | (HyperVWindowsExecutionRequestBase<"Stop-VM"> & {
        readonly mode: "shutdown" | "turn-off";
        readonly force: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Remove-VM"> & {
        readonly force: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Checkpoint-VM"> & {
        readonly snapshotName: string;
    })
    | (HyperVWindowsExecutionRequestBase<"Remove-VMSnapshot"> & {
        readonly snapshot: HyperVSnapshotSelector;
        readonly includeDescendants: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Restore-VMSnapshot"> & {
        readonly snapshot: HyperVSnapshotSelector;
    })
    | (HyperVWindowsHostExecutionRequestBase<"Get-VMSwitch"> & {
        readonly selector: HyperVVirtualSwitchSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-VMSwitch"> & HyperVCreateVMSwitchRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Set-VMSwitch"> & HyperVSetVMSwitchNotesRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-VMSwitch"> & HyperVRemoveVMSwitchRequest)
    | HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VMNetworkAdapter">
    | (HyperVWindowsHostExecutionRequestBase<"Get-VMNetworkAdapter"> & HyperVGetVMNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VMNetworkAdapter"> & HyperVGetManagementNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Remove-VMNetworkAdapter"> & HyperVRemoveVMNetworkAdapterRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-NetAdapter"> & HyperVGetHostNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-NetNeighbor"> & HyperVGetNetNeighborsRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Get-NetIPAddress"> & {
        readonly selector: HyperVNetIPAddressSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-NetIPAddress"> & HyperVCreateNetIPAddressRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-NetIPAddress"> & HyperVRemoveNetIPAddressRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Get-NetNat"> & {
        readonly selector: HyperVNatSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-NetNat"> & HyperVCreateNetNatRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-NetNat"> & HyperVRemoveNetNatRequest);

export type HyperVWindowsExecutionResult = {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr?: string;
    readonly error?: string;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly outputLimitExceeded?: boolean;
};

export type HyperVWindowsExecutionContext = {
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
};

export type HyperVWindowsExecutor = {
    execute(
        request: HyperVWindowsExecutionRequest,
        context: HyperVWindowsExecutionContext,
    ): HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>;
};

export type HyperVWindowsCallOptions = {
    readonly signal?: AbortSignal;
};

export type HyperVStartVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
};

export type HyperVStopVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly mode: "shutdown" | "turn-off";
    readonly force?: boolean;
};

export type HyperVRemoveVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly force?: boolean;
};

export type HyperVCheckpointVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshotName: string;
};

export type HyperVRemoveSnapshotRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshot: HyperVSnapshotSelector;
    // Native Remove-VMSnapshot removes only the named checkpoint unless -IncludeAllChildSnapshots.
    readonly includeDescendants?: boolean;
};

export type HyperVRestoreSnapshotRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshot: HyperVSnapshotSelector;
};

export type HyperVWindowsClient = {
    getVM(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVVirtualMachine[]>;
    getVMHardDiskDrives(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVHardDiskDrive[]>;
    getVMDvdDrives(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVDvdDrive[]>;
    startVM(
        request: HyperVStartVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    stopVM(
        request: HyperVStopVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    removeVM(
        request: HyperVRemoveVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    getVMSnapshots(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVVirtualMachineSnapshot[]>;
    // Returns the checkpoint the host actually created, so the caller never has to re-read by name.
    checkpointVM(
        request: HyperVCheckpointVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<HyperVVirtualMachineSnapshot>;
    removeVMSnapshot(
        request: HyperVRemoveSnapshotRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    restoreVMSnapshot(
        request: HyperVRestoreSnapshotRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
};
