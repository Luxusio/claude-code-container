import { describe, expect, it, vi } from "vitest";
import { createQemuGuestAccessApplication } from "../../../packages/device-lab/providers/application/qemu-guest-access.mjs";
import type { QemuGuestAccessPorts } from "../../../packages/device-lab/providers/ports/qemu-guest-access.mjs";
import type { QemuAccessLab as QemuLab } from "../../../packages/device-lab/providers/domain/qemu-guest-access.mjs";

function accessPorts(): { ports: QemuGuestAccessPorts; lab: QemuLab } {
    const lab: QemuLab = { id: "lab", name: "Guest", ownerId: "owner", runtimeState: "running", runtime: { pid: 21 }, resources: { memoryMb: 1024, cpus: 1 }, image: { diskImage: "/lab/disk" }, paths: { labDir: "/lab", workspaceDir: "/lab/workspace", artifactsDir: "/lab/artifacts", snapshotsDir: "/lab/snapshots", exportsDir: "/lab/exports" } };
    const ports: QemuGuestAccessPorts = {
        ownerId: () => "owner", readLab: () => ({ ok: true, lab }), writeLab: () => undefined, clock: () => "2026-10-11T00:00:00.000Z",
        processExists: () => true, sshAvailable: () => false, executeGuestCommand: () => { throw new Error("unexpected SSH execution"); },
        sshReadinessTimeoutMs: () => 1000, guestAgentReadinessTimeoutMs: () => 1000,
        hasReadinessObservation: () => false, observeReadiness: () => null,
    };
    return { ports, lab };
}

describe("QEMU guest access", () => {
    it("executes configured SSH with the default deadline without readiness probes or state publication", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" } };
        ports.sshAvailable = () => true;
        ports.observeReadiness = () => { throw new Error("guest exec must not probe readiness"); };
        ports.writeLab = () => { throw new Error("guest exec must not publish lab state"); };
        ports.executeGuestCommand = (requestedLab, commandText, timeoutMs) => {
            expect(requestedLab).toBe(lab);
            expect(commandText).toBe("id");
            expect(timeoutMs).toBe(30000);
            return { result: { ok: true, status: 0, stdout: "guest\n", stderr: "" }, redactionPaths: ["/usr/bin/ssh"] };
        };
        expect(createQemuGuestAccessApplication(ports).guestExec({ labId: "lab", command: "id" })).toMatchObject({
            ok: true, ownerId: "owner", labId: "lab", timeoutMs: 30000,
            result: { ok: true, status: 0, stdout: "guest\n", stderr: "" },
        });
    });

    it("checks guest-agent health without invoking its opted-in provision command", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" }, agent: { name: "agent", healthCommand: "health-only", provisionCommand: "install-agent", autoProvision: true } };
        ports.sshAvailable = () => true;
        ports.executeGuestCommand = (requestedLab, commandText, timeoutMs) => {
            expect(requestedLab).toBe(lab);
            expect(commandText).toBe("health-only");
            expect(timeoutMs).toBe(10000);
            return { result: { ok: true, status: 0 }, redactionPaths: ["/usr/bin/ssh"] };
        };
        expect(createQemuGuestAccessApplication(ports).guestAgentStatus({ labId: "lab" })).toMatchObject({ ok: true, status: { state: "ready", ready: true } });
    });
    it("reports configured SSH as available but unverified without executing it", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest", keyPath: "/secret/key" } };
        ports.sshAvailable = () => true;
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

    it.each([
        { name: "successful", ok: true, status: 0, state: "ready", check: "pass" },
        { name: "failed", ok: false, status: 7, state: "failed", check: "fail" },
    ])("redacts Windows native paths from $name default SSH readiness and published history", ({ ok, status, state, check }) => {
        const { ports, lab } = accessPorts();
        const executable = "C:\\native\\OpenSSH\\ssh.exe", keyPath = "C:\\private\\keys\\id_ed25519";
        lab.paths = { labDir: "C:\\private\\labs\\lab", workspaceDir: "C:\\private\\labs\\lab\\workspace", artifactsDir: "C:\\private\\labs\\lab\\artifacts", snapshotsDir: "C:\\private\\labs\\lab\\snapshots", exportsDir: "C:\\private\\labs\\lab\\exports" };
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest", keyPath, readinessCommand: "ready-only" } };
        ports.sshAvailable = () => true;
        const execute = vi.fn(() => ({ result: { ok, status, command: executable, args: ["-i", keyPath, "ready-only"],
            stdout: `native ${executable}; key ${keyPath}; lab ${lab.paths.labDir}; artifacts ${lab.paths.artifactsDir}`,
            stderr: `trace ${executable}; key ${keyPath}` }, redactionPaths: [executable] }));
        const publish = vi.fn(ports.writeLab);
        ports.executeGuestCommand = execute;
        ports.writeLab = publish;
        const response = createQemuGuestAccessApplication(ports).probeReadiness({ labId: "lab" });
        expect(response).toMatchObject({ ok, readiness: { state, checks: expect.arrayContaining([
            expect.objectContaining({ name: "runtime-process", status: "pass" }),
            expect.objectContaining({ name: "guest-ssh-readiness", status: check, exitStatus: status }),
        ]) } });
        expect(execute).toHaveBeenCalledExactlyOnceWith(lab, "ready-only", 1000);
        expect(publish).toHaveBeenCalledTimes(1);
        const returned = JSON.parse(JSON.stringify(response));
        const written = JSON.parse(JSON.stringify(publish.mock.calls[0][0].readiness));
        expect(written.latest).toEqual(returned.readiness);
        expect(written.history).toEqual([returned.readiness]);
        for (const readiness of [returned.readiness, written.latest, written.history[0]]) {
            const result = readiness.diagnostics.probes[0].result;
            expect(result).toEqual({ ok, status,
                stdout: "native <provider-internal>; key <provider-internal>; lab <provider-internal>; artifacts <provider-internal>",
                stderr: "trace <provider-internal>; key <provider-internal>" });
            for (const privatePath of [executable, keyPath, lab.paths.labDir, lab.paths.artifactsDir]) {
                expect(result.stdout).not.toContain(privatePath);
                expect(result.stderr).not.toContain(privatePath);
            }
        }
    });

    it("records a failed process observation without probing the guest", () => {
        const { ports, lab } = accessPorts(); ports.processExists = () => false;
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" } };
        ports.sshAvailable = () => true;
        ports.observeReadiness = () => { throw new Error("unexpected guest observation"); };
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuGuestAccessApplication(ports).probeReadiness({ labId: "lab" })).toMatchObject({
            ok: false, readiness: { state: "failed", diagnostics: { kind: "runtime-process-not-found" } },
        });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ readiness: expect.objectContaining({ latest: expect.objectContaining({ state: "failed" }) }) }));
    });

    it("refuses unavailable SSH without invoking an otherwise successful command", () => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" } };
        const execute = vi.fn(() => ({ result: { ok: true, status: 0 }, redactionPaths: [] }));
        const publish = vi.fn(ports.writeLab);
        ports.executeGuestCommand = execute;
        ports.writeLab = publish;
        expect(createQemuGuestAccessApplication(ports).guestExec({ labId: "lab", command: "id" })).toEqual({
            ok: false, error: "guest-ssh-command-unavailable", missing: ["ssh"], ownerId: "owner", labId: "lab",
        });
        expect(execute).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it.each([
        { name: "semantic refusal with exit zero", result: { ok: false, status: 0 } },
        { name: "null result", result: null },
        { name: "undefined result", result: undefined },
    ])("does not publish guest-exec success for $name", ({ result }) => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" } };
        ports.sshAvailable = () => true;
        const execute = vi.fn(() => ({ result, redactionPaths: [] }));
        const publish = vi.fn(ports.writeLab);
        ports.executeGuestCommand = execute;
        ports.writeLab = publish;
        expect(createQemuGuestAccessApplication(ports).guestExec({ labId: "lab", command: "id", timeoutMs: 2500 })).toMatchObject({
            ok: false, ownerId: "owner", labId: "lab", timeoutMs: 2500,
        });
        expect(execute).toHaveBeenCalledExactlyOnceWith(lab, "id", 2500);
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(["readiness", "agent"] as const)("records failed %s history after a semantic refusal with exit zero", (kind) => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest", readinessCommand: "ready-only" }, agent: { name: "agent", healthCommand: "health-only" } };
        ports.sshAvailable = () => true;
        ports.executeGuestCommand = () => ({ result: { ok: false, status: 0 }, redactionPaths: [] });
        const publish = vi.fn(ports.writeLab);
        ports.writeLab = publish;
        const application = createQemuGuestAccessApplication(ports);
        const response = kind === "readiness" ? application.probeReadiness({ labId: "lab" }) : application.guestAgentStatus({ labId: "lab" });
        expect(response).toMatchObject({ ok: false, [kind === "readiness" ? "readiness" : "status"]: { state: "failed" } });
        expect(publish).toHaveBeenCalledTimes(1);
        const written = publish.mock.calls[0][0];
        const history = kind === "readiness" ? written.readiness?.history : written.guest?.agent?.statusHistory;
        expect(history).toHaveLength(1);
        expect(history?.[0]).toMatchObject({ state: "failed", checkedAt: "2026-10-11T00:00:00.000Z" });
    });

    it.each(["exec", "readiness", "agent"] as const)("propagates the identical native exception from %s without publishing", (kind) => {
        const { ports, lab } = accessPorts();
        lab.guest = { ssh: { host: "127.0.0.1", port: 2222, user: "guest" }, agent: { name: "agent", healthCommand: "health-only" } };
        ports.sshAvailable = () => true;
        const failure = new Error("native SSH failed");
        ports.executeGuestCommand = () => { throw failure; };
        const publish = vi.fn(ports.writeLab);
        ports.writeLab = publish;
        const application = createQemuGuestAccessApplication(ports);
        let caught: unknown;
        try {
            if (kind === "exec") application.guestExec({ labId: "lab", command: "id" });
            else if (kind === "readiness") application.probeReadiness({ labId: "lab" });
            else application.guestAgentStatus({ labId: "lab" });
        } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(publish).not.toHaveBeenCalled();
    });
});
