import { describe, expect, it } from "vitest";
import { createQemuOwnedDataApplication } from "../../../packages/device-lab/providers/application/qemu-owned-data.mjs";
import { ownedDataPath } from "../../../packages/device-lab/providers/domain/qemu-owned-data.mjs";
import type { QemuOwnedDataPorts } from "../../../packages/device-lab/providers/ports/qemu-owned-data.mjs";

export function requiredOwnedDataCapabilities(ports: QemuOwnedDataPorts): void {
    const application = createQemuOwnedDataApplication(ports);
    const { copyFiles, ...missingCopy } = ports;
    // @ts-expect-error bounded native copy is required
    createQemuOwnedDataApplication(missingCopy);
    // @ts-expect-error synchronous publication cannot defer completion
    createQemuOwnedDataApplication({ ...ports, writeLab: async () => undefined });
    // @ts-expect-error snapshot commands must settle before snapshot metadata is published
    createQemuOwnedDataApplication({ ...ports, executeSnapshot: async () => ({ ok: true, status: 0 }) });
    const { executeSnapshot, ...missingSnapshot } = ports;
    // @ts-expect-error semantic native snapshot execution is required
    createQemuOwnedDataApplication(missingSnapshot);
    const { qemuImgAvailable, ...missingAvailability } = ports;
    // @ts-expect-error native snapshot availability is required
    createQemuOwnedDataApplication(missingAvailability);
    // @ts-expect-error availability must be a fact rather than an executable path
    createQemuOwnedDataApplication({ ...ports, qemuImgAvailable: () => "/usr/bin/qemu-img" });
    // @ts-expect-error availability must settle synchronously before snapshot execution
    createQemuOwnedDataApplication({ ...ports, qemuImgAvailable: async () => true });
    void application; void copyFiles; void executeSnapshot; void qemuImgAvailable;
}

describe("QEMU owned data path admission", () => {
    it("refuses traversal and retains an ordinary relative artifact path", () => {
        expect(ownedDataPath("../outside", "artifact-source")).toEqual({ ok: false, error: "invalid-artifact-source" });
        expect(ownedDataPath("screens/file.txt", "artifact-source")).toEqual({ ok: true, path: "screens/file.txt" });
    });
});
