import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { basename, join, relative, resolve, sep } from "path";
import { describe, expect, it } from "vitest";
import {
    createLab,
    deleteLab,
    labProviderStatus,
    startLab,
    stopLab,
} from "../../lab-mcp/src/provider.mjs";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const stateRoot = resolve(process.env.CCC_LAB_STATE_DIR || "/home/ccc/.ccc/labs");
const providerEnv = {
    ...process.env,
    CCC_LAB_RUNNER: "1",
    CCC_LAB_RUNNER_STATUS: "ready",
    CCC_LAB_STATE_DIR: stateRoot,
};
const providerOwnerId = "real-linux-vm-test";

function commandPath(command: string): string | null {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf-8",
        env: process.env,
    });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

function stateRelative(path: string): string | null {
    const resolved = resolve(path);
    const rel = relative(stateRoot, resolved);
    if (rel === "" || rel.startsWith("..") || resolve(rel) === rel) return null;
    return rel.split(sep).join("/");
}

function imageCandidates(): string[] {
    return [
        process.env.CCC_REAL_LINUX_VM_IMAGE,
        join(stateRoot, "images", "base.qcow2"),
        join(stateRoot, "images", "linux.qcow2"),
        join(stateRoot, "images", "base.raw"),
        join(stateRoot, "images", "linux.raw"),
    ].filter((candidate): candidate is string => Boolean(candidate));
}

function capability() {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    if (process.platform !== "linux") return { available: false, reason: "not a Linux host" };
    const status = labProviderStatus({ env: providerEnv, stateRoot });
    if (!status.available) return { available: false, reason: status.unsupportedReason || "lab provider unavailable", status };
    if (!status.qemuImg && !commandPath("qemu-img")) return { available: false, reason: "qemu-img is not available", status };
    const imagePath = imageCandidates().find((candidate) => existsSync(candidate));
    if (!imagePath) return { available: false, reason: `no base image found under ${join(stateRoot, "images")} or CCC_REAL_LINUX_VM_IMAGE`, status };
    const sourceImage = stateRelative(imagePath);
    if (!sourceImage) return { available: false, reason: `base image must be inside lab state root: ${stateRoot}`, status, imagePath };
    return { available: true, reason: "ready", status, imagePath, sourceImage };
}

const cap = capability();
const title = cap.available
    ? `boots and tears down a disposable Linux VM from ${basename(cap.imagePath!)}`
    : `skips Linux VM boot (${cap.reason})`;

describe.runIf(level >= 2)("level 2 real Linux VM integration", () => {
    it.skipIf(!cap.available)(title, async () => {
        const labId = `real-linux-vm-${Date.now()}`;
        const options = { env: providerEnv, stateRoot, ownerId: providerOwnerId };
        let startedPid: number | null = null;

        try {
            const created = createLab({
                name: "Real Linux VM Test",
                labId,
                sourceImage: cap.sourceImage,
                memoryMb: 512,
                cpus: 1,
            }, options);
            expect(created).toEqual(expect.objectContaining({ ok: true }));

            const started = startLab({ labId }, options);
            expect(started).toEqual(expect.objectContaining({ ok: true }));
            startedPid = Number(started.lab?.runtime?.pid || started.started?.pid || 0) || null;
            expect(startedPid).toBeTruthy();

            await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
            expect(() => process.kill(startedPid!, 0)).not.toThrow();
        } finally {
            if (startedPid) stopLab({ labId, force: true }, options);
            deleteLab({ labId, force: true }, options);
        }
    });
});
