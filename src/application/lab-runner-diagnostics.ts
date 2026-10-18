import { projectLabRunnerContract } from "../domain/lab-runner-diagnostics.js";
import type { LabRunnerConfigurationSnapshot } from "../domain/lab-runner-diagnostics.js";
import type { LabRunnerDiagnosticsPorts } from "../ports/lab-runner-diagnostics.js";

/** Require semantic properties without evaluating own or inherited accessors. */
export function createLabRunnerDiagnostics(ports: LabRunnerDiagnosticsPorts) {
    for (const name of ["resolveProjectPath", "containerName", "containerVmConfig", "labRunnerVmConfig", "labProfileName", "stateVolumeName", "stateContainerDir", "runtimeSummary"] as const) {
        let target: object | null = ports;
        let descriptor: PropertyDescriptor | undefined;
        while (target != null) {
            descriptor = Object.getOwnPropertyDescriptor(target, name);
            if (descriptor) break;
            target = Object.getPrototypeOf(target);
        }
        if (!descriptor || ("value" in descriptor && typeof descriptor.value !== "function")) throw new TypeError(`Lab runner diagnostics requires ${name}`);
    }
    function snapshot(cwd: string): LabRunnerConfigurationSnapshot {
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
        };
    }
    return {snapshot};
}
