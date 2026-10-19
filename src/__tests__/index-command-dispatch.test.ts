import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { HomeLayoutMigrationOptions } from "../ports/home-layout-migration.js";

const fixture = vi.hoisted(() => ({
    home: "", project: "", workspace: "", broken: false,
    profiles: new Set<string>(), runtime: vi.fn(), native: vi.fn(),
    setup: vi.fn(), check: vi.fn(), terminate: vi.fn(), remote: vi.fn(),
    clean: vi.fn(), createProfile: vi.fn(), removeProfile: vi.fn(), listProfiles: vi.fn(),
    savedDefault: vi.fn(), readDefault: vi.fn(), launch: vi.fn(),
    prompt: vi.fn(), repair: vi.fn(), setAside: vi.fn(), migrate: vi.fn(),
    profileLookup: vi.fn(), homeSessions: vi.fn(),
    removalLocked: false, removalTrace: [] as string[],
    removalClaims: vi.fn(), removalOwnership: vi.fn(), removalReady: vi.fn(),
    removalIdentity: vi.fn(), removalExists: vi.fn(), removalWorkspace: vi.fn(),
    removalStranded: vi.fn(), removalRunner: vi.fn(),
    removalLiteralFailure: null as Error | null,
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
    withSharedMutationLock: (key: string, operation: () => unknown) => {
        // Native home preparation validates the held lock's identity and private mode.
        expect(key).toBe(join(fixture.home, ".ccc", "codex-state.lock"));
        writeFileSync(key, "private dispatch fixture lock\n", { mode: 0o600, flag: "wx" });
        try { return operation(); } finally { rmSync(key); }
    },
}));
vi.mock("../clipboard-server.js", () => ({
    hasAnyActiveSessionsExcept: (...args: unknown[]) => fixture.homeSessions(...args),
    retireClipboardServerFromPortFile: vi.fn(),
}));
vi.mock("../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("../container-runtime.js", async original => ({
    ...await original<typeof import("../container-runtime.js")>(),
    setRuntimeOverride: (...args: unknown[]) => fixture.runtime(...args),
}));
vi.mock("../adapters/workspace-cli-container-runtime.js", async original => {
    const native = await original<typeof import("../adapters/workspace-cli-container-runtime.js")>();
    return {
        ...native,
        createNativeWorkspaceCliContainerRuntime: () => native.createNativeWorkspaceCliContainerRuntime(
            (...args) => fixture.removalRunner(...args), "docker",
        ),
    };
});
vi.mock("../docker.js", async original => ({
    ...await original<typeof import("../docker.js")>(),
    getContainerName: () => "base",
    ensureDockerRunning: (...args: unknown[]) => fixture.removalReady(...args),
    getManagedProjectContainerIdentity: (...args: unknown[]) => fixture.removalIdentity(...args),
    isContainerExists: (...args: unknown[]) => fixture.removalExists(...args),
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
    profileExists: (name: string) => fixture.profileLookup(name),
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
    withProjectFamilyLifecycleLock: (_projectId: string, operation: () => unknown) => {
        fixture.removalTrace.push("lock"); fixture.removalLocked = true;
        try { return operation(); } finally { fixture.removalLocked = false; fixture.removalTrace.push("unlock"); }
    },
    getSessionLockClaimsForProjectFamily: (...args: unknown[]) => fixture.removalClaims(...args),
}));
vi.mock("../worktree.js", async original => {
    const native = await original<typeof import("../worktree.js")>();
    return {
        ...native,
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
        assertWorkspaceBranch: (...args: unknown[]) => fixture.removalOwnership(...args),
        removeWorkspace: (...args: unknown[]) => fixture.removalWorkspace(...args),
        strandedBranchRegistrations: (...args: unknown[]) => fixture.removalStranded(...args),
        terminalSafeLiteral: (value: string) => {
            if (fixture.removalLiteralFailure) throw fixture.removalLiteralFailure;
            return native.terminalSafeLiteral(value);
        },
    };
});

import { main } from "../index.js";
import { WorktreeContentConflictError } from "../worktree.js";
import { getProjectId } from "../utils.js";

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
    fixture.profileLookup.mockImplementation((name: string) => fixture.profiles.has(name));
    fixture.homeSessions.mockReturnValue(false);
    fixture.migrate.mockImplementation(() => undefined);
    fixture.native.mockImplementation(() => { throw new Error("Unexpected native command"); });
    fixture.listProfiles.mockReturnValue(["work", "personal"]);
    fixture.readDefault.mockReturnValue("claude");
    fixture.prompt.mockResolvedValue("y");
    fixture.repair.mockReturnValue(null);
    fixture.setAside.mockReturnValue(join(fixture.workspace, "api.ccc-conflict-kept"));
    fixture.removalLocked = false;
    fixture.removalTrace = [];
    fixture.removalLiteralFailure = null;
    fixture.removalClaims.mockImplementation(() => { expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("claims"); return []; });
    fixture.removalOwnership.mockImplementation(() => { expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("ownership"); });
    fixture.removalReady.mockImplementation(() => { expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("ready"); });
    fixture.removalIdentity.mockImplementation((name: string) => {
        expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push(`identity:${name}`);
        return { containerId: name === "base" ? "base-native-id" : "profile-native-id", running: name === "base" };
    });
    fixture.removalExists.mockImplementation(() => { expect(fixture.removalLocked).toBe(true); return true; });
    fixture.removalWorkspace.mockImplementation(() => {
        expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("workspace");
        return { removed: ["nested"], errors: [] };
    });
    fixture.removalStranded.mockImplementation(() => {
        expect(fixture.removalLocked).toBe(false); fixture.removalTrace.push("stranded"); return [];
    });
    fixture.removalRunner.mockImplementation((_command: string, args: string[]) => {
        expect(fixture.removalLocked).toBe(true);
        if (JSON.stringify(args) === JSON.stringify(["ps", "-a", "--format", "{{.Names}}"])) {
            fixture.removalTrace.push("inventory");
            return { status: 0, stdout: "base\nbase--p--work\nunrelated\n" };
        }
        if ((args[0] === "stop" || args[0] === "rm") && ["base-native-id", "profile-native-id"].includes(args[1])) {
            fixture.removalTrace.push(`${args[0]}:${args[1]}`); return { status: 0 };
        }
        throw new Error(`Unexpected removal runtime command: ${args.join(" ")}`);
    });
    vi.spyOn(process, "exit").mockImplementation(status => { fixture.removalTrace.push(`exit:${status}`); throw new CliExit(Number(status)); });
    logs = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { fixture.removalTrace.push(`stdout:${args.map(String).join(" ")}`); });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { fixture.removalTrace.push(`stderr:${args.map(String).join(" ")}`); });
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

describe("actual CLI home migration and default profile wiring", () => {
    it.each(["legacy", "run"] as const)("checks %s session locks during migration before profile and workspace lifecycle work", async namespace => {
        const legacyLocks = join(fixture.home, ".ccc", "locks");
        const runLocks = join(fixture.home, ".ccc", "run", "locks");
        const activeDirectory = namespace === "legacy" ? legacyLocks : runLocks;
        fixture.homeSessions.mockImplementation((_excluded: unknown, directory: string) => directory === activeDirectory);
        fixture.migrate.mockImplementation((options: HomeLayoutMigrationOptions) => {
            fixture.removalTrace.push("migrate");
            expect(options.hasLiveSessions()).toBe(true);
        });
        fixture.profiles.add("work");
        fixture.profileLookup.mockImplementation((name: string) => {
            fixture.removalTrace.push(`profile:${name}`); return fixture.profiles.has(name);
        });
        vi.stubEnv("CCC_PROFILE", "work");
        await run(["@feature", "rm"]);
        expect(fixture.migrate).toHaveBeenCalledOnce();
        expect(fixture.homeSessions.mock.calls).toEqual(namespace === "legacy"
            ? [[null, legacyLocks]] : [[null, legacyLocks], [null, runLocks]]);
        expect(fixture.profileLookup).toHaveBeenCalledExactlyOnceWith("work");
        expect(fixture.removalTrace.slice(0, 3)).toEqual(["migrate", "profile:work", "lock"]);
        expect(fixture.removalWorkspace).toHaveBeenCalledExactlyOnceWith(fixture.project, "feature", { force: false });
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });

    it.each([false, true])("uses CCC_PROFILE=default without a named profile and keeps home migration host-side, inContainer=%s", async inContainer => {
        vi.stubEnv("CCC_PROFILE", "default");
        if (inContainer) vi.stubEnv("container", "docker");
        await run(["remote", "check"]);
        expect(fixture.profileLookup).not.toHaveBeenCalled();
        expect(fixture.check).toHaveBeenCalledExactlyOnceWith(fixture.project);
        expect(fixture.migrate).toHaveBeenCalledTimes(inContainer ? 0 : 1);
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        expectNoAlternativeEffects();
    });
});

describe("actual CLI workspace removal composition", () => {
    function outwardTrace(): string[] {
        return fixture.removalTrace.filter(entry => /^(stdout:|stderr:|exit:)/.test(entry));
    }

    function expectNoOtherCommandEffects(): void {
        expectNoAlternativeEffects();
        expect(fixture.setup).not.toHaveBeenCalled();
        expect(fixture.check).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.remote).not.toHaveBeenCalled();
        expect(fixture.repair).not.toHaveBeenCalled();
        expect(fixture.setAside).not.toHaveBeenCalled();
        expect(fixture.prompt).not.toHaveBeenCalled();
    }

    function expectOneFailureExit(): void {
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(fixture.removalTrace.at(-1)).toBe("exit:1");
        expect(fixture.removalLocked).toBe(false);
        expectNoOtherCommandEffects();
    }

    it("keeps native ID cleanup and output inside their existing guard and channel boundaries", async () => {
        await run(["--runtime", "docker", "@feature", "rm"]);
        expect(fixture.removalTrace).toEqual([
            "lock", "claims", "ownership", "ready", "stdout:Removing workspace @feature...",
            "inventory", "identity:base", "identity:base--p--work", "workspace",
            "stop:base-native-id", "rm:base-native-id", "rm:profile-native-id",
            "stdout:Removed associated container base.", "stdout:Removed associated container base--p--work.",
            "unlock", "stdout:  removed: nested", "stdout:Workspace removed.", "stranded",
        ]);
        expect(fixture.removalClaims).toHaveBeenCalledExactlyOnceWith(getProjectId(fixture.workspace));
        expect(fixture.removalOwnership).toHaveBeenCalledExactlyOnceWith(fixture.workspace, "feature", expect.any(Function), fixture.project, { allowTrackedGitlinks: true });
        expect(fixture.removalIdentity.mock.calls).toEqual([["base", fixture.workspace], ["base--p--work", fixture.workspace]]);
        expect(fixture.removalWorkspace).toHaveBeenCalledExactlyOnceWith(fixture.project, "feature", { force: false });
        expect(fixture.removalStranded).toHaveBeenCalledExactlyOnceWith(fixture.project, "feature");
        expect(fixture.removalRunner.mock.calls.map(call => call.slice(0, 2))).toEqual([
            ["docker", ["ps", "-a", "--format", "{{.Names}}"]],
            ["docker", ["stop", "base-native-id"]],
            ["docker", ["rm", "base-native-id"]],
            ["docker", ["rm", "profile-native-id"]],
        ]);
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        expect(fixture.removalLocked).toBe(false);
        expectNoOtherCommandEffects();
    });

    it.each([false, true])("observes active family claims and preserves the explicit force=%s policy", async force => {
        fixture.removalClaims.mockImplementation(() => {
            expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("claims"); return ["session-owner"];
        });
        if (force) {
            await run(["@feature", "rm", "--force"]);
            expect(fixture.removalWorkspace).toHaveBeenCalledExactlyOnceWith(fixture.project, "feature", { force: true });
            expect(output()).toContain("Workspace removed.");
            expect(process.exit).not.toHaveBeenCalled();
            expectNoOtherCommandEffects();
        } else {
            await expect(run(["@feature", "rm"])).rejects.toMatchObject({ status: 1 });
            expect(outwardTrace()).toEqual([
                "stderr:Error: Workspace has 1 session ownership claim(s); stop sessions first or use -f to force removal.", "exit:1",
            ]);
            expect(fixture.removalOwnership).not.toHaveBeenCalled();
            expect(fixture.removalReady).not.toHaveBeenCalled();
            expect(fixture.removalRunner).not.toHaveBeenCalled();
            expect(fixture.removalWorkspace).not.toHaveBeenCalled();
            expectOneFailureExit();
        }
        expect(fixture.removalClaims).toHaveBeenCalledExactlyOnceWith(getProjectId(fixture.workspace));
        expect(fixture.removalLocked).toBe(false);
    });

    it.each(["unavailable", "present-unknown", "duplicate"] as const)("refuses %s inventory before workspace deletion and exits once", async inventory => {
        if (inventory === "unavailable") fixture.removalRunner.mockReturnValue({ status: 1, stdout: "" });
        if (inventory === "present-unknown") fixture.removalIdentity.mockReturnValue(null);
        if (inventory === "duplicate") fixture.removalIdentity.mockReturnValue({ containerId: "same-native-id", running: true });
        await expect(run(["@feature", "rm", "-f"])).rejects.toMatchObject({ status: 1 });
        expect(output()).toBe("Removing workspace @feature...");
        expect(console.error).toHaveBeenCalledTimes(1);
        const message = inventory === "unavailable" ? "Unable to list workspace containers."
            : inventory === "duplicate" ? "Workspace container inventory contains a duplicate identity."
                : "Workspace container identity inspection failed; workspace removal was aborted.";
        expect(outwardTrace()).toEqual(["stdout:Removing workspace @feature...", `stderr:Error: ${message}`, "exit:1"]);
        expect(fixture.removalWorkspace).not.toHaveBeenCalled();
        expect(fixture.removalRunner).toHaveBeenCalledTimes(1);
        expect(fixture.removalStranded).not.toHaveBeenCalled();
        expectOneFailureExit();
    });

    it("reports partial workspace deletion on the existing channels and keeps associated containers", async () => {
        fixture.removalWorkspace.mockImplementation(() => {
            expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("workspace");
            return { removed: ["services/api"], errors: ["services/web is dirty; inspect it before retrying"] };
        });
        await expect(run(["@feature", "rm", "-f"])).rejects.toMatchObject({ status: 1 });
        expect(outwardTrace()).toEqual([
            "stdout:Removing workspace @feature...", "stdout:  removed: services/api",
            "stderr:  error: services/web is dirty; inspect it before retrying",
            "stderr:\nRemoved 1 item(s) before stopping — the workspace is partly dismantled. See the errors above.", "exit:1",
        ]);
        expect(fixture.removalTrace.indexOf("unlock")).toBeLessThan(fixture.removalTrace.indexOf("stdout:  removed: services/api"));
        expect(fixture.removalRunner).toHaveBeenCalledTimes(1);
        expect(fixture.removalStranded).not.toHaveBeenCalled();
        expect(output()).not.toContain("Workspace removed.");
        expectOneFailureExit();
    });

    it("stops cleanup after a native removal failure without claiming the completed workspace deletion rolled back", async () => {
        const ordinary = fixture.removalRunner.getMockImplementation()!;
        fixture.removalRunner.mockImplementation((command: string, args: string[], options: unknown) => {
            if (args[0] === "rm" && args[1] === "base-native-id") {
                expect(fixture.removalLocked).toBe(true); fixture.removalTrace.push("rm:base-native-id"); return { status: 1 };
            }
            return ordinary(command, args, options);
        });
        await expect(run(["@feature", "rm"])).rejects.toMatchObject({ status: 1 });
        expect(fixture.removalWorkspace).toHaveBeenCalledOnce();
        expect(fixture.removalRunner.mock.calls.map(call => call[1])).toEqual([
            ["ps", "-a", "--format", "{{.Names}}"], ["stop", "base-native-id"], ["rm", "base-native-id"],
        ]);
        expect(outwardTrace()).toEqual(["stdout:Removing workspace @feature...", "stderr:Error: Failed to remove workspace container.", "exit:1"]);
        expect(fixture.removalStranded).not.toHaveBeenCalled();
        expectOneFailureExit();
    });

    it("keeps ownership failure prose and the force restriction in the outward CLI", async () => {
        fixture.removalOwnership.mockImplementation(() => { throw new Error("Nested repository is not owned by the workspace source"); });
        await expect(run(["@feature", "rm", "-f"])).rejects.toMatchObject({ status: 1 });
        expect(outwardTrace()[0]).toBe("stderr:Error: Nested repository is not owned by the workspace source");
        expect(outwardTrace()[1]).toContain("-f does not lift this");
        expect(outwardTrace()[1]).toContain("git worktree prune");
        expect(fixture.removalReady).not.toHaveBeenCalled();
        expect(fixture.removalRunner).not.toHaveBeenCalled();
        expect(fixture.removalWorkspace).not.toHaveBeenCalled();
        expectOneFailureExit();
    });

    it("prints success before a later stranded-registry failure and exits once without repeating cleanup", async () => {
        fixture.removalStranded.mockImplementation(() => {
            expect(fixture.removalLocked).toBe(false); fixture.removalTrace.push("stranded"); throw new Error("stranded registry unavailable");
        });
        await expect(run(["@feature", "rm"])).rejects.toMatchObject({ status: 1 });
        expect(outwardTrace()).toEqual([
            "stdout:Removing workspace @feature...", "stdout:Removed associated container base.",
            "stdout:Removed associated container base--p--work.", "stdout:  removed: nested", "stdout:Workspace removed.",
            "stderr:Error: stranded registry unavailable", "exit:1",
        ]);
        expect(fixture.removalWorkspace).toHaveBeenCalledOnce();
        expect(fixture.removalRunner).toHaveBeenCalledTimes(4);
        expectOneFailureExit();
    });

    it("reports a stranded-remedy formatter failure after success with one outward exit", async () => {
        fixture.removalStranded.mockReturnValue([{ repository: "/source/repository", lockedPaths: [] }]);
        fixture.removalLiteralFailure = new Error("terminal formatter failed");
        await expect(run(["@feature", "rm"])).rejects.toMatchObject({ status: 1 });
        expect(outwardTrace().slice(-3)).toEqual(["stdout:Workspace removed.", "stderr:Error: terminal formatter failed", "exit:1"]);
        expect(fixture.removalWorkspace).toHaveBeenCalledOnce();
        expect(fixture.removalRunner).toHaveBeenCalledTimes(4);
        expectOneFailureExit();
    });

    it("renders shell-safe stranded unlock and prune remedies after successful removal", async () => {
        fixture.removalStranded.mockReturnValue([
            { repository: "/source/owner's $(repo)", lockedPaths: ["/old/worktree $(touch marker)"] },
            { repository: "/source/other repo", lockedPaths: [] },
        ]);
        await run(["@feature", "rm"]);
        expect(output()).toContain("Workspace removed.");
        expect(console.error).toHaveBeenCalledTimes(1);
        const notice = outwardTrace().at(-1)!;
        expect(notice).toContain("git -C '/source/owner'\\''s $(repo)' worktree unlock -- '/old/worktree $(touch marker)'");
        expect(notice).toContain("git -C '/source/owner'\\''s $(repo)' worktree prune");
        expect(notice).toContain('git -C "/source/other repo" worktree prune');
        expect(fixture.removalTrace.indexOf("stdout:Workspace removed.")).toBeLessThan(fixture.removalTrace.indexOf(notice));
        expect(process.exit).not.toHaveBeenCalled();
        expect(fixture.removalLocked).toBe(false);
        expectNoOtherCommandEffects();
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
