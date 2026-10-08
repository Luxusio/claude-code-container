import type { DoctorProbeResult, DoctorRuntimeInfo } from "../domain/doctor.js";

export interface DoctorLocksDirectory {
    exists(): boolean;
    readNames(): string[];
}

/** Required semantic observations; no native defaults or arbitrary command execution. */
export interface DoctorPorts {
    resolveProjectPath(projectPath: string): string;
    projectId(fullPath: string): string;
    containerName(fullPath: string): string;
    runtimeInfo(): DoctorRuntimeInfo;
    daemonRunning(): boolean;
    runtimeVersion(): DoctorProbeResult;
    imageExists(): boolean;
    imageLabel(): string | null;
    cliVersion: string;
    containerRunning(containerName: string): boolean;
    containerExists(containerName: string): boolean;
    identityMiseVolumeName(): string;
    inspectMiseVolume(volumeName: string): DoctorProbeResult;
    observeActiveSessions(projectId: string): string[];
    captureLocksDirectory(): DoctorLocksDirectory;
    runtimeCli(): string;
    claudeLauncherReport(containerName: string): DoctorProbeResult;
    /** Select native callee/receiver before evaluating the publication argument. */
    capturePublication(): (computedText: string) => undefined;
    /** Lazy callee selection precedes reading its message argument. */
    readonly sanitizeForTerminal: (message: string) => string;
}
