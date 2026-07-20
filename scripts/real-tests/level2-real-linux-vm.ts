import assert from "assert";
import { basename } from "path";
import {
    createLab,
    deleteLab,
    labProviderStatus,
    startLab,
    stopLab,
} from "../../lab-mcp/src/provider.mjs";
import { commandPath, findBaseImage, providerEnv, stateRelative, stateRoot } from "./helpers.ts";

function capability() {
    if (process.platform !== "linux") return { available: false, reason: "not a Linux host" };
    const status = labProviderStatus({ env: providerEnv, stateRoot });
    if (!status.available) return { available: false, reason: status.unsupportedReason || "lab provider unavailable", status };
    if (!status.qemuImg && !commandPath("qemu-img")) return { available: false, reason: "qemu-img is not available", status };
    const imagePath = findBaseImage();
    if (!imagePath) return { available: false, reason: `no base image found under ${stateRoot}/images or CCC_REAL_LINUX_VM_IMAGE`, status };
    const sourceImage = stateRelative(imagePath);
    if (!sourceImage) return { available: false, reason: `base image must be inside lab state root: ${stateRoot}`, status, imagePath };
    return { available: true, reason: "ready", imagePath, sourceImage };
}

const cap = capability();
const providerOwnerId = "real-linux-vm-test";

export const name = "level 2 real Linux VM boot";

export async function run() {
    if (!cap.available) return { status: "SKIP", reason: cap.reason };
    const labId = `real-linux-vm-${Date.now()}`;
    const options = { env: providerEnv, stateRoot, ownerId: providerOwnerId };
    let startedPid = null;

    try {
        const created = createLab({
            name: `Real Linux VM Test ${basename(cap.imagePath)}`,
            labId,
            sourceImage: cap.sourceImage,
            memoryMb: 512,
            cpus: 1,
        }, options);
        assert.strictEqual(created.ok, true, JSON.stringify(created));

        const started = startLab({ labId }, options);
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        startedPid = Number(started.lab?.runtime?.pid || started.started?.pid || 0) || null;
        assert.ok(startedPid, "qemu pid should be recorded");

        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
        assert.doesNotThrow(() => process.kill(startedPid, 0));
    } finally {
        if (startedPid) stopLab({ labId, force: true }, options);
        deleteLab({ labId, force: true }, options);
    }
    return { status: "PASS" };
}
