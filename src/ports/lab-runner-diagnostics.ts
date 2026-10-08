import type { LabRunnerConfigObservation } from "../domain/lab-runner-diagnostics.js";

export interface LabRunnerDiagnosticsPorts {
    readonly resolveProjectPath: (cwd: string) => string;
    readonly containerName: (project: string, profile?: string) => string;
    readonly containerVmConfig: (container: string) => LabRunnerConfigObservation;
    readonly labRunnerVmConfig: (profile: string, container: string) => LabRunnerConfigObservation | null;
    readonly labProfileName: () => string;
    readonly stateVolumeName: (container: string) => string;
    readonly stateContainerDir: () => string;
    readonly runtimeSummary: () => string;
    readonly publishOutput: (message: string) => undefined;
    readonly publishUsage: (message: string) => undefined;
}
