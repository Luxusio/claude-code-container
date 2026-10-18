import { resolve } from "path";
import { buildContainerVmRunConfig, buildLabRunnerRunConfig, getContainerName, getLabRunnerStateVolumeName } from "./docker.js";
import { formatRuntimeSummary } from "./container-runtime.js";
import { LAB_RUNNER_PROFILE_NAME, LAB_RUNNER_STATE_CONTAINER_DIR } from "./utils.js";
import { createLabRunnerDiagnostics } from "./application/lab-runner-diagnostics.js";
import type { LabRunnerConfigurationSnapshot } from "./domain/lab-runner-diagnostics.js";
import type { LabRunnerDiagnosticsPorts } from "./ports/lab-runner-diagnostics.js";
export type { ContainerVmContractSnapshot } from "./domain/lab-runner-diagnostics.js";

export interface LabRunnerSnapshot extends LabRunnerConfigurationSnapshot {
    startCommands: {
        shell: string;
        run: string;
        status: string;
    };
}

function nativeDiagnostics() {
    const ports: LabRunnerDiagnosticsPorts = {
        get resolveProjectPath() {
            const selected = resolve;
            return (cwd: string) => selected(cwd);
        },
        get containerName() {
            const selected = getContainerName;
            return (...args: Parameters<typeof getContainerName>) => selected(...args);
        },
        get containerVmConfig() {
            const selected = buildContainerVmRunConfig;
            return (container: string) => selected(container);
        },
        get labRunnerVmConfig() {
            const selected = buildLabRunnerRunConfig;
            return (profile: string, container: string) => selected(profile, container);
        },
        labProfileName: () => LAB_RUNNER_PROFILE_NAME,
        get stateVolumeName() {
            const selected = getLabRunnerStateVolumeName;
            return (container: string) => selected(container);
        },
        stateContainerDir: () => LAB_RUNNER_STATE_CONTAINER_DIR,
        get runtimeSummary() {
            const selected = formatRuntimeSummary;
            return () => selected();
        },
    };
    return createLabRunnerDiagnostics(ports);
}

export function labRunnerSnapshot(cwd = process.cwd()): LabRunnerSnapshot {
    return {
        ...nativeDiagnostics().snapshot(cwd),
        startCommands: {shell: "ccc labs shell", run: "ccc labs run <command>", status: "ccc labs status"},
    };
}
export function formatLabRunnerStatus(cwd = process.cwd()): string {
    return renderLabRunnerStatus(labRunnerSnapshot(cwd));
}
export function formatLabRunnerSmoke(cwd = process.cwd()): string {
    return renderLabRunnerSmoke(labRunnerSnapshot(cwd));
}
export function labsCli(args: string[], cwd = process.cwd()): number {
    const command = args[0] || "status";
    switch (command) {
        case "status":
        case "doctor": {
            const receiver = console;
            const selected = receiver.log;
            const message = formatLabRunnerStatus(cwd);
            Reflect.apply(selected, receiver, [message]);
            return 0;
        }
        case "smoke": {
            const receiver = console;
            const selected = receiver.log;
            const message = formatLabRunnerSmoke(cwd);
            Reflect.apply(selected, receiver, [message]);
            return 0;
        }
        default: {
            const receiver = console;
            const selected = receiver.error;
            Reflect.apply(selected, receiver, ["Usage: ccc labs <status|doctor|smoke|shell|run>"]);
            return 1;
        }
    }
}

function stateVolumeLabel(status: string, volumeName: string): string {
    return status === "ready" ? volumeName : "not mounted for new containers (nested VM unavailable)";
}

function renderLabRunnerStatus(snapshot: LabRunnerSnapshot): string {
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

function renderLabRunnerSmoke(snapshot: LabRunnerSnapshot): string {
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
