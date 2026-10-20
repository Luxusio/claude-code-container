import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import type { RuntimeBindGuard } from "../ports/runtime-bind-authority.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), lstat: vi.fn(), realpath: vi.fn(),
    guard: Object.freeze({root: "/home/test/.ccc"}), acquire: vi.fn(), record: vi.fn(), begin: vi.fn(), settle: vi.fn(),
}));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("fs", async original => ({...await original<typeof import("fs")>(), lstatSync: mocks.lstat, realpathSync: mocks.realpath}));
vi.mock("../home-layout.js", () => ({cccHome: () => "/home/test/.ccc"}));
vi.mock("../adapters/runtime-bind-authority.js", () => ({
    withRuntimeBindGuard: (root: string, operation: (guard: unknown) => unknown, options: unknown) => {
        mocks.acquire(root, options);
        return operation(mocks.guard);
    },
    recordRuntimeBindAuthority: (...args: unknown[]) => mocks.record(...args),
    beginRuntimeBindCreation: (...args: unknown[]) => mocks.begin(...args),
    settleRuntimeBindCreation: (...args: unknown[]) => mocks.settle(...args),
}));
vi.mock("../utils.js", () => ({ getCodexDir: (profile?: string) => profile ? `/home/test/.ccc/profiles/${profile}/codex` : "/home/test/.ccc/codex" }));
vi.mock("../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    // This unit owner supplies the process leaf explicitly; emitted integration owns native routing.
    const runner = () => { const capturedCli = "docker"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => mocks.spawn(capturedCli, args, options),
    }; };
    return { ...({ runtimeCli: () => "docker", getRuntimeInfo: () => ({ rootless: false, flavor: "docker-native" }) }), getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
const { prepareCodexStateOwnership, assertCodexStateAccessible, codexStateMigrationScript, codexStateAccessScript } = await import("../codex-state-ownership.js");
const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, linkSync, lstatSync: realLstat, readFileSync, rmSync } = await vi.importActual<typeof import("fs")>("fs");
const { spawnSync: realSpawn } = await vi.importActual<typeof import("child_process")>("child_process");

const root = "/home/test/.ccc/codex";
const previousImage = `sha256:${"a".repeat(64)}`;
const currentImage = `sha256:${"b".repeat(64)}`;
const previous = { Image: previousImage, Mounts: [{ Type: "bind", Source: root, Destination: "/home/ccc/.codex" }] };
const identity = { uid: 1000, gid: 1000, mapping: "host" as const, contractVersion: "1" };
const success = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fixtures: string[] = [];

beforeEach(() => {
    mocks.acquire.mockReset(); mocks.record.mockReset();
    mocks.begin.mockReset().mockImplementation(() => Object.freeze({})); mocks.settle.mockReset();
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    vi.spyOn(process, "getegid").mockReturnValue(1000);
    vi.stubEnv("container", "");
    mocks.spawn.mockReset().mockImplementation((_cli: string, args: string[]) => {
        if (args[0] === "run" && args.includes(previousImage)) return success("1001:1001");
        return success();
    });
    mocks.lstat.mockReset().mockReturnValue({ uid: 1000n, gid: 1000n, mode: 0o40755n, dev: 2096n, ino: 85186n, isDirectory: () => true, isSymbolicLink: () => false });
    mocks.realpath.mockReset().mockImplementation((path: string) => path);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("proven retained Codex state migration", () => {
    it("uses immutable old image without mounts and repairs only the managed store", () => {
        prepareCodexStateOwnership(previous, currentImage, identity);
        const calls = mocks.spawn.mock.calls.map(call => call[1] as string[]);
        expect(calls).toHaveLength(3);
        expect(calls[0]).toContain(previousImage);
        expect(calls[0]).not.toContain("--mount");
        expect(calls[1]).toEqual(["ps", "-q"]);
        expect(calls[2]).toContain(`type=bind,src=${root},dst=/state`);
        expect(calls[2].filter(arg => arg.startsWith("type=bind"))).toHaveLength(1);
        expect(calls[2]).toContain(currentImage);
        expect(calls[2].slice(-7)).toEqual(["/state", "1001", "1001", "1000", "1000", "2096", "85186"]);
        expect(calls[2].slice(2, 6)).toEqual(["--network", "none", "--user", "root"]);
    });
    it("publishes captured authority and pending effect before the public helper creates its protected bind", () => {
        const ticket = Object.freeze({owned: "codex helper"});
        mocks.begin.mockReturnValueOnce(ticket);
        mocks.spawn.mockImplementation((_cli: string, args: string[]) => {
            if (args.includes("--mount")) {
                expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith("/home/test/.ccc", {waitMs: 0});
                expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(mocks.guard,
                    expect.objectContaining({executable: "/fixture/runtime/docker", transport: expect.objectContaining({host: "unix:///fixture/engine.sock"})}));
                expect(mocks.settle).not.toHaveBeenCalled();
            }
            return success(args[0] === "run" && args.includes(previousImage) ? "1001:1001" : "");
        });
        prepareCodexStateOwnership(previous, currentImage, identity);
        expect(mocks.settle).toHaveBeenCalledExactlyOnceWith(mocks.guard, ticket);
        expect(mocks.spawn.mock.calls.filter(call => (call[1] as string[]).includes("--mount"))).toHaveLength(1);
    });
    it("uses an explicit held guard after source proof without acquiring the same guard again", () => {
        let proved = false;
        const proveSource = vi.fn(() => { proved = true; return true; });
        const aliasPrevious = {...previous, Mounts: [{...previous.Mounts[0], Source: "/alias/codex"}]};
        mocks.begin.mockImplementation(() => { expect(proved).toBe(true); return Object.freeze({}); });
        prepareCodexStateOwnership(aliasPrevious, currentImage, identity, undefined, proveSource, mocks.guard as RuntimeBindGuard);
        expect(proveSource).toHaveBeenCalledWith("/alias/codex");
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(mocks.begin).toHaveBeenCalledOnce();
        expect(mocks.settle).toHaveBeenCalledOnce();
    });
    it("refuses a helper before its protected bind when pending publication fails", () => {
        const failure = new Error("durable pending publication refused");
        mocks.begin.mockImplementationOnce(() => { throw failure; });
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(failure);
        expect(mocks.spawn.mock.calls.filter(call => (call[1] as string[]).includes("--mount"))).toEqual([]);
        expect(mocks.settle).not.toHaveBeenCalled();
    });
    it("does not settle a migration whose native client times out", () => {
        mocks.spawn.mockImplementation((_cli: string, args: string[]) => args.includes("--mount")
            ? {status: null, stdout: "", stderr: "", error: new Error("helper native client timed out")}
            : success(args[0] === "run" && args.includes(previousImage) ? "1001:1001" : ""));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow("timed out");
        expect(mocks.begin).toHaveBeenCalledOnce();
        expect(mocks.settle).not.toHaveBeenCalled();
    });
    it("does not migrate absent stores, non-host mappings, or already-matched IDs", () => {
        prepareCodexStateOwnership({ Image: previousImage, Mounts: [] }, currentImage, identity);
        prepareCodexStateOwnership(previous, currentImage, { ...identity, mapping: "desktop" });
        expect(mocks.spawn).not.toHaveBeenCalled();
        mocks.spawn.mockReturnValue(success("1000:1000"));
        prepareCodexStateOwnership(previous, currentImage, identity);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.lstat).not.toHaveBeenCalled();
    });
    it.each([undefined, "ccc:latest"])("refuses unavailable immutable provenance %s", Image => {
        expect(() => prepareCodexStateOwnership({ ...previous, Image }, currentImage, identity)).toThrow(/immutable/);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it.each(["0:1001", "1001:0", "ccc:ccc", "1001:4294967295"])("rejects invalid old account %s", value => {
        mocks.spawn.mockReturnValue(success(value));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/previous ccc/);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    it("refuses a different previous store and symlinked ancestor", () => {
        expect(() => prepareCodexStateOwnership({ ...previous, Mounts: [{ ...previous.Mounts[0], Source: "/home/test/.codex" }] }, currentImage, identity)).toThrow(/exact CCC/);
        mocks.lstat.mockImplementation((path: string) => ({ uid: 1000n, gid: 1000n, mode: 0o40755n, dev: 2096n, ino: 85186n, isDirectory: () => true, isSymbolicLink: () => path === "/home/test" }));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/ancestor/);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    it.each([root, "/home/test/.ccc", "/home/test"])("rejects group-writable trusted-owner directory %s", unsafe => {
        mocks.lstat.mockImplementation((path: string) => ({ uid: 1000n, gid: 1000n, mode: path === unsafe ? 0o40775n : 0o40755n, dev: 2096n, ino: 85186n, isDirectory: () => true, isSymbolicLink: () => false }));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/Remove group\/other write permissions/);
        expect(mocks.spawn.mock.calls.filter(call => call[1].includes("--mount"))).toHaveLength(0);
    });
    it("rejects root replacement between host validation and helper launch", () => {
        let rootReads = 0;
        mocks.lstat.mockImplementation((path: string) => ({ uid: 1000n, gid: 1000n, mode: 0o40755n, dev: 2096n, ino: path === root && ++rootReads > 1 ? 90000n : 85186n, isDirectory: () => true, isSymbolicLink: () => false }));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/root changed/);
        expect(mocks.spawn.mock.calls.filter(call => call[1].includes("--mount"))).toHaveLength(0);
    });
    it.each([root, "/home/test/.ccc", `${root}/tmp`, "/"])("blocks active overlapping source %s", Source => {
        mocks.spawn.mockImplementation((_cli: string, args: string[]) => args[0] === "run" ? success("1001:1001") :
            args[0] === "ps" ? success("active") : success(JSON.stringify([{ Id: "active", Mounts: [{ Type: "bind", Source }] }])));
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/in use/);
        expect(mocks.spawn.mock.calls.filter(call => call[1].includes("--mount"))).toHaveLength(0);
    });
    it("fails closed on inspection failure", () => {
        mocks.spawn.mockImplementation((_cli: string, args: string[]) => args[0] === "run" ? success("1001:1001") :
            args[0] === "ps" ? success("active") : { status: 1, stderr: "daemon disconnected" });
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow(/disconnected/);
        expect(mocks.spawn.mock.calls.filter(call => call[1].includes("--mount"))).toHaveLength(0);
    });
    it("reports recovery context when early access fails", () => {
        mocks.spawn.mockReturnValue({ status: 1, stderr: "Permission denied: app-server-daemon" });
        expect(() => assertCodexStateAccessible("project" )).toThrow(/Project-folder chown does not repair this separate store/);
        expect(mocks.spawn.mock.calls[0][1]).toEqual(["exec", "project", "python3", "-c", codexStateAccessScript]);
    });
    it.each([undefined, null, {}])("refuses incomplete previous Mounts %j before probing immutable account or the host store", Mounts => {
        const prior = { Image: previousImage, Mounts } as unknown as Parameters<typeof prepareCodexStateOwnership>[0];
        expect(() => prepareCodexStateOwnership(prior, currentImage, identity)).toThrow();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.lstat).not.toHaveBeenCalled();
    });
    it.each([{ Mounts: [] }, { Mounts: [{ Destination: "/other" }] }])("does not read the old image for a valid nonmanaged mount list $Mounts", ({ Mounts }) => {
        const prior = { get Image(): never { throw new Error("image read too early"); }, Mounts };
        expect(prepareCodexStateOwnership(prior, currentImage, identity)).toBeUndefined();
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.lstat).not.toHaveBeenCalled();
    });
    it("keeps the caller's original previous metadata getter fault", () => {
        const fault = { priorMounts: true };
        const prior = { get Mounts(): never { throw fault; }, Image: previousImage };
        try { prepareCodexStateOwnership(prior, currentImage, identity); throw new Error("missing exception"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.lstat).not.toHaveBeenCalled();
    });
    it("refuses a changed effective host principal after both traversals and before the helper", () => {
        vi.spyOn(process, "geteuid").mockReturnValueOnce(1000).mockReturnValue(77);
        expect(() => prepareCodexStateOwnership(previous, currentImage, identity)).toThrow("Host principal changed before Codex state migration.");
        expect(mocks.lstat).toHaveBeenCalledTimes(10);
        expect(mocks.spawn.mock.calls.map(call => call[1][0])).toEqual(["run", "ps"]);
    });
});

describe.skipIf(process.platform !== "linux" || realSpawn("python3", ["--version"]).status !== 0)("real nofollow Python preflight", () => {
    function fixture() {
        const path = mkdtempSync(join(tmpdir(), "ccc-codex-state-"));
        fixtures.push(path);
        mkdirSync(join(path, "private"), { mode: 0o700 });
        writeFileSync(join(path, "private", "daemon.lock"), "preserve", { mode: 0o600 });
        return path;
    }
    function execute(path: string, script = codexStateMigrationScript) {
        const stat = realLstat(path);
        return realSpawn("python3", ["-c", script, path, "65431", "65432", String(stat.uid), String(stat.gid), String(stat.dev), String(stat.ino)], { encoding: "utf-8" });
    }
    it("traverses private state while preserving external and dangling symlinks", () => {
        const path = fixture();
        symlinkSync("/etc/passwd", join(path, "external"));
        symlinkSync("/does-not-exist", join(path, "dangling"));
        const before = realLstat(join(path, "private", "daemon.lock"));
        const result = execute(path);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(realLstat(join(path, "private", "daemon.lock")).mode).toBe(before.mode);
        expect(readFileSync(join(path, "private", "daemon.lock"), "utf-8")).toBe("preserve");
        expect(realLstat(join(path, "external")).isSymbolicLink()).toBe(true);
    });
    it("rejects hardlinks in complete preflight", () => {
        const path = fixture();
        linkSync(join(path, "private", "daemon.lock"), join(path, "hardlink"));
        const result = execute(path);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Multiply linked");
        expect(readFileSync(join(path, "hardlink"), "utf-8")).toBe("preserve");
    });
    it("rejects substituted root identity before traversing its contents", () => {
        const path = fixture();
        const script = codexStateMigrationScript.replace("root_stat = os.fstat(root_fd)", "expected_ino = str(int(expected_ino) + 1)\nroot_stat = os.fstat(root_fd)");
        const result = execute(path, script);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("root identity changed");
        expect(readFileSync(join(path, "private", "daemon.lock"), "utf-8")).toBe("preserve");
    });
    it("rejects set-ID entries instead of silently clearing their modes", () => {
        const path = fixture();
        chmodSync(join(path, "private", "daemon.lock"), 0o4600);
        const result = execute(path);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Set-ID");
        expect(realLstat(join(path, "private", "daemon.lock")).mode & 0o7777).toBe(0o4600);
    });
    it.each(["late.jsonl", "private/late.jsonl"])("rejects concurrent addition %s before ownership writes", relative => {
        const path = fixture();
        const script = codexStateMigrationScript.replace(
            "    # A second complete validation",
            `    open(os.path.join(root, ${JSON.stringify(relative)}), 'w').close()\n    # A second complete validation`,
        );
        const result = execute(path, script);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("directory membership changed");
        expect(result.stdout).not.toContain("Migrated");
    });
    it("detects additions after traversal in final verification", () => {
        const path = fixture();
        const marker = "    validate_memberships()\n    for fd, parent_fd, name, before, path in entries:\n        uid";
        const script = codexStateMigrationScript.replace(marker,
            "    open(os.path.join(root, 'late.jsonl'), 'w').close()\n" + marker);
        const result = execute(path, script);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("directory membership changed");
    });
    it("detects changed modes during final verification", () => {
        const path = fixture();
        const marker = "    validate_memberships()\n    for fd, parent_fd, name, before, path in entries:\n        uid";
        const script = codexStateMigrationScript.replace(marker,
            "    os.chmod(os.path.join(root, 'private', 'daemon.lock'), 0o640)\n" + marker);
        const result = execute(path, script);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("changed before final verification");
    });
    it.skipIf(process.getuid?.() === 0).each(["app-server-daemon", "app-server-control"])("access guard detects an unreadable retained lock in %s before launching Codex", directory => {
        const path = fixture();
        mkdirSync(join(path, directory), { mode: 0o700 });
        writeFileSync(join(path, directory, "daemon.lock"), "private", { mode: 0o000 });
        const script = codexStateAccessScript.replace("root = '/home/ccc/.codex'", `root = ${JSON.stringify(path)}`);
        const result = realSpawn("python3", ["-c", script], { encoding: "utf-8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Unreadable Codex state file");
    });
    it.skipIf(process.getuid?.() === 0).each(["history.jsonl", "auth.json", "config.toml", "state.sqlite-wal", "sessions/record.jsonl"])("rejects readable but unwritable runtime state %s", relative => {
        const path = fixture();
        mkdirSync(join(path, "sessions"));
        writeFileSync(join(path, relative), "retained", { mode: 0o444 });
        const script = codexStateAccessScript.replace("root = '/home/ccc/.codex'", `root = ${JSON.stringify(path)}`);
        const result = realSpawn("python3", ["-c", script], { encoding: "utf-8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Unwritable Codex runtime state file");
    });
    it("permits read-only plugin assets and Harness git objects", () => {
        const path = fixture();
        mkdirSync(join(path, "plugins", "cache"), { recursive: true });
        mkdirSync(join(path, "harness", ".git", "objects"), { recursive: true });
        writeFileSync(join(path, "plugins", "cache", "asset.json"), "asset", { mode: 0o444 });
        writeFileSync(join(path, "harness", ".git", "objects", "object"), "object", { mode: 0o444 });
        const script = codexStateAccessScript.replace("root = '/home/ccc/.codex'", `root = ${JSON.stringify(path)}`);
        const result = realSpawn("python3", ["-c", script], { encoding: "utf-8" });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
    });
});

describe.skipIf(process.platform !== "linux" || realSpawn("python3", ["--version"]).status !== 0)("live Codex filesystem fixtures", () => {
    function fixture() {
        const path = mkdtempSync(join(tmpdir(), "ccc-codex-access-"));
        fixtures.push(path, `${path}-moved`);
        mkdirSync(join(path, "app-server-daemon"), { mode: 0o700 });
        mkdirSync(join(path, "sessions"), { mode: 0o700 });
        writeFileSync(join(path, "preserved.txt"), "retained state sentinel", { mode: 0o600 });
        return path;
    }
    function snapshot(path: string) {
        const info = realLstat(path);
        return { uid: info.uid, gid: info.gid, mode: info.mode, dev: info.dev, ino: info.ino,
            nlink: info.nlink, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
            content: readFileSync(path, "utf-8") };
    }
    function execute(path: string, hook = "", retainedRoot = path, moved = false) {
        const before = snapshot(join(retainedRoot, "preserved.txt"));
        // Only the public script's root changes. All hooks wrap real stdlib operations
        // over this private fixture; the production script itself runs unmodified.
        const script = codexStateAccessScript.replace("root = '/home/ccc/.codex'", `root = ${JSON.stringify(path)}`);
        const result = realSpawn("python3", ["-c", `import os, errno, socket
_fixture_root = ${JSON.stringify(path)}
_fixture_lstat, _fixture_access, _fixture_walk, _fixture_scandir = os.lstat, os.access, os.walk, os.scandir
_fixture_sockets = []
def _fixture_bind(path):
    endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous_directory = os.getcwd()
    try:
        os.chdir(os.path.dirname(path))
        endpoint.bind(os.path.basename(path))
    finally:
        os.chdir(previous_directory)
    _fixture_sockets.append(endpoint)
${hook}
${script}`], { encoding: "utf-8" });
        expect(snapshot(join(moved ? `${retainedRoot}-moved` : retainedRoot, "preserved.txt"))).toEqual(before);
        return result;
    }
    function removeListed(relative: string, operation: "unlink" | "rmdir") {
        return `_fixture_remove_target = os.path.join(_fixture_root, ${JSON.stringify(relative)})
def _fixture_racing_walk(*args, **kwargs):
    for directory, dirs, files in _fixture_walk(*args, **kwargs):
        if directory == os.path.dirname(_fixture_remove_target) and os.path.basename(_fixture_remove_target) in dirs + files:
            os.${operation}(_fixture_remove_target)
            print('fixture: enumerated then removed')
        yield directory, dirs, files
os.walk = _fixture_racing_walk`;
    }
    function overrideAccess(relative: string, mode: string, remove = false, directory = false) {
        return `_fixture_target = os.path.join(_fixture_root, ${JSON.stringify(relative)})
def _fixture_checked_access(path, requested, *args, **kwargs):
    accessible = _fixture_access(path, requested, *args, **kwargs)
    if os.fspath(path) == _fixture_target and requested & ${mode}:
        ${remove ? `os.${directory ? "rmdir" : "unlink"}(_fixture_target)` : "assert _fixture_lstat(_fixture_target)"}
        print('fixture: access returned false')
        return False
    return accessible
os.access = _fixture_checked_access`;
    }
    function foreignOwner(relative: string) {
        return `_fixture_target = os.path.join(_fixture_root, ${JSON.stringify(relative)})
def _fixture_foreign_lstat(path, *args, **kwargs):
    info = _fixture_lstat(path, *args, **kwargs)
    if os.fspath(path) == _fixture_target:
        values = list(info)
        values[4] = os.geteuid() + 1
        print('fixture: observed foreign owner')
        return os.stat_result(values)
    return info
os.lstat = _fixture_foreign_lstat`;
    }

    it.each([
        ["reported socket", "app-server-daemon/daemon-updater.sock", "socket"],
        ["differently named socket", "app-server-daemon/other-endpoint.sock", "socket"],
        ["regular file", "sessions/record.jsonl", "file"],
    ])("live Codex access probe: tolerates an enumerated %s removed before metadata", (_label, relative, kind) => {
        const path = fixture();
        if (kind === "file") writeFileSync(join(path, relative), "transient");
        const setup = kind === "socket" ? `_fixture_bind(os.path.join(_fixture_root, ${JSON.stringify(relative)}))\n` : "";
        const result = execute(path, setup + removeListed(relative, "unlink"));
        expect(result.stdout).toContain("fixture: enumerated then removed");
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
    it.each([["read", "os.R_OK"], ["write", "os.W_OK"]])("live Codex access probe: tolerates a file removed during its %s check", (_label, mode) => {
        const path = fixture();
        writeFileSync(join(path, "sessions", "record.jsonl"), "transient");
        const result = execute(path, overrideAccess("sessions/record.jsonl", mode, true));
        expect(result.stdout).toContain("fixture: access returned false");
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
    it("live Codex access probe: tolerates a listed child disappearing before real os.walk descent", () => {
        const path = fixture();
        const result = execute(path, removeListed("sessions", "rmdir"));
        expect(result.stdout).toContain("fixture: enumerated then removed");
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
    it.each(["metadata", "access"])("live Codex access probe: tolerates a yielded directory disappearing before %s", phase => {
        const path = fixture();
        const hook = phase === "access" ? overrideAccess("sessions", "os.R_OK | os.W_OK | os.X_OK", true, true) : `
def _fixture_racing_walk(*args, **kwargs):
    for directory, dirs, files in _fixture_walk(*args, **kwargs):
        if directory == os.path.join(_fixture_root, 'sessions'):
            os.rmdir(directory)
            print('fixture: yielded directory removed')
        yield directory, dirs, files
os.walk = _fixture_racing_walk`;
        const result = execute(path, hook);
        expect(result.stdout).toContain(phase === "access" ? "fixture: access returned false" : "fixture: yielded directory removed");
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
    it.each([
        ["readable file", "sessions/record.jsonl", "os.R_OK", "Unreadable Codex state file"],
        ["writable file", "sessions/record.jsonl", "os.W_OK", "Unwritable Codex runtime state file"],
        ["accessible directory", "sessions", "os.R_OK | os.W_OK | os.X_OK", "Inaccessible Codex state directory"],
    ])("live Codex access probe: refuses a retained entry failing its %s requirement even as root", (_label, relative, mode, diagnostic) => {
        const path = fixture();
        writeFileSync(join(path, "sessions", "record.jsonl"), "retained");
        const result = execute(path, overrideAccess(relative, mode));
        expect(result.stdout).toContain("fixture: access returned false");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(diagnostic);
    });
    it.each([
        ["file", "app-server-daemon/private.lock"],
        ["socket", "app-server-daemon/private.sock"],
        ["directory", "app-server-daemon"],
    ])("live Codex access probe: refuses a retained foreign-owned private %s even as root", (kind, relative) => {
        const path = fixture();
        if (kind === "file") writeFileSync(join(path, relative), "retained");
        const setup = kind === "socket" ? `_fixture_bind(os.path.join(_fixture_root, ${JSON.stringify(relative)}))\n` : "";
        const result = execute(path, setup + foreignOwner(relative));
        expect(result.stdout).toContain("fixture: observed foreign owner");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("belongs to another user");
    });
    it("live Codex access probe: a missing first sibling cannot hide a retained inaccessible sibling", () => {
        const path = fixture();
        for (const name of ["00-vanished.jsonl", "99-retained.jsonl"]) writeFileSync(join(path, "sessions", name), name);
        const hook = removeListed("sessions/00-vanished.jsonl", "unlink").replace(
            "        yield directory, dirs, files", "        files.sort()\n        yield directory, dirs, files",
        ) + "\n" + overrideAccess("sessions/99-retained.jsonl", "os.R_OK");
        const result = execute(path, hook);
        expect(result.stdout).toContain("fixture: enumerated then removed");
        expect(result.stdout).toContain("fixture: access returned false");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Unreadable Codex state file");
        expect(result.stderr).toContain("99-retained.jsonl");
    });
    it.each(["metadata", "walk"])("live Codex access probe: propagates %s permission and non-ENOENT filesystem errors", boundary => {
        const path = fixture();
        writeFileSync(join(path, "sessions", "record.jsonl"), "retained");
        for (const [error, diagnostic] of [["PermissionError(errno.EACCES, 'fixture denial', _fixture_target)", "PermissionError"], ["OSError(errno.EIO, 'fixture I/O failure', _fixture_target)", "fixture I/O failure"]] as const) {
            const relative = boundary === "walk" ? "sessions" : "sessions/record.jsonl";
            const operation = boundary === "walk" ? "scandir" : "lstat";
            const result = execute(path, `_fixture_target = os.path.join(_fixture_root, ${JSON.stringify(relative)})
def _fixture_failed_operation(path, *args, **kwargs):
    if os.fspath(path) == _fixture_target:
        _fixture_lstat(path)
        print('fixture: injected filesystem error')
        raise ${error}
    return _fixture_${operation}(path, *args, **kwargs)
os.${operation} = _fixture_failed_operation`);
            expect(result.stdout).toContain("fixture: injected filesystem error");
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(diagnostic);
        }
    });
    it.each([
        ["unknown filename", "FileNotFoundError(errno.ENOENT, 'fixture missing filename')"],
        ["outside filename", "FileNotFoundError(errno.ENOENT, 'fixture outside filename', _fixture_root + '-outside')"],
        ["root filename", "FileNotFoundError(errno.ENOENT, 'fixture root filename', _fixture_root)"],
    ])("live Codex access probe: refuses os.walk ENOENT with an %s", (_label, error) => {
        const path = fixture();
        const result = execute(path, `def _fixture_failed_scandir(path):
    if os.fspath(path) == os.path.join(_fixture_root, 'sessions'):
        print('fixture: walk ENOENT')
        raise ${error}
    return _fixture_scandir(path)
os.scandir = _fixture_failed_scandir`);
        expect(result.stdout).toContain("fixture: walk ENOENT");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("FileNotFoundError");
    });
    it.each(["missing", "symlink"])("live Codex access probe: refuses an initially %s state root", kind => {
        const path = fixture();
        const probeRoot = join(path, "probe-root");
        if (kind === "symlink") symlinkSync(join(path, "sessions"), probeRoot);
        const result = execute(probeRoot, "", path);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Codex state root");
    });
    it.each(["vanished", "symlinked"])("live Codex access probe: refuses a root %s after real enumeration", kind => {
        const path = fixture();
        const result = execute(path, `def _fixture_racing_walk(*args, **kwargs):
    for directory, dirs, files in _fixture_walk(*args, **kwargs):
        if directory == _fixture_root:
            os.rename(_fixture_root, _fixture_root + '-moved')
            ${kind === "symlinked" ? "os.symlink(_fixture_root + '-moved', _fixture_root)" : "pass"}
            print('fixture: root changed after enumeration')
        yield directory, dirs, files
os.walk = _fixture_racing_walk`, path, true);
        expect(result.stdout).toContain("fixture: root changed after enumeration");
        expect(result.status).not.toBe(0);
        if (kind === "vanished") {
            expect(result.stderr).toContain("FileNotFoundError");
            expect(result.stderr).toContain(path);
        } else {
            expect(result.stderr).toContain("Codex state root");
        }
    });
});
