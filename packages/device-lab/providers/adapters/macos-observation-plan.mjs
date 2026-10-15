import { observationMacosHelper, observationMacosSelection } from "../domain/device-observation.mjs";

export * from "../domain/device-observation.mjs";

/** @param {string} provider @param {string} instance @param {{softnet?:boolean,headless?:boolean}} [options] */
export function observationMacosStartArgs(provider, instance, options = {}) {
    return provider === "tart"
        ? ["run", ...(options.softnet ? ["--with-softnet"] : []), ...(options.headless ? ["--no-graphics"] : []), instance]
        : ["start", instance];
}

/** @param {import('../domain/lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device
 * @param {import('../domain/device-observation.mjs').MacosObservationSelection} selection
 * @param {import('../ports/device-observation.mjs').MacosFacts} discovery
 * @param {import('../ports/device-observation.mjs').MacosHelperPaths} paths */
export function materializeMacosObservationPlan(device, selection, discovery, paths) {
    const selected = discovery.providers[selection.providerIndex];
    const command = selected?.command || null;
    const instance = selection.providerInstance;
    const evidence = {
        requestedProvider: selection.requestedProvider,
        selectedProvider: selection.selectedProvider,
        providerCommand: command,
        providerInstance: instance,
        workspaceDir: paths.workspaceDir,
        image: device.image || null,
        memoryMb: device.memoryMb,
        cpus: device.cpus,
        helper: observationMacosHelper(device, paths),
        available: selection.available,
        missing: selection.missing,
        startCommand: selection.implemented && command ? {
            command,
            args: observationMacosStartArgs(selection.selectedProvider || "", instance, device)
        } : null,
        stopCommand: selection.implemented && command ? { command, args: ["stop", instance] } : null,
        deleteCommand: selection.implemented && command ? { command, args: ["delete", instance] } : null,
        implemented: selection.selectedProvider === "tart" ? ["base-image-create", "base-image-clone", "snapshot-clone", "snapshot-restore", "snapshot-delete", "provider-delete"] : [],
        deferred: selection.deferred
    };
    return {
        available: selection.available,
        missing: selection.missing,
        selectedProvider: selection.selectedProvider,
        providerInstance: instance,
        stopAvailable: Boolean(evidence.stopCommand),
        evidence
    };
}

/** @param {import('../domain/lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device
 * @param {{hostSupported:boolean,providers:{name:string,command:string}[],missing:string[]}} discovery
 * @param {string} ownerId @param {import('../ports/device-observation.mjs').MacosHelperPaths} paths */
export function observationMacosPlan(device, discovery, ownerId, paths) {
    const selection = observationMacosSelection(device, {
        ...discovery,
        providers: discovery.providers.map(provider => ({ name: provider.name, available: Boolean(provider.command) }))
    }, ownerId);
    return materializeMacosObservationPlan(device, selection, { ...discovery, available: discovery.hostSupported && discovery.providers.length > 0 }, paths).evidence;
}
