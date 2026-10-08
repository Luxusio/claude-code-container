import { projectLabRunnerContract, renderLabRunnerStatus, renderLabRunnerSmoke } from "../domain/lab-runner-diagnostics.js";
import type { LabRunnerSnapshot } from "../domain/lab-runner-diagnostics.js";
import type { LabRunnerDiagnosticsPorts } from "../ports/lab-runner-diagnostics.js";

/** Require semantic properties without evaluating own or inherited accessors. */
export function createLabRunnerDiagnostics(ports: LabRunnerDiagnosticsPorts) {
    for (const name of ["resolveProjectPath", "containerName", "containerVmConfig", "labRunnerVmConfig", "labProfileName", "stateVolumeName", "stateContainerDir", "runtimeSummary", "publishOutput", "publishUsage"] as const) {
        let target: object | null = ports;
        let descriptor: PropertyDescriptor | undefined;
        while (target != null) {
            descriptor = Object.getOwnPropertyDescriptor(target, name);
            if (descriptor) break;
            target = Object.getPrototypeOf(target);
        }
        if (!descriptor || ("value" in descriptor && typeof descriptor.value !== "function")) throw new TypeError(`Lab runner diagnostics requires ${name}`);
    }
    function snapshot(cwd: string): LabRunnerSnapshot {
        const projectPath = ports.resolveProjectPath(cwd);
        const defaultContainerName = ports.containerName(projectPath);
        const defaultConfig = ports.containerVmConfig(defaultContainerName);
        const containerName = ports.containerName(projectPath, ports.labProfileName());
        const config = ports.labRunnerVmConfig(ports.labProfileName(), containerName) || ports.containerVmConfig(containerName);
        const defaultContainer = projectLabRunnerContract(defaultContainerName, defaultConfig);
        const labRunnerProfile = projectLabRunnerContract(containerName, config);
        return {
            profile: ports.labProfileName(),
            containerName,
            stateVolumeName: ports.stateVolumeName(containerName),
            stateContainerDir: ports.stateContainerDir(),
            status: labRunnerProfile.status,
            unsupportedReason: labRunnerProfile.unsupportedReason,
            kvmDevicePath: labRunnerProfile.kvmDevicePath,
            kvmGroupId: labRunnerProfile.kvmGroupId,
            networkMode: labRunnerProfile.networkMode,
            runtime: ports.runtimeSummary(),
            defaultContainerVmCapable: true,
            defaultContainer,
            labRunnerProfile,
            startCommands: {shell: "ccc labs shell", run: "ccc labs run <command>", status: "ccc labs status"},
        };
    }
    function formatStatus(cwd: string): string { return renderLabRunnerStatus(snapshot(cwd)); }
    function formatSmoke(cwd: string): string { return renderLabRunnerSmoke(snapshot(cwd)); }
    function cli(args: string[], cwd: string): number {
        const command = args[0] || "status";
        switch (command) {
            case "status":
            case "doctor":
                ports.publishOutput(formatStatus(cwd));
                return 0;
            case "smoke":
                ports.publishOutput(formatSmoke(cwd));
                return 0;
            default:
                ports.publishUsage("Usage: ccc labs <status|doctor|smoke|shell|run>");
                return 1;
        }
    }
    return {snapshot, formatStatus, formatSmoke, cli};
}
