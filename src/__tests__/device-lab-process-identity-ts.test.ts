import * as childProcess from "child_process";
import * as fileSystem from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as windowsSystem from "@ccc/device-lab/windows-system-powershell.js";
import {
    deviceRuntimeProcessIdentityMatches,
    inspectDeviceRuntimeProcessIdentity,
    inspectDeviceRuntimeProcessIdentityAsync,
    readDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessIdentityAsync,
    readDeviceRuntimeProcessStartToken,
    signalDeviceRuntimeProcess,
    signalDeviceRuntimeProcessAsync,
    windowsProcessIdentityScriptForTest,
} from "@ccc/device-lab/device-lab-process-identity.js";

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
}));
vi.mock("fs", async (importOriginal) => ({ ...await importOriginal<typeof import("fs")>() }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("@ccc/device-lab/windows-system-powershell.js")>(),
}));

afterEach(() => vi.restoreAllMocks());

const windowsStartToken = "2026-01-01T00:00:00.1234567Z";
const psStartToken = "Sat Oct 17 10:00:00 2026";

function successfulProbe(stdout: string): childProcess.SpawnSyncReturns<string> {
    return { pid: 321, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

function mockIdentityProbes(platform: "win32" | "darwin", afterProbe?: () => void) {
    vi.spyOn(windowsSystem, "canonicalWindowsPowerShellPath").mockReturnValue("trusted-powershell.exe");
    return vi.spyOn(childProcess, "spawnSync").mockImplementation(((_file: string, args: string[]) => {
        const output = platform === "win32"
            ? JSON.stringify({ startToken: windowsStartToken, commandLine: "owned-runtime --private-argument" })
            : args.at(-1) === "lstart=" ? psStartToken : "owned-runtime --private-argument";
        afterProbe?.();
        return successfulProbe(output);
    }) as typeof childProcess.spawnSync);
}

function probeTimeouts(spawn: ReturnType<typeof mockIdentityProbes>): unknown[] {
    return spawn.mock.calls.map((call) => (call[2] as childProcess.SpawnSyncOptions).timeout);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

function nextEventLoopTurn(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function mockDeferredIdentityCommands() {
    type Callback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
    const requests: Array<{ args: readonly string[]; options: childProcess.ExecFileOptions; complete: Callback }> = [];
    const execute = vi.spyOn(childProcess, "execFile").mockImplementation(((_file: string, args: readonly string[], options: childProcess.ExecFileOptions, complete: Callback) => {
        requests.push({ args, options, complete });
        return {} as childProcess.ChildProcess;
    }) as typeof childProcess.execFile);
    return { execute, requests };
}

describe("broker device runtime process identity", () => {
    it("reads a stable hashed identity without exposing the command line", () => {
        const first = readDeviceRuntimeProcessIdentity(process.pid);
        const second = readDeviceRuntimeProcessIdentity(process.pid);
        expect(first).toEqual(expect.objectContaining({ pid: process.pid }));
        expect(first?.commandHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first).not.toHaveProperty("commandLine");
        expect(deviceRuntimeProcessIdentityMatches(first, second)).toBe(true);
    });

    it("reads a stable process start token independently of command visibility", () => {
        const first = readDeviceRuntimeProcessStartToken(process.pid);
        const second = readDeviceRuntimeProcessStartToken(process.pid);
        expect(first).toBeTruthy();
        expect(second).toBe(first);
        expect(readDeviceRuntimeProcessStartToken(-1)).toBeNull();
    });

    it("uses the acquired Windows process handle as the canonical start-token source", () => {
        const script = windowsProcessIdentityScriptForTest(321);
        expect(script).toContain("$H = Get-Process -Id 321");
        expect(script).toContain("startToken = $H.StartTime.ToUniversalTime().ToString('o')");
        expect(script).toContain("commandLine = [string]$P.CommandLine");
        expect(script).not.toContain("startToken = $P.CreationDate");
    });

    it("refuses to signal a reused pid", () => {
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "old", commandHash: "same" },
        }, "SIGINT", {
            readIdentity: () => ({ pid: 42, startToken: "new", commandHash: "same" }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-mismatch" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("treats an exited owned runtime as safely stale", () => {
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({
            runtimeId: "runtime-1",
            pid: 42,
            processIdentity: { pid: 42, startToken: "old", commandHash: "same" },
        }, "SIGINT", { readIdentity: () => null, probeLiveness: () => "exited", kill });
        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: true, stale: true, reason: "runtime-process-exited" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("preserves a live runtime when process identity lookup is unavailable", () => {
        const identity = { pid: 42, startToken: "same", commandHash: "same" };
        const observation = inspectDeviceRuntimeProcessIdentity(identity, 42, {
            readIdentity: () => null,
            probeLiveness: () => "alive",
        });
        expect(observation).toEqual({ status: "unavailable", current: null, liveness: "alive" });

        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity: identity }, "SIGINT", {
            readIdentity: () => null,
            probeLiveness: () => "alive",
            kill,
        });
        expect(result).toEqual(expect.objectContaining({
            attempted: false,
            ok: false,
            reason: "runtime-process-identity-unavailable",
        }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("signals an exact runtime identity", () => {
        const processIdentity = { pid: 42, startToken: "same", commandHash: "same" };
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-1", pid: 42, processIdentity }, "SIGTERM", {
            readIdentity: () => ({ ...processIdentity }),
            kill,
        });
        expect(result).toEqual(expect.objectContaining({ attempted: true, ok: true, pid: 42, signal: "SIGTERM" }));
        expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
    });
});

describe("native process identity remaining allowance", () => {
    it.runIf(process.platform === "linux").each([false, true])("classifies completed late default identity from Linux proc files (mismatch=%s)", mismatch => {
        const actual = readDeviceRuntimeProcessIdentity(process.pid)!;
        expect(actual).toBeTruthy();
        let remaining = 37.9;
        const nativeRead = fileSystem.readFileSync;
        const read = vi.spyOn(fileSystem, "readFileSync").mockImplementation(((...args: Parameters<typeof nativeRead>) => {
            const output = nativeRead(...args);
            if (String(args[0]) === `/proc/${process.pid}/stat`) remaining = 0;
            return output;
        }) as typeof nativeRead);
        const expected = mismatch ? { ...actual, startToken: "previous-process-birth" } : actual;
        const probeLiveness = vi.fn(() => "alive" as const);
        expect(inspectDeviceRuntimeProcessIdentity(expected, process.pid, { remainingMs: () => remaining, probeLiveness }))
            .toEqual(mismatch ? { status: "mismatch", current: actual, liveness: "alive" } : { status: "unavailable", current: null, liveness: "unknown" });
        expect(probeLiveness).not.toHaveBeenCalled();
        remaining = 37.9;
        expect(readDeviceRuntimeProcessIdentity(process.pid, { remainingMs: () => remaining })).toBeNull();
        read.mockClear();
        expect(inspectDeviceRuntimeProcessIdentity(expected, process.pid, { remainingMs: () => remaining, probeLiveness }).status).toBe("unavailable");
        expect(read).not.toHaveBeenCalled();
    });

    it.each([
        { platform: "win32", mismatch: false }, { platform: "win32", mismatch: true },
        { platform: "darwin", mismatch: false }, { platform: "darwin", mismatch: true },
    ] as const)("classifies completed late default identity on $platform (mismatch=$mismatch)", ({ platform, mismatch }) => {
        let remaining = 37.9, observations = 0, expire = false;
        const spawn = mockIdentityProbes(platform, () => {
            if (expire && ++observations === (platform === "win32" ? 1 : 2)) remaining = 0;
        });
        const actual = readDeviceRuntimeProcessIdentity(321, { platform })!;
        expect(actual).toBeTruthy();
        spawn.mockClear();
        expire = true;
        const expected = mismatch ? { ...actual, startToken: "previous-process-birth" } : actual;
        const probeLiveness = vi.fn(() => "alive" as const);

        expect(inspectDeviceRuntimeProcessIdentity(expected, 321, { platform, remainingMs: () => remaining, probeLiveness }))
            .toEqual(mismatch ? { status: "mismatch", current: actual, liveness: "alive" } : { status: "unavailable", current: null, liveness: "unknown" });
        expect(probeTimeouts(spawn)).toEqual(platform === "win32" ? [37] : [37, 37]);
        expect(probeLiveness).not.toHaveBeenCalled();

        remaining = 37.9; observations = 0; spawn.mockClear();
        expect(readDeviceRuntimeProcessIdentity(321, { platform, remainingMs: () => remaining })).toBeNull();
        expect(probeTimeouts(spawn)).toEqual(platform === "win32" ? [37] : [37, 37]);
    });

    it("does not dispatch a second default identity probe after the first consumes the allowance", () => {
        let remaining = 37.9;
        const spawn = mockIdentityProbes("darwin", () => { remaining = 0; });
        const probeLiveness = vi.fn(() => "alive" as const);
        expect(inspectDeviceRuntimeProcessIdentity({ pid: 321, startToken: "saved", commandHash: "saved" }, 321,
            { platform: "darwin", remainingMs: () => remaining, probeLiveness }))
            .toEqual({ status: "unavailable", current: null, liveness: "unknown" });
        expect(probeTimeouts(spawn)).toEqual([37]);
        expect(probeLiveness).not.toHaveBeenCalled();
    });

    it.each(["win32", "darwin"] as const)("preserves omitted-budget probe limits on %s", (platform) => {
        const spawn = mockIdentityProbes(platform);
        if (platform === "win32") spawn.mockReturnValueOnce(successfulProbe(windowsStartToken));

        expect(readDeviceRuntimeProcessStartToken(321, { platform })).toBe(
            platform === "win32" ? `windows:${windowsStartToken}` : `ps:${psStartToken}`,
        );
        expect(readDeviceRuntimeProcessIdentity(321, { platform })).toEqual(expect.objectContaining({
            pid: 321,
            startToken: platform === "win32" ? `windows:${windowsStartToken}` : `ps:${psStartToken}`,
            commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        expect(probeTimeouts(spawn)).toEqual(platform === "win32" ? [5000, 5000] : [5000, 5000, 5000]);
    });

    it.each(["win32", "darwin"] as const)("floors a positive fractional probe allowance on %s", (platform) => {
        const spawn = mockIdentityProbes(platform);
        if (platform === "win32") spawn.mockReturnValueOnce(successfulProbe(windowsStartToken));
        const options = { platform, remainingMs: () => 37.9 };

        expect(readDeviceRuntimeProcessStartToken(321, options)).toBeTruthy();
        expect(readDeviceRuntimeProcessIdentity(321, options)).toEqual(expect.objectContaining({ pid: 321 }));
        expect(probeTimeouts(spawn)).toEqual(platform === "win32" ? [37, 37] : [37, 37, 37]);
    });

    it.each(["win32", "darwin"] as const)("retains native probe caps for a larger supplied allowance on %s", (platform) => {
        const spawn = mockIdentityProbes(platform);

        expect(readDeviceRuntimeProcessIdentity(321, { platform, remainingMs: () => 60_000 })).toBeTruthy();
        expect(probeTimeouts(spawn)).toEqual(platform === "win32" ? [5000] : [5000, 5000]);
    });

    it("shares the Windows allowance across successive token and identity observations", () => {
        let remaining = 120.9;
        const spawn = mockIdentityProbes("win32", () => { remaining = 42.8; });
        spawn.mockImplementationOnce(() => {
            remaining = 42.8;
            return successfulProbe(windowsStartToken);
        });
        const options = { platform: "win32" as const, remainingMs: () => remaining };

        expect(readDeviceRuntimeProcessStartToken(321, options)).toBe(`windows:${windowsStartToken}`);
        expect(readDeviceRuntimeProcessIdentity(321, options)?.startToken).toBe(`windows:${windowsStartToken}`);
        expect(probeTimeouts(spawn)).toEqual([120, 42]);
    });

    it("shares one allowance between the Darwin command and start-token probes", () => {
        let remaining = 120.9;
        const spawn = mockIdentityProbes("darwin", () => { remaining = 42.8; });

        expect(readDeviceRuntimeProcessIdentity(321, { platform: "darwin", remainingMs: () => remaining }))
            .toEqual(expect.objectContaining({ pid: 321, startToken: `ps:${psStartToken}` }));
        expect(probeTimeouts(spawn)).toEqual([120, 42]);
    });

    it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "refuses a present unusable allowance (%s) without native observation or signal",
        (remaining) => {
            const spawn = mockIdentityProbes("win32");
            const readIdentity = vi.fn(() => ({ pid: 321, startToken: "saved", commandHash: "saved" }));
            const probeLiveness = vi.fn(() => "exited" as const);
            const kill = vi.fn();
            const remainingMs = () => remaining;

            for (const platform of ["win32", "darwin"] as const) {
                expect(readDeviceRuntimeProcessStartToken(321, { platform, remainingMs })).toBeNull();
                expect(readDeviceRuntimeProcessIdentity(321, { platform, remainingMs })).toBeNull();
            }
            const processIdentity = { pid: 321, startToken: "saved", commandHash: "saved" };
            expect(inspectDeviceRuntimeProcessIdentity(processIdentity, 321, { remainingMs, readIdentity, probeLiveness }))
                .toEqual(expect.objectContaining({ status: "unavailable", current: null }));
            expect(signalDeviceRuntimeProcess({ runtimeId: "runtime-321", pid: 321, processIdentity }, "SIGTERM", {
                remainingMs, readIdentity, probeLiveness, kill,
            })).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
            expect(spawn).not.toHaveBeenCalled();
            expect(readIdentity).not.toHaveBeenCalled();
            expect(probeLiveness).not.toHaveBeenCalled();
            expect(kill).not.toHaveBeenCalled();
        },
    );

    it.each(["win32", "darwin"] as const)("rejects native success observed after expiry on %s", (platform) => {
        let remaining = 50.9;
        const spawn = mockIdentityProbes(platform, () => { remaining = 0; });
        if (platform === "win32") spawn.mockImplementationOnce(() => {
            remaining = 0;
            return successfulProbe(windowsStartToken);
        });
        const options = { platform, remainingMs: () => remaining };

        expect(readDeviceRuntimeProcessStartToken(321, options)).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
        spawn.mockClear();
        remaining = 50.9;
        expect(readDeviceRuntimeProcessIdentity(321, options)).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(probeTimeouts(spawn)).toEqual([50]);
    });

    it("rejects a Darwin identity whose second successful probe exhausts the allowance", () => {
        let remaining = 80.9;
        let observations = 0;
        const spawn = mockIdentityProbes("darwin", () => { remaining = ++observations === 1 ? 25.7 : 0; });

        expect(readDeviceRuntimeProcessIdentity(321, { platform: "darwin", remainingMs: () => remaining })).toBeNull();
        expect(probeTimeouts(spawn)).toEqual([80, 25]);
    });

    it("refuses authority from an injected identity read that finishes after expiry", () => {
        let remaining = 80;
        const processIdentity = { pid: 321, startToken: "saved", commandHash: "saved" };
        const readIdentity = vi.fn(() => { remaining = 0; return { ...processIdentity }; });
        const probeLiveness = vi.fn(() => "exited" as const);
        const kill = vi.fn();
        const options = { remainingMs: () => remaining, readIdentity, probeLiveness, kill };

        expect(inspectDeviceRuntimeProcessIdentity(processIdentity, 321, options))
            .toEqual(expect.objectContaining({ status: "unavailable", current: null }));
        remaining = 80;
        expect(signalDeviceRuntimeProcess({ runtimeId: "runtime-321", pid: 321, processIdentity }, "SIGTERM", options))
            .toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(probeLiveness).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
    });

    it("refuses signaling when the allowance expires after matching revalidation", () => {
        let identityObserved = false;
        let observationsAfterIdentity = 0;
        const processIdentity = { pid: 321, startToken: "saved", commandHash: "saved" };
        const readIdentity = vi.fn(() => {
            identityObserved = true;
            return { ...processIdentity };
        });
        const remainingMs = () => {
            if (!identityObserved) return 80;
            return ++observationsAfterIdentity === 1 ? 80 : 0;
        };
        const kill = vi.fn();

        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-321", pid: 321, processIdentity }, "SIGTERM", {
            remainingMs, readIdentity, kill,
        });

        expect(readIdentity).toHaveBeenCalledTimes(1);
        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("preserves an observed identity mismatch when revalidation also exhausts the allowance", () => {
        let remaining = 80;
        const processIdentity = { pid: 321, startToken: "saved", commandHash: "saved" };
        const reusedIdentity = { ...processIdentity, startToken: "reused" };
        const readIdentity = vi.fn(() => { remaining = 0; return reusedIdentity; });
        const probeLiveness = vi.fn(() => "exited" as const);
        const kill = vi.fn();
        const options = { remainingMs: () => remaining, readIdentity, probeLiveness, kill };

        expect(inspectDeviceRuntimeProcessIdentity(processIdentity, 321, options))
            .toEqual(expect.objectContaining({ status: "mismatch", current: reusedIdentity }));
        remaining = 80;
        expect(signalDeviceRuntimeProcess({ runtimeId: "runtime-321", pid: 321, processIdentity }, "SIGTERM", options))
            .toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-mismatch" }));
        expect(probeLiveness).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
    });

    it("does not report exit from a liveness observation completed after expiry", () => {
        let remaining = 80;
        const processIdentity = { pid: 321, startToken: "saved", commandHash: "saved" };
        const kill = vi.fn();
        const result = signalDeviceRuntimeProcess({ runtimeId: "runtime-321", pid: 321, processIdentity }, "SIGTERM", {
            remainingMs: () => remaining,
            readIdentity: () => null,
            probeLiveness: () => { remaining = 0; return "exited"; },
            kill,
        });

        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(kill).not.toHaveBeenCalled();
    });
});

describe("asynchronous broker process identity", () => {
    const processIdentity = { pid: 321, startToken: "saved-birth", commandHash: "saved-hash" };
    const runtime = { runtimeId: "runtime-321", pid: 321, processIdentity };

    it.each([false, true])("awaits the default Linux proc read and charges its elapsed allowance (expired=%s)", async expired => {
        const command = deferred<Buffer>();
        const fields = Array<string>(20).fill("0");
        fields[0] = "S";
        fields[19] = "123";
        const readFile = vi.spyOn(fileSystem.promises, "readFile").mockImplementation(((path: unknown) => {
            return String(path) === "/proc/321/cmdline" ? command.promise : Promise.resolve(`321 (owned runtime) ${fields.join(" ")}`);
        }) as typeof fileSystem.promises.readFile);
        const synchronousRead = vi.spyOn(fileSystem, "readFileSync");
        let remaining = 80;
        let settled = false;
        const pending = readDeviceRuntimeProcessIdentityAsync(321, { platform: "linux", remainingMs: () => remaining })
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(readFile).toHaveBeenCalledTimes(1);
        expect(readFile.mock.calls[0][0]).toBe("/proc/321/cmdline");
        if (expired) remaining = 0;
        command.resolve(Buffer.from("owned-runtime\0--private-argument\0"));

        const actual = await pending;
        if (expired) {
            expect(actual).toBeNull();
            expect(readFile).toHaveBeenCalledTimes(1);
        } else {
            expect(actual).toEqual(expect.objectContaining({ pid: 321, startToken: "linux:123", commandHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
            expect(actual).not.toHaveProperty("commandLine");
            expect(readFile).toHaveBeenCalledTimes(2);
            expect(readFile.mock.calls[1][0]).toBe("/proc/321/stat");
        }
        expect(synchronousRead.mock.calls.filter(call => String(call[0]).startsWith("/proc/321/"))).toEqual([]);
    });

    it("awaits a native Windows identity command while the event loop continues", async () => {
        vi.spyOn(windowsSystem, "canonicalWindowsPowerShellPathAsync").mockResolvedValue("trusted-powershell.exe");
        const synchronousProbe = vi.spyOn(childProcess, "spawnSync");
        const { execute, requests } = mockDeferredIdentityCommands();
        let settled = false;
        const pending = readDeviceRuntimeProcessIdentityAsync(321, { platform: "win32", remainingMs: () => 37.9 })
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(requests).toHaveLength(1);
        expect(settled).toBe(false);
        expect(synchronousProbe).not.toHaveBeenCalled();
        expect(execute.mock.calls[0][0]).toBe("trusted-powershell.exe");
        expect(requests[0].options).toEqual(expect.objectContaining({
            timeout: 37, windowsHide: true, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        }));
        expect(requests[0].args).toContain(windowsProcessIdentityScriptForTest(321));

        requests[0].complete(null, JSON.stringify({ startToken: windowsStartToken, commandLine: "owned-runtime --private-argument" }), "");
        const actual = await pending;
        expect(actual).toEqual(expect.objectContaining({ pid: 321, startToken: `windows:${windowsStartToken}`, commandHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
        expect(actual).not.toHaveProperty("commandLine");
    });

    it("charges sequential Darwin commands to the same parent allowance", async () => {
        const { requests } = mockDeferredIdentityCommands();
        let remaining = 80.9;
        let settled = false;
        const pending = readDeviceRuntimeProcessIdentityAsync(321, { platform: "darwin", remainingMs: () => remaining })
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(requests).toHaveLength(1);
        expect(requests[0].options.timeout).toBe(80);
        expect(settled).toBe(false);
        remaining = 25.7;
        requests[0].complete(null, requests[0].args.at(-1) === "lstart=" ? psStartToken : "owned-runtime", "");
        await nextEventLoopTurn();
        expect(requests).toHaveLength(2);
        expect(requests[1].options.timeout).toBe(25);
        expect(settled).toBe(false);
        requests[1].complete(null, requests[1].args.at(-1) === "lstart=" ? psStartToken : "owned-runtime", "");

        expect(await pending).toEqual(expect.objectContaining({ pid: 321, startToken: `ps:${psStartToken}` }));
    });

    it("does not dispatch another Darwin command after a deferred probe spends the allowance", async () => {
        const { requests } = mockDeferredIdentityCommands();
        let remaining = 80;
        const pending = readDeviceRuntimeProcessIdentityAsync(321, { platform: "darwin", remainingMs: () => remaining });
        await nextEventLoopTurn();
        expect(requests).toHaveLength(1);
        remaining = 0;
        requests[0].complete(null, requests[0].args.at(-1) === "lstart=" ? psStartToken : "owned-runtime", "");

        expect(await pending).toBeNull();
        expect(requests).toHaveLength(1);
    });

    it("does not grant identity authority when a deferred reader finishes after expiry", async () => {
        const gate = deferred<typeof processIdentity | null>();
        let remaining = 80;
        const readIdentity = vi.fn(() => gate.promise);
        const pending = readDeviceRuntimeProcessIdentityAsync(321, { readIdentity, remainingMs: () => remaining });
        await nextEventLoopTurn();
        expect(readIdentity).toHaveBeenCalledWith(321);
        remaining = 0;
        gate.resolve({ ...processIdentity });
        expect(await pending).toBeNull();
    });

    it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "refuses unusable async parent allowance %s before native observation or signalling",
        async remaining => {
            const execute = vi.spyOn(childProcess, "execFile");
            const readIdentity = vi.fn(async () => ({ ...processIdentity }));
            const kill = vi.fn();
            const probeLiveness = vi.fn(() => "exited" as const);
            const options = { remainingMs: () => remaining, readIdentity, kill, probeLiveness };

            expect(await readDeviceRuntimeProcessIdentityAsync(321, { platform: "darwin", remainingMs: () => remaining })).toBeNull();
            expect(await readDeviceRuntimeProcessIdentityAsync(321, options)).toBeNull();
            expect(await inspectDeviceRuntimeProcessIdentityAsync(processIdentity, 321, options))
                .toEqual({ status: "unavailable", current: null, liveness: "unknown" });
            expect(await signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", options))
                .toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
            expect(execute).not.toHaveBeenCalled();
            expect(readIdentity).not.toHaveBeenCalled();
            expect(probeLiveness).not.toHaveBeenCalled();
            expect(kill).not.toHaveBeenCalled();
        },
    );

    it("waits for identity observation before the exact runtime can be signalled", async () => {
        const gate = deferred<typeof processIdentity | null>();
        const readIdentity = vi.fn(() => gate.promise);
        const kill = vi.fn();
        let settled = false;
        const pending = signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", { readIdentity, kill })
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(readIdentity).toHaveBeenCalledTimes(1);
        expect(kill).not.toHaveBeenCalled();
        gate.resolve({ ...processIdentity });

        expect(await pending).toEqual(expect.objectContaining({ attempted: true, ok: true, pid: 321, signal: "SIGTERM" }));
        expect(kill).toHaveBeenCalledExactlyOnceWith(321, "SIGTERM");
    });

    it.each([false, true])("preserves a deferred reused-pid mismatch when allowance also expires=%s", async expire => {
        const gate = deferred<typeof processIdentity | null>();
        let remaining = 80;
        const kill = vi.fn();
        const probeLiveness = vi.fn(() => "exited" as const);
        const pending = signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", {
            readIdentity: () => gate.promise, remainingMs: () => remaining, kill, probeLiveness,
        });
        await nextEventLoopTurn();
        if (expire) remaining = 0;
        const reusedIdentity = { ...processIdentity, startToken: "replacement-birth" };
        gate.resolve(reusedIdentity);

        expect(await pending).toEqual(expect.objectContaining({
            attempted: false, ok: false, reason: "runtime-process-identity-mismatch",
            observation: { status: "mismatch", current: reusedIdentity, liveness: "alive" },
        }));
        expect(kill).not.toHaveBeenCalled();
        expect(probeLiveness).not.toHaveBeenCalled();
    });

    it.each(["alive", "unknown", "exited"] as const)("retains conservative %s liveness after a deferred unavailable identity", async liveness => {
        const gate = deferred<typeof processIdentity | null>();
        const probeLiveness = vi.fn(() => liveness);
        const kill = vi.fn();
        const pending = signalDeviceRuntimeProcessAsync(runtime, "SIGINT", { readIdentity: () => gate.promise, probeLiveness, kill });
        await nextEventLoopTurn();
        expect(probeLiveness).not.toHaveBeenCalled();
        gate.resolve(null);

        expect(await pending).toEqual(expect.objectContaining(liveness === "exited"
            ? { attempted: false, ok: true, stale: true, reason: "runtime-process-exited" }
            : { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(probeLiveness).toHaveBeenCalledExactlyOnceWith(321);
        expect(kill).not.toHaveBeenCalled();
    });

    it("refuses a deferred exact match whose parent allowance has already expired", async () => {
        const gate = deferred<typeof processIdentity | null>();
        let remaining = 80;
        const kill = vi.fn();
        const probeLiveness = vi.fn(() => "exited" as const);
        const pending = signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", {
            readIdentity: () => gate.promise, remainingMs: () => remaining, kill, probeLiveness,
        });
        await nextEventLoopTurn();
        remaining = 0;
        gate.resolve({ ...processIdentity });

        expect(await pending).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(kill).not.toHaveBeenCalled();
        expect(probeLiveness).not.toHaveBeenCalled();
    });

    it("checks the allowance again immediately before signalling a matching observation", async () => {
        let identityObserved = false;
        let checksAfterObservation = 0;
        const kill = vi.fn();
        const result = await signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", {
            readIdentity: async () => { identityObserved = true; return { ...processIdentity }; },
            remainingMs: () => !identityObserved || ++checksAfterObservation === 1 ? 80 : 0,
            kill,
        });

        expect(result).toEqual(expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }));
        expect(kill).not.toHaveBeenCalled();
    });

    it("rechecks current authority in the signal closure after the deferred observation", async () => {
        const gate = deferred<typeof processIdentity | null>();
        let stillCurrent = true;
        const nativeKill = vi.fn();
        const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
            if (!stillCurrent) throw new Error("runtime-authority-changed");
            nativeKill(pid, signal);
        });
        const pending = signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", { readIdentity: () => gate.promise, kill });
        await nextEventLoopTurn();
        expect(kill).not.toHaveBeenCalled();
        stillCurrent = false;
        gate.resolve({ ...processIdentity });

        expect(await pending).toEqual(expect.objectContaining({ attempted: true, ok: false, error: "runtime-authority-changed" }));
        expect(kill).toHaveBeenCalledExactlyOnceWith(321, "SIGTERM");
        expect(nativeKill).not.toHaveBeenCalled();
    });
});
