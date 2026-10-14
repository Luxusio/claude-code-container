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
    let deviceId = "";
    let startedPid = null;
    await withDeviceLabMcp(async ({ callTool }) => {
        try {
            const created = parseToolPayload(await callTool("create_linux_vm", { detail: true,

                name: `Real Linux VM Test ${basename(cap.imagePath)}`,
                sourceImage: cap.sourceImage,
                memoryMb: 1024,
                cpus: 1,
            }));
            assert.strictEqual(created.ok, true, JSON.stringify(created));
            deviceId = lifecycleDevice(created, "create").deviceId;
            assert.ok(typeof deviceId === "string" && deviceId, "create must return the generated VM ID");

            await callTool("list_images", { detail: true,});
            markExpectedToolError(await callTool("import_image", { detail: true,
                name: "Missing Linux VM smoke image",
                sourcePath: "images/__missing-linux-vm-smoke__.qcow2",
            }));
            const stopped = parseToolPayload(await callTool("status", { detail: true, deviceId }));
            assert.strictEqual(stopped.ok, true, JSON.stringify(stopped));
            assert.strictEqual(stopped.readiness?.state, "stopped");
            const started = parseToolPayload(await callTool("start", { detail: true, deviceId }));
            assert.strictEqual(started.ok, true, JSON.stringify(started));
            startedPid = Number(lifecycleDevice(started, "start").runtime?.pid || started.started?.pid || 0) || null;
            assert.ok(startedPid, "qemu pid should be recorded");
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
            assert.doesNotThrow(() => process.kill(startedPid, 0));
        } finally {
            if (deviceId) {
                try {
                    if (startedPid) await callTool("stop", { detail: true, deviceId, force: true });
                } finally {
                    await callTool("delete", { detail: true, deviceId, force: true, confirmDestructive: true });
                }
            }
        }
    }, { env: providerEnv });
    return { status: "PASS" };
}
