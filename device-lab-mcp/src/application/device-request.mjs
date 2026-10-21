/** @typedef {import("../ports/device-request.mjs").DeviceArguments} Args */
/** @typedef {import("../ports/device-request.mjs").BrokerObservation} BrokerObservation */
/** @typedef {import("../ports/device-request.mjs").DeviceRequestOptions} Options */
import {
    BROKER_LIFECYCLE_COMMANDS,
    HYPER_V_LIFECYCLE_BACKENDS,
    BROKER_READONLY_DEVICE_TOOLS,
    BROKER_MUTATING_DEVICE_TOOLS,
    BROKER_PHYSICAL_TOOLS,
    BROKER_PHYSICAL_BACKENDS,
    BROKER_RECORDING_DEVICE_TOOLS,
    DEFAULT_BROKER_DISCOVERY_RPC_TIMEOUT_MS,
    HYPER_V_LINUX_GUI_TIMEOUT_MS,
    DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS,
    HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
    HYPER_V_CLEANUP_RESERVE_MS,
    HYPER_V_CREATE_RPC_TIMEOUT_MS,
    HYPER_V_HOST_LOCK_WAIT_MS,
    HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS,
    HYPER_V_MAX_BOOT_TIMEOUT_MS,
    DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS,
    MAX_DEVICE_OPERATION_TIMEOUT_MS,
    MAX_DEVICE_TOOL_RPC_TIMEOUT_MS,
    DIRECT_DEVICE_BACKEND_HINT_TOOLS,
    CURRENT_DISPLAY_DEVICE_ID,
    MOBILE_COMMON_OPERATIONS,
    commonOperation,
    DISPLAY_DEVICE_TOOL_MAP,
    LIFECYCLE_STATE_BACKENDS,
    BROKER_MOBILE_ACTIONS,
    BROKER_BACKEND_MOBILE_TOOLS,
    BROKER_APPIUM_ROUTED_MOBILE_TOOLS,
    DEFAULT_BROKER_APPIUM_RPC_TIMEOUT_MS,
    wantsBrokerLifecycle,
    wantsBrokerDeviceTool,
    optsOutOfImplicitBroker,
    wantsBrokerMobile,
    wantsBrokerPhysical,
    boundedTimeoutMs,
    brokerDeviceToolExecutionTimeout,
    wantsBrokerBackends,
    wantsCurrentDisplayDevice,
    HYPER_V_LINUX_TOOLS,
    isCursorMove,
    requestErrorMessage,
    selectBackendCatalog,
    activeAppMatches,
    selectMobileEffects
} from "../domain/device-request.mjs";
/** @template Result
 * @param {import("../ports/device-request.mjs").DeviceRequestPorts<Result>} ports */
export function createDeviceRequest(ports) {
    /** @param {Args} args */
    function brokerLifecycleExecutionTimeout(args) {
        const hyperVBackend = args?.backend === "windows-vm" || args?.backend === "linux-vm";
        if (hyperVBackend && args?.command === "device_create") {
            return { rpcTimeoutMs: HYPER_V_CREATE_RPC_TIMEOUT_MS };
        }
        if (hyperVBackend) {
            const waitsForBoot = (args?.command === "device_start" || args?.command === "device_reboot")
                && args?.waitForBoot !== false;
            const bootTimeoutMs = waitsForBoot
                ? Number.isFinite(args?.bootTimeoutMs)
                    ? Math.min(HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(args.bootTimeoutMs)))
                    : 5 * 60 * 1000
                : 0;
            // The broker reserves cleanup time on top of the operation deadline for linux-vm AND
            // windows-vm start/reboot, so its outer window is that much longer than the sum below.
            // Without matching it here the caller can time out while containment is still running, and
            // the response carrying scrubContainmentFailed — the one signal that a guest may still be
            // up with a live autologon — is simply lost.
            const containmentReserveMs = waitsForBoot ? HYPER_V_CLEANUP_RESERVE_MS : 0;
            const automaticRpcTimeoutMs = HYPER_V_HOST_LOCK_WAIT_MS
                + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS
                + bootTimeoutMs
                + (waitsForBoot && args?.backend === "linux-vm" ? HYPER_V_LINUX_GUI_TIMEOUT_MS : 0)
                + containmentReserveMs
                + HYPER_V_LIFECYCLE_RPC_BUFFER_MS;
            return { rpcTimeoutMs: automaticRpcTimeoutMs };
        }
        if (Number.isFinite(args?.rpcTimeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS) };
        if (Number.isFinite(args?.timeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS) };
        if (args?.backend === "android-emulator" && args?.createAvd === true) {
            return { rpcTimeoutMs: 315000 };
        }
        if (args?.backend === "android-emulator" && args?.deleteAvd === true) {
            return { rpcTimeoutMs: 135000 };
        }
        if (args?.waitForBoot === true) {
            const bootTimeoutMs = ports.startBootTimeoutMs(args);
            return { rpcTimeoutMs: bootTimeoutMs + 15000 };
        }
        return { rpcTimeoutMs: DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS };
    }


    const DEVICE_REQUIRED_TOOLS = new Set(ports.OPERATION_TOOLS
        .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
        .map((tool) => tool.name));

    DEVICE_REQUIRED_TOOLS.add("device_drag");

    const DEVICE_FLOW_ALLOWED_TOOLS = new Set(ports.DEVICE_FLOW_TOOL_NAMES);

    /** @param {import("../ports/device-request.mjs").DestructiveDecision} policy */
    function policyDeniedResult(policy) {
        return ports.textResult(false, JSON.stringify({ ok: false, policy }, null, 2));
    }

    /** @param {Args} [args] */
    function brokerRouteOptions(args = {}) {
        return { ...args, autolaunch: args?.autolaunch === false ? false : true };
    }

    /** @param {string} name @param {Args} [args] */
    function brokerDeviceToolRouteArgs(name, args = {}) {
        if (name !== "device_wireless") return args;
        return {
            ...args,
            devicePort: args?.port,
            port: Number.isInteger(args?.brokerPort) ? args.brokerPort : undefined,
        };
    }

    /** @param {Args|null} probe @param {BrokerObservation|null} rpcResult */
    function selectedBrokerProbeOptions(probe, rpcResult) {
        const selected = rpcResult?.selection;
        if (!selected?.host || !Number.isInteger(selected.port)) return probe;
        return { ...probe, hostCandidates: [selected.host], port: selected.port };
    }

    /** @param {string} routedBy */
    function implicitBrokerUnavailableResult(routedBy) {
        return ports.jsonResult({
            ok: false,
            error: "broker-runtime-unavailable",
            routedBy,
            detail: "Implicit broker routing was required for this owner-scoped device operation, but no usable broker runtime was available. Use implicitBroker:false only when direct local provider access is intended.",
        });
    }

    /**  @returns {Array<[string, import("../ports/device-request.mjs").DeviceRecord[]]>} */
    function lifecycleBackendDevices() {
        return [
            ["android-emulator", ports.listAndroidDevices()],
            ["android-device", ports.listAndroidRealDevices()],
            ["ios-simulator", ports.listIosDevices({ identityOnly: true })],
            ["ios-device", ports.listIosRealDevices()],
            ["windows-sandbox", ports.listWindowsDevices()],
            ["windows-vm", ports.listWindowsVmDevices()],
            ["macos-vm", ports.listMacosDevices({ identityOnly: true })],
            ["linux-vm", ports.listLinuxVmDevices()],
        ];
    }

    /** @param {boolean} [includeLocalProviders] */
    function directBackendList(includeLocalProviders = true) {
        const display = ports.currentDisplayTarget();
        const android = includeLocalProviders ? ports.androidDiscovery() : null;
        const ios = includeLocalProviders ? ports.iosDiscovery() : null;
        return [
            {
                name: "x11-current-display",
                host: "container",
                creatable: false,
                available: display.available,
                lazy: false,
                capabilities: display.capabilities,
            },
            ...(includeLocalProviders ? [
                ports.androidBackend(android),
                ports.androidRealBackend(android),
                ports.iosBackend(ios),
                ports.iosRealBackend(ports.iosRealDiscovery(ios)),
                ports.windowsBackend(),
                ports.windowsVmBackend(),
                ports.macosBackend(),
            ] : []),
            ports.linuxVmBackend(),
        ];
    }

    /** @param {Args} [args] */
    function brokerDiscoveryExecutionTimeout(args = {}) {
        return {
            rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_DISCOVERY_RPC_TIMEOUT_MS),
        };
    }

    /** @param {Args} [args] @param {Options} [options] @returns {Promise<import("../domain/device-request.mjs").BackendCatalogOutcome>} */
    async function handleDeviceBackends(args = {}, options = {}) {
        const { detail = false } = options;
        const brokerOptOut = optsOutOfImplicitBroker(args);
        const directBackends = directBackendList(brokerOptOut || detail);
        const containerBackends = directBackends.filter((backend) => backend.host === "container");
        const explicitBroker = wantsBrokerBackends(args);
        if (brokerOptOut) {
            const broker = await ports.observeBrokerStatus({ ...args, autolaunch: false, probe: false });
            return { kind: "direct", value: {
                ownerId: ports.ownerId(),
                broker: broker.receipt,
                source: "direct-provider",
                backends: directBackends,
            } };
        }
        const implicitProbe = explicitBroker || brokerOptOut ? null : ports.implicitBrokerProbeOptions(args || {});
        const probe = explicitBroker ? { ...args, probe: true } : implicitProbe;
        const broker = await ports.observeBrokerStatus(probe ? { ...args, ...probe, probe: true } : { ...args, autolaunch: !brokerOptOut, probe: !brokerOptOut });
        if (probe && broker.available) {
            const brokerBackends = await ports.observeBrokerBackends({ ...args, ...probe, ...brokerDiscoveryExecutionTimeout(args) });
            if (brokerBackends.ok && Array.isArray(brokerBackends.backends)) {
                const brokerBackendNames = new Set(brokerBackends.backends.map((backend) => backend?.name).filter(Boolean));
                return { kind: "broker", value: {
                    ownerId: ports.ownerId(),
                    broker: broker.receipt,
                    source: "host-broker-provider-discovery",
                    routedBy: "device-backends-broker",
                    backends: [
                        ...containerBackends.filter((backend) => !brokerBackendNames.has(backend.name)),
                        ...brokerBackends.backends,
                    ],
                    hostBackends: {receipt:brokerBackends.payloadReceipt,backends:brokerBackends.backends},
                    ...(detail ? { localBackends: directBackends } : {}),
                } };
            }
            return { kind: "broker-discovery-failed", value: {
                ok: false,
                ownerId: ports.ownerId(),
                broker: broker.receipt,
                source: "broker-provider-discovery-failed",
                routedBy: "device-backends-broker",
                backends: containerBackends,
                brokerBackendsError: brokerBackends.receipt,
                ...(detail ? { localBackends: directBackends } : {}),
            } };
        }
        return { kind: broker.available ? "discovery-unavailable" : "broker-unavailable", value: {
            ok: false,
            error: broker.available ? "broker-provider-discovery-unavailable" : "broker-unavailable",
            ownerId: ports.ownerId(),
            broker: broker.receipt,
            source: broker.available ? "broker-provider-discovery-failed" : "broker-unavailable",
            routedBy: "device-backends-broker",
            backends: containerBackends,
            ...(detail ? { localBackends: directBackends } : {}),
        } };
    }

    /** @param {string|undefined} deviceId @returns {import("../ports/device-request.mjs").BackendInference} */
    function inferLifecycleBackend(deviceId) {
        if (!deviceId) return { ok: false, error: "missing-device-id" };
        const matches = [];
        for (const [backend, devices] of lifecycleBackendDevices()) {
            if ((devices || []).some((device) => device?.id === deviceId)) matches.push(backend);
        }
        if (matches.length === 1) return { ok: true, backend: matches[0] };
        if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
        return { ok: false, error: "device-backend-not-found" };
    }

    /** @param {import("../ports/device-request.mjs").BrokerInventoryObservation} inventory @param {string|undefined} deviceId @returns {import("../ports/device-request.mjs").BackendInference} */
    function inferBrokerInventoryLifecycleBackend(inventory, deviceId) {
        const matches = [];
        const backends = Array.isArray(inventory?.backends) ? inventory.backends : [];
        for (const entry of backends) {
            const backend = LIFECYCLE_STATE_BACKENDS.get(entry?.stateKey || "");
            if (!backend) continue;
            const devices = Array.isArray(entry?.devices) ? entry.devices : [];
            if (devices.some((device) => device?.id === deviceId)) matches.push(backend);
        }
        if (matches.length === 1) return { ok: true, backend: matches[0] };
        if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
        return { ok: false, error: "device-backend-not-found" };
    }

    /**  @returns {Array<[string, import("../ports/device-request.mjs").DeviceRecord[]]>} */
    function mobileBackendDevices() {
        return [
            ["android-emulator", ports.listAndroidDevices()],
            ["android-device", ports.listAndroidRealDevices()],
            ["ios-simulator", ports.listIosDevices({ identityOnly: true })],
            ["ios-device", ports.listIosRealDevices()],
        ];
    }

    /** @param {string|undefined} deviceId @returns {import("../ports/device-request.mjs").BackendInference} */
    function inferMobileBackend(deviceId) {
        if (!deviceId) return { ok: false, error: "missing-device-id" };
        const matches = [];
        for (const [backend, devices] of mobileBackendDevices()) {
            if ((devices || []).some((device) => device?.id === deviceId)) matches.push(backend);
        }
        if (matches.length === 1) return { ok: true, backend: matches[0] };
        if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
        return { ok: false, error: "device-backend-not-found" };
    }

    /** @param {Args} args */
    function brokerMobileOptions(args) {
        return {
            autolaunch: args?.autolaunch,
            hostCandidates: args?.hostCandidates,
            launchHost: args?.launchHost,
            port: args?.port,
            timeoutMs: args?.timeoutMs,
            rpcTimeoutMs: args?.rpcTimeoutMs,
            launchTimeoutMs: args?.launchTimeoutMs,
            appiumPort: args?.appiumPort,
            serverPort: args?.serverPort,
            automationName: args?.automationName,
            provider: args?.provider,
            physical: args?.physical,
        };
    }

    /** @param {Args} args */
    function brokerAppiumOptions(args) {
        return {
            ...brokerMobileOptions(args),
            rpcTimeoutMs: Number.isFinite(args?.rpcTimeoutMs)
                ? Number(args.rpcTimeoutMs)
                : DEFAULT_BROKER_APPIUM_RPC_TIMEOUT_MS,
        };
    }

    /** @param {Args} args @param {string} backend */
    function appIdForBackend(args, backend) {
        return backend.startsWith("android") ? args?.packageName : args?.bundleId;
    }

    /** @param {string} name @param {Args} args */
    function explicitBackendMismatchResult(name, args) {
        const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
        if (!requestedBackend || !deviceId) return null;
        const inference = BROKER_MOBILE_ACTIONS.has(name)
            ? inferMobileBackend(deviceId)
            : DIRECT_DEVICE_BACKEND_HINT_TOOLS.has(name)
                ? inferLifecycleBackend(deviceId)
                : null;
        if (!inference?.ok || inference.backend === requestedBackend) return null;
        return ports.jsonResult({
            ok: false,
            error: "device-backend-mismatch",
            deviceId,
            requestedBackend,
            actualBackend: inference.backend,
            routedBy: "direct-backend-hint",
        });
    }

    /** @param {string} name @param {Args} [args] */
    async function handleCurrentDisplayDeviceTool(name, args = {}) {
        if (name === "device_status") return ports.jsonResult(ports.currentDisplayTarget());
        const displayTool = DISPLAY_DEVICE_TOOL_MAP.get(name);
        if (!displayTool) return null;
        return ports.handleDisplayTool(displayTool, args);
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result>} */
    async function handleBrokerLifecycleTool(name, args) {
        if (name !== "device_create" && !args?.backend) {
            return /** @type {Result} */ (await maybeHandleImplicitBrokerLifecycleTool(name, { ...args, implicitBroker: true, broker: true, viaBroker: true }));
        }
        const deviceId = typeof args?.deviceId === "string" ? args.deviceId : undefined;
        /** @type {string|import("../ports/device-request.mjs").BackendInference} */
        const backend = typeof args?.backend === "string" && args.backend ? args.backend : name === "device_create" ? { ok: false, error: "missing-backend", matches: [] } : inferLifecycleBackend(deviceId);
        if (typeof backend !== "string" && backend?.ok === false) {
            return ports.jsonResult({
                ok: false,
                error: backend.error,
                deviceId,
                matches: backend.matches || [],
                routedBy: "device-lifecycle-broker",
            });
        }
        const routeArgs = brokerRouteOptions(args);
        let brokerArgs = name === "device_create" ? { ...routeArgs, devicePort: args?.port, port: args?.brokerPort } : routeArgs;
        if (name === "device_create" && ["windows-vm", "linux-vm", "macos-vm"].includes(args.backend || "")) {
            // A selected VM port is HTTP transport, never the Android console port.
            const probe = ports.implicitBrokerProbeOptions({ ...routeArgs, port: args.port ?? args.brokerPort });
            if (!probe) return implicitBrokerUnavailableResult("device-lifecycle-broker");
            brokerArgs = { ...routeArgs, ...probe, devicePort: args.devicePort };
        }
        const result = await ports.invokeBrokerLifecycle({
            ...brokerArgs,
            ...brokerLifecycleExecutionTimeout({ ...args, backend: typeof backend === "string" ? backend : backend.backend, command: name }),
            action: "invoke",
            backend: typeof backend === "string" ? backend : backend.backend,
            command: name,
            deviceId,
            preserveNetwork: args?.preserveNetwork,
            dryRun: args?.dryRun === true,
        });
        return ports.presentBrokerLifecycle(result.receipt, {routedBy:"device-lifecycle-broker",implicit:false});
    }

    /** @param {string} name @param {Args} args @param {BrokerObservation} result */
    function implicitBrokerLifecycleResult(name, args, result) {
        return ports.presentBrokerLifecycle(result.receipt, {
            routedBy:"device-lifecycle-broker-implicit",implicit:true,
            ...(name === "device_delete" ? {deleted:args.deviceId,
                ...(args.deleteAvd === true ? {avdDeleted:true} : {}),
                ...(args.deleteSimulator === true ? {simulatorDeleted:true} : {})} : {}),
        });
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result|null>} */
    async function maybeHandleImplicitBrokerLifecycleTool(name, args) {
        if (!BROKER_LIFECYCLE_COMMANDS.has(name) || optsOutOfImplicitBroker(args)) return null;
        const probe = ports.implicitBrokerProbeOptions(name === "device_create" ? { ...(args || {}), port: undefined } : args || {});
        if (name === "device_create") {
            const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
            if (!requestedBackend || typeof args?.name !== "string" || !args.name.trim()) return null;
            if (!probe) return implicitBrokerUnavailableResult("device-lifecycle-broker-implicit");
            const result = await ports.invokeBrokerLifecycle({
                ...args,
                ...probe,
                ...brokerLifecycleExecutionTimeout({ ...args, backend: requestedBackend, command: name }),
                devicePort: args?.port,
                action: "invoke",
                backend: requestedBackend,
                command: name,
                deviceId: args?.deviceId,
                dryRun: args?.dryRun === true,
            });
            return implicitBrokerLifecycleResult(name, args, result);
        }
        const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
        if (!deviceId) return null;
        if (!probe) return implicitBrokerUnavailableResult("device-lifecycle-broker-implicit");
        const inventory = await ports.observeBrokerInventory({ ...probe });
        if (!inventory.ok) return ports.presentBrokerReceipt(inventory.receipt, {routedBy: "device-lifecycle-broker-implicit"});
        const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
        const explicitHyperVDeleteMiss = name === "device_delete"
            && inventoryBackend.error === "device-backend-not-found"
            && HYPER_V_LIFECYCLE_BACKENDS.has(requestedBackend);
        if (!inventoryBackend.ok) {
            if (inventoryBackend.error === "device-backend-not-found" && !explicitHyperVDeleteMiss) {
                return ports.jsonResult({ ok: false, error: "device-not-found", deviceId, routedBy: "device-lifecycle-broker-implicit" });
            }
            if (!explicitHyperVDeleteMiss) {
                return ports.jsonResult({
                    ok: false,
                    error: inventoryBackend.error,
                    deviceId,
                    matches: inventoryBackend.matches || [],
                    routedBy: "device-lifecycle-broker-implicit",
                });
            }
        }
        const resolvedBackend = explicitHyperVDeleteMiss ? requestedBackend : inventoryBackend.backend;
        if (requestedBackend && requestedBackend !== resolvedBackend) {
            return ports.jsonResult({
                ok: false,
                error: "device-backend-mismatch",
                deviceId,
                requestedBackend,
                actualBackend: resolvedBackend,
                routedBy: "device-lifecycle-broker-implicit",
            });
        }
        const result = await ports.invokeBrokerLifecycle({
            ...args,
            ...selectedBrokerProbeOptions(probe, inventory),
            ...brokerLifecycleExecutionTimeout({ ...args, backend: resolvedBackend, command: name }),
            action: "invoke",
            backend: resolvedBackend,
            command: name,
            deviceId,
            dryRun: args?.dryRun === true,
        });
        return implicitBrokerLifecycleResult(name, args, result);
    }

    /** @param {string} name */
    function brokerPhysicalAction(name) {
        if (name === "device_attach") return "attach";
        if (name === "device_detach") return "detach";
        return "";
    }

    /** @param {Args} [args] */
    function brokerPhysicalProbeArgs(args = {}) {
        return {
            ...(args || {}),
            // device_attach already uses `port` for the Android Wi-Fi device port.
            // device_detach has no device port but still accepts brokerPort for
            // legacy diagnostics. Use brokerPort, when supplied, for probing.
            port: Number.isInteger(args?.brokerPort) ? args.brokerPort : undefined,
        };
    }

    /** @param {string} name @param {Args} args @param {string} backend */
    function brokerPhysicalInvokeArgs(name, args = {}, backend) {
        const action = brokerPhysicalAction(name);
        const result = {
            ...(args || {}),
            action,
            backend,
        };
        if (name === "device_attach") result.devicePort = args?.port;
        if (Number.isInteger(args?.brokerPort)) result.port = args.brokerPort;
        return result;
    }

    /** @param {Args} [args] */
    function brokerPhysicalExecutionTimeout(args = {}) {
        if (Number.isFinite(args?.rpcTimeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS) };
        if (Number.isFinite(args?.timeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS) };
        return { rpcTimeoutMs: DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS };
    }

    /** @param {string} name @param {Args} args @param {Args|null} probe @param {string} routedBy @returns {Promise<import("../ports/device-request.mjs").PhysicalInference<Result>>} */
    async function inferBrokerPhysicalBackend(name, args, probe, routedBy) {
        const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        if (requestedBackend) {
            if (BROKER_PHYSICAL_BACKENDS.has(requestedBackend)) return { ok: true, backend: requestedBackend, inventory: null };
            return { ok: false, handled: true, response: ports.jsonResult({ ok: false, error: "unsupported-physical-backend", backend: requestedBackend, routedBy }) };
        }
        if (name === "device_attach") {
            return { ok: false, handled: true, response: ports.jsonResult({ ok: false, error: "missing-backend", routedBy }) };
        }
        const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
        if (!deviceId) return { ok: false, handled: true, response: ports.jsonResult({ ok: false, error: "missing-device-id", routedBy }) };
        const inventory = await ports.observeBrokerInventory({ ...probe });
        if (!inventory.ok) return { ok: false, handled: true, response: ports.presentBrokerReceipt(inventory.receipt, {routedBy}) };
        const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
        if (!inventoryBackend.ok) {
            if (inventoryBackend.error === "device-backend-not-found") {
                return { ok: false, handled: true, response: ports.jsonResult({ ok: false, error: "device-not-found", deviceId, routedBy }) };
            }
            return {
                ok: false,
                handled: true,
                response: ports.jsonResult({
                    ok: false,
                    error: inventoryBackend.error,
                    deviceId,
                    matches: inventoryBackend.matches || [],
                    routedBy,
                }),
            };
        }
        if (!BROKER_PHYSICAL_BACKENDS.has(inventoryBackend.backend)) {
            return {
                ok: false,
                handled: true,
                response: ports.jsonResult({
                    ok: false,
                    error: "unsupported-physical-backend",
                    deviceId,
                    actualBackend: inventoryBackend.backend,
                    supportedBackends: [...BROKER_PHYSICAL_BACKENDS],
                    routedBy,
                }),
            };
        }
        return { ok: true, backend: inventoryBackend.backend, inventory };
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result>} */
    async function handleBrokerPhysicalTool(name, args) {
        const routedBy = "device-physical-broker";
        const probe = ports.implicitBrokerProbeOptions(brokerPhysicalProbeArgs(args || {}), { allowDefault: true });
        const inference = await inferBrokerPhysicalBackend(name, args, probe, routedBy);
        if (!inference.ok) return inference.response || ports.jsonResult({ ok: false, error: "broker-rpc-unavailable", routedBy });
        const result = await ports.brokerPhysical({
            ...brokerRouteOptions(brokerPhysicalInvokeArgs(name, args, inference.backend)),
            ...selectedBrokerProbeOptions(probe, inference.inventory),
            ...brokerPhysicalExecutionTimeout(args),
        });
        return ports.presentBrokerReceipt(result.receipt, {routedBy});
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result|null>} */
    async function maybeHandleImplicitBrokerPhysicalTool(name, args) {
        if (!BROKER_PHYSICAL_TOOLS.has(name) || optsOutOfImplicitBroker(args)) return null;
        const probe = ports.implicitBrokerProbeOptions(brokerPhysicalProbeArgs(args || {}));
        const routedBy = "device-physical-broker-implicit";
        if (!probe) return implicitBrokerUnavailableResult(routedBy);
        const inference = await inferBrokerPhysicalBackend(name, args, probe, routedBy);
        if (!inference.ok) return inference.handled ? inference.response : null;
        const result = await ports.brokerPhysical({
            ...brokerPhysicalInvokeArgs(name, args, inference.backend),
            ...selectedBrokerProbeOptions(probe, inference.inventory),
            ...brokerPhysicalExecutionTimeout(args),
        });
        return ports.presentBrokerReceipt(result.receipt, {routedBy});
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result>} */
    async function handleBrokerDeviceTool(name, args) {
        if (MOBILE_COMMON_OPERATIONS.has(name) || (args?.deviceId && !args?.backend)) {
            // The shared operation needs the same owner inventory validation as implicit calls.
            return /** @type {Result} */ (await maybeHandleImplicitBrokerDeviceTool(name, { ...args, implicitBroker: true, broker: true, viaBroker: true }));
        }
        const result = await ports.brokerDeviceTool({
            ...brokerRouteOptions(brokerDeviceToolRouteArgs(name, args)),
            ...brokerDeviceToolExecutionTimeout(name, args),
            tool: name,
        });
        return ports.presentBrokerTool(result.receipt, { routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker" : "device-readonly-broker" });
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result|null>} */
    async function maybeHandleImplicitBrokerDeviceTool(name, args) {
        if (!(BROKER_READONLY_DEVICE_TOOLS.has(name) || BROKER_MUTATING_DEVICE_TOOLS.has(name)) || optsOutOfImplicitBroker(args)) return null;
        if (name === "device_inventory" && !(typeof args?.backend === "string" && args.backend)) return null;
        const isUnattachedPhysicalTool = name === "device_wireless" && BROKER_PHYSICAL_BACKENDS.has(args?.backend || "");
        if (name !== "device_inventory" && !isUnattachedPhysicalTool && !(typeof args?.deviceId === "string" && args.deviceId)) return null;
        const routedArgs = brokerDeviceToolRouteArgs(name, args);
        const probe = ports.implicitBrokerProbeOptions(routedArgs);
        if (!probe) return implicitBrokerUnavailableResult(BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit");
        let brokerBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        let inventory = null;
        if (name !== "device_inventory" && !isUnattachedPhysicalTool) {
            inventory = await ports.observeBrokerInventory({ ...probe });
            if (!inventory.ok) return ports.presentBrokerReceipt(inventory.receipt, {routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit"});
            const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, args.deviceId);
            if (!inventoryBackend.ok) {
                if (inventoryBackend.error === "device-backend-not-found") {
                    return ports.jsonResult({
                        ok: false,
                        error: "device-not-found",
                        deviceId: args.deviceId,
                        routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
                    });
                }
                return ports.jsonResult({
                    ok: false,
                    error: inventoryBackend.error,
                    deviceId: args.deviceId,
                    matches: inventoryBackend.matches || [],
                    routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
                });
            }
            if (brokerBackend && brokerBackend !== inventoryBackend.backend) {
                return ports.jsonResult({
                    ok: false,
                    error: "device-backend-mismatch",
                    deviceId: args.deviceId,
                    requestedBackend: brokerBackend,
                    actualBackend: inventoryBackend.backend,
                    routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
                });
            }
            brokerBackend = inventoryBackend.backend;
        }
        if (isCursorMove(name, args) && !["windows-vm", "linux-vm", "windows-sandbox", "macos-vm"].includes(brokerBackend)) {
            return ports.jsonResult({ ok: false, error: "device-cursor-move-backend-unsupported" });
        }
        const common = commonOperation(name, brokerBackend, args);
        if (common.error) return ports.textResult(false, common.error);
        if (common.name !== name && wantsBrokerMobile(common.name, args)) {
            return handleBrokerMobileTool(common.name, {
                ...args, ...selectedBrokerProbeOptions(probe, inventory), backend: brokerBackend,
            });
        }
        const listing = name === "device_list_files";
        if (listing && brokerBackend === "ios-device") return ports.jsonResult({ ok: false, error: "list-files-unsupported", detail: "The current Device Lab physical iOS adapter does not implement file listing.", deviceId: args.deviceId });
        const composedListing = listing && brokerBackend !== "ios-simulator";
        const executionArgs = {
            ...routedArgs,
            ...selectedBrokerProbeOptions(probe, inventory),
            ...brokerDeviceToolExecutionTimeout(name, args),
        };
        const result = composedListing
            ? await ports.invokeBrokerListFiles(executionArgs, brokerBackend)
            : await ports.brokerDeviceTool({
                ...executionArgs,
                ...(brokerBackend ? {backend:brokerBackend} : {}),
                tool:common.name,
            });
        if (composedListing) return ports.listFilesFromExecResult(ports.presentBrokerTool(result.receipt, {}), args);
        const routedBy = BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit";
        return ports.presentBrokerTool(result.receipt, {routedBy,payload:BROKER_RECORDING_DEVICE_TOOLS.has(name)});
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result|null>} */
    async function maybeHandleImplicitBrokerMobileTool(name, args) {
        if (!BROKER_MOBILE_ACTIONS.has(name) || optsOutOfImplicitBroker(args)) return null;
        if (!(typeof args?.deviceId === "string" && args.deviceId)) return null;
        const probe = ports.implicitBrokerProbeOptions(args || {});
        if (!probe) return implicitBrokerUnavailableResult("mobile-device-broker-implicit");
        const inventory = await ports.observeBrokerInventory({ ...probe });
        if (!inventory.ok) return ports.presentBrokerReceipt(inventory.receipt, {routedBy: "mobile-device-broker-implicit"});
        const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, args.deviceId);
        if (!inventoryBackend.ok) {
            if (inventoryBackend.error === "device-backend-not-found") {
                return ports.jsonResult({ ok: false, error: "device-not-found", deviceId: args.deviceId, routedBy: "mobile-device-broker-implicit" });
            }
            return ports.jsonResult({
                ok: false,
                error: inventoryBackend.error,
                deviceId: args.deviceId,
                matches: inventoryBackend.matches || [],
                routedBy: "mobile-device-broker-implicit",
            });
        }
        if (!["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(inventoryBackend.backend)) {
            return ports.jsonResult({
                ok: false,
                error: "unsupported-mobile-backend",
                deviceId: args.deviceId,
                actualBackend: inventoryBackend.backend,
                supportedBackends: ["android-emulator", "android-device", "ios-simulator", "ios-device"],
                routedBy: "mobile-device-broker-implicit",
            });
        }
        const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        if (requestedBackend && requestedBackend !== inventoryBackend.backend) {
            return ports.jsonResult({
                ok: false,
                error: "device-backend-mismatch",
                deviceId: args.deviceId,
                requestedBackend,
                actualBackend: inventoryBackend.backend,
                routedBy: "mobile-device-broker-implicit",
            });
        }
        if (BROKER_APPIUM_ROUTED_MOBILE_TOOLS.has(name)) {
            return handleBrokerMobileTool(name, {
                ...args,
                ...selectedBrokerProbeOptions(probe, inventory),
                backend: inventoryBackend.backend,
            });
        }
        const result = await ports.brokerDeviceTool({
            ...args,
            ...selectedBrokerProbeOptions(probe, inventory),
            ...brokerDeviceToolExecutionTimeout(name, args),
            backend: inventoryBackend.backend,
            tool: name,
        });
        return ports.presentBrokerTool(result.receipt, { routedBy: "mobile-device-broker-implicit" });
    }

    /** @param {string} name @param {Args} args @returns {Promise<Result>} */
    async function handleBrokerMobileTool(name, args) {
        const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
        /** @type {string|import("../ports/device-request.mjs").BackendInference|undefined} */
        let backend = args?.backend;
        if (!backend) {
            const probe = ports.implicitBrokerProbeOptions(args || {}, { allowDefault: true });
            if (!probe) return implicitBrokerUnavailableResult("mobile-broker-appium");
            const inventory = await ports.observeBrokerInventory({ ...probe });
            if (!inventory.ok) return ports.presentBrokerReceipt(inventory.receipt, {routedBy: "mobile-broker-appium"});
            backend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
            args = { ...args, ...selectedBrokerProbeOptions(probe, inventory) };
        }
        if (typeof backend !== "string" && backend?.ok === false) {
            return ports.jsonResult({
                ok: false,
                error: backend.error,
                deviceId,
                matches: backend.matches || [],
                routedBy: "mobile-broker-appium",
            });
        }
        const resolvedBackend = typeof backend === "string" ? backend : backend.backend;
        if (typeof resolvedBackend !== "string"
            || !["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(resolvedBackend)) {
            return ports.jsonResult({ ok: false, error: "unsupported-mobile-backend", deviceId });
        }
        const routeArgs = brokerRouteOptions(args);
        const appiumOptions = brokerAppiumOptions(routeArgs);
        if (name === "mobile_clear_app_data" && resolvedBackend === "ios-device") {
            return ports.textResult(false, "mobile_clear_app_data is not supported by iOS physical devices");
        }
        if (BROKER_BACKEND_MOBILE_TOOLS.has(name)) {
            const result = await ports.brokerDeviceTool({
                ...routeArgs,
                ...brokerDeviceToolExecutionTimeout(name, args),
                backend: resolvedBackend,
                tool: name,
            });
            return ports.presentBrokerTool(result.receipt, { routedBy: "mobile-device-broker" });
        }
        if (name === "mobile_session_status") {
            const result = await ports.observeMobileSessionStatus({
                ...appiumOptions,
                backend: resolvedBackend,
                deviceId,
            });
            return ports.presentBrokerReceipt(result.receipt, {deviceId,routedBy:"mobile-broker-appium"});
        }
        const expectedAppId = appIdForBackend(args, resolvedBackend);
        if (name === "mobile_wait_for_app" && !expectedAppId) {
            return ports.textResult(false, resolvedBackend.startsWith("android") ? "mobile_wait_for_app requires packageName" : "mobile_wait_for_app requires bundleId");
        }
        const mapped = name === "mobile_wait_for_text" || name === "mobile_wait_for_app" ? null : selectMobileEffects(name, args || {}, resolvedBackend);
        if (mapped?.error) return ports.textResult(false, mapped.error);
        const ensure = await ports.ensureMobileSession({
            ...appiumOptions,
            backend: resolvedBackend,
            deviceId,
            force: args?.force === true,
        });
        if (!ensure.ok) return ports.presentBrokerReceipt(ensure.receipt, {routedBy: "mobile-broker-appium"});

        if (name === "mobile_wait_for_text") {
            const text = args?.text;
            if (!text) return ports.textResult(false, "mobile_wait_for_text requires text");
            const wait = ports.createWaitBudget(args?.timeoutMs, args?.intervalMs);
            const timeoutMs = wait.timeoutMs;
            let observed = false;
            let lastSource = "";
            while (wait.remaining() > 0) {
                const requestOptions = {
                    ...selectedBrokerProbeOptions(appiumOptions, ensure),
                    autolaunch: false,
                    requestTimeoutMs: wait.requestTimeout(600000),
                    backend: resolvedBackend,
                    deviceId,
                };
                if (requestOptions.requestTimeoutMs <= 0) break;
                const request = await ports.executeMobileEffect(requestOptions, {kind:"read-source"});
                if (request.kind === "failed") {
                    if (observed && request.localBudgetExhausted) break;
                    return ports.presentBrokerReceipt(request.receipt, {routedBy: "mobile-broker-appium"});
                }
                if (wait.remaining() <= 0) return ports.presentSourceWait({kind:"deadline-during"});
                observed = true;
                lastSource = request.sourceText ?? "";
                if (lastSource.includes(text)) return ports.presentSourceWait({kind:"matched",text,source:lastSource,backend:resolvedBackend,receipt:request.receipt});
                await wait.pause();
            }
            if (!observed) return ports.presentSourceWait({kind:"deadline-before"});
            return ports.presentSourceWait({kind:"unmatched",text,source:lastSource,timeoutMs,backend:resolvedBackend});
        }

        if (name === "mobile_wait_for_app") {
            const wait = ports.createWaitBudget(args?.timeoutMs, args?.intervalMs);
            let observed = false;
            /** @type {unknown} */
            let lastReceipt = null;
            // Admission above guarantees an app identity before session setup.
            const appId = /** @type {string} */ (expectedAppId);
            while (wait.remaining() > 0) {
                const requestOptions = {
                    ...selectedBrokerProbeOptions(appiumOptions, ensure),
                    autolaunch: false,
                    requestTimeoutMs: wait.requestTimeout(600000),
                    backend: resolvedBackend,
                    deviceId,
                    expectedAppId: appId,
                };
                if (requestOptions.requestTimeoutMs <= 0) break;
                const observation = await ports.observeActiveApp(requestOptions);
                if (observation.kind === 'failed') {
                    if (observed && observation.localBudgetExhausted) break;
                    return ports.presentActiveAppWait({kind:'failed-observation',receipt:observation.receipt});
                }
                if (wait.remaining() <= 0) return ports.presentActiveAppWait({kind:'deadline-during'});
                observed = true;
                lastReceipt = observation.receipt;
                if (activeAppMatches(resolvedBackend, appId, observation)) {
                    return ports.presentActiveAppWait({kind:'matched',backend:resolvedBackend,expectedAppId:appId,receipt:observation.receipt});
                }
                await wait.pause();
            }
            if (!observed) return ports.presentActiveAppWait({kind:'deadline-before'});
            return ports.presentActiveAppWait({kind:'unmatched',backend:resolvedBackend,timeoutMs:wait.timeoutMs,receipt:lastReceipt});
        }

        const effects = /** @type {Extract<import("../domain/device-request.mjs").MobileEffectSelection,{effects:unknown}>} */ (mapped).effects;
        /** @type {import("../ports/device-request.mjs").MobileObservation|null} */
        let observation = null;
        for (const effect of effects) {
            observation = await ports.executeMobileEffect({
                ...selectedBrokerProbeOptions(appiumOptions, ensure),
                autolaunch: false, backend: resolvedBackend, deviceId,
            }, effect);
            if (observation.kind === 'failed') return ports.presentBrokerReceipt(observation.receipt,{routedBy:"mobile-broker-appium"});
        }
        const completed = /** @type {Extract<import("../ports/device-request.mjs").MobileObservation,{kind:'completed'}>} */ (observation);
        const appId = appIdForBackend(args, resolvedBackend);
        return ports.presentMobileObservation(name, resolvedBackend, completed, {
            requests: effects.length,
            ...(name === "mobile_open_url" ? { openedUrl: args.url } : {}),
            ...(name === "mobile_install_app" ? { installed: args.path } : {}),
            ...(name === "mobile_launch_app" ? { launched: appId } : {}),
            ...(name === "mobile_uninstall_app" ? { uninstalled: appId } : {}),
            ...(name === "mobile_stop_app" ? { stopped: appId } : {}),
            ...(name === "mobile_set_location" ? { location: { latitude: Number(args.latitude), longitude: Number(args.longitude) } } : {}),
        });
    }

    /** @param {string} name @param {Args} [args] @returns {Promise<Result|null>} */
    async function maybeHandleHyperVLinuxVmTool(name, args = {}) {
        if (args?.backend !== "linux-vm" || !HYPER_V_LINUX_TOOLS.has(name)) return null;
        const explicitHyperVBroker = args?.provider === "hyper-v"
            || wantsBrokerLifecycle(name, args)
            || wantsBrokerDeviceTool(name, args);
        if (explicitHyperVBroker) {
            return BROKER_LIFECYCLE_COMMANDS.has(name)
                ? handleBrokerLifecycleTool(name, args)
                : handleBrokerDeviceTool(name, args);
        }
        if (optsOutOfImplicitBroker(args)) return null;
        const probeArgs = name === "device_create"
            ? { ...(args || {}), port: args?.brokerPort }
            : args || {};
        const probe = ports.implicitBrokerProbeOptions(probeArgs);
        if (!probe) return null;
        const backends = await ports.observeBrokerBackends({ ...probe, ...brokerDiscoveryExecutionTimeout(args) });
        const advertised = backends.ok && Array.isArray(backends.backends)
            ? backends.backends.find((backend) => backend?.name === "linux-vm" && backend?.provider === "hyper-v")
            : null;
        if (!advertised) return null;
        const route = { ...args, ...selectedBrokerProbeOptions(probe, backends), autolaunch: true };
        if (BROKER_LIFECYCLE_COMMANDS.has(name)) return handleBrokerLifecycleTool(name, route);
        return handleBrokerDeviceTool(name, route);
    }

    function directDeviceList() {
        return [
            ports.currentDisplayTarget(),
            ...ports.listAndroidDevices(),
            ...ports.listAndroidRealDevices(),
            ...ports.listIosDevices(),
            ...ports.listIosRealDevices(),
            ...ports.listWindowsDevices(),
            ...ports.listWindowsVmDevices(),
            ...ports.listMacosDevices(),
            ...ports.listLinuxVmDevices(),
        ];
    }

    /** @param {Args} [args] @returns {Promise<Result>} */
    async function handleDeviceList(args = {}) {
        if (!optsOutOfImplicitBroker(args)) {
            const probe = ports.implicitBrokerProbeOptions(args);
            if (probe) {
                const inventory = await ports.observeBrokerInventory({ ...args, ...probe });
                if (!inventory.ok || !Array.isArray(inventory.backends)) {
                    return ports.presentBrokerReceipt(inventory.receipt, {routedBy: "device-list-broker-implicit"});
                }
                const failedBackend = inventory.backends.find((entry) => entry?.error);
                if (failedBackend) {
                    return ports.jsonResult({
                        ok: false,
                        error: failedBackend.error,
                        stateKey: failedBackend.stateKey,
                        routedBy: "device-list-broker-implicit",
                    });
                }
                return ports.jsonResult({
                    ownerId: ports.ownerId(),
                    devices: [
                        ports.currentDisplayTarget(),
                        ...inventory.backends.flatMap((entry) => Array.isArray(entry?.devices) ? entry.devices : []),
                    ].filter((device) => !args.backend || device.backend === args.backend || (args.backend === CURRENT_DISPLAY_DEVICE_ID && device.id === CURRENT_DISPLAY_DEVICE_ID)),
                    routedBy: "device-list-broker-implicit",
                });
            }
        }
        return ports.jsonResult({ ownerId: ports.ownerId(), devices: directDeviceList().filter((device) => !args.backend || device.backend === args.backend || (args.backend === CURRENT_DISPLAY_DEVICE_ID && device.id === CURRENT_DISPLAY_DEVICE_ID)), routedBy: "device-list-direct" });
    }

    /** @param {string} name @param {Args} args */
    function unhandledDeviceToolResult(name, args) {
        if (!DEVICE_REQUIRED_TOOLS.has(name)) return null;
        const deviceId = args.deviceId;
        const detail = "Use devices to choose a device.";
        let diagnostic;
        if (deviceId === undefined) {
            diagnostic = { ok: false, error: "missing-device-id", detail };
        } else {
            // Read only this owner's stored targets; diagnosing an unsupported action
            // must not discover providers or turn an unreadable state into absence.
            const matches = new Set();
            if (deviceId === CURRENT_DISPLAY_DEVICE_ID) matches.add(CURRENT_DISPLAY_DEVICE_ID);
            for (const [stateKey, backend] of LIFECYCLE_STATE_BACKENDS) {
                if (ports.readOwnerDevices(stateKey).some((device) => device.id === deviceId)) matches.add(backend);
            }
            if (ports.listLinuxVmDevices({ strictState: true }).some((device) => device.id === deviceId)) matches.add("linux-vm");
            if (matches.size === 0) {
                diagnostic = { ok: false, error: "device-not-found", deviceId, detail };
            } else if (matches.size > 1) {
                diagnostic = { ok: false, error: "ambiguous-device-backend", deviceId, matches: [...matches] };
            } else {
                diagnostic = { ok: false, error: "device-tool-unsupported", tool: name, deviceId, backend: [...matches][0] };
            }
        }
        return ports.textResult(false, JSON.stringify(diagnostic));
    }

    /** @param {Args} args @param {boolean} detail @returns {Promise<Result>} */
    async function handleFilteredBackends(args, detail) {
        const catalog = await handleDeviceBackends(args, { detail });
        return ports.presentBackendCatalog(selectBackendCatalog(catalog, args.backend));
    }

    /** @param {string} name @param {Args} rawArgs @param {Options} [options] @returns {Promise<Result>} */
    async function dispatchTool(name, rawArgs, options = {}) {
        const { region, ...args } = rawArgs || {};
        const startedAt = ports.now();
        const result = await dispatchDeviceTool(name, args, options);
        if (name === "device_start") return ports.finishStartReadiness(result, args, startedAt,
            (probe, probeArgs) => dispatchDeviceTool(probe, probeArgs, options));
        return name === "device_screenshot" && region !== undefined ? ports.cropScreenshotResult(result, region) : result;
    }

    /** @param {string} name @param {Args} rawArgs @param {Options} [options] @returns {Promise<Result>} */
    async function dispatchDeviceTool(name, rawArgs, options = {}) {
        const { detail = false } = options;
        const args = { ...ports.normalizeToolArgs(rawArgs, name), ...(name === "device_status" && detail ? { detail: true } : {}) };
        if (name === "device_list") return handleDeviceList(args);
        if (name === "device_inventory" && args.backend === undefined) {
            return ports.availableDevices(backend => dispatchDeviceTool(name, { ...args, backend }, { detail }), { detail });
        }
        if (name === "device_backends") return handleFilteredBackends(args, detail);
        if (MOBILE_COMMON_OPERATIONS.has(name) && args.backend !== undefined) {
            const common = commonOperation(name, args.backend, args);
            if (common.error) return ports.textResult(false, common.error);
        }
        if (name === "mobile_key"
            && !(typeof args.key === "string" && args.key.length > 0)
            && !(typeof args.keyCode === "number" && Number.isFinite(args.keyCode))) {
            return ports.textResult(false, "mobile_key requires key or keyCode");
        }
        if (name === "mobile_wait_for_text" && !(typeof args.text === "string" && args.text.length > 0)) {
            return ports.textResult(false, "mobile_wait_for_text requires text");
        }
        if (isCursorMove(name, args)) {
            if (typeof args.x !== "number" || !Number.isInteger(args.x) || args.x < 0
                || typeof args.y !== "number" || !Number.isInteger(args.y) || args.y < 0) {
                return ports.jsonResult({ ok: false, error: "device-cursor-coordinates-invalid", detail: "Provide both x and y as nonnegative screenshot pixels." });
            }
            if (args.deviceId === CURRENT_DISPLAY_DEVICE_ID && (args.backend === undefined || args.backend === CURRENT_DISPLAY_DEVICE_ID)) return /** @type {Result} */ (await ports.handleDisplayTool("display_move", args));

        }
        if (args.deviceId !== undefined
            && (typeof args.deviceId !== "string" || !ports.OWNER_DEVICE_ID_PATTERN.test(args.deviceId))) {
            return ports.textResult(false, JSON.stringify({
                ok: false,
                error: "device-id-invalid",
                deviceId: typeof args.deviceId === "string" ? args.deviceId.slice(0, 128) : null,
            }, null, 2));
        }
        const policy = ports.evaluateDestructivePolicy(name, args);
        if (!policy.ok) return policyDeniedResult(policy);

        if (name === "device_list_files" && args.deviceId === CURRENT_DISPLAY_DEVICE_ID) return ports.jsonResult({ ok: false, error: "list-files-unsupported", detail: "Current-display targets do not provide a filesystem adapter." });
        if (wantsCurrentDisplayDevice(name, args) || (args.deviceId === CURRENT_DISPLAY_DEVICE_ID && DEVICE_REQUIRED_TOOLS.has(name))) {
            if (args.backend !== undefined && args.backend !== CURRENT_DISPLAY_DEVICE_ID) return ports.jsonResult({ ok: false, error: "device-backend-mismatch", actualBackend: CURRENT_DISPLAY_DEVICE_ID });
            const common = commonOperation(name, CURRENT_DISPLAY_DEVICE_ID, args);
            if (common.error) return ports.textResult(false, common.error);
            const displayResult = await handleCurrentDisplayDeviceTool(name, args);
            return /** @type {Result} */ (displayResult ?? ports.textResult(false, JSON.stringify({ ok: false, error: "device-tool-unsupported", tool: name, deviceId: args.deviceId, backend: CURRENT_DISPLAY_DEVICE_ID })));
        }

        // An explicit route must never first offer the target to a local provider.
        if (wantsBrokerLifecycle(name, args)) return handleBrokerLifecycleTool(name, args);
        if (wantsBrokerDeviceTool(name, args)) return handleBrokerDeviceTool(name, args);
        if (wantsBrokerMobile(name, args)) return handleBrokerMobileTool(name, args);
        if (wantsBrokerPhysical(name, args)) return handleBrokerPhysicalTool(name, args);
        if (args.backend === "linux-vm" && args.provider === "hyper-v") {
            const explicitHyperV = await maybeHandleHyperVLinuxVmTool(name, args);
            if (explicitHyperV) return explicitHyperV;
        }

        if (args.broker === true || args.viaBroker === true || args.autolaunch === true) {
            return ports.jsonResult({ ok: false, error: "unsupported-broker-operation", tool: name });
        }

        const localTarget = args.deviceId && args.deviceId !== CURRENT_DISPLAY_DEVICE_ID
            && name !== "device_create" && name !== "device_attach" && HYPER_V_LINUX_TOOLS.has(name)
            ? inferLifecycleBackend(args.deviceId) : null;
        if (localTarget?.error === "ambiguous-device-backend"
            && (optsOutOfImplicitBroker(args) || localTarget.matches?.includes("linux-vm"))) {
            return ports.jsonResult({ ...localTarget, deviceId: args.deviceId });
        }
        const directTarget = optsOutOfImplicitBroker(args) && args.deviceId && args.deviceId !== CURRENT_DISPLAY_DEVICE_ID
            && name !== "device_create" && name !== "device_attach"
            ? localTarget || inferLifecycleBackend(args.deviceId) : null;
        if (directTarget?.error === "ambiguous-device-backend") return ports.jsonResult(directTarget);

        const localLinuxTarget = localTarget?.ok === true && localTarget.backend === "linux-vm";
        if (localLinuxTarget && !optsOutOfImplicitBroker(args)) {
            const probe = ports.implicitBrokerProbeOptions(args);
            if (probe) {
                const routedBy = BROKER_LIFECYCLE_COMMANDS.has(name) ? "device-lifecycle-broker-implicit"
                    : BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit";
                const inventory = await ports.observeBrokerInventory({ ...probe });
                if (!inventory.ok) return ports.presentBrokerReceipt(inventory.receipt, {routedBy});
                if (!Array.isArray(inventory.backends)) {
                    return ports.jsonResult({ ok: false, error: "broker-inventory-invalid", routedBy });
                }
                const failedBackend = inventory.backends.find(entry => entry.error);
                if (failedBackend) return ports.jsonResult({ ok: false, error: failedBackend.error, stateKey: failedBackend.stateKey, routedBy });
                if (inventory.backends.some(entry => !Array.isArray(entry.devices))) {
                    return ports.jsonResult({ ok: false, error: "broker-inventory-invalid", routedBy });
                }
                const unattributedTarget = inventory.backends.some(entry =>
                    Array.isArray(entry.devices) && entry.devices.some(device => device?.id === args.deviceId)
                    && !LIFECYCLE_STATE_BACKENDS.has(entry.stateKey || ""));
                if (unattributedTarget) {
                    return ports.jsonResult({ ok: false, error: "broker-inventory-invalid", deviceId: args.deviceId, routedBy });
                }
                const brokerTarget = inferBrokerInventoryLifecycleBackend(inventory, args.deviceId);
                if (brokerTarget.ok || brokerTarget.error === "ambiguous-device-backend") {
                    return ports.jsonResult({
                        ok: false, error: "ambiguous-device-backend", deviceId: args.deviceId,
                        matches: [...new Set(["linux-vm", ...(brokerTarget.ok ? [brokerTarget.backend] : brokerTarget.matches || [])])],
                        routes: ["direct-provider", "broker"],
                    });
                }
            }
        }

        const explicitMismatch = explicitBackendMismatchResult(name, args);
        if (explicitMismatch) return explicitMismatch;
        if (!localLinuxTarget) {
            const hyperVLinuxResult = await maybeHandleHyperVLinuxVmTool(name, args);
            if (hyperVLinuxResult) return hyperVLinuxResult;
        }
        const linuxVmManagementResult = await ports.handleLinuxVmManagementTool(name, args);
        if (linuxVmManagementResult) return linuxVmManagementResult;
        const linuxVmResult = await ports.handleLinuxVmTool(name, args);
        if (linuxVmResult) return linuxVmResult;

        const implicitBrokerLifecycleResult = await maybeHandleImplicitBrokerLifecycleTool(name, args);
        if (implicitBrokerLifecycleResult) return implicitBrokerLifecycleResult;

        const implicitBrokerPhysicalResult = await maybeHandleImplicitBrokerPhysicalTool(name, args);
        if (implicitBrokerPhysicalResult) return implicitBrokerPhysicalResult;

        const implicitBrokerDeviceResult = await maybeHandleImplicitBrokerDeviceTool(name, args);
        if (implicitBrokerDeviceResult) return implicitBrokerDeviceResult;

        const implicitBrokerMobileResult = await maybeHandleImplicitBrokerMobileTool(name, args);
        if (implicitBrokerMobileResult) return implicitBrokerMobileResult;


        if (MOBILE_COMMON_OPERATIONS.has(name)) {
            const inferred = directTarget || inferLifecycleBackend(args.deviceId);
            if (inferred.error === "ambiguous-device-backend") return ports.jsonResult(inferred);
            const common = commonOperation(name, inferred.ok ? inferred.backend : args.backend, args);
            if (common.error) return ports.textResult(false, common.error);
            name = common.name;
        }

        if (name === "device_list_files") {
            const owner = directTarget || inferLifecycleBackend(args.deviceId);
            if (!owner.ok) return unhandledDeviceToolResult(name, args) || ports.jsonResult(owner);
            if (owner.backend === "ios-device") return ports.jsonResult({ ok: false, error: "list-files-unsupported", detail: "The current Device Lab physical iOS adapter does not implement file listing.", deviceId: args.deviceId });
            if (owner.backend !== "ios-simulator") return ports.listDirectDeviceFiles(args, owner.backend);
        }
        const androidResult = await ports.handleAndroidTool(name, args);
        if (androidResult) return androidResult;

        const androidRealResult = await ports.handleAndroidRealTool(name, args);
        if (androidRealResult) return androidRealResult;

        const iosResult = await ports.handleIosTool(name, args);
        if (iosResult) return iosResult;

        const iosRealResult = await ports.handleIosRealTool(name, args);
        if (iosRealResult) return iosRealResult;

        const windowsResult = await ports.handleWindowsTool(name, args);
        if (windowsResult) return windowsResult;

        const macosResult = await ports.handleMacosTool(name, args);
        if (macosResult) return macosResult;

        const displayResult = await ports.handleDisplayTool(name, args);
        if (displayResult) return displayResult;

        return unhandledDeviceToolResult(name, args) || ports.textResult(false, `Unknown tool: ${name}`);
    }

    /** @param {Args} args @param {Options} options @returns {Promise<Result>} */
    async function handleRunFlow(args, options) {
        return ports.runDeviceFlow(args, options, { toolInputError: ports.toolInputError, flowOperationAllowed: ports.flowOperationAllowed, toolOperation: ports.toolOperation, flowStepArguments: ports.flowStepArguments, normalizePublicToolArgs: ports.normalizePublicToolArgs, withBrokerOperation: ports.withBrokerOperation, dispatchTool, evaluateDestructivePolicy: ports.evaluateDestructivePolicy, policyDeniedResult, actionResult: ports.actionResult,
            unexpectedError: (message) => ports.textResult(false, message),
            textFailure: (message) => ports.textResult(false, message),
            renderFlow: (value, { toolName, detail }) => ports.flowJsonResult(detail ? value : ports.compactToolValue(toolName, value), { detail }),
        });
    }

    /** @param {Args} args @param {Options} options @returns {Promise<Result>} */
    async function handleDeviceRunFlow(args, options) {
        return handleRunFlow(args, { toolName: "device_run_flow", toolAllowed: (name) => DEVICE_FLOW_ALLOWED_TOOLS.has(name), ...options });
    }

    /** @param {string} publicName @param {unknown} [rawArgs] @returns {Promise<Result>} */
    async function request(publicName, rawArgs = {}) {
     const inputError = ports.toolInputError(publicName, rawArgs);
     if (inputError) {
      if (inputError === publicName + " requires confirmDestructive:true") return policyDeniedResult(ports.evaluateDestructivePolicy(ports.toolOperation(publicName, rawArgs), rawArgs));
      return ports.jsonResult({ok:false,error:inputError});
     }
     /** @type {import("../ports/device-request.mjs").DeviceRequest} */
     const selected = {publicName,operation:ports.toolOperation(publicName,rawArgs),arguments:ports.normalizePublicToolArgs(publicName,rawArgs),detail:rawArgs !== null && typeof rawArgs === "object" && Reflect.get(rawArgs, "detail") === true};
     const {operation:name,arguments:args,detail}=selected;
     const result=await ports.withBrokerOperation(async()=>{
      try {
       const policy=ports.evaluateDestructivePolicy(name,args);
       if(!policy.ok)return policyDeniedResult(policy);
       if(name==="device_broker_status")return ports.presentBrokerReceipt((await ports.observeBrokerStatus(args)).receipt,{});
       if(name==="device_run_flow")return await handleDeviceRunFlow(args,{detail});
       return await dispatchTool(name,args,{detail});
      }catch(error){return ports.textResult(false,"Unexpected error: "+requestErrorMessage(error));}
     });
     return name==="device_run_flow"?result:ports.actionResult(publicName,name,result,{detail});
    }
    return {request,dispatch:dispatchTool,dispatchDevice:dispatchDeviceTool,brokerLifecycleExecutionTimeout};
}
