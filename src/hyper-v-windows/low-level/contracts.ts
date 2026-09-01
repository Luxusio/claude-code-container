export const HYPER_V_WINDOWS_OPERATIONS = [
    "Get-VM",
    "Get-VMHardDiskDrive",
    "Get-VMDvdDrive",
    "Start-VM",
    "Stop-VM",
    "Remove-VM",
] as const;

export type HyperVWindowsOperation = typeof HYPER_V_WINDOWS_OPERATIONS[number];

export type HyperVVirtualMachineSelector =
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

type HyperVWindowsExecutionRequestBase<Operation extends HyperVWindowsOperation> = {
    readonly schemaVersion: 1;
    readonly operation: Operation;
    readonly selector: HyperVVirtualMachineSelector;
};

export type HyperVWindowsExecutionRequest =
    | HyperVWindowsExecutionRequestBase<"Get-VM">
    | HyperVWindowsExecutionRequestBase<"Get-VMHardDiskDrive">
    | HyperVWindowsExecutionRequestBase<"Get-VMDvdDrive">
    | HyperVWindowsExecutionRequestBase<"Start-VM">
    | (HyperVWindowsExecutionRequestBase<"Stop-VM"> & {
        readonly mode: "shutdown" | "turn-off";
        readonly force: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Remove-VM"> & {
        readonly force: boolean;
    });

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
};
