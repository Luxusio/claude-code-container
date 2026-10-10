import { describe, expect, it } from "vitest";
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

    it("preserves native nullable runtime version fallback", () => {
        const f = fixture({ runtimeInfo: () => ({ runtime: "docker", version: null, flavor: "native" }),
            runtimeVersion: () => ({ status: 0, stdout: " " }) });
        expect(f.run()).toBe(true);
        expect(f.output).toContain("  ✓ Runtime: Docker running (vunknown, native)");
    });

});
