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
    createQemuOwnedDataApplication({ ...ports, executeQemuImg: async () => ({ ok: true, status: 0 }) });
    void application; void copyFiles;
}

describe("QEMU owned data path admission", () => {
    it("refuses traversal and retains an ordinary relative artifact path", () => {
        expect(ownedDataPath("../outside", "artifact-source")).toEqual({ ok: false, error: "invalid-artifact-source" });
        expect(ownedDataPath("screens/file.txt", "artifact-source")).toEqual({ ok: true, path: "screens/file.txt" });
    });
});
