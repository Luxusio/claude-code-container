import { describe, expect, it } from "vitest";
import { createQemuGuestTransferApplication } from "../../../packages/device-lab/providers/application/qemu-guest-transfer.mjs";
import { validateGuestTransferPath } from "../../../packages/device-lab/providers/domain/qemu-guest-transfer.mjs";
import type { QemuGuestTransferPorts } from "../../../packages/device-lab/providers/ports/qemu-guest-transfer.mjs";

// Compile-only actual consumed factory contract; no native capability is invoked here.
export function requiredGuestTransferCapabilities(ports: QemuGuestTransferPorts) {
    const app = createQemuGuestTransferApplication(ports);
    const { transportRunner, ...missingTransport } = ports;
    // @ts-expect-error bounded transport selection is required
    createQemuGuestTransferApplication(missingTransport);
    const { writeLab, ...missingPublication } = ports;
    // @ts-expect-error operation history publication is required
    createQemuGuestTransferApplication(missingPublication);
    // @ts-expect-error cleanup must settle synchronously before a result is returned
    createQemuGuestTransferApplication({ ...ports, removeDirectory: async () => undefined });
    return { app, transportRunner, writeLab };
}

describe("guest transfer path admission", () => {
    it("rejects traversal while normalizing ordinary absolute guest paths", () => {
        expect(validateGuestTransferPath("/workspace/../escape", "guest-path", ["/workspace"])).toEqual({
            ok: false, error: "guest-path-path-traversal-rejected",
        });
        expect(validateGuestTransferPath("/workspace//app/", "guest-path", ["/workspace"])).toEqual({
            ok: true, guestPath: "/workspace/app", allowedGuestRoots: ["/workspace"],
        });
    });
});
