import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const native = vi.hoisted(() => ({ lstat: vi.fn(), readdir: vi.fn(), spawn: vi.fn() }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), lstatSync: native.lstat, readdirSync: native.readdir }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn }));
import { DamagedWorkspaceMetadataError, detectWorktreeWorkspaceBranch, getWorkspacePath, WORKTREE_SEPARATOR } from "../../worktree.js";

const root = path.resolve("/ccc-workspace-naming-fixture");
const workspace = path.join(root, "a--b--c");
const sources = [path.join(root, "a"), path.join(root, "a--b")];
const missing = () => Object.assign(new Error("fixture missing"), { code: "ENOENT" });
function capture(operation: () => unknown): unknown { try { return operation(); } catch (error) { return error; } }

function fixture() {
    const events: string[] = [];
    const scans = new Map<string, number>();
    const state = { failure: undefined as unknown, failSource: "", failScan: 0 };
    const originalIndexOf = String.prototype.indexOf;
    vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, from) {
        if (String(this) === "a--b--c" && search === "--") events.push(`index:${from ?? "initial"}`);
        return originalIndexOf.call(this, search, from);
    });
    native.lstat.mockImplementation((selected: string) => {
        expect(path.isAbsolute(selected)).toBe(true);
        expect(selected === root || selected.startsWith(`${root}${path.sep}`)).toBe(true);
        if (selected === workspace || sources.includes(selected) || sources.some(source => selected === path.join(source, ".git"))) {
            return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, dev: 1n, ino: 2n };
        }
        throw missing();
    });
    native.readdir.mockImplementation((selected: string) => {
        expect([workspace, ...sources]).toContain(selected);
        const count = (scans.get(selected) ?? 0) + 1; scans.set(selected, count);
        events.push(`scan:${path.basename(selected)}:${count}`);
        if (selected === state.failSource && count === state.failScan) throw state.failure;
        return [];
    });
    native.spawn.mockImplementation((command: string, args: string[], options: { cwd: string }) => {
        expect(command).toBe("git"); expect(sources).toContain(options.cwd);
        if (args.join(" ") === "worktree list --porcelain") {
            events.push(`registry:${path.basename(options.cwd)}`);
            // Duplicate registry lines never create duplicate repair ownership.
            return { status: 0, stdout: `worktree ${workspace}\nworktree ${workspace}\n`, stderr: "" };
        }
        expect(args).toEqual(["ls-files", "--stage", "-z"]);
        events.push(`nested:${path.basename(options.cwd)}`);
        return { status: 0, stdout: "", stderr: "" };
    });
    return { events, scans, state };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("public native workspace naming facade", () => {
    it.each(["feature/a/b", " feature\\A ", "", "--branch"])("retains native sibling path handling for %j", branch => {
        const source = path.join(root, "parent", "..", "Repo");
        expect(getWorkspacePath(source, branch)).toBe(path.join(root, `Repo--${branch.replace(/\//g, "-")}`));
        expect(WORKTREE_SEPARATOR).toBe("--");
        expect(native.spawn).not.toHaveBeenCalled(); expect(native.lstat).not.toHaveBeenCalled();
    });

    it("keeps candidate string search interleaved with root registry then nested native scans", () => {
        const f = fixture();
        const failure = capture(() => detectWorktreeWorkspaceBranch(workspace));
        expect(failure).toBeInstanceOf(DamagedWorkspaceMetadataError);
        expect((failure as DamagedWorkspaceMetadataError).repairs).toEqual([{ checkoutPath: workspace, sourcePath: sources[0] }]);
        const registrationWalk = ["index:initial", "registry:a", "nested:a", "scan:a:1", "index:3", "registry:a--b", "nested:a--b", "scan:a--b:1", "index:6"];
        expect(f.events.slice(1, 10)).toEqual(registrationWalk);
        // Two registration passes, then the repair pass. First proven owner wins:
        // later candidates are still scanned but cannot reassign the root repair.
        expect(f.events.filter(event => event.startsWith("registry:"))).toEqual(["registry:a", "registry:a--b", "registry:a", "registry:a--b", "registry:a"]);
        expect(f.scans.get(sources[0])).toBe(3); expect(f.scans.get(sources[1])).toBe(3);
    });

    it.each([new Error("native scan"), { stage: "native scan" }])("propagates registration nested-scan failure unchanged: %j", failure => {
        const f = fixture(); Object.assign(f.state, { failSource: sources[0], failScan: 1, failure });
        expect(capture(() => detectWorktreeWorkspaceBranch(workspace))).toBe(failure);
        expect(f.events).toEqual(["scan:a--b--c:1", "index:initial", "registry:a", "nested:a", "scan:a:1"]);
    });

    it.each([new Error("repair scan"), { stage: "repair scan" }])("catches only repair nested-scan failure and continues candidates: %j", failure => {
        const f = fixture(); Object.assign(f.state, { failSource: sources[0], failScan: 3, failure });
        const observed = capture(() => detectWorktreeWorkspaceBranch(workspace));
        expect(observed).toBeInstanceOf(DamagedWorkspaceMetadataError);
        expect((observed as DamagedWorkspaceMetadataError).repairs).toEqual([{ checkoutPath: workspace, sourcePath: sources[0] }]);
        expect(f.events.slice(-7)).toEqual(["registry:a", "nested:a", "scan:a:3", "index:3", "nested:a--b", "scan:a--b:3", "index:6"]);
    });

    it("never infers source authority from a leading separator", () => {
        const f = fixture(); const leading = path.join(root, "--a--b");
        const original = native.lstat.getMockImplementation()!;
        native.lstat.mockImplementation(selected => selected === leading ? { isDirectory: () => true } : original(selected));
        native.readdir.mockImplementation(selected => { expect(selected).toBe(leading); return []; });
        expect(detectWorktreeWorkspaceBranch(leading)).toBeNull();
        expect(native.spawn).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
    });
});
