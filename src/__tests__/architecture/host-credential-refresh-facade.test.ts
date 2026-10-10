import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), home: vi.fn(() => "/fixture/home"), events: [] as string[] }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn, execSync: () => { throw Error("Forbidden process"); }, exec: () => { throw Error("Forbidden process"); }, spawn: () => { throw Error("Forbidden process"); } }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: native.exists, readFileSync: (path: unknown) => {
    if (path instanceof URL && path.pathname.endsWith("/packages/device-lab/package.json")) return '{"version":"0.0.0-fixture"}';
    throw Error("Forbidden credential read");
} }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: native.home }));
const adapter = await import("../../adapters/credentials/host-refresh.js");
const { createHostCredentialRefresh } = await import("../../application/credentials/host-refresh.js");
const assets = await import("../../adapters/credentials/ssh-material.js");
const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
beforeEach(() => {
    vi.resetAllMocks(); native.events.length = 0;
    native.home.mockImplementation(() => { native.events.push("home"); return "/fixture/home"; });
    native.exists.mockImplementation((path: string) => { native.events.push(`exists:${path}`); return true; });
    native.spawn.mockImplementation(() => { native.events.push("spawn"); return { status: 0, get error() { throw Error("unread error"); }, get stdout() { throw Error("unread stdout"); }, get stderr() { throw Error("unread stderr"); } }; });
});
afterEach(() => vi.restoreAllMocks());
describe("actual native host credential refresh composition", () => {
    it.each(["docker", "podman"])("constructs without effects and SSH dispatches with default user through %s", cli => {
        const select = vi.fn(() => { native.events.push("runtime"); return cli; });
        const ports = adapter.createNativeHostCredentialRefreshPorts(select);
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
        expect(createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(select)).syncGit("id")).toBeUndefined();
        expect(native.events).toEqual(["home", `exists:${join("/fixture/home", ".gitconfig")}`]);
        expect(select).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it("fresh factory invocations observe changed native homes and runtime without shared scope", () => {
        let cli = "docker";
        let home = "/fixture/first";
        native.home.mockImplementation(() => home);
        const select = vi.fn(() => cli);
        createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(select)).syncGit("first-id");
        cli = "podman"; home = "/fixture/second";
        createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(select)).syncGit("second-id");
        expect(select).toHaveBeenCalledTimes(2);
        expect(native.spawn.mock.calls[0]).toEqual(["docker", ["cp", join("/fixture/first", ".gitconfig"), "first-id:/tmp/ccc-host-gitconfig"], { stdio: "ignore" }]);
        expect(native.spawn.mock.calls[2]).toEqual(["podman", ["cp", join("/fixture/second", ".gitconfig"), "second-id:/tmp/ccc-host-gitconfig"], { stdio: "ignore" }]);
    });
    it.each([false, true])("failed SSH observes source after dispatch and warns only when source exists (%s)", exists => {
        native.spawn.mockImplementation(() => { native.events.push("spawn"); return { status: null }; });
        native.exists.mockImplementation(path => { native.events.push(`exists:${path}`); return exists; });
        const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
        createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(() => { native.events.push("runtime"); return "docker"; })).refreshSsh("id");
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
        const refresh = createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(() => { if (boundary === "runtime") throw sentinel; return "docker"; }));
        let observed: unknown;
        try { boundary === "exists" ? refresh.syncGit("id") : refresh.refreshSsh("id"); } catch (error) { observed = error; }
        expect(observed).toBe(sentinel);
    });

});
