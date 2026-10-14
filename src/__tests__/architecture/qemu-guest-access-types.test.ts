import { describe, expect, it } from "vitest";
import { createQemuGuestAccessApplication } from "../../../packages/device-lab/providers/application/qemu-guest-access.mjs";
import { sessionIdFor } from "../../../packages/device-lab/providers/domain/qemu-guest-access.mjs";
import type { QemuGuestAccessPorts } from "../../../packages/device-lab/providers/ports/qemu-guest-access.mjs";

export function requiredGuestAccessCapabilities(ports: QemuGuestAccessPorts): void {
    const application = createQemuGuestAccessApplication(ports);
    const execution = application.guestExec({ labId: "lab", command: "id", timeoutMs: 2500 });
    const { executeGuestCommand, ...missingSsh } = ports;
    // @ts-expect-error bounded SSH execution is required
    createQemuGuestAccessApplication(missingSsh);
    // @ts-expect-error synchronous readiness observations cannot return deferred results
    createQemuGuestAccessApplication({ ...ports, observeReadiness: async () => ({ ready: true }) });
    // @ts-expect-error guarded history publication must finish before returning
    createQemuGuestAccessApplication({ ...ports, writeLab: async () => undefined });
    // @ts-expect-error Guest commands require a settled synchronous SSH result.
    createQemuGuestAccessApplication({ ...ports, executeGuestCommand: async () => ({ result: { ok: true, status: 0 }, redactionPaths: [] }) });
    // @ts-expect-error Native execution inside the settled envelope must also be synchronous.
    createQemuGuestAccessApplication({ ...ports, executeGuestCommand: () => ({ result: Promise.resolve({ ok: true, status: 0 }), redactionPaths: [] }) });
    // @ts-expect-error Availability is a semantic fact rather than a native executable path.
    createQemuGuestAccessApplication({ ...ports, sshAvailable: () => "/usr/bin/ssh" });
    const { sshAvailable, ...missingAvailability } = ports;
    // @ts-expect-error Native SSH availability is a required bounded observation.
    createQemuGuestAccessApplication(missingAvailability);
    // @ts-expect-error Availability must settle before command admission and execution.
    createQemuGuestAccessApplication({ ...ports, sshAvailable: async () => true });
    void application; void executeGuestCommand; void execution; void sshAvailable;
}

describe("QEMU session ID admission", () => {
    it("rejects invalid explicit IDs instead of generating a replacement", () => {
        expect(sessionIdFor({ sessionId: "../escape" }, "2026-10-11T00:00:00.000Z")).toBeNull();
        expect(sessionIdFor({ sessionId: "session-one" }, "2026-10-11T00:00:00.000Z")).toBe("session-one");
    });
});
