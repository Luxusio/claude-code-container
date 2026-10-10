import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, sep } from "path";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(), realpath: vi.fn(), root: vi.fn(), runtime: vi.fn(), cli: vi.fn(), normalize: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("fs", () => ({ lstatSync: mocks.stat, realpathSync: mocks.realpath }));
vi.mock("../../utils.js", () => ({ getCodexDir: mocks.root }));
vi.mock("../../container-runtime.js", () => ({ runtimeCli: mocks.cli, getRuntimeInfo: mocks.runtime }));
vi.mock("../../container-identity.js", () => ({ normalizeImageId: mocks.normalize }));
const native = await import("../../codex-state-ownership.js");
const root = "/private/ccc/codex";
const principal = { uid: 1000, gid: 1000, mapping: "host" as const, contractVersion: "1" };
const previous = { Image: "old", Mounts: [{ Type: "bind", Source: root, Destination: "/home/ccc/.codex" }] };
const trace: unknown[][] = [];
beforeEach(() => {
    vi.stubEnv("container", ""); vi.stubGlobal("process", { ...process, platform: "linux", geteuid: () => 1000, getegid: () => 1000 });
    mocks.root.mockReset().mockImplementation(profile => { trace.push(["root", profile]); return root; });
    mocks.runtime.mockReset().mockReturnValue({ rootless: false, flavor: "docker-native" });
    mocks.cli.mockReset().mockReturnValue("private-runtime");
    mocks.normalize.mockReset().mockImplementation(value => { trace.push(["normalize", value]); return value + "-normalized"; });
    mocks.stat.mockReset().mockImplementation((path, options) => { trace.push(["stat", path, options]); return { mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: 9n, isDirectory: () => true, isSymbolicLink: () => false }; });
    mocks.realpath.mockReset().mockImplementation(value => value);
    mocks.spawn.mockReset().mockImplementation((cli, args, options) => { trace.push(["spawn", cli, args, options]); return { status: 0, stdout: args[0] === "run" && !args.includes("--mount") ? " 1001:1002 \n" : "", stderr: "" }; });
    trace.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const invoke = () => native.prepareCodexStateOwnership(previous, "new", principal, "chosen");
const noHelper = () => expect(mocks.spawn.mock.calls.filter(call => call[1].includes("--mount"))).toHaveLength(0);

describe("actual Codex retained-state native composition", () => {
    it("retains public synchronous names, arities, scripts and exact bounded argv", () => {
        expect(native.prepareCodexStateOwnership.name).toBe("prepareCodexStateOwnership");
        expect(native.prepareCodexStateOwnership.length).toBe(5);
        expect(native.assertCodexStateAccessible.name).toBe("assertCodexStateAccessible");
        expect(native.assertCodexStateAccessible.length).toBe(2);
        expect(invoke()).toBeUndefined();
        const options = { encoding: "utf-8", input: undefined, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 };
        expect(mocks.spawn.mock.calls).toEqual([
            ["private-runtime", ["run", "--rm", "--network", "none", "--user", "root", "--entrypoint", "/bin/sh", "old-normalized", "-c", 'set -eu; printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"'], options],
            ["private-runtime", ["ps", "-q"], options],
            ["private-runtime", ["run", "--rm", "--network", "none", "--user", "root", "--mount", `type=bind,src=${root},dst=/state`, "--entrypoint", "python3", "new-normalized", "-c", native.codexStateMigrationScript, "/state", "1001", "1002", "1000", "1000", "8", "9"], options],
        ]);
        expect(mocks.stat.mock.calls).toEqual([...Array(2)].flatMap(() => [root, dirname(root), dirname(dirname(root)), sep].map(path => [path, { bigint: true }])));
        expect(trace.at(-2)).toEqual(["normalize", "new"]);
    });
    it("keeps error-first native diagnostics, exit diagnostics and trim exceptions", () => {
        mocks.spawn.mockReturnValue({ error: { message: "native failed" }, status: 1, stderr: "second" });
        expect(invoke).toThrow("Codex state ownership check failed: native failed"); noHelper();
        mocks.spawn.mockReturnValue({ status: null, stderr: "" });
        expect(invoke).toThrow("Codex state ownership check failed: exit null");
        const opaque = { trim: true };
        mocks.spawn.mockReturnValue({ status: 0, stdout: { trim() { throw opaque; } } });
        try { invoke(); throw new Error("missing exception"); } catch (error) { expect(error).toBe(opaque); }
    });
    it("does not dispatch current-image helper after active overlap or replacement", () => {
        mocks.spawn.mockImplementation((_cli, args) => ({ status: 0, stdout: args[0] === "run" ? "1001:1002" : args[0] === "ps" ? "active" : JSON.stringify([{ Id: "active", Mounts: previous.Mounts }]), stderr: "" }));
        expect(invoke).toThrow("Codex state is in use by container active.");
        expect(mocks.normalize.mock.calls).toEqual([["old"]]); noHelper();
    });
    it("does not retry a final native failure or swallow its stdout trim error", () => {
        mocks.spawn.mockImplementation((_cli, args) => ({ status: args.includes("--mount") ? 1 : 0, stdout: args[0] === "run" ? "1001:1002" : "", stderr: args.includes("--mount") ? "partial ownership write" : "" }));
        expect(invoke).toThrow("Codex state ownership check failed: partial ownership write");
        expect(mocks.spawn).toHaveBeenCalledTimes(3);
    });
    it("keeps retained access support native and reports the same recovery advice", () => {
        mocks.spawn.mockReturnValue({ status: 1, stderr: "denied" });
        expect(() => native.assertCodexStateAccessible("pinned", "chosen")).toThrow(`Codex state ownership check failed: denied\nCCC-managed Codex state (${root}) is inaccessible.`);
        expect(mocks.spawn.mock.calls[0][1]).toEqual(["exec", "pinned", "python3", "-c", native.codexStateAccessScript]);
    });

});
