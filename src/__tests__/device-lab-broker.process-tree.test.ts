import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { runInNewContext } from "vm";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    boundedProviderCommandRunnerScript,
    defaultProviderCommandRunner,
    defaultProviderCommandRunnerAsync,
    providerCommandSpawn,
    runBrokerBackendChild,
    terminateBrokerSpawnedProcessTree,
    windowsHiddenVbsLauncherScript,
} from "@ccc/device-lab/device-lab-broker.js";

const roots: string[] = [];
const workerFixture = vi.hoisted(() => ({
    delayMs: 0,
    replacement: "",
    data: undefined as undefined | { shared: SharedArrayBuffer; admissionShared: SharedArrayBuffer },
    workers: [] as import("worker_threads").Worker[],
}));
const backendNative = vi.hoisted(() => ({
    spawn: undefined as undefined | ((...args: unknown[]) => unknown),
    identity: undefined as undefined | ((...args: unknown[]) => unknown),
    inspect: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock("child_process", async original => {
    const actual = await original<typeof import("child_process")>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => backendNative.spawn ? backendNative.spawn(...args) : actual.spawn(...args) };
});
vi.mock("@ccc/device-lab/device-lab-process-identity.js", async original => {
    const actual = await original<typeof import("@ccc/device-lab/device-lab-process-identity.js")>();
    return {
        ...actual,
        readDeviceRuntimeProcessIdentity: (...args: Parameters<typeof actual.readDeviceRuntimeProcessIdentity>) => backendNative.identity
            ? backendNative.identity(...args)
            : actual.readDeviceRuntimeProcessIdentity(...args),
        inspectDeviceRuntimeProcessIdentity: (...args: Parameters<typeof actual.inspectDeviceRuntimeProcessIdentity>) => backendNative.inspect
            ? backendNative.inspect(...args)
            : actual.inspectDeviceRuntimeProcessIdentity(...args),
    };
});

vi.mock("worker_threads", async original => {
    const actual = await original<typeof import("worker_threads")>();
    return {
        ...actual,
        Worker: class extends actual.Worker {
            constructor(script: string | URL, options: import("worker_threads").WorkerOptions) {
                const delayed = workerFixture.delayMs
                    ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${workerFixture.delayMs});\n${script}`
                    : script;
                super(workerFixture.replacement || delayed, options);
                workerFixture.data = options.workerData;
                workerFixture.workers.push(this);
            }
        },
    };
});

/** Execute the shipped Worker body at its native boundary, without real foreign PIDs. */
function generatedRunnerFixture(options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    cleanupGraceMs?: number;
    admission?: [number, number];
    admissionState?: number;
    grantDelayMs?: number;
    cancel?: "before-request" | "after-grant" | "before-claim" | "during-spawn";
    spawnError?: boolean;
    identityCostMs?: number;
    terminationCostMs?: number;
    missingIdentity?: boolean;
    changedIdentity?: boolean;
} = {}) {
    let now = 0;
    let identityReads = 0;
    const platform = options.platform || "win32";
    const nativeRequests: Array<{ args: string[]; timeout: number; env?: NodeJS.ProcessEnv }> = [];
    const signals: Array<{ pid: number; signal: string }> = [];
    const spawns: unknown[] = [];
    const dispatchStates: number[] = [];
    const timers = new Map<object, { callback: () => void; at: number; delay: number }>();
    const shared = new SharedArrayBuffer(16 + 65536);
    const identityShared = new SharedArrayBuffer(4096);
    const control = new Int32Array(shared, 0, 4);
    const admissionShared = options.admission || options.cancel ? new SharedArrayBuffer(20 + 65536) : undefined;
    const admission = admissionShared ? new Int32Array(admissionShared, 0, 5) : undefined;
    if (admission && options.admissionState !== undefined) admission[0] = options.admissionState;
    if (options.cancel === "before-request") admission![3] = 1;
    const child = Object.assign(new EventEmitter(), {
        pid: 7001,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdin: { end: vi.fn(), destroy: vi.fn() },
        stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        unref: vi.fn(),
        kill: vi.fn(),
    });
    const parentPort = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    const identity = () => {
        identityReads += 1;
        now += options.identityCostMs || 0;
        return options.missingIdentity ? "" : JSON.stringify({
            startToken: options.changedIdentity && identityReads > 1 ? "reused-token" : "2026-10-02T02:11:08.7160248Z",
            commandLine: "node provider.js",
        });
    };
    let waits = 0;
    const atomics = {
        load: Atomics.load, store: Atomics.store, notify: Atomics.notify,
        compareExchange: (array: Int32Array, slot: number, expected: number, value: number) => {
            if (array.buffer === admissionShared && slot === 0 && expected === 3 && value === 4 && options.cancel === "before-claim") {
                Atomics.store(array, 3, 1);
                Atomics.compareExchange(array, 0, 3, -1);
            }
            const before = Atomics.compareExchange(array, slot, expected, value);
            if (array.buffer === admissionShared && slot === 0 && expected === 2 && value === 3 && before === 2 && options.cancel === "after-grant") {
                Atomics.store(array, 3, 1);
            }
            return before;
        },
        wait: (array: Int32Array, slot: number) => {
            if (++waits > 20) throw new Error("fixture admission never settled");
            if (array.buffer === admissionShared && slot === 0 && array[0] === 1) {
                now += options.grantDelayMs || 0;
                array[1] = options.admission?.[0] ?? 40;
                array[2] = options.admission?.[1] ?? 100;
                array[0] = 2;
                return "ok";
            }
            return "timed-out";
        },
    };
    const monotonic = () => now;
    const hrtime = Object.assign(() => [Math.floor(now / 1000), (now % 1000) * 1e6], { bigint: () => BigInt(Math.floor(now * 1e6)) });
    const context = {
        Buffer, SharedArrayBuffer, Int32Array, Uint8Array, Atomics: atomics,
        performance: { now: monotonic },
        process: { platform, env: {}, hrtime, kill: (pid: number, signal: string) => signals.push({ pid, signal }) },
        require: (name: string) => {
            if (name === "node:child_process") return {
                spawn: (...args: unknown[]) => {
                    spawns.push(args);
                    if (admission) dispatchStates.push(Atomics.load(admission, 0));
                    if (options.cancel === "during-spawn") Atomics.store(admission!, 3, 1);
                    if (options.spawnError) throw new Error("native-spawn-threw");
                    return child;
                },
                spawnSync: (_file: string, args: string[], nativeOptions: { timeout: number; env?: NodeJS.ProcessEnv }) => {
                    nativeRequests.push({ args, ...nativeOptions });
                    if (nativeOptions.env?.CCC_WINDOWS_TERMINATE_PID) {
                        now += options.terminationCostMs || 0;
                        return { status: 0, stdout: "", stderr: "" };
                    }
                    return { status: 0, stdout: identity(), stderr: "" };
                },
            };
            if (name === "node:crypto") return { createHash };
            if (name === "node:fs") return { readFileSync: () => { throw new Error("unavailable identity"); } };
            if (name === "node:perf_hooks") return { performance: { now: monotonic } };
            if (name === "node:worker_threads") return {
                parentPort,
                workerData: {
                    shared, identityShared,
                    ...(admissionShared ? { admissionShared } : {}),
                    payload: {
                        executable: "test-owned-provider", args: [], outputLimit: 16,
                        timeoutMs: options.timeoutMs ?? 100,
                        cleanupGraceMs: options.cleanupGraceMs ?? 50,
                        windowsPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    },
                },
            };
            throw new Error(`unexpected generated runner dependency: ${name}`);
        },
        setTimeout: (callback: () => void, delay: number) => {
            const timer = { unref: () => timer };
            timers.set(timer, { callback, delay, at: now + delay });
            return timer;
        },
        clearTimeout: (timer: object) => { timers.delete(timer); },
    };
    runInNewContext(boundedProviderCommandRunnerScript(), context);
    return {
        child, spawns, dispatchStates, nativeRequests, signals, timers, admission, parentPort, control,
        advance: (milliseconds: number) => { now += milliseconds; },
        runNextTimer: () => {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) throw new Error("fixture expected a pending timer");
            timers.delete(next[0]);
            now = Math.max(now, next[1].at);
            next[1].callback();
        },
        exit: (status: number) => { child.exitCode = status; child.emit("exit", status, null); },
        close: (status: number) => {
            child.exitCode = status;
            child.emit("exit", status, null);
            child.emit("close", status, null);
        },
        failureBytes: () => admission && admission[4] > 0
            ? Buffer.from(new Uint8Array(admissionShared!, 20, admission[4]))
            : undefined,
        publishedIdentity: () => control[3] > 0
            ? JSON.parse(Buffer.from(new Uint8Array(identityShared, 0, control[3])).toString("utf8"))
            : undefined,
        result: () => control[0] === 1
            ? JSON.parse(Buffer.from(new Uint8Array(shared, 16, control[1])).toString("utf8"))
            : undefined,
    };
}

function temporaryRoot() {
    const root = mkdtempSync(join(tmpdir(), "ccc-broker-process-tree-"));
    roots.push(root);
    return root;
}

function descendantProbeScript(readyFile: string) {
    const childScript = [
        "(async () => {",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
    return [
        "(async () => {",
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
}

function stdioHoldingDescendantScript(readyFile: string) {
    const childScript = [
        "(async () => {",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
    return [
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'inherit' });`,
        "setInterval(() => undefined, 1000);",
    ].join("\n");
}

function outputOverflowDescendantScript(readyFile: string, outputBytes: number) {
    const childScript = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
    ].join("\n");
    return [
        "(async () => {",
        "const { existsSync } = await import('node:fs');",
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `while (!existsSync(${JSON.stringify(readyFile)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
        `process.stdout.write('x'.repeat(${outputBytes}));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
}

function processIsRunning(pid: number) {
    try {
        process.kill(pid, 0);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (process.platform !== "win32") {
        const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        if (status.status !== 0 || /^Z/.test(status.stdout.trim())) return false;
    }
    return true;
}

async function expectProcessTreeExit(readyFile: string) {
    expect(existsSync(readyFile), "descendant never reached its ready point before the timeout").toBe(true);
    const pid = Number(readFileSync(readyFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5000;
    while (processIsRunning(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(processIsRunning(pid), `descendant process ${pid} survived timeout cleanup`).toBe(false);
}

function terminateTestProcess(pid: number) {
    if (!processIsRunning(pid)) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        return;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* best-effort test cleanup */ }
}

async function cleanupOwnedProcesses(readyFile: string, parentPid?: number) {
    const pids = [parentPid, existsSync(readyFile) ? Number(readFileSync(readyFile, "utf8")) : undefined]
        .filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0);
    for (const pid of pids) terminateTestProcess(pid);
    for (const pid of pids) {
        const until = Date.now() + 5000;
        while (processIsRunning(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        expect(processIsRunning(pid), `test-owned process ${pid} did not settle in teardown`).toBe(false);
    }
}

afterEach(async () => {
    workerFixture.delayMs = 0;
    workerFixture.replacement = "";
    workerFixture.data = undefined;
    await Promise.allSettled(workerFixture.workers.splice(0).map(worker => worker.terminate()));
    backendNative.spawn = undefined;
    backendNative.identity = undefined;
    backendNative.inspect = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
        try {
            for (const file of readdirSync(root).filter(file => file.endsWith(".ready"))) {
                await cleanupOwnedProcesses(join(root, file));
            }
        } finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
    }
});

describe("device broker timed-out process tree cleanup", () => {
    function claimedWorkerScript(publishAfterCancellation: boolean) {
        return `
            const { workerData, parentPort } = require('node:worker_threads');
            const control = new Int32Array(workerData.shared,0,4);
            const admission = new Int32Array(workerData.admissionShared,0,5);
            Atomics.store(admission,0,1); Atomics.compareExchange(control,0,0,2); Atomics.notify(control,0);
            parentPort.postMessage({admission:true});
            while (Atomics.load(admission,0) === 1) Atomics.wait(admission,0,1,1000);
            if (Atomics.compareExchange(admission,0,2,3) !== 2 || Atomics.compareExchange(admission,0,3,4) !== 3)
                throw new Error('test dispatch was not claimed');
            const cancellation = setInterval(() => {
                if (!Atomics.load(admission,3)) return;
                clearInterval(cancellation);
                if (${publishAfterCancellation}) setTimeout(() => {
                    const identity = Buffer.from(JSON.stringify({pid:7101,startToken:'linux:100',commandHash:'${"a".repeat(64)}'}));
                    new Uint8Array(workerData.identityShared).set(identity);
                    Atomics.store(control,2,7101); Atomics.store(control,3,identity.length);
                    Atomics.compareExchange(admission,0,4,5); Atomics.notify(admission,0);
                    parentPort.postMessage({spawned:true,pid:7101});
                },100);
            },5);
            setInterval(() => {},1000);
        `;
    }

    function backendFixture(identityCostMs = 0) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const child = Object.assign(new EventEmitter(), {
            pid: 7002, exitCode: null as number | null, signalCode: null,
            stdin: { end: vi.fn(), destroy: vi.fn() },
            stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
            stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
            unref: vi.fn(),
        });
        backendNative.spawn = () => child;
        backendNative.identity = (_pid, nativeOptions) => {
            expect((nativeOptions as { remainingMs?: () => number }).remainingMs?.()).toBeGreaterThan(0);
            now += identityCostMs;
            return { pid: child.pid, startToken: "linux:100", commandHash: "a".repeat(64) };
        };
        return { child, setNow: (value: number) => { now = value; } };
    }

    it("charges backend identity to command time and caps post-cleanup grace at the captured completion ceiling", async () => {
        const fixture = backendFixture(40);
        let settled = false;
        const execution = runBrokerBackendChild("test-owned-script", "", {
            cwd: temporaryRoot(), timeoutMs: 100, outputLimit: 16, cleanupGraceMs: 50,
            terminateTree: pid => {
                fixture.setNow(15140);
                return { pid: pid!, attempted: true, ok: true, signal: "SIGKILL", platform: process.platform };
            },
        }).then(result => { settled = true; return result; });
        fixture.setNow(99);
        await vi.advanceTimersByTimeAsync(59);
        expect(settled).toBe(false);
        fixture.setNow(100);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        fixture.setNow(15149);
        await vi.advanceTimersByTimeAsync(9);
        expect(settled).toBe(false);
        fixture.setNow(15150);
        await vi.advanceTimersByTimeAsync(1);
        expect(await execution).toMatchObject({ status: null, timedOut: true, cleanup: { attempted: true, ok: true } });
        expect(fixture.child.stdout.destroy).toHaveBeenCalledOnce();
        expect(fixture.child.unref).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, 7])("classifies a late backend native status %s without replacing a genuine rejection", async status => {
        const fixture = backendFixture();
        const execution = runBrokerBackendChild("test-owned-script", "", {
            cwd: temporaryRoot(), timeoutMs: 100, outputLimit: 16,
        });
        fixture.child.stdout.emit("data", Buffer.from("effect-observed"));
        fixture.setNow(101);
        fixture.child.exitCode = status;
        fixture.child.emit("close", status, null);
        expect(await execution).toMatchObject({ status, stdout: "effect-observed", timedOut: status === 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves backend output overflow when command expiry occurs during bounded cleanup", async () => {
        const fixture = backendFixture();
        const execution = runBrokerBackendChild("test-owned-script", "", {
            cwd: temporaryRoot(), timeoutMs: 100, outputLimit: 16, cleanupGraceMs: 200,
            terminateTree: pid => ({ pid: pid!, attempted: true, ok: true, signal: "SIGKILL", platform: process.platform }),
        });
        fixture.child.stdout.emit("data", Buffer.from("x".repeat(32)));
        fixture.setNow(100);
        await vi.advanceTimersByTimeAsync(100);
        fixture.setNow(200);
        await vi.advanceTimersByTimeAsync(100);
        const result = await execution;
        expect(result).toMatchObject({ timedOut: false, error: { message: expect.stringContaining("output exceeded limit") } });
        expect(result.error?.message).not.toContain("timed out");
        expect(Buffer.byteLength(result.stdout)).toBe(16);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves an early backend native exit while stdio delays close beyond command expiry", async () => {
        const fixture = backendFixture();
        const execution = runBrokerBackendChild("test-owned-script", "", {
            cwd: temporaryRoot(), timeoutMs: 100, outputLimit: 16, cleanupGraceMs: 50,
            terminateTree: pid => ({ pid: pid!, attempted: true, ok: true, signal: "SIGKILL", platform: process.platform }),
        });
        fixture.child.stdout.emit("data", Buffer.from("effect-observed"));
        fixture.setNow(30);
        fixture.child.exitCode = 7;
        fixture.child.emit("exit", 7, null);
        fixture.setNow(100);
        await vi.advanceTimersByTimeAsync(100);
        fixture.setNow(101);
        fixture.child.emit("close", 7, null);
        const result = await execution;
        expect(result).toMatchObject({ status: 7, stdout: "effect-observed", timedOut: false });
        expect(result.error).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("never bypasses worker process identity fencing with a direct child kill", () => {
        const fixture = generatedRunnerFixture({ platform: "linux", missingIdentity: true });
        for (let index = 0; index < 5 && !fixture.result(); index += 1) fixture.runNextTimer();
        expect(fixture.result()).toMatchObject({ cleanup: { attempted: false, ok: false } });
        expect(fixture.signals).toEqual([]);
        expect(fixture.child.kill).not.toHaveBeenCalled();
    });

    it("captures the exact Windows handle token with legacy and reduced identity probe budgets", () => {
        const script = boundedProviderCommandRunnerScript();
        const identityFunction = script.slice(script.indexOf("function processIdentity("), script.indexOf("function publishIdentity"));
        const handleToken = "2026-10-02T02:11:08.7160248Z";
        const cimToken = "2026-10-02T02:11:08.7160240Z";
        const commandLine = "node provider.js";
        const requests: number[] = [];
        const context = {
            process: { platform: "win32" },
            payload: { windowsPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
            createHash,
            spawnSync: (_file: string, args: string[], options: { timeout: number }) => {
                requests.push(options.timeout);
                return {
                status: 0,
                stdout: JSON.stringify({
                    startToken: args.at(-1)?.includes("$H.StartTime.ToUniversalTime().ToString('o')") ? handleToken : cimToken,
                    commandLine,
                }),
                };
            },
        };
        const observed = runInNewContext(`${identityFunction}; processIdentity(42)`, context);
        expect(observed).toEqual({ pid: 42, startToken: `windows:${handleToken}`, commandHash: createHash("sha256").update(commandLine).digest("hex") });
        expect(requests).toEqual([5000]);
        expect(runInNewContext(`${identityFunction}; processIdentity(42, () => 37.8)`, context)).toEqual(observed);
        expect(requests).toEqual([5000, 37]);
    });

    it.each([0, 10])("shares admitted command and completion durations across transport, identity, termination and grace (transport %sms)", grantDelayMs => {
        const fixture = generatedRunnerFixture({ admission: [40, 100], grantDelayMs, identityCostMs: 10, terminationCostMs: 25, cleanupGraceMs: 80 });
        expect(fixture.spawns).toHaveLength(1);
        expect(fixture.nativeRequests[0].timeout).toBe(40 - grantDelayMs);
        expect([...fixture.timers.values()].some(timer => timer.delay === 30 - grantDelayMs)).toBe(true);
        fixture.runNextTimer();
        expect(fixture.nativeRequests[1].timeout).toBe(60);
        const termination = fixture.nativeRequests.find(request => request.env?.CCC_WINDOWS_TERMINATE_PID);
        expect(termination?.timeout).toBe(50);
        expect(Number(termination?.env?.CCC_WINDOWS_TERMINATE_TIMEOUT_MS)).toBeGreaterThan(0);
        expect(Number(termination?.env?.CCC_WINDOWS_TERMINATE_TIMEOUT_MS)).toBeLessThanOrEqual(50);
        expect([...fixture.timers.values()].some(timer => timer.delay === 25)).toBe(true);
        fixture.runNextTimer();
        expect(fixture.result()).toMatchObject({ status: null, timedOut: true, cleanup: { attempted: true, ok: true } });
        expect(fixture.timers.size).toBe(0);
    });

    it("refuses a positive grant consumed by request-to-receive transport delay before any native work", () => {
        const fixture = generatedRunnerFixture({ admission: [40, 100], grantDelayMs: 41 });
        expect(fixture.spawns).toEqual([]);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.result()).toMatchObject({ status: null, timedOut: true });
    });

    it.each(["before-request", "after-grant"] as const)("prevents native spawn when admission is cancelled %s", cancel => {
        const fixture = generatedRunnerFixture({ admission: [40, 100], cancel });
        expect(fixture.spawns).toEqual([]);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.signals).toEqual([]);
        expect(fixture.result()).toMatchObject({ status: null, timedOut: true });
    });

    it("prevents dispatch when parent revocation wins the atomic claim race", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400], cancel: "before-claim" });
        expect(fixture.admission?.[0]).toBe(-1);
        expect(fixture.spawns).toEqual([]);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.result()).toMatchObject({ status: null, timedOut: true });
    });

    it("retains an in-flight dispatch claim until cancelled native spawn publishes its saved identity", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400], cancel: "during-spawn" });
        expect(fixture.dispatchStates).toEqual([4]);
        expect(fixture.control[2]).toBe(7001);
        expect(fixture.publishedIdentity()).toMatchObject({ pid: 7001, startToken: "windows:2026-10-02T02:11:08.7160248Z" });
        expect(fixture.admission?.[0]).toBe(5);
        expect(fixture.child.stdin.end).not.toHaveBeenCalled();
        for (let index = 0; index < 5 && !fixture.result(); index += 1) fixture.runNextTimer();
        expect(fixture.result()).toMatchObject({ timedOut: true });
    });

    it("acknowledges the dispatch claim when native spawn throws synchronously", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400], spawnError: true });
        expect(fixture.dispatchStates).toEqual([4]);
        expect(fixture.admission?.[0]).toBe(5);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.result()).toMatchObject({ status: null, error: expect.stringContaining("native-spawn-threw"), timedOut: false });
    });

    it.each([[0, 100], [40, 0], [-1, 100], [40, -1]])("refuses malformed admission durations %j", (command, completion) => {
        const fixture = generatedRunnerFixture({ admission: [command, completion] });
        expect(fixture.spawns).toEqual([]);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.result()?.status).toBeNull();
    });

    it.each([2, 3])("refuses a pre-existing or already consumed admission grant (%s)", admissionState => {
        const fixture = generatedRunnerFixture({ admission: [40, 100], admissionState });
        expect(fixture.spawns).toEqual([]);
        expect(fixture.nativeRequests).toEqual([]);
        expect(fixture.result()?.status).toBeNull();
    });

    it("does not grant cleanup authority to an identity observation that finishes after completion expiry", () => {
        const fixture = generatedRunnerFixture({ admission: [40, 45], identityCostMs: 10 });
        for (let index = 0; index < 5 && !fixture.result(); index += 1) fixture.runNextTimer();
        expect(fixture.nativeRequests[1].timeout).toBe(5);
        expect(fixture.nativeRequests.filter(request => request.env?.CCC_WINDOWS_TERMINATE_PID)).toEqual([]);
        expect(fixture.signals).toEqual([]);
        expect(fixture.result()).toMatchObject({ status: null, cleanup: { attempted: false, ok: false } });
    });

    it("refuses a late successful native close without losing observed output", () => {
        const fixture = generatedRunnerFixture();
        fixture.child.stdout.emit("data", Buffer.from("effect-observed"));
        fixture.advance(101);
        fixture.close(0);
        expect(fixture.result()).toMatchObject({ stdout: "effect-observed", timedOut: true });
    });

    it("keeps genuine native rejection primary when its close arrives after command expiry", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400], cleanupGraceMs: 200 });
        fixture.child.emit("error", new Error("native-spawn-rejected"));
        const firstFailure = fixture.failureBytes();
        expect(JSON.parse(firstFailure!.toString("utf8"))).toMatchObject({ error: expect.stringContaining("native-spawn-rejected") });
        fixture.child.stderr.emit("data", Buffer.from("x".repeat(32)));
        fixture.advance(101);
        fixture.runNextTimer();
        fixture.close(1);
        expect(fixture.result()).toMatchObject({ status: 1, error: expect.stringContaining("native-spawn-rejected"), timedOut: false });
        expect(fixture.failureBytes()).toEqual(firstFailure);
    });

    it("retains overflow while cleanup crosses command expiry and bounds final observation", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400], identityCostMs: 10, cleanupGraceMs: 200 });
        fixture.child.stdout.emit("data", Buffer.from("x".repeat(32)));
        const firstFailure = fixture.failureBytes();
        expect(JSON.parse(firstFailure!.toString("utf8"))).toMatchObject({ error: expect.stringContaining("ENOBUFS"), outputLimitExceeded: true });
        fixture.advance(150);
        fixture.runNextTimer();
        fixture.close(0);
        expect(fixture.result()).toMatchObject({ error: expect.stringContaining("ENOBUFS"), outputLimitExceeded: true, timedOut: false });
        expect(Buffer.byteLength(fixture.result().stdout)).toBe(16);
        expect(fixture.timers.size).toBe(0);
        expect(fixture.failureBytes()).toEqual(firstFailure);
    });

    it("publishes an early native exit once and preserves it while stdio delays close past command expiry", () => {
        const fixture = generatedRunnerFixture({ admission: [100, 400] });
        fixture.child.stdout.emit("data", Buffer.from("effect-observed"));
        fixture.advance(30);
        fixture.exit(7);
        const firstFailure = fixture.failureBytes();
        expect(JSON.parse(firstFailure!.toString("utf8"))).toEqual({ status: 7, signal: null });
        fixture.advance(70);
        fixture.runNextTimer();
        fixture.advance(1);
        fixture.close(7);
        expect(fixture.result()).toMatchObject({ status: 7, stdout: "effect-observed", timedOut: false });
        expect(fixture.result().error).toBeUndefined();
        expect(fixture.failureBytes()).toEqual(firstFailure);
        expect(fixture.timers.size).toBe(0);
    });

    it.each(["missing", "changed"])("refuses native termination for %s saved identity", kind => {
        const fixture = generatedRunnerFixture({ missingIdentity: kind === "missing", changedIdentity: kind === "changed" });
        fixture.runNextTimer();
        expect(fixture.nativeRequests.filter(request => request.env?.CCC_WINDOWS_TERMINATE_PID)).toEqual([]);
        expect(fixture.signals).toEqual([]);
        for (let index = 0; index < 5 && !fixture.result(); index += 1) fixture.runNextTimer();
        expect(fixture.result()).toMatchObject({ cleanup: { attempted: false, ok: false } });
    });

    it.each([false, true])("accounts real Worker startup before %s asynchronous invocation", async asynchronous => {
        const root = temporaryRoot();
        const readyFile = join(root, "startup-effect.ready");
        workerFixture.delayMs = 300;
        const command = {
            mode: "exec" as const, provider: "startup-allowance-provider", executable: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setTimeout(() => process.stdout.write('too-late'), 450);`],
            cwd: root,
        };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 650, outputLimit: 1024 })
            : defaultProviderCommandRunner(command, { timeoutMs: 650, outputLimit: 1024 });
        try {
            expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true });
            expect(result.stdout).not.toContain("too-late");
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it.each([false, true])("prevents a Worker admitted after command expiry from spawning (%s async)", async asynchronous => {
        const root = temporaryRoot();
        const effectFile = join(root, "forbidden-startup-effect");
        workerFixture.delayMs = 300;
        const command = {
            mode: "exec" as const, provider: "expired-admission-provider", executable: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effectFile)}, 'forbidden')`],
            cwd: root,
        };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 100, outputLimit: 1024 })
            : defaultProviderCommandRunner(command, { timeoutMs: 100, outputLimit: 1024 });
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true });
        expect(existsSync(effectFile)).toBe(false);
    });

    it("acknowledges readiness published after synchronous admission without repeatedly busy-waiting", () => {
        workerFixture.replacement = `
            const { workerData } = require('node:worker_threads');
            const control = new Int32Array(workerData.shared,0,4);
            const admission = new Int32Array(workerData.admissionShared,0,5);
            Atomics.store(admission,0,1);
            Atomics.notify(control,0);
            while (Atomics.load(admission,0) === 1) Atomics.wait(admission,0,1,1000);
            if (Atomics.compareExchange(admission,0,2,3) !== 2) throw new Error('test admission was not granted');
            Atomics.store(control,0,2);
            Atomics.notify(control,0);
            setTimeout(() => {
                const encoded=Buffer.from(JSON.stringify({status:0,stdout:'readiness-acknowledged',stderr:'',timedOut:false}));
                new Uint8Array(workerData.shared,16).set(encoded);
                Atomics.store(control,1,encoded.length); Atomics.store(control,0,1); Atomics.notify(control,0);
            },50);
        `;
        const actualWait = Atomics.wait;
        let staleReadinessWaits = 0;
        vi.spyOn(Atomics, "wait").mockImplementation(((array: Int32Array, index: number, expected: number, timeout?: number) => {
            if (expected === 0 && Atomics.load(array, index) === 2) staleReadinessWaits += 1;
            return actualWait(array, index, expected, timeout);
        }) as typeof Atomics.wait);
        const result = defaultProviderCommandRunner({
            mode: "exec", provider: "readiness-race-provider", executable: process.execPath, args: [],
        }, { timeoutMs: 2000, wrapperTimeoutMs: 2500, outputLimit: 32 });
        expect(result).toMatchObject({ status: 0, stdout: "readiness-acknowledged", timedOut: false });
        expect(staleReadinessWaits).toBeLessThanOrEqual(1);
    });

    it.runIf(process.platform !== "win32").each([false, true])("waits for in-flight identity publication under captured fallback time (%s async)", async asynchronous => {
        workerFixture.replacement = claimedWorkerScript(true);
        const remainingAtCleanup: number[] = [];
        backendNative.inspect = (expected, pid, nativeOptions) => {
            expect(expected).toMatchObject({ pid: 7101, startToken: "linux:100", commandHash: "a".repeat(64) });
            expect(pid).toBe(7101);
            remainingAtCleanup.push((nativeOptions as { remainingMs: () => number }).remainingMs());
            return { status: "match" };
        };
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const actualWait = Atomics.wait;
        const claimWaits: number[] = [];
        vi.spyOn(Atomics, "wait").mockImplementation(((array: Int32Array, index: number, expected: number, timeout?: number) => {
            if (array.buffer === workerFixture.data?.admissionShared && expected === 4) claimWaits.push(timeout!);
            return actualWait(array, index, expected, timeout);
        }) as typeof Atomics.wait);
        const command = { mode: "exec" as const, provider: "in-flight-publication-provider", executable: process.execPath, args: [] };
        let result;
        if (asynchronous) {
            let settled = false;
            const execution = defaultProviderCommandRunnerAsync(command, {
                timeoutMs: 30000, wrapperTimeoutMs: 1000, cleanupGraceMs: 50, outputLimit: 32,
            }).then(value => { settled = true; return value; });
            const until = Date.now() + 5000;
            while (Date.now() < until) {
                const admission = workerFixture.data && new Int32Array(workerFixture.data.admissionShared, 0, 5);
                if (admission?.[0] === 4 && admission[3] === 1) break;
                if (settled) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            const admission = new Int32Array(workerFixture.data!.admissionShared, 0, 5);
            expect(admission[0]).toBe(4);
            expect(admission[3]).toBe(1);
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(settled).toBe(false);
            expect(signal).not.toHaveBeenCalled();
            result = await execution;
            expect(claimWaits).toEqual([]);
        } else {
            result = defaultProviderCommandRunner(command, {
                timeoutMs: 30000, wrapperTimeoutMs: 1000, cleanupGraceMs: 50, outputLimit: 32,
            });
            expect(claimWaits.length).toBeGreaterThan(0);
            expect(claimWaits.every(duration => duration > 0 && duration <= 15050)).toBe(true);
        }
        expect(result).toMatchObject({
            timedOut: true, error: "device-lab provider wrapper timed out after 1000ms",
            cleanup: { pid: 7101, attempted: true, ok: true },
        });
        expect(remainingAtCleanup).toHaveLength(1);
        expect(remainingAtCleanup[0]).toBeGreaterThan(14000);
        expect(remainingAtCleanup[0]).toBeLessThan(15000);
        expect(signal).toHaveBeenCalledWith(-7101, "SIGKILL");
    });

    it.each([false, true])("keeps unresolved in-flight publication unconfirmed when captured fallback expires (%s async)", async asynchronous => {
        workerFixture.replacement = claimedWorkerScript(false);
        const actualNow = performance.now.bind(performance);
        let offset = 0;
        let exhausted = false;
        vi.spyOn(performance, "now").mockImplementation(() => {
            const admission = workerFixture.data && new Int32Array(workerFixture.data.admissionShared, 0, 5);
            if (!exhausted && admission?.[0] === 4 && admission[3] === 1) {
                exhausted = true;
                offset += 15051;
            }
            return actualNow() + offset;
        });
        const inspection = vi.fn(() => ({ status: "match" }));
        backendNative.inspect = inspection;
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const command = { mode: "exec" as const, provider: "unconfirmed-publication-provider", executable: process.execPath, args: [] };
        const startedAt = actualNow();
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 30000, wrapperTimeoutMs: 1000, cleanupGraceMs: 50, outputLimit: 32 })
            : defaultProviderCommandRunner(command, { timeoutMs: 30000, wrapperTimeoutMs: 1000, cleanupGraceMs: 50, outputLimit: 32 });
        expect(exhausted).toBe(true);
        expect(actualNow() - startedAt).toBeLessThan(2500);
        expect(result).toMatchObject({ timedOut: true, status: null, cleanup: { attempted: false, ok: false } });
        expect(inspection).not.toHaveBeenCalled();
        expect(signal).not.toHaveBeenCalled();
    });

    it.each([false, true])("keeps invalid Worker transport primary and fences malformed identity (%s async)", async asynchronous => {
        workerFixture.replacement = `
            const { workerData, parentPort } = require('node:worker_threads');
            const control = new Int32Array(workerData.shared, 0, 4);
            const identity = Buffer.from(JSON.stringify({pid:7003,startToken:'linux:100',commandHash:'invalid'}));
            new Uint8Array(workerData.identityShared).set(identity);
            Atomics.store(control,3,identity.length); Atomics.store(control,2,7003);
            new Uint8Array(workerData.shared,16).set(Buffer.from('{invalid'));
            Atomics.store(control,1,8); Atomics.store(control,0,1); Atomics.notify(control,0);
            parentPort.postMessage({done:true});
        `;
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const command = { mode: "exec" as const, provider: "invalid-transport-provider", executable: process.execPath, args: [] };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 1000, outputLimit: 16 })
            : defaultProviderCommandRunner(command, { timeoutMs: 1000, outputLimit: 16 });
        expect(result).toMatchObject({ status: null, error: "device-lab provider runner returned invalid output" });
        expect(result.timedOut).not.toBe(true);
        expect(signal).not.toHaveBeenCalled();
    });

    it.each([false, true])("rechecks late successful Worker transport at the parent boundary (%s async)", async asynchronous => {
        workerFixture.replacement = `
            const { workerData, parentPort } = require('node:worker_threads');
            setTimeout(() => {
                const control=new Int32Array(workerData.shared,0,4);
                const encoded=Buffer.from(JSON.stringify({status:0,stdout:'effect-observed',stderr:'',timedOut:false}));
                new Uint8Array(workerData.shared,16).set(encoded);
                Atomics.store(control,1,encoded.length); Atomics.store(control,0,1); Atomics.notify(control,0);
                parentPort.postMessage({done:true});
            },200);
        `;
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const command = { mode: "exec" as const, provider: "late-transport-provider", executable: process.execPath, args: [] };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 150, wrapperTimeoutMs: 1000, outputLimit: 32 })
            : defaultProviderCommandRunner(command, { timeoutMs: 150, wrapperTimeoutMs: 1000, outputLimit: 32 });
        expect(result).toMatchObject({ timedOut: true });
        expect(signal).not.toHaveBeenCalled();
    });

    it.each([false, true])("retains an established Worker failure through explicit wrapper expiry (%s async)", async asynchronous => {
        workerFixture.replacement = `
            const { workerData } = require('node:worker_threads');
            const failure = Buffer.from(JSON.stringify({error:'native-spawn-rejected',outputLimitExceeded:false}));
            new Uint8Array(workerData.admissionShared,20).set(failure);
            Atomics.store(new Int32Array(workerData.admissionShared,0,5),4,failure.length);
            setInterval(() => {},1000);
        `;
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const command = { mode: "exec" as const, provider: "primary-failure-provider", executable: process.execPath, args: [] };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 30000, wrapperTimeoutMs: 150, outputLimit: 16 })
            : defaultProviderCommandRunner(command, { timeoutMs: 30000, wrapperTimeoutMs: 150, outputLimit: 16 });
        expect(result.error).toMatch(/^native-spawn-rejected; device-lab provider wrapper timed out after 150ms/);
        expect(result.outputLimitExceeded).toBe(false);
        expect(signal).not.toHaveBeenCalled();
    });

    it.each([false, true])("uses only captured parent fallback time after a shorter wrapper expires (%s async)", async asynchronous => {
        workerFixture.replacement = `
            const { workerData } = require('node:worker_threads');
            const control = new Int32Array(workerData.shared,0,4);
            const identity=Buffer.from(JSON.stringify({pid:7004,startToken:'linux:100',commandHash:'${"a".repeat(64)}'}));
            new Uint8Array(workerData.identityShared).set(identity);
            Atomics.store(control,3,identity.length); Atomics.store(control,2,7004);
            setInterval(() => {},1000);
        `;
        const actualNow = performance.now.bind(performance);
        let offset = 0;
        vi.spyOn(performance, "now").mockImplementation(() => actualNow() + offset);
        const remainders: number[] = [];
        backendNative.inspect = (_expected, _pid, nativeOptions) => {
            const remainingMs = (nativeOptions as { remainingMs?: () => number }).remainingMs;
            remainders.push(remainingMs?.() ?? Number.NaN);
            offset += 14900;
            remainders.push(remainingMs?.() ?? Number.NaN);
            return { status: "match" };
        };
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const command = { mode: "exec" as const, provider: "captured-fallback-provider", executable: process.execPath, args: [] };
        const result = asynchronous
            ? await defaultProviderCommandRunnerAsync(command, { timeoutMs: 30000, wrapperTimeoutMs: 150, cleanupGraceMs: 50, outputLimit: 16 })
            : defaultProviderCommandRunner(command, { timeoutMs: 30000, wrapperTimeoutMs: 150, cleanupGraceMs: 50, outputLimit: 16 });
        expect(result).toMatchObject({ timedOut: true, error: "device-lab provider wrapper timed out after 150ms" });
        expect(remainders).toHaveLength(2);
        expect(remainders[0]).toBeGreaterThan(14800);
        expect(remainders[0]).toBeLessThanOrEqual(15050);
        expect(remainders[1]).toBeGreaterThan(0);
        expect(remainders[1]).toBeLessThanOrEqual(150);
        expect(signal).toHaveBeenCalledWith(-7004, "SIGKILL");
    });

    it("rejects percent expansion and line breaks in Windows command-shell arguments", () => {
        for (const unsafe of ["%PATH%", "safe\r\nwhoami", "safe\nwhoami"]) {
            expect(() => providerCommandSpawn({
                mode: "exec",
                provider: "test-provider",
                executable: "C:\\tools\\provider.cmd",
                args: [unsafe],
            }, "win32"), unsafe).toThrow(/windows-command-argument-(percent-expansion|newline)-rejected/);
            expect(() => windowsHiddenVbsLauncherScript("C:\\tools\\provider.exe", [unsafe]), unsafe)
                .toThrow(/windows-command-argument-(percent-expansion|newline)-rejected/);
        }
    });

    it("targets the POSIX process group instead of only the wrapper pid", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const cleanup = terminateBrokerSpawnedProcessTree(321, {
            platform: "linux",
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 321, platform: "linux" });
        expect(signals).toEqual([{ pid: -321, signal: "SIGKILL" }]);
    });

    it("requests recursive Windows tree termination", () => {
        const pids: number[] = [];
        const cleanup = terminateBrokerSpawnedProcessTree(654, {
            platform: "win32",
            terminateWindowsTree: (pid) => {
                pids.push(pid);
                return { attempted: true, ok: true };
            },
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 654, platform: "win32" });
        expect(pids).toEqual([654]);
    });

    it("passes the verified Windows start token into the default tree terminator", () => {
        const source = terminateBrokerSpawnedProcessTree.toString();
        expect(source).toContain("options.expectedIdentity?.startToken");
        expect(source).not.toContain("terminateWindowsProcessTree(value, undefined, true)");
    });

    it("refuses process-tree termination when the spawned process identity changed", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const expectedIdentity = { pid: 777, startToken: "linux:100", commandHash: "a".repeat(64) };
        const cleanup = terminateBrokerSpawnedProcessTree(777, {
            platform: "linux",
            expectedIdentity,
            requireIdentity: true,
            readIdentity: () => ({ ...expectedIdentity, startToken: "linux:200" }),
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: false, ok: false, pid: 777, error: "spawned-process-identity-mismatch" });
        expect(signals).toEqual([]);
    });

    it("terminates a process tree only after matching the spawned process identity", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const expectedIdentity = { pid: 778, startToken: "linux:100", commandHash: "b".repeat(64) };
        const cleanup = terminateBrokerSpawnedProcessTree(778, {
            platform: "linux",
            expectedIdentity,
            requireIdentity: true,
            readIdentity: () => expectedIdentity,
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 778 });
        expect(signals).toEqual([{ pid: -778, signal: "SIGKILL" }]);
    });

    it("prevents a backend descendant from performing late work after timeout", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "backend-descendant.ready");
        const result = await runBrokerBackendChild(descendantProbeScript(readyFile), "", {
            cwd: root,
            timeoutMs: 3000,
            outputLimit: 1024,
        });

        try {
            expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true, cleanup: { attempted: true, ok: true } });
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it("settles backend execution and reports cleanup failure when descendants retain stdio", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "backend-cleanup-failure.ready");
        const startedAt = Date.now();
        const result = await runBrokerBackendChild(stdioHoldingDescendantScript(readyFile), "", {
            cwd: root,
            timeoutMs: 1000,
            outputLimit: 1024,
            cleanupGraceMs: 50,
            terminateTree: (pid) => ({
                attempted: true,
                ok: false,
                pid: pid || 0,
                signal: "SIGKILL",
                platform: process.platform,
                error: "injected-tree-kill-failure",
            }),
        });
        const parentPid = Number(result.cleanup?.pid);
        try {
            expect(Date.now() - startedAt).toBeLessThan(5000);
            expect(result, JSON.stringify(result)).toMatchObject({
                timedOut: true,
                status: null,
                cleanup: { attempted: true, ok: false, error: "injected-tree-kill-failure" },
            });
            expect(result.error?.message).toContain("process-tree cleanup failed: injected-tree-kill-failure");
            expect(existsSync(readyFile)).toBe(true);
        } finally {
            await cleanupOwnedProcesses(readyFile, parentPid);
        }
    });

    it("prevents a provider descendant from surviving timeout cleanup on every platform", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-descendant.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, { timeoutMs: 3000, outputLimit: 1024 });

        try {
            expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true, cleanup: { attempted: true, ok: true } });
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it("cleans the live provider tree when the Worker wrapper itself times out", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-wrapper-timeout.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, {
            timeoutMs: 30000,
            wrapperTimeoutMs: 3000,
            outputLimit: 1024,
        });

        try {
            expect(result, JSON.stringify(result)).toMatchObject({
                timedOut: true,
                error: "device-lab provider wrapper timed out after 3000ms",
                cleanup: { attempted: true, ok: true },
            });
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it("identity-fences asynchronous provider cleanup when the Worker wrapper times out", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "async-provider-wrapper-timeout.ready");
        const result = await defaultProviderCommandRunnerAsync({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, {
            timeoutMs: 30000,
            wrapperTimeoutMs: 3000,
            outputLimit: 1024,
        });

        try {
            expect(result, JSON.stringify(result)).toMatchObject({
                timedOut: true,
                error: "device-lab provider wrapper timed out after 3000ms",
                cleanup: { attempted: true, ok: true },
            });
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it("terminates provider descendants when bounded output overflows", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-output-overflow.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", outputOverflowDescendantScript(readyFile, 64 * 1024)],
            cwd: root,
        }, { timeoutMs: 10000, outputLimit: 1024 });

        try {
            expect(result, JSON.stringify(result)).toMatchObject({
                timedOut: false,
                cleanup: { attempted: true, ok: true },
            });
            expect(result.error).toContain("ENOBUFS");
            expect(Buffer.byteLength(result.stdout || "")).toBeLessThanOrEqual(1024);
            await expectProcessTreeExit(readyFile);
        } finally {
            await cleanupOwnedProcesses(readyFile, result.cleanup?.pid);
        }
    });

    it("carries worst-case JSON-escaped output through the bounded shared transport", () => {
        const outputBytes = 30000;
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", `process.stdout.write('\\u0000'.repeat(${outputBytes}))`],
        }, { timeoutMs: 10000, outputLimit: outputBytes });

        expect(result, JSON.stringify(result)).toMatchObject({ status: 0, timedOut: false });
        expect(result.error).toBeUndefined();
        expect(Buffer.byteLength(result.stdout || "")).toBe(outputBytes);
        expect(result.stdout).toBe("\u0000".repeat(outputBytes));
    });
});
