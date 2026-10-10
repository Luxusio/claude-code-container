import { describe, expect, it } from "vitest";
import { createQemuGuestAccessApplication } from "../../../packages/device-lab/providers/application/qemu-guest-access.mjs";
import { sessionIdFor } from "../../../packages/device-lab/providers/domain/qemu-guest-access.mjs";
import type { QemuGuestAccessPorts } from "../../../packages/device-lab/providers/ports/qemu-guest-access.mjs";

export function requiredGuestAccessCapabilities(ports: QemuGuestAccessPorts): void {
    const application = createQemuGuestAccessApplication(ports);
    const { executeSsh, ...missingSsh } = ports;
    // @ts-expect-error bounded SSH execution is required
    createQemuGuestAccessApplication(missingSsh);
    // @ts-expect-error synchronous readiness observations cannot return deferred results
    createQemuGuestAccessApplication({ ...ports, observeReadiness: async () => ({ ready: true }) });
    // @ts-expect-error guarded history publication must finish before returning
    createQemuGuestAccessApplication({ ...ports, writeLab: async () => undefined });
    void application; void executeSsh;
}

describe("QEMU session ID admission", () => {
    it("rejects invalid explicit IDs instead of generating a replacement", () => {
        expect(sessionIdFor({ sessionId: "../escape" }, "2026-10-11T00:00:00.000Z")).toBeNull();
        expect(sessionIdFor({ sessionId: "session-one" }, "2026-10-11T00:00:00.000Z")).toBe("session-one");
    });
});
