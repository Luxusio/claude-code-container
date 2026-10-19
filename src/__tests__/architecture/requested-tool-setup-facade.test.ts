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
            if (name === "codex") {
                expect(spawn).toHaveBeenCalledWith("podman", ["exec", target, "timeout", "-k", "2s", "8s", "sh", "-c",
                    "command -v bwrap >/dev/null 2>&1 || exit 42; exec bwrap --version"],
                { stdio: "ignore", timeout: 15000 });
            }
            expect(exec).not.toHaveBeenCalled();
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it.each([
        { observation: result(124), message: "Requested tool codex is unavailable after setup" },
        { observation: { ...result(null), error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }, message: "Requested tool codex readiness check timed out" },
    ])("passes the raw readiness observation to the real policy ($message)", async ({ observation, message }) => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        spawn.mockReturnValueOnce(result()).mockReturnValueOnce(observation);
        try {
            expect(() => setup.ensureTools("target", registry.getToolByName("codex")!)).toThrow(message);
            expect(spawn.mock.calls[1]).toEqual(["docker", ["exec", "target", "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: 15000 }]);
            expect(spawn).not.toHaveBeenCalledWith("docker", ["exec", "target", "timeout", "-k", "2s", "8s", "sh", "-c",
                "command -v bwrap >/dev/null 2>&1 || exit 42; exec bwrap --version"],
            { stdio: "ignore", timeout: 15000 });
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });
});
