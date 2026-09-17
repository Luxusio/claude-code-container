import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
    events: [] as string[],
    running: false,
    missing: new Set<string>(),
    failedPackages: new Set<string>(),
    failWrapper: false,
    failProbe: false,
    exitStatus: 0,
    warnAfterCommand: false,
    spawn: vi.fn(),
    unlink: vi.fn(),
    restore: vi.fn(),
    prepare: vi.fn(),
    buildMcp: vi.fn(),
    cleanup: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
    spawnSync: fixture.spawn,
}));

vi.mock("fs", async (importOriginal) => ({
    ...await importOriginal<typeof import("fs")>(),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: fixture.unlink,
}));

vi.mock("../utils.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../utils.js")>(),
    collectForwardedEnv: vi.fn(() => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 })),
    writeEnvFile: vi.fn(() => "/tmp/ccc-login-startup.env"),
    prompt: vi.fn(async () => "n"),
}));

vi.mock("../docker.js", () => ({
    ensureDockerRunning: vi.fn(),
    getContainerName: vi.fn(() => "ccc-startup-test"),
    getContainerStatus: vi.fn(() => ({ exists: true, running: fixture.running, imageId: "image" })),
    getCurrentImageId: vi.fn(() => "image"),
    startProjectContainer: vi.fn(() => "ccc-startup-test"),
    isContainerRunning: vi.fn(() => true),
    resolveCredentialHostPath: vi.fn((mount: { hostDir: string }) => `/fixture/${mount.hostDir}`),
    restoreCodexConfigHostOwnership: fixture.restore,
    prepareCodexConfigForContainer: fixture.prepare,
    syncClipboardShims: vi.fn(),
}));

vi.mock("../container-runtime.js", () => ({ runtimeCli: vi.fn(() => "docker") }));
vi.mock("../worktree.js", () => ({ getWorktreeGitMounts: vi.fn(() => []) }));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardServer: vi.fn(async () => null) }));
vi.mock("../codex-clipboard-image.js", () => ({
    maybeAttachCodexClipboardImage: vi.fn(async (_project: string, args: string[]) => ({ args })),
}));
vi.mock("../device-lab-broker.js", () => ({
    DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1",
    ensureHostDeviceBroker: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../device-lab-admin.js", () => ({ devicesCliAsync: vi.fn() }));
vi.mock("../lab-runner-admin.js", () => ({ labsCli: vi.fn() }));
vi.mock("../remote.js", () => ({}));
vi.mock("../session.js", () => ({
    createSessionLock: vi.fn(() => "/fixture/session.lock"),
    setSession: vi.fn(),
    setupSignalHandlers: vi.fn(),
    getActiveSessionsForProject: vi.fn(() => []),
    cleanupSession: fixture.cleanup,
}));
vi.mock("../mcp-forward.js", () => ({ buildMcpConfig: fixture.buildMcp }));
vi.mock("../localhost-proxy-setup.js", () => ({ setupLocalhostProxy: vi.fn() }));

import { main } from "../index.js";

const originalArgv = process.argv;

class CliExit extends Error {
    constructor(readonly status: number) {
        super(`CLI exited with ${status}`);
    }
}

function result(status = 0, stdout = "") {
    return { status, stdout, stderr: "", signal: null, pid: 1, output: [] };
}

async function runLogin(): Promise<number> {
    try {
        await main();
    } catch (error) {
        if (error instanceof CliExit) return error.status;
        throw error;
    }
    throw new Error("Login did not exit");
}

function loginCalls(): string[][] {
    return fixture.spawn.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => args.includes("codex") && args.includes("login"));
}

describe("ccc codex login startup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("CCC_PROFILE", "");
        vi.stubEnv("DEBUG", "");
        process.argv = [process.execPath, "ccc", "codex", "login"];
        vi.spyOn(process, "exit").mockImplementation((status) => {
            throw new CliExit(Number(status ?? 0));
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        fixture.events.length = 0;
        fixture.running = false;
        fixture.missing = new Set(["codex"]);
        fixture.failedPackages = new Set();
        fixture.failWrapper = false;
        fixture.failProbe = false;
        fixture.exitStatus = 0;
        fixture.warnAfterCommand = false;
        fixture.restore.mockImplementation(() => {
            fixture.events.push("host-access");
            if (fixture.warnAfterCommand && fixture.events.includes("login")) {
                console.warn("Unable to restore host access to Codex config.toml");
            }
        });
        fixture.prepare.mockImplementation(() => fixture.events.push("container-access"));
        fixture.buildMcp.mockImplementation(() => {
            fixture.events.push("mcp");
            return [];
        });
        fixture.unlink.mockImplementation(() => fixture.events.push("unlink-env"));
        fixture.cleanup.mockImplementation(() => fixture.events.push("cleanup"));

        // The real installer runs against a simulated container filesystem.
        // Only runtime calls are replaced; command dispatch and setup stay real.
        fixture.spawn.mockImplementation((_runtime: string, args: string[]) => {
            const script = args.at(-1) ?? "";
            if (args.includes("codex") && args.includes("login")) {
                fixture.events.push("login");
                return result(fixture.missing.has("codex") ? 127 : fixture.exitStatus);
            }
            if (script.includes("echo codex")) {
                const probed = ["gemini", "codex", "opencode"].filter((name) => script.includes(`echo ${name}`));
                fixture.events.push(`probe:${probed.join(",")}`);
                if (fixture.failProbe) return result(1);
                return result(0, probed.filter((name) => fixture.missing.has(name)).join("\n"));
            }
            if (script.includes("npm install -g ")) {
                const packages = script.match(/npm install -g ([^;&\n]+)/)?.[1].trim().split(/\s+/) ?? [];
                fixture.events.push(`install:${packages.join(",")}`);
                return result(packages.some((pkg) => fixture.failedPackages.has(pkg)) ? 1 : 0);
            }
            const wrapper = script.match(/cat > \/home\/ccc\/\.local\/bin\/(\w+)/)?.[1];
            if (wrapper) {
                if (fixture.failWrapper) return result(1);
                fixture.missing.delete(wrapper);
                fixture.events.push(`wrapper:${wrapper}`);
            }
            return result();
        });
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it.each([false, true])("restores host access before MCP generation (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();

        expect(await runLogin()).toBe(0);
        expect(fixture.restore).toHaveBeenCalledTimes(2);
        expect(fixture.events.indexOf("host-access")).toBeLessThan(fixture.events.indexOf("mcp"));
        expect(fixture.events.indexOf("mcp")).toBeLessThan(fixture.events.indexOf("container-access"));
        expect(fixture.events.slice(-4)).toEqual(["login", "host-access", "unlink-env", "cleanup"]);
    });

    it("repairs missing Codex in a running container without installing unrelated tools", async () => {
        fixture.running = true;
        fixture.missing.add("opencode");

        expect(await runLogin()).toBe(0);
        expect(fixture.events).toContain("probe:codex");
        expect(fixture.events).toContain("install:@openai/codex");
        expect(fixture.events).toContain("wrapper:codex");
        expect(fixture.events).not.toContain("install:opencode-ai");
        expect(fixture.missing.has("opencode")).toBe(true);
        expect(fixture.events.indexOf("wrapper:codex")).toBeLessThan(fixture.events.indexOf("login"));
    });

    it("launches login after Codex succeeds and optional OpenCode installation fails", async () => {
        fixture.missing.add("opencode");
        fixture.failedPackages.add("opencode-ai");

        expect(await runLogin()).toBe(0);
        expect(fixture.events).toContain("wrapper:codex");
        expect(fixture.events).not.toContain("wrapper:opencode");
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("opencode"));
        expect(loginCalls()).toHaveLength(1);
    });

    it.each(["install", "wrapper", "probe"])("retains the active %s error after cold setup retries and never launches login", async (failure) => {
        if (failure === "install") fixture.failedPackages.add("@openai/codex");
        fixture.failWrapper = failure === "wrapper";
        fixture.failProbe = failure === "probe";

        expect(await runLogin()).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to install tools in container: Failed to .+codex.+exit code 1/i));
        expect(fixture.events.filter((event) => event.startsWith("probe:"))).toHaveLength(2);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.buildMcp).not.toHaveBeenCalled();
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.unlink).not.toHaveBeenCalled();
    });

    it.each(["install", "wrapper", "probe"])("does not launch login when selected-tool %s fails in a running container", async (failure) => {
        fixture.running = true;
        if (failure === "install") fixture.failedPackages.add("@openai/codex");
        fixture.failWrapper = failure === "wrapper";
        fixture.failProbe = failure === "probe";

        await expect(runLogin()).rejects.toThrow(/codex.*exit code 1/i);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.buildMcp).not.toHaveBeenCalled();
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.unlink).not.toHaveBeenCalled();
    });

    it("reuses the repaired Codex wrapper on the next warm invocation", async () => {
        fixture.running = true;

        expect(await runLogin()).toBe(0);
        fixture.events.length = 0;
        expect(await runLogin()).toBe(0);

        expect(fixture.events).toContain("probe:codex");
        expect(fixture.events.some((event) => event.startsWith("install:"))).toBe(false);
        expect(fixture.events).toContain("login");
    });

    it.each([false, true])("preserves login arguments without unsupported default flags (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();

        expect(await runLogin()).toBe(0);
        const [args] = loginCalls();
        expect(args.slice(args.indexOf("ccc-startup-test") + 1)).toEqual(["codex", "login"]);
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("preserves command status and cleanup when post-command ownership repair warns", async () => {
        fixture.running = true;
        fixture.missing.clear();
        fixture.exitStatus = 143;
        fixture.warnAfterCommand = true;

        expect(await runLogin()).toBe(143);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("config.toml"));
        expect(fixture.unlink).toHaveBeenCalledWith("/tmp/ccc-login-startup.env");
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.events.slice(-4)).toEqual(["login", "host-access", "unlink-env", "cleanup"]);
    });

    it.each([false, true])("cleans up and retains preparation failure before login or recovery (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();
        const error = new Error("Unable to prepare Codex credentials: directory ACL grant failed (Operation not supported)");
        fixture.prepare.mockImplementation(() => { throw error; });

        await expect(runLogin()).rejects.toBe(error);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.events.some((event) => event.startsWith("install:"))).toBe(false);
        expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("retrying"));
        expect(fixture.restore).toHaveBeenCalledTimes(2);
        expect(fixture.unlink).toHaveBeenCalledExactlyOnceWith("/tmp/ccc-login-startup.env");
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.events.slice(-3)).toEqual(["host-access", "unlink-env", "cleanup"]);
    });
});
