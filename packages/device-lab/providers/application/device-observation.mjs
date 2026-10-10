import { observationAvailability, simulatorObservationState, publicObservationAndroidDevice, publicObservationMacosDevice, observationMacosPlan, observationLeaseState, observationHardwareId, observationOwnedLease, observationTargetStatus } from "../domain/device-observation.mjs";
import { publicLab } from "../domain/qemu-lifecycle.mjs";
/** @typedef {import('../domain/device-observation.mjs').ObservationTarget} Target */
/** @typedef {import('../domain/device-observation.mjs').ObservationLease} Lease */
/** @typedef {Parameters<typeof observationTargetStatus>[2]} TargetOptions */
/** @param {Target} target @param {TargetOptions} options
 * @param {import('../ports/device-observation.mjs').TargetObservationPorts} ports
 * @param {Map<string,Lease[]>} [snapshots] */
export function normalizeDeviceTarget(target, options = {}, ports, snapshots) {
    let leaseState = options.leaseState;
    if (!leaseState) {
        if (!target?.physical) {
            leaseState = {
                state: "not-required"
            };
        }
        else {
            const backend = target.backend, hardwareId = observationHardwareId(target);
            if (!backend || !hardwareId) {
                leaseState = {
                    state: "unknown",
                    hardwareId
                };
            }
            else {
                let leases = snapshots?.get(backend);
                if (!leases) {
                    leases = ports.readPhysicalLeases(backend);
                    snapshots?.set(backend, leases);
                }
                const owner = ports.ownerId();
                const lease = observationOwnedLease(target, leases, owner);
                leaseState = observationLeaseState(target, lease, typeof lease?.expiresAt === "string" ? ports.now() : 0);
            }
        }
    }
    return observationTargetStatus(target, leaseState, options);
}
/** @template {Target} Device @param {Device} target @param {TargetOptions} options @param {import('../ports/device-observation.mjs').TargetObservationPorts} ports @param {Map<string,Lease[]>} [snapshots] */
export function presentDeviceTarget(target, options = {}, ports, snapshots) {
    const status = normalizeDeviceTarget(target, options, ports, snapshots);
    return {
        ...target,
        ...status,
        targetStatus: status
    };
}
/** @template {Target} Device @param {Device[]} targets @param {TargetOptions} options @param {import('../ports/device-observation.mjs').TargetObservationPorts} ports */
export function presentDeviceTargets(targets, options = {}, ports) {
    /** @type {Map<string,Lease[]>} */
    const snapshots = new Map();
    return targets.map(target => presentDeviceTarget(target, options, ports, snapshots));
}
/** @param {import('../ports/device-observation.mjs').DeviceObservationPorts} ports */
export function createDeviceObservation(ports) {
    /** @template {Target} Device @param {Device} device */
    const target = device => presentDeviceTarget(device, {}, ports);
    /** @template {Target} Device @param {Device[]} devices */
    const targets = devices => presentDeviceTargets(devices, {}, ports);
    /** @param {string} name @param {string} host @param {boolean} creatable @param {{available:boolean,missing:string[]}} facts */
    const backendBase = (name, host, creatable, facts) => ({
        name,
        host,
        creatable,
        available: facts.available,
        lazy: true,
        status: observationAvailability(facts.available),
        missing: facts.missing
    });
    switch (ports.kind) {
        case "android-emulator": {
            const discovery = () => {
                const adb = ports.executable("adb"), emulator = ports.executable("emulator"), avdmanager = ports.executable("avdmanager");
                const missing = [...(adb ? [] : ["adb"]), ...(emulator ? [] : ["emulator"])], provisioningMissing = avdmanager ? [] : ["avdmanager"];
                return {
                    adb,
                    emulator,
                    avdmanager,
                    available: missing.length === 0,
                    missing,
                    provisioningAvailable: provisioningMissing.length === 0,
                    provisioningMissing
                };
            };
            const owned = () => ports.records().map(device => publicObservationAndroidDevice(target({
                ...device,
                ownerId: ports.ownerId()
            })));
            return {
                discovery,
                backend: (facts = discovery()) => ({
                    ...backendBase(ports.kind, "host-or-container", true, facts),
                    tools: {
                        adb: facts.adb,
                        emulator: facts.emulator,
                        avdmanager: facts.avdmanager
                    },
                    provisioning: {
                        available: facts.provisioningAvailable,
                        missing: facts.provisioningMissing
                    },
                    capabilities: ports.capabilities
                }),
                owned,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "android-emulator" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    const owner = ports.ownerId();
                    const devices = owned();
                    const result = facts.emulator ? ports.avdResult(facts.emulator) : null;
                    const hostAvds = !result ? {
                        available: false,
                        missing: ["emulator"],
                        avds: []
                    } : result.status !== 0 ? {
                        available: false,
                        missing: [],
                        avds: [],
                        error: result.stderr || result.stdout || `exit ${result.status}`
                    } : {
                        available: true,
                        missing: [],
                        avds: result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
                    };
                    return {
                        backend,
                        ownerId: owner,
                        devices,
                        hostAvds,
                        ...ports.creationFacts(facts),
                        discovery: facts
                    };
                }
            };
        }
        case "android-device": {
            const discovery = () => ports.androidPrerequisites();
            const owned = () => targets(ports.records().map(device => ({
                ...device,
                ownerId: ports.ownerId()
            })));
            return {
                discovery,
                backend: (facts = discovery()) => {
                    const missing = facts.adb ? [] : ["adb"];
                    return {
                        ...backendBase(ports.kind, "host-usb-adb", false, {
                            available: missing.length === 0,
                            missing
                        }),
                        attachable: true,
                        tools: {
                            adb: facts.adb
                        },
                        capabilities: ports.capabilities
                    };
                },
                owned,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "android-device" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    return {
                        backend,
                        ownerId: ports.ownerId(),
                        devices: owned(),
                        hostDevices: facts.adb ? ports.hostResult(facts.adb) : {
                            available: false,
                            missing: ["adb"],
                            devices: []
                        },
                        discovery: {
                            adb: facts.adb,
                            available: Boolean(facts.adb),
                            missing: facts.adb ? [] : ["adb"]
                        }
                    };
                }
            };
        }
        case "ios-simulator": {
            const discovery = () => {
                const xcrun = ports.executable("xcrun");
                const missing = xcrun ? [] : ["xcrun"];
                return {
                    xcrun,
                    available: missing.length === 0,
                    missing
                };
            };
            /** @param {import('../ports/device-observation.mjs').ObservationRecord} device @param {import('../ports/device-observation.mjs').IosFacts} facts @param {import('../ports/device-observation.mjs').SimulatorObservation} [inventory] */
            const reconcile = (device, facts, inventory) => {
                if (!facts.available || !facts.xcrun) {
                    return device;
                }
                const resolved = ports.ownedTarget(facts.xcrun, device, inventory);
                if (resolved.error || !resolved.simulator) {
                    return device;
                }
                const status = simulatorObservationState(resolved.simulator.state);
                if (status === device.status && resolved.simulator.name === device.simulatorName) {
                    return device;
                }
                return ports.publishObserved(device, status, resolved.simulator.name) || device;
            };
            /** @param {import('../ports/device-observation.mjs').ObservationRecord[]} devices @param {import('../ports/device-observation.mjs').IosFacts} facts @param {import('../ports/device-observation.mjs').SimulatorObservation} [inventory] */
            const project = (devices, facts, inventory) => devices.map(device => target({
                ...reconcile(device, facts, inventory),
                ownerId: ports.ownerId()
            }));
            const owned = ({ identityOnly = false } = {}) => {
                const devices = ports.records();
                if (identityOnly) {
                    return devices;
                }
                if (!devices.length) {
                    return [];
                }
                const facts = discovery();
                const inventory = facts.available && facts.xcrun ? ports.simulators(facts.xcrun, ["list", "devices", "-j"]) : undefined;
                return project(devices, facts, inventory);
            };
            return {
                discovery,
                backend: (facts = discovery()) => ({
                    ...backendBase(ports.kind, "macos-host", true, facts),
                    tools: {
                        xcrun: facts.xcrun
                    },
                    capabilities: ports.capabilities
                }),
                owned,
                reconcile,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "ios-simulator" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    const inventory = facts.available && facts.xcrun ? ports.simulators(facts.xcrun, ["list", "-j"]) : undefined;
                    const owner = ports.ownerId();
                    const devices = project(ports.records(), facts, inventory);
                    const hostSimulators = !facts.available ? {
                        available: false,
                        missing: facts.missing,
                        devices: {},
                        runtimes: [],
                        deviceTypes: []
                    } : inventory?.error ? {
                        available: false,
                        missing: [],
                        devices: {},
                        runtimes: [],
                        deviceTypes: [],
                        error: inventory.error.stderr || inventory.error.stdout || `exit ${inventory.error.status}`
                    } : {
                        available: true,
                        missing: [],
                        devices: inventory?.value.devices || {},
                        runtimes: inventory?.value.runtimes || [],
                        deviceTypes: inventory?.value.devicetypes || inventory?.value.deviceTypes || []
                    };
                    return {
                        backend,
                        ownerId: owner,
                        devices,
                        hostSimulators,
                        discovery: facts
                    };
                }
            };
        }
        case "ios-device": {
            const discovery = (ios = ports.simulatorPrerequisites()) => {
                const xcodebuild = ports.executable("xcodebuild");
                const missing = [...ios.missing];
                return {
                    xcrun: ios.xcrun,
                    xcodebuild,
                    available: missing.length === 0,
                    missing
                };
            };
            const owned = () => targets(ports.records().map(device => ({
                ...device,
                ownerId: ports.ownerId()
            })));
            return {
                discovery,
                backend: (facts = discovery()) => ({
                    ...backendBase(ports.kind, "macos-host-usb-xcode", false, facts),
                    attachable: true,
                    tools: {
                        xcrun: facts.xcrun,
                        xcodebuild: facts.xcodebuild
                    },
                    capabilities: ports.capabilities
                }),
                owned,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "ios-device" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    const owner = ports.ownerId();
                    const devices = owned();
                    const result = facts.xcrun ? ports.hostResult(facts.xcrun) : null;
                    const hostDevices = !result ? {
                        available: false,
                        missing: ["xcrun"],
                        devices: []
                    } : result.status !== 0 ? {
                        available: false,
                        missing: [],
                        devices: [],
                        error: result.stderr || result.stdout || `exit ${result.status}`
                    } : {
                        available: true,
                        missing: [],
                        devices: result.devices
                    };
                    return {
                        backend,
                        ownerId: owner,
                        devices,
                        hostDevices,
                        discovery: facts
                    };
                }
            };
        }
        case "windows-sandbox": {
            const discovery = () => {
                const wsb = ports.executable("wsb");
                const missing = wsb ? [] : ["wsb"];
                return {
                    wsb,
                    available: missing.length === 0,
                    missing
                };
            };
            const owned = () => ports.records().map(device => target({
                ...device,
                ownerId: ports.ownerId()
            }));
            return {
                discovery,
                backend: (facts = discovery()) => ({
                    ...backendBase(ports.kind, "windows-host", true, facts),
                    tools: {
                        wsb: facts.wsb
                    },
                    capabilities: ports.capabilities
                }),
                owned,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "windows-sandbox" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    return {
                        ownerId: ports.ownerId(),
                        backend,
                        devices: ports.records().map(device => target({
                            ...device,
                            ownerId: ports.ownerId(),
                            helper: ports.helperMetadata(device),
                            configPath: ports.configPath(device)
                        })),
                        discovery: facts,
                        hostSandboxes: {
                            provider: "wsb",
                            available: facts.available,
                            command: facts.wsb,
                            missing: facts.missing,
                            lazy: true,
                            singleton: true,
                            lock: ports.singleton(),
                            note: "Windows Sandbox does not expose a stable all-sandbox inventory through the baseline wsb CLI; owner definitions are listed without starting sandboxes."
                        }
                    };
                }
            };
        }
        case "windows-vm": {
            const discovery = () => {
                const hostSupported = ports.platform === "win32";
                const powershell = hostSupported ? (ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell")) : null;
                const missing = [...(hostSupported ? [] : ["windows-host"]), ...(hostSupported && !powershell ? ["powershell"] : [])];
                return {
                    hostSupported,
                    powershell,
                    available: missing.length === 0,
                    missing
                };
            };
            return {
                discovery,
                backend: () => {
                    const facts = discovery();
                    return {
                        ...backendBase(ports.kind, "windows-host", true, facts),
                        provider: "hyper-v",
                        tools: {
                            powershell: facts.powershell
                        },
                        capabilities: ports.capabilities
                    };
                },
                owned: () => ports.records(),
                inventory: () => undefined
            };
        }
        case "macos-vm": {
            const discovery = () => {
                const hostSupported = ports.platform === "darwin";
                const providers = hostSupported ? ports.providerNames.map(name => ({
                    name,
                    command: ports.executable(name)
                })).filter(provider => provider.command !== null).map(provider => ({
                    name: provider.name,
                    command: provider.command || ""
                })) : [];
                const missing = [...(hostSupported ? [] : ["macos-host"]), ...(hostSupported && !providers.length ? ["macos-vm-provider"] : [])];
                return {
                    hostSupported,
                    providers,
                    available: hostSupported && providers.length > 0,
                    missing
                };
            };
            /** @param {import('../domain/lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device @param {import('../ports/device-observation.mjs').MacosFacts} facts */
            const plan = (device, facts) => observationMacosPlan(device, facts, ports.ownerId(), ports.helperPaths(device));
            /** @param {import('../domain/lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice} device @param {import('../ports/device-observation.mjs').MacosFacts} facts */
            const project = (device, facts) => {
                const presented = publicObservationMacosDevice(device);
                return target({
                    ...presented,
                    providerPlan: plan(presented, facts)
                });
            };
            const owned = ({ identityOnly = false } = {}) => {
                const devices = ports.records();
                if (identityOnly) {
                    return devices;
                }
                if (!devices.length) {
                    return [];
                }
                const facts = discovery();
                return devices.map(device => project({
                    ...device,
                    ownerId: ports.ownerId()
                }, facts));
            };
            return {
                discovery,
                backend: (facts = discovery()) => ({
                    ...backendBase(ports.kind, "macos-host", true, facts),
                    providers: facts.providers,
                    capabilities: ports.capabilities
                }),
                owned,
                plan,
                project,
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    const { backend = "macos-vm" } = args;
                    if (backend !== ports.kind) {
                        return undefined;
                    }
                    const facts = discovery();
                    return {
                        ownerId: ports.ownerId(),
                        backend,
                        devices: ports.records().map(device => project({
                            ...device,
                            ownerId: ports.ownerId()
                        }, facts)),
                        discovery: facts,
                        hostVms: {
                            providers: facts.providers.map(provider => ({
                                name: provider.name,
                                command: provider.command
                            })),
                            available: facts.available,
                            missing: facts.missing,
                            lazy: true,
                            note: "Provider discovery checks command availability only; VM list/start operations are not run by inventory."
                        }
                    };
                }
            };
        }
        case "linux-vm": {
            /** @returns {import('../ports/device-observation.mjs').LinuxProviderStatus} */
            const discovery = () => {
                const facts = ports.runnerFacts();
                let status = "unsupported", reason = "";
                if (facts.runner !== "1") {
                    reason = "CCC_LAB_RUNNER is not enabled for this container";
                }
                else if (facts.runnerStatus !== "ready") {
                    reason = facts.unsupportedReason || `lab-runner status is ${facts.runnerStatus || "unset"}`;
                }
                else if (!facts.kvmAvailable) {
                    reason = `${facts.kvmPath} is not available`;
                }
                else if (!facts.qemu) {
                    reason = "qemu-system-x86_64 is not available";
                }
                else {
                    status = "ready";
                }
                return {
                    ok: true,
                    provider: "container-qemu",
                    available: status === "ready",
                    status,
                    unsupportedReason: reason || null,
                    ownerId: facts.ownerId,
                    stateRoot: facts.stateRoot,
                    qemu: facts.qemu,
                    qemuImg: facts.qemuImg,
                    kvmPath: facts.kvmPath,
                    networkMode: "user"
                };
            };
            const labs = ({ strictState = false } = {}) => {
                if (!ports.labsRootExists()) {
                    return {
                        ok: true,
                        ownerId: ports.ownerId(),
                        labs: []
                    };
                }
                const labs = ports.labEntries().filter(entry => entry.isDirectory()).map(entry => {
                    try {
                        const loaded = ports.readLab(entry.name);
                        return loaded.ok && loaded.lab ? loaded.lab : null;
                    }
                    catch {
                        if (strictState === true) {
                            throw new Error("lab-state-invalid");
                        }
                        return null;
                    }
                }).filter(lab => lab !== null).map(lab => publicLab(lab));
                return {
                    ok: true,
                    ownerId: ports.ownerId(),
                    labs
                };
            };
            /** @param {import('../domain/qemu-lifecycle.mjs').QemuLab} lab */
            const device = lab => ({
                ...lab,
                deviceId: lab.id,
                backend: "linux-vm",
                provider: lab.provider || "container-qemu",
                capabilities: ports.capabilities
            });
            return {
                discovery,
                backend: () => {
                    const status = discovery();
                    return {
                        ...backendBase(ports.kind, "container", true, {
                            available: status.available,
                            missing: status.available ? [] : [status.unsupportedReason].filter(reason => reason !== null)
                        }),
                        status: status.status,
                        provider: "container-qemu",
                        capabilities: ports.capabilities
                    };
                },
                labs,
                owned: (options = {}) => labs(options).labs.map(device),
                inventory: /** @param {{backend?:string}} [args] */ (args = {}) => {
                    if (args.backend !== ports.kind) {
                        return undefined;
                    }
                    const status = discovery();
                    const result = labs();
                    return {
                        ...result,
                        backend: "linux-vm",
                        devices: result.labs.map(device),
                        discovery: status
                    };
                }
            };
        }
    }
}
