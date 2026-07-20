import assert from "assert";
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readMacosDevices, writeMacosDevices } from "../../device-lab-mcp/src/state/macos-state.mjs";
import { lifecycleDevice, parseContractToolPayload, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { discoverTartSourceImage, inspectTartInstance } from "./providers/tart.ts";
import { macosVmE2EOptions } from "./typed-options.ts";

export { parseTartListImages, selectAutoTartSourceImage, selectAutoTartSourceImageFromListResults } from "./providers/tart.ts";

function commandPath(command) {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf-8",
        env: process.env,
        windowsHide: true,
    });
    if (result.status !== 0) return null;
    return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function bootTimeoutMs() {
    const value = Number(process.env.CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS || 10000);
    return Number.isFinite(value) && value > 0 ? value : 10000;
}

function optionTimeoutMs(value, fallback) {
    const parsed = Number(value || fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runBestEffort(command, args, timeoutMs = 60000) {
    if (!command) return null;
    return spawnSync(command, args, {
        encoding: "utf-8",
        env: process.env,
        timeout: timeoutMs,
        windowsHide: true,
    });
}

function sourceImageSkipReason(source) {
    if (!source.auto) return "missing CCC_REAL_MACOS_VM_SOURCE_IMAGE";
    if (source.candidates?.length > 0) return `${source.reason}; set CCC_REAL_MACOS_VM_SOURCE_IMAGE to one candidate`;
    return source.reason || "no usable local Tart images found; set CCC_REAL_MACOS_VM_SOURCE_IMAGE=<image-or-vm>";
}

function discoverAutoSourceImage(tart) {
    return discoverTartSourceImage(tart, { run: runBestEffort });
}

export function sourceImage(tart) {
    const primary = (process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE || "").trim();
    const compatibility = (process.env.CCC_REAL_TART_SOURCE_IMAGE || "").trim();
    const configured = primary || compatibility;
    if (!configured || configured.toLowerCase() === "auto") return discoverAutoSourceImage(tart);
    return { source: configured, auto: false, candidates: [] };
}

function cleanupTartInstances(tart, instances) {
    for (const instance of [...new Set(instances.filter(Boolean))]) {
        runBestEffort(tart, ["stop", instance], 60000);
        runBestEffort(tart, ["delete", instance], 60000);
    }
}

function cleanupMacosStateDevice(deviceId) {
    writeMacosDevices(readMacosDevices().filter((device) => device.id !== deviceId));
}

function autoSshKeyPath() {
    return join(homedir(), ".ccc", "devices", "real-tests", "macos-vm-ssh", "id_ed25519");
}

function ensureAutoSshKey() {
    const keyPath = autoSshKeyPath();
    if (existsSync(keyPath)) return { keyPath, generated: false };
    const sshKeygen = commandPath("ssh-keygen");
    if (!sshKeygen) return { keyPath: "", generated: false, error: "missing ssh-keygen" };
    mkdirSync(join(homedir(), ".ccc", "devices", "real-tests", "macos-vm-ssh"), { recursive: true });
    const result = runBestEffort(sshKeygen, [
        "-t", "ed25519",
        "-N", "",
        "-f", keyPath,
        "-C", "ccc-real-macos-vm-e2e",
    ], 30000);
    if (result?.status !== 0) {
        return {
            keyPath: "",
            generated: false,
            error: result?.stderr || result?.stdout || `ssh-keygen exited ${result?.status ?? "unknown"}`,
        };
    }
    try { chmodSync(keyPath, 0o600); } catch { /* ssh-keygen normally sets this */ }
    return { keyPath, generated: true };
}

function defaultSshUser() {
    const configured = (process.env.CCC_REAL_MACOS_VM_DEFAULT_SSH_USER || "").trim();
    if (configured) return configured;
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
        const projectUser = String(pkg.name || "")
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "")
            .replace(/^[^a-z_]+/, "")
            .slice(0, 32);
        if (projectUser) return projectUser;
    } catch {
        // Fall through to the stable ccc account name.
    }
    return "ccc";
}

export function sshConfig() {
    const explicitSshUser = ((process.env.CCC_REAL_MACOS_VM_SSH_USER || "").trim() || (process.env.CCC_REAL_TART_SSH_USER || "").trim());
    const sshHost = ((process.env.CCC_REAL_MACOS_VM_SSH_HOST || "").trim() || (process.env.CCC_REAL_TART_SSH_HOST || "").trim());
    const sshPort = Number(process.env.CCC_REAL_MACOS_VM_SSH_PORT || process.env.CCC_REAL_TART_SSH_PORT || 22);
    const configuredSshKeyPath = ((process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH || "").trim() || (process.env.CCC_REAL_TART_SSH_KEY_PATH || "").trim());
    const sshUser = explicitSshUser || defaultSshUser();
    const autoKey = !configuredSshKeyPath ? ensureAutoSshKey() : null;
    const sshKeyPath = configuredSshKeyPath || autoKey?.keyPath || "";
    return {
        available: true,
        sshUser,
        ...(sshHost ? { sshHost } : {}),
        sshPort: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : 22,
        ...(sshKeyPath ? { sshKeyPath } : {}),
        ...(autoKey?.keyPath ? { generatedSshKeyPath: autoKey.keyPath, generatedSshPublicKeyPath: `${autoKey.keyPath}.pub`, generatedSshKey: autoKey.generated } : {}),
        ...(autoKey?.error ? { sshKeyGenerationError: autoKey.error } : {}),
    };
}

function parsePayload(result) {
    return parseToolPayload(result);
}

async function timedStep(timings, name, fn) {
    const startedAt = Date.now();
    try {
        return await fn();
    } finally {
        timings[name] = Date.now() - startedAt;
    }
}

export function macosVmE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    if (process.platform !== "darwin") return { available: false, reason: "not a macOS host" };
    const tart = commandPath("tart");
    if (!tart) return { available: false, reason: "missing tart" };
    const source = sourceImage(tart);
    if (!source.source) {
        return {
            available: false,
            reason: sourceImageSkipReason(source),
            tart,
            sourceCandidates: source.candidates,
        };
    }
    return { available: true, reason: "ready", tart, source: source.source, sourceAuto: source.auto, sourceCandidates: source.candidates };
}

/** @param {{ level?: number; bootTimeoutMs?: number; helperTimeoutMs?: number; snapshot?: boolean; imageTools?: boolean; [key: string]: unknown }} options */
export async function runMacosVmE2E(options: any = {}) {
    const typedOptions = macosVmE2EOptions(options);
    const level = Number(typedOptions.level || process.env.CCC_TEST_LEVEL || "0");
    const cap = macosVmE2ECapability(level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };

    const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const name = `Level ${level} macOS E2E ${suffix}`;
    const deviceId = `macos-level${level}-e2e-${suffix}`;
    const snapshotName = `Level ${level} Snapshot ${suffix}`;
    let created = false;
    let stopped = false;
    let deleted = false;
    const ssh = sshConfig();
    const managedProviderInstances = [];
    const disposableDeviceIds = [];
    const timings = {};

    return withDeviceLabMcp(async ({ callTool }) => {
        const direct = { backend: "macos-vm" };
        const macosImage = { backend: "macos-vm" };
        try {
            const create = await timedStep(timings, "createMs", async () => parsePayload(await callTool("device_base_image_create", {
                ...macosImage,
                name,
                deviceId,
                sourceImage: cap.source,
                provider: "tart",
                ...(ssh.available ? {
                    sshUser: ssh.sshUser,
                    sshPort: ssh.sshPort,
                    ...(ssh.sshHost ? { sshHost: ssh.sshHost } : {}),
                    ...(ssh.sshKeyPath ? { sshKeyPath: ssh.sshKeyPath } : {}),
                } : {}),
            })));
        created = true;
        const createdDevice = lifecycleDevice(create, "macOS VM device_base_image_create");
        assert.strictEqual(createdDevice.id, deviceId);
        assert.strictEqual(createdDevice.provider, "tart");
        assert.ok(createdDevice.providerInstance);
        managedProviderInstances.push(createdDevice.providerInstance);

            const start = await timedStep(timings, "startMs", async () => parseContractToolPayload("device_start", await callTool("device_start", {
                ...direct,
                deviceId,
                headless: true,
                waitForBoot: !ssh.sshHost,
                bootTimeoutMs: optionTimeoutMs(typedOptions.bootTimeoutMs, bootTimeoutMs()),
            })));
        const startedDevice = lifecycleDevice(start, "macOS VM device_start");
        assert.strictEqual(startedDevice.id, deviceId);
        assert.ok(["running", "starting"].includes(startedDevice.status));
        const tartAfterStart = inspectTartInstance(cap.tart, createdDevice.providerInstance);
        assert.strictEqual(tartAfterStart.found, true, `Tart instance missing after start: ${createdDevice.providerInstance}`);
        assert.match(tartAfterStart.image.state, /running|started/i, JSON.stringify(tartAfterStart));
        if (start.boot?.ready === true) assert.ok(start.boot.ip);
        const guestHost = ssh.sshHost || start.boot?.ip || "";
        const canExerciseGuest = Boolean(ssh.available && guestHost);
        if (canExerciseGuest) {
            assert.strictEqual(start.helper.status, "provisioned");
            assert.strictEqual(startedDevice.helper.ssh.host, guestHost);
            assert.strictEqual(startedDevice.helper.ssh.user, ssh.sshUser);
        }

            const status = await timedStep(timings, "statusMs", async () => parseContractToolPayload("device_status", await callTool("device_status", { ...direct, deviceId })));
        const statusDevice = lifecycleDevice(status, "macOS VM device_status");
        assert.strictEqual(statusDevice.id, deviceId);
        assert.ok(["running", "starting"].includes(statusDevice.status));
        assert.strictEqual(statusDevice.providerInstance, createdDevice.providerInstance);

        const boot = start.boot?.ready === true
            ? { ready: true, ip: start.boot.ip }
            : { ready: false, reason: start.boot?.error || start.boot?.stderr || "Tart did not report a guest IP" };
        let guest = { exercised: false, reason: ssh.available ? "missing SSH host/IP" : "SSH helper not enabled" };
        if (canExerciseGuest) {
            guest = await timedStep(timings, "guestMs", async () => {
                const helperTimeoutMs = optionTimeoutMs(
                    typedOptions.helperTimeoutMs,
                    Number(process.env.CCC_REAL_MACOS_VM_HELPER_TIMEOUT_MS || process.env.CCC_MACOS_VM_HELPER_TIMEOUT_MS || 30000),
                );
                const exec = parsePayload(await callTool("device_exec", {
                    ...direct,
                    deviceId,
                    command: "printf ccc-macos-vm-e2e-ok",
                    helperTimeoutMs,
                }));
                assert.match(exec.stdout, /ccc-macos-vm-e2e-ok/);

                const uploadLocalPath = join(process.cwd(), `.ccc-macos-vm-e2e-upload-${suffix}.txt`);
                const downloadLocalPath = join(process.cwd(), `.ccc-macos-vm-e2e-download-${suffix}.txt`);
                const remotePath = `/tmp/ccc-macos-vm-e2e-${suffix}.txt`;
                writeFileSync(uploadLocalPath, `ccc-macos-vm-e2e-file-${suffix}`);
                try {
                    const upload = parsePayload(await callTool("device_upload", {
                        ...direct,
                        deviceId,
                        localPath: uploadLocalPath,
                        remotePath,
                        helperTimeoutMs,
                    }));
                    assert.strictEqual(upload.provider, "scp");
                    assert.strictEqual(upload.uploaded.localPath, uploadLocalPath);
                    assert.strictEqual(upload.uploaded.remotePath, remotePath);

                    const download = parsePayload(await callTool("device_download", {
                        ...direct,
                        deviceId,
                        remotePath,
                        localPath: downloadLocalPath,
                        helperTimeoutMs,
                    }));
                    assert.strictEqual(download.provider, "scp");
                    assert.strictEqual(download.downloaded.remotePath, remotePath);
                    assert.strictEqual(download.downloaded.localPath, downloadLocalPath);
                    assert.strictEqual(readFileSync(downloadLocalPath, "utf-8"), `ccc-macos-vm-e2e-file-${suffix}`);
                } finally {
                    try { await callTool("device_exec", { ...direct, deviceId, command: `rm -f '${remotePath.replace(/'/g, "'\\''")}'`, helperTimeoutMs }); } catch { /* preserve primary failure */ }
                    rmSync(uploadLocalPath, { force: true });
                    rmSync(downloadLocalPath, { force: true });
                }

                const screenshot = await callTool("device_screenshot", { ...direct, deviceId, helperTimeoutMs });
                assert.strictEqual(screenshot?.content?.[0]?.type, "image");
                assert.ok(String(screenshot.content[0].data || "").length > 64);

                for (const button of ["left", "right"]) {
                    const click = parsePayload(await callTool("device_click", { ...direct, deviceId, x: 20, y: 20, button, helperTimeoutMs }));
                    assert.strictEqual(click.provider, "ssh-macos-helper");
                    assert.deepStrictEqual(click.clicked, { x: 20, y: 20, button });
                }

                for (const button of ["left", "right"]) {
                    const doubleClick = parsePayload(await callTool("device_double_click", { ...direct, deviceId, x: 30, y: 30, button, helperTimeoutMs }));
                    assert.strictEqual(doubleClick.provider, "ssh-macos-helper");
                    assert.deepStrictEqual(doubleClick.doubleClicked, { x: 30, y: 30, button });
                }

                const key = parsePayload(await callTool("device_key", { ...direct, deviceId, key: "Escape", helperTimeoutMs }));
                assert.strictEqual(key.provider, "ssh-macos-helper");
                assert.deepStrictEqual(key.key, { key: "Escape", keyCode: 53, modifiers: [] });

                const type = parsePayload(await callTool("device_type", { ...direct, deviceId, text: "ccc-macos-type-e2e", helperTimeoutMs }));
                assert.strictEqual(type.provider, "ssh-macos-helper");
                assert.deepStrictEqual(type.typed, { text: "ccc-macos-type-e2e" });

                for (const direction of ["up", "down", "left", "right"]) {
                    const scroll = parsePayload(await callTool("device_scroll", { ...direct, deviceId, direction, amount: 1, helperTimeoutMs }));
                    assert.strictEqual(scroll.provider, "ssh-macos-helper");
                    assert.deepStrictEqual(scroll.scrolled, { direction, amount: 1 });
                }

                const windows = parsePayload(await callTool("device_window_list", { ...direct, deviceId, helperTimeoutMs }));
                assert.ok(Array.isArray(windows.windows));

                const cursor = parsePayload(await callTool("device_cursor_position", { ...direct, deviceId, helperTimeoutMs }));
                assert.strictEqual(cursor.provider, "ssh-macos-helper");
                assert.ok(cursor.cursor === null || typeof cursor.cursor === "object");

                const accessibility = parsePayload(await callTool("device_accessibility_snapshot", { ...direct, deviceId, maxDepth: 1, maxNodes: 20, helperTimeoutMs }));
                assert.ok(["macos-system-events", "ssh-macos-helper"].includes(accessibility.provider));
                assert.ok(accessibility.accessibility === null || typeof accessibility.accessibility === "object");

                const recordingStatus = parsePayload(await callTool("device_record_video_status", { ...direct, deviceId }));
                assert.strictEqual(recordingStatus.provider, "ssh-screencapture-video");
                assert.strictEqual(recordingStatus.deviceId, deviceId);
                return {
                    exercised: true,
                    sshHost: startedDevice.helper.ssh.host,
                    sshUser: ssh.sshUser,
                    sshKeyPath: ssh.sshKeyPath || null,
                    generatedSshPublicKeyPath: ssh.generatedSshPublicKeyPath || null,
                    helperTimeoutMs,
                    uploadDownloaded: true,
                };
            });
        }

            const stop = await timedStep(timings, "stopMs", async () => parseContractToolPayload("device_stop", await callTool("device_stop", { ...direct, deviceId })));
        stopped = true;
        assert.strictEqual(stop.device.status, "stopped");
        const tartAfterStop = inspectTartInstance(cap.tart, createdDevice.providerInstance);
        assert.strictEqual(tartAfterStop.found, true, `Tart instance missing after stop: ${createdDevice.providerInstance}`);
        assert.match(tartAfterStop.image.state, /stopped/i, JSON.stringify(tartAfterStop));

        let snapshot = null;
        if (typedOptions.snapshot === true) {
            snapshot = await timedStep(timings, "snapshotMs", async () => {
                const createdSnapshot = parsePayload(await callTool("device_snapshot_create", { ...direct, deviceId, snapshotName })).snapshot;
                assert.ok(createdSnapshot.providerInstance);
                managedProviderInstances.push(createdSnapshot.providerInstance);
                const snapshotRestore = parsePayload(await callTool("device_snapshot_restore", { ...direct, deviceId, snapshotName, force: true, confirmDestructive: true }));
                assert.strictEqual(snapshotRestore.device.restoredFrom.id, createdSnapshot.id);
                assert.strictEqual(snapshotRestore.device.restoredFrom.name, snapshotName);
                const snapshotDelete = parsePayload(await callTool("device_snapshot_delete", { ...direct, deviceId, snapshotName, confirmDestructive: true }));
                assert.strictEqual(snapshotDelete.deleted, createdSnapshot.id);
                managedProviderInstances.splice(managedProviderInstances.indexOf(createdSnapshot.providerInstance), 1);
                return createdSnapshot;
            });
        }

        if (typedOptions.imageTools === true) {
            await timedStep(timings, "imageToolsMs", async () => {
                const createViaBase = parsePayload(await callTool("device_base_image_create", {
                    ...macosImage,
                    name: `Base create ${suffix}`,
                    deviceId: `${deviceId}-base-create`,
                    sourceImage: cap.source,
                    provider: "tart",
                }));
                disposableDeviceIds.push(createViaBase.device.id);
                managedProviderInstances.push(createViaBase.device.providerInstance);
                assert.strictEqual(createViaBase.operation, "base-image-create");
                assert.ok(createViaBase.device.providerInstance);

                const cloneViaBase = parsePayload(await callTool("device_base_image_clone", {
                    ...macosImage,
                    name: `Base clone ${suffix}`,
                    deviceId: `${deviceId}-base-clone`,
                    sourceDeviceId: deviceId,
                    provider: "tart",
                }));
                disposableDeviceIds.push(cloneViaBase.device.id);
                managedProviderInstances.push(cloneViaBase.device.providerInstance);
                assert.strictEqual(cloneViaBase.operation, "base-image-clone");
                assert.ok(cloneViaBase.device.providerInstance);

                for (const disposableId of [...disposableDeviceIds]) {
                    const removed = parseContractToolPayload("device_delete", await callTool("device_delete", { ...direct, deviceId: disposableId, force: true, confirmDestructive: true }));
                    assert.strictEqual(removed.deleted, disposableId);
                    disposableDeviceIds.splice(disposableDeviceIds.indexOf(disposableId), 1);
                    for (const providerInstance of removed.providerDeleted || []) {
                        const index = managedProviderInstances.indexOf(providerInstance);
                        if (index >= 0) managedProviderInstances.splice(index, 1);
                    }
                }
            });
        }

            const del = await timedStep(timings, "deleteMs", async () => parseContractToolPayload("device_delete", await callTool("device_delete", { ...direct, deviceId, force: true, confirmDestructive: true })));
        deleted = true;
        assert.strictEqual(del.deleted, deviceId);
            const tartAfterDelete = inspectTartInstance(cap.tart, createdDevice.providerInstance);
            assert.strictEqual(tartAfterDelete.found, false, `Tart instance survived delete: ${createdDevice.providerInstance}`);
            const listAfterDelete = await timedStep(timings, "statusAfterDeleteMs", async () => parsePayload(await callTool("device_list")));
            assert.strictEqual(listAfterDelete.devices.some((device) => device.id === deviceId), false);
        const timingDetail = Object.entries(timings).map(([key, value]) => `${key}=${value}`).join(" ");

        return {
            status: "PASS",
            detail: `device=${deviceId} vm=${createdDevice.providerInstance} boot=${boot.ready ? `ip:${boot.ip}` : "no-ip"} guest=${guest.exercised ? "ssh" : "not-configured"} snapshot=${typedOptions.snapshot === true ? "yes" : "no"} ${timingDetail}`,
            provider: "tart",
            source: cap.source,
            deviceId,
            vmName: createdDevice.providerInstance,
            providerInstance: createdDevice.providerInstance,
            boot,
            ip: boot.ready ? boot.ip : null,
            guest,
            timings,
            snapshot: typedOptions.snapshot === true,
            snapshotProviderInstance: snapshot?.providerInstance || null,
        };
        } finally {
            if (created && !stopped) {
                try { await callTool("device_stop", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
            if (created && !deleted) {
                try { await callTool("device_delete", { ...direct, deviceId, force: true, confirmDestructive: true }); } catch { /* preserve primary failure */ }
                cleanupTartInstances(cap.tart, managedProviderInstances);
                cleanupMacosStateDevice(deviceId);
            }
            for (const disposableId of disposableDeviceIds) {
                try { await callTool("device_delete", { ...direct, deviceId: disposableId, force: true, confirmDestructive: true }); } catch { /* preserve primary failure */ }
                cleanupMacosStateDevice(disposableId);
            }
        }
    }, providerMcpSessionOptions(options, "ccc-real-macos-vm-e2e"));
}
