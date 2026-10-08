import { describe, expect, it, vi } from "vitest";
import { createDoctor } from "../../application/doctor.js";
import type { DoctorPorts } from "../../ports/doctor.js";

function fixture(overrides: Partial<DoctorPorts> = {}) {
    const output: string[] = [];
    const calls: string[] = [];
    const ports: DoctorPorts = {
        resolveProjectPath: path => { calls.push(`resolve:${path}`); return "/project"; },
        projectId: () => "project", containerName: () => "container",
        runtimeInfo: () => ({ runtime: "docker", version: "fallback", flavor: "native" }),
        daemonRunning: () => true, runtimeVersion: () => ({ status: 9, stdout: "27\n" }),
        imageExists: () => true, imageLabel: () => null, cliVersion: "1",
        containerRunning: () => true, containerExists: () => false,
        identityMiseVolumeName: () => "cache", inspectMiseVolume: () => ({ status: 0 }),
        observeActiveSessions: () => [],
        captureLocksDirectory: () => ({ exists: () => false, readNames: () => { throw new Error("unexpected read"); } }),
        runtimeCli: () => "docker", claudeLauncherReport: () => ({ status: 0, stdout: "Claude\n" }),
        capturePublication: () => { calls.push("capture"); return text => { output.push(text); return undefined; }; },
        sanitizeForTerminal: text => { calls.push(`sanitize:${text}`); return text; },
        ...overrides,
    };
    return { ports, output, calls, run: () => createDoctor(ports)("relative") };
}

describe("complete inward doctor", () => {
    it("returns a synchronous boolean and publishes ordered checks", () => {
        const f = fixture();
        expect(f.run()).toBe(true);
        expect(f.output).toEqual(["\n=== CCC Doctor ===\n", "  ✓ Runtime: Docker running (v27, native)",
            "  ✓ Image: Built locally (dev)", "  ✓ Container: Running (container)",
            "  ✓ Mise cache: Volume 'cache' exists", "  ✓ Sessions: No active sessions",
            "  ✓ Claude: Claude", "", "Summary: All checks passed", ""]);
        expect(f.calls.indexOf("capture")).toBeLessThan(f.calls.indexOf("sanitize:Docker running (v27, native)"));
    });
    it("denies every later observation after a missing daemon", () => {
        let denied = 0;
        const deny = (): never => { denied++; throw new Error("denied"); };
        const f = fixture({ daemonRunning: () => false, runtimeVersion: deny, imageExists: deny,
            containerRunning: deny, identityMiseVolumeName: deny, observeActiveSessions: deny });
        expect(f.run()).toBe(false);
        expect(denied).toBe(0);
        expect(f.output).toContain("Summary: 1 error(s), 0 warning(s)");
    });
    it("repeats running observations and only inspects existence on the first false result", () => {
        const events: string[] = [];
        let count = 0;
        const f = fixture({ containerRunning: () => { events.push("running"); return ++count === 2; },
            containerExists: () => { events.push("exists"); return true; },
            claudeLauncherReport: () => { events.push("launcher"); return { status: 2, stdout: "unmanaged" }; } });
        expect(f.run()).toBe(true);
        expect(events).toEqual(["running", "exists", "running", "launcher"]);
        expect(f.output).toContain("  ! Claude: unmanaged");
    });
    it.each([null, "1", "old", ""])("preserves image label decision for %s", label => {
        const f = fixture({ imageLabel: () => label, containerRunning: () => false });
        expect(f.run()).toBe(true);
        expect(f.output[2]).toBe(label === null ? "  ✓ Image: Built locally (dev)"
            : label === "1" ? "  ✓ Image: Registry (v1)"
                : `  ! Image: Registry (v${label} -- CLI expects v1, run 'ccc' to update)`);
    });
    it("retains missing-image build hint and continues after its error", () => {
        const f = fixture({ imageExists: () => false, runtimeCli: () => "podman" });
        expect(f.run()).toBe(false);
        expect(f.output).toContain("  ✗ Image: Not found -- run 'ccc' to auto-pull, or 'podman build -t ccc .' for local build");
        expect(f.output).toContain("  ✓ Claude: Claude");
    });
    it("counts old, new and profile locks without pruning sessions", () => {
        const f = fixture({ observeActiveSessions: () => ["active"],
            captureLocksDirectory: () => ({ exists: () => true, readNames: () => [
                "project-old.lock", "project--new.lock", "project--p--work--a.lock", "foreign--a.lock", "project.txt"] }) });
        expect(f.run()).toBe(true);
        expect(f.output).toContain("  ! Stale locks: 2 stale lock file(s) found");
    });
    it("does not read unconsumed native error fields", () => {
        const f = fixture({ runtimeVersion: () => ({ status: 7, stdout: "version", get error(): never { throw new Error("error read"); } }),
            inspectMiseVolume: () => ({ status: 0, get stdout(): never { throw new Error("stdout read"); } }) });
        expect(f.run()).toBe(true);
    });
    it("retains lazy fallback and launcher double trim/getter reads", () => {
        const events: string[] = [];
        const f = fixture({ runtimeInfo: () => ({ runtime: "podman", get version() { events.push("fallback"); return "fallback"; }, flavor: "native" }),
            runtimeVersion: () => ({ status: null, stdout: " " }),
            claudeLauncherReport: () => ({ get status() { events.push("status"); return 2; },
                get stdout() { events.push("stdout"); return "unmanaged\n"; } }) });
        expect(f.run()).toBe(true);
        expect(events).toEqual(["fallback", "status", "stdout", "stdout"]);
    });
    it("selects publication before sanitizer and propagates the same fault", () => {
        const error = new Error("row log getter");
        let captures = 0, sanitizes = 0;
        const f = fixture({ capturePublication: () => { if (++captures === 2) throw error; return () => undefined; },
            sanitizeForTerminal: text => { sanitizes++; return text; } });
        expect(() => f.run()).toThrow(error);
        expect(sanitizes).toBe(0);
    });
    it("selects sanitizer before evaluating a check message getter", () => {
        let sequence = "";
        const f = fixture();
        Object.defineProperty(f.ports, "sanitizeForTerminal", { get() {
            sequence += "select;";
            return (text: string) => text;
        } });
        const originalPush = Array.prototype.push;
        const push = vi.spyOn(Array.prototype, "push").mockImplementation(function (this: unknown[], ...values: unknown[]) {
            for (const value of values) {
                if (value && typeof value === "object" && "name" in value && value.name === "Runtime" && "message" in value) {
                    const message = value.message;
                    Object.defineProperty(value, "message", { get() { sequence += "message;"; return message; } });
                }
            }
            return originalPush.apply(this, values);
        });
        try { expect(f.run()).toBe(true); expect(sequence.startsWith("select;message;")).toBe(true); }
        finally { push.mockRestore(); }
    });
});
