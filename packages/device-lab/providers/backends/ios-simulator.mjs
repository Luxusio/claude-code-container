import { iosControlOrientation, iosContainerRelativePathAllowed } from "../domain/ios-control-transfer.mjs";
import { createIosControlTransfer } from "../application/ios-control-transfer.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createIosSimulatorLifecycle } from "../application/lifecycle/ios-simulator-lifecycle.mjs";
import { listContainedDirectory, validateListFilesArgs, LIST_FILES_DEFAULT_LIMIT } from "../file-listing.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, normalize } from "path";
import { commandPath, localBinPath, run, runWithInput, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult, truncateDiagnosticText } from "../responses.mjs";
import { screenshotFileResult } from "../screenshot-file.mjs";
import { claimIosDevice, findIosDevice, readIosDevices, transitionIosDevice, updateIosDevice } from "../state/ios-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, readProcessIdentity, refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcess, waitForProcessIdentity } from "../state/process-identity.mjs";
import { appiumGenerationMatches, claimRecordingFinalization, recordingGenerationMatches, transitionAppiumGeneration, transitionRecordingGeneration } from "../state/runtime-generation.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, copyStagedInputFile, createLocalOutputStage, discardLocalOutputStage, populateLocalOutputStage, restoreLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

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

function unsupportedMobileResult(tool) {
    return textResult(false, `iOS Simulator does not support ${tool} through base simctl; use Appium/XCUITest support when available.`);
}

function unsupportedIosResult(tool, reason) {
    return textResult(false, `iOS Simulator ${tool} is not supported through base simctl in this slice: ${reason}`);
}

function iosAppiumStatus(device) {
    return {
        deviceId: device.id,
        appium: iosAppiumDiscovery(),
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
    };
}

function missingIosAppiumResult(discovery) {
    return textResult(false, `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}`);
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRecorderProcess(child, label) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => done(null), 150);
        child.once("error", (error) => done(textResult(false, `${label} recorder failed to start: ${error.message}`)));
        child.once("exit", (code, signal) => done(textResult(false, `${label} recorder exited before it was ready: ${signal || `exit ${code}`}`)));
    });
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

async function appiumServerReady(appium) {
    if (!appium?.serverUrl) return false;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/status`, { method: "GET" });
        return true;
    } catch {
        return false;
    }
}

async function appiumSessionReady(appium, serverReady) {
    if (!appium?.sessionId || !serverReady) return false;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "GET" });
        return true;
    } catch {
        return false;
    }
}

async function deleteAppiumSession(appium) {
    if (!appium?.serverUrl || !appium?.sessionId) return;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "DELETE" });
    } catch {
        /* best effort cleanup */
    }
}

async function stopOwnedAppium(appium, label) {
    const ownsProcess = Boolean(appium?.runtimeId
        && appium.processOwner === "device-lab-mcp"
        && appium.startedBy === "direct-provider"
        && appium.serverPid
        && appium.processIdentity);
    if (!ownsProcess) {
        await deleteAppiumSession(appium);
        return { exited: true, signaled: false, reason: "appium-process-identity-missing" };
    }
    const runtime = { ...appium, pid: appium.serverPid };
    const observation = inspectProcessIdentity(runtime.processIdentity, runtime.pid);
    if (observation.status === "exited") return { exited: true, signaled: false, reason: "runtime-process-exited" };
    if (observation.status !== "match") {
        const reason = observation.status === "mismatch"
            ? "runtime-process-identity-mismatch"
            : "runtime-process-identity-unavailable";
        return { exited: false, signaled: false, reason, error: `${label} process identity could not be verified: ${reason}` };
    }
    await deleteAppiumSession(appium);
    return terminateOwnedAppiumProcess(runtime, label);
}

function reconcileIosRecording(device) {
    if (!device?.recording?.active || !device.recording.pid) return device;
    const observation = device.recording.processIdentity
        ? inspectProcessIdentity(device.recording.processIdentity, device.recording.pid)
        : null;
    const recorderIsCurrent = observation
        ? observation.status === "match" || observation.status === "unavailable"
        : processIsAlive(device.recording.pid);
    if (recorderIsCurrent) return device;
    const expected = device.recording;
    const pending = { ...expected, active: false, endedAt: now() };
    return updateIosDevice(device.id, (item) => recordingGenerationMatches(expected, item.recording)
        ? { ...item, recording: pending, updatedAt: now() }
        : item) || device;
}

function monitorIosRecordingExit(deviceId, recording) {
    return () => {
        transitionRecordingGeneration(updateIosDevice, deviceId, recording, {
            ...recording,
            active: false,
            endedAt: now(),
        }, now());
    };
}

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

async function waitForAppium(url) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            await fetchIosAppiumJson(`${url}/status`, { method: "GET", timeoutMs: 1000 });
            return true;
        } catch {
            await sleep(250);
        }
    }
    return false;
}

export async function waitForIosApp(xcrun, target, bundleId, timeoutMs = 10000, intervalMs = 500) {
    const budget = createWaitBudget(timeoutMs, intervalMs);
    let last = null;
    let observation = null;
    const executableHint = String(bundleId).split(".").filter(Boolean).at(-1) || String(bundleId);
    while (budget.remaining() > 0) {
        // Only the latest sweep can establish that the app is absent.
        observation = null;
        for (const args of [
            ["simctl", "spawn", target, "pgrep", "-f", bundleId],
            ["simctl", "spawn", target, "pgrep", "-i", "-f", executableHint],
        ]) {
            const allowance = budget.requestTimeout();
            if (!allowance) break;
            const r = run(xcrun, args, { timeout: allowance });
            last = r;
            const clean = !r.error && !r.signal && (r.status === 0
                || (r.status === 1 && !r.stdout && !r.stderr));
            if (clean) observation = r;
            if (clean && r.status === 0 && r.stdout.trim()) {
                return { running: true, pid: r.stdout.trim(), stdout: r.stdout, stderr: r.stderr, status: r.status };
            }
        }
        for (const domain of ["user/501", "gui/501", "system"]) {
            const allowance = budget.requestTimeout();
            if (!allowance) break;
            const launchctl = run(xcrun, ["simctl", "spawn", target, "launchctl", "print", domain], { timeout: allowance });
            last = launchctl;
            const clean = !launchctl.error && !launchctl.signal && launchctl.status === 0;
            if (clean) observation = launchctl;
            if (clean && String(launchctl.stdout || "").toLowerCase().includes(String(bundleId).toLowerCase())) {
                return {
                    running: true,
                    pid: null,
                    stdout: "",
                    stderr: launchctl.stderr,
                    status: launchctl.status,
                    observedBy: `launchctl-${domain}`,
                };
            }
        }
        await budget.pause();
    }
    if (!observation) {
        const cause = last ? [
            last.error?.code,
            last.error?.message,
            last.signal ? `signal ${last.signal}` : "",
            last.status != null ? `exit ${last.status}` : "",
            last.stderr || last.stdout,
        ].filter(Boolean).join(": ") : "No simulator app observation completed";
        return { error: {
            stderr: truncateDiagnosticText(`Unable to observe iOS Simulator app: ${cause || "command failed"}`, 4096),
            status: last?.status ?? null,
        } };
    }
    return {
        running: false,
        timeoutMs: budget.timeoutMs,
        stdout: String(observation.stdout || "").slice(-512),
        stderr: String(observation.stderr || "").slice(-512),
        status: 0,
        nativeStatus: observation.status,
        observedBy: "pgrep-and-launchctl",
    };
}

async function ensureIosAppiumSession(deviceId) {
    let device = findIosDevice(deviceId);
    if (!device) return { unknown: true };

    const discovery = iosAppiumDiscovery();
    if (!discovery.available) {
        return { error: `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}` };
    }
    const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
    if (ownedTarget.error) return { error: ownedTarget.error };

    const port = device.appiumPort || appiumPortForIosDevice(device.id);
    const serverUrl = `http://127.0.0.1:${port}`;

    const serverReady = await appiumServerReady(device.appium);
    if (await appiumSessionReady(device.appium, serverReady)) {
        return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
    }

    const staleAppium = device.appium ?? null;
    const ownedServer = Boolean(staleAppium?.runtimeId
        && staleAppium.processOwner === "device-lab-mcp"
        && staleAppium.startedBy === "direct-provider"
        && staleAppium.serverPid
        && staleAppium.processIdentity);
    const reusableServer = serverReady && !ownedServer;
    if (ownedServer) {
        const stopped = await stopOwnedAppium(staleAppium, "iOS Simulator stale Appium");
        if (!stopped.exited) return { error: stopped.error };
    }
    const stale = transitionAppiumGeneration(updateIosDevice, deviceId, staleAppium, null, now());
    if (!stale.committed && stale.device?.appium != null) {
        return { error: "iOS Simulator Appium state changed while reconciling a stale session" };
    }
    device = stale.device;

    const runtimeId = randomUUID();
    const child = reusableServer ? null : spawn(discovery.appium, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
    });
    const processIdentity = child?.pid ? await waitForProcessIdentity(child.pid, 1000) : null;
    if (child?.pid && !processIdentity) {
        try { child.kill("SIGTERM"); } catch { /* startup child already exited */ }
        return { error: `iOS Simulator Appium process identity could not be established on ${serverUrl}` };
    }
    let startupRuntime = child?.pid ? { runtimeId, serverPid: child.pid, pid: child.pid, processIdentity } : null;
    let appium = null;
    if (child) {
        child.once("exit", () => {
            if (appium) transitionAppiumGeneration(updateIosDevice, deviceId, appium, null, now());
        });
        child.unref();
    }

    const ready = (reusableServer && staleAppium.serverUrl === serverUrl) || await waitForAppium(serverUrl);
    if (startupRuntime) startupRuntime = refreshOwnedRuntimeProcessIdentity(startupRuntime);
    if (!ready) {
        if (child?.pid) {
            const stopped = await terminateOwnedAppiumProcess(startupRuntime, "iOS Simulator Appium startup");
            if (!stopped.exited) return { error: `${stopped.error}. Appium server did not become ready on ${serverUrl}` };
        }
        return { error: `Appium server did not become ready on ${serverUrl}` };
    }

    let response;
    try {
        response = await fetchIosAppiumJson(`${serverUrl}/session`, {
            method: "POST",
            body: JSON.stringify({
                capabilities: {
                    alwaysMatch: {
                        platformName: "iOS",
                        "appium:automationName": "XCUITest",
                        "appium:deviceName": device.simulatorName || device.name || device.id,
                        "appium:udid": ownedTarget.target,
                    },
                },
            }),
        });
    } catch (error) {
        if (child?.pid) {
            await terminateOwnedAppiumProcess(startupRuntime, "iOS Simulator Appium startup");
        }
        return { error: `Appium session creation failed: ${error.message}` };
    }
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (!sessionId) {
        if (child?.pid) {
            await terminateOwnedAppiumProcess(startupRuntime, "iOS Simulator Appium startup");
        }
        return { error: "Appium did not return a session id" };
    }

    appium = {
        runtimeId,
        authority: "direct-provider",
        processOwner: child ? "device-lab-mcp" : "external",
        startedBy: child ? "direct-provider" : "existing-server",
        serverUrl,
        serverPid: child?.pid ?? null,
        processIdentity: startupRuntime?.processIdentity ?? null,
        sessionId,
        automationName: "XCUITest",
        updatedAt: now(),
    };
    const committed = transitionAppiumGeneration(updateIosDevice, deviceId, null, appium, now());
    if (!committed.committed) {
        await deleteAppiumSession(appium);
        if (child?.pid) await terminateOwnedAppiumProcess(startupRuntime, "iOS Simulator Appium superseded startup");
        return { error: "iOS Simulator Appium state changed before the new session was committed" };
    }
    const updated = updateIosDevice(deviceId, (item) => item.appium?.runtimeId === runtimeId
        ? { ...item, appiumPort: port, updatedAt: now() }
        : item);
    if (child?.pid && !processIsAlive(child.pid)) {
        transitionAppiumGeneration(updateIosDevice, deviceId, appium, null, now());
        return { error: "iOS Simulator Appium exited before the new session became usable" };
    }

    return { device: updated, serverUrl, sessionId };
}

async function iosAppiumSessionOrResult(deviceId) {
    let session;
    try {
        session = await withOwnerDeviceOperation("ios", deviceId, () => ensureIosAppiumSession(deviceId));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return { result: textResult(false, `iOS Simulator Appium operation lock failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (session.unknown) return { unknown: true };
    if (session.error) return { result: textResult(false, session.error) };
    return { session };
}

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

async function iosAppiumSource(deviceId) {
    const resolved = await iosAppiumSessionOrResult(deviceId);
    if (resolved.unknown || resolved.result) return resolved;
    const { session } = resolved;
    try {
        const source = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
        return { session, source: source?.value ?? source?.source ?? source };
    } catch (error) {
        return { result: textResult(false, `iOS Simulator Appium source request failed: ${error.message}`) };
    }
}

function now() {
    return new Date().toISOString();
}

function iosContainerType(value) {
    return value || "data";
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
    return child === parent || child.startsWith(`${parent}/`);
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
    simctlJson: (...args) => simctlJson(...args),
    run: (...args) => run(...args),
    runWithTimeout: (...args) => runWithTimeout(...args),
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
    textResult: (...args) => textResult(...args),
    jsonResult: (...args) => jsonResult(...args),
    fail: (...args) => fail(...args),
    runtimeId: (...args) => randomUUID(...args),
    wallTimestamp: (...args) => now(...args),
});

async function handleIosToolUnlocked(name, args) {
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_create":
            return iosSimulatorLifecycle.create(args);

        case "device_delete":
            return iosSimulatorLifecycle.delete(args);

        case "device_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            const discovery = iosDiscovery();
            return jsonResult({ device: withTargetStatus(reconcileIosDevice(device, discovery)), backend: iosBackend(discovery), automation: iosAppiumStatus(device) });
        }

        case "device_start":
            return iosSimulatorLifecycle.start(args);

        case "device_stop":
            return iosSimulatorLifecycle.stop(args);

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "spawn", ownedTarget.target, "/bin/sh", "-lc", command]);
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);

            const tempRoot = mkdtempSync(join(tmpdir(), "ccc-ios-screenshot-"));
            const ssPath = join(tempRoot, "screenshot.png");
            try {
                const r = runWithTimeout(discovery.xcrun, ["simctl", "io", ownedTarget.target, "screenshot", ssPath], 30_000);
                if (r.status !== 0) return fail(r);
                return screenshotFileResult(ssPath, "ios-simulator-screenshot");
            } finally {
                rmSync(tempRoot, { recursive: true, force: true });
            }
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const found = findIosDevice(deviceId);
            const device = reconcileIosRecording(found);
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "simctl-recordVideo" });
        }

        case "device_record_video_start": {
            const { deviceId, localPath } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (device.recording) {
                const state = device.recording.active ? "already active" : "pending finalization";
                return textResult(false, `iOS Simulator recording ${state} for ${deviceId}`);
            }

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);

            const resolvedLocalPath = localPath || iosRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            mkdirSync(iosRecordingDir(device), { recursive: true });
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const localStage = createLocalOutputStage(safeLocalPath, {
                label: "recording-local-path",
                stageParent: iosRecordingDir(device),
                stagePrefix: ".recording-stage-",
            });
            if (!localStage.ok) return textResult(false, localStage.message);
            const child = spawn(discovery.xcrun, ["simctl", "io", ownedTarget.target, "recordVideo", localStage.stagedPath], {
                detached: true,
                stdio: "ignore",
                env: process.env,
                windowsHide: true,
            });
            let recording = null;
            const runtimeId = randomUUID();
            let exited = false;
            child.once("exit", () => {
                exited = true;
                if (recording) monitorIosRecordingExit(deviceId, recording)();
            });
            const startError = await waitForRecorderProcess(child, "iOS Simulator recordVideo");
            if (startError) {
                localStage.cleanup();
                return startError;
            }
            const processIdentity = readProcessIdentity(child.pid);
            if (!processIdentity) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                localStage.cleanup();
                return textResult(false, `iOS Simulator recorder process identity could not be established for ${deviceId}.`);
            }
            recording = {
                active: true,
                provider: "simctl-recordVideo",
                runtimeId,
                pid: child.pid,
                processIdentity,
                localPath: safeLocalPath,
                stagingPath: localStage.stagedPath,
                startedAt: now(),
            };
            child.unref();
            const committed = transitionRecordingGeneration(updateIosDevice, deviceId, device.recording ?? null, recording, now());
            if (!committed.committed) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                localStage.cleanup();
                return textResult(false, `iOS Simulator recording state changed while starting for ${deviceId}; the new recorder was stopped.`);
            }
            if (exited || !processIsAlive(child.pid)) {
                transitionRecordingGeneration(updateIosDevice, deviceId, recording, null, now());
                localStage.cleanup();
                return textResult(false, `iOS Simulator recorder exited before its state was committed for ${deviceId}.`);
            }
            return jsonResult({ deviceId, recording: committed.device.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording) return textResult(false, `No iOS Simulator recording active for ${deviceId}`);

            const previous = device.recording;
            const artifactSourcePath = previous.stagingPath || previous.localPath;
            const resolvedLocalPath = localPath || previous.localPath || iosRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            if (previous.active) {
                const recorderSignal = signalOwnedRuntimeProcess(previous, "SIGINT");
                if (!recorderSignal.signaled && recorderSignal.reason !== "runtime-process-exited") {
                    return textResult(false, `iOS Simulator recording process could not be safely stopped for ${deviceId} (${recorderSignal.reason || "unknown"}); state remains active.`);
                }
                if (recorderSignal.signaled) {
                    const exited = await waitForProcessExit(previous.pid, 3000);
                    if (!exited) return textResult(false, `iOS Simulator recording did not exit within 3000ms for ${deviceId}; state remains active.`);
                }
            }
            const claimed = claimRecordingFinalization(updateIosDevice, deviceId, previous, { localPath: safeLocalPath }, now());
            if (!claimed.committed || !claimed.device?.recording) {
                return textResult(false, `iOS Simulator recording state changed while stopping for ${deviceId}; successor state was preserved.`);
            }
            const pending = claimed.device.recording;
            const persistentStage = typeof pending.stagingPath === "string" && pending.stagingPath.length > 0;
            const localStage = persistentStage
                ? restoreLocalOutputStage(safeLocalPath, pending.stagingPath, {
                    label: "recording-local-path",
                    stageParent: iosRecordingDir(device),
                    stagePrefix: ".recording-stage-",
                })
                : createLocalOutputStage(safeLocalPath, { label: "recording-local-path" });
            if (!localStage.ok) return textResult(false, `${localStage.message}. iOS Simulator recording remains pending finalization for ${deviceId}.`);
            if (!persistentStage) {
                const populated = populateLocalOutputStage(artifactSourcePath, localStage, { label: "recording-local-path-stage" });
                if (!populated.ok) {
                    localStage.cleanup();
                    return textResult(false, `${populated.message}. iOS Simulator legacy recording remains pending finalization for ${deviceId}.`);
                }
            }
            const committed = commitLocalOutputStage(localStage, { label: "recording-local-path", minBytes: 1 });
            if (!committed.ok) {
                if (!persistentStage) localStage.cleanup();
                return textResult(false, `${committed.message}. iOS Simulator recording remains pending finalization for ${deviceId}.`);
            }
            const cleared = transitionRecordingGeneration(updateIosDevice, deviceId, pending, null, now());
            const updated = cleared.device;
            if (!cleared.committed) {
                if (!persistentStage) localStage.cleanup();
                return textResult(false, `iOS Simulator recording state changed while stopping for ${deviceId}; successor state and staged artifact were preserved.`);
            }
            localStage.cleanup();
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "simctl-recordVideo",
                recording: { ...pending, active: false, localPath: safeLocalPath, stoppedAt: now() },
                device: updated,
            });
        }

        case "device_list_files": {
            const device = findIosDevice(args.deviceId);
            if (!device) return undefined;
            const error = validateListFilesArgs(args);
            if (error) return jsonResult({ ok: false, error });
            if (!args.bundleId) return jsonResult({ ok: false, error: "list-files-bundle-id-required", detail: "iOS Simulator listing requires bundleId to select an app container." });
            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const container = resolveIosAppContainer(discovery.xcrun, ownedTarget.target, args.bundleId, iosContainerType(args.containerType));
            if (container.error) return fail(container.error);
            const requested = args.path.replace(/^[/\\]+/, "") || ".";
            if (requested.split(/[/\\]/).includes("..")) return jsonResult({ ok: false, error: "list-files-container-escape" });
            const target = requested === "." ? { path: container.containerRoot } : pathInsideContainer(container.containerRoot, requested);
            if (target.error) return textResult(false, target.error);
            const contained = ensureContainerPathForRead(container.containerRoot, target.path);
            if (contained.error) return textResult(false, contained.error);
            try { return jsonResult(listContainedDirectory(container.containerRoot, requested, args.limit ?? LIST_FILES_DEFAULT_LIMIT)); }
            catch (error) { return jsonResult({ ok: false, error: "list-files-container-read-failed", detail: error.code || error.message }); }
        }

        case "device_upload":
        case "device_download":
            return controlTransfer.handle(name, args);

        case "device_reset": {
            const { deviceId, bundleId, containerType, eraseSimulator = false } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            if (eraseSimulator) {
                if (device.recording) {
                    return textResult(false, `Refusing to erase ${deviceId} while a recording is active or pending finalization; stop the recording first`);
                }
                const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
                if (ownedTarget.error) return textResult(false, ownedTarget.error);
                const r = run(discovery.xcrun, ["simctl", "erase", ownedTarget.target]);
                if (r.status !== 0) return fail(r);
                const updated = updateIosDevice(deviceId, (item) => ({
                    ...item,
                    status: "stopped",
                    bootReady: false,
                    lastReset: { eraseSimulator: true, resetAt: now(), stdout: r.stdout, stderr: r.stderr },
                    updatedAt: now(),
                }));
                return jsonResult({ reset: { eraseSimulator: true }, device: updated, stdout: r.stdout, stderr: r.stderr, provider: "simctl" });
            }

            if (!bundleId) return textResult(false, "iOS Simulator reset requires bundleId or eraseSimulator=true");
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const type = iosContainerType(containerType);
            const container = resolveIosAppContainer(discovery.xcrun, ownedTarget.target, bundleId, type);
            if (container.error) return fail(container.error);
            const containment = ensureContainerPathForRead(container.containerRoot, container.containerRoot);
            if (containment.error) return textResult(false, containment.error);
            clearDirectoryContents(container.containerRoot);
            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                lastReset: { bundleId, containerType: type, containerRoot: container.containerRoot, resetAt: now() },
                updatedAt: now(),
            }));
            return jsonResult({ reset: { bundleId, containerType: type }, containerRoot: container.containerRoot, device: updated, provider: "simctl-app-container" });
        }

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleIosTool("device_screenshot", { deviceId });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ deviceId, ...iosAppiumStatus(device) });
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const resolved = await iosAppiumSource(deviceId);
            if (resolved.unknown) return undefined;
            if (resolved.result) return resolved.result;

            return jsonResult({
                provider: "appium-xcuitest",
                source: resolved.source,
                sessionId: resolved.session.sessionId,
                serverUrl: resolved.session.serverUrl,
            });
        }

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "openurl", ownedTarget.target, url]);
            return r.status === 0 ? jsonResult({ openedUrl: url, provider: "simctl", stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "device_install_app": {
            const { deviceId, path } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = runWithTimeout(discovery.xcrun, ["simctl", "install", ownedTarget.target, path], 300_000);
            return r.status === 0 ? jsonResult({ installed: path, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "mobile_install_app": {
            const { deviceId, path } = args;
            return handleIosTool("device_install_app", { deviceId, path });
        }

        case "device_launch_app": {
            const { deviceId, bundleId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "launch", ownedTarget.target, bundleId]);
            return r.status === 0 ? jsonResult({ launched: bundleId, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "mobile_launch_app": {
            const { deviceId, bundleId } = args;
            return handleIosTool("device_launch_app", { deviceId, bundleId });
        }

        case "mobile_uninstall_app": {
            const { deviceId, bundleId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS Simulator mobile_uninstall_app requires bundleId");

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "uninstall", ownedTarget.target, bundleId]);
            return r.status === 0 ? jsonResult({ uninstalled: bundleId, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_stop_app": {
            const { deviceId, bundleId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS Simulator mobile_stop_app requires bundleId");

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "terminate", ownedTarget.target, bundleId]);
            return r.status === 0 ? jsonResult({ stopped: bundleId, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_clear_app_data": {
            const { deviceId, bundleId, containerType } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS Simulator mobile_clear_app_data requires bundleId");
            return handleIosTool("device_reset", { deviceId, bundleId, containerType });
        }

        case "mobile_grant_permission":
        case "mobile_revoke_permission": {
            const { deviceId, bundleId, service } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId || !service) return textResult(false, `iOS Simulator ${name} requires bundleId and service`);

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const action = name === "mobile_grant_permission" ? "grant" : "revoke";
            const r = run(discovery.xcrun, ["simctl", "privacy", ownedTarget.target, action, service, bundleId]);
            return r.status === 0 ? jsonResult({ permission: { bundleId, service, action }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_set_location": {
            const { deviceId, latitude, longitude } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "location", ownedTarget.target, "set", `${latitude},${longitude}`]);
            return r.status === 0 ? jsonResult({ location: { latitude, longitude }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_set_clipboard": {
            const { deviceId, text } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = runWithInput(discovery.xcrun, ["simctl", "pbcopy", ownedTarget.target], String(text));
            return r.status === 0 ? jsonResult({ clipboard: { set: true }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_get_clipboard": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const r = run(discovery.xcrun, ["simctl", "pbpaste", ownedTarget.target]);
            return r.status === 0 ? jsonResult({ text: r.stdout, stderr: r.stderr, status: r.status, provider: "simctl" }) : fail(r);
        }

        case "mobile_wait_for_app": {
            const { deviceId, bundleId, timeoutMs, intervalMs } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS Simulator wait-for-app requires bundleId");

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);
            const ownedTarget = resolveOwnedSimulatorTarget(discovery.xcrun, device);
            if (ownedTarget.error) return textResult(false, ownedTarget.error);
            const result = await waitForIosApp(discovery.xcrun, ownedTarget.target, bundleId, timeoutMs, intervalMs);
            if (result.error) return fail(result.error);
            return jsonResult({ ...result, bundleId, provider: "simctl" });
        }

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
            return controlTransfer.handle(name, args);

        case "mobile_wait_for_text": {
            const { deviceId, text, timeoutMs, intervalMs } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!text) return textResult(false, "iOS Simulator wait-for-text requires text");
            const resolved = await iosAppiumSessionOrResult(deviceId);
            if (resolved.unknown) return undefined;
            if (resolved.result) return resolved.result;
            const { session } = resolved;
            const budget = createWaitBudget(timeoutMs, intervalMs);
            let lastSource = "";
            let observed = false;
            while (budget.remaining() > 0) {
                try {
                    guardIosObservation(deviceId, device, session);
                    const allowance = budget.requestTimeout(5000);
                    if (!allowance) throw new Error("Appium observation budget exhausted before source request");
                    const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/source`, {
                        method: "GET", timeoutMs: allowance,
                    });
                    guardIosObservation(deviceId, device, session);
                    if (budget.remaining() <= 0) throw new Error("Appium source observation timed out");
                    observed = true;
                    lastSource = String((response?.value ?? response?.source ?? response) || "");
                    if (lastSource.includes(text)) return jsonResult({ found: true, text, source: lastSource, provider: "appium-xcuitest" });
                } catch (error) {
                    return textResult(false, `iOS Simulator Appium source request failed: ${error.message}`);
                }
                await budget.pause();
            }
            if (!observed) return textResult(false, "Appium observation budget exhausted before source request");
            return jsonResult({ found: false, text, source: lastSource, timeoutMs: budget.timeoutMs, provider: "appium-xcuitest" });
        }

        case "mobile_back":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_set_battery":
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedMobileResult(name);
        }

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
    ], executable: name => commandPath(name), records: () => readIosDevices(), simulators: (xcrun, args) => simctlJson(xcrun, args), ownedTarget: (xcrun, device, inventory) => resolveOwnedSimulatorTarget(xcrun, device, inventory), publishObserved: (device, status, simulatorName) => updateIosDevice(device.id, item => item.updatedAt === device.updatedAt && item.status === device.status && item.udid === device.udid && item.simulatorName === device.simulatorName ? { ...item, simulatorName: simulatorName || item.simulatorName, status, updatedAt: now() } : item) });

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
    requestSession: (session, path, body) => fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
    }),
    jsonResult: value => jsonResult(value),
    textResult: (ok, message) => textResult(ok, message),
    ownedSimulatorName: name => isOwnedSimulatorName(name),
    discovery: () => iosDiscovery(),
    missingPrerequisites: facts => missingPrereqResult(facts),
    verifyTarget: (xcrun, device) => resolveOwnedSimulatorTarget(xcrun, device),
    appContainerCommand: (xcrun, target, bundleId, type) => run(xcrun, ["simctl", "get_app_container", target, bundleId, type]),
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
    fail: result => fail(result),
});
