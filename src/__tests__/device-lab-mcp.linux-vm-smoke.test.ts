import { EventEmitter } from "events";
import { existsSync, rmSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    formatLabMcpSmokeReport,
    runLabMcpSmoke,
} from "@ccc/device-lab/providers/backends/linux-vm-smoke.mjs";

describe("device-lab Linux VM provider smoke runner", () => {
    it("passes the fake-provider lifecycle without external VM prerequisites", async () => {
        const report = await runLabMcpSmoke();

        expect(report.ok, JSON.stringify(report)).toBe(true);
        expect(report.steps.map((step) => step.name)).toEqual([
            "provider-status",
            "image-import",
            "lab-create",
            "disk-materialize",
            "lab-start",
            "readiness-probe",
            "guest-push",
            "guest-pull",
            "guest-exec",
            "lab-stop",
            "snapshot-create",
            "lab-delete",
        ]);
        expect(report.steps.every((step) => step.status === "PASS")).toBe(true);
        const text = formatLabMcpSmokeReport(report);
        expect(text).toContain("mode: fake-provider");
        expect(text).toContain("result: PASS");
    });

    it("reports the failing step with structured diagnostics", async () => {
        const report = await runLabMcpSmoke({
            commandRunner: (command: string, args: string[]) => {
                if (args[0] === "create") return { ok: false, command, args, stderr: "qemu-img failed" };
                return { ok: true, command, args, pid: 1234 };
            },
        });

        expect(report.ok).toBe(false);
        // Disk materialization fails after the real reference import succeeded.
        expect(report.steps.slice(0, 3)).toEqual([
            { name: "provider-status", status: "PASS" },
            { name: "image-import", status: "PASS" },
            { name: "lab-create", status: "PASS" },
        ]);
        expect(report.steps.map((step) => step.name)).not.toContain("lab-start");
        expect(report.steps.map((step) => step.name)).not.toContain("lab-stop");
        expect(report.steps.map((step) => step.name)).not.toContain("lab-delete");
        expect(report.steps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: "disk-materialize",
                status: "FAIL",
                error: "disk-materialize failed",
                result: expect.objectContaining({
                    ok: false,
                    error: "qemu-img-create-failed",
                }),
            }),
        ]));
        expect(formatLabMcpSmokeReport(report)).toContain("result: FAIL");
    });
});

describe("fake-provider smoke child teardown", () => {
    const fixtures: Array<{ child: EventEmitter; roots: string[] }> = [];

    afterEach(() => {
        for (const fixture of fixtures.splice(0)) {
            fixture.child.emit("close", 0, null);
            for (const root of fixture.roots) rmSync(root, { recursive: true, force: true });
        }
        vi.useRealTimers();
        vi.doUnmock("child_process");
        vi.doUnmock("@ccc/device-lab/providers/state/process-identity.mjs");
        vi.doUnmock("@ccc/device-lab/providers/backends/linux-vm.mjs");
        vi.resetModules();
    });

    async function controlledSmoke(finalStep: "guest-exec" | "lab-stop" | "snapshot-create" | "lab-delete" = "lab-delete") {
        const child = Object.assign(new EventEmitter(), {
            pid: 54321,
            exitCode: null,
            signalCode: null,
            kill: vi.fn(() => true),
        });
        const identity = { pid: child.pid, startToken: "owned-smoke-birth", commandHash: "owned-smoke-command" };
        const roots: string[] = [];
        fixtures.push({ child, roots });
        let reachedFinalStep!: () => void;
        const ready = new Promise<void>((resolve) => { reachedFinalStep = resolve; });
        const observeStep = (name: string, operation: () => Record<string, unknown>) => () => {
            const result = operation();
            if (name === finalStep) reachedFinalStep();
            return result;
        };
        const guestExec = vi.fn<() => Record<string, unknown>>(() => ({ ok: true }));
        const stopLab = vi.fn<() => Record<string, unknown>>(() => ({ ok: true, stopped: true }));
        const snapshotLab = vi.fn<() => Record<string, unknown>>(() => ({ ok: true }));
        const terminate = vi.fn(async () => ({
            exited: false,
            signaled: false,
            reason: "runtime-process-identity-mismatch",
            error: "qualified termination refused",
        }));

        vi.resetModules();
        vi.doMock("child_process", () => ({ spawn: vi.fn(() => child) }));
        vi.doMock("@ccc/device-lab/providers/state/process-identity.mjs", () => ({
            waitForProcessIdentity: vi.fn(async () => identity),
            terminateOwnedRuntimeProcess: terminate,
        }));
        vi.doMock("@ccc/device-lab/providers/backends/linux-vm.mjs", () => ({
            ownerId: () => "smoke-owner",
            labProviderStatus: (options: { stateRoot: string; allowedWorkspaceRoots: string[] }) => {
                roots.push(options.stateRoot, ...options.allowedWorkspaceRoots);
                return { available: true };
            },
            importImage: () => ({ ok: true }),
            createLab: () => ({ ok: true, lab: { id: "smoke-lab" } }),
            materializeDisk: () => ({ ok: true }),
            startLab: () => ({ ok: true }),
            probeReadiness: () => ({ ok: true }),
            guestPush: () => ({ ok: true }),
            guestPull: () => ({ ok: true }),
            guestExec: observeStep("guest-exec", guestExec),
            stopLab: observeStep("lab-stop", stopLab),
            snapshotLab: observeStep("snapshot-create", snapshotLab),
            deleteLab: observeStep("lab-delete", () => ({ ok: true })),
        }));
        const { runLabMcpSmoke: run } = await import("@ccc/device-lab/providers/backends/linux-vm-smoke.mjs");
        return { run, child, identity, roots, ready, guestExec, stopLab, snapshotLab, terminate };
    }

    it("joins a positively stopped owned child before cleaning roots without repeating termination", async () => {
        const fixture = await controlledSmoke();
        const settled = vi.fn();
        const running = fixture.run().then((report) => { settled(); return report; });
        await fixture.ready;

        expect(fixture.stopLab).toHaveBeenCalledOnce();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.child.kill).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.roots).toHaveLength(2);
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);

        fixture.child.emit("close", 0, null);
        const report = await running;
        expect(report.ok, JSON.stringify(report)).toBe(true);
        expect(report.steps).toHaveLength(12);
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => !existsSync(root))).toBe(true);
    });

    it("preserves a later lifecycle error after positive stop while still joining the child", async () => {
        const fixture = await controlledSmoke("snapshot-create");
        fixture.snapshotLab.mockReturnValue({ ok: false, error: "snapshot rejected" });
        const settled = vi.fn();
        const running = fixture.run().then((report) => { settled(); return report; });
        await fixture.ready;

        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        fixture.child.emit("close", 0, null);

        expect(await running).toMatchObject({ ok: false, error: "snapshot-create failed" });
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => !existsSync(root))).toBe(true);
    });

    it.each([
        ["missing", { ok: true }, "snapshot-create", "snapshot-create failed"],
        ["failed", { ok: false, stopped: true, error: "stop rejected" }, "lab-stop", "lab-stop failed"],
    ] as const)("uses qualified termination with %s stop proof and preserves the primary lifecycle error", async (_name, stopResult, finalStep, primaryError) => {
        const fixture = await controlledSmoke(finalStep);
        fixture.stopLab.mockReturnValue(stopResult);
        fixture.snapshotLab.mockReturnValue({ ok: false, error: "snapshot rejected" });
        const settled = vi.fn();
        const running = fixture.run().then((report) => { settled(); return report; });
        await fixture.ready;

        expect(fixture.terminate).toHaveBeenCalledExactlyOnceWith({
            runtimeId: "owned-smoke-child",
            pid: fixture.identity.pid,
            processIdentity: fixture.identity,
        }, "Fake-provider smoke", { timeoutMs: 1000 });
        expect(fixture.child.kill).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        fixture.child.emit("close", 0, null);

        expect(await running).toMatchObject({ ok: false, error: primaryError });
        expect(fixture.roots.every((root) => !existsSync(root))).toBe(true);
    });

    it("retains qualified termination when an earlier lifecycle error prevents stop", async () => {
        const fixture = await controlledSmoke("guest-exec");
        fixture.guestExec.mockReturnValue({ ok: false, error: "guest command rejected" });
        const running = fixture.run();
        await fixture.ready;

        expect(fixture.stopLab).not.toHaveBeenCalled();
        expect(fixture.terminate).toHaveBeenCalledOnce();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        fixture.child.emit("close", 0, null);

        expect(await running).toMatchObject({ ok: false, error: "guest-exec failed" });
        expect(fixture.roots.every((root) => !existsSync(root))).toBe(true);
    });

    it.each(["missing stopped confirmation", "different captured runtime"])("reports termination refusal for %s after otherwise passing lifecycle steps", async (proof) => {
        const fixture = await controlledSmoke();
        fixture.stopLab.mockImplementation(() => {
            if (proof === "different captured runtime") fixture.child.pid += 1;
            return proof === "missing stopped confirmation" ? { ok: true } : { ok: true, stopped: true };
        });
        const settled = vi.fn();
        const running = fixture.run().then((report) => { settled(); return report; });
        await fixture.ready;

        expect(fixture.terminate).toHaveBeenCalledExactlyOnceWith({
            runtimeId: "owned-smoke-child",
            pid: fixture.identity.pid,
            processIdentity: fixture.identity,
        }, "Fake-provider smoke", { timeoutMs: 1000 });
        expect(fixture.child.kill).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        fixture.child.emit("close", 0, null);

        const report = await running;
        expect(report).toMatchObject({ ok: false, error: "qualified termination refused" });
        expect(report.steps).toHaveLength(12);
        expect(report.steps.every((step) => step.status === "PASS")).toBe(true);
        expect(fixture.roots.every((root) => !existsSync(root))).toBe(true);
    });

    it("fails after the unchanged two-second close allowance and retains private roots", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const fixture = await controlledSmoke();
        const settled = vi.fn();
        const running = fixture.run().then((report) => { settled(); return report; });
        await fixture.ready;

        await vi.advanceTimersByTimeAsync(1999);
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        await vi.advanceTimersByTimeAsync(1);

        expect(await running).toMatchObject({ ok: false, error: "fake-provider child join timed out" });
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
        fixture.child.emit("close", 0, null);
        expect(fixture.roots.every((root) => existsSync(root))).toBe(true);
    });
});
