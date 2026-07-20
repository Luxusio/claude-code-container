import assert from "assert";
import { existsSync } from "fs";
import { basename } from "path";
import { commandPath, findBaseImage, providerEnv, stateRelative, stateRoot } from "./helpers.ts";
import { lifecycleDevice, markExpectedToolError, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";

function capability() {
    if (process.platform !== "linux") return { available: false, reason: "not a Linux host" };
    if (providerEnv.CCC_LAB_RUNNER !== "1" || providerEnv.CCC_LAB_RUNNER_STATUS !== "ready") {
        return { available: false, reason: providerEnv.CCC_LAB_RUNNER_UNSUPPORTED_REASON || "Linux VM provider is not ready" };
    }
    if (!existsSync("/dev/kvm")) return { available: false, reason: "/dev/kvm is not available" };
    if (!commandPath("qemu-system-x86_64")) return { available: false, reason: "qemu-system-x86_64 is not available" };
    if (!commandPath("qemu-img")) return { available: false, reason: "qemu-img is not available" };
    const imagePath = findBaseImage();
    if (!imagePath) return { available: false, reason: `no base image found under ${stateRoot}/images or CCC_REAL_LINUX_VM_IMAGE` };
    const sourceImage = stateRelative(imagePath);
    if (!sourceImage) return { available: false, reason: `base image must be inside device-lab state root: ${stateRoot}`, imagePath };
    return { available: true, reason: "ready", imagePath, sourceImage };
}

const cap = capability();
export const name = "level 2 real Linux VM boot";

export async function run() {
    if (!cap.available) return { status: "SKIP", reason: cap.reason };
    const labId = `real-linux-vm-${Date.now()}`;
    let startedPid = null;
    await withDeviceLabMcp(async ({ callTool }) => {
        try {
            const created = parseToolPayload(await callTool("device_create", {
                backend: "linux-vm",
                name: `Real Linux VM Test ${basename(cap.imagePath)}`,
                deviceId: labId,
                sourceImage: cap.sourceImage,
                memoryMb: 512,
                cpus: 1,
            }));
            assert.strictEqual(created.ok, true, JSON.stringify(created));
            assert.strictEqual(lifecycleDevice(created, "device_create").id, labId);

            await callTool("device_image_list", { backend: "linux-vm" });
            markExpectedToolError(await callTool("device_image_import", {
                backend: "linux-vm",
                name: "Missing Linux VM smoke image",
                sourcePath: "images/__missing-linux-vm-smoke__.qcow2",
            }));
            markExpectedToolError(await callTool("device_disk_materialize", {
                backend: "linux-vm",
                deviceId: labId,
                dryRun: true,
            }));
            await callTool("device_target_list", { backend: "linux-vm", deviceId: labId });
            markExpectedToolError(await callTool("device_readiness_probe", { backend: "linux-vm", deviceId: labId }));
            await callTool("device_session_open", {
                backend: "linux-vm",
                deviceId: labId,
                sessionType: "metadata",
            });
            markExpectedToolError(await callTool("device_workspace_sync", {
                backend: "linux-vm",
                deviceId: labId,
                sourcePath: stateRoot,
            }));
            markExpectedToolError(await callTool("device_artifacts_export", { backend: "linux-vm", deviceId: labId }));
            markExpectedToolError(await callTool("device_guest_agent_status", { backend: "linux-vm", deviceId: labId }));
            markExpectedToolError(await callTool("device_guest_agent_provision", { backend: "linux-vm", deviceId: labId }));
            markExpectedToolError(await callTool("device_reboot", { backend: "linux-vm", deviceId: labId }));

            const started = parseToolPayload(await callTool("device_start", { backend: "linux-vm", deviceId: labId }));
            assert.strictEqual(started.ok, true, JSON.stringify(started));
            startedPid = Number(lifecycleDevice(started, "device_start").runtime?.pid || started.started?.pid || 0) || null;
            assert.ok(startedPid, "qemu pid should be recorded");
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
            assert.doesNotThrow(() => process.kill(startedPid, 0));
        } finally {
            if (startedPid) await callTool("device_stop", { backend: "linux-vm", deviceId: labId, force: true });
            await callTool("device_delete", { backend: "linux-vm", deviceId: labId, force: true, confirmDestructive: true });
        }
    }, { env: providerEnv });
    return { status: "PASS" };
}
