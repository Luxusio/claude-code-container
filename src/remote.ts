// Public remote facade composes application policy with native services.
import { createRemoteServices } from "./application/remote-services.js";
import { createNativeRemoteServicesPorts, renderMutagenSyncStatus } from "./adapters/remote-services.js";

export { isValidHostOrUser } from "./domain/remote-services.js";
export { shellEscapeArg } from "./adapters/remote-shell.js";
export { isValidEnvKey } from "./utils.js";
export { getProjectHash, getMutagenSessionName } from "./adapters/remote-services.js";
export { remoteLifecycleShell, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell, remoteClaudeDirScript, remoteContainerStartScript } from "./adapters/remote-shell.js";

const ports = createNativeRemoteServicesPorts();
const services = createRemoteServices(ports);
export const checkTailscale = () => services.checkTailscale();
export const checkMutagen = () => services.checkMutagen();
export function isHostReachable(host: string): boolean { return services.isHostReachable(host); }
export function getMutagenSyncStatus(sessionName: string): string | null { return renderMutagenSyncStatus(ports.observeSync(sessionName)); }
export const remoteExec = services.remoteExec;
export const remoteSetup = services.remoteSetup;
export const remoteCheck = services.remoteCheck;
export const remoteTerminate = services.remoteTerminate;
