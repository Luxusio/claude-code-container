import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";

afterEach(() => {
    vi.doUnmock("child_process");
    vi.doUnmock("../../container-runtime.js");
    vi.restoreAllMocks();
    vi.resetModules();
});

function result(status: number | null = 0, stdout = ""): SpawnSyncReturns<string> {
    return { status, stdout, stderr: "", pid: 1, output: [], signal: null };
}

// Native evidence can contain values beyond its static Error/status declaration.
function readiness(status: number | null | undefined, error?: unknown): SpawnSyncReturns<string> {
    return { ...result(), status, error } as SpawnSyncReturns<string>;
}

async function loadFacade() {
    const spawn = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
    const exec = vi.fn(() => { throw new Error("unexpected native exec"); });
    vi.doMock("child_process", async importOriginal => ({
        ...await importOriginal<object>(), spawnSync: (...args: unknown[]) => spawn(...normalizeNativeRuntimeCall(args)), execSync: exec,
    }));
    vi.doMock("../../container-runtime.js", async importOriginal => ({
        ...await importOriginal<typeof import("../../container-runtime.js")>(),
        // Runtime facts are preloaded below; keep this facade focused on setup commands.
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation(),
    }));
    vi.resetModules();
    const setup = await import("../../container-setup.js");
    const runtime = await import("../../container-runtime.js");
    const registry = await import("../../tool-registry.js");
    return { setup, runtime, registry, spawn, exec };
}

describe("requested tool setup production facade", () => {
    it("imports without executing native commands", async () => {
        const { spawn, exec } = await loadFacade();
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
    });

    it.each(["claude", "codex"])("uses the current native runtime for %s setup and readiness", async name => {
        const { setup, runtime, registry, spawn, exec } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "podman" });
        const target = "target with spaces";
        const descriptor = registry.getToolByName(name)!;
        spawn.mockImplementation(() => result(0, name === "claude" ? "VALID\n" : ""));
        try {
            expect(setup.ensureTools(target, descriptor)).toBeUndefined();
            expect(spawn.mock.calls[0][0]).toBe("podman");
            expect(spawn.mock.calls[0][1]).toEqual(name === "claude"
                ? ["exec", target, "sh", "-c", expect.stringContaining(setup.CLAUDE_BIN_PATH)]
                : ["exec", target, "sh", "-c", "[ -x /home/ccc/.local/bin/codex ] || echo codex"]);
            const launcherPath = name === "claude" ? setup.CLAUDE_BIN_PATH : "/home/ccc/.local/bin/codex";
            expect(spawn).toHaveBeenCalledWith("podman", ["exec", target, "test", "-x", launcherPath],
                { stdio: "ignore", timeout: 15000 });
            expect(spawn.mock.calls.filter(([, args]) => (args as string[])[2] === "test")).toHaveLength(1);
            if (name === "codex") {
                expect(spawn).toHaveBeenCalledWith("podman", ["exec", target, "timeout", "-k", "2s", "8s", "sh", "-c",
                    "command -v bwrap >/dev/null 2>&1 || exit 42; exec bwrap --version"],
                { stdio: "ignore", timeout: 15000 });
            }
            expect(spawn).toHaveBeenCalledTimes(name === "claude" ? 2 : 3);
            expect(exec).not.toHaveBeenCalled();
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it.each([
        { name: "nonzero exit", observation: readiness(1), timeout: false },
        { name: "exit 124", observation: readiness(124), timeout: false },
        { name: "exit 137", observation: readiness(137), timeout: false },
        { name: "null status", observation: readiness(null), timeout: false },
        { name: "absent status", observation: readiness(undefined), timeout: false },
        { name: "zero exit with native error", observation: readiness(0, { code: "EIO" }), timeout: false },
        { name: "zero exit with another truthy error", observation: readiness(0, "native failure"), timeout: false },
        { name: "different timeout-code case", observation: readiness(0, { code: "etimedout" }), timeout: false },
        { name: "native timeout", observation: readiness(null, { code: "ETIMEDOUT" }), timeout: true },
        { name: "native timeout with zero exit", observation: readiness(0, { code: "ETIMEDOUT" }), timeout: true },
    ])("classifies $name and stops after one native readiness probe", async ({ observation, timeout }) => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        spawn.mockReturnValueOnce(result()).mockReturnValueOnce(observation);
        try {
            expect(() => setup.ensureTools("target", registry.getToolByName("codex")!)).toThrow(timeout
                ? "Requested tool codex readiness check timed out" : "Requested tool codex is unavailable after setup");
            expect(spawn.mock.calls[1]).toEqual(["docker", ["exec", "target", "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: 15000 }]);
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it.each([undefined, null, false, 0, ""])("accepts zero exit with falsey error %j before preparing the Codex sandbox", async error => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        spawn.mockReturnValueOnce(result()).mockReturnValueOnce(readiness(0, error)).mockReturnValueOnce(result());
        try {
            expect(setup.ensureTools("target", registry.getToolByName("codex")!)).toBeUndefined();
            expect(spawn.mock.calls[1]).toEqual(["docker", ["exec", "target", "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: 15000 }]);
            expect(spawn.mock.calls[2]).toEqual(["docker", ["exec", "target", "timeout", "-k", "2s", "8s", "sh", "-c",
                "command -v bwrap >/dev/null 2>&1 || exit 42; exec bwrap --version"],
            { stdio: "ignore", timeout: 15000 }]);
            expect(spawn).toHaveBeenCalledTimes(3);
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it("uses the original descriptor's tool name after the failed native probe", async () => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        const descriptor = { ...registry.getToolByName("codex")! };
        spawn.mockReturnValueOnce(result()).mockImplementationOnce(() => {
            descriptor.name = "renamed-tool";
            return result(1);
        });
        try {
            expect(() => setup.ensureTools("target", descriptor)).toThrow("Requested tool renamed-tool is unavailable after setup");
            expect(spawn.mock.calls[1]).toEqual(["docker", ["exec", "target", "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: 15000 }]);
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it("propagates an unexpected native readiness exception unchanged without another command", async () => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        const failure = new Error("unexpected native readiness fault");
        spawn.mockReturnValueOnce(result()).mockImplementationOnce(() => { throw failure; });
        try {
            let caught: unknown;
            try { setup.ensureTools("target", registry.getToolByName("codex")!); } catch (error) { caught = error; }
            expect(caught).toBe(failure);
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });
});
