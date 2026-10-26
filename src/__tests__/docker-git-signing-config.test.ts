import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { gitSigningKeyRewriteShell, sshCredentialCopyShell } from "../docker.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ccc-git-signing-key-"));
    temporaryRoots.push(root);
    return root;
}

function configureSigningKeys(configPath: string, values: string[]): void {
    for (const value of values) {
        const result = spawnSync(
            "git",
            ["config", "--file", configPath, "--add", "user.signingkey", value],
            { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
    }
}

function readSigningKeys(configPath: string): string[] {
    const result = spawnSync(
        "git",
        ["config", "--file", configPath, "--get-all", "user.signingkey"],
        { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trimEnd().split("\n");
}

function runRewrite(options: {
    signingKeys: string[];
    hostSshRoot: string;
    copiedKeyName?: string;
    copiedKeySymlink?: boolean;
}): { configPath: string; copiedRoot: string } {
    const root = makeRoot();
    const configPath = join(root, "gitconfig");
    const copiedRoot = join(root, "ssh-copy");
    mkdirSync(copiedRoot);
    configureSigningKeys(configPath, options.signingKeys);

    if (options.copiedKeyName) {
        const copiedKey = join(copiedRoot, options.copiedKeyName);
        if (options.copiedKeySymlink) {
            const outsideKey = join(root, "outside-key");
            writeFileSync(outsideKey, "private-key");
            symlinkSync(outsideKey, copiedKey);
        } else {
            writeFileSync(copiedKey, "private-key");
        }
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");
    }

    const result = spawnSync(
        "sh",
        [
            "-c",
            gitSigningKeyRewriteShell(),
            "ccc-signing-key-rewrite",
            configPath,
            options.hostSshRoot,
            copiedRoot,
        ],
        { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return { configPath, copiedRoot };
}

function prepareOwnedFixtureDirectories(path: string): void {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) prepareOwnedFixtureDirectories(join(path, name));
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        // Expected-red permission failures can leave restrictive extracted directories.
        // Repair only this test's owned fixture tree, without following links.
        prepareOwnedFixtureDirectories(root);
        rmSync(root, { recursive: true, force: true });
    }
});

describe("host Git signing-key rewrite", () => {
    it.each([
        {
            name: "macOS",
            signingKey: "/Users/ecokjkim/.ssh/id_ed25519",
            hostSshRoot: "/Users/ecokjkim/.ssh",
        },
        {
            name: "Windows",
            signingKey: "C:\\Users\\Luxus\\.ssh\\id_ed25519",
            hostSshRoot: "C:/Users/Luxus/.ssh",
        },
    ])("rewrites an exact $name host key after it was copied", ({ signingKey, hostSshRoot }) => {
        const { configPath, copiedRoot } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot,
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual([join(copiedRoot, "id_ed25519")]);
    });

    it.each([
        ["a key outside the host home", "/opt/team/.ssh/id_ed25519"],
        ["a relative key", "keys/id_ed25519"],
        ["an inline key", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest"],
        ["an unrecognized key name", "/Users/ecokjkim/.ssh/team-signing-key"],
    ])("preserves %s", (_name, signingKey) => {
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when the copied key is missing", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when a stale copied key has no completion marker", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const root = makeRoot();
        const configPath = join(root, "gitconfig");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        configureSigningKeys(configPath, [signingKey]);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");

        const result = spawnSync(
            "sh",
            ["-c", gitSigningKeyRewriteShell(), "rewrite", configPath, "/Users/ecokjkim/.ssh", copiedRoot],
            { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when the copied key is a symlink", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
            copiedKeySymlink: true,
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves multiple signing-key values", () => {
        const signingKeys = [
            "/Users/ecokjkim/.ssh/id_ed25519",
            "/Users/ecokjkim/.ssh/id_rsa",
        ];
        const { configPath } = runRewrite({
            signingKeys,
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual(signingKeys);
    });

    it("does not evaluate shell syntax in a configured value", () => {
        const root = makeRoot();
        const sentinel = join(root, "executed");
        const signingKey = `/Users/ecokjkim/.ssh/id_ed25519$(touch ${sentinel})`;
        const configPath = join(root, "gitconfig");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        configureSigningKeys(configPath, [signingKey]);
        writeFileSync(join(copiedRoot, "id_ed25519"), "private-key");

        const result = spawnSync(
            "sh",
            ["-c", gitSigningKeyRewriteShell(), "rewrite", configPath, "/Users/ecokjkim/.ssh", copiedRoot],
            { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(sentinel)).toThrow();
        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });
});

describe("container SSH credential copy", () => {
    function runCopy(
        sourceRoot: string,
        copiedRoot: string,
        env: NodeJS.ProcessEnv = process.env,
        privilegedRead = false,
    ) {
        return spawnSync(
            "sh",
            ["-c", sshCredentialCopyShell(privilegedRead), "ccc-ssh-copy", sourceRoot, copiedRoot],
            { encoding: "utf8", env },
        );
    }

    const canElevate = process.platform !== "win32" && process.getuid?.() !== 0
        && spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;

    it.skipIf(!canElevate)("copies a private host key across a UID boundary without changing host permissions", () => {
        const root = makeRoot();
        const source = join(root, "host-ssh");
        const copied = join(root, "ssh-copy");
        mkdirSync(source, { mode: 0o700 });
        writeFileSync(join(source, "id_ed25519"), "fixture-key-not-a-real-secret", { mode: 0o600 });
        expect(spawnSync("sudo", ["-n", "chown", "-R", "0:0", source]).status).toBe(0);
        try {
            expect(runCopy(source, copied).status).toBe(14);
            const result = runCopy(source, copied, process.env, true);
            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(join(copied, "id_ed25519"), "utf8")).toBe("fixture-key-not-a-real-secret");
            expect(statSync(copied).uid).toBe(process.getuid!());
            expect(statSync(join(copied, "id_ed25519")).uid).toBe(process.getuid!());
            expect(statSync(join(copied, "id_ed25519")).mode & 0o777).toBe(0o600);
            expect(statSync(source).uid).toBe(0);
            expect(statSync(source).mode & 0o777).toBe(0o700);
            expect(readdirSync(root).some(name => name.startsWith(".ccc-ssh-archive."))).toBe(false);
        } finally {
            expect(spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, source]).status).toBe(0);
        }
    });

    it("cleans archive and stale credentials when the privileged reader fails", () => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        for (const path of [source, copied, bin]) mkdirSync(path);
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
        expect(runCopy(source, copied, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, true).status).toBe(13);
        expect(readdirSync(root)).toEqual(expect.not.arrayContaining(["ssh-copy"]));
        expect(readdirSync(root).some(name => name.startsWith(".ccc-ssh-archive.") || name.includes(".next."))).toBe(false);
    });

    it.each([
        { name: "sudo password denial", diagnostic: "sudo: a password is required\n", status: 19 },
        { name: "sudo tty denial", diagnostic: "sudo: sorry, you must have a tty to run sudo\n", status: 19 },
        { name: "changed source", diagnostic: "tar: /private/fixture-host/.ssh/private-key-sentinel: file changed as we read it\n", status: 20 },
        { name: "mixed conditions", diagnostic: "sudo: a password is required\ntar: private-key-sentinel: file changed as we read it\n", status: 13 },
        { name: "unknown accompanying error", diagnostic: "sudo: a password is required\nprivate-key-sentinel: unrelated error\n", status: 13 },
        { name: "localized error", diagnostic: "sudo: 암호가 필요합니다 /private/fixture-host/.ssh/private-key-sentinel\n", status: 13 },
        { name: "unknown error", diagnostic: "tar: private-key-sentinel: Permission denied\n", status: 13 },
        { name: "unterminated evidence", diagnostic: "sudo: a password is required", status: 13 },
        { name: "oversized evidence", diagnostic: "sudo: a password is required\n" + "private-key-sentinel".repeat(500) + "\n", status: 13 },
        { name: "unavailable evidence", diagnostic: "sudo: a password is required\n", status: 13, removeEvidence: true },
    ])("keeps archive $name diagnostics private and fail-closed", ({ diagnostic, status, removeEvidence }) => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        const metadata = join(root, "capture-metadata.json");
        for (const directory of [source, copied, bin]) mkdirSync(directory);
        writeFileSync(join(source, "id_ed25519"), "source-key-sentinel", { mode: 0o600 });
        writeFileSync(join(copied, "id_ed25519"), "stale-key-sentinel");
        writeFileSync(join(copied, ".ccc-copy-complete"), "complete\n");
        writeFileSync(join(bin, "sudo"), `#!/usr/bin/python3 -I
import json, os, pathlib, stat, sys
root = pathlib.Path(os.environ["CCC_SSH_FIXTURE_ROOT"])
captures = list(root.glob(".ccc-ssh-archive.stderr.*"))
pathlib.Path(os.environ["CCC_SSH_FIXTURE_METADATA"]).write_text(json.dumps([
    {"mode": stat.S_IMODE(item.stat().st_mode), "uid": item.stat().st_uid} for item in captures
]))
if os.environ["CCC_SSH_FIXTURE_REMOVE_EVIDENCE"] == "yes":
    for item in captures:
        item.unlink()
sys.stderr.write(os.environ["CCC_SSH_FIXTURE_DIAGNOSTIC"])
sys.stdout.write("partial-key-sentinel")
sys.exit(42)
`, { mode: 0o755 });

        const result = runCopy(source, copied, {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CCC_SSH_FIXTURE_ROOT: root,
            CCC_SSH_FIXTURE_METADATA: metadata,
            CCC_SSH_FIXTURE_DIAGNOSTIC: diagnostic,
            CCC_SSH_FIXTURE_REMOVE_EVIDENCE: removeEvidence ? "yes" : "no",
        }, true);

        expect(result.status).toBe(status);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        const captures = JSON.parse(readFileSync(metadata, "utf8")) as { mode: number; uid: number }[];
        expect(captures).toHaveLength(1);
        expect(captures[0].mode).toBe(0o600);
        if (process.getuid) expect(captures[0].uid).toBe(process.getuid());
        expect(existsSync(copied)).toBe(false);
        expect(readdirSync(root).filter(name => name.startsWith(".") || name.includes(".next.") || name.includes(".previous."))).toEqual([]);
        expect(readFileSync(join(source, "id_ed25519"), "utf8")).toBe("source-key-sentinel");
        expect(statSync(join(source, "id_ed25519")).mode & 0o777).toBe(0o600);
    });

    it("preserves successful archive creation despite a recognized warning", () => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        for (const directory of [source, bin]) mkdirSync(directory);
        writeFileSync(join(source, "id_ed25519"), "source-key-sentinel");
        writeFileSync(join(bin, "sudo"), '#!/bin/sh\nprintf "%s\\n" "sudo: a password is required" >&2\nshift\nexec "$@"\n', { mode: 0o755 });

        const result = runCopy(source, copied, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, true);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(readFileSync(join(copied, "id_ed25519"), "utf8")).toBe("source-key-sentinel");
        expect(readFileSync(join(copied, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
        expect(readdirSync(root).filter(name => name.startsWith("."))).toEqual([]);
    });

    it("replaces a copied completion-marker symlink without touching its target", () => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const outside = join(root, "outside");
        mkdirSync(source);
        writeFileSync(outside, "untouched");
        symlinkSync(outside, join(source, ".ccc-copy-complete"));
        expect(runCopy(source, copied).status).toBe(0);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
        expect(readFileSync(join(copied, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
    });

    it.each([
        { failure: "staging", status: 11, command: "mkdir", body: 'case "$1" in *.next.*) exit 42;; esac\nexec /bin/mkdir "$@"' },
        { failure: "archive-create", status: 12, command: "mktemp", body: "exit 42" },
        { failure: "archive-diagnostics-create", status: 12, command: "mktemp", body: `case "$1" in *.stderr.*) exit 42;; esac\nexec ${existsSync("/usr/bin/mktemp") ? "/usr/bin/mktemp" : "/bin/mktemp"} "$@"` },
        { failure: "extract", status: 14, command: "tar", body: `case "$1" in --no-same-owner) exit 42;; esac\nexec ${existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "/bin/tar"} "$@"` },
        { failure: "permissions", status: 15, command: "chmod", body: 'case "$1" in 600) exit 42;; esac\nexec /bin/chmod "$@"' },
        { failure: "completion", status: 17, command: "chmod", body: 'for path do case "$path" in */.ccc-copy-complete) exit 42;; esac; done\nexec /bin/chmod "$@"' },
        { failure: "publication", status: 18, command: "mv", body: 'case "$1" in *.next.*) exit 42;; esac\nexec /bin/mv "$@"' },
    ])("invalidates stale credentials and staging on $failure failure", ({ status, command, body }) => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        for (const path of [source, copied, bin]) mkdirSync(path);
        writeFileSync(join(source, "id_ed25519"), "new-fixture");
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(copied, ".ccc-copy-complete"), "complete\n");
        writeFileSync(join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        // This fixture tests extraction failure without requiring privilege.
        writeFileSync(join(bin, "sudo"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
        expect(runCopy(source, copied, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, true).status).toBe(status);
        expect(readdirSync(root)).not.toContain("ssh-copy");
        expect(readdirSync(root).filter(name => name.startsWith("."))).toEqual([]);
    });

    function restrictiveFixture() {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const nested = join(source, "nested");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(source, "id_ed25519"), "synthetic-signing-key-sentinel", { mode: 0o400 });
        writeFileSync(join(source, "id_ed25519.pub"), "synthetic-public-key-sentinel", { mode: 0o400 });
        writeFileSync(join(source, "known_hosts"), "fixture.example ssh-ed25519 AAAAFixtureOnly\n", { mode: 0o400 });
        writeFileSync(join(nested, "private-sentinel"), "nested-fixture", { mode: 0o400 });
        chmodSync(nested, 0o400);
        chmodSync(source, 0o500);
        return { root, source, copied, nested };
    }

    it.skipIf(!canElevate)("SSH copy publication regression: completes restrictive native tar transfer before invoking the required Git signer", () => {
        const { root, source, copied, nested } = restrictiveFixture();
        mkdirSync(copied);
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(copied, ".ccc-copy-complete"), "complete\n");
        const result = runCopy(source, copied, process.env, true);

        // Assert the user-visible completion first: this must fail on the old helper,
        // independently of its private status codes or any new exported symbol.
        expect(existsSync(join(copied, "id_ed25519"))).toBe(true);
        expect(existsSync(join(copied, ".ccc-copy-complete"))).toBe(true);
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(copied, "id_ed25519"), "utf8")).toBe("synthetic-signing-key-sentinel");
        expect(readFileSync(join(copied, "nested", "private-sentinel"), "utf8")).toBe("nested-fixture");
        expect(readFileSync(join(copied, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
        for (const [path, mode] of [
            [copied, 0o700], [join(copied, "nested"), 0o700],
            [join(copied, "id_ed25519"), 0o600], [join(copied, "nested", "private-sentinel"), 0o600],
            [join(copied, "id_ed25519.pub"), 0o644], [join(copied, "known_hosts"), 0o644],
            [join(copied, ".ccc-copy-complete"), 0o600],
        ] as const) {
            expect(statSync(path).mode & 0o777).toBe(mode);
            expect(statSync(path).uid).toBe(process.getuid!());
        }
        expect(statSync(source).mode & 0o777).toBe(0o500);
        expect(statSync(nested).mode & 0o777).toBe(0o400);
        expect(statSync(source).uid).toBe(process.getuid!());
        for (const name of ["id_ed25519", "id_ed25519.pub", "known_hosts"]) {
            expect(statSync(join(source, name)).mode & 0o777).toBe(0o400);
        }
        expect(readdirSync(root).filter(name => name.startsWith(".") || name.includes(".next.") || name.includes(".backup."))).toEqual([]);

        const configPath = join(root, "gitconfig");
        configureSigningKeys(configPath, ["/Users/ecokjkim/.ssh/id_ed25519"]);
        const signer = join(root, "fixture-signer");
        const signerArgs = join(root, "signer-argv");
        writeFileSync(signer, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CCC_SIGNER_ARGV"\nexit 42\n', { mode: 0o755 });
        const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_NOSYSTEM: "1", CCC_SIGNER_ARGV: signerArgs };
        const repository = join(root, "repository");
        mkdirSync(repository);
        const git = (...args: string[]) => spawnSync("git", args, { cwd: repository, env: gitEnv, encoding: "utf8" });
        for (const [key, value] of [
            ["gpg.format", "ssh"], ["commit.gpgsign", "true"], ["gpg.ssh.program", signer],
            ["user.name", "Fixture"], ["user.email", "fixture@example.test"],
        ] as const) expect(git("config", "--file", configPath, key, value).status).toBe(0);
        expect(git("init", "--quiet").status).toBe(0);
        const rewritten = spawnSync("sh", ["-c", gitSigningKeyRewriteShell(), "rewrite", configPath, "/Users/ecokjkim/.ssh", copied], { encoding: "utf8" });
        expect(rewritten.status, rewritten.stderr).toBe(0);
        expect(readSigningKeys(configPath)).toEqual([join(copied, "id_ed25519")]);
        writeFileSync(join(repository, "fixture.txt"), "fixture\n");
        expect(git("add", "fixture.txt").status).toBe(0);
        const commit = git("commit", "--quiet", "-m", "must require signing");
        expect(commit.status).not.toBe(0);
        const argv = readFileSync(signerArgs, "utf8").trimEnd().split("\n");
        expect(argv.filter(arg => arg === "-f")).toHaveLength(1);
        expect(argv[argv.indexOf("-f") + 1]).toBe(join(copied, "id_ed25519"));
        expect(git("rev-parse", "--verify", "HEAD").status).not.toBe(0);
        expect(git("config", "--get", "gpg.format").stdout.trim()).toBe("ssh");
        expect(git("config", "--get", "commit.gpgsign").stdout.trim()).toBe("true");
    });

    it.skipIf(!canElevate)("SSH copy publication regression: removes restrictive staging after a provenance write failure", () => {
        const { root, source, copied } = restrictiveFixture();
        chmodSync(source, 0o700);
        mkdirSync(join(source, ".ccc-known-hosts-origin.json"));
        chmodSync(source, 0o500);
        mkdirSync(copied);
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(copied, ".ccc-copy-complete"), "complete\n");

        const result = runCopy(source, copied, process.env, true);

        expect(readdirSync(root).filter(name => name.startsWith(".") || name.includes(".next.") || name.includes(".backup."))).toEqual([]);
        expect(existsSync(copied)).toBe(false);
        expect(result.status).toBe(16);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("synthetic-signing-key-sentinel");
        expect(result.stderr).not.toContain("nested-fixture");
        expect(result.stderr).not.toContain("stale-fixture");
        expect(statSync(source).mode & 0o777).toBe(0o500);
    });

    it("replaces an existing copy instead of nesting the source directory", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "old-key");

        const first = runCopy(sourceRoot, copiedRoot);
        expect(first.status, first.stderr).toBe(0);
        expect(readFileSync(join(copiedRoot, "id_ed25519"), "utf8")).toBe("old-key");

        writeFileSync(join(sourceRoot, "id_ed25519"), "new-key");
        const second = runCopy(sourceRoot, copiedRoot);
        expect(second.status, second.stderr).toBe(0);
        expect(readFileSync(join(copiedRoot, "id_ed25519"), "utf8")).toBe("new-key");
        expect(() => readFileSync(join(copiedRoot, ".ssh", "id_ed25519"))).toThrow();
        expect(readFileSync(join(copiedRoot, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
    });

    it("applies restrictive permissions to a completed copy", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "private-key");
        writeFileSync(join(sourceRoot, "id_ed25519.pub"), "public-key");
        writeFileSync(join(sourceRoot, "known_hosts"), "host-key");

        const result = runCopy(sourceRoot, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(statSync(copiedRoot).mode & 0o777).toBe(0o700);
        expect(statSync(join(copiedRoot, "id_ed25519")).mode & 0o777).toBe(0o600);
        expect(statSync(join(copiedRoot, "id_ed25519.pub")).mode & 0o777).toBe(0o644);
        expect(statSync(join(copiedRoot, "known_hosts")).mode & 0o777).toBe(0o644);
        expect(statSync(join(copiedRoot, ".ccc-copy-complete")).mode & 0o777).toBe(0o600);
    });

    it("does not follow public-key or known-hosts symlinks while setting permissions", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        const outsidePublicKey = join(root, "outside.pub");
        const outsideKnownHosts = join(root, "outside-known-hosts");
        mkdirSync(sourceRoot);
        writeFileSync(outsidePublicKey, "outside-public-key");
        writeFileSync(outsideKnownHosts, "outside-host-key");
        chmodSync(outsidePublicKey, 0o600);
        chmodSync(outsideKnownHosts, 0o600);
        symlinkSync(outsidePublicKey, join(sourceRoot, "id_ed25519.pub"));
        symlinkSync(outsideKnownHosts, join(sourceRoot, "known_hosts"));

        const result = runCopy(sourceRoot, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(statSync(outsidePublicKey).mode & 0o777).toBe(0o600);
        expect(statSync(outsideKnownHosts).mode & 0o777).toBe(0o600);
    });

    it("removes a stale copy when the source directory is unavailable", () => {
        const root = makeRoot();
        const missingSource = join(root, "missing-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");

        const result = runCopy(missingSource, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
    });

    it("removes a stale copy when the source root is a symlink", () => {
        const root = makeRoot();
        const realSource = join(root, "real-source");
        const sourceLink = join(root, "source-link");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(realSource);
        writeFileSync(join(realSource, "id_ed25519"), "unexpected-key");
        symlinkSync(realSource, sourceLink);
        mkdirSync(copiedRoot);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");

        const result = runCopy(sourceLink, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
    });

    it("removes a stale completed copy when refresh copying fails", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        const fakeBin = join(root, "fake-bin");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "new-key");
        mkdirSync(copiedRoot);
        mkdirSync(fakeBin);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");
        const failingCopy = join(fakeBin, "cp");
        writeFileSync(failingCopy, "#!/bin/sh\nexit 42\n");
        chmodSync(failingCopy, 0o755);

        const result = runCopy(sourceRoot, copiedRoot, {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        });

        expect(result.status).toBe(14);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
        expect(() => readFileSync(join(copiedRoot, ".ccc-copy-complete"))).toThrow();
        expect(readdirSync(root).some((name) => name.includes(".ssh-copy.next."))).toBe(false);
    });
});
