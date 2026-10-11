import { describe, expect, it, vi } from "vitest";
import { createQemuGuestAccessApplication } from "../../../packages/device-lab/providers/application/qemu-guest-access.mjs";
import type { QemuGuestAccessPorts } from "../../../packages/device-lab/providers/ports/qemu-guest-access.mjs";
import type { QemuAccessLab as QemuLab } from "../../../packages/device-lab/providers/domain/qemu-guest-access.mjs";

function accessPorts(): { ports: QemuGuestAccessPorts; lab: QemuLab } {
    const lab: QemuLab = { id: "lab", name: "Guest", ownerId: "owner", runtimeState: "running", runtime: { pid: 21 }, resources: { memoryMb: 1024, cpus: 1 }, image: { diskImage: "/lab/disk" }, paths: { labDir: "/lab", workspaceDir: "/lab/workspace", artifactsDir: "/lab/artifacts", snapshotsDir: "/lab/snapshots", exportsDir: "/lab/exports" } };
    const ports: QemuGuestAccessPorts = {
        ownerId: () => "owner", readLab: () => ({ ok: true, lab }), writeLab: () => undefined, clock: () => "2026-10-11T00:00:00.000Z",
        processExists: () => true, sshPath: () => null, executeSsh: () => { throw new Error("unexpected SSH execution"); },
        sshReadinessTimeoutMs: () => 1000, guestAgentReadinessTimeoutMs: () => 1000,
        hasReadinessObservation: () => false, observeReadiness: () => null,
    };
    return { ports, lab };
}

describe("QEMU guest access", () => {
    it("executes configured SSH with the default deadline without readiness probes or state publication", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" } };
        ports.sshPath = () => "/usr/bin/ssh";
        ports.observeReadiness = () => { throw new Error("guest exec must not probe readiness"); };
        ports.writeLab = () => { throw new Error("guest exec must not publish lab state"); };
        ports.executeSsh = (_command, args, _lab, timeoutMs) => {
            expect(args.at(-1)).toBe("id");
            expect(timeoutMs).toBe(30000);
            return { ok: true, status: 0, stdout: "guest\n", stderr: "" };
        };
        expect(createQemuGuestAccessApplication(ports).guestExec({ labId: "lab", command: "id" })).toMatchObject({
            ok: true, ownerId: "owner", labId: "lab", timeoutMs: 30000,
            result: { ok: true, status: 0, stdout: "guest\n", stderr: "" },
        });
    });

    it("checks guest-agent health without invoking its opted-in provision command", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" }, agent: { name: "agent", healthCommand: "health-only", provisionCommand: "install-agent", autoProvision: true } };
        ports.sshPath = () => "/usr/bin/ssh";
        ports.executeSsh = (_command, args) => {
            expect(args.at(-1)).toBe("health-only");
            return { ok: true, status: 0 };
        };
        expect(createQemuGuestAccessApplication(ports).guestAgentStatus({ labId: "lab" })).toMatchObject({ ok: true, status: { state: "ready", ready: true } });
    });
    it("reports configured SSH as available but unverified without executing it", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest", keyPath: "/secret/key" } };
        ports.sshPath = () => "/usr/bin/ssh";
        expect(createQemuGuestAccessApplication(ports).openSession({ labId: "lab", sessionType: "guest-ssh", sessionId: "session" })).toMatchObject({
            ok: true, session: { state: "open", attach: { available: true } },
        });
    });

    it("keeps the raw monitor unavailable even when the running target is ready", () => {
        const { ports } = accessPorts();
        expect(createQemuGuestAccessApplication(ports).openSession({ labId: "lab", sessionType: "monitor" })).toMatchObject({
            ok: true, session: { attach: { available: false, kind: "bounded-monitor-proxy-required", requestedTargetReady: true } },
        });
    });

    it("does not promote process-only readiness to verified guest readiness", () => {
        const { ports } = accessPorts();
        expect(createQemuGuestAccessApplication(ports).probeReadiness({ labId: "lab" })).toMatchObject({ ok: true, readiness: { state: "process-running" } });
    });

    it("records a failed process observation without probing the guest", () => {
        const { ports } = accessPorts(); ports.processExists = () => false;
        ports.observeReadiness = () => { throw new Error("unexpected guest observation"); };
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuGuestAccessApplication(ports).probeReadiness({ labId: "lab" })).toMatchObject({
            ok: false, readiness: { state: "failed", diagnostics: { kind: "runtime-process-not-found" } },
        });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ readiness: expect.objectContaining({ latest: expect.objectContaining({ state: "failed" }) }) }));
    });
});
