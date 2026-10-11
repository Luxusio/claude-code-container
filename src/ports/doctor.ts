import type { DoctorImageObservation, DoctorLauncherObservation, DoctorRuntimeInfo } from "../domain/doctor.js";

/** Required synchronous observations; no native process receipts or presentation. */
export interface DoctorPorts {
    runtimeInfo(): DoctorRuntimeInfo;
    daemonRunning(): boolean;
    runtimeVersion(): string | null;
    image(): DoctorImageObservation;
    readonly cliVersion: string;
    containerRunning(containerName: string): boolean;
    containerExists(containerName: string): boolean;
    miseCache(): { volumeName: string; exists: boolean };
    activeSessionCount(projectId: string): number;
    lockNames(): readonly string[];
    claudeLauncherReport(containerName: string): DoctorLauncherObservation;
}
