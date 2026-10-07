import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("fs", () => ({ lstatSync: mocks.lstat, realpathSync: mocks.realpath }));
vi.mock("../utils.js", () => ({ getCodexDir: (profile?: string) => profile ? `/home/test/.ccc/profiles/${profile}/codex` : "/home/test/.ccc/codex" }));
vi.mock("../container-runtime.js", () => ({ runtimeCli: () => "docker", getRuntimeInfo: () => ({ rootless: false, flavor: "docker-native" }) }));
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
