import { renderStageCleanupFailure } from "../adapters/stage-cleanup-result.mjs";
import { performIosControl, createIosSimulatorNative } from "../adapters/ios-control-transfer.mjs";
import { createDirectRecording } from "../adapters/direct-recording.mjs";
import { createIosObservationAccess } from "../application/ios-observation-access.mjs";
import { iosControlOrientation, iosContainerRelativePathAllowed } from "../domain/ios-control-transfer.mjs";
import { createIosControlTransfer } from "../application/ios-control-transfer.mjs";
import { createIosAppManagement } from "../application/ios-app-management.mjs";
import { createIosEnvironment } from "../application/ios-environment.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { simulatorObservation, presentSimulatorCatalog } from "../adapters/mobile-inventory.mjs";
import { simulatorObservationState } from "../domain/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createIosSimulatorLifecycle } from "../application/lifecycle/ios-simulator-lifecycle.mjs";
import { listContainedDirectory, validateListFilesArgs } from "../file-listing.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { constants, homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "path";
import { commandPath, localBinPath, run, runWithInput, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult, truncateDiagnosticText } from "../responses.mjs";
import { screenshotFileResult } from "../screenshot-file.mjs";
import { claimIosDevice, findIosDevice, readIosDevices, transitionIosDevice, updateIosDevice } from "../state/ios-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcess, waitForProcessIdentity } from "../state/process-identity.mjs";
import { appiumGenerationMatches, transitionAppiumGeneration } from "../state/runtime-generation.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, copyStagedInputFile, createLocalOutputStage, discardLocalOutputStage, populateLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

/** @type {import('../ports/direct-recording.mjs').DirectRecordingNative} */
const recordingNative = {
    kind: 'ios-simulator', findDevice: findIosDevice, updateDevice: updateIosDevice,
    localPath: iosRecordingLocalPath, validateLocalOutputPath, recordingDirectory: iosRecordingDir,
    resolveTarget(device) {
        const discovery = iosDiscovery();
        if (!discovery.available) return { kind: 'native', value: missingPrereqResult(discovery) };
        const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
        if (ownedTarget.error) return { kind: 'failure', message: ownedTarget.error };
        return { kind: 'ready', device, target: { kind: 'simulator', executable: discovery.xcrun, target: ownedTarget.target } };
    },
};
const directRecording = createDirectRecording(recordingNative);
/** @param {import('../domain/direct-recording.mjs').RecordingOutcome|undefined} outcome
 * @returns {unknown} */
function presentRecordingOutcome(outcome) {
    if (!outcome || outcome.kind === 'missing') return undefined;
    if (outcome.kind === 'cleanup-failure') {
        const primary = outcome.primary;
        return renderStageCleanupFailure({
            error: 'recording-stage-cleanup-failed',
            primary: primary.kind === 'thrown' ? primary
                : { kind: 'returned', outcome: primary.kind, result: presentRecordingOutcome(primary) },
            cleanupError: outcome.error,
            ...(primary.kind === 'success' || Object.keys(outcome.facts).length
                ? { result: { ...outcome.facts, ...(primary.kind === 'success' ? { kind: 'completed', completed: true } : {}) } } : {}),
        }, jsonResult);
    }
    if (outcome.kind === 'failure') return textResult(false, outcome.message);
    if (outcome.kind === 'native') return outcome.value;
    return jsonResult(outcome.value);
}


const IOS_APPIUM_HTTP_TIMEOUT_MS = 5000;
export const IOS_APPIUM_HTTP_MAX_TIMEOUT_MS = 300000;
export const IOS_APPIUM_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const IOS_APPIUM_ERROR_TEXT_LIMIT_BYTES = 32 * 1024;

export function iosDiscovery() { return deviceObservation.discovery(); }

/** @param {import("../ports/device-observation.mjs").IosFacts & {xcodebuild?: string | null}} [ios] */
export function iosAppiumDiscovery(ios = iosDiscovery()) {
    const appium = localBinPath("appium") || commandPath("appium");
    const xcuitestDriver = localBinPath("appium-xcuitest-driver") || commandPath("appium-xcuitest-driver");
    const xcodebuild = Object.hasOwn(ios, "xcodebuild") ? ios.xcodebuild : commandPath("xcodebuild");
    const missing = [...ios.missing];
    if (!appium) missing.push("appium");
    if (!xcuitestDriver) missing.push("appium-xcuitest-driver");
    if (!xcodebuild) missing.push("xcodebuild");
    return {
        appium,
        xcuitestDriver,
        xcodebuild,
        xcrun: ios.xcrun,
        available: missing.length === 0,
        missing,
    };
}

export function normalizeIosOrientation(orientation) {
    return iosControlOrientation(orientation);
}

export function iosBackend(discovery = iosDiscovery()) { return deviceObservation.backend(discovery); }

function iosDeviceId(name) {
    return `ios-${slug(name)}`;
}

function iosRecordingDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "ios", device.id, "recordings");
}

function iosRecordingLocalPath(device) {
    return join(iosRecordingDir(device), `recording-${Date.now()}.mp4`);
}

function appiumPortForIosDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:ios:${id}`).digest();
    return 30000 + (hash.readUInt16BE(0) % 10000);
}

function ownerSimulatorPrefix() {
    return `ccc-${ownerId()}-`;
}

function isOwnedSimulatorName(name) {
    return typeof name === "string" && name.startsWith(ownerSimulatorPrefix());
}

function missingPrereqResult(discovery) {
    return textResult(false, `iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
}

function unsupportedIosResult(tool, reason) {
    return textResult(false, `iOS Simulator ${tool} is not supported through base simctl in this slice: ${reason}`);
}

function missingIosAppiumResult(discovery) {
    return textResult(false, `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}`);
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (!processIsAlive(pid)) return true;
        await sleep(50);
    }
    return !processIsAlive(pid);
}

async function terminateOwnedAppiumProcess(appium, label, timeoutMs = 1000) {
    return terminateOwnedRuntimeProcess({ ...appium, pid: appium?.serverPid }, label, { timeoutMs });
}

async function deleteAppiumSession(appium) { return createObservationAccess().deleteSession(appium); }

async function stopOwnedAppium(appium, label) { return createObservationAccess().stopOwnedAppium(appium, label); }

function boundedIosAppiumErrorText(text, maxBytes = IOS_APPIUM_ERROR_TEXT_LIMIT_BYTES) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    const suffix = "...[truncated]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    let prefix = bytes.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8");
    while (Buffer.byteLength(prefix, "utf8") + suffixBytes > maxBytes) {
        prefix = prefix.slice(0, -1);
    }
    return `${prefix}${suffix}`;
}

function iosAppiumHttpError(status, text) {
    const prefix = `HTTP ${status}: `;
    const remaining = IOS_APPIUM_ERROR_TEXT_LIMIT_BYTES - Buffer.byteLength(prefix, "utf8");
    return new Error(`${prefix}${boundedIosAppiumErrorText(text, remaining)}`);
}

export function normalizeIosAppiumHttpTimeoutMs(timeoutMs) {
    const requestedTimeoutMs = Number(timeoutMs);
    return Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? Math.min(IOS_APPIUM_HTTP_MAX_TIMEOUT_MS, requestedTimeoutMs)
        : IOS_APPIUM_HTTP_TIMEOUT_MS;
}

async function readBoundedIosAppiumResponse(response) {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(IOS_APPIUM_RESPONSE_LIMIT_BYTES)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Appium response exceeded ${IOS_APPIUM_RESPONSE_LIMIT_BYTES} bytes`);
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > IOS_APPIUM_RESPONSE_LIMIT_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`Appium response exceeded ${IOS_APPIUM_RESPONSE_LIMIT_BYTES} bytes`);
            }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total).toString("utf8");
    } finally {
        reader.releaseLock();
    }
}

export async function fetchIosAppiumJson(url, options = {}) {
    const { timeoutMs = IOS_APPIUM_HTTP_TIMEOUT_MS, ...requestOptions } = options;
    const boundedTimeoutMs = normalizeIosAppiumHttpTimeoutMs(timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
    try {
        const response = await fetch(url, {
            ...requestOptions,
            signal: controller.signal,
            redirect: "manual",
            headers: {
                "Content-Type": "application/json",
                ...(requestOptions.headers || {}),
            },
        });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Appium redirect disallowed (HTTP ${response.status})`);
        }
        const text = await readBoundedIosAppiumResponse(response);
        let payload = {};
        if (text) {
            try { payload = JSON.parse(text); } catch { payload = { raw: boundedIosAppiumErrorText(text) }; }
        }
        if (!response.ok) throw iosAppiumHttpError(response.status, text);
        return payload;
    } catch (error) {
        if (error?.name === "AbortError") throw new Error(`Appium request timed out after ${boundedTimeoutMs}ms: ${url}`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** @template {import('../ports/ios-observation-access.mjs').IosAccessAppiumEffect} Effect
 * @param {Effect} effect
 * @returns {Promise<import('../ports/ios-observation-access.mjs').IosAccessAppiumResult<Effect>>} */
export async function performIosAppiumEffect(effect) {
    const sessionUrl = "sessionId" in effect ? `${effect.serverUrl}/session/${effect.sessionId}` : `${effect.serverUrl}/session`;
    const url = effect.kind === "server-status" ? `${effect.serverUrl}/status`
        : effect.kind === "source" || effect.kind === "screenshot" ? `${sessionUrl}/${effect.kind}`
        : effect.kind === "active-app" ? `${sessionUrl}/execute/sync` : sessionUrl;
    const options = effect.kind === "create-session" ? { method: "POST", body: JSON.stringify({ capabilities: { alwaysMatch: {
        platformName: "iOS", "appium:automationName": "XCUITest", "appium:deviceName": effect.deviceName,
        "appium:udid": effect.target, ...(effect.physical ? { "appium:realDevice": true } : {}),
    } } }) } : effect.kind === "active-app" ? { method: "POST", body: JSON.stringify({ script: "mobile: activeAppInfo", args: [] }), timeoutMs: effect.timeoutMs }
        : { method: effect.kind === "delete-session" ? "DELETE" : "GET", ...("timeoutMs" in effect ? { timeoutMs: effect.timeoutMs } : {}) };
    const response = await fetchIosAppiumJson(url, options);
    const value = response?.value ?? response;
    const result = effect.kind === "create-session" ? { sessionId: typeof value?.sessionId === "string" && value.sessionId ? value.sessionId : typeof response?.sessionId === "string" && response.sessionId ? response.sessionId : null }
        : effect.kind === "source" ? { source: response?.value ?? response?.source ?? response }
        : effect.kind === "screenshot" ? { data: response?.value || response?.screenshot || undefined }
        : effect.kind === "active-app" ? { bundleIds: [value?.bundleId, value?.bundleID].filter((bundleId) => typeof bundleId === "string"), activeApp: value } : undefined;
    return /** @type {import('../ports/ios-observation-access.mjs').IosAccessAppiumResult<Effect>} */ (result);
}

export async function waitForIosApp(xcrun, target, bundleId, timeoutMs = 10000, intervalMs = 500) { return createObservationAccess(xcrun).waitForApp(target, bundleId, timeoutMs, intervalMs); }

async function ensureIosAppiumSession(deviceId) { return createObservationAccess().ensureSession(deviceId); }

function guardIosObservation(deviceId, original, session) {
    const current = findIosDevice(deviceId);
    if (!current || current.udid !== original.udid
        || current.simulatorName !== original.simulatorName
        || current.createdAt !== original.createdAt
        || current.lifecycle?.runtimeId !== original.lifecycle?.runtimeId
        || !appiumGenerationMatches(session.device?.appium, current.appium)
        || current.appium?.serverUrl !== session.serverUrl
        || current.appium?.sessionId !== session.sessionId) {
        throw new Error("iOS Simulator device or Appium session changed during observation; retry the wait");
    }
}

function now() {
    return new Date().toISOString();
}

function resolveIosAppContainer(xcrun, target, bundleId, containerType = "data") {
    const r = run(xcrun, ["simctl", "get_app_container", target, bundleId, containerType]);
    if (r.status !== 0) return { error: r };
    const containerRoot = r.stdout.trim();
    if (!containerRoot) return { error: { ...r, status: 1, stderr: "simctl get_app_container returned an empty path" } };
    return { containerRoot };
}

function boundedSimulatorIdentityDetail(value) {
    const text = String(value || "").trim();
    return text.length > 4096 ? `${text.slice(0, 4096)}...` : text;
}

function resolveOwnedSimulatorTarget(xcrun, device, inventory) {
    if (!isOwnedSimulatorName(device?.simulatorName)) {
        return { error: `Refusing iOS Simulator operation for non-owned simulator name: ${device?.simulatorName}` };
    }
    const listed = inventory ?? simctlJson(xcrun, ["list", "devices", "-j"]);
    if (listed.error) {
        const detail = boundedSimulatorIdentityDetail(listed.error.stderr || listed.error.stdout || `exit ${listed.error.status}`);
        return { error: `Unable to verify iOS Simulator ownership${detail ? `: ${detail}` : ""}` };
    }
    const simulators = Object.values(listed.value.devices || {}).flatMap((items) => Array.isArray(items) ? items : []);
    const matches = device.udid
        ? simulators.filter((item) => item?.udid === device.udid)
        : simulators.filter((item) => item?.name === device.simulatorName);
    if (matches.length !== 1) {
        return { error: `Unable to verify iOS Simulator ownership for ${device.id}: expected one host match, found ${matches.length}` };
    }
    const simulator = matches[0];
    if (simulator.name !== device.simulatorName || !isOwnedSimulatorName(simulator.name) || typeof simulator.udid !== "string" || !simulator.udid) {
        return { error: `iOS Simulator ownership mismatch for ${device.id}: recorded ${device.simulatorName}, host ${simulator.name || "unknown"}` };
    }
    return { target: simulator.udid, simulator };
}

function pathInsideContainer(containerRoot, requestedPath) {
    const stripped = String(requestedPath || "").replace(/^[/\\]+/, "");
    const relativePath = normalize(stripped);
    if (!iosContainerRelativePathAllowed({ relativePath, absolute: isAbsolute(relativePath) })) {
        return { error: `Refusing path outside iOS app container: ${requestedPath}` };
    }
    return { path: join(containerRoot, relativePath), relativePath };
}

function realPathIsInside(parent, child) {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function ensureContainerPathForWrite(containerRoot, targetPath) {
    try {
        const root = realpathSync(containerRoot);
        const targetParent = dirname(targetPath);
        let existingAncestor = targetParent;
        while (!existsSync(existingAncestor)) {
            const next = dirname(existingAncestor);
            if (next === existingAncestor) break;
            existingAncestor = next;
        }
        const ancestor = realpathSync(existingAncestor);
        if (!realPathIsInside(root, ancestor)) return { error: "Resolved iOS app container path escapes the container" };
        mkdirSync(targetParent, { recursive: true });
        const parent = realpathSync(targetParent);
        if (!realPathIsInside(root, parent)) return { error: "Resolved iOS app container path escapes the container" };
        if (existsSync(targetPath)) {
            const existing = realpathSync(targetPath);
            if (!realPathIsInside(root, existing)) return { error: "Resolved iOS app container path escapes the container" };
        }
        return { root };
    } catch (error) {
        return { error: `Unable to resolve iOS app container path: ${error.message}` };
    }
}

function ensureContainerPathForRead(containerRoot, sourcePath) {
    try {
        const root = realpathSync(containerRoot);
        const source = realpathSync(sourcePath);
        if (!realPathIsInside(root, source)) return { error: "Resolved iOS app container path escapes the container" };
        return { root, source };
    } catch (error) {
        return { error: `Unable to resolve iOS app container path: ${error.message}` };
    }
}

function clearDirectoryContents(path) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        rmSync(join(path, entry.name), { recursive: true, force: true });
    }
}

function simctlJson(xcrun, args) {
    const r = run(xcrun, ["simctl", ...args]);
    if (r.status !== 0) return { error: r };
    try {
        return { value: JSON.parse(r.stdout || "{}") };
    } catch {
        return { error: { ...r, stderr: `Invalid simctl JSON: ${r.stdout}` } };
    }
}

function reconcileIosDevice(device, discovery = iosDiscovery(), inventory) { return deviceObservation.reconcile(device,discovery,inventory); }

export function listIosDevices({ identityOnly = false } = {}) { return deviceObservation.owned({identityOnly}); }

const iosSimulatorLifecycle = createIosSimulatorLifecycle({
    iosDeviceId: (...args) => iosDeviceId(...args),
    readIosDevices: (...args) => readIosDevices(...args),
    findIosDevice: (...args) => findIosDevice(...args),
    ownerSimulatorPrefix: (...args) => ownerSimulatorPrefix(...args),
    slug: (...args) => slug(...args),
    isOwnedSimulatorName: (...args) => isOwnedSimulatorName(...args),
    iosDiscovery: (...args) => iosDiscovery(...args),
    ...createIosSimulatorNative({run, runWithTimeout, simctlJson}),
    ownerId: (...args) => ownerId(...args),
    appiumPortForIosDevice: (...args) => appiumPortForIosDevice(...args),
    claimIosDevice: (...args) => claimIosDevice(...args),
    transitionIosDevice: (...args) => transitionIosDevice(...args),
    signalOwnedRuntimeProcess: (...args) => signalOwnedRuntimeProcess(...args),
    waitForProcessExit: (...args) => waitForProcessExit(...args),
    inspectProcessIdentity: (...args) => inspectProcessIdentity(...args),
    deleteAppiumSession: (...args) => deleteAppiumSession(...args),
    terminateOwnedAppiumProcess: (...args) => terminateOwnedAppiumProcess(...args),
    discardLocalOutputStage: (...args) => discardLocalOutputStage(...args),
    iosRecordingDir: (...args) => iosRecordingDir(...args),
    withTargetStatus: (...args) => withTargetStatus(...args),
    runtimeId: (...args) => randomUUID(...args),
    wallTimestamp: (...args) => now(...args),
});

async function handleIosToolUnlocked(name, args) {
    const environment = presentIosEnvironmentOutcome(iosEnvironment.request(name, args));
    if (environment !== undefined) return environment;
    if (name !== "device_reset" || !args.eraseSimulator) {
        const outcome = await createAppManagement().request(name, args);
        if (outcome?.kind === "json") return jsonResult(outcome.payload);
        if (outcome?.kind === "text") return textResult(false, outcome.message);
        if (outcome?.kind === "command-failure") return fail(outcome.command);
        if (name === "device_reset") return undefined;
    }
    const access = await createObservationAccess().request(name, args);
    if (access !== undefined) return access;
    switch (name) {
        case "device_inventory": {
            const value = deviceObservation.inventory(args);
            if (value === undefined) return undefined;
            const { catalog, ...inventory } = value;
            return jsonResult({ ...inventory, hostSimulators: presentSimulatorCatalog(inventory.discovery, catalog) });
        }

        case "device_create":
            return presentIosNativeOutcome(await iosSimulatorLifecycle.create(args));

        case "device_delete":
            return presentIosNativeOutcome(await iosSimulatorLifecycle.delete(args));



        case "device_start":
            return presentIosNativeOutcome(await iosSimulatorLifecycle.start(args));

        case "device_stop":
            return presentIosNativeOutcome(await iosSimulatorLifecycle.stop(args));





        case "device_record_video_status":
        case "device_record_video_start":
        case "device_record_video_stop":
            return presentRecordingOutcome(await directRecording.request(name, args));


        case "device_upload":
        case "device_download":
            return presentIosNativeOutcome(await controlTransfer.handle(name, args));











        case "mobile_tap":
        case "mobile_double_tap":
        case "mobile_long_press":
        case "mobile_swipe":
        case "mobile_drag":
        case "mobile_type_text":
        case "mobile_key":
        case "mobile_home":
        case "mobile_lock":
        case "mobile_unlock":
        case "mobile_rotate_left":
        case "mobile_rotate_right":
        case "mobile_set_orientation":
            return presentIosNativeOutcome(await controlTransfer.handle(name, args));








        default:
            return undefined;
    }
}

export async function handleIosTool(name, args) {
    if (name === "device_create" && args?.backend && args.backend !== "ios-simulator") return undefined;
    if (!requiresOwnerDeviceOperation("ios", name)) return handleIosToolUnlocked(name, args);
    const createsDevice = name === "device_create";
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : createsDevice && typeof args?.name === "string"
            ? iosDeviceId(args.name)
            : null;
    if (!deviceId) return handleIosToolUnlocked(name, args);
    if (!createsDevice && !findIosDevice(deviceId)) return handleIosToolUnlocked(name, args);
    try {
        return await withOwnerDeviceOperation("ios", deviceId, () => handleIosToolUnlocked(name, args));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `iOS Simulator device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const deviceObservation = createDeviceObservation({ kind: "ios-simulator", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: [
        "device_list_files",
        "device_inventory",
        "device_create",
        "device_delete",
        "device_start",
        "device_stop",
        "device_status",
        "device_exec",
        "device_screenshot",
        "device_record_video_start",
        "device_record_video_stop",
        "device_record_video_status",
        "device_upload",
        "device_download",
        "device_reset",
        "device_install_app",
        "device_launch_app",
        "mobile_open_url",
        "mobile_install_app",
        "mobile_launch_app",
        "mobile_screenshot",
        "mobile_session_status",
        "mobile_dump_ui",
        "mobile_tap",
        "mobile_double_tap",
        "mobile_long_press",
        "mobile_swipe",
        "mobile_drag",
        "mobile_type_text",
        "mobile_key",
        "mobile_home",
        "mobile_lock",
        "mobile_unlock",
        "mobile_rotate_left",
        "mobile_rotate_right",
        "mobile_set_orientation",
        "mobile_uninstall_app",
        "mobile_stop_app",
        "mobile_clear_app_data",
        "mobile_grant_permission",
        "mobile_revoke_permission",
        "mobile_set_location",
        "mobile_set_clipboard",
        "mobile_get_clipboard",
        "mobile_wait_for_text",
        "mobile_wait_for_app",
    ], executable: name => commandPath(name), records: () => readIosDevices(), listOwnedSimulators: xcrun => simulatorObservation(simctlJson(xcrun, ["list", "devices", "-j"])), simulatorCatalog: xcrun => simulatorObservation(simctlJson(xcrun, ["list", "-j"])), ownedTarget: (xcrun, device, inventory) => {
        if (inventory && !inventory.ok) return { matched: false };
        const resolved = resolveOwnedSimulatorTarget(xcrun, device, inventory?.evidence);
        return resolved.error || !resolved.simulator ? { matched: false } : {
            matched: true, status: simulatorObservationState(resolved.simulator.state), name: resolved.simulator.name,
        };
    }, publishObserved: (device, status, simulatorName) => updateIosDevice(device.id, item => item.updatedAt === device.updatedAt && item.status === device.status && item.udid === device.udid && item.simulatorName === device.simulatorName ? { ...item, simulatorName: simulatorName || item.simulatorName, status, updatedAt: now() } : item) });

/**
 * Project the shared native stage observation without changing its allocated
 * paths or cleanup handle. Only successful shared stages have a cleanup handle.
 * @param {ReturnType<typeof stageLocalInputFile> | ReturnType<typeof createLocalOutputStage>} stage
 * @returns {import("../ports/ios-control-transfer.mjs").IosStageResult}
 */
function controlTransferStage(stage) {
    if (stage.ok && "cleanup" in stage && typeof stage.cleanup === "function"
        && "path" in stage && typeof stage.path === "string"
        && "stagedPath" in stage && typeof stage.stagedPath === "string") {
        return { ...stage, ok: true, path: stage.path, stagedPath: stage.stagedPath, cleanup: stage.cleanup };
    }
    if ("message" in stage && typeof stage.message === "string") {
        return { ...stage, ok: false, message: stage.message };
    }
    throw new Error("Invalid native iOS transfer stage result");
}

/**
 * Preserve native transfer details while making the successful/failed carrier
 * explicit for the inward application.
 * @param {ReturnType<typeof copyStagedInputFile> | ReturnType<typeof populateLocalOutputStage> | ReturnType<typeof commitLocalOutputStage>} result
 * @returns {import("../ports/ios-control-transfer.mjs").IosTransferResult}
 */
function controlTransferResult(result) {
    if (result.ok && "path" in result && typeof result.path === "string") {
        return { ...result, ok: true, path: result.path };
    }
    if ("message" in result && typeof result.message === "string") {
        return { ...result, ok: false, message: result.message };
    }
    throw new Error("Invalid native iOS transfer result");
}

/** @param {import('../ports/mobile-environment.mjs').EnvironmentCommandReceipt} command
 * @returns {import('../ports/mobile-environment.mjs').EnvironmentCommandObservation} */
function iosEnvironmentObservation(command) {
    return { kind: command.status === 0 ? "succeeded" : "failed", command };
}

/** @param {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} outcome */
function presentIosEnvironmentOutcome(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "refused") return textResult(false, outcome.message);
    if (outcome.kind === "command-failure") return fail(outcome.command);
    if (outcome.kind === "missing-prerequisites") return missingPrereqResult({ missing: outcome.missing });
    switch (outcome.kind) {
        case "location-set": return jsonResult({ location: { latitude: outcome.location.latitude, longitude: outcome.location.longitude }, stdout: outcome.command.stdout, stderr: outcome.command.stderr, provider: "simctl" });
        case "clipboard-set": return jsonResult({ clipboard: { set: true }, stdout: outcome.command.stdout, stderr: outcome.command.stderr, provider: "simctl" });
        case "clipboard-read": return jsonResult({ text: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status, provider: "simctl" });
    }
}

/** @type {import('../ports/mobile-environment.mjs').IosSimulatorEnvironmentPorts<{xcrun:string,udid:string},NonNullable<ReturnType<typeof findIosDevice>>>} */
const iosEnvironmentPorts = {
    variant: "simulator",
    device: id => findIosDevice(id),
    target(device) {
        const facts = iosDiscovery();
        if (!facts.available || !facts.xcrun) return { kind: "missing-prerequisites", missing: facts.missing };
        const observed = resolveOwnedSimulatorTarget(facts.xcrun, device);
        return observed.error
            ? { kind: "refused", message: observed.error }
            : { kind: "ready", target: { xcrun: facts.xcrun, udid: observed.target } };
    },
    setLocation: (target, location) => iosEnvironmentObservation(run(target.xcrun, ["simctl", "location", target.udid, "set", `${location.latitude},${location.longitude}`])),
    writeClipboard: (target, text) => iosEnvironmentObservation(runWithInput(target.xcrun, ["simctl", "pbcopy", target.udid], text)),
    readClipboard: target => iosEnvironmentObservation(run(target.xcrun, ["simctl", "pbpaste", target.udid])),
};
const iosEnvironment = createIosEnvironment(iosEnvironmentPorts);

function createAppManagement() {
    /** @type {string|null} */
    let xcrun = null;
    return createIosAppManagement({
        variant: "simulator",
        device: id => findIosDevice(id),
        discovery: () => {
            const facts = iosDiscovery();
            xcrun = facts.xcrun;
            return { available: Boolean(facts.available && xcrun), missing: facts.missing };
        },
        ownedTarget: device => {
            const observed = resolveOwnedSimulatorTarget(xcrun, device);
            return observed.error ? { ok: false, message: observed.error } : { ok: true, target: observed.target };
        },
        perform: (target, effect) => {
            const args = effect.kind === "install" ? ["simctl", "install", target, effect.path]
                : effect.kind === "launch" ? ["simctl", "launch", target, effect.bundleId]
                : effect.kind === "stop" ? ["simctl", "terminate", target, effect.bundleId]
                : effect.kind === "uninstall" ? ["simctl", "uninstall", target, effect.bundleId]
                : effect.kind === "permission" ? ["simctl", "privacy", target, effect.action, effect.service, effect.bundleId]
                : ["simctl", "openurl", target, effect.url];
            const command = effect.kind === "install" ? runWithTimeout(xcrun, args, 300000) : run(xcrun, args);
            return { kind: command.status === 0 ? "succeeded" : "failed", command };
        },
        resolveAppContainer: (target, bundleId, type) => {
            const observed = resolveIosAppContainer(xcrun, target, bundleId, type);
            return observed.error ? { ok: false, command: observed.error } : { ok: true, containerRoot: observed.containerRoot };
        },
        containAppContainer: root => {
            const observed = ensureContainerPathForRead(root, root);
            return observed.error ? { ok: false, message: observed.error } : { ok: true };
        },
        clearAppContainer: root => { clearDirectoryContents(root); return undefined; },
        publishAppReset: (id, reset, updatedAt) => updateIosDevice(id, item => ({ ...item, lastReset: reset, updatedAt })),
        clock: () => now(),
    });
}

const controlTransfer = createIosControlTransfer({
    kind: "simulator",
    findDevice: id => findIosDevice(id),
    resolveSession: async id => {
        try {
            return await withOwnerDeviceOperation("ios", id, () => ensureIosAppiumSession(id));
        } catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "shared-mutation-lock-timeout") throw error;
            return { error: `iOS Simulator Appium operation lock failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    },
    performControl: (session, command) => performIosControl(fetchIosAppiumJson, session, command),
    ownedSimulatorName: name => isOwnedSimulatorName(name),
    discovery: () => iosDiscovery(),
    verifyTarget: (xcrun, device) => resolveOwnedSimulatorTarget(xcrun, device),
    resolveContainer: (xcrun, target, bundleId, type) => {
        const receipt = run(xcrun, ["simctl", "get_app_container", target, bundleId, type]);
        if (receipt.status !== 0) return {kind:"failed", receipt};
        const containerRoot = receipt.stdout.trim();
        return containerRoot ? {kind:"resolved", containerRoot} : {kind:"failed", receipt:{...receipt,status:1,stderr:"simctl get_app_container returned an empty path"}};
    },
    pathFacts: (root, requestedPath) => {
        const stripped = String(requestedPath || "").replace(/^[/\\]+/, "");
        const relativePath = normalize(stripped);
        return { relativePath, absolute: isAbsolute(relativePath), path: join(root, relativePath) };
    },
    guardWrite: (root, path) => ensureContainerPathForWrite(root, path),
    guardRead: (root, path) => ensureContainerPathForRead(root, path),
    exists: path => existsSync(path),
    stageInput: path => {
        const stage = stageLocalInputFile(path, { label: "upload-local-path" });
        return controlTransferStage(stage);
    },
    stageOutput: path => {
        const stage = createLocalOutputStage(path, { label: "download-local-path" });
        return controlTransferStage(stage);
    },
    copyInput: (stage, path) => controlTransferResult(copyStagedInputFile(stage, path, { label: "upload-local-path" })),
    populateOutput: (path, stage) => controlTransferResult(populateLocalOutputStage(path, stage, { label: "download-remote-path" })),
    commitOutput: stage => controlTransferResult(commitLocalOutputStage(stage, { label: "download-local-path" })),
    disposeStage: stage => { stage.cleanup(); },
});

/** @param {string|null} executable @param {number} port
 * @returns {import('../ports/ios-observation-access.mjs').IosAccessChild} */
function spawnObservationAppium(executable, port) {
    const child = spawn(executable, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true, stdio: "ignore", env: process.env, windowsHide: true,
    });
    return {
        pid: child.pid,
        onExit: operation => { child.once("exit", operation); return undefined; },
        unref: () => { child.unref(); return undefined; },
        abortStartup: () => { child.kill("SIGTERM"); return undefined; },
    };
}

/** @param {string} stdout @param {string} bundleId
 * @returns {{valid:false}|{valid:true,pid:string|null}} */
function simulatorBootstrapAppPid(stdout, bundleId) {
    const lines = stdout.trim().split(/\r?\n/);
    if (!/^PID[\t ]+Status[\t ]+Label$/.test(lines[0])) return { valid: false };
    const prefix = `UIKitApplication:${bundleId}`;
    /** @type {string|null} */
    let pid = null;
    for (const line of lines.slice(1)) {
        const row = /^[\t ]*(-|\d+)[\t ]+(-?\d+)[\t ]+([^\s]+)[\t ]*$/.exec(line);
        if (!row || !Number.isSafeInteger(Number(row[2])) || (row[1] !== "-" && !Number.isSafeInteger(Number(row[1])))) return { valid: false };
        if (row[1] === "-" || Number(row[1]) <= 0 || !row[3].startsWith(prefix)) continue;
        if (/^(?:\[[^\[\]\s]+\])+$/.test(row[3].slice(prefix.length))) pid = row[1];
    }
    return { valid: true, pid };
}

/** @template {import('../ports/ios-observation-access.mjs').IosAccessSimulatorEffect} Effect
 * @param {string|null} xcrun @param {Effect} effect
 * @returns {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */
function performSimulatorEffect(xcrun, effect) {
    const target = effect.target;
    let command;
    if (effect.kind === "app-probe") {
        const bootstrapProbe = effect.probe === "bootstrap-services";
        const processProbe = effect.probe === "bundle-process" || effect.probe === "name-process";
        const domain = effect.probe === "user-services" ? "user/501" : effect.probe === "gui-services" ? "gui/501" : "system";
        const hint = String(effect.bundleId).split(".").filter(Boolean).at(-1) || String(effect.bundleId);
        const args = bootstrapProbe ? ["simctl", "spawn", target, "launchctl", "list"]
            : processProbe ? ["simctl", "spawn", target, "pgrep", ...(effect.probe === "name-process" ? ["-i"] : []), "-f", effect.probe === "name-process" ? hint : effect.bundleId]
            : ["simctl", "spawn", target, "launchctl", "print", domain];
        command = run(xcrun, args, { timeout: effect.timeoutMs });
        if (bootstrapProbe) {
            const clean = !command.error && !command.signal && command.status === 0;
            const table = clean ? simulatorBootstrapAppPid(command.stdout, effect.bundleId) : null;
            if (table?.valid) return /** @type {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */ ({
                kind: table.pid ? "present" : "absent", receipt: { ...command, stdout: "", stderr: "" },
                ...(table.pid ? { pid: table.pid } : {}), observedBy: "launchctl-list",
            });
            const cause = clean ? "Malformed iOS Simulator launchctl list response"
                : [command.error?.code, command.error?.message, command.signal ? `signal ${command.signal}` : "", command.status != null ? `exit ${command.status}` : "", command.stderr || command.stdout].filter(Boolean).join(": ");
            return /** @type {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */ ({
                kind: "failed", receipt: { ...command, stdout: "", stderr: cause || "command failed" },
            });
        }
        const clean = !command.error && !command.signal && (command.status === 0 || (processProbe && command.status === 1 && !command.stdout && !command.stderr));
        const present = clean && command.status === 0 && (processProbe ? Boolean(command.stdout.trim()) : String(command.stdout || "").toLowerCase().includes(String(effect.bundleId).toLowerCase()));
        const cause = [command.error?.code, command.error?.message, command.signal ? `signal ${command.signal}` : "", command.status != null ? `exit ${command.status}` : "", command.stderr || command.stdout].filter(Boolean).join(": ");
        const result = { kind: present ? "present" : clean ? "absent" : "failed", receipt: !clean ? { ...command, stderr: cause || "command failed" } : present && !processProbe ? { ...command, stdout: "" } : command,
            ...(present ? { pid: processProbe ? command.stdout.trim() : null, ...(!processProbe ? { observedBy: `launchctl-${domain}` } : {}) } : {}) };
        return /** @type {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */ (result);
    }
    const args = effect.kind === "exec" ? ["simctl", "spawn", target, ...(effect.argv ?? ["/bin/sh", "-lc", effect.command])]
        : effect.kind === "screenshot" ? ["simctl", "io", target, "screenshot", effect.path]
        : effect.kind === "erase" ? ["simctl", "erase", target]
        : ["simctl", "get_app_container", target, effect.bundleId, effect.containerType];
    command = effect.kind === "screenshot" ? run(xcrun, args, { timeout: 30000 }) : run(xcrun, args);
    if (effect.kind === "app-container") {
        const path = command.stdout.trim();
        if (command.status === 0 && !path) command = { ...command, status: 1, stderr: "simctl get_app_container returned an empty path" };
        return /** @type {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */ ({ ...command, ok: command.status === 0, path });
    }
    return /** @type {import('../ports/ios-observation-access.mjs').IosAccessSimulatorResult<Effect>} */ ({ ...command, ok: command.status === 0 });
}

/** @param {unknown} stderr */
function simctlFailureObservation(stderr) {
    if (typeof stderr !== "string") return undefined;
    const bytes = Buffer.from(stderr.slice(0, 16 * 1024 + 1), "utf8");
    // A cut token must not become complete at the observation boundary.
    const prefix = bytes.subarray(0, 16 * 1024).toString("utf8") + (bytes.length > 16 * 1024 ? "_" : "");
    /** @type {{domain:string,code:number}[]} */
    const errors = [];
    const pattern = /\b[Dd]omain\s*=\s*(NSPOSIXErrorDomain|NSCocoaErrorDomain|com\.apple\.CoreSimulator\.SimError|com\.apple\.CoreSimulator\.LaunchdSimError|SimXPCErrorDomain)(?:\s*,\s*|\s+)[Cc]ode\s*=\s*([+-]?\d+)(?=[\s,):}"\]]|$)/g;
    for (const match of prefix.matchAll(pattern)) {
        const code = Number(match[2]);
        if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647) continue;
        const domain = match[1];
        if (errors.some(error => error.domain === domain && error.code === code)) continue;
        errors.push({ domain, code });
        if (errors.length === 4) break;
    }
    const spawnFailure = /\b(?:failed\s+to\s+spawn|posix_spawnp?(?:\(\))?(?:\s*:\s*|\s+)(?:failed|failure))\b/i.test(prefix)
        || /(?:^|\n)Process spawn via launchd failed\.(?=\r?\n|$)/.test(prefix);
    return errors.length || spawnFailure ? {
        ...(errors.length ? { errors } : {}), ...(spawnFailure ? { stage: "spawn" } : {}),
    } : undefined;
}

/** @param {string|null} [initialXcrun] */
function createObservationAccess(initialXcrun = null) {
    let xcrun = initialXcrun;
    /** @type {string|null} */
    let appium = null;
    /** @type {import('../ports/ios-observation-access.mjs').IosObservationAccessPorts<import('../ports/ios-observation-access.mjs').IosAccessDevice, import('../responses.mjs').IosAccessNativeResult>} */
    const observationPorts = {
        kind: "simulator",
        findDevice: id => findIosDevice(id),
        discovery: () => {
            const discovery = iosDiscovery();
            xcrun = discovery.xcrun;
            return discovery;
        },
        appiumDiscovery: discovery => {
            const observed = iosAppiumDiscovery(/** @type {ReturnType<typeof iosDiscovery>|undefined} */ (discovery));
            xcrun = observed.xcrun;
            appium = observed.appium;
            return observed;
        },
        backend: discovery => iosBackend(/** @type {ReturnType<typeof iosDiscovery>} */ (discovery)),
        targetStatus: device => withTargetStatus(device),
        withDeviceOperation: (id, operation) => withOwnerDeviceOperation("ios", id, operation),
        waitBudget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
        appiumEffect: performIosAppiumEffect,
        spawnServer: port => spawnObservationAppium(appium, port),
        inspectRuntime: runtime => inspectProcessIdentity(runtime?.processIdentity, runtime?.pid),
        waitIdentity: (pid, timeoutMs) => waitForProcessIdentity(pid, timeoutMs),
        refreshRuntime: runtime => refreshOwnedRuntimeProcessIdentity(runtime),
        terminateRuntime: (runtime, label) => terminateOwnedAppiumProcess(runtime, label),
        isAlive: pid => processIsAlive(pid),
        publishAppium: (id, expected, replacement, timestamp) => transitionAppiumGeneration(updateIosDevice, id, expected, replacement, timestamp),
        updateAppiumPort: (id, runtimeId, port, timestamp) => updateIosDevice(id, item => item.appium?.runtimeId === runtimeId
            ? { ...item, appiumPort: port, updatedAt: timestamp } : item),
        timestamp: () => now(),
        runtimeId: () => randomUUID(),
        serverUrlForPort: port => `http://127.0.0.1:${port}`,
        portForDevice: id => appiumPortForIosDevice(id),
        pause: milliseconds => sleep(milliseconds),
        diagnostic: (text, maximumBytes) => truncateDiagnosticText(text, maximumBytes),
        jsonResult: value => jsonResult(value),
        textResult: (ok, message) => textResult(ok, message),
        commandFailure: command => {
            const receipt = /** @type {import('../ports/ios-observation-access.mjs').IosAccessCommand & {timedOut?:boolean}} */ (command);
            const status = Number.isSafeInteger(receipt.status) && receipt.status !== null && receipt.status >= 0 ? receipt.status : null;
            const signal = typeof receipt.signal === "string" && Object.hasOwn(constants.signals, receipt.signal) ? receipt.signal : null;
            const errorCode = typeof receipt.error?.code === "string" && Object.hasOwn(constants.errno, receipt.error.code) ? receipt.error.code : null;
            const timedOut = receipt.timedOut === true || errorCode === "ETIMEDOUT";
            const diagnosticCode = timedOut ? "native-timeout"
                : errorCode === "ENOENT" ? "native-not-found"
                : errorCode === "EACCES" || errorCode === "EPERM" ? "native-permission-denied"
                : signal ? "native-signal"
                : status !== null && status !== 0 ? "native-nonzero-exit" : "native-unknown";
            const simctl = simctlFailureObservation(receipt.stderr);
            return { ...fail(command), structuredContent: {
                ok: false, error: "provider-command-failed",
                execution: { status, signal, timedOut, errorCode, diagnosticCode, ...(simctl ? { simctl } : {}) },
            } };
        },
        imageResult: data => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
        verifyTarget: device => resolveOwnedSimulatorTarget(xcrun, device),
        simulatorEffect: effect => performSimulatorEffect(xcrun, effect),
        missingPrerequisites: discovery => missingPrereqResult(discovery),
        reconcileDevice: (device, discovery) => reconcileIosDevice(device, /** @type {ReturnType<typeof iosDiscovery>} */ (discovery)),
        pathInContainer: (root, requested) => pathInsideContainer(root, requested),
        guardRead: (root, path) => ensureContainerPathForRead(root, path),
        listArgumentError: args => validateListFilesArgs(args),
        listDirectory: (root, requested, limit) => listContainedDirectory(root, requested, limit),
        stageScreenshot: () => {
            const root = mkdtempSync(join(tmpdir(), "ccc-ios-screenshot-"));
            return { path: join(root, "screenshot.png"), dispose: () => { rmSync(root, { recursive: true, force: true }); return undefined; } };
        },
        readScreenshot: path => screenshotFileResult(path, "ios-simulator-screenshot"),
        publishErased: (id, change) => updateIosDevice(id, item => ({ ...item, ...change })),
        guardObservation: (id, original, session) => { guardIosObservation(id, original, session); return undefined; },
        checkObservation: (id, original, session) => { guardIosObservation(id, original, session); return undefined; },
    };

    return createIosObservationAccess(observationPorts);
}

/** @returns {unknown} */
function presentIosNativeOutcome(outcome) {
    if (outcome === undefined) return undefined;
    if (outcome.kind === "cleanup-failure") {
        const primary = outcome.primary;
        return renderStageCleanupFailure({
            error: "ios-transfer-cleanup-failed",
            primary: primary.kind === "thrown" ? primary
                : { kind: "returned", outcome: primary.kind, result: presentIosNativeOutcome(primary) },
            cleanupError: outcome.error,
            ...(primary.kind === "json" ? { result: { kind: "completed", completed: true } } : {}),
        }, jsonResult);
    }
    if (outcome.kind === "json") return jsonResult(outcome.payload);
    if (outcome.kind === "command-failure") return fail(outcome.receipt);
    if (outcome.kind === "conflict") {
        const payload = { ...outcome.payload };
        if (payload.rollback) payload.rollback = { ok: payload.rollback.ok, ...payload.rollback.receipt };
        return textResult(false, JSON.stringify(payload));
    }
    return textResult(false,outcome.message);
}
