// src/__tests__/index-registry-call.test.ts
// Tests for deriveRegistryEntries() — the pure helper exposed from registry.ts
// that main() uses to compute what to upsert into the registry.
import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// We test deriveRegistryEntries directly (it's a pure-ish function with an
// injectable siblingExists, so no real FS access is needed).

async function getDeriveRegistryEntries() {
    const { deriveRegistryEntries } = await import("../registry.js");
    return deriveRegistryEntries;
}

it("deriveRegistryEntries returns one source entry for a plain directory", async () => {
    const deriveRegistryEntries = await getDeriveRegistryEntries();

    // Plain dir — no "--" in basename
    const projectPath = "/home/user/myproject";
    const entries = deriveRegistryEntries(projectPath, () => false);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("source");
    expect(entries[0].host_path).toBe(projectPath);
});

it("deriveRegistryEntries returns [worktree, source] for a path matching <base>--<slug> with existing sibling", async () => {
    const deriveRegistryEntries = await getDeriveRegistryEntries();

    const projectPath = "/home/user/myproject--feature-ui";
    // siblingExists returns true for the source dir
    const entries = deriveRegistryEntries(projectPath, (p) => {
        return p === "/home/user/myproject";
    });

    expect(entries).toHaveLength(2);
    const worktreeEntry = entries.find((e) => e.kind === "worktree");
    const sourceEntry = entries.find((e) => e.kind === "source");

    expect(worktreeEntry).toBeDefined();
    expect(worktreeEntry!.host_path).toBe(projectPath);
    expect(worktreeEntry!.branch).toBe("feature-ui");
    expect(worktreeEntry!.source).toBeDefined();

    expect(sourceEntry).toBeDefined();
    expect(sourceEntry!.host_path).toBe("/home/user/myproject");

    // worktree source id must match source entry id
    expect(worktreeEntry!.source).toBe(sourceEntry!.id);
});

it("deriveRegistryEntries returns source entry when sibling dir does not exist", async () => {
    const deriveRegistryEntries = await getDeriveRegistryEntries();

    const projectPath = "/home/user/myproject--feature-ui";
    // siblingExists returns false
    const entries = deriveRegistryEntries(projectPath, () => false);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("source");
    expect(entries[0].host_path).toBe(projectPath);
});

it("deriveRegistryEntries uses real fs.existsSync when no override provided (integration)", async () => {
    const deriveRegistryEntries = await getDeriveRegistryEntries();

    // Create a real temp dir structure: parent/source and parent/source--branch
    const tmpParent = path.join(os.tmpdir(), `ccc-derive-test-${Math.random().toString(36).slice(2, 8)}`);
    const sourcePath = path.join(tmpParent, "myrepo");
    const worktreePath = path.join(tmpParent, "myrepo--main");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    try {
        const entries = deriveRegistryEntries(worktreePath); // real fs check
        expect(entries).toHaveLength(2);
        expect(entries.some((e) => e.kind === "worktree")).toBe(true);
        expect(entries.some((e) => e.kind === "source")).toBe(true);
    } finally {
        fs.rmSync(tmpParent, { recursive: true, force: true });
    }
});
