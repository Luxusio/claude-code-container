import assert from "assert";
import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hyperVReadinessCommand, parseHyperVReadiness } from "../../src/host-control/hyper-v/index.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { brokerToolFailureEvidence, formatBrokerToolFailure, lifecycleDevice, parseToolPayload, parseToolResult, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";

const DEVICE_PREFIX = "linux-hyper-v-real-e2e-";
const CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop", "device_reboot", "device_status",
    "device_exec", "device_upload", "device_download",
    "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];

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
    deviceId: string;
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
        deviceId: boundedDiagnosticIdentity(input.deviceId, "unknown-device"),
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
            rmSync(target, { force: true });
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
    requireField("id", expectedDeviceId, (value) => value === expectedDeviceId);
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
        ...(tool === "device_create" ? { provider: "hyper-v" } : {}),
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
    return { available: true, powershell, ssh, scp, sourceImage };
}

async function cleanupPrevious(callTool: (tool: string, args: any) => Promise<any>) {
    const inventory = resultValue(hyperVLinuxToolPayload(await callTool("device_inventory", { backend: "linux-vm" })));
    const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
    for (const device of devices.filter((candidate: any) => String(candidate?.id || "").startsWith(DEVICE_PREFIX))) {
        try { await callTool("device_stop", { backend: "linux-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true }); } catch { /* delete is still attempted */ }
        hyperVLinuxToolPayload(await callTool("device_delete", { backend: "linux-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true, confirmDestructive: true }));
    }
}

export async function runHyperVLinuxVmE2E(options: any = {}) {
    const capability = options.brokerOnly === true
        ? { available: true, sourceImage: String(options.sourceImage || process.env.CCC_REAL_HYPER_V_LINUX_SOURCE_IMAGE || "").trim() }
        : hyperVLinuxVmE2ECapability(options);
    if (!capability.available) return { status: "SKIP", reason: "reason" in capability ? capability.reason : "Hyper-V Linux VM unavailable", capability };

    const deviceId = `${DEVICE_PREFIX}${Date.now()}`;
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
        const direct: Record<string, unknown> = { backend: "linux-vm", deviceId };
        try {
            currentStep = "recover previous owner-scoped VM residue";
            await cleanupPrevious(callTool);

            currentStep = "create VM and cloud-init seed";
            const createdDevice = lifecycleDevice(hyperVLinuxToolPayload(await callTool("device_create", {
                ...direct,
                name: "Real Hyper-V Ubuntu VM Test",
                profile: "ubuntu-lts",
                memoryMb: 2048,
                cpus: 2,
                networking: true,
                ...(capability.sourceImage ? { sourceImage: capability.sourceImage } : {}),
            })), "device_create");
            direct.incarnationId = createdDevice.incarnationId;
            created = true;
            assertHyperVLinuxCreateContract(createdDevice, deviceId);
            const networkAddress = String(createdDevice.networkAddress || "");

            currentStep = "inventory VM";
            const inventory = resultValue(hyperVLinuxToolPayload(await callTool("device_inventory", { backend: "linux-vm" })));
            assert.ok(Array.isArray(inventory.devices) && inventory.devices.some((device: any) => device.id === deviceId));

            currentStep = "start and wait for SSH";
            const started = lifecycleDevice(hyperVLinuxToolPayload(await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "device_start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);

            currentStep = "verify static guest address and NAT connectivity";
            const networkProbe = resultValue(hyperVLinuxToolPayload(await callTool("device_exec", {
                ...direct,
                command: `ip -4 addr show | grep -F '${networkAddress}/' >/dev/null && getent hosts archive.ubuntu.com >/dev/null && timeout 15 bash -c '</dev/tcp/archive.ubuntu.com/80' && printf ccc-network-ok`,
            })));
            assert.strictEqual(networkProbe.provider, "hyper-v-ssh");
            assert.match(networkProbe.stdout || "", /ccc-network-ok/);

            currentStep = "read VM status";
            const status = lifecycleDevice(hyperVLinuxToolPayload(await callTool("device_status", direct)), "device_status");
            assert.strictEqual(status.id, deviceId);
            assert.strictEqual(status.status, "running");

            currentStep = "execute guest command";
            const executed = resultValue(hyperVLinuxToolPayload(await callTool("device_exec", { ...direct, command: "uname -sr && printf ccc-hyper-v-linux-e2e-ok" })));
            assert.strictEqual(executed.provider, "hyper-v-ssh");
            assert.match(executed.stdout || "", /ccc-hyper-v-linux-e2e-ok/);

            currentStep = "reboot VM and wait for SSH";
            const rebooted = lifecycleDevice(hyperVLinuxToolPayload(await callTool("device_reboot", { ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "device_reboot");
            assert.strictEqual(rebooted.status, "running");
            assert.strictEqual(rebooted.bootReady, true);
            const afterReboot = resultValue(hyperVLinuxToolPayload(await callTool("device_exec", { ...direct, command: "printf ccc-hyper-v-linux-reboot-ok" })));
            assert.match(afterReboot.stdout || "", /ccc-hyper-v-linux-reboot-ok/);

            currentStep = "upload and download guest file";
            const uploadPath = join(tempDir, "upload.txt");
            const downloadPath = join(tempDir, "download.txt");
            const remotePath = "/tmp/ccc-hyper-v-linux-e2e.txt";
            writeFileSync(uploadPath, "ccc-hyper-v-linux-transfer-ok", "utf8");
            resultValue(hyperVLinuxToolPayload(await callTool("device_upload", { ...direct, localPath: uploadPath, remotePath })));
            resultValue(hyperVLinuxToolPayload(await callTool("device_download", { ...direct, remotePath, localPath: downloadPath })));
            assert.strictEqual(readFileSync(downloadPath, "utf8"), "ccc-hyper-v-linux-transfer-ok");

            currentStep = "create production checkpoint";
            const snapshot = resultValue(hyperVLinuxToolPayload(await callTool("device_snapshot_create", { ...direct, snapshotName: "durability" })));
            const snapshotId = snapshot.snapshot?.id;
            assert.ok(snapshotId);

            currentStep = "list production checkpoints";
            const snapshotList = resultValue(hyperVLinuxToolPayload(await callTool("device_snapshot_list", direct)));
            assert.ok(Array.isArray(snapshotList.snapshots));
            assert.ok(snapshotList.snapshots.some((candidate: any) => candidate?.id === snapshotId && candidate?.name === "durability"));

            currentStep = "restore production checkpoint";
            resultValue(hyperVLinuxToolPayload(await callTool("device_snapshot_restore", { ...direct, snapshotId, force: true, confirmDestructive: true })));

            currentStep = "verify SSH after checkpoint restore";
            const restored = resultValue(hyperVLinuxToolPayload(await callTool("device_exec", { ...direct, command: "printf ccc-hyper-v-linux-restored" })));
            assert.match(restored.stdout || "", /ccc-hyper-v-linux-restored/);

            currentStep = "delete production checkpoint";
            resultValue(hyperVLinuxToolPayload(await callTool("device_snapshot_delete", { ...direct, snapshotId, confirmDestructive: true })));

            currentStep = "stop VM";
            lifecycleDevice(hyperVLinuxToolPayload(await callTool("device_stop", { ...direct, force: true })), "device_stop");

            currentStep = "delete VM";
            hyperVLinuxToolPayload(await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }));
            created = false;

            currentStep = "verify advertised capability coverage";
            assert.deepStrictEqual(CAPABILITIES.filter((tool) => !calledCapabilities.has(tool)), []);
            return { status: "PASS", deviceId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error: any) {
            try {
                const diagnostic = writeHyperVLinuxFailureDiagnostic({ step: currentStep, deviceId, created, error });
                return { status: "FAIL", reason: `${currentStep}: details=results/device-lab-real/hyper-v-linux-diagnostic-latest.json; ${terminalFailureSummary(error)}` };
            } catch (diagnosticError) {
                return { status: "FAIL", reason: `${currentStep}: diagnostic-write-failed=${boundedFailureMessage(diagnosticError)}; ${terminalFailureSummary(error)}` };
            }
        } finally {
            if (created) {
                try { await callTool("device_stop", { ...direct, force: true }); } catch { /* best effort */ }
                try { await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }); } catch { /* evidence remains */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-linux-vm-e2e"));
}
