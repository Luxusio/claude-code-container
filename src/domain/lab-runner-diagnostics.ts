export interface ContainerVmContractSnapshot {
    containerName: string;
    stateVolumeName: string;
    stateContainerDir: string;
    status: "ready" | "unsupported";
    unsupportedReason: string | null;
    kvmDevicePath: string | null;
    kvmGroupId: number | null;
    networkMode: "user";
}

export interface LabRunnerConfigurationSnapshot {
    profile: string;
    containerName: string;
    stateVolumeName: string;
    stateContainerDir: string;
    status: "ready" | "unsupported";
    unsupportedReason: string | null;
    kvmDevicePath: string | null;
    kvmGroupId: number | null;
    networkMode: "user";
    runtime: string;
    defaultContainerVmCapable: true;
    defaultContainer: ContainerVmContractSnapshot;
    labRunnerProfile: ContainerVmContractSnapshot;
}

export interface LabRunnerConfigObservation {
    status: "ready" | "unsupported";
    stateVolumeName: string;
    stateContainerDir: string;
    kvmDevicePath?: string;
    kvmGroupId?: number;
    networkMode: "user";
    unsupportedReason?: string;
}

export function projectLabRunnerContract(containerName: string, config: LabRunnerConfigObservation): ContainerVmContractSnapshot {
    return {
        containerName,
        stateVolumeName: config.stateVolumeName,
        stateContainerDir: config.stateContainerDir,
        status: config.status,
        unsupportedReason: config.unsupportedReason || null,
        kvmDevicePath: config.kvmDevicePath || null,
        kvmGroupId: config.kvmGroupId ?? null,
        networkMode: config.networkMode,
    };
}

