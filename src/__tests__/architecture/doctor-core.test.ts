import { describe, expect, it } from "vitest";
import { createDoctor } from "../../application/doctor.js";
import type { DoctorPorts } from "../../ports/doctor.js";

const request = { projectId: "project", containerName: "container" };
const info = { runtime: "docker", version: "fallback", flavor: "native" };
function fixture(overrides: Partial<DoctorPorts> = {}) {
    const ports: DoctorPorts = {
        runtimeInfo: () => info, daemonRunning: () => true, runtimeVersion: () => "27",
        image: () => ({ kind: "local" }), cliVersion: "1",
        containerRunning: () => true, containerExists: () => false,
        miseCache: () => ({ volumeName: "cache", exists: true }),
        activeSessionCount: () => 0, lockNames: () => [],
        claudeLauncherReport: () => ({ kind: "ready", description: "Claude" }), ...overrides,
    };
    return () => createDoctor(ports)(request);
}

describe("semantic doctor diagnosis", () => {
    it("returns ordered finite checks", () => {
        expect(fixture()()).toEqual({ ok: true, checks: [
            { kind: "runtime", status: "ok", info, version: "27" },
            { kind: "image", status: "ok", image: { kind: "local" }, expectedVersion: "1" },
            { kind: "container", status: "ok", state: "running", name: "container" },
            { kind: "mise-cache", status: "ok", volumeName: "cache", exists: true },
            { kind: "sessions", status: "ok", count: 0 },
            { kind: "claude", status: "ok", launcher: { kind: "ready", description: "Claude" } },
        ] });
    });
    it("refuses all downstream observations after absent daemon", () => {
        const deny = (): never => { throw new Error("downstream observation"); };
        expect(fixture({ daemonRunning: () => false, runtimeVersion: deny, image: deny,
            containerRunning: deny, containerExists: deny, miseCache: deny,
            activeSessionCount: deny, lockNames: deny, claudeLauncherReport: deny })())
            .toEqual({ ok: false, checks: [{ kind: "runtime", status: "error", info, version: null }] });
    });
    it.each([
        { observed: "27", fallback: "fallback", version: "27" },
        { observed: null, fallback: "fallback", version: "fallback" },
        { observed: null, fallback: null, version: null },
        { observed: null, fallback: undefined, version: null },
    ])("uses observed version then info then null: $version", ({ observed, fallback, version }) => {
        const runtimeInfo = { ...info, version: fallback };
        expect(fixture({ runtimeInfo: () => runtimeInfo, runtimeVersion: () => observed })().checks[0])
            .toEqual({ kind: "runtime", status: "ok", info: runtimeInfo, version });
    });
    it.each([
        { image: { kind: "local" } as const, status: "ok", ok: true },
        { image: { kind: "registry", version: "1" } as const, status: "ok", ok: true },
        { image: { kind: "registry", version: "old" } as const, status: "warn", ok: true },
        { image: { kind: "registry", version: "" } as const, status: "warn", ok: true },
        { image: { kind: "missing" } as const, status: "error", ok: false },
    ])("diagnoses image $image.kind with $status", ({ image, status, ok }) => {
        const report = fixture({ image: () => image })();
        expect(report.ok).toBe(ok);
        expect(report.checks[1]).toEqual({ kind: "image", status, image, expectedVersion: "1" });
        expect(report.checks).toContainEqual({ kind: "claude", status: "ok", launcher: { kind: "ready", description: "Claude" } });
    });
    it.each([
        { running: true, exists: true, state: "running", status: "ok" },
        { running: false, exists: true, state: "stopped", status: "warn" },
        { running: false, exists: false, state: "missing", status: "warn" },
    ])("diagnoses $state container", ({ running, exists, state, status }) => {
        const report = fixture({ containerRunning: name => { expect(name).toBe("container"); return running; },
            containerExists: name => { expect(name).toBe("container"); return exists; } })();
        expect(report.ok).toBe(true);
        expect(report.checks[2]).toEqual({ kind: "container", status, state, name: "container" });
    });
    it.each([true, false])("diagnoses cache existence %s", exists => {
        const report = fixture({ miseCache: () => ({ volumeName: "project-cache", exists }) })();
        expect(report.ok).toBe(true);
        expect(report.checks[3]).toEqual({ kind: "mise-cache", status: exists ? "ok" : "warn", volumeName: "project-cache", exists });
    });
    it.each([0, 3])("reports %s active sessions", count => {
        expect(fixture({ activeSessionCount: project => { expect(project).toBe("project"); return count; } })().checks)
            .toContainEqual({ kind: "sessions", status: "ok", count });
    });
    it("counts old, new and profile current locks, excluding foreign and nonlocks", () => {
        const report = fixture({ activeSessionCount: () => 1, lockNames: () => [
            "project-old.lock", "project--new.lock", "project--p--work--a.lock",
            "foreign--a.lock", "foreign-old.lock", "project.txt", "project--a.guard",
        ] })();
        expect(report.ok).toBe(true);
        expect(report.checks).toContainEqual({ kind: "stale-locks", status: "warn", count: 2 });
    });
    it.each([0, 1, 3])("omits stale warning when active sessions cover current locks: %s", count => {
        const report = fixture({ activeSessionCount: () => count,
            lockNames: () => count === 0 ? [] : ["project--active.lock"] })();
        expect(report.checks.some(check => check.kind === "stale-locks")).toBe(false);
    });
    it.each([
        { launcher: { kind: "ready", description: "Claude" } as const, status: "ok" },
        { launcher: { kind: "update-unmanaged", description: "unmanaged" } as const, status: "warn" },
        { launcher: { kind: "missing" } as const, status: "warn" },
    ])("diagnoses launcher $launcher.kind", ({ launcher, status }) => {
        const report = fixture({ claudeLauncherReport: name => { expect(name).toBe("container"); return launcher; } })();
        expect(report.ok).toBe(true);
        expect(report.checks).toContainEqual({ kind: "claude", status, launcher });
    });
    it("skips launcher when a running container stops", () => {
        const observations = [true, false];
        const report = fixture({ containerRunning: () => observations.shift()!,
            claudeLauncherReport: () => { throw new Error("stopped container launcher"); } })();
        expect(report.checks[2]).toEqual({ kind: "container", status: "ok", state: "running", name: "container" });
        expect(report.checks.some(check => check.kind === "claude")).toBe(false);
    });
    it("observes launcher when a stopped container starts", () => {
        const observations = [false, true];
        const report = fixture({ containerRunning: () => observations.shift()!, containerExists: () => true })();
        expect(report.checks[2]).toEqual({ kind: "container", status: "warn", state: "stopped", name: "container" });
        expect(report.checks).toContainEqual({ kind: "claude", status: "ok", launcher: { kind: "ready", description: "Claude" } });
        expect(report.ok).toBe(true);
    });
    it.each(["runtimeVersion", "image", "miseCache", "lockNames", "claudeLauncherReport"] as const)
    ("propagates unexpected exceptions from %s", leaf => {
        const failure = new Error(`native ${leaf}`);
        expect(fixture({ [leaf]: () => { throw failure; } })).toThrow(failure);
    });
});
