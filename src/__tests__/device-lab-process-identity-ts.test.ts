import * as childProcess from "child_process";
import * as fileSystem from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as windowsSystem from "@ccc/device-lab/windows-system-powershell.js";
import {
    deviceRuntimeProcessIdentityMatches,
    inspectDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessStartToken,
    signalDeviceRuntimeProcess,
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
        spawn.mockImplementationOnce((() => {
            remaining = 42.8;
            return successfulProbe(windowsStartToken);
        }) as typeof childProcess.spawnSync);
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
        if (platform === "win32") spawn.mockImplementationOnce((() => {
            remaining = 0;
            return successfulProbe(windowsStartToken);
        }) as typeof childProcess.spawnSync);
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
