import { spawn } from "node:child_process";
import * as nativeProcess from "child_process";
import * as nativeFs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    inspectProcessIdentity,
    processIdentityMatches,
    readProcessIdentity,
    readProcessIdentityAsync,
    refreshOwnedRuntimeProcessIdentity,
    signalOwnedRuntimeProcess,
    terminateOwnedRuntimeProcess,
    terminateOwnedRuntimeProcessTree,
    waitForProcessIdentity,
} from "@ccc/device-lab/providers/state/process-identity.mjs";

vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>() }));

afterEach(() => vi.restoreAllMocks());

const savedIdentity = { pid: 42, startToken: "epoch-1", commandHash: "appium" };
const savedRuntime = { runtimeId: "runtime-1", pid: 42, processIdentity: savedIdentity };
const unavailable = { status: "unavailable", current: null, liveness: "unknown" };

function localClock() {
    let elapsed = 0;
    const now = () => elapsed;
    vi.spyOn(Date, "now").mockImplementation(now);
    return { now, advance: (milliseconds: number) => { elapsed += milliseconds; } };
}

function nativeOutput(stdout: string, status = 0) {
    return { status, stdout, stderr: "", signal: null } as any;
}

function platform(value: NodeJS.Platform) {
    vi.spyOn(process, "platform", "get").mockReturnValue(value);
}

// Only the Windows executable lookup is simulated; native command arguments and
// timeouts still pass through the adapter's real dispatch boundary.
function windowsExecutableFixture() {
    vi.spyOn(nativeFs, "lstatSync").mockReturnValue({
        isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false,
    } as any);
    vi.spyOn(nativeFs.realpathSync, "native").mockReturnValue("C:\\Windows\\System32\\fixture.exe");
}

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

    describe("captured operation allowance", () => {
        it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY])("refuses an invalid or exhausted parent before observation: %s", async remaining => {
            const clock = localClock();
            const readIdentity = vi.fn(() => savedIdentity), probeLiveness = vi.fn(() => "exited" as const), kill = vi.fn();
            const options = { now: clock.now, remainingMs: () => remaining, readIdentity, probeLiveness, kill };
            expect(inspectProcessIdentity(savedIdentity, 42, options)).toEqual(unavailable);
            expect(refreshOwnedRuntimeProcessIdentity(savedRuntime, options)).toBe(savedRuntime);
            expect(signalOwnedRuntimeProcess(savedRuntime, "SIGINT", options)).toMatchObject({ attempted: false, signaled: false, reason: "runtime-process-identity-unavailable" });
            expect(await waitForProcessIdentity(42, 100, options)).toBeNull();
            expect(await terminateOwnedRuntimeProcess(savedRuntime, "Appium", options)).toMatchObject({ exited: false, signaled: false, reason: "runtime-process-identity-unavailable" });
            const taskkill = vi.fn();
            expect(await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", { ...options, platform: "win32", taskkill })).toMatchObject({ exited: false, signaled: false, reason: "runtime-process-identity-unavailable" });
            expect(readIdentity).not.toHaveBeenCalled();
            expect(probeLiveness).not.toHaveBeenCalled();
            expect(kill).not.toHaveBeenCalled();
            expect(taskkill).not.toHaveBeenCalled();
        });

        it("performs no identity or liveness read for a zero identity-wait duration", async () => {
            const readIdentity = vi.fn(() => savedIdentity), probeLiveness = vi.fn(() => "alive" as const);
            expect(await waitForProcessIdentity(42, 0, { readIdentity, probeLiveness })).toBeNull();
            expect(readIdentity).not.toHaveBeenCalled();
            expect(probeLiveness).not.toHaveBeenCalled();
        });

        it("never accepts an identity or same-birth refresh returned after expiry", async () => {
            const clock = localClock();
            const readIdentity = vi.fn(() => { clock.advance(10); return { ...savedIdentity, commandHash: "new-command" }; });
            expect(refreshOwnedRuntimeProcessIdentity(savedRuntime, { now: clock.now, remainingMs: () => 10, readIdentity })).toBe(savedRuntime);
            expect(await waitForProcessIdentity(42, 10, { now: clock.now, readIdentity })).toBeNull();
            const kill = vi.fn();
            expect(signalOwnedRuntimeProcess(savedRuntime, "SIGINT", {
                now: clock.now, remainingMs: () => 10, readIdentity: () => { clock.advance(10); return savedIdentity; }, kill,
            })).toMatchObject({ attempted: false, reason: "runtime-process-identity-unavailable", observation: unavailable });
            expect(kill).not.toHaveBeenCalled();
        });

        it("rejects a late exited liveness result and performs no subsequent probe", () => {
            const clock = localClock();
            const probeLiveness = vi.fn(() => { clock.advance(10); return "exited" as const; });
            expect(inspectProcessIdentity(savedIdentity, 42, {
                now: clock.now, remainingMs: () => 10, readIdentity: () => null, probeLiveness,
            })).toEqual(unavailable);
            expect(probeLiveness).toHaveBeenCalledExactlyOnceWith(42);
        });

        it("retains a real mismatch even when the mismatching read exhausts the allowance", () => {
            const clock = localClock(), current = { ...savedIdentity, startToken: "successor" }, kill = vi.fn();
            const result = signalOwnedRuntimeProcess(savedRuntime, "SIGINT", {
                now: clock.now, remainingMs: () => 10,
                readIdentity: () => { clock.advance(10); return current; }, kill,
            });
            expect(result).toMatchObject({ attempted: false, signaled: false, reason: "runtime-process-identity-mismatch", current,
                observation: { status: "mismatch", current, liveness: "alive" } });
            expect(kill).not.toHaveBeenCalled();
        });

        it.each(["ESRCH", "EPERM"])("retains an admitted signal's native %s diagnosis after expiry", code => {
            const clock = localClock();
            const result = signalOwnedRuntimeProcess(savedRuntime, "SIGTERM", {
                now: clock.now, remainingMs: () => 10, readIdentity: () => savedIdentity,
                kill: () => { clock.advance(10); throw Object.assign(new Error("native signal rejected"), { code }); },
            });
            expect(result).toMatchObject({ attempted: true, signaled: false, exited: code === "ESRCH",
                reason: code === "ESRCH" ? "runtime-process-exited" : "runtime-process-signal-failed", error: "native signal rejected" });
        });

        it.each(["signal", "taskkill"] as const)("checks the allowance after identity validation immediately before %s", async effect => {
            const clock = localClock(), kill = vi.fn(), taskkill = vi.fn(() => nativeOutput("terminated"));
            const current = { ...savedIdentity, get commandHash() { clock.advance(10); return savedIdentity.commandHash; } };
            const options = { now: clock.now, remainingMs: () => 10, readIdentity: () => current, kill, taskkill, platform: "win32" as const };
            const result = effect === "signal"
                ? signalOwnedRuntimeProcess(savedRuntime, "SIGINT", options)
                : await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", options);
            expect(result).toMatchObject({ signaled: false, reason: "runtime-process-identity-unavailable" });
            expect(kill).not.toHaveBeenCalled();
            expect(taskkill).not.toHaveBeenCalled();
        });

        it("retains every observed parent shrink even if the parent later grows", async () => {
            const clock = localClock(), sleeps: number[] = [];
            let queries = 0, reads = 0;
            const readIdentity = vi.fn(() => ++reads > 3 ? savedIdentity : null);
            const result = await waitForProcessIdentity(42, 100, {
                now: clock.now, remainingMs: () => ++queries === 1 ? 100 : queries === 2 ? 10 : 1000,
                readIdentity, probeLiveness: () => "alive",
                sleep: milliseconds => { sleeps.push(milliseconds); clock.advance(milliseconds); },
            });
            expect(result).toBeNull();
            expect(sleeps).toEqual([10]);
            expect(readIdentity).toHaveBeenCalledTimes(1);
            expect(queries).toBeGreaterThan(2);
        });

        it("retains a second observed parent shrink after polling has already consumed time", async () => {
            const clock = localClock(), sleeps: number[] = [];
            let parent = 200, reads = 0;
            const readIdentity = vi.fn(() => {
                parent = ++reads === 1 ? 80 : 5;
                return reads > 2 ? savedIdentity : null;
            });
            const result = await waitForProcessIdentity(42, 200, {
                now: clock.now, remainingMs: () => parent, readIdentity,
                probeLiveness: () => { parent = 200; return "alive"; },
                sleep: milliseconds => { sleeps.push(milliseconds); clock.advance(milliseconds); },
            });
            expect(result).toBeNull();
            expect(sleeps).toEqual([50, 5]);
            expect(readIdentity).toHaveBeenCalledTimes(2);
        });

        it.each([1, -1])("ignores a %s-direction wall-clock jump and never adds a final identity read", async direction => {
            const clock = localClock(), sleeps: number[] = [];
            let wall = 10_000, reads = 0;
            vi.spyOn(Date, "now").mockImplementation(() => wall);
            const readIdentity = vi.fn(() => ++reads >= 3 ? savedIdentity : null);
            const result = await waitForProcessIdentity(42, 60, {
                now: clock.now, readIdentity, probeLiveness: () => "alive",
                sleep: milliseconds => { sleeps.push(milliseconds); clock.advance(milliseconds); wall += direction * 1_000_000; },
            });
            expect(result).toBeNull();
            expect(sleeps).toEqual([50, 10]);
            expect(readIdentity).toHaveBeenCalledTimes(2);
        });

        it("does not accept a final identity after a sleep overruns the remaining allowance", async () => {
            let reads = 0;
            const clock = localClock(), readIdentity = vi.fn(() => ++reads > 1 ? savedIdentity : null);
            const sleep = vi.fn(() => { clock.advance(100); });
            expect(await waitForProcessIdentity(42, 20, { now: clock.now, readIdentity, probeLiveness: () => "alive", sleep })).toBeNull();
            expect(sleep).toHaveBeenCalledExactlyOnceWith(20);
            expect(readIdentity).toHaveBeenCalledTimes(1);
        });

        it("preserves exactly one argument for injected readers and forwards an unvalidated wait PID", async () => {
            const clock = localClock(), rawPid = { supplied: "raw-pid" }, readRaw = vi.fn(() => savedIdentity);
            expect(await waitForProcessIdentity(rawPid, 100, { now: clock.now, readIdentity: readRaw })).toBe(savedIdentity);
            expect(readRaw.mock.calls).toEqual([[rawPid]]);
            const readIdentity = vi.fn(() => savedIdentity);
            refreshOwnedRuntimeProcessIdentity(savedRuntime, { now: clock.now, readIdentity });
            inspectProcessIdentity(savedIdentity, 42, { now: clock.now, readIdentity });
            signalOwnedRuntimeProcess(savedRuntime, "SIGINT", { now: clock.now, readIdentity, kill: vi.fn() });
            const taskkill = vi.fn(() => nativeOutput("terminated"));
            await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "win32", timeoutMs: 0, now: clock.now, readIdentity, taskkill, probeLiveness: () => "exited",
            });
            expect(readIdentity.mock.calls).toEqual([[42], [42], [42], [42]]);
            expect(taskkill.mock.calls).toEqual([[42]]);
        });
    });

    describe("native command admission", () => {
        it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY])("never sends an invalid or sub-millisecond timeout to a native command: %s", async remaining => {
            platform("darwin");
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockReturnValue(nativeOutput("fixture"));
            const execFile = vi.spyOn(nativeProcess, "execFile").mockImplementation(((_executable: unknown, _args: unknown, _options: unknown, callback: any) => {
                callback(null, "fixture", "");
            }) as any);
            const options = { now: () => 0, remainingMs: () => remaining };
            expect(readProcessIdentity(42, options)).toBeNull();
            expect(await readProcessIdentityAsync(42, options)).toBeNull();
            expect(spawnSync).not.toHaveBeenCalled();
            expect(execFile).not.toHaveBeenCalled();
        });

        it("refuses a nonfinite local clock before native dispatch", async () => {
            platform("darwin");
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockReturnValue(nativeOutput("fixture"));
            const execFile = vi.spyOn(nativeProcess, "execFile").mockImplementation(((_executable: unknown, _args: unknown, _options: unknown, callback: any) => {
                callback(null, "fixture", "");
            }) as any);
            expect(readProcessIdentity(42, { now: () => Number.NaN })).toBeNull();
            expect(await readProcessIdentityAsync(42, { now: () => Number.POSITIVE_INFINITY })).toBeNull();
            expect(spawnSync).not.toHaveBeenCalled();
            expect(execFile).not.toHaveBeenCalled();
        });

        it("shares one remainder across sequential Darwin probes while preserving the 5000ms cap", () => {
            platform("darwin");
            const clock = localClock();
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockImplementation(((_executable: unknown, args: string[]) => {
                if (args.includes("lstart=")) { clock.advance(4500); return nativeOutput("started"); }
                clock.advance(1);
                return nativeOutput("node appium");
            }) as any);
            expect(readProcessIdentity(42, { now: clock.now, remainingMs: () => 6000 })).toMatchObject({ pid: 42, startToken: "ps:started" });
            expect(spawnSync.mock.calls).toEqual([
                ["/bin/ps", ["-p", "42", "-o", "lstart="], expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL" })],
                ["/bin/ps", ["-p", "42", "-o", "command="], expect.objectContaining({ timeout: 1500, killSignal: "SIGKILL" })],
            ]);
        });

        it("does not start a second sequential native probe after the first consumes the total", () => {
            platform("darwin");
            const clock = localClock();
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockImplementation((() => { clock.advance(6000); return nativeOutput("started"); }) as any);
            expect(readProcessIdentity(42, { now: clock.now, remainingMs: () => 6000 })).toBeNull();
            expect(spawnSync).toHaveBeenCalledTimes(1);
        });

        it.each([false, true])("dispatches independent async probes in parallel with retained caps and rejects late success: late=%s", async late => {
            platform("darwin");
            const clock = localClock(), pending: { args: string[]; callback: (error: Error | null, stdout: string) => void }[] = [];
            const execFile = vi.spyOn(nativeProcess, "execFile").mockImplementation(((_executable: unknown, args: string[], _options: unknown, callback: any) => {
                pending.push({ args, callback });
            }) as any);
            const promise = readProcessIdentityAsync(42, { now: clock.now, remainingMs: () => 6000 });
            expect(pending).toHaveLength(2);
            expect(execFile.mock.calls.map(call => (call[2] as { timeout?: number }).timeout)).toEqual([5000, 5000]);
            clock.advance(4500);
            pending.find(call => call.args.includes("lstart="))!.callback(null, "started");
            clock.advance(late ? 1500 : 1000);
            pending.find(call => call.args.includes("command="))!.callback(null, "node appium");
            const result = await promise;
            if (late) expect(result).toBeNull();
            else expect(result).toMatchObject({ pid: 42, startToken: "ps:started" });
        });

        it("checks admission independently before each async dispatch", async () => {
            platform("darwin");
            const clock = localClock();
            const execFile = vi.spyOn(nativeProcess, "execFile").mockImplementation(((_executable: unknown, _args: unknown, _options: unknown, callback: any) => {
                clock.advance(6000);
                callback(null, "started", "");
            }) as any);
            expect(await readProcessIdentityAsync(42, { now: clock.now, remainingMs: () => 6000 })).toBeNull();
            expect(execFile).toHaveBeenCalledTimes(1);
        });

        it.each([false, true])("floors Windows native identity allowance and rejects a late result: async=%s", async asynchronous => {
            platform("win32");
            windowsExecutableFixture();
            const clock = localClock(), output = JSON.stringify({ startToken: "birth", commandLine: "node appium" });
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockReturnValue(nativeOutput(output));
            const execFile = vi.spyOn(nativeProcess, "execFile").mockImplementation(((_executable: unknown, _args: unknown, _options: unknown, callback: any) => {
                callback(null, output, "");
            }) as any);
            const options = { now: clock.now, remainingMs: () => 37.9 };
            const first = asynchronous ? await readProcessIdentityAsync(42, options) : readProcessIdentity(42, options);
            expect(first).toMatchObject({ pid: 42, startToken: "windows:birth" });
            const native = asynchronous ? execFile : spawnSync;
            expect(native.mock.calls[0][2]).toMatchObject({ timeout: 37, windowsHide: true, killSignal: "SIGKILL" });
            if (asynchronous) execFile.mockImplementation(((_executable: unknown, _args: unknown, _options: unknown, callback: any) => {
                clock.advance(38); callback(null, output, "");
            }) as any);
            else spawnSync.mockImplementation((() => { clock.advance(38); return nativeOutput(output); }) as any);
            expect(asynchronous ? await readProcessIdentityAsync(42, options) : readProcessIdentity(42, options)).toBeNull();
        });

        it("retains 5000ms native read caps with safe envelope arithmetic and a large clock origin", () => {
            platform("darwin");
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockImplementation(((_executable: unknown, args: string[]) => nativeOutput(args.includes("lstart=") ? "started" : "node appium")) as any);
            expect(readProcessIdentity(42, { now: () => Number.MAX_SAFE_INTEGER, remainingMs: () => Number.MAX_SAFE_INTEGER })).toBeTruthy();
            expect(spawnSync.mock.calls.map(call => call[2]?.timeout)).toEqual([5000, 5000]);
        });

        it("retains the native 10000ms taskkill cap under the finite Windows tree envelope", async () => {
            windowsExecutableFixture();
            const clock = localClock(), spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockReturnValue(nativeOutput("terminated"));
            const result = await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "win32", timeoutMs: Number.MAX_SAFE_INTEGER, now: clock.now,
                readIdentity: () => savedIdentity, probeLiveness: () => "exited",
            });
            expect(spawnSync).toHaveBeenCalledWith(expect.any(String), ["/PID", "42", "/T", "/F"], expect.objectContaining({ timeout: 10_000, windowsHide: true }));
            expect(result).toMatchObject({ exited: true, signaled: true, method: "taskkill-tree", status: 0 });
        });

        it.each([0, 9])("charges native taskkill to remaining time and retains late status/output precedence: status=%s", async status => {
            windowsExecutableFixture();
            const clock = localClock(), probeLiveness = vi.fn(() => "exited" as const);
            const spawnSync = vi.spyOn(nativeProcess, "spawnSync").mockImplementation((() => {
                clock.advance(50);
                return { ...nativeOutput("partial native output", status), stderr: status === 0 ? "" : "native rejection" };
            }) as any);
            const result = await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "win32", timeoutMs: 100, now: clock.now, remainingMs: () => 80,
                readIdentity: () => { clock.advance(30); return savedIdentity; }, probeLiveness,
            });
            expect(spawnSync.mock.calls[0][2]).toMatchObject({ timeout: 50 });
            expect(result).toEqual({ exited: false, signaled: status === 0, method: "taskkill-tree", status,
                error: status === 0 ? "partial native output" : "native rejection\npartial native output" });
            expect(probeLiveness).not.toHaveBeenCalled();
        });
    });

    describe("shared termination allowance and legacy phase waits", () => {
        it("keeps timeoutMs as a separate observation cap after each admitted signal", async () => {
            const clock = localClock(), effects: [number, unknown][] = [], sleeps: number[] = [];
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 30, now: clock.now, readIdentity: () => savedIdentity,
                kill: (_pid, signal) => { effects.push([clock.now(), signal]); },
                probeLiveness: () => effects.length === 3 ? "exited" : "alive",
                sleep: milliseconds => { sleeps.push(milliseconds); clock.advance(milliseconds); },
            });
            expect(result).toMatchObject({ exited: true, signaled: true });
            expect(effects).toEqual([[0, "SIGINT"], [30, "SIGTERM"], [60, "SIGKILL"]]);
            expect(sleeps).toEqual([30, 30]);
        });

        it("uses one immediate liveness observation and no sleep in each zero-wait phase", async () => {
            const clock = localClock(), kill = vi.fn(), readIdentity = vi.fn(() => savedIdentity);
            const probeLiveness = vi.fn(() => "alive" as const), sleep = vi.fn(() => { clock.advance(50); });
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", { timeoutMs: 0, now: clock.now, readIdentity, kill, probeLiveness, sleep });
            expect(result).toMatchObject({ exited: false, signaled: true });
            expect(kill.mock.calls).toEqual([[42, "SIGINT"], [42, "SIGTERM"], [42, "SIGKILL"]]);
            expect(readIdentity).toHaveBeenCalledTimes(3);
            expect(probeLiveness).toHaveBeenCalledTimes(3);
            expect(sleep).not.toHaveBeenCalled();
        });

        it("does not begin liveness observation after a positive phase has already expired", async () => {
            let ticks = 0;
            const kill = vi.fn(), probeLiveness = vi.fn(() => "exited" as const), sleep = vi.fn();
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 0.9, now: () => ++ticks, readIdentity: () => savedIdentity, kill, probeLiveness, sleep,
            });
            expect(result).toMatchObject({ exited: false, signaled: true });
            expect(kill.mock.calls).toEqual([[42, "SIGINT"], [42, "SIGTERM"], [42, "SIGKILL"]]);
            expect(probeLiveness).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it("charges identity reads and phase sleeps to the same parent allowance", async () => {
            const clock = localClock(), effects: [number, unknown][] = [], sleeps: number[] = [];
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 30, now: clock.now, remainingMs: () => 85,
                readIdentity: () => { clock.advance(10); return savedIdentity; },
                kill: (_pid, signal) => { effects.push([clock.now(), signal]); }, probeLiveness: () => "alive",
                sleep: milliseconds => { sleeps.push(milliseconds); clock.advance(milliseconds); },
            });
            expect(result).toMatchObject({ exited: false, signaled: false, reason: "runtime-process-identity-unavailable" });
            expect(effects).toEqual([[10, "SIGINT"], [50, "SIGTERM"]]);
            expect(sleeps).toEqual([30, 30]);
        });

        it("bounds a phase sleep by operation remainder and refuses observations after an overlong sleep", async () => {
            const clock = localClock(), readIdentity = vi.fn(() => savedIdentity), kill = vi.fn(), probeLiveness = vi.fn(() => "alive" as const);
            const sleep = vi.fn(() => { clock.advance(100); });
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 30, now: clock.now, remainingMs: () => 25, readIdentity, kill, probeLiveness, sleep,
            });
            expect(result).toMatchObject({ exited: false, reason: "runtime-process-identity-unavailable" });
            expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
            expect(kill).toHaveBeenCalledTimes(1);
            expect(readIdentity).toHaveBeenCalledTimes(1);
            expect(probeLiveness).toHaveBeenCalledTimes(1);
        });

        it("refuses a late exited confirmation after an admitted signal", async () => {
            const clock = localClock(), kill = vi.fn(), probeLiveness = vi.fn(() => { clock.advance(10); return "exited" as const; });
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 5, now: clock.now, remainingMs: () => 10, readIdentity: () => savedIdentity, kill, probeLiveness,
            });
            expect(result).toMatchObject({ exited: false, reason: "runtime-process-identity-unavailable" });
            expect(kill).toHaveBeenCalledTimes(1);
            expect(probeLiveness).toHaveBeenCalledTimes(1);
        });

        it("does not accept exited liveness returned after a positive phase cap while total time remains", async () => {
            const clock = localClock(), kill = vi.fn();
            let probes = 0;
            const probeLiveness = vi.fn(() => {
                if (++probes === 1) { clock.advance(6); return "exited" as const; }
                return "alive" as const;
            });
            const result = await terminateOwnedRuntimeProcess(savedRuntime, "Appium", {
                timeoutMs: 5, now: clock.now, remainingMs: () => 100, readIdentity: () => savedIdentity, kill, probeLiveness,
                sleep: milliseconds => { clock.advance(milliseconds); },
            });
            expect(result).toMatchObject({ exited: false, signaled: true });
            expect(kill.mock.calls).toEqual([[42, "SIGINT"], [42, "SIGTERM"], [42, "SIGKILL"]]);
        });

        it.each([false, true])("captures the ordinary envelope and charges the POSIX tree's initial observation: tree=%s", async tree => {
            const clock = localClock(), effects: [number, unknown][] = [];
            const options = {
                timeoutMs: 0, now: clock.now, platform: "linux" as const,
                readIdentity: () => { clock.advance(9500); return savedIdentity; },
                kill: (_pid: number, signal: string | number) => { effects.push([clock.now(), signal]); clock.advance(1000); },
                killTree: (_pid: number, signal: string | number) => { effects.push([clock.now(), signal]); clock.advance(1000); },
                probeLiveness: () => "alive" as const, sleep: () => { clock.advance(50); },
            };
            const result = tree
                ? await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", options)
                : await terminateOwnedRuntimeProcess(savedRuntime, "Appium", options);
            expect(result).toMatchObject({ exited: false, reason: "runtime-process-identity-unavailable" });
            expect(effects).toEqual(tree ? [[19_000, "SIGINT"], [29_500, "SIGTERM"]] : [[9500, "SIGINT"], [20_000, "SIGTERM"]]);
        });

        it("hands the remaining parent allowance through the POSIX tree delegation", async () => {
            const clock = localClock(), effects: [number, unknown][] = [];
            const result = await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "linux", timeoutMs: 0, now: clock.now, remainingMs: () => 25_000,
                readIdentity: () => { clock.advance(5000); return savedIdentity; },
                killTree: (_pid, signal) => { effects.push([clock.now(), signal]); clock.advance(3000); },
                probeLiveness: () => "alive", sleep: () => { clock.advance(50); },
            });
            expect(result).toMatchObject({ exited: false, reason: "runtime-process-identity-unavailable" });
            expect(effects).toEqual([[10_000, "SIGINT"], [18_000, "SIGTERM"]]);
        });

        it("does not treat successful taskkill status as proof of exit", async () => {
            const clock = localClock(), probeLiveness = vi.fn(() => "alive" as const), sleep = vi.fn(() => { clock.advance(50); });
            const result = await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "win32", timeoutMs: 0, now: clock.now, readIdentity: () => savedIdentity,
                taskkill: () => nativeOutput("taskkill reported success"), probeLiveness, sleep,
            });
            expect(result).toEqual({ exited: false, signaled: true, method: "taskkill-tree", status: 0, error: "taskkill reported success" });
            expect(probeLiveness).toHaveBeenCalledExactlyOnceWith(42);
            expect(sleep).not.toHaveBeenCalled();
        });

        it("charges the initial identity and injected taskkill to the captured Windows default total", async () => {
            const clock = localClock(), probeLiveness = vi.fn(() => "exited" as const);
            const result = await terminateOwnedRuntimeProcessTree(savedRuntime, "Appium", {
                platform: "win32", timeoutMs: 0, now: clock.now,
                readIdentity: () => { clock.advance(9500); return savedIdentity; },
                taskkill: () => { clock.advance(11_000); return nativeOutput("taskkill completed late"); }, probeLiveness,
            });
            expect(result).toEqual({ exited: false, signaled: true, method: "taskkill-tree", status: 0, error: "taskkill completed late" });
            expect(probeLiveness).not.toHaveBeenCalled();
        });
    });
});
