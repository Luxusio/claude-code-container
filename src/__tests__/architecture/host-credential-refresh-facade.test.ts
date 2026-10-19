import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), home: vi.fn(() => "/fixture/home"), events: [] as string[] }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn, execSync: () => { throw Error("Forbidden process"); }, exec: () => { throw Error("Forbidden process"); }, spawn: () => { throw Error("Forbidden process"); } }));
vi.mock("fs", async original => {
    const manifest = new URL("../package.json", import.meta.resolve("@ccc/device-lab/version.js"));
    return { ...await original<typeof import("node:fs")>(), existsSync: native.exists, readFileSync: (path: unknown) => {
        if (path instanceof URL && path.href === manifest.href) return '{"version":"0.0.0-fixture"}';
        throw Error("Forbidden credential read");
    } };
});
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: native.home }));
const adapter = await import("../../adapters/credentials/host-refresh.js");
const { createHostCredentialRefresh } = await import("../../application/credentials/host-refresh.js");
const assets = await import("../../adapters/credentials/ssh-material.js");
function fixturePorts(selectRuntime: () => string) {
    let cli: string;
    return adapter.createNativeHostCredentialRefreshPorts(() => { cli = selectRuntime(); return cli; },
        ((args: readonly string[], options?: import("child_process").SpawnSyncOptions) => native.spawn(cli, args, options)) as import("../../container-runtime.js").BoundNativeSpawnSync);
}
beforeEach(() => {
    vi.resetAllMocks(); native.events.length = 0;
    native.home.mockImplementation(() => { native.events.push("home"); return "/fixture/home"; });
    native.exists.mockImplementation((path: string) => { native.events.push(`exists:${path}`); return true; });
    native.spawn.mockImplementation(() => { native.events.push("spawn"); return { status: 0, get error() { throw Error("unread error"); }, get stdout() { throw Error("unread stdout"); }, get stderr() { throw Error("unread stderr"); } }; });
});
afterEach(() => vi.restoreAllMocks());
describe("actual native host credential refresh composition", () => {
    it("uses an explicitly bound native runner for both staged Git effects after the selector changes", async () => {
        const { bindNativeRuntimeInvocation, validateNativeRuntimeInvocation } = await import("../../adapters/container-runtime-invocation.js");
        const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../../ports/container-runtime-invocation.js");
        const invocation = validateNativeRuntimeInvocation({
            version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
            transport: { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: "/fixture/config",
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
            selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
        });
        let selected = "docker";
        const ports = adapter.createNativeHostCredentialRefreshPorts(() => selected, bindNativeRuntimeInvocation(invocation).spawnSync);
        expect(ports.hostGitConfigExists()).toBe(true);
        ports.stageHostGitConfig("same-id");
        selected = "podman";
        ports.installHostGitConfig("same-id");
        expect(native.spawn).toHaveBeenCalledTimes(2);
        for (const [program, args, options] of native.spawn.mock.calls) {
            expect(program).toBe("/fixture/runtime/docker");
            expect(args.slice(0, 4)).toEqual(["--config", "/fixture/config", "--host", "unix:///fixture/engine-a.sock"]);
            expect(options.env.CONTAINER_CONNECTION).toBeUndefined();
            expect(options.shell).toBe(false);
        }
        expect(native.spawn.mock.calls.map(call => call[1][8])).toEqual(["cp", "exec"]);
    });

    it.each(["docker", "podman"])("constructs without effects and SSH dispatches with default user through %s", cli => {
        const select = vi.fn(() => { native.events.push("runtime"); return cli; });
        const ports = fixturePorts(select);
        const refresh = createHostCredentialRefresh(ports);
        expect(native.events).toEqual([]);
        expect(refresh.refreshSsh("captured-verified-id")).toBeUndefined();
        expect(native.events).toEqual(["home", "runtime", "spawn"]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith(cli, ["exec", "captured-verified-id", "sh", "-c", assets.sshCredentialCopyShell(true), "ccc-ssh-copy", "/home/ccc/.ssh", "/tmp/.ssh-copy"], { stdio: "ignore" });
        expect(native.exists).not.toHaveBeenCalled();
    });
    it("absent Git does not select runtime or calculate SSH root", () => {
        native.exists.mockImplementation(path => { native.events.push(`exists:${path}`); return false; });
        const select = vi.fn(() => "docker");
        expect(createHostCredentialRefresh(fixturePorts(select)).syncGit("id")).toBeUndefined();
        expect(native.events).toEqual(["home", `exists:${join("/fixture/home", ".gitconfig")}`]);
        expect(select).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it("fresh factory invocations observe changed native homes and runtime without shared scope", () => {
        let cli = "docker";
        let home = "/fixture/first";
        native.home.mockImplementation(() => home);
        const select = vi.fn(() => cli);
        createHostCredentialRefresh(fixturePorts(select)).syncGit("first-id");
        cli = "podman"; home = "/fixture/second";
        createHostCredentialRefresh(fixturePorts(select)).syncGit("second-id");
        expect(select).toHaveBeenCalledTimes(2);
        expect(native.spawn.mock.calls[0]).toEqual(["docker", ["cp", join("/fixture/first", ".gitconfig"), "first-id:/tmp/ccc-host-gitconfig"], { stdio: "ignore" }]);
        expect(native.spawn.mock.calls[2]).toEqual(["podman", ["cp", join("/fixture/second", ".gitconfig"), "second-id:/tmp/ccc-host-gitconfig"], { stdio: "ignore" }]);
    });
    it.each([false, true])("failed SSH observes source after dispatch and warns only when source exists (%s)", exists => {
        native.spawn.mockImplementation(() => { native.events.push("spawn"); return { status: null }; });
        native.exists.mockImplementation(path => { native.events.push(`exists:${path}`); return exists; });
        const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
        createHostCredentialRefresh(fixturePorts(() => { native.events.push("runtime"); return "docker"; })).refreshSsh("id");
        expect(native.events).toEqual(["home", "runtime", "spawn", `exists:${join("/fixture/home", ".ssh")}`]);
        expect(warning).toHaveBeenCalledTimes(exists ? 1 : 0);
    });
    it.each(["home", "runtime", "exists", "spawn", "status", "report"])("preserves native %s thrown identity", boundary => {
        const sentinel = { boundary };
        if (boundary === "home") native.home.mockImplementation(() => { throw sentinel; });
        if (boundary === "exists") native.exists.mockImplementation(() => { throw sentinel; });
        if (boundary === "spawn") native.spawn.mockImplementation(() => { throw sentinel; });
        if (boundary === "status") native.spawn.mockReturnValue({ get status() { throw sentinel; } });
        if (boundary === "report") {
            native.spawn.mockReturnValue({ status: 1 });
            vi.spyOn(console, "error").mockImplementation(() => { throw sentinel; });
        }
        const refresh = createHostCredentialRefresh(fixturePorts(() => { if (boundary === "runtime") throw sentinel; return "docker"; }));
        let observed: unknown;
        try { boundary === "exists" ? refresh.syncGit("id") : refresh.refreshSsh("id"); } catch (error) { observed = error; }
        expect(observed).toBe(sentinel);
    });

});
