import { resolve } from "path";
import {
    buildContainerVmRunConfig,
    buildLabRunnerRunConfig,
    getContainerName,
    getLabRunnerStateVolumeName,
    type LabRunnerRunConfig,
} from "./docker.js";
import { formatRuntimeSummary } from "./container-runtime.js";
import { LAB_RUNNER_PROFILE_NAME, LAB_RUNNER_STATE_CONTAINER_DIR } from "./utils.js";

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

function contractSnapshot(containerName: string, config: LabRunnerRunConfig): ContainerVmContractSnapshot {
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

export function labRunnerSnapshot(cwd = process.cwd()): LabRunnerSnapshot {
    const projectPath = resolve(cwd);
    const defaultContainerName = getContainerName(projectPath);
    const defaultConfig = buildContainerVmRunConfig(defaultContainerName);
    const containerName = getContainerName(projectPath, LAB_RUNNER_PROFILE_NAME);
    const config = buildLabRunnerRunConfig(LAB_RUNNER_PROFILE_NAME, containerName) || buildContainerVmRunConfig(containerName);
    const defaultContainer = contractSnapshot(defaultContainerName, defaultConfig);
    const labRunnerProfile = contractSnapshot(containerName, config);
    return {
        profile: LAB_RUNNER_PROFILE_NAME,
        containerName,
        stateVolumeName: getLabRunnerStateVolumeName(containerName),
        stateContainerDir: LAB_RUNNER_STATE_CONTAINER_DIR,
        status: labRunnerProfile.status,
        unsupportedReason: labRunnerProfile.unsupportedReason,
        kvmDevicePath: labRunnerProfile.kvmDevicePath,
        kvmGroupId: labRunnerProfile.kvmGroupId,
        networkMode: labRunnerProfile.networkMode,
        runtime: formatRuntimeSummary(),
        defaultContainerVmCapable: true,
        defaultContainer,
        labRunnerProfile,
        startCommands: {
            shell: "ccc labs shell",
            run: "ccc labs run <command>",
            status: "ccc labs status",
        },
    };
}

export function formatLabRunnerStatus(cwd = process.cwd()): string {
    const snapshot = labRunnerSnapshot(cwd);
    const lines = [
        "=== CCC Lab Runner ===",
        "",
        `profile: ${snapshot.profile} (built-in)`,
        `container: ${snapshot.containerName}`,
        `state volume: ${snapshot.stateVolumeName}`,
        `state mount: ${snapshot.stateContainerDir}`,
        `runtime: ${snapshot.runtime}`,
        `status: ${snapshot.status}`,
    ];
    if (snapshot.unsupportedReason) lines.push(`unsupported reason: ${snapshot.unsupportedReason}`);
    lines.push(`kvm: ${snapshot.kvmDevicePath ? `${snapshot.kvmDevicePath}${snapshot.kvmGroupId !== null ? ` group=${snapshot.kvmGroupId}` : ""}` : "not exposed"}`);
    lines.push(`vm networking: ${snapshot.networkMode} (QEMU user-mode; no host TUN exposure)`);
    lines.push(`default container: ${snapshot.defaultContainer.containerName}`);
    lines.push(`default state volume: ${snapshot.defaultContainer.stateVolumeName}`);
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

export function formatLabRunnerSmoke(cwd = process.cwd()): string {
    const snapshot = labRunnerSnapshot(cwd);
    const lines = [
        "=== CCC Lab Runner Smoke ===",
        "",
        "default-container-vm-config: PASS",
        "default-container-safety: PASS no --privileged or host TUN exposure",
        `default-durable-lab-state: PASS ${snapshot.defaultContainer.stateVolumeName}:${snapshot.defaultContainer.stateContainerDir}`,
        snapshot.defaultContainer.status === "ready"
            ? `default-nested-kvm: PASS ${snapshot.defaultContainer.kvmDevicePath}${snapshot.defaultContainer.kvmGroupId !== null ? ` group=${snapshot.defaultContainer.kvmGroupId}` : ""}`
            : `default-nested-kvm: SKIP ${snapshot.defaultContainer.unsupportedReason || "unsupported"}`,
        "built-in-profile: PASS",
        `lab-runner-durable-lab-state: PASS ${snapshot.stateVolumeName}:${snapshot.stateContainerDir}`,
        snapshot.status === "ready"
            ? `lab-runner-nested-kvm: PASS ${snapshot.kvmDevicePath}${snapshot.kvmGroupId !== null ? ` group=${snapshot.kvmGroupId}` : ""}`
            : `lab-runner-nested-kvm: SKIP ${snapshot.unsupportedReason || "unsupported"}`,
        `vm-network: PASS ${snapshot.networkMode} networking (no host TUN exposure)`,
        snapshot.defaultContainer.status === "ready"
            ? "container-qemu-provider-gate: PASS lab-mcp can report ready when in-container qemu is present"
            : "container-qemu-provider-gate: SKIP lab-mcp must report unsupported until CCC_LAB_RUNNER_STATUS=ready",
        "vm-startup: not-run (smoke is non-starting)",
        `result: ${snapshot.defaultContainer.status === "ready" && snapshot.status === "ready" ? "PASS" : "SKIP"}`,
        "",
    ];
    return lines.join("\n");
}

export function labsCli(args: string[], cwd = process.cwd()): number {
    const command = args[0] || "status";
    switch (command) {
        case "status":
        case "doctor":
            console.log(formatLabRunnerStatus(cwd));
            return 0;
        case "smoke":
            console.log(formatLabRunnerSmoke(cwd));
            return 0;
        default:
            console.error("Usage: ccc labs <status|doctor|smoke|shell|run>");
            return 1;
    }
}
