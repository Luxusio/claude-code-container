import assert from "assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hyperVReadinessCommand, parseHyperVReadiness } from "../../src/device-lab/providers/hyper-v.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { lifecycleDevice, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";

const DEVICE_PREFIX = "linux-hyper-v-real-e2e-";
const CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop", "device_reboot", "device_status",
    "device_exec", "device_upload", "device_download",
    "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];

function payload(result: any) {
    const value = parseToolPayload(result);
    if (value?.ok === false) {
        const execution = value.provisioning && typeof value.provisioning === "object" ? value.provisioning : null;
        const diagnostic = execution
            ? JSON.stringify({
                status: execution.status,
                signal: execution.signal,
                error: execution.error,
                stdout: String(execution.stdout || "").slice(-1024),
                stderr: String(execution.stderr || "").slice(-2048),
            })
            : "";
        throw new Error([value.error, value.detail, diagnostic].filter(Boolean).join(": ") || "Hyper-V Linux broker operation failed");
    }
    return value;
}

function resultValue(value: any) {
    return value?.result && typeof value.result === "object" ? value.result : value;
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
    const inventory = resultValue(payload(await callTool("device_inventory", { backend: "linux-vm" })));
    const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
    for (const device of devices.filter((candidate: any) => String(candidate?.id || "").startsWith(DEVICE_PREFIX))) {
        try { await callTool("device_stop", { backend: "linux-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true }); } catch { /* delete is still attempted */ }
        payload(await callTool("device_delete", { backend: "linux-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true, confirmDestructive: true }));
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
            return rawCallTool(tool, args);
        };
        const direct: Record<string, unknown> = { backend: "linux-vm", deviceId };
        try {
            currentStep = "recover previous owner-scoped VM residue";
            await cleanupPrevious(callTool);

            currentStep = "create VM and cloud-init seed";
            const createdDevice = lifecycleDevice(payload(await callTool("device_create", {
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
            assert.strictEqual(createdDevice.id, deviceId);
            assert.strictEqual(createdDevice.guestProvisioned, true);
            assert.strictEqual(createdDevice.guestTransport, "ssh");
            assert.strictEqual(createdDevice.switchName, "CCC Device Lab");
            const networkAddress = String(createdDevice.networkAddress || "");
            assert.match(networkAddress, /^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/);

            currentStep = "inventory VM";
            const inventory = resultValue(payload(await callTool("device_inventory", { backend: "linux-vm" })));
            assert.ok(Array.isArray(inventory.devices) && inventory.devices.some((device: any) => device.id === deviceId));

            currentStep = "start and wait for SSH";
            const started = lifecycleDevice(payload(await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 600000 })), "device_start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);

            currentStep = "verify static guest address and NAT connectivity";
            const networkProbe = resultValue(payload(await callTool("device_exec", {
                ...direct,
                command: `ip -4 addr show | grep -F '${networkAddress}/' >/dev/null && getent hosts archive.ubuntu.com >/dev/null && timeout 15 bash -c '</dev/tcp/archive.ubuntu.com/80' && printf ccc-network-ok`,
            })));
            assert.strictEqual(networkProbe.provider, "hyper-v-ssh");
            assert.match(networkProbe.stdout || "", /ccc-network-ok/);

            currentStep = "read VM status";
            const status = lifecycleDevice(payload(await callTool("device_status", direct)), "device_status");
            assert.strictEqual(status.id, deviceId);
            assert.strictEqual(status.status, "running");

            currentStep = "execute guest command";
            const executed = resultValue(payload(await callTool("device_exec", { ...direct, command: "uname -sr && printf ccc-hyper-v-linux-e2e-ok" })));
            assert.strictEqual(executed.provider, "hyper-v-ssh");
            assert.match(executed.stdout || "", /ccc-hyper-v-linux-e2e-ok/);

            currentStep = "reboot VM and wait for SSH";
            const rebooted = lifecycleDevice(payload(await callTool("device_reboot", { ...direct, waitForBoot: true, bootTimeoutMs: 600000 })), "device_reboot");
            assert.strictEqual(rebooted.status, "running");
            assert.strictEqual(rebooted.bootReady, true);
            const afterReboot = resultValue(payload(await callTool("device_exec", { ...direct, command: "printf ccc-hyper-v-linux-reboot-ok" })));
            assert.match(afterReboot.stdout || "", /ccc-hyper-v-linux-reboot-ok/);

            currentStep = "upload and download guest file";
            const uploadPath = join(tempDir, "upload.txt");
            const downloadPath = join(tempDir, "download.txt");
            const remotePath = "/tmp/ccc-hyper-v-linux-e2e.txt";
            writeFileSync(uploadPath, "ccc-hyper-v-linux-transfer-ok", "utf8");
            resultValue(payload(await callTool("device_upload", { ...direct, localPath: uploadPath, remotePath })));
            resultValue(payload(await callTool("device_download", { ...direct, remotePath, localPath: downloadPath })));
            assert.strictEqual(readFileSync(downloadPath, "utf8"), "ccc-hyper-v-linux-transfer-ok");

            currentStep = "create production checkpoint";
            const snapshot = resultValue(payload(await callTool("device_snapshot_create", { ...direct, snapshotName: "durability" })));
            const snapshotId = snapshot.snapshot?.id;
            assert.ok(snapshotId);

            currentStep = "list production checkpoints";
            const snapshotList = resultValue(payload(await callTool("device_snapshot_list", direct)));
            assert.ok(Array.isArray(snapshotList.snapshots));
            assert.ok(snapshotList.snapshots.some((candidate: any) => candidate?.id === snapshotId && candidate?.name === "durability"));

            currentStep = "restore production checkpoint";
            resultValue(payload(await callTool("device_snapshot_restore", { ...direct, snapshotId, force: true, confirmDestructive: true })));

            currentStep = "verify SSH after checkpoint restore";
            const restored = resultValue(payload(await callTool("device_exec", { ...direct, command: "printf ccc-hyper-v-linux-restored" })));
            assert.match(restored.stdout || "", /ccc-hyper-v-linux-restored/);

            currentStep = "delete production checkpoint";
            resultValue(payload(await callTool("device_snapshot_delete", { ...direct, snapshotId, confirmDestructive: true })));

            currentStep = "stop VM";
            lifecycleDevice(payload(await callTool("device_stop", { ...direct, force: true })), "device_stop");

            currentStep = "delete VM";
            payload(await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }));
            created = false;

            currentStep = "verify advertised capability coverage";
            assert.deepStrictEqual(CAPABILITIES.filter((tool) => !calledCapabilities.has(tool)), []);
            return { status: "PASS", deviceId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error: any) {
            return { status: "FAIL", reason: `${currentStep}: ${error?.message || String(error)}` };
        } finally {
            if (created) {
                try { await callTool("device_stop", { ...direct, force: true }); } catch { /* best effort */ }
                try { await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }); } catch { /* evidence remains */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-linux-vm-e2e"));
}
