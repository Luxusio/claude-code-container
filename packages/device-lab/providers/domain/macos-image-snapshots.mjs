/** @typedef {import("./lifecycle/macos-vm-lifecycle.mjs").MacosVmDevice} MacosVmDevice */
/** @typedef {import("./lifecycle/macos-vm-lifecycle.mjs").MacosVmSnapshot} MacosVmSnapshot */
/** @param {MacosVmDevice|null|undefined} source @param {string|undefined} sourceId @param {boolean} force */
export function macosCloneSourceRefusal(source, sourceId, force) {
    if (source?.lifecycle) {
        return `Refusing to clone ${sourceId} while lifecycle operation ${source.lifecycle.operation || "unknown"} is active`;
    }
    if (source && source.status !== "stopped" && !force) {
        return `Refusing to clone ${sourceId} while status is ${source.status}; stop it first or pass force=true.`;
    }
    return undefined;
}
/** @param {MacosVmDevice} device @param {string|undefined} snapshotName @param {string|null|undefined} wantedId */
export function selectMacosSnapshot(device, snapshotName, wantedId) {
    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];
    return snapshots.find(snapshot => snapshot.id === wantedId || snapshot.name === snapshotName);
}
/** @param {MacosVmDevice} device @param {MacosVmSnapshot} snapshot */
export function macosRestoreCandidate(device, snapshot) {
    const recovery = device.restoreRecovery;
    return recovery?.candidateProviderInstance
        && recovery.snapshotId === snapshot.id && recovery.snapshotName === snapshot.name
        ? recovery.candidateProviderInstance : undefined;
}
/** @param {{id:string,name?:string,provider?:string|null,image?:string|null,memoryMb:number,cpus:number,ssh:import("./lifecycle/macos-vm-lifecycle.mjs").MacosVmSsh|null,extra?:Partial<MacosVmDevice>}} options
 * @param {{ownerId:string,helper:MacosVmDevice["helper"],createdAt:string,updatedAt:string}} facts */
export function defineMacosImageDevice({ id, name, provider, image, memoryMb, cpus, ssh, extra = {} }, facts) {
    return {
        id, name, backend: "macos-vm", kind: "desktop", platform: "macos", ownerId: facts.ownerId,
        provider, image, memoryMb, cpus, providerInstance: `ccc-${facts.ownerId}-${id}`,
        ssh, helper: facts.helper, status: "stopped", creatable: true, snapshots: [], recording: null,
        ...extra, createdAt: facts.createdAt, updatedAt: facts.updatedAt
    };
}
/** @param {{available:boolean,missing:string[],selectedProvider:string|null}} plan
 * @param {{provider?:string|null}} device @param {string} tool */
export function macosImageProviderRefusal(plan, device, tool) {
    if (!plan.available) {
        return `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`;
    }
    if (plan.selectedProvider !== "tart") {
        return `macOS VM ${tool} is not supported for provider ${plan.selectedProvider || device.provider || "auto"}; Tart is currently required for image and snapshot operations.`;
    }
    return undefined;
}
