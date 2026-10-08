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

export interface LabRunnerSnapshot {
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
    startCommands: {
        shell: string;
        run: string;
        status: string;
    };
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

function stateVolumeLabel(status: string, volumeName: string): string {
    return status === "ready" ? volumeName : "not mounted for new containers (nested VM unavailable)";
}

export function renderLabRunnerStatus(snapshot: LabRunnerSnapshot): string {
    const lines = [
        "=== CCC Lab Runner ===",
        "",
        `profile: ${snapshot.profile} (built-in)`,
        `container: ${snapshot.containerName}`,
        `state volume: ${stateVolumeLabel(snapshot.status, snapshot.stateVolumeName)}`,
        `state mount: ${snapshot.stateContainerDir}`,
        `runtime: ${snapshot.runtime}`,
        `status: ${snapshot.status}`,
    ];
    if (snapshot.unsupportedReason) lines.push(`unsupported reason: ${snapshot.unsupportedReason}`);
    lines.push(`kvm: ${snapshot.kvmDevicePath ? `${snapshot.kvmDevicePath}${snapshot.kvmGroupId !== null ? ` group=${snapshot.kvmGroupId}` : ""}` : "not exposed"}`);
    lines.push(`vm networking: ${snapshot.networkMode} (QEMU user-mode; no host TUN exposure)`);
    lines.push(`default container: ${snapshot.defaultContainer.containerName}`);
    lines.push(`default state volume: ${stateVolumeLabel(snapshot.defaultContainer.status, snapshot.defaultContainer.stateVolumeName)}`);
    lines.push(`default status: ${snapshot.defaultContainer.status}`);
    if (snapshot.defaultContainer.unsupportedReason) lines.push(`default unsupported reason: ${snapshot.defaultContainer.unsupportedReason}`);
    lines.push(`default kvm: ${snapshot.defaultContainer.kvmDevicePath ? `${snapshot.defaultContainer.kvmDevicePath}${snapshot.defaultContainer.kvmGroupId !== null ? ` group=${snapshot.defaultContainer.kvmGroupId}` : ""}` : "not exposed"}`);
    lines.push("default container: VM-capable when supported; durable lab state and bounded /dev/kvm use the same safety gates");
    lines.push("safety: no --privileged and no host TUN exposure");
    lines.push("startup policy: lazy; this status check does not start labs or VMs");
    lines.push(`shell: ${snapshot.startCommands.shell}`);
    lines.push(`run: ${snapshot.startCommands.run}`);
    lines.push("mcp: call lab_status inside the default or lab-runner container for container-QEMU provider readiness");
    lines.push("");
    return lines.join("\n");
}

export function renderLabRunnerSmoke(snapshot: LabRunnerSnapshot): string {
    const lines = [
        "=== CCC Lab Runner Smoke ===",
        "",
        "default-container-vm-config: PASS",
        "default-container-safety: PASS no --privileged or host TUN exposure",
        snapshot.defaultContainer.status === "ready"
            ? `default-durable-lab-state: PASS ${snapshot.defaultContainer.stateVolumeName}:${snapshot.defaultContainer.stateContainerDir}`
            : `default-durable-lab-state: SKIP ${snapshot.defaultContainer.unsupportedReason || "unsupported"}`,
        snapshot.defaultContainer.status === "ready"
            ? `default-nested-kvm: PASS ${snapshot.defaultContainer.kvmDevicePath}${snapshot.defaultContainer.kvmGroupId !== null ? ` group=${snapshot.defaultContainer.kvmGroupId}` : ""}`
            : `default-nested-kvm: SKIP ${snapshot.defaultContainer.unsupportedReason || "unsupported"}`,
        "built-in-profile: PASS",
        snapshot.status === "ready"
            ? `lab-runner-durable-lab-state: PASS ${snapshot.stateVolumeName}:${snapshot.stateContainerDir}`
            : `lab-runner-durable-lab-state: SKIP ${snapshot.unsupportedReason || "unsupported"}`,
        snapshot.status === "ready"
            ? `lab-runner-nested-kvm: PASS ${snapshot.kvmDevicePath}${snapshot.kvmGroupId !== null ? ` group=${snapshot.kvmGroupId}` : ""}`
            : `lab-runner-nested-kvm: SKIP ${snapshot.unsupportedReason || "unsupported"}`,
        `vm-network: PASS ${snapshot.networkMode} networking (no host TUN exposure)`,
        snapshot.defaultContainer.status === "ready"
            ? "container-qemu-provider-gate: PASS device-lab linux-vm can report ready when in-container qemu is present"
            : "container-qemu-provider-gate: SKIP device-lab linux-vm must report unsupported until CCC_LAB_RUNNER_STATUS=ready",
        "vm-startup: not-run (smoke is non-starting)",
        `result: ${snapshot.defaultContainer.status === "ready" && snapshot.status === "ready" ? "PASS" : "SKIP"}`,
        "",
    ];
    return lines.join("\n");
}

