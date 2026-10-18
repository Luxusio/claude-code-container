import * as childProcess from "child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readDeviceRuntimeProcessIdentity } from "@ccc/device-lab/device-lab-process-identity.js";
import {
    waitForExpectedRuntimeExitAsync,
    waitForExpectedRuntimeExitSync,
    type AsyncRuntimeExitOptions,
    type RuntimeExitOptions,
} from "@ccc/device-lab/device-lab/adapters/process/runtime-exit.js";

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
}));

const expected = { pid: 42, startToken: "linux:123", commandHash: "a".repeat(64) };
const psBirth = "Wed Oct 15 12:00:00 2026";
const localizedPsBirths = ["2026년 10월 15일 목요일 12시 00분 00초", "jeu. 15 oct. 2026 12:00:00"];
const windowsBirth = "windows:2026-10-15T12:00:00.0000000Z";

function linuxStat(state = "S", birth = "123", pid = expected.pid): string {
    const fields = Array<string>(20).fill("0");
    fields[0] = state;
    fields[19] = birth;
    return `${pid} (owned child ) with spaces) ${fields.join(" ")}`;
}

function clock() {
    let elapsed = 0;
    return {
        now: () => elapsed,
        sleep: vi.fn((ms: number) => {
            expect(ms).toBeGreaterThan(0);
            elapsed += ms;
        }),
        advance: (ms: number) => { elapsed += ms; },
    };
}

function nativeResult(stdout: string, status: number | null = 0, stderr = "") {
    return { status, stdout, stderr };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

function nextEventLoopTurn(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

describe("expected runtime exit observation", () => {
    it.each(["Z", "X"])("observes a matching Linux child in dead state %s as ended", state => {
        const readProcStat = vi.fn(() => linuxStat(state));
        const c = clock();
        expect(waitForExpectedRuntimeExitSync(expected, 100, { platform: "linux", ...c, readProcStat })).toBe("ended");
        expect(readProcStat).toHaveBeenCalledWith(expected.pid, expect.any(Number), 4096);
        expect(c.sleep).not.toHaveBeenCalled();
    });

    it("recognizes predecessor exit when a Linux pid now has a different valid birth", () => {
        const c = clock();
        expect(waitForExpectedRuntimeExitSync(expected, 100, {
            platform: "linux", ...c, readProcStat: () => linuxStat("R", "456"),
        })).toBe("ended");
    });

    it("distinguishes an absent Linux process from denied or malformed observations", () => {
        const c = clock();
        expect(waitForExpectedRuntimeExitSync(expected, 100, {
            platform: "linux", ...c,
            readProcStat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
        })).toBe("ended");
        for (const code of ["EACCES", "EPERM", "EIO"]) {
            expect(waitForExpectedRuntimeExitSync(expected, 100, {
                platform: "linux", ...clock(),
                readProcStat: () => { throw Object.assign(new Error("unreadable"), { code }); },
            }), code).toBe("unavailable");
        }
    });

    it.each([
        "",
        "42 (truncated) S 0 0",
        linuxStat("Z", "not-a-birth"),
        linuxStat("Z", "123", 99),
        "x".repeat(4097),
    ])("does not mistake malformed Linux stat data for exit: %j", stat => {
        expect(waitForExpectedRuntimeExitSync(expected, 100, {
            platform: "linux", ...clock(), readProcStat: () => stat,
        })).toBe("unavailable");
    });

    it("stops polling a live Linux birth at the deadline without a fresh native probe", () => {
        const c = clock();
        const probes: Array<{ at: number; remaining: number; maxBytes: number }> = [];
        expect(waitForExpectedRuntimeExitSync(expected, 125, {
            platform: "linux", ...c,
            readProcStat: (_pid, remaining, maxBytes) => {
                probes.push({ at: c.now(), remaining, maxBytes });
                return linuxStat("R");
            },
        })).toBe("still-running");
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
            expect(probe.at).toBeLessThan(125);
            expect(probe.remaining).toBeGreaterThan(0);
            expect(probe.remaining).toBeLessThanOrEqual(125 - probe.at);
            expect(probe.maxBytes).toBe(4096);
        }
        expect(c.now()).toBe(125);
    });

    it("retains unknown status when the latest live-process observation becomes unavailable", () => {
        const c = clock();
        let reads = 0;
        expect(waitForExpectedRuntimeExitSync(expected, 100, {
            platform: "linux", ...c,
            readProcStat: () => {
                if (++reads === 1) return linuxStat("R");
                throw Object.assign(new Error("denied"), { code: "EPERM" });
            },
        })).toBe("unavailable");
        expect(reads).toBe(2);
    });

    it("does not treat a different command hash within the same Linux birth as exit", () => {
        expect(waitForExpectedRuntimeExitSync({ ...expected, commandHash: "b".repeat(64) }, 50, {
            platform: "linux", ...clock(), readProcStat: () => linuxStat("R"),
        })).toBe("still-running");
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not probe without a finite positive time budget (%s)", timeoutMs => {
        const readProcStat = vi.fn(() => linuxStat("Z"));
        const run = vi.fn(() => nativeResult("ended"));
        expect(waitForExpectedRuntimeExitSync(expected, timeoutMs, { platform: "linux", readProcStat, run })).toBe("unavailable");
        expect(readProcStat).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
    });

    it.each([
        null,
        { ...expected, pid: -1 },
        { ...expected, pid: 1.5 },
        { ...expected, pid: Number.MAX_SAFE_INTEGER + 1 },
        { ...expected, startToken: "" },
        { ...expected, commandHash: "unverified" },
    ])("requires a complete expected runtime identity before observing it (%j)", identity => {
        const readProcStat = vi.fn(() => linuxStat("Z"));
        expect(waitForExpectedRuntimeExitSync(identity, 100, { platform: "linux", readProcStat })).toBe("unavailable");
        expect(readProcStat).not.toHaveBeenCalled();
    });

    it.each(["Z", "Zs+"])("recognizes a same-birth Darwin process in state %s as ended", state => {
        const run = vi.fn(() => nativeResult(`${psBirth} ${state}\n`));
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${psBirth}` }, 100, {
            platform: "darwin", ...clock(), run,
        })).toBe("ended");
        expect(run).toHaveBeenCalledWith("/bin/ps", ["-p", "42", "-o", "lstart=", "-o", "state="], expect.objectContaining({
            encoding: "utf8", timeout: expect.any(Number), maxBuffer: 4096, killSignal: "SIGKILL", windowsHide: true,
        }));
    });

    // Apple's ps appends process flags to the state, in print.c state().
    // X means traced in this suffix; it is not a Darwin dead-state letter.
    // https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c
    it.each(["Ss", "S+", "S<s+", "SX"])("keeps a matching Darwin birth with native state flags %s alive", state => {
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${psBirth}` }, 100, {
            platform: "darwin", ...clock(), run: () => nativeResult(`${psBirth} ${state}\n`),
        })).toBe("still-running");
    });

    it.each(["Sgarbage", "Zgarbage", "S++", "S+s", "X", "?s"])("rejects malformed or unknown Darwin state flags %s", state => {
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${psBirth}` }, 100, {
            platform: "darwin", ...clock(), run: () => nativeResult(`${psBirth} ${state}\n`),
        })).toBe("unavailable");
    });

    it("distinguishes clean Darwin absence from ambiguous live births and failed ps execution", () => {
        const identity = { ...expected, startToken: `ps:${psBirth}` };
        for (const result of [nativeResult("", 1), nativeResult("Wed Oct 15 12:00:01 2026 Z\n")]) {
            expect(waitForExpectedRuntimeExitSync(identity, 100, { platform: "darwin", ...clock(), run: () => result })).toBe("ended");
        }
        for (const result of [nativeResult("Wed Oct 15 12:00:01 2026 S\n"), nativeResult("", 0), nativeResult("", 1, "permission denied"), nativeResult("not a birth S"), nativeResult("", 2)]) {
            expect(waitForExpectedRuntimeExitSync(identity, 100, { platform: "darwin", ...clock(), run: () => result })).toBe("unavailable");
        }
    });

    it.each(localizedPsBirths)("observes a saved localized Darwin birth without parsing its date: %s", birth => {
        const run = vi.fn(() => nativeResult(`${birth} S<s+\n`));
        const c = clock();
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${birth}` }, 100, {
            platform: "darwin", ...c, run,
        })).toBe("still-running");
        expect(run).toHaveBeenCalled();
        expect(c.now()).toBe(100);
    });

    it.each(localizedPsBirths)("confirms localized predecessor exit only from clean absence or matching zombie: %s", birth => {
        const identity = { ...expected, startToken: `ps:${birth}` };
        for (const result of [nativeResult("", 1), nativeResult(`${birth} Zs+\n`)]) {
            const run = vi.fn(() => result);
            expect(waitForExpectedRuntimeExitSync(identity, 100, { platform: "darwin", ...clock(), run })).toBe("ended");
            expect(run).toHaveBeenCalled();
        }
        for (const result of [
            nativeResult("", 0), nativeResult("", 1, "permission denied"),
            { ...nativeResult("", 1), error: new Error("ps failed") },
            { ...nativeResult(`${birth} Z\n`), signal: "SIGKILL" },
            nativeResult(`${birth} Zgarbage\n`),
        ]) {
            expect(waitForExpectedRuntimeExitSync(identity, 100, {
                platform: "darwin", ...clock(), run: () => result,
            })).toBe("unavailable");
        }
    });

    it.each([
        // A timezone change can render one live birth as two English dates.
        ["Wed Oct 15 12:00:00 2026", "Wed Oct 15 08:00:00 2026"],
        [localizedPsBirths[0], localizedPsBirths[1]],
        [localizedPsBirths[1], "jeu. 15 oct. 2026 12:00:01"],
        [psBirth, localizedPsBirths[0]],
        [localizedPsBirths[1], psBirth],
    ])("requires independent exit evidence for ambiguous Darwin birth mismatch %s / %s", (saved, observed) => {
        const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("exit observer must not signal"); });
        try {
            for (const state of ["S", "S<s+", "Z", "Zs+"]) {
                expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${saved}` }, 100, {
                    platform: "darwin", ...clock(), run: () => nativeResult(`${observed} ${state}\n`),
                })).toBe(state.startsWith("Z") ? "ended" : "unavailable");
            }
            expect(kill).not.toHaveBeenCalled();
        } finally { kill.mockRestore(); }
    });

    it.each(["", "   ", " birth", "birth ", "birth\nsecond row", "birth\rsecond row", "birth\u0000", "birth\u001b", "birth\u007f", "birth\u0085", "birth\u2028", "birth\u2029", "가".repeat(1365)])("rejects an unsafe saved Darwin birth before probing (case %#)", birth => {
        const run = vi.fn(() => nativeResult("", 1));
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${birth}` }, 100, {
            platform: "darwin", ...clock(), run,
        })).toBe("unavailable");
        expect(run).not.toHaveBeenCalled();
    });

    it.each(["birth\nsecond row S\n", "birth\u0000 S\n", "가".repeat(1366) + " S\n"])("rejects malformed native output with a localized expected birth (case %#)", stdout => {
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: `ps:${localizedPsBirths[0]}` }, 100, {
            platform: "darwin", ...clock(), run: () => nativeResult(stdout),
        })).toBe("unavailable");
    });

    it.each(["darwin", "win32"] as const)("bounds every %s subprocess by the remaining monotonic budget", platform => {
        const c = clock();
        const probes: Array<{ at: number; timeout: number }> = [];
        const identity = { ...expected, startToken: platform === "darwin" ? `ps:${psBirth}` : windowsBirth };
        const run: NonNullable<RuntimeExitOptions["run"]> = (_executable, _args, options) => {
            probes.push({ at: c.now(), timeout: options.timeout });
            expect(options.maxBuffer).toBe(4096);
            c.advance(Math.min(10, options.timeout));
            return nativeResult(platform === "darwin" ? `${psBirth} S\n` : windowsBirth);
        };
        expect(waitForExpectedRuntimeExitSync(identity, 125, {
            platform, ...c, powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", run,
        })).toBe("still-running");
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
            expect(probe.at).toBeLessThan(125);
            expect(probe.timeout).toBeGreaterThan(0);
            expect(probe.timeout).toBeLessThanOrEqual(125 - probe.at);
        }
        expect(c.now()).toBe(125);
    });

    it.each(["darwin", "win32"] as const)("does not turn a timed out %s probe into process absence", platform => {
        const c = clock();
        const run = vi.fn((_executable: string, _args: string[], options: { timeout: number }) => {
            c.advance(options.timeout);
            return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) };
        });
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: platform === "darwin" ? `ps:${psBirth}` : windowsBirth }, 75, {
            platform, ...c, powershellPath: "powershell.exe", run,
        })).toBe("unavailable");
        expect(run).toHaveBeenCalledTimes(1);
        expect(c.sleep).not.toHaveBeenCalled();
    });

    it("requires explicit Windows process absence or a different valid birth", () => {
        const identity = { ...expected, startToken: windowsBirth };
        for (const stdout of ["ended", "windows:2026-10-15T12:00:01.0000000Z"]) {
            expect(waitForExpectedRuntimeExitSync(identity, 100, {
                platform: "win32", ...clock(), powershellPath: "powershell.exe", run: () => nativeResult(stdout),
            })).toBe("ended");
        }
        for (const result of [nativeResult(""), nativeResult("garbage"), nativeResult("windows:not-a-birth"), nativeResult("ended", 1), { ...nativeResult("ended"), signal: "SIGKILL" }]) {
            expect(waitForExpectedRuntimeExitSync(identity, 100, {
                platform: "win32", ...clock(), powershellPath: "powershell.exe", run: () => result,
            })).toBe("unavailable");
        }
    });

    it("retains unknown status when the Windows executable cannot be resolved", () => {
        const run = vi.fn(() => nativeResult("ended"));
        expect(waitForExpectedRuntimeExitSync({ ...expected, startToken: windowsBirth }, 100, {
            platform: "win32", powershellPath: null, run,
        })).toBe("unavailable");
        expect(run).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform !== "linux")("observes an actual owned child exit while its parent event loop cannot reap it", async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        const closed = new Promise<{ error?: Error }>(resolve => {
            child.once("error", error => resolve({ error }));
            child.once("close", () => resolve({}));
        });
        let joinTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            const identity = readDeviceRuntimeProcessIdentity(child.pid);
            expect(identity).not.toBeNull();
            expect(child.kill("SIGKILL")).toBe(true);
            expect(waitForExpectedRuntimeExitSync(identity, 2000)).toBe("ended");
            // The sync waiter must understand native dead state. kill(pid, 0) still
            // succeeds until Node returns to its event loop and reaps this child.
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
            const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
            expect(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0]).toMatch(/^[ZX]$/);
        } finally {
            if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            try {
                const result = await Promise.race([
                    closed,
                    new Promise<never>((_resolve, reject) => {
                        joinTimer = setTimeout(() => reject(new Error("owned runtime child was not reaped")), 2000);
                    }),
                ]);
                expect(result.error).toBeUndefined();
            } finally {
                if (joinTimer) clearTimeout(joinTimer);
            }
        }
    });
});

describe("asynchronous exact runtime exit observation", () => {
    it("recognizes clean Darwin absence from the default native execFile exit-one callback", async () => {
        const c = clock();
        type Callback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
        const native = vi.spyOn(childProcess, "execFile").mockImplementation(((_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, complete: Callback) => {
            setImmediate(() => complete(Object.assign(new Error("ps exited without a matching process"), { code: 1 }), "", ""));
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);
        try {
            expect(await waitForExpectedRuntimeExitAsync({ ...expected, startToken: `ps:${psBirth}` }, 100, {
                platform: "darwin", ...c,
            })).toBe("ended");
            expect(native).toHaveBeenCalledTimes(1);
            expect(native.mock.calls[0][0]).toBe("/bin/ps");
            expect(native.mock.calls[0][1]).toEqual(["-p", "42", "-o", "lstart=", "-o", "state="]);
            expect(native.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 100, maxBuffer: 4096 }));
            expect(c.sleep).not.toHaveBeenCalled();
        } finally { native.mockRestore(); }
    });

    it.each([
        { name: "nonzero exit with stderr", error: Object.assign(new Error("ps failed"), { code: 1 }), stderr: "permission denied" },
        { name: "killed native command", error: Object.assign(new Error("ps killed"), { code: 1, killed: true }), stderr: "" },
        { name: "signalled native command", error: Object.assign(new Error("ps signalled"), { code: 1, signal: "SIGKILL" as const }), stderr: "" },
        { name: "native launch failure", error: Object.assign(new Error("ps unavailable"), { code: "ENOENT" }), stderr: "" },
        { name: "native timeout", error: Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT", killed: true }), stderr: "" },
    ])("does not turn a default Darwin execFile $name into clean absence", async ({ error, stderr }) => {
        const c = clock();
        type Callback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
        const native = vi.spyOn(childProcess, "execFile").mockImplementation(((_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, complete: Callback) => {
            setImmediate(() => complete(error, "", stderr));
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);
        try {
            expect(await waitForExpectedRuntimeExitAsync({ ...expected, startToken: `ps:${psBirth}` }, 100, {
                platform: "darwin", ...c,
            })).toBe("unavailable");
            expect(native).toHaveBeenCalled();
        } finally { native.mockRestore(); }
    });

    it("awaits each Linux observation and pacing sleep before probing again", async () => {
        const c = clock();
        const firstObservation = deferred<string>();
        const sleepGate = deferred<void>();
        const events: string[] = [];
        let reads = 0;
        const readProcStat = vi.fn((_pid: number, remaining: number, maxBytes: number) => {
            events.push(`read:${remaining}:${maxBytes}`);
            return ++reads === 1 ? firstObservation.promise : Promise.resolve(linuxStat("Z"));
        });
        const sleep = vi.fn(async (milliseconds: number) => {
            events.push(`sleep:${milliseconds}`);
            await sleepGate.promise;
            c.advance(milliseconds);
        });
        let settled = false;
        const pending = waitForExpectedRuntimeExitAsync(expected, 100, { platform: "linux", now: c.now, readProcStat, sleep })
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(events).toEqual(["read:100:4096"]);
        expect(sleep).not.toHaveBeenCalled();
        c.advance(12);
        firstObservation.resolve(linuxStat("R"));
        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(events).toEqual(["read:100:4096", "sleep:50"]);
        expect(readProcStat).toHaveBeenCalledTimes(1);
        sleepGate.resolve();

        expect(await pending).toBe("ended");
        expect(events).toEqual(["read:100:4096", "sleep:50", "read:38:4096"]);
    });

    it("refuses an exit observation that completes after the original deadline", async () => {
        const c = clock();
        const observation = deferred<string>();
        const sleep = vi.fn();
        const pending = waitForExpectedRuntimeExitAsync(expected, 75, {
            platform: "linux", now: c.now, sleep, readProcStat: () => observation.promise,
        });
        await nextEventLoopTurn();
        c.advance(76);
        observation.resolve(linuxStat("Z"));

        expect(await pending).toBe("unavailable");
        expect(sleep).not.toHaveBeenCalled();
    });

    it.each(["Z", "X"])("recognizes a qualified Linux process in dead state %s after an awaited read", async state => {
        const c = clock();
        const readProcStat = vi.fn(async () => linuxStat(state));
        expect(await waitForExpectedRuntimeExitAsync(expected, 100, { platform: "linux", ...c, readProcStat })).toBe("ended");
        expect(readProcStat).toHaveBeenCalledExactlyOnceWith(42, 100, 4096);
        expect(c.sleep).not.toHaveBeenCalled();
    });

    it("uses a different valid Linux birth as exact predecessor-exit evidence", async () => {
        expect(await waitForExpectedRuntimeExitAsync(expected, 100, {
            platform: "linux", ...clock(), readProcStat: async () => linuxStat("R", "456"),
        })).toBe("ended");
        expect(await waitForExpectedRuntimeExitAsync({ ...expected, commandHash: "b".repeat(64) }, 50, {
            platform: "linux", ...clock(), readProcStat: async () => linuxStat("R"),
        })).toBe("still-running");
    });

    it.each(["ENOENT", "EPERM", "EIO"])("distinguishes rejected async Linux observation %s from absence", async code => {
        expect(await waitForExpectedRuntimeExitAsync(expected, 100, {
            platform: "linux", ...clock(), readProcStat: async () => { throw Object.assign(new Error("unreadable"), { code }); },
        })).toBe(code === "ENOENT" ? "ended" : "unavailable");
    });

    it.each([linuxStat("Z", "not-a-birth"), linuxStat("Z", "123", 99), "x".repeat(4097)])(
        "does not grant exit from malformed awaited Linux output (case %#)",
        async stat => {
            expect(await waitForExpectedRuntimeExitAsync(expected, 100, {
                platform: "linux", ...clock(), readProcStat: async () => stat,
            })).toBe("unavailable");
        },
    );

    it("retains unavailable status when async Linux observation loses permission after a live birth", async () => {
        const c = clock();
        let reads = 0;
        expect(await waitForExpectedRuntimeExitAsync(expected, 100, {
            platform: "linux", ...c,
            readProcStat: async () => {
                if (++reads === 1) return linuxStat("R");
                throw Object.assign(new Error("denied"), { code: "EPERM" });
            },
        })).toBe("unavailable");
        expect(reads).toBe(2);
        expect(c.now()).toBe(100);
    });

    it("does not start a fresh native observation after an awaited sleep consumes the deadline", async () => {
        const c = clock();
        const gate = deferred<void>();
        const readProcStat = vi.fn(async () => linuxStat("R"));
        const sleep = vi.fn(async (milliseconds: number) => {
            await gate.promise;
            c.advance(milliseconds);
        });
        const pending = waitForExpectedRuntimeExitAsync(expected, 25, { platform: "linux", now: c.now, readProcStat, sleep });
        await nextEventLoopTurn();
        expect(readProcStat).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
        gate.resolve();
        expect(await pending).toBe("still-running");
        expect(readProcStat).toHaveBeenCalledTimes(1);
    });

    it("refuses a rejected async pacing effect without starting another probe", async () => {
        const readProcStat = vi.fn(async () => linuxStat("R"));
        expect(await waitForExpectedRuntimeExitAsync(expected, 100, {
            platform: "linux", now: () => 0, readProcStat,
            sleep: async () => { throw new Error("pacing cancelled"); },
        })).toBe("unavailable");
        expect(readProcStat).toHaveBeenCalledTimes(1);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not dispatch async effects without a usable allowance %s", async timeoutMs => {
        const readProcStat = vi.fn(async () => linuxStat("Z"));
        const run = vi.fn(async () => nativeResult("ended"));
        const sleep = vi.fn();
        expect(await waitForExpectedRuntimeExitAsync(expected, timeoutMs, { platform: "linux", readProcStat, run, sleep })).toBe("unavailable");
        expect(readProcStat).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    it.each([null, { ...expected, pid: -1 }, { ...expected, startToken: "" }, { ...expected, commandHash: "unverified" }])(
        "does not dispatch an async probe for unqualified runtime identity %j",
        async identity => {
            const readProcStat = vi.fn(async () => linuxStat("Z"));
            expect(await waitForExpectedRuntimeExitAsync(identity, 100, { platform: "linux", readProcStat })).toBe("unavailable");
            expect(readProcStat).not.toHaveBeenCalled();
        },
    );

    it.each(["darwin", "win32"] as const)("awaits native %s observations and carries their time into later probes", async platform => {
        const c = clock();
        const gate = deferred<ReturnType<typeof nativeResult>>();
        const probes: Array<{ at: number; timeout: number }> = [];
        const identity = { ...expected, startToken: platform === "darwin" ? `ps:${psBirth}` : windowsBirth };
        const run: NonNullable<AsyncRuntimeExitOptions["run"]> = (_executable, _args, options) => {
            probes.push({ at: c.now(), timeout: options.timeout });
            expect(options.maxBuffer).toBe(4096);
            return probes.length === 1 ? gate.promise : Promise.resolve(nativeResult(platform === "darwin" ? "" : "ended", platform === "darwin" ? 1 : 0));
        };
        let settled = false;
        const pending = waitForExpectedRuntimeExitAsync(identity, 100, {
            platform, ...c, powershellPath: "trusted-powershell.exe", run,
        }).then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(probes).toEqual([{ at: 0, timeout: 100 }]);
        expect(c.sleep).not.toHaveBeenCalled();
        c.advance(20);
        gate.resolve(nativeResult(platform === "darwin" ? `${psBirth} S\n` : windowsBirth));

        expect(await pending).toBe("ended");
        expect(probes).toEqual([{ at: 0, timeout: 100 }, { at: 70, timeout: 30 }]);
        expect(c.sleep).toHaveBeenCalledExactlyOnceWith(50);
    });

    it.each(["darwin", "win32"] as const)("does not accept delayed %s absence beyond the deadline", async platform => {
        const c = clock();
        const gate = deferred<ReturnType<typeof nativeResult>>();
        const run = vi.fn(() => gate.promise);
        const pending = waitForExpectedRuntimeExitAsync({ ...expected, startToken: platform === "darwin" ? `ps:${psBirth}` : windowsBirth }, 75, {
            platform, ...c, powershellPath: "trusted-powershell.exe", run,
        });
        await nextEventLoopTurn();
        c.advance(76);
        gate.resolve(nativeResult(platform === "darwin" ? "" : "ended", platform === "darwin" ? 1 : 0));

        expect(await pending).toBe("unavailable");
        expect(run).toHaveBeenCalledTimes(1);
        expect(c.sleep).not.toHaveBeenCalled();
    });

    it.each(["ended", "windows:2026-10-15T12:00:01.0000000Z"])("observes awaited exact Windows exit evidence %s", async stdout => {
        const run = vi.fn(async () => nativeResult(stdout));
        expect(await waitForExpectedRuntimeExitAsync({ ...expected, startToken: windowsBirth }, 100, {
            platform: "win32", ...clock(), powershellPath: "trusted-powershell.exe", run,
        })).toBe("ended");
        expect(run).toHaveBeenCalledTimes(1);
    });

    it.each([nativeResult("garbage"), nativeResult("ended", 1), { ...nativeResult("ended"), error: new Error("native transport failed") }])(
        "does not mistake failed awaited Windows output for predecessor exit (case %#)",
        async result => {
            expect(await waitForExpectedRuntimeExitAsync({ ...expected, startToken: windowsBirth }, 100, {
                platform: "win32", ...clock(), powershellPath: "trusted-powershell.exe", run: async () => result,
            })).toBe("unavailable");
        },
    );

    it("preserves Darwin birth ambiguity after awaited localized native observation", async () => {
        const identity = { ...expected, startToken: `ps:${localizedPsBirths[0]}` };
        expect(await waitForExpectedRuntimeExitAsync(identity, 50, {
            platform: "darwin", ...clock(), run: async () => nativeResult(`${localizedPsBirths[1]} S<s+\n`),
        })).toBe("unavailable");
        expect(await waitForExpectedRuntimeExitAsync(identity, 50, {
            platform: "darwin", ...clock(), run: async () => nativeResult(`${localizedPsBirths[1]} Zs+\n`),
        })).toBe("ended");
    });
});
