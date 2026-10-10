/** @typedef {{id?:string,backend?:string,kind?:string,physical?:boolean,available?:boolean,status?:string,lifecycle?:string|{runtimeId?:string,operation?:string}|null,creatable?:boolean,attachable?:boolean,hardwareId?:string,serial?:string,udid?:string,appium?:{serverUrl?:string,serverPid?:number,sessionId?:string,updatedAt?:string}|null,recording?:{active?:boolean,provider?:string,startedAt?:string}|null,helper?:object|null}} ObservationTarget */
/** @typedef {{hardwareId:string,ownerId:string,deviceId?:string,expiresAt?:string,heartbeatAt?:string}} ObservationLease */
/** @typedef {{state:string,reason?:string}} ObservationReadiness */
/** @typedef {{state:string,hardwareId?:string|null,ownerId?:string,deviceId?:string|null,expiresAt?:string|null,heartbeatAt?:string|null}} ObservationLeaseState */
/** @param {boolean} available */
export function observationAvailability(available) {
    return available ? "available" : "missing-prerequisites";
}
/** @param {string|undefined} state */
export function simulatorObservationState(state) {
    return !state ? "unknown" : String(state).toLowerCase() === "booted" ? "booted" : "stopped";
}
/** @template {{avdRoot?:string}} Device @param {Device} device */
export function publicObservationAndroidDevice(device) {
    const result = {
        ...device
    };
    delete result.avdRoot;
    return result;
}
/** @param {import('./lifecycle/macos-vm-lifecycle.mjs').MacosVmSsh|null|undefined} ssh */
export function publicObservationSsh(ssh) {
    if (!ssh) {
        return null;
    }
    const { password, ...result } = ssh;
    return password ? {
        ...result,
        passwordConfigured: true
    } : result;
}
/** @template {import('./lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} Device @param {Device} device */
export function publicObservationMacosDevice(device) {
    return {
        ...device,
        ssh: publicObservationSsh(device.ssh)
    };
}
/** @param {import('./lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device
 * @param {{workspaceDir:string,toolsDir:string,hostHelperScript:string}} paths */
export function observationMacosHelper(device, paths) {
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const provisioning = device.helper?.provisioning || null;
    const bridgeConfigured = Boolean(device.ssh?.host && device.ssh?.user);
    return {
        ...paths,
        remoteScriptPath,
        bridge: bridgeConfigured ? "ssh" : "missing",
        ssh: publicObservationSsh(device.ssh),
        status: (provisioning && typeof provisioning === "object" && "status" in provisioning ? provisioning.status : null) || (bridgeConfigured ? "ssh-configured" : "planned"),
        provisioning,
        requiredFor: ["device_focus_window", "device_drag", "device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_accessibility_snapshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"]
    };
}
/** @param {string} provider @param {string} instance @param {{softnet?:boolean,headless?:boolean}} [options] */
export function observationMacosStartArgs(provider, instance, options = {}) {
    return provider === "tart"
        ? ["run", ...(options.softnet ? ["--with-softnet"] : []), ...(options.headless ? ["--no-graphics"] : []), instance]
        : ["start", instance];
}
/** @param {import('./lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device
 * @param {{hostSupported:boolean,providers:{name:string,command:string}[],missing:string[]}} discovery
 * @param {string} ownerId @param {{workspaceDir:string,toolsDir:string,hostHelperScript:string}} paths */
export function observationMacosPlan(device, discovery, ownerId, paths) {
    const requestedProvider = device.provider || "auto";
    const selected = requestedProvider === "auto" ? discovery.providers[0] : discovery.providers.find(provider => provider.name === requestedProvider);
    const implemented = selected && ["tart", "vz", "utmctl"].includes(selected.name);
    const instance = device.providerInstance || `ccc-${ownerId}-${device.id}`;
    const missing = [...discovery.missing];
    if (discovery.hostSupported && !selected) {
        const reason = requestedProvider === "auto" ? "macos-vm-provider" : `macos-vm-provider:${requestedProvider}`;
        if (!missing.includes(reason)) {
            missing.push(reason);
        }
    }
    const command = selected?.command || null;
    const startArgs = observationMacosStartArgs(selected?.name || "", instance, device);
    return {
        requestedProvider,
        selectedProvider: selected?.name || null,
        providerCommand: command,
        providerInstance: instance,
        workspaceDir: paths.workspaceDir,
        image: device.image || null,
        memoryMb: device.memoryMb,
        cpus: device.cpus,
        helper: observationMacosHelper(device, paths),
        available: missing.length === 0 && Boolean(implemented && command),
        missing,
        startCommand: implemented && command ? {
            command,
            args: startArgs
        } : null,
        stopCommand: implemented && command ? {
            command,
            args: ["stop", instance]
        } : null,
        deleteCommand: implemented && command ? {
            command,
            args: ["delete", instance]
        } : null,
        implemented: selected?.name === "tart" ? ["base-image-create", "base-image-clone", "snapshot-clone", "snapshot-restore", "snapshot-delete", "provider-delete"] : [],
        deferred: device.ssh ? [] : ["guest-helper-auto-provisioning-requires-ssh"]
    };
}
/** @param {ObservationTarget} target */
export function observationRuntimeState(target) {
    return target?.lifecycle || target?.status || (target?.available === false ? "unavailable" : target?.available === true ? "available" : "unknown");
}
/** @param {ObservationTarget} target @param {ReturnType<typeof observationRuntimeState>} runtimeState @returns {ObservationReadiness} */
export function observationReadiness(target, runtimeState) {
    if (target?.available === false) {
        return {
            state: "unavailable",
            reason: "missing-prerequisites"
        };
    }
    if (typeof runtimeState === "string" && ["running", "booted", "attached", "current", "available"].includes(runtimeState)) {
        return {
            state: "ready"
        };
    }
    if (typeof runtimeState === "string" && ["stopped", "shutdown"].includes(runtimeState)) {
        return {
            state: "stopped"
        };
    }
    return {
        state: "unknown"
    };
}
/** @param {ObservationTarget} target */
export function observationHardwareId(target) {
    return target?.hardwareId || target?.serial || target?.udid || null;
}
/** @param {ObservationTarget} target @param {ObservationLease[]} leases @param {string} ownerId */
export function observationOwnedLease(target, leases, ownerId) {
    const hardwareId = observationHardwareId(target);
    return leases.find(entry => entry.hardwareId === hardwareId && entry.ownerId === ownerId);
}
/** @param {ObservationTarget} target @param {ObservationLease|undefined} lease @param {number} now @returns {ObservationLeaseState} */
export function observationLeaseState(target, lease, now) {
    if (!target?.physical) {
        return { state: "not-required" };
    }
    const hardwareId = observationHardwareId(target);
    if (!target?.backend || !hardwareId) {
        return { state: "unknown", hardwareId };
    }
    if (!lease) {
        return { state: "missing", hardwareId };
    }
    return {
        state: typeof lease.expiresAt === "string" && Date.parse(lease.expiresAt) <= now ? "expired" : "owned",
        ownerId: lease.ownerId,
        hardwareId,
        deviceId: lease.deviceId || target?.id || null,
        expiresAt: lease.expiresAt || null,
        heartbeatAt: lease.heartbeatAt || null
    };
}
/** @param {ObservationTarget} target */
export function observationSessionState(target) {
    const appium = target?.appium || null, recording = target?.recording || null, helper = target?.helper || null;
    const helperStatus = helper && "status" in helper ? helper.status : null;
    const provisioning = helper && "provisioning" in helper && helper.provisioning && typeof helper.provisioning === "object" ? helper.provisioning : null;
    return {
        state: appium?.sessionId || appium?.serverPid || recording?.active ? "active" : "none",
        appium: appium ? {
            serverUrl: appium.serverUrl || null,
            serverPid: appium.serverPid || null,
            sessionId: appium.sessionId || null,
            updatedAt: appium.updatedAt || null
        } : null,
        recording: recording ? {
            active: Boolean(recording.active),
            provider: recording.provider || null,
            startedAt: recording.startedAt || null
        } : null,
        helper: helper ? {
            status: helperStatus || (provisioning && "status" in provisioning ? provisioning.status : null) || null,
            provider: (provisioning && "provider" in provisioning ? provisioning.provider : null) || null
        } : null
    };
}
/** @param {ObservationTarget} target @param {ObservationLeaseState} leaseState
 * @param {{runtimeState?:ReturnType<typeof observationRuntimeState>,targetKind?:string,creatable?:boolean,attachable?:boolean,readiness?:ObservationReadiness,leaseState?:ObservationLeaseState,sessionState?:ReturnType<typeof observationSessionState>}} [options] */
export function observationTargetStatus(target, leaseState, options = {}) {
    const runtimeState = options.runtimeState || observationRuntimeState(target);
    return {
        targetKind: options.targetKind || (target?.backend === "x11" || target?.kind === "display" ? "current-display" : target?.physical ? "physical-device" : "virtual-device"),
        creatable: Boolean(options.creatable ?? target?.creatable),
        attachable: Boolean(options.attachable ?? target?.attachable),
        runtimeState,
        readiness: options.readiness || observationReadiness(target, runtimeState),
        leaseState: options.leaseState || leaseState,
        sessionState: options.sessionState || observationSessionState(target)
    };
}
