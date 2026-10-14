import { hyperVMemoryFailureReason } from "./hyper-v-memory-diagnostic.ts";
import assert from "assert";
import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId as deviceLabOwnerId } from "#device-lab/providers/context.mjs";
import { inspectHyperVUbuntuImageCache } from "#device-lab/device-lab/broker/hyper-v/image-store.js";
import { hyperVLinuxImageBlockers, hyperVLinuxImageSkipReason } from "#device-lab/device-lab/hyper-v-linux-image-readiness.js";
import { hyperVReadinessCommand, parseHyperVReadiness } from "#device-lab/host-control/hyper-v/index.js";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { brokerToolFailureEvidence, formatBrokerToolFailure, lifecycleDevice, markExpectedToolError, parseToolPayload, parseToolResult, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { runHyperVGuiE2E } from "./hyper-v-gui-e2e.ts";

import { readHyperVFixtureDeviceIds, recordHyperVFixtureDeviceId } from "../durability/real-provider-cycles.mjs";
const CAPABILITIES = [
    "devices", "create_linux_vm", "delete", "start", "stop", "reboot", "status",
    "exec", "upload", "download",
    "snapshot", "snapshot", "snapshot", "snapshot",
];
// Release this device's allocation but keep the shared managed switch, gateway and NAT, as the
// Windows E2E does. Tearing that fabric down needs a UAC prompt, which an unattended Level 3 run
// cannot answer; the 2026-09-25 host run failed its final delete exactly there.
export const HYPER_V_LINUX_E2E_DELETE_OPTIONS = Object.freeze({
    force: true,
    confirmDestructive: true,
    preserveNetwork: true,
});

export const HYPER_V_LINUX_PRE_REBOOT_COMMAND = "uname -sr && sudo test -s /etc/netplan/99-ccc-static.yaml && sudo netplan generate && sudo sync && printf ccc-hyper-v-linux-e2e-ok";

export function prepareHyperVLinuxDownloadDestination(path: string) {
    writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function hyperVLinuxToolPayload(result: any) {
    const value = result?.isError === true ? parseToolResult(result) : parseToolPayload(result);
    if (result?.isError === true || value?.ok === false) {
        const error = new Error(formatBrokerToolFailure(value, "Hyper-V Linux broker operation failed"));
        Object.defineProperty(error, "brokerPayload", { value });
        throw error;
    }
    return value;
}

function boundedFailureMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const codes = message.match(/\b(?:broker|hyper-v|powershell|ssh)-[a-z0-9-]{2,128}\b/g) || [];
    return codes.length > 0 ? [...new Set(codes)].slice(0, 8).join(",") : "failure-message-redacted";
}

function terminalFailureSummary(error: unknown) {
    const memoryFailure = hyperVMemoryFailureReason((error as any)?.brokerPayload);
    if (memoryFailure) return memoryFailure;
    return (error as any)?.brokerPayload
        ? formatBrokerToolFailure((error as any).brokerPayload, "Hyper-V Linux broker operation failed")
        : boundedFailureMessage(error);
}

function boundedDiagnosticIdentity(value: unknown, fallback: string) {
    return typeof value === "string"
        && value.length <= 128
        && /^[A-Za-z0-9 ._:+-]+$/.test(value)
        ? value
        : fallback;
}

export function writeHyperVLinuxFailureDiagnostic(input: {
    outputRoot?: string;
    step: string;
    created: boolean;
    error: unknown;
}) {
    const outputRoot = input.outputRoot || join(repoRoot, "results", "device-lab-real");
    mkdirSync(outputRoot, { recursive: true });
    const generatedAt = new Date().toISOString();
    const timestamp = generatedAt.replace(/[:.]/g, "-");
    const record = {
        schemaVersion: 1,
        generatedAt,
        backend: "linux-vm",
        step: boundedDiagnosticIdentity(input.step, "unknown-step"),
        created: input.created,
        failure: (input.error as any)?.brokerPayload
            ? brokerToolFailureEvidence((input.error as any).brokerPayload)
            : { message: boundedFailureMessage(input.error) },
        privacy: "Host paths, credentials, VM names, endpoints, and raw command output are omitted.",
    };
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const timestampedPath = join(outputRoot, `hyper-v-linux-diagnostic-${timestamp}.json`);
    const latestPath = join(outputRoot, "hyper-v-linux-diagnostic-latest.json");
    for (const target of [timestampedPath, latestPath]) {
        const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        let renamed = false;
        try {
            writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
            // libuv uses replacement rename semantics on Windows and POSIX.
            renameSync(temporary, target);
            renamed = true;
        } finally {
            if (!renamed) rmSync(temporary, { force: true });
        }
    }
    return { timestampedPath, latestPath };
}

function resultValue(value: any) {
    return value?.result && typeof value.result === "object" ? value.result : value;
}

function contractValue(value: unknown) {
    if (value === undefined) return "missing";
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value.slice(0, 128));
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return typeof value;
}

export function assertHyperVLinuxCreateContract(device: any, expectedDeviceId: string) {
    const fields = device && typeof device === "object" && !Array.isArray(device)
        ? Object.keys(device)
            .sort()
            .slice(0, 64)
            .map((field) => field.slice(0, 64))
            .join(",")
            .slice(0, 1024)
        : "none";
    const requireField = (field: string, expected: unknown, valid: (value: unknown) => boolean) => {
        const actual = device?.[field];
        if (!valid(actual)) {
            throw new Error(
                `hyper-v-linux-create-response-invalid: ${field} expected ${contractValue(expected)}, received ${contractValue(actual)}; fields=${fields}`,
            );
        }
    };
    requireField("deviceId", expectedDeviceId, (value) => value === expectedDeviceId);
    requireField("guestProvisioned", true, (value) => value === true);
    requireField("guestTransport", "ssh", (value) => value === "ssh");
    requireField("switchName", "CCC Device Lab", (value) => value === "CCC Device Lab");
    requireField("networkAddress", "managed IPv4 address", (value) => (
        typeof value === "string"
        && /^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/.test(value)
    ));
}

export function hyperVLinuxBrokerArgs(tool: string, args: Record<string, unknown>) {
    return {
        ...args,
        viaBroker: true,
        ...(tool === "create_linux_vm" ? { provider: "hyper-v" } : {}),
    };
}

function commandAvailable(command: string, options: any = {}) {
    if (options[command]) return options[command];
    const result = (options.spawnSyncImpl || hiddenSpawnSync)("where.exe", [`${command}.exe`], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
    });
    return result.status === 0 ? String(result.stdout || "").split(/\r?\n/).find(Boolean) || `${command}.exe` : null;
}

export function hyperVLinuxVmE2ECapability(options: any = {}) {
    if ((options.platform || process.platform) !== "win32") return { available: false, reason: "not a Windows host" };
    const powershell = options.powershell || "powershell.exe";
    const command = hyperVReadinessCommand(powershell);
    const probe = (options.spawnSyncImpl || hiddenSpawnSync)(command.executable, command.args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
    const readiness = probe.status === 0 ? parseHyperVReadiness(probe.stdout || "") : null;
    if (!readiness?.available) return { available: false, reason: `Hyper-V unavailable${readiness?.missing?.length ? `: ${readiness.missing.join(", ")}` : ""}` };
    const ssh = commandAvailable("ssh", options);
    const scp = commandAvailable("scp", options);
    if (!ssh || !scp) return { available: false, reason: `missing ${[!ssh && "ssh", !scp && "scp"].filter(Boolean).join(", ")}` };
    const sourceImage = String(options.sourceImage || process.env.CCC_REAL_HYPER_V_LINUX_SOURCE_IMAGE || "").trim();
    // An imported source VHDX never runs qemu-img. Otherwise create reuses the cached ubuntu-lts image
    // or acquires it, so ask the readiness question the smoke and device_backends ask, against the
    // broker's private root and the owner the MCP session resolves.
    if (!sourceImage) {
        const cache = (options.inspectImageCache || inspectHyperVUbuntuImageCache)(
            options.privateRoot || join(homedir(), ".ccc", "device-broker-private"),
            String(options.ownerId || deviceLabOwnerId(process.env, repoRoot)),
        );
        const image = hyperVLinuxImageBlockers(readiness, cache);
        if (image.blockers.length > 0) return { available: false, reason: hyperVLinuxImageSkipReason(readiness, image) };
    }
    return { available: true, powershell, ssh, scp, sourceImage };
}

async function cleanupPrevious(callTool: (tool: string, args: any) => Promise<any>, ownedDeviceIds: Iterable<string>) {
    const inventory = resultValue(hyperVLinuxToolPayload(await callTool("devices", { view: "available", detail: true, backend: "linux-vm" })));
    assert.ok(Array.isArray(inventory?.devices), "cleanup inventory must contain devices");
    for (const deviceId of new Set(ownedDeviceIds)) {
        try {
            const stopped = await callTool("stop", { detail: true, deviceId, force: true });
            const missing = parseToolPayload({ ...stopped, isError: false });
            if (missing?.ok === false && missing.error === "device-not-found" && missing.deviceId === deviceId) markExpectedToolError(stopped);
        } catch { /* delete is still attempted */ }
        const deleted = await callTool("delete", { detail: true, deviceId, ...HYPER_V_LINUX_E2E_DELETE_OPTIONS });
        const observed = parseToolPayload({ ...deleted, isError: false });
        if (observed?.ok === false && observed.error === "device-not-found" && observed.deviceId === deviceId) {
            const fresh = resultValue(hyperVLinuxToolPayload(await callTool("devices", { view: "available", detail: true, backend: "linux-vm" })));
            assert.ok(Array.isArray(fresh?.devices) && fresh.devices.every(device => typeof device?.deviceId === "string" && device.deviceId), "cleanup inventory must identify every device");
            assert.ok(!fresh.devices.some(device => device.deviceId === deviceId), "deleted VM remains in inventory");
            markExpectedToolError(deleted);
        } else hyperVLinuxToolPayload(deleted);
    }
}

export async function runHyperVLinuxVmE2E(options: any = {}) {
    const capability = options.brokerOnly === true
        ? { available: true, sourceImage: String(options.sourceImage || process.env.CCC_REAL_HYPER_V_LINUX_SOURCE_IMAGE || "").trim() }
        : hyperVLinuxVmE2ECapability(options);
    if (!capability.available) return { status: "SKIP", reason: "reason" in capability ? capability.reason : "Hyper-V Linux VM unavailable", capability };

    let deviceId = "";
    const calledCapabilities = new Set<string>();
    const tempParent = join(repoRoot, "results");
    mkdirSync(tempParent, { recursive: true });
    const tempDir = mkdtempSync(join(tempParent, "ccc-hyper-v-linux-e2e-"));
    let created = false;
    let currentStep = "start MCP session";

    return withDeviceLabMcp(async ({ callTool: rawCallTool }) => {
        const callTool = async (tool: string, args: any) => {
            if (CAPABILITIES.includes(tool)) calledCapabilities.add(tool);
            return rawCallTool(tool, hyperVLinuxBrokerArgs(tool, args));
        };
        const direct: Record<string, unknown> = {};
        try {
            currentStep = "recover previous owner-scoped VM residue";
            await cleanupPrevious(callTool, readHyperVFixtureDeviceIds("linux-vm"));

            currentStep = "create VM and cloud-init seed";
            const createdDevice = lifecycleDevice(hyperVLinuxToolPayload(await callTool("create_linux_vm", { detail: true,

                name: "Real Hyper-V Ubuntu VM Test",
                profile: "ubuntu-lts",
                memoryMb: 2048,
                cpus: 2,
                ...(capability.sourceImage ? { sourceImage: capability.sourceImage } : {}),
            })), "create");
            deviceId = createdDevice.deviceId;
            direct.deviceId = deviceId;
            created = true;
            recordHyperVFixtureDeviceId("linux-vm", deviceId);
            assertHyperVLinuxCreateContract(createdDevice, deviceId);
            const networkAddress = String(createdDevice.networkAddress || "");

            currentStep = "inventory VM";
            const inventory = resultValue(hyperVLinuxToolPayload(await callTool("devices", { view: "available", detail: true, backend: "linux-vm" })));
            assert.ok(Array.isArray(inventory.devices) && inventory.devices.some((device: any) => device.deviceId === deviceId));

            currentStep = "start and wait for SSH";
            const started = lifecycleDevice(hyperVLinuxToolPayload(await callTool("start", { detail: true, ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);

            currentStep = "verify static guest address and NAT connectivity";
            const networkProbe = resultValue(hyperVLinuxToolPayload(await callTool("exec", { detail: true,
                ...direct,
                command: `ip -4 addr show | grep -F '${networkAddress}/' >/dev/null && getent hosts archive.ubuntu.com >/dev/null && timeout 15 bash -c '</dev/tcp/archive.ubuntu.com/80' && printf ccc-network-ok`,
            })));
            assert.strictEqual(networkProbe.provider, "hyper-v-ssh");
            assert.match(networkProbe.stdout || "", /ccc-network-ok/);

            currentStep = "read VM status";
            const status = lifecycleDevice(hyperVLinuxToolPayload(await callTool("status", { detail: true, ...direct })), "status");
            assert.strictEqual(status.deviceId, deviceId);
            assert.strictEqual(status.status, "running");

            currentStep = "execute guest command";
            const executed = resultValue(hyperVLinuxToolPayload(await callTool("exec", { detail: true,
                ...direct,
                command: HYPER_V_LINUX_PRE_REBOOT_COMMAND,
            })));
            assert.strictEqual(executed.provider, "hyper-v-ssh");
            assert.match(executed.stdout || "", /ccc-hyper-v-linux-e2e-ok/);

            currentStep = "reboot VM and wait for SSH";
            const rebooted = lifecycleDevice(hyperVLinuxToolPayload(await callTool("reboot", { detail: true, ...direct, force: true, waitForBoot: true, bootTimeoutMs: 1200000 })), "reboot");
            assert.strictEqual(rebooted.status, "running");
            assert.strictEqual(rebooted.bootReady, true);
            const afterReboot = resultValue(hyperVLinuxToolPayload(await callTool("exec", { detail: true, ...direct, command: "printf ccc-hyper-v-linux-reboot-ok" })));
            assert.match(afterReboot.stdout || "", /ccc-hyper-v-linux-reboot-ok/);

            currentStep = "prove Linux GUI screenshot and computer input";
            await runHyperVGuiE2E(callTool, direct, "linux");

            currentStep = "upload and download guest file";
            const uploadPath = join(tempDir, "upload.txt");
            const downloadPath = join(tempDir, "download.txt");
            const remotePath = "/tmp/ccc-hyper-v-linux-e2e.txt";
            writeFileSync(uploadPath, "ccc-hyper-v-linux-transfer-ok", "utf8");
            prepareHyperVLinuxDownloadDestination(downloadPath);
            resultValue(hyperVLinuxToolPayload(await callTool("upload", { detail: true, ...direct, localPath: uploadPath, remotePath })));
            const listing = hyperVLinuxToolPayload(await callTool("list_files", { detail: true, ...direct, path: "/tmp", limit: 500 }));
            assert.ok(listing.entries.some((entry: any) => entry.name === "ccc-hyper-v-linux-e2e.txt" && entry.type === "file"));
            resultValue(hyperVLinuxToolPayload(await callTool("download", { detail: true, ...direct, remotePath, localPath: downloadPath })));
            assert.strictEqual(readFileSync(downloadPath, "utf8"), "ccc-hyper-v-linux-transfer-ok");

            currentStep = "create production checkpoint";
            const snapshot = resultValue(hyperVLinuxToolPayload(await callTool("snapshot", { action: "create", detail: true, ...direct, snapshotName: "durability" })));
            const snapshotId = snapshot.snapshot?.id;
            assert.ok(snapshotId);

            currentStep = "list production checkpoints";
            const snapshotList = resultValue(hyperVLinuxToolPayload(await callTool("snapshot", { action: "list", detail: true, ...direct })));
            assert.ok(Array.isArray(snapshotList.snapshots));
            assert.ok(snapshotList.snapshots.some((candidate: any) => candidate?.id === snapshotId && candidate?.name === "durability"));

            currentStep = "restore production checkpoint";
            resultValue(hyperVLinuxToolPayload(await callTool("snapshot", { action: "restore", detail: true, ...direct, snapshotId, force: true, confirmDestructive: true })));

            currentStep = "verify SSH after checkpoint restore";
            const restored = resultValue(hyperVLinuxToolPayload(await callTool("exec", { detail: true, ...direct, command: "printf ccc-hyper-v-linux-restored" })));
            assert.match(restored.stdout || "", /ccc-hyper-v-linux-restored/);

            currentStep = "delete production checkpoint";
            resultValue(hyperVLinuxToolPayload(await callTool("snapshot", { action: "delete", detail: true, ...direct, snapshotId, confirmDestructive: true })));

            currentStep = "stop VM";
            lifecycleDevice(hyperVLinuxToolPayload(await callTool("stop", { detail: true, ...direct, force: true })), "stop");

            currentStep = "delete VM";
            hyperVLinuxToolPayload(await callTool("delete", { detail: true, ...direct, ...HYPER_V_LINUX_E2E_DELETE_OPTIONS }));
            created = false;

            currentStep = "verify advertised capability coverage";
            assert.deepStrictEqual(CAPABILITIES.filter((tool) => !calledCapabilities.has(tool)), []);
            return { status: "PASS", deviceId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error: any) {
            let guiConsole = "";
            if (currentStep === "prove Linux GUI screenshot and computer input" && created) {
                try {
                    const capture = await callTool("screenshot", { detail: true, ...direct, timeoutMs: 10000 });
                    const image = capture?.isError === true ? null : capture?.content?.find((item: any) => item?.type === "image" && item?.mimeType === "image/png");
                    const encoded = image?.data;
                    if (typeof encoded === "string" && encoded.length <= 4 * 1024 * 1024
                        && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
                        const png = Buffer.from(encoded, "base64");
                        if (png.length <= 2 * 1024 * 1024
                            && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
                            const outputRoot = join(repoRoot, "results", "device-lab-real");
                            mkdirSync(outputRoot, { recursive: true });
                            const target = join(outputRoot, "hyper-v-linux-gui-latest.png");
                            const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
                            try {
                                writeFileSync(temporary, png, { mode: 0o600, flag: "wx" });
                                renameSync(temporary, target);
                                guiConsole = "guestConsole=results/device-lab-real/hyper-v-linux-gui-latest.png; ";
                            } finally { rmSync(temporary, { force: true }); }
                        }
                    }
                } catch { /* the original GUI failure remains authoritative */ }
            }
            try {
                const diagnostic = writeHyperVLinuxFailureDiagnostic({ step: currentStep, created, error });
                return { status: "FAIL", reason: `${currentStep}: ${guiConsole}details=results/device-lab-real/hyper-v-linux-diagnostic-latest.json; ${terminalFailureSummary(error)}` };
            } catch (diagnosticError) {
                return { status: "FAIL", reason: `${currentStep}: ${guiConsole}diagnostic-write-failed=${boundedFailureMessage(diagnosticError)}; ${terminalFailureSummary(error)}` };
            }
        } finally {
            if (created) {
                try { await callTool("stop", { detail: true, ...direct, force: true }); } catch { /* best effort */ }
                try { await callTool("delete", { detail: true, ...direct, ...HYPER_V_LINUX_E2E_DELETE_OPTIONS }); } catch { /* evidence remains */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-linux-vm-e2e"));
}
