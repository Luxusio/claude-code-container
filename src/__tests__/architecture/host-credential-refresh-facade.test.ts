import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
const docker = await import("../../docker.js");
const python = await import("../../ssh-known-hosts.js");
const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
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
    it.each(["docker", "podman"])("pins %s and normalized SSH root before stage despite runtime mutation", initial => {
        let cli = initial;
        const select = vi.fn(() => { native.events.push("runtime"); return cli; });
        native.home.mockImplementationOnce(() => { native.events.push("home"); return "/fixture/config-home"; }).mockImplementationOnce(() => { native.events.push("home"); return "C:\\fixture\\ssh-home\\"; });
        native.spawn.mockImplementation(() => { native.events.push("spawn"); cli = "mutated"; return { status: 0 }; });
        expect(createHostCredentialRefresh(adapter.createNativeHostCredentialRefreshPorts(select)).syncGit("verified-id")).toBeUndefined();
        expect(native.events).toEqual(["home", `exists:${join("/fixture/config-home", ".gitconfig")}`, "runtime", "home", "spawn", "spawn"]);
        expect(select).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls).toEqual([
            [initial, ["cp", join("/fixture/config-home", ".gitconfig"), "verified-id:/tmp/ccc-host-gitconfig"], { stdio: "ignore" }],
            [initial, ["exec", "--user", "root", "verified-id", "sh", "-c", "set -e; cp /tmp/ccc-host-gitconfig /home/ccc/.gitconfig; git config --file /home/ccc/.gitconfig --add safe.directory '*'; " + assets.gitSigningKeyRewriteShell() + "; chown ccc:ccc /home/ccc/.gitconfig; rm -f /tmp/ccc-host-gitconfig", "ccc-signing-key-rewrite", "/home/ccc/.gitconfig", join("C:\\fixture\\ssh-home\\", ".ssh").replace(/\\/g, "/").replace(/\/+$/, ""), "/tmp/.ssh-copy"], { stdio: "ignore" }],
        ]);
    });
    it.each([0, 1, null, undefined])("forwards raw lazy native status %s without reading other fields", status => {
        const reads: string[] = [];
        native.spawn.mockReturnValue({ get status() { reads.push("status"); return status; }, get error() { throw Error("unread error"); }, get stdout() { throw Error("unread output"); } });
        const ports = adapter.createNativeHostCredentialRefreshPorts(() => "docker");
        const result = ports.refreshSsh("id");
        expect(reads).toEqual([]); expect(result.status).toBe(status); expect(reads).toEqual(["status"]);
        expect(Object.keys(result)).toEqual(["status"]);
    });
    it("reports exact warning literals with console receiver and undefined return", () => {
        const calls: unknown[][] = [];
        vi.spyOn(console, "error").mockImplementation(function (this: unknown, ...args: unknown[]) { expect(this).toBe(console); calls.push(args); });
        const ports = adapter.createNativeHostCredentialRefreshPorts(() => "docker");
        expect(ports.reportSshRefreshFailure()).toBeUndefined(); expect(ports.reportGitCopyFailure()).toBeUndefined(); expect(ports.reportGitInstallFailure()).toBeUndefined();
        expect(calls).toEqual([["[ccc] WARNING: failed to refresh copied SSH credentials inside container"], ["[ccc] WARNING: failed to copy host .gitconfig into container"], ["[ccc] WARNING: failed to install host .gitconfig inside container"]]);
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
    it("preserves independent pre-extraction asset hashes, names, arities and direct public bindings", () => {
        expect(docker.sshCredentialCopyShell).toBe(assets.sshCredentialCopyShell);
        expect(docker.gitSigningKeyRewriteShell).toBe(assets.gitSigningKeyRewriteShell);
        expect(assets.sshCredentialCopyShell.name).toBe("sshCredentialCopyShell"); expect(assets.sshCredentialCopyShell.length).toBe(0);
        expect(assets.gitSigningKeyRewriteShell.name).toBe("gitSigningKeyRewriteShell"); expect(assets.gitSigningKeyRewriteShell.length).toBe(0);
        for (const generator of [assets.sshCredentialCopyShell, docker.sshCredentialCopyShell]) {
            expect(hash(generator())).toBe("fd51e763f1cfffb14fb5d8dee11a37e82fe2de4b84587251b8739648e3ad0875");
            expect(hash(generator(false))).toBe("fd51e763f1cfffb14fb5d8dee11a37e82fe2de4b84587251b8739648e3ad0875");
            expect(hash(generator(true))).toBe("c0572abc56af6a2d15e2b9b67312c2e1a1c03051191bcf668a3160070651e79f");
        }
        expect(hash(docker.gitSigningKeyRewriteShell())).toBe("1e01e43d18f169911673c4a63b0b915c4cd1ae264aaca8c017e1748c41e4a5bb");
        expect(hash(python.SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT)).toBe("d5939c35f33717ca7d7452cce7025a0632a21523a61b657b7feec29616d30ffd");
        expect(hash(readFileSync(new URL("../../ssh-known-hosts.ts", import.meta.url)))).toBe("4bfd709896350bb71fa22962cc9dbe44250b94f1733d9b83ab67d7d6710f808e");
        expect(docker).not.toHaveProperty("fixSshPermissions"); expect(docker).not.toHaveProperty("syncHostGitConfig");
    });
});
