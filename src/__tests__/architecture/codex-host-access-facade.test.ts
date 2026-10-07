import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname } from "path";

const native = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn(), lstat: vi.fn(), forbidden: vi.fn(), modeReads: [] as string[], modeFailure: undefined as unknown }));
vi.mock("child_process", async original => {
    const actual = await original<typeof import("node:child_process")>();
    const blocked = () => { native.forbidden(); throw new Error("Forbidden process"); };
    return { ...actual, spawnSync: native.spawn, spawn: blocked, exec: blocked, execFile: blocked, execSync: blocked, execFileSync: blocked, fork: blocked };
});
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const blocked = () => { native.forbidden(); throw new Error("Forbidden filesystem"); };
    const constants = { ...actual.constants, get R_OK() { native.modeReads.push("R"); if (native.modeFailure) throw native.modeFailure; return 4; }, get W_OK() { native.modeReads.push("W"); return 2; } };
    return { ...actual, ...Object.fromEntries(Object.entries(actual).filter(([, value]) => typeof value === "function").map(([name]) => [name, blocked])),
        constants, promises: Object.fromEntries(Object.keys(actual.promises).map(name => [name, blocked])), accessSync: native.access, lstatSync: native.lstat,
        readFileSync: (selected: unknown) => selected instanceof URL && selected.href === new URL("../../../packages/device-lab/package.json", import.meta.url).href ? JSON.stringify({ version: "fixture" }) : blocked() };
});
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => "/ccc-codex-host-fake/home", tmpdir: () => "/ccc-codex-host-fake/temp" }));
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const utils = await import("../../utils.js");
const acl = await import("../../codex-config-acl.js");
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const target = "target;$(ignored)";
const options = { encoding: "utf-8", timeout: 15_000 };
const uidCall = (cli = "docker") => [cli, ["exec", target, "sh", "-c", "id -u"], options];
const repairCall = (cli = "docker", uid = "2001") => [cli, ["exec", "--user", "root", target, "sh", "-c", `timeout -k 2s 10s sh -c '${acl.codexConfigFileAclScript(uid).replace(/'/g, `'"'"'`)}'`], options];
function thrown(fn: () => unknown): unknown { try { fn(); } catch (error) { return error; } throw new Error("Expected throw"); }
function denied() { native.access.mockImplementationOnce(() => { throw { code: "EACCES" }; }); }
beforeEach(() => {
    vi.resetAllMocks(); native.modeReads.length = 0; native.modeFailure = undefined;
    runtime._setRuntimeInfoForTest({ runtime: "docker" });
    native.access.mockReturnValue(undefined); native.spawn.mockReturnValue({ status: 0, stdout: "2001\n", stderr: "" });
    native.lstat.mockImplementation(() => ({ uid: 1001, isDirectory() { return true; }, isFile() { return true; }, get nlink(): never { throw new Error("Forbidden nlink"); } }));
    Object.defineProperty(process, "getuid", { configurable: true, value: function(this: unknown) { expect(this).toBe(process); return 1001; } });
    vi.spyOn(console, "warn").mockImplementation(function(this: unknown) { expect(this).toBe(console); });
});
afterEach(() => {
    expect(native.forbidden).not.toHaveBeenCalled(); runtime._resetRuntimeCacheForTest(); vi.restoreAllMocks();
    if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor); else Reflect.deleteProperty(process, "getuid");
});
function publicContract() {
    const result: void = docker.restoreCodexConfigHostOwnership("target", "named");
    // @ts-expect-error Historical facade returns void.
    const narrow: undefined = docker.restoreCodexConfigHostOwnership("target");
    // @ts-expect-error Target is required.
    docker.restoreCodexConfigHostOwnership();
    // @ts-expect-error Facade is synchronous.
    const promise: Promise<void> = docker.restoreCodexConfigHostOwnership("target");
    void [result, narrow, promise];
}
void publicContract;
describe("Codex actual native restoration facade", () => {
    it.each([undefined, "named"])("resolves profile %s with exact native effects and same captured mode", profile => {
        const config = utils.getCodexConfigFile(profile); native.lstat.mockClear(); denied();
        expect(docker.restoreCodexConfigHostOwnership.length).toBe(2);
        expect(docker.restoreCodexConfigHostOwnership.name).toBe("restoreCodexConfigHostOwnership");
        expect(docker.restoreCodexConfigHostOwnership(target, profile)).toBeUndefined();
        expect(native.access.mock.calls).toEqual([[config, 6], [config, 6]]);
        expect(native.lstat.mock.calls.slice(-2)).toEqual([[dirname(config)], [config]]);
        expect(native.spawn.mock.calls).toEqual([uidCall(), repairCall()]); expect(native.modeReads).toEqual(["R", "W"]);
        expect(console.warn).not.toHaveBeenCalled(); expect(JSON.stringify(native.spawn.mock.calls)).not.toContain("chown");
    });
    it("reads live process UID with original receiver and raw metadata methods", () => {
        const trace: string[] = []; let reads = 0;
        Object.defineProperty(process, "getuid", { configurable: true, get() { trace.push(`getuid:${++reads}`); return function(this: unknown) { expect(this).toBe(process); trace.push("uid-call"); return 1001; }; } });
        native.lstat.mockImplementation(path => { trace.push(path.endsWith("config.toml") ? "config" : "parent"); const result = { get uid() { trace.push("owner"); return 1001; }, isDirectory() { expect(this).toBe(result); trace.push("directory"); return true; }, isFile() { expect(this).toBe(result); trace.push("file"); return true; }, get nlink(): never { throw new Error("Forbidden nlink"); } }; return result; });
        denied(); docker.restoreCodexConfigHostOwnership(target, "named");
        expect(trace).toEqual(["getuid:1", "parent", "config", "directory", "owner", "getuid:2", "uid-call", "file"]);
    });
    it("captures outer runtime before UID selection and retains it after UID command changes runtime", () => {
        denied(); native.spawn.mockImplementationOnce(() => { runtime._setRuntimeInfoForTest({ runtime: "podman" }); return { status: 0, stdout: "2001", stderr: "" }; });
        docker.restoreCodexConfigHostOwnership(target, "named"); expect(native.spawn.mock.calls).toEqual([uidCall(), repairCall()]);
        denied(); docker.restoreCodexConfigHostOwnership(target, "named"); expect(native.spawn.mock.calls.slice(2)).toEqual([uidCall("podman"), repairCall("podman")]);
    });
    it("captures mode outside catches after resolution and fresh on each invocation", () => {
        const sentinel = {}; native.modeFailure = sentinel;
        expect(thrown(() => docker.restoreCodexConfigHostOwnership(target, "named"))).toBe(sentinel); expect(native.access).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
        native.modeFailure = undefined; native.modeReads.length = 0;
        docker.restoreCodexConfigHostOwnership(target, "named"); docker.restoreCodexConfigHostOwnership(target);
        expect(native.modeReads).toEqual(["R", "W", "R", "W"]); expect(native.access.mock.calls[0]![0]).not.toBe(native.access.mock.calls[1]![0]);
    });
    it.each(["", "-1", "2001x", "4294967295"])("warns invalid mapped UID %s without repair", uid => {
        denied(); native.spawn.mockReturnValue({ status: 0, stdout: uid, stderr: "" }); docker.restoreCodexConfigHostOwnership(target, "named");
        expect(native.spawn.mock.calls).toEqual([uidCall()]); expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("invalid container user identity")); expect(native.access).toHaveBeenCalledTimes(1);
    });
    it("retains leading zeros and whitespace parsing", () => { denied(); native.spawn.mockReturnValueOnce({ status: 0, stdout: "  002001\n", stderr: "" }); docker.restoreCodexConfigHostOwnership(target, "named"); expect(native.spawn.mock.calls).toEqual([uidCall(), repairCall("docker", "002001")]); });
    it.each(["identity", "directory", "owner", "file"])("warns unsafe %s without native commands", invalid => {
        denied(); if (invalid === "identity") Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
        native.lstat.mockReturnValue({ uid: invalid === "owner" ? 2 : 1001, isDirectory: () => invalid !== "directory", isFile: () => invalid !== "file" });
        docker.restoreCodexConfigHostOwnership(target, "named"); expect(native.spawn).not.toHaveBeenCalled(); expect(console.warn).toHaveBeenCalledTimes(1);
        if (invalid === "identity") expect(native.lstat).not.toHaveBeenCalled();
    });
    it.each(["lookup", "repair"])("retains %s failure and timeout diagnostics", stage => {
        for (const observation of [{ status: null, error: { message: "timed out", code: "ETIMEDOUT" } }, { status: 42, stderr: " diagnostic \n" }, { status: null, stderr: "" }]) {
            native.spawn.mockReset(); native.access.mockReset().mockReturnValue(undefined); denied();
            if (stage === "repair") native.spawn.mockReturnValueOnce({ status: 0, stdout: "2001" }); native.spawn.mockReturnValueOnce(observation);
            docker.restoreCodexConfigHostOwnership(target, "named");
            expect(native.spawn.mock.calls).toEqual(stage === "repair" ? [uidCall(), repairCall()] : [uidCall()]);
            expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining(stage === "repair" ? "container ACL repair failed" : "container user lookup failed"));
            expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("error" in observation ? "timed out" : observation.status === null ? "exit unknown" : "diagnostic"));
            expect(native.access).toHaveBeenCalledTimes(1);
        }
    });
    it("warns recheck denial and preserves warning throw identity", () => {
        denied(); native.access.mockImplementationOnce(() => { throw new Error("recheck denial"); }); docker.restoreCodexConfigHostOwnership(target, "named");
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("recheck denial"));
        const sentinel = {}; vi.mocked(console.warn).mockImplementation(() => { throw sentinel; }); denied(); native.spawn.mockReturnValueOnce({ status: 1, stderr: "lookup denied" });
        expect(thrown(() => docker.restoreCodexConfigHostOwnership(target, "named"))).toBe(sentinel);
    });
});
