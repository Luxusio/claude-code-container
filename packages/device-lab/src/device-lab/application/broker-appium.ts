import { brokerOwnedAppiumRuntime, validateAppiumParams, isPlainRecord, validateAppiumRequestParams, requestedAppiumPort, appiumAutomationName, appiumProviderName, appiumCapabilities, claimsBrokerOwnedAppiumRuntime, brokerOwnedAppiumEndpoint, brokerLaunchedAppiumServerUrl, appiumMetadata, appiumRuntimeOperationError, appiumParamError, appiumWebDriverRequestTimeoutMs } from "../domain/broker-appium.js";
import type { AppiumParamSuccess, BrokerAppiumResponse, BrokerAppiumBudget, BrokerAppiumRefusal, BrokerAppiumInstrumentationRecovery, BrokerAppiumRuntimeFailure, BrokerAppiumRecordOutcome, BrokerAppiumClearOutcome, BrokerAppiumStartOutcome, BrokerAppiumStopOutcome, BrokerAppiumSessionOutcome, BrokerAppiumDeleteSessionOutcome, BrokerAppiumRequestOutcome } from "../domain/broker-appium.js";
import type { BrokerAppiumPorts, BrokerAppiumTransition, BrokerAppiumVerification } from "../ports/broker-appium.js";
const DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS = 60000;
const DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS = 240000;
const DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS = 300000;
const DEVICE_BROKER_APPIUM_INSTALL_LOCK_WAIT_MS = DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS + 15000;
const DEVICE_BROKER_APPIUM_INSTALL_LOCK_STALE_MS = 15 * 60 * 1000;
const DEVICE_BROKER_APPIUM_LAUNCH_POLICY = "node-direct-hidden-v1";
const DEVICE_BROKER_APPIUM_PORT_SCAN_LIMIT = 128;
const DEVICE_BROKER_APPIUM_AUTO_PORT_MIN = 20000;
const DEVICE_BROKER_APPIUM_AUTO_PORT_MAX = 39999;
type AppiumRequestBudget = BrokerAppiumBudget;

/** Complete Appium policy, sharing native authority and peer locks through explicit capabilities. */
export function createBrokerAppiumApplication<Runtime>(ports: BrokerAppiumPorts<Runtime>) {
    const readOwnerDevices = ports.readDevices, ownerDeviceStateFailure = ports.stateFailure, ownerDeviceNotFound = ports.notFound, transitionOwnerAppiumRuntime = ports.publish;
    const verifyBrokerOwnedAppiumListener = ports.verifyListener, terminateBrokerOwnedAppiumAndWait = ports.terminateRuntime, terminateManagedAppiumPortListener = ports.terminatePortListener;
    const sleep = ports.sleep, withOwnerDeviceOperation = ports.withDeviceOperation, refreshPhysicalDeviceLeaseForOperation = ports.heartbeat;
    const isDeviceOperationLockTimeout = ports.isLockTimeout, deviceOperationLockFailure = ports.lockFailure;
    const ensureBrokerAppiumRuntimeDirectory = ports.ensureRuntimeDirectory, inspectBrokerAppiumRuntimeDirectory = ports.inspectRuntimeDirectory, inspectBrokerAppiumNodeModulesDirectory = ports.inspectNodeModules, brokerAppiumRuntimeEntryIsValid = ports.entryIsValid;
    const DEVICE_BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
    function liveBrokerOwnedAppiumRuntime(appium: unknown) { const runtime = brokerOwnedAppiumRuntime(appium); return Boolean(runtime && (!ports.usesDefaultCommandRunner || ports.isProcessIdentityCurrent(runtime.processIdentity, runtime.pid))); }
    function reusableBrokerOwnedAppium(appium: unknown) { return isPlainRecord(appium) && appium.launchPolicy === DEVICE_BROKER_APPIUM_LAUNCH_POLICY && liveBrokerOwnedAppiumRuntime(appium); }
    function defaultAppiumPort(ownerId: string, backend: string, deviceId: string) { return DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + ports.portSeed(ownerId, backend, deviceId) % (DEVICE_BROKER_APPIUM_AUTO_PORT_MAX - DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + 1); }
    function appiumLiveRuntimeMetadataConflict(ownerId: string, parsed: AppiumParamSuccess, appium: unknown): BrokerAppiumRefusal | null {
        if (!liveBrokerOwnedAppiumRuntime(appium)) return null;
        return {kind: "refused", reason: "conflict", error: "appium-runtime-active", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, remedy: "stop the broker-owned Appium server before replacing or clearing its metadata"};
    }

    function recordAppiumSession(ownerId: string, params: unknown): BrokerAppiumRecordOutcome {
        const parsed = validateAppiumParams(params, "record");
        if (!parsed.ok) return appiumParamError(parsed);
        const metadata = appiumMetadata(params);
        if (!metadata.ok) return {kind: "refused", reason: metadata.reason, error: metadata.error};
        metadata.appium = { ...metadata.appium, runtimeId: ports.runtimeId(), updatedAt: ports.timestamp() };
        let device: unknown;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const currentAppium = (device as Record<string, unknown>).appium ?? null;
        const liveConflict = appiumLiveRuntimeMetadataConflict(ownerId, parsed, currentAppium);
        if (liveConflict) return liveConflict;
        const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, currentAppium, metadata.appium);
        if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition);
        return {kind: "metadata-recorded", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device: transition.device, appium: metadata.appium};
    }

    function clearAppiumSession(ownerId: string, params: unknown): BrokerAppiumClearOutcome {
        const parsed = validateAppiumParams(params, "clear");
        if (!parsed.ok) return appiumParamError(parsed);
        let device: unknown;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const currentAppium = (device as Record<string, unknown>).appium ?? null;
        const liveConflict = appiumLiveRuntimeMetadataConflict(ownerId, parsed, currentAppium);
        if (liveConflict) return liveConflict;
        const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, currentAppium, null);
        if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition);
        return {kind: "metadata-cleared", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device: transition.device, cleared: true};
    }

    async function startAppiumServerUnlocked(ownerId: string, params: unknown): Promise<BrokerAppiumStartOutcome> {
        const parsed = validateAppiumParams(params, "start");
        if (!parsed.ok) return appiumParamError(parsed);
        let devices: unknown[];
        try {
            devices = readOwnerDevices(ownerId, parsed.stateKey);
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const existingAppium = device && typeof device === "object" ? (device as { appium?: unknown }).appium : null;
        const force = (params as { force?: unknown })?.force === true;
        const reusableRuntime = reusableBrokerOwnedAppium(existingAppium);
        const reusableListener = reusableRuntime ? verifyBrokerOwnedAppiumListener(existingAppium) : null;
        const reusable = reusableRuntime && reusableListener?.ok === true;
        if (existingAppium && typeof existingAppium === "object" && !force && reusable) {
            return {kind: "server-reused", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device, appium: existingAppium, started: false, reused: true};
        }
        const replaced = force || (existingAppium && typeof existingAppium === "object" && !reusable)
            ? await terminateBrokerOwnedAppiumAndWait(existingAppium)
            : { attempted: false, ok: true, receipt: null };
        if (!replaced.ok) {
            return {kind: "refused", reason: "provider-failed", error: "appium-existing-process-stop-failed", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium: existingAppium, replaced};
        }
        const record = device as Record<string, unknown>;
        const portSelection = selectAvailableAppiumPort(ownerId, parsed.backend, parsed.deviceId, params, record);
        if (!portSelection.ok) {
            return {kind: "refused", reason: "conflict", error: portSelection.error, ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, portSelection};
        }
        const port = portSelection.port;
        const serverUrl = `http://127.0.0.1:${port}`;
        const runtime = ensureBrokerAppiumRuntime();
        if (!runtime.ok) {
            return {kind: "refused", reason: "provider-failed", error: runtime.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, runtime};
        }
        if (runtime.source === "provider-path") {
            try {
                ensureBrokerAppiumRuntimeDirectory(runtime.handle);
            } catch (error) {
                return {kind: "refused", reason: "provider-failed", error: appiumRuntimeOperationError(error, "appium-runtime-directory-invalid"), ownerId, backend: parsed.backend, deviceId: parsed.deviceId};
            }
        }
        if (runtime.source === "broker-runtime") {
            try {
                if (!inspectBrokerAppiumRuntimeDirectory(runtime.handle) || !brokerAppiumRuntimeEntryIsValid(runtime.handle)) {
                    throw new Error("appium-runtime-entry-invalid");
                }
            } catch (error) {
                return {kind: "refused", reason: "provider-failed", error: appiumRuntimeOperationError(error, "appium-runtime-entry-invalid"), ownerId, backend: parsed.backend, deviceId: parsed.deviceId};
            }
        }
        const portCleanup = terminateManagedAppiumPortListener(port);
        if (!portCleanup.ok) {
            return {kind: "refused", reason: "conflict", error: portCleanup.error || "appium-port-cleanup-failed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, portCleanup};
        }
        const execution = await ports.launchServer(runtime.handle, {backend: parsed.backend, port, timeoutMs: ports.commandTimeoutMs});
        if (!execution.ok) {
            return {kind: "refused", reason: "provider-failed", error: "appium-server-start-failed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, execution};
        }
        const appium = {
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.appium.start",
            runtimeId: ports.runtimeId(),
            launchPolicy: DEVICE_BROKER_APPIUM_LAUNCH_POLICY,
            serverUrl,
            serverPid: execution.pid ?? null,
            ...(execution.processIdentity ? { processIdentity: execution.processIdentity } : {}),
            port,
            automationName: appiumAutomationName(parsed.backend),
            provider: appiumProviderName(parsed.backend),
            physical: parsed.backend.endsWith("-device"),
            updatedAt: ports.timestamp(),
        };
        const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, existingAppium, appium);
        if (!transition.matched) {
            const rollback = await terminateBrokerOwnedAppiumAndWait(appium);
            return {kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, found: transition.found, currentAppium: transition.currentAppium, rollback};
        }
        return {kind: "server-started", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium, started: true, reused: false, replaced, execution, portCleanup, portSelection, runtime: {
                        provisioned: runtime.provisioned,
                        source: runtime.source,
                    }, session: null};
    }

    async function stopAppiumServerUnlocked(ownerId: string, params: unknown): Promise<BrokerAppiumStopOutcome> {
        const parsed = validateAppiumParams(params, "stop");
        if (!parsed.ok) return appiumParamError(parsed);
        let devices: unknown[];
        try {
            devices = readOwnerDevices(ownerId, parsed.stateKey);
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const appium = device && typeof device === "object" ? (device as { appium?: unknown }).appium : null;
        const signal = await terminateBrokerOwnedAppiumAndWait(appium);
        if (!signal.ok) {
            return {kind: "refused", reason: "provider-failed", error: "appium-stop-failed", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium, signal};
        }
        const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, appium, null);
        if (!transition.matched && transition.currentAppium !== null) {
            return {kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, currentAppium: transition.currentAppium, signal};
        }
        return {kind: "server-stopped", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, stopped: true, stalePid: "stale" in signal && signal.stale === true, signal};
    }

    function findOwnerAppiumDevice(ownerId: string, parsed: AppiumParamSuccess) {
        const devices = readOwnerDevices(ownerId, parsed.stateKey);
        const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        return { devices, device };
    }

    function writeUpdatedAppiumDevice(
        ownerId: string,
        parsed: AppiumParamSuccess,
        expected: unknown,
        appium: Record<string, unknown> | null,
    ) {
        return transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, expected, appium);
    }

    function appiumRuntimeStateConflict(ownerId: string, parsed: AppiumParamSuccess, transition: BrokerAppiumTransition, detail: Pick<BrokerAppiumRefusal, "response" | "rollback" | "readiness" | "signal" | "statusObservation" | "sessionObservation"> = {}): BrokerAppiumRefusal {
        return {kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, found: transition.found, currentAppium: transition.currentAppium, ...detail};
    }

    function appiumListenerOwnershipFailure(ownerId: string, parsed: AppiumParamSuccess, verification: BrokerAppiumVerification): BrokerAppiumRefusal {
        return {kind: "refused", reason: "conflict", error: "appium-listener-ownership-unverified", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, verification};
    }

    async function ensureAppiumWebDriverSessionUnlocked(ownerId: string, params: unknown): Promise<BrokerAppiumSessionOutcome> {
        const parsed = validateAppiumParams(params, "session");
        if (!parsed.ok) return appiumParamError(parsed);
        let device: unknown;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        if (parsed.backend === "ios-simulator") {
            const ownedTarget = ports.resolveIosTarget(ownerId, device);
            if (!ownedTarget.ok) {
                return {kind: "refused", reason: "conflict", error: ownedTarget.error, missing: ownedTarget.missing, ownerId, backend: parsed.backend, deviceId: parsed.deviceId};
            }
            device = { ...(device as Record<string, unknown>), udid: ownedTarget.target };
        }

        let appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
            ? { ...((device as { appium: Record<string, unknown> }).appium) }
            : {};
        const force = params && typeof params === "object" && !Array.isArray(params) && (params as { force?: unknown }).force === true;
        const existingEndpoint = brokerOwnedAppiumEndpoint(appium);
        const existingVerification = (claimsBrokerOwnedAppiumRuntime(appium) || existingEndpoint.ok)
            ? verifyBrokerOwnedAppiumListener(appium)
            : null;
        if (existingVerification && !existingVerification.ok) {
            return appiumListenerOwnershipFailure(ownerId, parsed, existingVerification);
        }
        const existingServerUrl = existingVerification?.ok ? existingVerification.serverUrl : null;
        if (existingServerUrl && typeof appium.sessionId === "string" && force) {
            const deleteResponse = await ports.deleteSession(existingServerUrl, appium.sessionId, ports.commandTimeoutMs);
            if (!deleteResponse.ok) {
                return {kind: "session-delete-failed", error: "appium-session-delete-failed", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium, created: false, reused: false, response: deleteResponse};
            }
            const previousAppium = appium;
            appium = { ...appium, sessionId: null, sessionCapabilities: null, updatedAt: ports.timestamp() };
            const transition = writeUpdatedAppiumDevice(ownerId, parsed, previousAppium, appium);
            if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { response: deleteResponse });
        }
        if (existingServerUrl && typeof appium.sessionId === "string" && !force) {
            const status = await ports.status(existingServerUrl, ports.commandTimeoutMs);
            const session = status.ok ? await ports.inspectSession(existingServerUrl, appium.sessionId, ports.commandTimeoutMs) : null;
            if (status.ok && session?.ok) {
                return {kind: "session-reused", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium, reused: true, created: false};
            }
            const previousAppium = appium;
            appium = { ...appium, sessionId: null, sessionCapabilities: null, updatedAt: ports.timestamp() };
            const transition = writeUpdatedAppiumDevice(ownerId, parsed, previousAppium, appium);
            if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { statusObservation: status, sessionObservation: session });
        }

        let startedServer = false;
        if (!brokerLaunchedAppiumServerUrl(appium)) {
            const started = await startAppiumServerUnlocked(ownerId, params);
            if (started.kind !== "server-started" && started.kind !== "server-reused") return started;
            startedServer = true;
            try {
                ({ device } = findOwnerAppiumDevice(ownerId, parsed));
            } catch (error) {
                return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
            }
            appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
                ? { ...((device as { appium: Record<string, unknown> }).appium) }
                : {};
        }

        const listenerVerification = startedServer
            ? await waitForBrokerOwnedAppiumListener(appium)
            : verifyBrokerOwnedAppiumListener(appium);
        if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
        const serverUrl = listenerVerification.serverUrl;
        const readiness = await waitForAppiumServerReady(serverUrl);
        if (!readiness.ok) {
            const signal = await terminateBrokerOwnedAppiumAndWait(appium);
            const transition = signal.ok ? writeUpdatedAppiumDevice(ownerId, parsed, appium, null) : null;
            if (transition && !transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { readiness, signal });
            return {kind: "refused", reason: "provider-failed", error: "appium-server-not-ready", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, readiness, signal};
        }
        const capabilities = appiumCapabilities(parsed.backend, device);
        let response = await ports.createSession(serverUrl, capabilities, DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS);
        let instrumentationRecovery = null;
        if (!response.ok && parsed.backend.startsWith("android") && response.instrumentationInitializationFailed) {
            instrumentationRecovery = resetAndroidAppiumInstrumentation(device);
            if (instrumentationRecovery.attempted) {
                response = await ports.createSession(serverUrl, capabilities, DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS);
            }
        }
        if (!response.ok) {
            return {kind: "refused", reason: "provider-failed", error: "appium-session-create-failed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, response, ...(instrumentationRecovery ? { instrumentationRecovery } : {})};
        }
        const sessionId = response.sessionId;
        if (!sessionId) {
            return {kind: "refused", reason: "provider-failed", error: "appium-session-id-missing", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, response};
        }
        const updatedAppium = {
            ...appium,
            authority: "host-broker",
            sessionId,
            sessionCapabilities: capabilities,
            ...(instrumentationRecovery ? { instrumentationRecovery: { attempted: true, recovered: true, updatedAt: ports.timestamp() } } : {}),
            updatedAt: ports.timestamp(),
        };
        const transition = writeUpdatedAppiumDevice(ownerId, parsed, appium, updatedAppium);
        if (!transition.matched) {
            const rollback = await ports.deleteSession(serverUrl, sessionId, ports.commandTimeoutMs);
            return appiumRuntimeStateConflict(ownerId, parsed, transition, { response, rollback });
        }
        const updatedDevice = transition.device;
        return {kind: "session-created", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device: updatedDevice, appium: updatedAppium, created: true, reused: false, response};
    }

    async function deleteAppiumWebDriverSessionUnlocked(ownerId: string, params: unknown): Promise<BrokerAppiumDeleteSessionOutcome> {
        const parsed = validateAppiumParams(params, "delete-session");
        if (!parsed.ok) return appiumParamError(parsed);
        let device: unknown;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
            ? { ...((device as { appium: Record<string, unknown> }).appium) }
            : null;
        if (!appium || typeof appium.sessionId !== "string") {
            return {kind: "session-deleted", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, deleted: false};
        }
        const listenerVerification = verifyBrokerOwnedAppiumListener(appium);
        if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
        const serverUrl = listenerVerification.serverUrl;
        const response = await ports.deleteSession(serverUrl, appium.sessionId, ports.commandTimeoutMs);
        if (!response.ok) {
            return {kind: "session-delete-failed", error: "appium-session-delete-failed", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, appium, deleted: false, response};
        }
        const { sessionId: _sessionId, sessionCapabilities: _sessionCapabilities, ...remainingAppium } = appium;
        const updatedAppium = { ...remainingAppium, updatedAt: ports.timestamp() };
        const transition = writeUpdatedAppiumDevice(ownerId, parsed, appium, updatedAppium);
        if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { response });
        const updatedDevice = transition.device;
        return {kind: "session-deleted", ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device: updatedDevice, appium: updatedAppium, deleted: response.ok, response};
    }

    function appiumRequestBudgetFailure(): BrokerAppiumRefusal {
        return {kind: "refused", reason: "deadline", error: "appium-request-timeout"};
    }

    async function proxyAppiumWebDriverRequest(ownerId: string, params: unknown, waitBudget?: AppiumRequestBudget): Promise<BrokerAppiumRequestOutcome> {
        const parsed = validateAppiumRequestParams(params);
        if (!parsed.ok) return appiumParamError(parsed);
        let device: unknown;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        const appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
            ? (device as { appium: Record<string, unknown> }).appium
            : null;
        if (!appium || typeof appium.sessionId !== "string") {
            return {kind: "refused", reason: "invalid", error: "missing-appium-session", ownerId, backend: parsed.backend, deviceId: parsed.deviceId};
        }
        const listenerVerification = verifyBrokerOwnedAppiumListener(appium);
        if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
        const serverUrl = listenerVerification.serverUrl;
        const timeoutMs = waitBudget ? Math.ceil(waitBudget.remaining()) : appiumWebDriverRequestTimeoutMs(ports.commandTimeoutMs);
        if (timeoutMs <= 0) return appiumRequestBudgetFailure();
        const response = await ports.sessionCommand(serverUrl, appium.sessionId, {
            method: parsed.method,
            path: parsed.path,
            body: parsed.body,
        }, timeoutMs);
        if (waitBudget && waitBudget.remaining() <= 0) return appiumRequestBudgetFailure();
        return {kind: response.ok ? "request-completed" : "request-failed", ...(response.ok ? {} : { error: "appium-request-failed" }), ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, method: parsed.method, path: parsed.path, response};
    }

    async function withAppiumDeviceOperation<Outcome extends BrokerAppiumResponse>(
        ownerId: string,
        params: unknown,
        action: "record" | "clear" | "start" | "stop" | "session" | "delete-session" | "request",
        operation: (waitBudget?: AppiumRequestBudget) => Promise<Outcome> | Outcome,
    ): Promise<Outcome | BrokerAppiumRefusal> {
        const parsed = action === "request" ? validateAppiumRequestParams(params) : validateAppiumParams(params, action);
        if (!parsed.ok) return appiumParamError(parsed);
        const requestTimeoutMs = action === "request" ? (params as Record<string, unknown>).requestTimeoutMs : undefined;
        const deadline = typeof requestTimeoutMs === "number" ? ports.monotonicNow() + requestTimeoutMs : null;
        const waitBudget = deadline === null ? undefined : { remaining: () => Math.max(0, deadline - ports.monotonicNow()) };
        try {
            return await withOwnerDeviceOperation<Outcome | BrokerAppiumRefusal>(ownerId, parsed.stateKey, parsed.deviceId, () => {
                if (waitBudget && waitBudget.remaining() <= 0) return appiumRequestBudgetFailure();
                if (DEVICE_BROKER_PHYSICAL_BACKENDS.has(parsed.stateKey)
                    && (action === "session" || action === "delete-session" || action === "request")) {
                    let device: unknown;
                    try {
                        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
                    } catch (error) {
                        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                    }
                    if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
                    const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, {
                        stateKey: parsed.stateKey,
                        backend: parsed.backend,
                        device: device as Record<string, unknown>,
                    }, parsed.deviceId, waitBudget);
                    if (leaseFailure) return leaseFailure;
                }
                if (waitBudget && waitBudget.remaining() <= 0) return appiumRequestBudgetFailure();
                return operation(waitBudget);
            }, waitBudget);
        } catch (error) {
            if (!isDeviceOperationLockTimeout(error)) throw error;
            return deviceOperationLockFailure(ownerId, parsed.backend, parsed.deviceId, error);
        }
    }

    async function waitForAppiumServerReady(serverUrl: string, timeoutMs = DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS) {
        const deadline = ports.now() + Math.max(1, timeoutMs);
        let response: Awaited<ReturnType<typeof ports.status>> | null = null;
        while (ports.now() <= deadline) {
            const remainingMs = Math.max(1, deadline - ports.now());
            response = await ports.status(serverUrl, Math.min(2000, remainingMs));
            if (response.ok && response.ready) return { ok: true, response };
            if (ports.now() < deadline) await sleep(Math.min(200, Math.max(1, deadline - ports.now())));
        }
        return { ok: false, response };
    }

    async function waitForBrokerOwnedAppiumListener(
        appium: unknown,
        timeoutMs = DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS,
    ) {
        const deadline = ports.now() + Math.max(1, timeoutMs);
        let verification = verifyBrokerOwnedAppiumListener(appium);
        while (!verification.ok
            && verification.error === "appium-port-listener-unavailable"
            && ports.now() < deadline) {
            await sleep(Math.min(100, Math.max(1, deadline - ports.now())));
            verification = verifyBrokerOwnedAppiumListener(appium);
        }
        return verification;
    }

    function selectAvailableAppiumPort(
        ownerId: string,
        backend: string,
        deviceId: string,
        params: unknown,
        record: Record<string, unknown>,
    ) {
        const explicitPort = requestedAppiumPort(params);
        const preferredPort = explicitPort
            || (typeof record.appiumPort === "number" && Number.isInteger(record.appiumPort) && record.appiumPort > 0 && record.appiumPort <= 65535
                ? record.appiumPort
                : defaultAppiumPort(ownerId, backend, deviceId));
        if (!ports.strictAppiumPortOwnership) {
            return { ok: true as const, port: preferredPort, attempts: [{ port: preferredPort, occupied: false, simulated: true }] };
        }
        const occupied = ports.portListener(preferredPort);
        if (!occupied) return { ok: true as const, port: preferredPort, attempts: [{ port: preferredPort, occupied: false }] };
        if (explicitPort) {
            return {
                ok: false as const,
                error: "appium-port-occupied",
                port: preferredPort,
                listener: occupied,
                attempts: [{ port: preferredPort, occupied: true }],
            };
        }
        const attempts = [{ port: preferredPort, occupied: true }];
        const start = preferredPort >= DEVICE_BROKER_APPIUM_AUTO_PORT_MIN && preferredPort <= DEVICE_BROKER_APPIUM_AUTO_PORT_MAX
            ? preferredPort
            : defaultAppiumPort(ownerId, backend, deviceId);
        const range = DEVICE_BROKER_APPIUM_AUTO_PORT_MAX - DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + 1;
        for (let offset = 1; offset < DEVICE_BROKER_APPIUM_PORT_SCAN_LIMIT; offset += 1) {
            const port = DEVICE_BROKER_APPIUM_AUTO_PORT_MIN
                + ((start - DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + offset) % range);
            const listener = ports.portListener(port);
            attempts.push({ port, occupied: Boolean(listener) });
            if (!listener) return { ok: true as const, port, attempts };
        }
        return { ok: false as const, error: "appium-port-range-exhausted", port: preferredPort, listener: occupied, attempts };
    }

    function resetAndroidAppiumInstrumentation(device: unknown): BrokerAppiumInstrumentationRecovery {
        const available = ports.instrumentationAvailable();
        const serial = field(device, "serial") || (numberField(device, "port") ? `emulator-${numberField(device, "port")}` : null);
        if (!available || !serial) return {attempted: false, ok: false, error: "missing-adb-or-serial", results: []};
        const steps = ["force-stop-server", "force-stop-test", "uninstall-server", "uninstall-test", "uninstall-settings"] as const;
        const results = steps.map(step => ports.resetInstrumentation(serial, step));
        return {attempted: true, ok: true, receipt: ports.instrumentationReceipt(serial), results};
    }

    function ensureBrokerAppiumRuntime(): {ok: true; handle: Runtime; provisioned: boolean; source: "provider-path" | "broker-runtime"} | BrokerAppiumRuntimeFailure {
        const captured = ports.captureRuntime();
        const handle = captured.handle;
        if (captured.kind === "injected") return {ok: true, handle, provisioned: false, source: "provider-path"};
        const receipt = ports.runtimeReceipt(handle);
        const manifests = readRuntimeManifests(handle, receipt);
        if (!manifests.ok) return manifests;
        const manifestHash = ports.manifestDigest(manifests.packageText, manifests.lockText);
        try {
            ensureBrokerAppiumRuntimeDirectory(handle);
            return ports.withInstallLock(() => {
                ensureBrokerAppiumRuntimeDirectory(handle);
                if (!inspectBrokerAppiumRuntimeDirectory(handle)) throw new Error("appium-runtime-directory-invalid");
                try {
                    const marker = ports.readMarker(handle);
                    if (marker !== null && !isPlainRecord(marker)) throw new Error("invalid-appium-runtime-marker");
                    if (isPlainRecord(marker) && marker.manifestHash === manifestHash && brokerAppiumRuntimeEntryIsValid(handle)) {
                        return {ok: true as const, handle, provisioned: false, source: "broker-runtime" as const};
                    }
                } catch {
                    // A linked, malformed, or incomplete runtime is never reused.
                }
                if (!ports.installAvailable(handle)) return {ok: false as const, error: "appium-runtime-npm-missing", receipt};
                inspectBrokerAppiumNodeModulesDirectory(handle);
                ports.writeManifest(handle, "package", manifests.packageText);
                ports.writeManifest(handle, "lock", manifests.lockText);
                try {
                    ports.removeMarker(handle);
                } catch (error) {
                    if (!ports.isMissingFile(error)) throw new Error("appium-runtime-marker-remove-failed");
                }
                const execution = ports.installRuntime(handle, DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS);
                if (!execution.ok || !inspectBrokerAppiumRuntimeDirectory(handle)
                    || !inspectBrokerAppiumNodeModulesDirectory(handle) || !brokerAppiumRuntimeEntryIsValid(handle)) {
                    return {ok: false as const, error: "appium-runtime-install-failed", receipt, execution};
                }
                ports.writeMarker(handle, {manifestHash, installedAt: ports.timestamp()});
                return {ok: true as const, handle, provisioned: true, source: "broker-runtime" as const};
            }, {waitMs: DEVICE_BROKER_APPIUM_INSTALL_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_APPIUM_INSTALL_LOCK_STALE_MS});
        } catch (error) {
            return {ok: false, error: ports.isLockTimeout(error)
                ? "appium-runtime-install-lock-timeout" : appiumRuntimeOperationError(error, "appium-runtime-install-failed"), receipt};
        }
    }

    function field(device: unknown, name: string): string | null {
        if (!device || typeof device !== "object") return null;
        const value = (device as Record<string, unknown>)[name];
        return typeof value === "string" && value ? value : null;
    }
    function numberField(device: unknown, name: string): number | null {
        if (!device || typeof device !== "object") return null;
        const value = (device as Record<string, unknown>)[name];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    function readRuntimeManifests(handle: Runtime, receipt: unknown): {ok: true; packageText: string; lockText: string} | BrokerAppiumRuntimeFailure {
        try {
            const packageText = ports.readManifest(handle, "package");
            const lockText = ports.readManifest(handle, "lock");
            if (packageText === null || lockText === null) return {ok: false, error: "appium-runtime-manifest-missing", receipt};
            for (const text of [packageText, lockText]) {
                if (!isPlainRecord(JSON.parse(text))) throw new Error("invalid-appium-runtime-manifest");
            }
            return {ok: true, packageText, lockText};
        } catch (error) {
            return {ok: false, error: "appium-runtime-manifest-invalid", detail: ports.stateErrorCode(error) || "appium-runtime-manifest-invalid", receipt};
        }
    }
    return {
        start: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "start", () => startAppiumServerUnlocked(ownerId, params)),
        stop: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "stop", () => stopAppiumServerUnlocked(ownerId, params)),
        ensureSession: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "session", () => ensureAppiumWebDriverSessionUnlocked(ownerId, params)),
        deleteSession: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "delete-session", () => deleteAppiumWebDriverSessionUnlocked(ownerId, params)),
        request: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "request", budget => proxyAppiumWebDriverRequest(ownerId, params, budget)),
        record: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "record", () => recordAppiumSession(ownerId, params)),
        clear: (ownerId: string, params: unknown) => withAppiumDeviceOperation(ownerId, params, "clear", () => clearAppiumSession(ownerId, params)),
    };
}
