import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
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

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
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
    ): ReturnType<typeof spawnSync> {
        return spawnSync(
            "sh",
            ["-c", sshCredentialCopyShell(), "ccc-ssh-copy", sourceRoot, copiedRoot],
            { encoding: "utf8", env },
        );
    }

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

        expect(result.status).toBe(1);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
        expect(() => readFileSync(join(copiedRoot, ".ccc-copy-complete"))).toThrow();
        expect(readdirSync(root).some((name) => name.includes(".ssh-copy.next."))).toBe(false);
    });
});
