import assert from "assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { hiddenSpawnSync, realProviderTempRoot } from "./helpers.mjs";
import {
    windowsBackend,
    windowsDiscovery,
} from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.mjs";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.mjs";

const WSB_LIST_TIMEOUT_MS = 10000;
const WSB_STOP_TIMEOUT_MS = 60000;

function parsePayload(result) {
    return parseToolPayload(result);
}

function responseText(result) {
    return result?.content?.[0]?.text || "";
}

function assertReportedLocalPath(actual, expected, brokerOnly) {
    if (brokerOnly) {
        assert.ok(String(actual || "").replace(/\\/g, "/").endsWith(`/${basename(expected)}`));
        return;
    }
    assert.strictEqual(actual, expected);
}

export function windowsRecordingPayload(payload) {
    return payload?.recording ? payload : payload?.result && typeof payload.result === "object" ? payload.result : payload;
}

export function windowsRecordingState(payload) {
    const normalized = windowsRecordingPayload(payload);
    return normalized?.recording && typeof normalized.recording === "object" ? normalized.recording : normalized;
}

export function findImageContent(result) {
    return Array.isArray(result?.content)
        ? result.content.find((item) => item?.type === "image") || null
        : null;
}

function isWindowsSandboxSingleUseError(result) {
    const text = responseText(result);
    return result?.isError === true && (/CO_E_APPSINGLEUSE/i.test(text) || /0x800401F6/i.test(text));
}

function collectGuids(value, output = new Set()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
            output.add(match[0]);
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectGuids(item, output);
        return output;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectGuids(item, output);
    }
    return output;
}

export function windowsSandboxSessionIdsFromListOutput(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        return [...collectGuids(parsed)];
    } catch {
        return [...collectGuids(stdout)];
    }
}

export function listRunningWindowsSandboxSessions(options = {}) {
    const discovery = windowsDiscovery();
    const wsb = options.wsb || discovery.wsb;
    const runner = (command, args, runOptions = {}) => {
        return (options.runner || hiddenSpawnSync)(command, args, { ...runOptions, windowsHide: true });
    };
    if (!wsb) return { ok: false, ids: [], error: "missing wsb" };
    const listed = runner(wsb, ["list", "--raw"], { encoding: "utf-8", timeout: WSB_LIST_TIMEOUT_MS });
    if (listed.status !== 0) {
        return {
            ok: false,
            ids: [],
            error: listed.stderr || listed.stdout || listed.error?.message || `wsb list failed: ${listed.status}`,
        };
    }
    return { ok: true, ids: windowsSandboxSessionIdsFromListOutput(listed.stdout || "") };
}

export function stopRunningWindowsSandboxSessions(options = {}) {
    const discovery = windowsDiscovery();
    const wsb = options.wsb || discovery.wsb;
    const runner = (command, args, runOptions = {}) => {
        return (options.runner || hiddenSpawnSync)(command, args, { ...runOptions, windowsHide: true });
    };
    const verifiedIds = new Set(options.verifiedSessionIds || []);
    const preExistingIds = new Set(options.preExistingSessionIds || []);
    if (verifiedIds.size === 0) return { ok: false, stopped: [], error: "no verified test-owned sessions" };
    const listed = listRunningWindowsSandboxSessions(options);
    if (!listed.ok) return { ok: false, stopped: [], error: listed.error };
    const ids = listed.ids.filter((id) => verifiedIds.has(id) && !preExistingIds.has(id));
    const stopped = [];
    const failed = [];
    for (const id of ids) {
        const result = runner(wsb, ["stop", "--id", id], { encoding: "utf-8", timeout: WSB_STOP_TIMEOUT_MS });
        if (result.status === 0) stopped.push(id);
        else failed.push({ id, error: result.stderr || result.stdout || result.error?.message || `wsb stop failed: ${result.status}` });
    }
    return { ok: failed.length === 0, stopped, failed };
}

export function verifiedWindowsSandboxSessionId(statusPayload, deviceId) {
    const device = statusPayload?.device || statusPayload?.result?.device;
    if (device?.id !== deviceId) return null;
    return typeof device.sandboxId === "string" && device.sandboxId ? device.sandboxId : null;
}

function windowsStateFile(homeDir, owner) {
    return join(homeDir, ".ccc/devices/owners", owner, "windows", "devices.json");
}

function windowsDeviceDir(homeDir, owner, deviceId) {
    return join(homeDir, ".ccc/devices/owners", owner, "windows", deviceId);
}

function readWindowsStateDevices(homeDir, owner) {
    const file = windowsStateFile(homeDir, owner);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
        return [];
    }
}

function writeWindowsStateDevices(homeDir, owner, devices) {
    writeFileSync(windowsStateFile(homeDir, owner), JSON.stringify({ devices }, null, 2));
}

function cleanupFailure(operation, deviceId, error) {
    const detail = error?.message || String(error);
    return new Error(`Windows Sandbox ${operation} failed for ${deviceId}; ownership evidence was preserved: ${detail}`, { cause: error });
}

function assertStoppedCleanupResult(result, deviceId) {
    const payload = parsePayload(result);
    if (payload?.device?.id !== deviceId || payload?.device?.status !== "stopped") {
        throw new Error(`device_stop did not verify stopped state: ${JSON.stringify(payload)}`);
    }
}

function assertDeletedCleanupResult(result, deviceId) {
    const payload = parsePayload(result);
    if (payload?.deleted !== deviceId) {
        throw new Error(`device_delete did not verify deletion: ${JSON.stringify(payload)}`);
    }
}

function assertRecordingStoppedCleanupResult(result) {
    const payload = windowsRecordingPayload(parsePayload(result));
    if (payload?.stopped !== true && payload?.recording?.active !== false) {
        throw new Error(`device_record_video_stop did not verify recorder exit: ${JSON.stringify(payload)}`);
    }
}

function tryRemoveTree(path) {
    try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message || String(error), code: error?.code };
    }
}

function removeVerifiedWindowsSandboxE2EEvidence(homeDir, owner, deviceId) {
    const removed = tryRemoveTree(windowsDeviceDir(homeDir, owner, deviceId));
    if (!removed.ok) {
        throw new Error(`verified provider cleanup succeeded but device evidence removal failed for ${deviceId}: ${removed.error}`);
    }
    const stateFile = windowsStateFile(homeDir, owner);
    if (existsSync(stateFile)) {
        writeWindowsStateDevices(
            homeDir,
            owner,
            readWindowsStateDevices(homeDir, owner).filter((device) => device?.id !== deviceId),
        );
    }
    const lockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
    if (!existsSync(lockPath)) return;
    try {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (lock?.ownerId === owner && lock?.deviceId === deviceId) rmSync(lockPath, { force: true });
    } catch {
        // Preserve malformed ownership evidence for manual inspection.
    }
}

export async function cleanupCurrentWindowsSandboxE2E(options = {}) {
    const homeDir = options.homeDir || homedir();
    const owner = options.ownerId || ownerId();
    const deviceId = options.deviceId;
    const callTool = options.callTool;
    if (!deviceId || typeof callTool !== "function") {
        throw new Error("cleanupCurrentWindowsSandboxE2E requires deviceId and callTool");
    }

    if (options.recordingActive === true) {
        try {
            assertRecordingStoppedCleanupResult(await callTool("device_record_video_stop", {
                backend: "windows-sandbox",
                deviceId,
                helperTimeoutMs: options.recordingStopTimeoutMs || 10000,
            }));
        } catch (error) {
            throw cleanupFailure("recording cleanup", deviceId, error);
        }
    }
    if (options.needsStop === true) {
        try {
            assertStoppedCleanupResult(await callTool("device_stop", { backend: "windows-sandbox", deviceId }), deviceId);
        } catch (error) {
            throw cleanupFailure("device_stop", deviceId, error);
        }
    }
    try {
        assertDeletedCleanupResult(await callTool("device_delete", {
            backend: "windows-sandbox",
            deviceId,
            force: true,
            confirmDestructive: true,
        }), deviceId);
    } catch (error) {
        throw cleanupFailure("device_delete", deviceId, error);
    }

    removeVerifiedWindowsSandboxE2EEvidence(homeDir, owner, deviceId);
    return { ok: true, deviceId };
}

export async function cleanupPreviousWindowsSandboxE2E(options = {}) {
    const homeDir = options.homeDir || homedir();
    const owner = options.ownerId || ownerId();
    const callTool = options.callTool || ((name, args) => {
        throw new Error(`cleanupPreviousWindowsSandboxE2E requires callTool for provider cleanup: ${name} ${JSON.stringify(args || {})}`);
    });
    const devices = readWindowsStateDevices(homeDir, owner).filter((device) => String(device?.id || "").startsWith("windows-real-sandbox-"));
    const failures = [];
    for (const device of devices) {
        try {
            await cleanupCurrentWindowsSandboxE2E({
                homeDir,
                ownerId: owner,
                deviceId: device.id,
                callTool,
                recordingActive: device?.recording?.active === true,
                needsStop: device?.status !== "stopped",
            });
        } catch (error) {
            failures.push(error);
        }
    }
    const windowsRoot = join(homeDir, ".ccc/devices/owners", owner, "windows");
    if (existsSync(windowsRoot)) {
        for (const entry of readdirSync(windowsRoot).filter((name) => name.startsWith("windows-real-sandbox-"))) {
            if (!devices.some((device) => device.id === entry)) {
                failures.push(new Error(`Windows Sandbox orphan evidence requires manual cleanup: ${join(windowsRoot, entry)}`));
            }
        }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Previous Windows Sandbox E2E cleanup was not verified");
}

export async function startWindowsSandboxE2EDevice(callTool, deviceId, options = {}) {
    const direct = { backend: "windows-sandbox" };
    const preExisting = listRunningWindowsSandboxSessions(options);
    const startResult = await callTool("device_start", { ...direct, deviceId });
    if (!isWindowsSandboxSingleUseError(startResult)) return parsePayload(startResult);
    if (!preExisting.ok) return parsePayload(startResult);
    let status;
    try {
        status = parsePayload(await callTool("device_status", { ...direct, deviceId }));
    } catch {
        return parsePayload(startResult);
    }
    const verifiedSessionId = verifiedWindowsSandboxSessionId(status, deviceId);
    if (!verifiedSessionId) return parsePayload(startResult);
    const recovery = stopRunningWindowsSandboxSessions({
        ...options,
        verifiedSessionIds: [verifiedSessionId],
        preExistingSessionIds: preExisting.ids,
    });
    if (!recovery.ok || recovery.stopped.length !== 1) return parsePayload(startResult);
    const retryDelayMs = options.retryDelayMs ?? 500;
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return parsePayload(await callTool("device_start", { ...direct, deviceId }));
}

export function windowsSandboxE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    const discovery = windowsDiscovery();
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2", discovery };
    if (process.platform !== "win32") return { available: false, reason: "not a Windows host", discovery };
    if (!discovery.available) return { available: false, reason: `missing ${discovery.missing.join(", ")}`, discovery };
    return { available: true, reason: "ready", discovery };
}

export async function runWindowsSandboxE2E(options = {}) {
    const cap = options.brokerOnly === true
        ? { available: true, reason: "host broker capability supplied" }
        : windowsSandboxE2ECapability(options.level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };

    const deviceId = `windows-real-sandbox-${Date.now()}`;
    const tempDir = mkdtempSync(join(realProviderTempRoot(options), "ccc-windows-sandbox-e2e-"));
    const helperTimeoutMs = options.helperTimeoutMs || 180000;
    const screenshotTimeoutMs = Math.min(helperTimeoutMs, 45000);
    let created = false;
    let stopped = false;
    let deleted = false;
    let recordingActive = false;
    const advertisedCapabilities = windowsBackend().capabilities;
    const calledCapabilities = new Set();

    return withDeviceLabMcp(async ({ callTool: rawCallTool }) => {
        const callTool = async (tool, args) => {
            if (advertisedCapabilities.includes(tool)) calledCapabilities.add(tool);
            return rawCallTool(tool, args);
        };
        const direct = { backend: "windows-sandbox" };
        await cleanupPreviousWindowsSandboxE2E({ callTool });
        let primaryFailure = null;
        let passResult = null;
        try {
            const createResult = parsePayload(await callTool("device_create", {
                ...direct,
                name: "Real Windows Sandbox Test",
                deviceId,
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 2048,
            }));
            created = true;
            assert.strictEqual(createResult.device.id, deviceId);
            assert.strictEqual(createResult.device.status, "stopped");

            const inventory = parsePayload(await callTool("device_inventory", direct));
            const inventoryDevices = inventory.devices || inventory.result?.devices;
            assert.ok(Array.isArray(inventoryDevices));
            assert.ok(inventoryDevices.some((device) => device.id === deviceId));

            const started = await startWindowsSandboxE2EDevice(callTool, deviceId);
            assert.strictEqual(started.device.status, "running");
            assert.ok(String(started.device.configPath || "").includes(`${deviceId}.wsb`));

            const status = parsePayload(await callTool("device_status", { ...direct, deviceId }));
            assert.strictEqual(status.device.id, deviceId);
            assert.strictEqual(status.device.status, "running");
            assert.strictEqual(status.device.sandboxId, started.device.sandboxId);

            parsePayload(await callTool("device_exec", {
                ...direct,
                deviceId,
                command: "Write-Output ccc-windows-e2e-ok",
                helperTimeoutMs,
            }));

            const screenshot = await callTool("device_screenshot", { ...direct, deviceId, helperTimeoutMs: screenshotTimeoutMs });
            const screenshotImage = findImageContent(screenshot);
            assert.ok(screenshotImage, `Windows Sandbox screenshot returned no image content: ${responseText(screenshot)}`);
            assert.strictEqual(screenshotImage.mimeType, "image/png");
            assert.ok(String(screenshotImage.data || "").length > 64);

            for (const button of ["left", "right"]) {
                const click = parsePayload(await callTool("device_click", { ...direct, deviceId, x: 20, y: 20, button, helperTimeoutMs }));
                assert.strictEqual(click.provider, "windows-helper");
                assert.deepStrictEqual(click.clicked, { x: 20, y: 20, button });
            }

            for (const button of ["left", "right"]) {
                const doubleClick = parsePayload(await callTool("device_double_click", { ...direct, deviceId, x: 30, y: 30, button, helperTimeoutMs }));
                assert.strictEqual(doubleClick.provider, "windows-helper");
                assert.deepStrictEqual(doubleClick.doubleClicked, { x: 30, y: 30, button });
            }

            const key = parsePayload(await callTool("device_key", { ...direct, deviceId, key: "Escape", helperTimeoutMs }));
            assert.strictEqual(key.provider, "windows-helper");
            assert.strictEqual(key.key.key, "Escape");

            const type = parsePayload(await callTool("device_type", { ...direct, deviceId, text: "ccc-windows-type-e2e", helperTimeoutMs }));
            assert.strictEqual(type.provider, "windows-helper");
            assert.strictEqual(type.typed.text, "ccc-windows-type-e2e");

            for (const direction of ["up", "down", "left", "right"]) {
                const scroll = parsePayload(await callTool("device_scroll", { ...direct, deviceId, x: 40, y: 40, direction, amount: 1, helperTimeoutMs }));
                assert.strictEqual(scroll.provider, "windows-helper");
                assert.deepStrictEqual(scroll.scrolled, { x: 40, y: 40, direction, amount: 1 });
            }

            const uploadSource = join(tempDir, "upload.txt");
            writeFileSync(uploadSource, "ccc-upload-ok");
            const uploadRemote = "C:\\Users\\WDAGUtilityAccount\\Desktop\\ccc-upload.txt";
            const upload = parsePayload(await callTool("device_upload", {
                ...direct,
                deviceId,
                localPath: uploadSource,
                remotePath: uploadRemote,
                helperTimeoutMs,
            }));
            assert.strictEqual(upload.provider, "windows-helper");
            assertReportedLocalPath(upload.uploaded.localPath, uploadSource, options.brokerOnly);
            assert.strictEqual(upload.uploaded.remotePath, uploadRemote);

            const uploadVerificationTarget = join(tempDir, "upload-verification.txt");
            parsePayload(await callTool("device_download", {
                ...direct,
                deviceId,
                remotePath: uploadRemote,
                localPath: uploadVerificationTarget,
                helperTimeoutMs,
            }));
            assert.strictEqual(readFileSync(uploadVerificationTarget, "utf-8"), "ccc-upload-ok");

            const downloadRemote = "C:\\Users\\WDAGUtilityAccount\\Desktop\\ccc-download.txt";
            const downloadTarget = join(tempDir, "download.txt");
            const createDownloadRemote = parsePayload(await callTool("device_exec", {
                ...direct,
                deviceId,
                command: `Set-Content -Path ${downloadRemote} -Value ccc-download-ok -Encoding ASCII`,
                helperTimeoutMs,
            }));
            const download = parsePayload(await callTool("device_download", {
                ...direct,
                deviceId,
                remotePath: downloadRemote,
                localPath: downloadTarget,
                helperTimeoutMs,
            }));
            assert.strictEqual(download.provider, "windows-helper");
            assert.strictEqual(download.downloaded.remotePath, downloadRemote);
            assertReportedLocalPath(download.downloaded.localPath, downloadTarget, options.brokerOnly);
            assert.match(readFileSync(downloadTarget, "utf-8"), /ccc-download-ok/);

            const windows = parsePayload(await callTool("device_window_list", { ...direct, deviceId, helperTimeoutMs }));
            assert.strictEqual(windows.provider, "windows-process-main-window");
            assert.ok(Array.isArray(windows.windows));

            const cursor = parsePayload(await callTool("device_cursor_position", { ...direct, deviceId, helperTimeoutMs }));
            assert.strictEqual(cursor.provider, "windows-helper");
            assert.ok(cursor.cursor === null || typeof cursor.cursor === "object");

            const accessibility = parsePayload(await callTool("device_accessibility_snapshot", { ...direct, deviceId, maxDepth: 1, maxNodes: 20, helperTimeoutMs }));
            assert.strictEqual(accessibility.provider, "windows-uiautomation");
            assert.ok(accessibility.accessibility === null || typeof accessibility.accessibility === "object");

            const recordingPath = join(tempDir, "windows-recording.zip");
            const recordingStart = windowsRecordingPayload(parsePayload(await callTool("device_record_video_start", {
                ...direct,
                deviceId,
                localPath: recordingPath,
                timeLimitSec: 10,
                helperTimeoutMs,
            })));
            recordingActive = true;
            assert.ok(recordingStart.recording, `Windows Sandbox recording start returned no recording: ${JSON.stringify(recordingStart)}`);
            assert.strictEqual(recordingStart.recording.provider, "windows-helper-frame-archive");
            assert.strictEqual(recordingStart.recording.active, true);
            await new Promise((resolve) => setTimeout(resolve, 1500));

            const recordingStatus = windowsRecordingPayload(parsePayload(await callTool("device_record_video_status", { ...direct, deviceId, helperTimeoutMs: 5000 })));
            const recordingState = windowsRecordingState(recordingStatus);
            assert.ok(recordingState, `Windows Sandbox recording status returned no recording: ${JSON.stringify(recordingStatus)}`);
            assert.strictEqual(recordingState.active, true, `Windows Sandbox recording is not active: ${JSON.stringify(recordingStatus)}`);

            const recordingStop = windowsRecordingPayload(parsePayload(await callTool("device_record_video_stop", {
                ...direct,
                deviceId,
                localPath: recordingPath,
                helperTimeoutMs,
            })));
            assert.strictEqual(recordingStop.provider, "windows-helper-frame-archive");
            assert.strictEqual(recordingStop.stopped, true);
            recordingActive = false;
            assert.ok(existsSync(recordingPath));
            assert.ok(readFileSync(recordingPath).length > 0);

            const stoppedPayload = parsePayload(await callTool("device_stop", { ...direct, deviceId }));
            assert.strictEqual(stoppedPayload.device.id, deviceId);
            assert.strictEqual(stoppedPayload.device.status, "stopped");
            stopped = true;

            const deleteResult = parsePayload(await callTool("device_delete", { ...direct, deviceId, force: true, confirmDestructive: true }));
            assert.strictEqual(deleteResult.deleted, deviceId);
            deleted = true;

            assert.deepStrictEqual(
                advertisedCapabilities.filter((tool) => !calledCapabilities.has(tool)),
                [],
                "Windows Sandbox real E2E did not call every advertised capability",
            );

            passResult = { status: "PASS", deviceId, sandboxId: started.device.sandboxId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error) {
            primaryFailure = error;
        } finally {
            let cleanupFailureError = null;
            if (created && !deleted) {
                try {
                    await cleanupCurrentWindowsSandboxE2E({
                        callTool,
                        deviceId,
                        recordingActive,
                        needsStop: !stopped,
                    });
                } catch (error) {
                    cleanupFailureError = error;
                }
            }
            rmSync(tempDir, { recursive: true, force: true });
            if (cleanupFailureError) {
                const errors = primaryFailure ? [primaryFailure, cleanupFailureError] : [cleanupFailureError];
                throw new AggregateError(errors, `Windows Sandbox E2E cleanup failed for ${deviceId}; ownership evidence was preserved`);
            }
        }
        if (primaryFailure) throw primaryFailure;
        return passResult;
    }, providerMcpSessionOptions(options, "ccc-real-windows-sandbox-e2e"));
}
