import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
    readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
    createWorkspace, detectWorktreeWorkspaceBranch, getWorkspacePath, listWorkspaces,
} from "../worktree.js";

const compiledCli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

// These tests delegate every ordinary Git operation to real Git. Only the named
// inspection fault is injected; engine commands are fenced before any launch.
describe.skipIf(process.platform === "win32")("multi workspace registry discovery and reuse", () => {
    let root: string;
    let savedEnvironment: NodeJS.ProcessEnv;
    let privateEnvironment: NodeJS.ProcessEnv;
    let gitLog: string;
    let engineLog: string;

    beforeEach(() => {
        savedEnvironment = { ...process.env };
        const located = spawnSync("sh", ["-c", "command -v git"], {
            encoding: "utf-8", stdio: "pipe",
        });
        expect(located.status, located.stderr).toBe(0);
        const realGit = located.stdout.trim();
        root = mkdtempSync(join(tmpdir(), "ccc-multi-reuse-"));
        const home = join(root, "home");
        const bin = join(root, "bin");
        mkdirSync(home);
        mkdirSync(bin);
        gitLog = join(root, "git.log");
        engineLog = join(root, "engine.log");
        writeFileSync(gitLog, "");
        writeFileSync(engineLog, "");
        writeFileSync(join(bin, "git"), [
            "#!/bin/sh",
            'printf "%s | %s\\n" "$PWD" "$*" >> "$CCC_REUSE_GIT_LOG"',
            'if [ "$PWD" = "$CCC_REUSE_FAIL_REPOSITORY" ] && [ "$1" = worktree ] && [ "$2" = list ]; then',
            '  printf "injected registry inspection failure\\n" >&2',
            '  printf "hit\\n" >> "$CCC_REUSE_FAULT_LOG"',
            "  exit 73",
            "fi",
            'exec "$CCC_REUSE_REAL_GIT" "$@"',
            "",
        ].join("\n"));
        chmodSync(join(bin, "git"), 0o755);
        for (const engine of ["docker", "podman"]) {
            writeFileSync(join(bin, engine), [
                "#!/bin/sh",
                'printf "%s\\n" "$*" >> "$CCC_REUSE_ENGINE_LOG"',
                'printf "test engine fence\\n" >&2',
                "exit 89",
                "",
            ].join("\n"));
            chmodSync(join(bin, engine), 0o755);
        }
        // env-i semantics: no inherited Git directory, index, hooks, credentials,
        // runtime override, profile, or VITEST shortcut reaches the compiled CLI.
        privateEnvironment = {
            HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
            PATH: `${bin}:${dirname(realGit)}:/usr/bin:/bin`,
            LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
            CCC_REUSE_REAL_GIT: realGit, CCC_REUSE_GIT_LOG: gitLog,
            CCC_REUSE_ENGINE_LOG: engineLog,
        };
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, privateEnvironment);
    });

    afterEach(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, savedEnvironment);
        rmSync(root, { recursive: true, force: true });
    });

    function git(repository: string, args: string[]): string {
        const result = spawnSync("git", args, {
            cwd: repository, env: process.env, encoding: "utf-8", stdio: "pipe",
        });
        expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
        return result.stdout;
    }

    function initRepo(repository: string): void {
        mkdirSync(repository, { recursive: true });
        git(repository, ["init", "--initial-branch=main"]);
        git(repository, ["config", "user.name", "Reuse Test"]);
        git(repository, ["config", "user.email", "reuse@example.invalid"]);
        git(repository, ["config", "commit.gpgsign", "false"]);
        writeFileSync(join(repository, "tracked.txt"), "initial bytes\n");
        git(repository, ["add", "."]);
        git(repository, ["commit", "-m", "initial"]);
    }

    function multiSource(name = "source"): string {
        const source = join(root, name);
        mkdirSync(source);
        initRepo(join(source, "alpha"));
        initRepo(join(source, "beta"));
        writeFileSync(join(source, "plain.bin"), Buffer.from([0, 255, 10, 13, 42]));
        return source;
    }

    function cli(source: string, args: string[], input = "n\n") {
        expect(existsSync(compiledCli), "Build this checkout before compiled CLI tests").toBe(true);
        const result = spawnSync(process.execPath, [compiledCli, ...args], {
            cwd: source, env: privateEnvironment, input, encoding: "utf-8",
            stdio: "pipe", timeout: 20_000,
        });
        expect(result.error).toBeUndefined();
        return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    }

    function snapshot(source: string, workspace: string) {
        return {
            copied: readFileSync(join(workspace, "plain.bin")),
            repositories: ["alpha", "beta"].map((name) => {
                const repository = join(source, name);
                const checkout = join(workspace, name);
                const common = resolve(repository, git(repository, ["rev-parse", "--git-common-dir"]).trim());
                const registry = join(common, "worktrees");
                return {
                    sourceHead: git(repository, ["rev-parse", "HEAD"]),
                    checkoutHead: git(checkout, ["rev-parse", "HEAD"]),
                    checkoutBranch: git(checkout, ["branch", "--show-current"]),
                    config: readFileSync(join(common, "config")),
                    gitFile: readFileSync(join(checkout, ".git")),
                    tracked: readFileSync(join(checkout, "tracked.txt")),
                    untracked: existsSync(join(checkout, "untracked.txt"))
                        ? readFileSync(join(checkout, "untracked.txt")) : null,
                    registrations: git(repository, ["worktree", "list", "--porcelain"]),
                    backpointers: readdirSync(registry).sort().map((entry) => [
                        entry, readFileSync(join(registry, entry, "gitdir")),
                        readFileSync(join(registry, entry, "HEAD")),
                    ]),
                };
            }),
        };
    }

    function additions(): string[] {
        return readFileSync(gitLog, "utf-8").split("\n")
            .filter((line) => line.includes(" | worktree add "));
    }

    it("creates, lists, detects and reuses a plain-parent workspace without another add or changed content", () => {
        const source = multiSource();
        const branch = "feature/reuse";
        const workspace = getWorkspacePath(source, branch);
        const created = cli(source, ["runtime", `@${branch}`]);
        expect(created.output).toContain(`Workspace created: ${workspace}`);
        expect(created.status, created.output).toBe(1); // intentional runtime-discovery fence
        expect(created.output).toContain("No container runtime found");
        expect(additions()).toHaveLength(2);
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe(branch);
        expect(listWorkspaces(source)).toEqual([{ branch: "feature-reuse", path: workspace }]);
        const listed = cli(source, ["@"]);
        expect(listed.status, listed.output).toBe(0);
        expect(listed.output).toContain("feature-reuse");
        writeFileSync(join(workspace, "alpha", "tracked.txt"), "modified workspace bytes\n");
        writeFileSync(join(workspace, "beta", "untracked.txt"), "keep uncommitted work\n");
        writeFileSync(join(source, "plain.bin"), "source changed after copying");
        const before = snapshot(source, workspace);
        const beforeAdds = additions();

        const reused = cli(source, ["runtime", `@${branch}`]);

        expect(reused.output).toContain(`Using existing workspace: ${workspace}`);
        expect(reused.output).not.toContain("Creating workspace");
        expect(reused.output).not.toContain("worktree (repaired)");
        expect(reused.status, reused.output).toBe(1);
        expect(reused.output).toContain("No container runtime found");
        expect(additions()).toEqual(beforeAdds);
        expect(snapshot(source, workspace)).toEqual(before);
        expect(readFileSync(join(workspace, "plain.bin"))).toEqual(Buffer.from([0, 255, 10, 13, 42]));
        expect(readFileSync(engineLog, "utf-8").trim().split("\n").every((line) => line === "--version"))
            .toBe(true);
        expect(readFileSync(gitLog, "utf-8")).not.toContain(`${source} | ls-files`);
    });

    it("refuses actual reuse when one registered child has lost its Git metadata", () => {
        const source = multiSource();
        const branch = "damaged";
        const workspace = createWorkspace(source, branch).workspacePath;
        rmSync(join(workspace, "beta", ".git"));
        const marker = join(workspace, "beta", "keep.txt");
        writeFileSync(marker, "preserved damaged checkout\n");
        const registryBefore = git(join(source, "beta"), ["worktree", "list", "--porcelain"]);
        const addsBefore = additions();

        expect(() => detectWorktreeWorkspaceBranch(workspace)).toThrow("Workspace Git metadata is missing or damaged");
        const refused = cli(source, ["runtime", `@${branch}`]);

        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).not.toContain("Using existing workspace");
        expect(refused.output).toMatch(/not owned|metadata|worktree/i);
        expect(readFileSync(marker, "utf-8")).toBe("preserved damaged checkout\n");
        expect(git(join(source, "beta"), ["worktree", "list", "--porcelain"])).toBe(registryBefore);
        expect(additions()).toEqual(addsBefore);
    });

    it("refuses a foreign same-branch child at actual reuse even when detection sees the branch", () => {
        const source = multiSource();
        const branch = "foreign";
        const workspace = createWorkspace(source, branch).workspacePath;
        const checkout = join(workspace, "beta");
        renameSync(checkout, join(root, "saved-owned-beta"));
        const foreign = join(root, "foreign-repository");
        initRepo(foreign);
        git(foreign, ["worktree", "add", "-b", branch, checkout]);
        writeFileSync(join(checkout, "untracked.txt"), "foreign work\n");
        const registryBefore = git(join(source, "beta"), ["worktree", "list", "--porcelain"]);
        const foreignBefore = git(foreign, ["worktree", "list", "--porcelain"]);
        const gitFileBefore = readFileSync(join(checkout, ".git"));
        const addsBefore = additions();
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe(branch);

        const refused = cli(source, ["runtime", `@${branch}`]);

        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain("not owned by its source repository");
        expect(refused.output).not.toContain("Using existing workspace");
        expect(readFileSync(join(checkout, ".git"))).toEqual(gitFileBefore);
        expect(readFileSync(join(checkout, "untracked.txt"), "utf-8")).toBe("foreign work\n");
        expect(git(join(source, "beta"), ["worktree", "list", "--porcelain"])).toBe(registryBefore);
        expect(git(foreign, ["worktree", "list", "--porcelain"])).toBe(foreignBefore);
        expect(additions()).toEqual(addsBefore);
    });

    it("retains Git-root registry and tracked nested-submodule detection", () => {
        const source = join(root, "unified");
        const origin = join(root, "origin");
        initRepo(source);
        initRepo(origin);
        git(source, ["-c", "protocol.file.allow=always", "submodule", "add", origin, "services/api"]);
        git(source, ["commit", "-am", "track nested repository"]);
        const workspace = createWorkspace(source, "unified-reuse").workspacePath;
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("unified-reuse");
        const beforeAdds = additions();
        const reused = cli(source, ["runtime", "@unified-reuse"]);
        expect(reused.output).toContain(`Using existing workspace: ${workspace}`);
        expect(additions()).toEqual(beforeAdds);
        rmSync(join(workspace, "services", "api", ".git"));
        expect(() => detectWorktreeWorkspaceBranch(workspace)).toThrow("Workspace Git metadata is missing or damaged");
    });

    it("checks exact source and child paths across separator-bearing source and branch names", () => {
        const source = multiSource("prefix--source");
        const prefixCandidate = join(root, "prefix");
        mkdirSync(prefixCandidate);
        initRepo(join(prefixCandidate, "alpha"));
        const workspace = createWorkspace(source, "branch--suffix").workspacePath;
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("branch--suffix");
        const addsBefore = additions();
        const reused = cli(source, ["runtime", "@branch--suffix"]);
        expect(reused.output).toContain(`Using existing workspace: ${workspace}`);
        expect(additions()).toEqual(addsBefore);
        expect(git(join(prefixCandidate, "alpha"), ["worktree", "list", "--porcelain"]))
            .not.toContain(workspace);
    });

    it("propagates malformed source metadata instead of falling back to the plain-directory scan", () => {
        const source = multiSource();
        const workspace = createWorkspace(source, "malformed").workspacePath;
        writeFileSync(join(source, ".git"), "not Git metadata\n");
        const addsBefore = additions();
        expect(() => detectWorktreeWorkspaceBranch(workspace))
            .toThrow(`Unable to inspect Git worktree registry '${source}'`);
        expect(additions()).toEqual(addsBefore);
        expect(readFileSync(join(source, ".git"), "utf-8")).toBe("not Git metadata\n");
    });

    it("propagates a narrowly injected registry inspection fault while all other Git calls delegate", () => {
        const source = multiSource();
        const workspace = createWorkspace(source, "inspection-fault").workspacePath;
        const repository = join(source, "alpha");
        const faultLog = join(root, "fault.log");
        process.env.CCC_REUSE_FAIL_REPOSITORY = repository;
        process.env.CCC_REUSE_FAULT_LOG = faultLog;
        try {
            expect(() => detectWorktreeWorkspaceBranch(workspace))
                .toThrow(`Unable to inspect Git worktree registry '${repository}'`);
            expect(readFileSync(faultLog, "utf-8")).toBe("hit\n");
        } finally {
            delete process.env.CCC_REUSE_FAIL_REPOSITORY;
            delete process.env.CCC_REUSE_FAULT_LOG;
        }
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("inspection-fault");
    });

    it("does not follow ordinary symlink children while discovering plain-parent registrations", () => {
        const source = multiSource();
        const workspace = createWorkspace(source, "symlink-child").workspacePath;
        const outside = join(root, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, ".git"), "malformed outside metadata\n");
        symlinkSync(outside, join(source, "ordinary-link"), "dir");
        const addsBefore = additions();

        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("symlink-child");

        expect(additions()).toEqual(addsBefore);
        expect(readFileSync(gitLog, "utf-8")).not.toContain(`${outside} |`);
        expect(readFileSync(join(outside, ".git"), "utf-8")).toBe("malformed outside metadata\n");
    });
});
