// Public remote facade composes application policy with native services.
import { createRemoteServices } from "./application/remote-services.js";
import { createNativeRemoteServicesPorts, projectRemoteExecutionOutcome, projectRemoteTerminateOutcome, renderMutagenSyncStatus } from "./adapters/remote-services.js";

export { isValidHostOrUser } from "./domain/remote-services.js";
export { shellEscapeArg } from "./adapters/remote-shell.js";
export { isValidEnvKey } from "./utils.js";
export { getProjectHash, getMutagenSessionName } from "./adapters/remote-services.js";
export { remoteLifecycleShell, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell, remoteClaudeDirScript, remoteContainerStartScript } from "./adapters/remote-shell.js";

const nativeServices = () => createRemoteServices(createNativeRemoteServicesPorts());
export const checkTailscale = () => nativeServices().checkTailscale();
export const checkMutagen = () => nativeServices().checkMutagen();
export function isHostReachable(host: string): boolean { return nativeServices().isHostReachable(host); }
export function getMutagenSyncStatus(sessionName: string): string | null {
    const ports = createNativeRemoteServicesPorts();
    return renderMutagenSyncStatus(ports.observeSyncInventory(), sessionName);
}
export async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<void> {
    projectRemoteExecutionOutcome(await nativeServices().remoteExec(projectPath, host, args));
}
export function remoteSetup(): Promise<void> { return nativeServices().remoteSetup(); }
export function remoteCheck(projectPath: string): Promise<void> { return nativeServices().remoteCheck(projectPath); }
export async function remoteTerminate(projectPath: string): Promise<void> {
    projectRemoteTerminateOutcome(await nativeServices().remoteTerminate(projectPath));
}
