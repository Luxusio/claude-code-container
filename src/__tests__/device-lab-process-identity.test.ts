import { spawn } from "node:child_process";
import * as nativeFs from "fs";
import { describe, expect, it, vi } from "vitest";
import {
    inspectProcessIdentity,
    processIdentityMatches,
    readProcessIdentity,
    refreshOwnedRuntimeProcessIdentity,
    signalOwnedRuntimeProcess,
    terminateOwnedRuntimeProcess,
    terminateOwnedRuntimeProcessTree,
    waitForProcessIdentity,
} from "@ccc/device-lab/providers/state/process-identity.mjs";

vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));

describe("device runtime process identity", () => {
    it("reads the current process with a stable start token and hashed command", () => {
        const first = readProcessIdentity(process.pid);
        const second = readProcessIdentity(process.pid);
        expect(first).toEqual(expect.objectContaining({ pid: process.pid }));
        expect(first?.startToken).toBeTruthy();
        expect(first?.commandHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first).not.toHaveProperty("commandLine");
        expect(processIdentityMatches(first, second)).toBe(true);
    });

    it.skipIf(process.platform !== "linux")("recognizes only the saved birth of an unreaped same-parent Linux child", async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve());child.once("error", reject); });
        let identity: ReturnType<typeof readProcessIdentity>;
        let joinTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            identity = await waitForProcessIdentity(child.pid, 2000);
            expect(identity).toBeTruthy();
            expect(signalOwnedRuntimeProcess({ runtimeId: "owned-test-child", pid: child.pid, processIdentity: identity }, "SIGKILL").signaled).toBe(true);
            const waiter = new Int32Array(new SharedArrayBuffer(4)), deadline = performance.now() + 2000;
            let dead = false;
            do {
                const stat = nativeFs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
                const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
                if (state === "Z" || state === "X") { dead = true;break; }
                Atomics.wait(waiter, 0, 0, 10);
            } while (performance.now() < deadline);
            expect(dead).toBe(true);
            expect(inspectProcessIdentity(identity, child.pid)).toEqual({ status: "exited", current: null, liveness: "exited" });
            expect(inspectProcessIdentity({ ...identity, startToken: "linux:0" }, child.pid).status).toBe("mismatch");
            expect(inspectProcessIdentity({ ...identity, pid: process.pid }, child.pid).status).toBe("unavailable");
            expect(inspectProcessIdentity(null, child.pid).status).toBe("unavailable");
            expect(inspectProcessIdentity({ ...identity, startToken: undefined }, child.pid).status).toBe("unavailable");
            expect(inspectProcessIdentity({ ...identity, commandHash: undefined }, child.pid).status).toBe("unavailable");
            expect(inspectProcessIdentity(identity, child.pid, { readIdentity: () => null, probeLiveness: () => "alive" }).status).toBe("unavailable");
            expect(inspectProcessIdentity(identity, child.pid, { readIdentity: () => null }).status).toBe("unavailable");
            expect(inspectProcessIdentity(identity, child.pid, { probeLiveness: () => "alive" }).status).toBe("unavailable");
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { joinTimer = setTimeout(() => reject(new Error("owned child join timed out")), 2000); })]); }
            finally { if (joinTimer) clearTimeout(joinTimer); }
        }
    });

    it.skipIf(process.platform !== "linux")("recognizes native dead-state X only with a complete matching Linux birth", () => {
        const identity = readProcessIdentity(process.pid)!;
        const path = `/proc/${process.pid}/stat`, originalRead = nativeFs.readFileSync;
        const stat = originalRead(path, "utf8"), close = stat.lastIndexOf(")"), fields = stat.slice(close + 1).trim().split(/\s+/);
        fields[0] = "X";
        const read = vi.spyOn(nativeFs, "readFileSync").mockImplementation(((file: Parameters<typeof originalRead>[0], options?: unknown) => {
            if (file === path) return stat.slice(0, close + 1) + " " + fields.join(" ");
            if (file === `/proc/${process.pid}/cmdline`) return Buffer.alloc(0);
            return originalRead(file, options as any);
        }) as typeof originalRead);
        try {
            expect(inspectProcessIdentity(identity, process.pid).status).toBe("exited");
            expect(inspectProcessIdentity({ ...identity, startToken: "linux:0" }, process.pid).status).toBe("mismatch");
            expect(inspectProcessIdentity({ ...identity, commandHash: undefined }, process.pid).status).toBe("unavailable");
        } finally { read.mockRestore(); }
    });

    it("does not signal a reused pid whose process identity changed", () => {
        const kill = vi.fn();
        const result = signalOwnedRuntimeProcess({
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "first", commandHash: "recorder" },
        }, "SIGINT", {
            readIdentity: () => ({ pid: 42, startToken: "successor", commandHash: "recorder" }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: false, signaled: false, reason: "runtime-process-identity-mismatch" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("signals only an exact generated runtime identity", () => {
        const identity = { pid: 42, startToken: "first", commandHash: "recorder" };
        const kill = vi.fn();
        const result = signalOwnedRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "SIGTERM", {
            readIdentity: () => ({ ...identity }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: true, signaled: true, pid: 42, signal: "SIGTERM" }));
        expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
    });

    it("distinguishes an unavailable identity lookup from process exit", () => {
        const identity = { pid: 42, startToken: "first", commandHash: "recorder" };
        expect(inspectProcessIdentity(identity, 42, {
            readIdentity: () => null,
            probeLiveness: () => "alive",
        })).toEqual({ status: "unavailable", current: null, liveness: "alive" });
        expect(inspectProcessIdentity(identity, 42, {
            readIdentity: () => null,
            probeLiveness: () => "exited",
        })).toEqual({ status: "exited", current: null, liveness: "exited" });

        const kill = vi.fn();
        const result = signalOwnedRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "SIGINT", {
            readIdentity: () => null,
            probeLiveness: () => "alive",
            kill,
        });
        expect(result).toEqual(expect.objectContaining({
            attempted: false,
            signaled: false,
            reason: "runtime-process-identity-unavailable",
        }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("treats an ESRCH signal race as an exited runtime", () => {
        const identity = { pid: 42, startToken: "first", commandHash: "recorder" };
        const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
        const result = signalOwnedRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "SIGINT", {
            readIdentity: () => ({ ...identity }),
            kill: () => { throw error; },
        });
        expect(result).toEqual(expect.objectContaining({
            attempted: true,
            signaled: false,
            exited: true,
            reason: "runtime-process-exited",
        }));
    });

    it("refuses to terminate a runtime whose initial process identity mismatches", async () => {
        const identity = { pid: 42, startToken: "first", commandHash: "appium" };
        const kill = vi.fn();
        const result = await terminateOwnedRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "Appium", {
            timeoutMs: 0,
            readIdentity: () => ({ ...identity, startToken: "successor" }),
            probeLiveness: () => "alive",
            kill,
        });

        expect(result).toEqual(expect.objectContaining({
            exited: false,
            signaled: false,
            reason: "runtime-process-identity-mismatch",
        }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("revalidates process identity before escalating a termination signal", async () => {
        const identity = { pid: 42, startToken: "first", commandHash: "appium" };
        const kill = vi.fn();
        let identityReads = 0;
        const result = await terminateOwnedRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "Appium", {
            timeoutMs: 0,
            readIdentity: () => (++identityReads === 1 ? { ...identity } : { ...identity, startToken: "successor" }),
            probeLiveness: () => "alive",
            sleep: async () => {},
            kill,
        });

        expect(result).toEqual(expect.objectContaining({
            exited: false,
            signaled: false,
            reason: "runtime-process-identity-mismatch",
        }));
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith(42, "SIGINT");
    });

    it("terminates a POSIX process group only after exact identity verification", async () => {
        const identity = { pid: 42, startToken: "first", commandHash: "emulator" };
        let alive = true;
        const killTree = vi.fn(() => { alive = false; });
        const result = await terminateOwnedRuntimeProcessTree({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "Emulator", {
            platform: "linux",
            timeoutMs: 0,
            readIdentity: () => ({ ...identity }),
            probeLiveness: () => alive ? "alive" : "exited",
            sleep: async () => {},
            killTree,
        });

        expect(result).toEqual(expect.objectContaining({ exited: true, signaled: true }));
        expect(killTree).toHaveBeenCalledWith(-42, "SIGINT");
    });

    it("uses Windows taskkill tree only after exact identity verification", async () => {
        const identity = { pid: 42, startToken: "first", commandHash: "wscript" };
        let alive = true;
        const taskkill = vi.fn(() => {
            alive = false;
            return { status: 0, stdout: "terminated", stderr: "" };
        });
        const result = await terminateOwnedRuntimeProcessTree({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "Emulator", {
            platform: "win32",
            timeoutMs: 0,
            readIdentity: () => ({ ...identity }),
            probeLiveness: () => alive ? "alive" : "exited",
            sleep: async () => {},
            taskkill,
        });

        expect(result).toEqual(expect.objectContaining({ exited: true, signaled: true, method: "taskkill-tree", status: 0 }));
        expect(taskkill).toHaveBeenCalledWith(42);

        const mismatchedTaskkill = vi.fn();
        const mismatch = await terminateOwnedRuntimeProcessTree({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "Emulator", {
            platform: "win32",
            readIdentity: () => ({ ...identity, startToken: "successor" }),
            probeLiveness: () => "alive",
            taskkill: mismatchedTaskkill,
        });
        expect(mismatch).toEqual(expect.objectContaining({ exited: false, reason: "runtime-process-identity-mismatch" }));
        expect(mismatchedTaskkill).not.toHaveBeenCalled();
    });

    it("waits for a newly spawned process identity to become observable", async () => {
        const identity = { pid: 42, startToken: "first", commandHash: "appium" };
        let reads = 0;
        const result = await waitForProcessIdentity(42, 1000, {
            readIdentity: () => (++reads < 3 ? null : identity),
            probeLiveness: () => "alive",
            sleep: async () => {},
        });

        expect(result).toEqual(identity);
        expect(reads).toBe(3);
    });

    it("refreshes an owned child command only within the same process epoch", () => {
        const runtime = {
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "epoch-1", commandHash: "shell" },
        };
        expect(refreshOwnedRuntimeProcessIdentity(runtime, {
            readIdentity: () => ({ pid: 42, startToken: "epoch-1", commandHash: "node" }),
        }).processIdentity.commandHash).toBe("node");
        expect(refreshOwnedRuntimeProcessIdentity(runtime, {
            readIdentity: () => ({ pid: 42, startToken: "epoch-2", commandHash: "unrelated" }),
        })).toBe(runtime);
    });
});
