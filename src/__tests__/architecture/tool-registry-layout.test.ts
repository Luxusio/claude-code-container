import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_BIN_PATH } from "../../domain/tool-layout.js";

afterEach(() => { vi.doUnmock("../../container-setup.js"); vi.doUnmock("child_process"); vi.restoreAllMocks(); vi.resetModules(); });

describe("shared tool launcher authority", () => {
    it("loads the actual registry without installer or native dependencies and preserves metadata and identities", async () => {
        vi.doMock("../../container-setup.js", () => { throw new Error("registry loaded installer"); });
        vi.doMock("child_process", () => { throw new Error("registry loaded native process"); });
        vi.resetModules();
        const registry = await import("../../tool-registry.js");
        const tools = registry.getAllTools();
        expect(registry.getAllTools()).toBe(tools);
        expect(registry.getDefaultTool()).toBe(tools[0]);
        for (const tool of tools) expect(registry.getToolByName(tool.name)).toBe(tool);
        expect(tools).toEqual([
            { name: "claude", displayName: "Claude Code", binary: CLAUDE_BIN_PATH,
                defaultFlags: [], credentialMounts: [
                    { hostDir: ".ccc/claude", containerDir: "/home/ccc/.claude" },
                    { hostDir: ".claude/ide", containerDir: "/home/ccc/.claude/ide" }],
                needsNodeRuntime: true, updateCommand: ["claude", "update"], installCommand: "curl -fsSL https://claude.ai/install.sh | bash" },
            { name: "gemini", displayName: "Gemini CLI", binary: "gemini", defaultFlags: ["--yolo"],
                credentialMounts: [{ hostDir: ".gemini", containerDir: "/home/ccc/.gemini" }],
                needsNodeRuntime: false, updateCommand: ["gemini", "update"], installCommand: "npm install -g @google/gemini-cli" },
            { name: "codex", displayName: "Codex", binary: "codex", defaultFlags: ["--dangerously-bypass-approvals-and-sandbox"],
                subcommands: ["exec", "e", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server", "remote-control", "completion", "update", "doctor", "migrate-rollouts", "sandbox", "debug", "apply", "a", "resume", "fork", "cloud", "exec-server", "features", "help"],
                subcommandsAcceptingDefaultFlags: ["exec", "e", "resume", "fork"], credentialMounts: [
                    { hostDir: ".ccc/codex", containerDir: "/home/ccc/.codex" }, { hostDir: ".omx", containerDir: "/home/ccc/.omx" },
                    { hostDir: ".agents", containerDir: "/home/ccc/.agents" }],
                needsNodeRuntime: false, updateCommand: ["codex", "update"], installCommand: "npm install -g @openai/codex" },
            { name: "opencode", displayName: "OpenCode", binary: "opencode", defaultFlags: ["--dangerously-skip-permissions"],
                credentialMounts: [{ hostDir: ".local/share/opencode", containerDir: "/home/ccc/.local/share/opencode" },
                    { hostDir: ".config/opencode", containerDir: "/home/ccc/.config/opencode" }],
                needsNodeRuntime: false, updateCommand: ["opencode", "update"], installCommand: "npm install -g opencode-ai" },
        ]);
        expect(registry.getAllCredentialMounts()).toEqual(tools.flatMap(tool => tool.credentialMounts));
        expect(registry.getNpmTools()).toEqual([{ cmd: "gemini", pkg: "@google/gemini-cli" },
            { cmd: "codex", pkg: "@openai/codex" }, { cmd: "opencode", pkg: "opencode-ai" }]);
    });

    it.each([false, true])("keeps the public setup paths on actual ensureTools (install needed=%s)", async installNeeded => {
        vi.doUnmock("../../container-setup.js");
        const spawn = vi.fn();
        vi.doMock("child_process", async importOriginal => ({ ...await importOriginal<object>(), spawnSync: (...args: unknown[]) => spawn(...normalizeNativeRuntimeCall(args)) }));
        vi.resetModules();
        const setup = await import("../../container-setup.js");
        const runtime = await import("../../container-runtime.js");
        const registry = await import("../../tool-registry.js");
        const invocation = preloadNativeRuntimeFixture(runtime, { runtime: "docker" });
        spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "--version") return { status: 0, stdout: "Docker version 27.0.0\n", stderr: "" };
            if (args[0] === "info" && args[2] === "{{.OperatingSystem}}") return { status: 0, stdout: "Fixture Linux\n", stderr: "" };
            if (args[0] === "info" && args[2] === "{{json .SecurityOptions}}") return { status: 0, stdout: "[]", stderr: "" };
            throw new Error(`unexpected capability fixture command: ${JSON.stringify(args)}`);
        });
        expect(runtime.runWithNativeRuntimeInvocation(invocation, () => runtime.getRuntimeInfo())).toMatchObject({
            runtime: "docker", version: "27.0.0", dockerDesktop: false, rootless: false,
        });
        expect(spawn.mock.calls.map(call => call[1])).toEqual([
            ["--version"], ["info", "--format", "{{.OperatingSystem}}"],
            ...(process.platform === "linux" ? [["info", "--format", "{{json .SecurityOptions}}"]] : []),
        ]);
        spawn.mockClear();
        vi.spyOn(console, "log").mockImplementation(() => {});
        expect(setup.CLAUDE_BIN_PATH).toBe(CLAUDE_BIN_PATH);
        expect(setup.CLAUDE_LAYOUT_PATHS).toEqual({ bin: CLAUDE_BIN_PATH, dataDir: "/home/ccc/.local/share/claude",
            volumeDataDir: "/home/ccc/.local/share/mise/.claude-data", legacyCacheFile: "/home/ccc/.local/share/mise/.claude-bin/claude" });
        const statuses = installNeeded ? ["INSTALL\n", "", "VALID\n", ""] : ["VALID\n", ""];
        spawn.mockImplementation(() => ({ status: 0, stdout: statuses.shift(), stderr: "" }));
        expect(setup.ensureTools("pinned target", registry.getDefaultTool())).toBeUndefined();
        expect(spawn).toHaveBeenCalledTimes(installNeeded ? 4 : 2);
        const calls = spawn.mock.calls;
        expect(calls[0][0]).toBe("docker");
        expect(calls[0][1].slice(0, 4)).toEqual(["exec", "pinned target", "sh", "-c"]);
        for (const path of Object.values(setup.CLAUDE_LAYOUT_PATHS)) expect(calls[0][1][4]).toContain(path);
        if (installNeeded) {
            expect(calls[1][1]).toEqual(["exec", "pinned target", "sh", "-c", "timeout -k 5s 285s sh -c 'curl -fsSL https://claude.ai/install.sh | bash'"]);
            expect(calls[2]).toEqual(calls[0]);
        }
        expect(calls.at(-1)).toEqual(["docker", ["exec", "pinned target", "test", "-x", CLAUDE_BIN_PATH],
            { stdio: "ignore", timeout: 15_000 }]);
        expect(statuses).toEqual([]);
        runtime._resetRuntimeCacheForTest();
    });
});
