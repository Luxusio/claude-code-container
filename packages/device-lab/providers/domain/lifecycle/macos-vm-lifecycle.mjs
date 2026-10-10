/** Mutable domain facts retain the native record's open structural shape.
 * @typedef {{host?: string | null, port?: number, user?: string | null, keyPath?: string | null, password?: string | null} & Record<string, unknown>} MacosVmSsh
 * @typedef {{runtimeId: string, operation: string, claimedAt: string, previousStatus?: string}} MacosVmLifecycleClaim
 * @typedef {{runtimeId?: string, providerPid?: number | null, pid?: number, active?: boolean, remotePath?: string} & Record<string, unknown>} MacosVmRuntime
 * @typedef {{id: string, name?: string, provider?: string, providerInstance?: string} & Record<string, unknown>} MacosVmSnapshot
 * @typedef {{candidateProviderInstance?: string | null, supersededCandidateProviderInstances?: string[]} & Record<string, unknown>} MacosVmRecovery
 * @typedef {{ready: boolean, skipped?: boolean, ip?: string} & Record<string, unknown>} MacosVmBoot
 * @typedef {{
 * id: string, name?: string, backend?: string, ownerId?: string, provider?: string | null,
 * providerInstance?: string, providerResourceManaged?: boolean, image?: string | null,
 * memoryMb?: number, cpus?: number, headless?: boolean, softnet?: boolean,
 * ssh?: MacosVmSsh | null, helper?: {provisioning?: unknown} & Record<string, unknown>,
 * status?: string, lifecycle?: MacosVmLifecycleClaim | null, runtime?: MacosVmRuntime | null,
 * recording?: MacosVmRuntime | null, snapshots?: MacosVmSnapshot[], restoreRecovery?: MacosVmRecovery | null,
 * provisioning?: string, imageSource?: string, clonedFrom?: unknown, imageCreatedAt?: string, clonedAt?: string,
 * bootReady?: boolean, lastBootCheck?: MacosVmBoot | null
 * } & Record<string, unknown>} MacosVmDevice
 */

/** @param {MacosVmDevice | null} device
 * @param {string} instance */
export function macosProviderInstanceReferenced(device, instance) {
    if (!device || !instance) return false;
    if (device.providerInstance === instance || device.restoreRecovery?.candidateProviderInstance === instance) return true;
    if ((device.restoreRecovery?.supersededCandidateProviderInstances || []).includes(instance)) return true;
    return (device.snapshots || []).some((snapshot) => snapshot.providerInstance === instance);
}

/** @param {MacosVmDevice} device */
export function managedProviderResource(device) {
    return Boolean(
        device.providerResourceManaged ||
        device.provisioning === "image-created" ||
        device.provisioning === "image-cloned" ||
        device.imageSource ||
        device.clonedFrom ||
        device.imageCreatedAt ||
        device.clonedAt
    );
}

/** @param {MacosVmDevice} device
 * @returns {Array<{kind: string, id?: string, instance: string}>} */
export function snapshotProviderInstances(device) {
    return (Array.isArray(device.snapshots) ? device.snapshots : [])
        .filter((snapshot) => snapshot.provider === "tart" && snapshot.providerInstance)
        .map((snapshot) => ({ kind: "snapshot", id: snapshot.id, instance: /** @type {string} */ (snapshot.providerInstance) }));
}

/** @param {MacosVmDevice} device
 * @returns {Array<{kind: string, id?: string, instance: string}>} */
export function restoreRecoveryProviderInstances(device) {
    const recovery = device.restoreRecovery;
    if (!recovery?.candidateProviderInstance) return [];
    return [recovery.candidateProviderInstance, ...(recovery.supersededCandidateProviderInstances || [])]
        .map((instance) => ({ kind: "restore-recovery", instance }));
}


/** @param {{provider?: string, image?: string | null}} options */
export function usesDefaultTartMacosCredentials({ provider, image }) {
    const selectedProvider = !provider || provider === "auto" ? "tart" : provider;
    if (selectedProvider !== "tart") return false;
    const value = String(image || "");
    return value === "ccc-macos-base" ||
        /^ghcr\.io\/cirruslabs\/macos-[^:]+(?:[:@].*)?$/.test(value) ||
        /^macos-[^-]+-base$/.test(value);
}

/** @param {{sshHost?: string, sshPort?: number, sshUser?: string, sshKeyPath?: string | null, sshPassword?: string, provider?: string, image?: string | null}} options */
export function macosSshConfig({ sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, provider, image }) {
    const useDefaultPassword = usesDefaultTartMacosCredentials({ provider, image }) && !sshHost && !sshUser && !sshKeyPath && !sshPassword;
    return sshHost || sshUser || sshKeyPath || sshPassword || useDefaultPassword ? {
        host: sshHost || null,
        port: sshPort,
        user: sshUser || (useDefaultPassword ? "admin" : null),
        keyPath: sshKeyPath || null,
        password: sshPassword || (useDefaultPassword ? "admin" : null),
    } : null;
}
