// Public remote facade; native authority is composed here without cached owner binding.
import { createRemoteServices } from "./application/remote-services.js";
import { createNativeRemoteServicesPorts } from "./adapters/remote-services.js";

export { isValidHostOrUser, shellEscapeArg } from "./domain/remote-services.js";
export { isValidEnvKey } from "./utils.js";
export { getProjectHash, getMutagenSessionName } from "./adapters/remote-services.js";
export { remoteLifecycleShell, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell, remoteClaudeDirScript, remoteContainerStartScript } from "./adapters/remote-shell.js";

const services = createRemoteServices(createNativeRemoteServicesPorts());
export const checkTailscale = () => services.checkTailscale();
export const checkMutagen = () => services.checkMutagen();
export function isHostReachable(host: string): boolean { return services.isHostReachable(host); }
export function getMutagenSyncStatus(sessionName: string): string | null { return services.getMutagenSyncStatus(sessionName); }
// Reuse the actual async functions so delegation adds no Promise adoption turn.
export const remoteExec = services.remoteExec;
export const remoteSetup = services.remoteSetup;
export const remoteCheck = services.remoteCheck;
export const remoteTerminate = services.remoteTerminate;
