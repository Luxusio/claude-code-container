import { resolve } from "path";
import { buildContainerVmRunConfig, buildLabRunnerRunConfig, getContainerName, getLabRunnerStateVolumeName } from "./docker.js";
import { formatRuntimeSummary } from "./container-runtime.js";
import { LAB_RUNNER_PROFILE_NAME, LAB_RUNNER_STATE_CONTAINER_DIR } from "./utils.js";
import { createLabRunnerDiagnostics } from "./application/lab-runner-diagnostics.js";
import type { LabRunnerSnapshot } from "./domain/lab-runner-diagnostics.js";
import type { LabRunnerDiagnosticsPorts } from "./ports/lab-runner-diagnostics.js";
export type { ContainerVmContractSnapshot, LabRunnerSnapshot } from "./domain/lab-runner-diagnostics.js";

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
        get publishOutput() {
            const receiver = console;
            const selected = receiver.log;
            return (message: string): undefined => { Reflect.apply(selected, receiver, [message]); return undefined; };
        },
        get publishUsage() {
            const receiver = console;
            const selected = receiver.error;
            return (message: string): undefined => { Reflect.apply(selected, receiver, [message]); return undefined; };
        },
    };
    return createLabRunnerDiagnostics(ports);
}

export function labRunnerSnapshot(cwd = process.cwd()): LabRunnerSnapshot {
    return nativeDiagnostics().snapshot(cwd);
}
export function formatLabRunnerStatus(cwd = process.cwd()): string {
    return nativeDiagnostics().formatStatus(cwd);
}
export function formatLabRunnerSmoke(cwd = process.cwd()): string {
    return nativeDiagnostics().formatSmoke(cwd);
}
export function labsCli(args: string[], cwd = process.cwd()): number {
    return nativeDiagnostics().cli(args, cwd);
}
