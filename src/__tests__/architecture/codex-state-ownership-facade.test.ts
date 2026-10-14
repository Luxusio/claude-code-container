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
const invokePrevious = (value: unknown) => native.prepareCodexStateOwnership(value as Parameters<typeof native.prepareCodexStateOwnership>[0], "new", principal, "chosen");
const withActiveInspection = (payload: string, ids = "active") => mocks.spawn.mockImplementation((_cli, args) => ({
    status: 0, stdout: args[0] === "run" && !args.includes("--mount") ? "1001:1002" : args[0] === "ps" ? ids : args[0] === "inspect" ? payload : "", stderr: "",
}));

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
    it.each(["desktop", "podman-keep-id"] as const)("never reads prior getters for irrelevant %s mapping", mapping => {
        const prior = { get Mounts(): never { throw new Error("mounts observed too early"); }, get Image(): never { throw new Error("image observed too early"); } };
        expect(native.prepareCodexStateOwnership(prior, "new", { ...principal, mapping }, "chosen")).toBeUndefined();
        expect(mocks.runtime).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
    });
    it("does not read previous or principal gid getters for nested and unsupported hosts", () => {
        const prior = { get Mounts(): never { throw new Error("mounts observed too early"); } };
        vi.stubEnv("container", "docker");
        expect(native.prepareCodexStateOwnership(prior, "new", principal)).toBeUndefined();
        expect(mocks.runtime).not.toHaveBeenCalled();
        vi.stubEnv("container", "");
        mocks.runtime.mockReturnValue({ rootless: true, flavor: "docker-native" });
        expect(() => native.prepareCodexStateOwnership(prior, "new", principal)).toThrow("Unsupported host mapping for Codex state migration.");
        mocks.runtime.mockReturnValue({ rootless: false, flavor: "docker-native" });
        const wrongUid = { ...principal, uid: 77, get gid(): never { throw new Error("gid observed too early"); } };
        expect(() => native.prepareCodexStateOwnership(prior, "new", wrongUid)).toThrow("Unsupported host mapping for Codex state migration.");
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
    });
    it.each([undefined, null, {}, "mounts", [null], [false], ["mount"]].map(Mounts => ({ Mounts })))("refuses incomplete previous mount metadata $Mounts before account or filesystem effects", ({ Mounts }) => {
        const prior = { get Image(): never { throw new Error("image observed too early"); }, Mounts };
        expect(() => invokePrevious(prior)).toThrow();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
    });
    it.each([
        { name: "missing Destination", mount: {} },
        { name: "non-string Destination", mount: { Destination: 17 } },
        { name: "empty Destination", mount: { Destination: "" } },
    ].flatMap(({ name, mount }) => [
        { name: name + " alone", Mounts: [mount] },
        { name: name + " after a managed bind", Mounts: [previous.Mounts[0], mount] },
    ]))("refuses $name before account or ownership effects", ({ Mounts }) => {
        expect(() => invokePrevious({ Image: "old", Mounts })).toThrow(/^Cannot inspect previous container mounts\.$/);
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
        noHelper();
    });
    it.each([
        { name: "sparse-only", length: 1, managedIndex: undefined },
        { name: "hole before a managed bind", length: 2, managedIndex: 1 },
        { name: "hole after a managed bind", length: 2, managedIndex: 0 },
    ])("refuses $name before source proof or ownership effects", ({ length, managedIndex }) => {
        const Mounts = new Array<(typeof previous.Mounts)[number]>(length);
        if (managedIndex !== undefined) Mounts[managedIndex] = { ...previous.Mounts[0], Source: "runtime-alias" };
        const proof = vi.fn((_source: string) => true);
        expect(() => native.prepareCodexStateOwnership({ Image: "old", Mounts }, "new", principal, "chosen", proof))
            .toThrow(/^Cannot inspect previous container mounts\.$/);
        expect(proof).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
        noHelper();
    });
    it("preserves ascending prior slot getter order and its original fault before ownership effects", () => {
        const reads: number[] = []; const fault = { slot: 1 }; const Mounts = new Array<unknown>(3);
        Object.defineProperty(Mounts, 0, { get() { reads.push(0); return { Destination: "/unrelated" }; } });
        Object.defineProperty(Mounts, 1, { get() { reads.push(1); throw fault; } });
        Object.defineProperty(Mounts, 2, { get() { throw new Error("later slot observed too early"); } });
        try { invokePrevious({ Image: "old", Mounts }); throw new Error("missing exception"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(reads).toEqual([0, 1]);
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
        noHelper();
    });
    it("preserves a raw Destination getter fault after a qualified managed bind without ownership effects", () => {
        const fault = { destination: true };
        const Mounts = [previous.Mounts[0], { get Destination(): never { throw fault; } }];
        try { invokePrevious({ Image: "old", Mounts }); throw new Error("missing exception"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
        noHelper();
    });
    it.each([{ name: "empty", Mounts: [] }, { name: "nonmanaged", Mounts: [{ Destination: "/unrelated", get Type(): never { throw new Error("type observed too early"); }, get Source(): never { throw new Error("source observed too early"); } }] }])("keeps a qualified $name mount list a no-op without reading old image", ({ Mounts }) => {
        expect(invokePrevious({ get Image(): never { throw new Error("image observed too early"); }, Mounts })).toBeUndefined();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
    });
    it.each([
        { Type: "bind", Destination: "/home/ccc/.codex" },
        { Type: "bind", Source: 17, Destination: "/home/ccc/.codex" },
        { Type: "volume", Source: root, Destination: "/home/ccc/.codex" },
    ])("refuses an unqualified managed mount %j without reading old image", mount => {
        expect(() => invokePrevious({ get Image(): never { throw new Error("image observed too early"); }, Mounts: [mount] })).toThrow();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.normalize).not.toHaveBeenCalled();
    });
    it("reads previous Mounts once and preserves the source proof callback's alias", () => {
        let reads = 0; const proof = vi.fn(() => true);
        const prior = { Image: "old", get Mounts() { reads++; return [{ Type: "bind", Source: "runtime-alias", Destination: "/home/ccc/.codex" }]; } };
        expect(native.prepareCodexStateOwnership(prior, "new", principal, "chosen", proof)).toBeUndefined();
        expect(reads).toBe(1);
        expect(proof).toHaveBeenCalledExactlyOnceWith("runtime-alias");
        expect(mocks.spawn.mock.calls.at(-1)?.[1]).toContain(`type=bind,src=${root},dst=/state`);
    });
    it.each(["Mounts", "Image", "proof"])("propagates the original previous %s getter or callback fault", field => {
        const fault = { field }; const prior = {
            get Mounts() { if (field === "Mounts") throw fault; return [{ Type: "bind", Source: field === "proof" ? "alias" : root, Destination: "/home/ccc/.codex" }]; },
            get Image() { if (field === "Image") throw fault; return "old"; },
        };
        try { native.prepareCodexStateOwnership(prior, "new", principal, undefined, () => { throw fault; }); throw new Error("missing exception"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
    });
    it.each(["0:1002", "1001:0", "4294967295:1002", "1001:4294967295", "ccc:ccc", "1.5:1002", "1001:1002:1003", ""])("refuses malformed native account text %s before filesystem or active observations", account => {
        mocks.spawn.mockReturnValue({ status: 0, stdout: account, stderr: "" });
        expect(invoke).toThrow("Cannot establish previous ccc UID/GID for Codex state migration.");
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.stat).not.toHaveBeenCalled();
        noHelper();
    });
    it.each(["null", "{}", "[]", "not JSON", '[{"Id":"active"}]', '[{"Mounts":null}]', '[null]', '[17]'])("refuses malformed native active inspection %s before the ownership helper", payload => {
        withActiveInspection(payload);
        expect(invoke).toThrow();
        expect(mocks.spawn.mock.calls.map(call => call[1][0])).toEqual(["run", "ps", "inspect"]);
        expect(mocks.normalize.mock.calls).toEqual([["old"]]);
        noHelper();
    });
    it("splits actual ps output into one bounded inspection and refuses a count mismatch", () => {
        withActiveInspection('[{"Id":"a","Mounts":[]}]', " a \n b ");
        expect(invoke).toThrow("Cannot inspect active Codex state users.");
        expect(mocks.spawn.mock.calls[2]).toEqual(["private-runtime", ["inspect", "a", "b"], { encoding: "utf-8", input: undefined, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }]);
        noHelper();
    });
    it.each([undefined, "", "relative"])("rejects an unqualified native active bind Source %s before realpath", Source => {
        withActiveInspection(JSON.stringify([{ Id: "active", Mounts: [{ Type: "bind", Source }] }]));
        expect(invoke).toThrow("Cannot resolve active container bind source.");
        expect(mocks.realpath).not.toHaveBeenCalled();
        noHelper();
    });
    it("keeps non-bind mounts with omitted destinations harmless and missing container identity diagnostic", () => {
        withActiveInspection(JSON.stringify([{ Mounts: [{ Type: "volume" }] }]));
        expect(invoke()).toBeUndefined();
        expect(mocks.spawn.mock.calls.at(-1)?.[1]).toContain("--mount");
        mocks.spawn.mockClear();
        withActiveInspection(JSON.stringify([{ Mounts: [{ Type: "bind", Source: root }] }]));
        expect(invoke).toThrow("Codex state is in use by container unknown.");
        noHelper();
    });
    it("propagates raw native observation failures without dispatching the final helper", () => {
        const fault = { spawn: true };
        mocks.spawn.mockImplementation((_cli, args) => { if (args[0] === "ps") throw fault; return { status: 0, stdout: "1001:1002", stderr: "" }; });
        try { invoke(); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(fault); }
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
        noHelper();
    });
    it("propagates a raw fault in the second ancestor traversal before current-image normalization", () => {
        const fault = { secondTraversal: true }; let calls = 0;
        mocks.stat.mockImplementation(() => { if (++calls === 6) throw fault; return { mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: 9n, isDirectory: () => true, isSymbolicLink: () => false }; });
        try { invoke(); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(fault); }
        expect(mocks.normalize.mock.calls).toEqual([["old"]]);
        noHelper();
    });
    it("rejects a replaced native root after eight ancestor observations", () => {
        let roots = 0;
        mocks.stat.mockImplementation(path => ({ mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: path === root && ++roots === 2 ? 88n : 9n, isDirectory: () => true, isSymbolicLink: () => false }));
        expect(invoke).toThrow("Codex state root changed before helper startup.");
        expect(mocks.stat).toHaveBeenCalledTimes(8);
        expect(mocks.normalize.mock.calls).toEqual([["old"]]);
        noHelper();
    });
    it("rechecks the caller's original principal before the native helper", () => {
        const changing = { ...principal };
        mocks.spawn.mockImplementation((_cli, args) => { if (args[0] === "ps") changing.uid = 77; return { status: 0, stdout: args[0] === "run" ? "1001:1002" : "", stderr: "" }; });
        expect(() => native.prepareCodexStateOwnership(previous, "new", changing)).toThrow("Host principal changed before Codex state migration.");
        expect(mocks.stat).toHaveBeenCalledTimes(8);
        expect(mocks.normalize.mock.calls).toEqual([["old"]]);
        noHelper();
    });
    it("retains BigInt device and inode strings in native helper argv without numeric rounding", () => {
        mocks.stat.mockReturnValue({ mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 9007199254740993n, ino: 12345678901234567890n, isDirectory: () => true, isSymbolicLink: () => false });
        expect(invoke()).toBeUndefined();
        expect(mocks.spawn.mock.calls.at(-1)?.[1].slice(-2)).toEqual(["9007199254740993", "12345678901234567890"]);
    });

});
