import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = vi.hoisted(() => ({
    home: "", project: "", workspace: "", broken: false,
    profiles: new Set<string>(), runtime: vi.fn(), native: vi.fn(),
    setup: vi.fn(), check: vi.fn(), terminate: vi.fn(), remote: vi.fn(),
    clean: vi.fn(), createProfile: vi.fn(), removeProfile: vi.fn(), listProfiles: vi.fn(),
    savedDefault: vi.fn(), readDefault: vi.fn(), launch: vi.fn(),
    prompt: vi.fn(), repair: vi.fn(), setAside: vi.fn(), migrate: vi.fn(),
}));

// Use a private native directory for cwd/content, but make every external effect
// explicit. A dispatch regression must not reach a real engine, SSH, or profile.
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => fixture.home }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: (...args: unknown[]) => fixture.native(...args) }));
vi.mock("../utils.js", async original => ({
    ...await original<typeof import("../utils.js")>(),
    get DATA_DIR() { return join(fixture.home, ".ccc"); },
    prompt: (...args: unknown[]) => fixture.prompt(...args),
}));
vi.mock("../home-layout.js", async original => ({
    ...await original<typeof import("../home-layout.js")>(),
    migrateHomeLayout: (...args: unknown[]) => fixture.migrate(...args),
    ensureDefaultProfileDir: vi.fn(),
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(),
    withSharedMutationLock: (_key: string, operation: () => unknown) => operation(),
}));
vi.mock("../clipboard-server.js", () => ({ hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("../container-runtime.js", async original => ({
    ...await original<typeof import("../container-runtime.js")>(),
    setRuntimeOverride: (...args: unknown[]) => fixture.runtime(...args),
}));
vi.mock("../remote.js", () => ({
    remoteSetup: (...args: unknown[]) => fixture.setup(...args),
    remoteCheck: (...args: unknown[]) => fixture.check(...args),
    remoteTerminate: (...args: unknown[]) => fixture.terminate(...args),
    remoteExec: (...args: unknown[]) => fixture.remote(...args),
}));
vi.mock("../clean.js", () => ({ cleanContainers: (...args: unknown[]) => fixture.clean(...args) }));
vi.mock("../profile.js", async original => ({
    ...await original<typeof import("../profile.js")>(),
    profileExists: (name: string) => fixture.profiles.has(name),
    listProfiles: (...args: unknown[]) => fixture.listProfiles(...args),
    createProfile: (...args: unknown[]) => fixture.createProfile(...args),
    removeProfile: (...args: unknown[]) => fixture.removeProfile(...args),
}));
vi.mock("../tool-detect.js", async original => ({
    ...await original<typeof import("../tool-detect.js")>(),
    getDefaultToolPreference: (...args: unknown[]) => fixture.readDefault(...args),
    setDefaultToolPreference: (...args: unknown[]) => fixture.savedDefault(...args),
}));
vi.mock("../application/container-exec.js", async original => ({
    ...await original<typeof import("../application/container-exec.js")>(),
    createContainerExec: () => ({ exec: (...args: unknown[]) => fixture.launch(...args) }),
}));
vi.mock("../composition/container-exec.js", async original => ({
    ...await original<typeof import("../composition/container-exec.js")>(),
    createNativeContainerExecPorts: () => ({}),
}));
vi.mock("../session.js", async original => ({
    ...await original<typeof import("../session.js")>(),
    withProjectFamilyLifecycleLockAsync: async (_projectId: string, operation: () => unknown) => operation(),
}));
vi.mock("../worktree.js", async original => ({
    ...await original<typeof import("../worktree.js")>(),
    isWorktreeWorkspace: () => false,
    getWorkspacePath: () => fixture.workspace,
    workspaceExists: () => true,
    hasGitMetadata: () => true,
    repairWorkspaceRootOwnership: vi.fn(),
    assertWorkspaceRootOwnership: vi.fn(),
    assertWorkspaceReady: vi.fn(),
    repairWorkspace: () => [],
    detectBrokenWorktrees: () => fixture.broken ? [{ name: "api" }] : [],
    fixBrokenWorktree: (...args: unknown[]) => fixture.repair(...args),
    setAsideConflictingContent: (...args: unknown[]) => fixture.setAside(...args),
}));

import { main } from "../index.js";
import { WorktreeContentConflictError } from "../worktree.js";

class CliExit extends Error {
    constructor(readonly status: number) { super(`CLI exited ${status}`); }
}
const initialArgv = process.argv;
const initialCwd = process.cwd();
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
    vi.clearAllMocks();
    fixture.home = mkdtempSync(join(tmpdir(), "ccc-index-dispatch-"));
    fixture.project = join(fixture.home, "project");
    fixture.workspace = join(fixture.home, "project--feature");
    mkdirSync(fixture.project);
    mkdirSync(fixture.workspace);
    writeFileSync(join(fixture.workspace, "user.txt"), "uncommitted user data");
    process.chdir(fixture.project);
    vi.stubEnv("CCC_PROFILE", "");
    vi.stubEnv("DEBUG", "");
    vi.stubEnv("container", "");
    fixture.broken = false;
    fixture.profiles = new Set();
    fixture.native.mockImplementation(() => { throw new Error("Unexpected native command"); });
    fixture.listProfiles.mockReturnValue(["work", "personal"]);
    fixture.readDefault.mockReturnValue("claude");
    fixture.prompt.mockResolvedValue("y");
    fixture.repair.mockReturnValue(null);
    fixture.setAside.mockReturnValue(join(fixture.workspace, "api.ccc-conflict-kept"));
    vi.spyOn(process, "exit").mockImplementation(status => { throw new CliExit(Number(status)); });
    logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    process.argv = initialArgv;
    process.chdir(initialCwd);
    rmSync(fixture.home, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

async function run(args: string[]): Promise<void> {
    process.argv = [process.execPath, "ccc", ...args];
    await main();
}
function output(): string {
    return logs.mock.calls.map(call => call.map(String).join(" ")).join("\n");
}
function expectNoAlternativeEffects(): void {
    expect(fixture.native).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(fixture.createProfile).not.toHaveBeenCalled();
    expect(fixture.removeProfile).not.toHaveBeenCalled();
    expect(fixture.clean).not.toHaveBeenCalled();
    expect(fixture.savedDefault).not.toHaveBeenCalled();
}

describe("normalized main command dispatch", () => {
    it.each([
        ["--runtime", "podman", "remote", "setup"],
        ["remote", "--runtime", "podman", "setup"],
        ["remote", "setup", "--runtime", "podman"],
        ["--env", "MODE=one", "remote", "setup"],
        ["remote", "--env", "MODE=two", "setup"],
        ["remote", "setup", "--env", "MODE=three"],
    ])("routes remote setup after consuming global arguments: %j", async (...args) => {
        await run(args);
        expect(fixture.setup).toHaveBeenCalledExactlyOnceWith();
        expect(fixture.check).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });

    it.each(["check", "terminate"])("routes remote %s to the current project without inventing a host", async command => {
        await run(["--runtime", "docker", "remote", "--env", "FLAG=one", command]);
        const expected = command === "check" ? fixture.check : fixture.terminate;
        expect(expected).toHaveBeenCalledExactlyOnceWith(fixture.project);
        expect(command === "check" ? fixture.terminate : fixture.check).not.toHaveBeenCalled();
        expect(fixture.setup).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });

    it.each([
        ["--runtime", "podman", "remote", "dev.example", "codex", "--resume", "--env", "LOCAL=value"],
        ["remote", "--env", "LOCAL=value", "dev.example", "codex", "--runtime", "podman", "--resume"],
        ["remote", "dev.example", "--runtime", "podman", "codex", "--env", "LOCAL=value", "--resume"],
    ])("forwards only remaining argv to the explicitly selected host: %j", async (...args) => {
        await run(args);
        expect(fixture.remote).toHaveBeenCalledExactlyOnceWith(fixture.project, "dev.example", ["codex", "--resume"]);
        expect(fixture.runtime).toHaveBeenCalledExactlyOnceWith("podman");
        expect(fixture.setup).not.toHaveBeenCalled();
        expect(fixture.check).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });

    it.each([
        ["--runtime", "docker", "remote"],
        ["remote", "--runtime", "docker"],
        ["--env", "MODE=saved", "remote"],
        ["remote", "--env", "MODE=saved"],
    ])("uses saved remote configuration when normalized argv has no host: %j", async (...args) => {
        await run(args);
        expect(fixture.remote).toHaveBeenCalledExactlyOnceWith(fixture.project, undefined, []);
        expect(fixture.setup).not.toHaveBeenCalled();
        expect(fixture.check).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });

    it.each([
        ["--runtime", "podman", "profile", "list"],
        ["profile", "--env", "MODE=list", "list"],
        ["profile", "list", "--runtime", "podman"],
    ])("lists profiles without taking option values as a subcommand: %j", async (...args) => {
        await run(args);
        expect(fixture.listProfiles).toHaveBeenCalledExactlyOnceWith();
        expect(output()).toContain("work");
        expect(output()).toContain("personal");
        expectNoAlternativeEffects();
    });

    it.each([
        ["--runtime", "docker", "profile", "add", "work"],
        ["profile", "--env", "MODE=add", "add", "work"],
        ["profile", "add", "--runtime", "docker", "work"],
        ["profile", "add", "work", "--env", "MODE=add"],
    ])("creates only the normalized requested profile: %j", async (...args) => {
        await run(args);
        expect(fixture.createProfile).toHaveBeenCalledExactlyOnceWith("work", undefined);
        expect(fixture.removeProfile).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.clean).not.toHaveBeenCalled();
        expect(fixture.native).not.toHaveBeenCalled();
    });

    it.each([
        ["--env", "MODE=remove", "profile", "rm", "work"],
        ["profile", "--runtime", "podman", "rm", "work"],
        ["profile", "rm", "--env", "MODE=remove", "work"],
        ["profile", "rm", "work", "--runtime", "podman"],
    ])("removes only the normalized requested profile: %j", async (...args) => {
        fixture.profiles.add("work");
        await run(args);
        expect(fixture.removeProfile).toHaveBeenCalledExactlyOnceWith("work");
        expect(fixture.createProfile).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.clean).not.toHaveBeenCalled();
        expect(fixture.native).not.toHaveBeenCalled();
    });

    it.each([
        { command: ["profile", "add", "work"], existing: true, message: "already exists" },
        { command: ["profile", "rm", "work"], existing: false, message: "does not exist" },
        { command: ["profile", "add", "default"], existing: false, message: "always exists" },
        { command: ["profile", "rm", "default"], existing: true, message: "cannot be removed" },
        { command: ["profile", "add", "bad/name"], existing: false, message: "Invalid profile name" },
    ])("preserves profile refusal before effects: $command", async ({ command, existing, message }) => {
        if (existing) fixture.profiles.add(command[2]);
        await expect(run(["--runtime", "docker", ...command])).rejects.toMatchObject({ status: 1 });
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
        expectNoAlternativeEffects();
    });

    it.each([
        ["--runtime", "podman", "clean", "--all", "--volumes", "--dry-run", "--yes"],
        ["clean", "--env", "MODE=clean", "--all", "--runtime", "podman", "--volumes", "--dry-run", "-y"],
        ["clean", "--all", "--volumes", "--dry-run", "--yes", "--runtime", "podman"],
    ])("passes the selected clean flags as booleans: %j", async (...args) => {
        await run(args);
        expect(fixture.clean).toHaveBeenCalledExactlyOnceWith({ all: true, volumes: true, dryRun: true, yes: true });
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.removeProfile).not.toHaveBeenCalled();
        expect(fixture.native).not.toHaveBeenCalled();
    });

    it.each([
        ["clean", "--env", "--all"],
        ["--env", "--all", "clean"],
        ["clean", "--env", "--volumes"],
        ["clean", "--env", "--yes"],
        ["clean", "--env", "--dry-run"],
    ])("never promotes a consumed environment value into a clean flag: %j", async (...args) => {
        await run(args);
        expect(fixture.clean).toHaveBeenCalledExactlyOnceWith({ all: false, volumes: false, dryRun: false, yes: false });
        expect(fixture.native).not.toHaveBeenCalled();
    });

    it.each([
        ["--default", "--runtime", "podman", "codex"],
        ["--runtime", "podman", "--default", "codex"],
        ["--default", "--env", "MODE=tool", "codex"],
        ["--default", "codex", "--env", "MODE=tool"],
    ])("selects the normalized default tool without option-value leakage: %j", async (...args) => {
        await run(args);
        expect(fixture.savedDefault).toHaveBeenCalledExactlyOnceWith("codex");
        expect(fixture.readDefault).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.launch).not.toHaveBeenCalled();
        expect(output()).toContain("Default tool set to: codex");
    });

    it("does not treat a consumed --default environment value as a preference command", async () => {
        await run(["--env", "--default", "remote", "check"]);
        expect(fixture.check).toHaveBeenCalledExactlyOnceWith(fixture.project);
        expect(fixture.savedDefault).not.toHaveBeenCalled();
        expect(fixture.readDefault).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.launch).not.toHaveBeenCalled();
    });

    it("preserves a default-tool query and rejects an unknown selected tool without effects", async () => {
        await run(["--runtime", "docker", "--default"]);
        expect(output()).toContain("Default tool: claude");
        expect(fixture.readDefault).toHaveBeenCalledOnce();
        await expect(run(["--default", "not-a-supported-tool"])).rejects.toMatchObject({ status: 1 });
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown tool: not-a-supported-tool"));
        expectNoAlternativeEffects();
    });

    it("keeps help informational before runtime, profile, home layout or remote effects", async () => {
        vi.stubEnv("CCC_PROFILE", "invalid/profile");
        await run(["--runtime", "unsupported", "--env", "MODE=one", "--help"]);
        expect(output()).toContain("USAGE:");
        expect(fixture.runtime).not.toHaveBeenCalled();
        expect(fixture.migrate).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });
});

describe("actual CLI broken-worktree repair reporting", () => {
    async function repairFromMain(): Promise<void> {
        fixture.broken = true;
        await run(["@feature", "remote", "check"]);
        expect(fixture.check).toHaveBeenCalledExactlyOnceWith(fixture.workspace);
        expect(readFileSync(join(fixture.workspace, "user.txt"), "utf8")).toBe("uncommitted user data");
    }

    it("does not claim unchanged content after an unqualified generic repair failure", async () => {
        const error = new Error("recovery incomplete; backup retained at /private/user-backup");
        fixture.repair.mockImplementation(() => { throw error; });
        await repairFromMain();
        const failure = output().split("\n").find(line => line.includes(error.message));
        expect(failure).toBeDefined();
        expect(failure).not.toMatch(/content unchanged|Nothing was changed|exactly as it was/);
        expect(fixture.repair).toHaveBeenCalledExactlyOnceWith(fixture.project, fixture.workspace, "api", "feature", true);
        expect(fixture.setAside).not.toHaveBeenCalled();
    });

    it("names retained set-aside content without claiming a generic retry left everything unchanged", async () => {
        const root = join(fixture.workspace, "api");
        const conflict = new WorktreeContentConflictError(root, [join(root, "changed.txt")]);
        const retry = new Error("replacement retained; recovery could not complete");
        fixture.repair.mockImplementationOnce(() => { throw conflict; }).mockImplementationOnce(() => { throw retry; });
        await repairFromMain();
        const failure = output().split("\n").find(line => line.includes(retry.message));
        expect(failure).toBeDefined();
        expect(failure).not.toMatch(/content unchanged|Nothing was changed|exactly as it was/);
        expect(output()).toContain(join(fixture.workspace, "api.ccc-conflict-kept"));
        expect(fixture.setAside).toHaveBeenCalledExactlyOnceWith(root, conflict.conflicts);
        expect(fixture.repair).toHaveBeenCalledTimes(2);
    });

    it("keeps the ordinary false-outcome unchanged-content message", async () => {
        fixture.repair.mockReturnValue(null);
        await repairFromMain();
        expect(output()).toContain("api: failed to fix (content unchanged)");
        expect(fixture.setAside).not.toHaveBeenCalled();
    });

    it("keeps the native restored-conflict explanation and respects declined set-aside", async () => {
        const root = join(fixture.workspace, "api");
        const conflict = new WorktreeContentConflictError(root, [join(root, "changed.txt")]);
        fixture.repair.mockImplementation(() => { throw conflict; });
        fixture.prompt.mockResolvedValueOnce("y").mockResolvedValueOnce("n");
        await repairFromMain();
        expect(output()).toContain("Nothing was changed or lost; the directory is exactly as it was.");
        expect(output()).toContain("api: left unrepaired (content unchanged)");
        expect(output()).toContain("changed.txt");
        expect(fixture.setAside).not.toHaveBeenCalled();
        expect(fixture.repair).toHaveBeenCalledOnce();
    });
});
