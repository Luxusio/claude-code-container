import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OPENCODE_DATA_DIRECTORY_ACL, prepareOpenCodeDataDirectory } from "../opencode-data-access.js";

const state = vi.hoisted(() => ({ home: "", spawn: vi.fn() }));
vi.mock("os", async (original) => ({ ...await original<typeof import("os")>(), homedir: () => state.home }));
vi.mock("child_process", async (original) => ({ ...await original<typeof import("child_process")>(), spawnSync: state.spawn }));
vi.mock("fs", async (original) => {
    const fs = await original<typeof import("fs")>();
    return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
vi.mock("../container-runtime.js", () => ({ runtimeCli: () => "docker" }));

const realFs = await vi.importActual<typeof import("fs")>("fs");
const realProcess = await vi.importActual<typeof import("child_process")>("child_process");
const lstat = vi.mocked(lstatSync);
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const success = { status: 0, stdout: "", stderr: "" };
let directory: string;

beforeEach(() => {
    state.home = mkdtempSync(join(tmpdir(), "ccc-opencode-access-"));
    directory = join(state.home, ".local", "share", "opencode");
    mkdirSync(directory, { recursive: true });
    if (typeof process.getuid !== "function") {
        Object.defineProperty(process, "getuid", { value: () => statSync(directory).uid, configurable: true });
    }
    lstat.mockReset().mockImplementation(realFs.lstatSync);
    state.spawn.mockReset().mockReturnValue(success);
});

afterEach(() => {
    vi.restoreAllMocks();
    if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
    rmSync(state.home, { recursive: true, force: true });
});

function deniedThenLookup(uid = "2001\n") {
    state.spawn.mockReturnValueOnce({ ...success, status: 3 });
    state.spawn.mockReturnValueOnce({ ...success, stdout: uid });
}

describe("prepareOpenCodeDataDirectory", () => {
    it("returns after one bounded default-user probe when access is healthy", () => {
        const before = statSync(directory);
        prepareOpenCodeDataDirectory("ccc-test");
        expect(state.spawn).toHaveBeenCalledExactlyOnceWith("docker", [
            "exec", "-w", "/", "ccc-test", "/bin/sh", "-c", expect.stringContaining("exit 3"),
        ], { encoding: "utf-8", timeout: 10000 });
        expect(lstat).not.toHaveBeenCalled();
        expect(statSync(directory)).toEqual(before);
    });

    it("checks host ownership and actual container UID before granting, then verifies as the default user", () => {
        deniedThenLookup("100001\n");
        prepareOpenCodeDataDirectory("ccc-test");
        expect(lstat).toHaveBeenCalledExactlyOnceWith(directory);
        const calls = state.spawn.mock.calls;
        expect(calls).toHaveLength(4);
        expect(calls[1][1]).toEqual(["exec", "-w", "/", "ccc-test", "/bin/sh", "-c", "/usr/bin/id -u"]);
        expect(calls[2][1].slice(0, -1)).toEqual(["exec", "--user", "root", "-w", "/", "ccc-test", "/bin/sh", "-c"]);
        expect(calls[2][1].at(-1)).toContain(`/usr/bin/timeout 8s /usr/bin/python3 -I - 100001 ${statSync(directory).uid} <<'CCC_OPENCODE_ACL'`);
        expect(calls[2][1].at(-1)).toContain(OPENCODE_DATA_DIRECTORY_ACL);
        expect(calls[3][1]).toEqual(calls[0][1]);
        for (const call of calls) expect(call[2]).toEqual({ encoding: "utf-8", timeout: 10000 });
    });

    it.each([
        ["runtime exit", { status: 1, stderr: "container is not running" }, "container is not running"],
        ["spawn error", { status: null, error: new Error("spawn docker ENOENT") }, "spawn docker ENOENT"],
        ["timeout", { status: null, error: new Error("spawn docker ETIMEDOUT") }, "spawn docker ETIMEDOUT"],
        ["signal", { status: null, signal: "SIGTERM" }, "exit unknown"],
        ["denial with a spawn error", { status: 3, error: new Error("runtime failed") }, "runtime failed"],
    ])("does not repair after %s", (_name, result, cause) => {
        state.spawn.mockReturnValueOnce({ ...success, ...result });
        expect(() => prepareOpenCodeDataDirectory("ccc-test")).toThrow(`Unable to prepare OpenCode data at ${directory}: access check failed (${cause})`);
        expect(state.spawn).toHaveBeenCalledTimes(1);
        expect(lstat).not.toHaveBeenCalled();
    });

    it.each(["missing", "file", "symlink", "foreign owner", "identity unavailable"])("refuses a host directory with %s", (kind) => {
        deniedThenLookup();
        if (kind === "missing" || kind === "file") {
            rmSync(directory, { recursive: true });
            if (kind === "file") writeFileSync(directory, "unchanged");
        } else if (kind === "symlink") {
            // Model lstat's symlink result even on Windows without symlink privileges.
            lstat.mockReturnValueOnce(Object.assign(statSync(directory), { isDirectory: () => false, isSymbolicLink: () => true }));
        } else if (kind === "foreign owner") {
            lstat.mockReturnValueOnce(Object.assign(statSync(directory), { uid: process.getuid!() + 1 }));
        } else {
            Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
        }
        expect(() => prepareOpenCodeDataDirectory("ccc-test")).toThrow(kind === "missing" ? "ENOENT" : "non-symlink directory owned by the host user");
        expect(state.spawn).toHaveBeenCalledTimes(1);
        if (kind === "file") expect(readFileSync(directory, "utf8")).toBe("unchanged");
    });

    it.each(["", "-1", "1001; id", "1.5", "NaN", "4294967295", "99999999999999999999"])("refuses invalid container UID %j without privileged execution", (uid) => {
        deniedThenLookup(uid);
        expect(() => prepareOpenCodeDataDirectory("ccc-test")).toThrow("invalid container user identity");
        expect(state.spawn).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["container user lookup", 1, "id: unavailable"],
        ["directory ACL grant", 2, "python3: not found"],
        ["access verification", 3, "still denied"],
    ])("preserves a failure from %s", (operation, index, stderr) => {
        const results = [
            { ...success, status: 3 }, { ...success, stdout: "2001\n" }, success, success,
        ];
        results[index] = { ...success, status: index === 3 ? 3 : 1, stderr };
        for (const result of results) state.spawn.mockReturnValueOnce(result);
        expect(() => prepareOpenCodeDataDirectory("ccc-test")).toThrow(`${operation} failed (${stderr})`);
        expect(state.spawn).toHaveBeenCalledTimes(index + 1);
    });
});

interface Snapshot {
    uid: number;
    gid: number;
    mode: number;
    inode: number;
    mtime: string;
    ctime: string;
    access: number[][] | null;
    defaults: number[][] | null;
}

function python(script: string, args: string[] = []) {
    return realProcess.spawnSync("/usr/bin/python3", ["-I", "-", ...args], { input: script, encoding: "utf8", timeout: 10000 });
}

function snapshot(path = directory): Snapshot {
    const result = python(String.raw`
import errno, json, os, struct, sys
p = sys.argv[1]
s = os.stat(p)
def acl(name):
    try:
        return list(struct.iter_unpack("<HHI", os.getxattr(p, "system.posix_acl_" + name)[4:]))
    except OSError as error:
        if error.errno != errno.ENODATA:
            raise
        return None
print(json.dumps(dict(uid=s.st_uid, gid=s.st_gid, mode=s.st_mode & 0o7777,
    inode=s.st_ino, mtime=str(s.st_mtime_ns), ctime=str(s.st_ctime_ns),
    access=acl("access"), defaults=acl("default"))))
`, [path]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
}

function grantScript(path = directory) {
    return OPENCODE_DATA_DIRECTORY_ACL.replace("/home/ccc/.local/share/opencode", path);
}

const grantUid = process.getuid?.() === 2001 ? 2002 : 2001;

function grant(path = directory, prefix = "", uid = String(grantUid)) {
    return python(prefix + grantScript(path), [uid, String(statSync(directory).uid)]);
}

function setAcl(kind: "access" | "default", entries: number[][]) {
    const result = python(String.raw`
import json, os, struct, sys
entries = json.loads(sys.argv[3])
encoded = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
os.setxattr(sys.argv[1], "system.posix_acl_" + sys.argv[2], encoded)
`, [directory, kind, JSON.stringify(entries)]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
}

const undefinedId = 0xffffffff;
const canonical = (group = 5, other = 1, uid = grantUid) => [
    [1, 7, undefinedId], [2, 7, uid], [4, group, undefinedId], [16, 7, undefinedId], [32, other, undefinedId],
];

describe.skipIf(process.platform !== "linux")("actual Linux directory ACL script", () => {
    let child: string;
    beforeEach(() => {
        chmodSync(directory, 0o751);
        child = join(directory, "existing-data");
        writeFileSync(child, "preserve this data\n", { mode: 0o640 });
    });

    it("grants only the named UID while preserving ownership, effective group/other access and child metadata", () => {
        const before = snapshot();
        const childBefore = snapshot(child);
        expect(before.uid).not.toBe(grantUid);
        expect(before.access).toBeNull();
        const result = grant();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const after = snapshot();
        expect(after).toMatchObject({ uid: before.uid, gid: before.gid, inode: before.inode, defaults: null });
        expect(after.access).toEqual(canonical());
        expect(after.mode & 0o700).toBe(before.mode & 0o700);
        expect(after.access![2][1] & after.access![3][1]).toBe((before.mode >> 3) & 7);
        expect(after.mode & 7).toBe(before.mode & 7);
        expect(snapshot(child)).toEqual(childBefore);
        expect(readFileSync(child, "utf8")).toBe("preserve this data\n");
    });

    it("refuses a mounted directory owned by a different host principal", () => {
        const before = snapshot();
        const childBefore = snapshot(child);
        const result = python(grantScript(), [String(grantUid), String(before.uid + 1)]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("mounted data directory is not owned by the host user");
        expect(snapshot()).toEqual(before);
        expect(snapshot(child)).toEqual(childBefore);
    });

    it("accepts an exact repeated grant without rewriting its ACL or metadata", () => {
        expect(grant().status).toBe(0);
        const afterFirst = snapshot();
        const childBefore = snapshot(child);
        expect(grant().status).toBe(0);
        expect(snapshot()).toEqual(afterFirst);
        expect(snapshot(child)).toEqual(childBefore);
    });

    it("serializes competing grants and leaves the exact canonical ACL", async () => {
        const childBefore = snapshot(child);
        const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
            const worker = realProcess.spawn("/usr/bin/python3", ["-I", "-", String(grantUid), String(statSync(directory).uid)], { stdio: ["pipe", "ignore", "pipe"], timeout: 10000 });
            let stderr = "";
            worker.stderr.on("data", (chunk) => { stderr += chunk; });
            worker.on("error", reject);
            worker.on("close", (status) => resolve({ status, stderr }));
            // Widen the lock-held window so competing processes encounter it.
            worker.stdin.end(`import fcntl, time\noriginal_flock = fcntl.flock\ndef held_flock(fd, operation):\n    original_flock(fd, operation)\n    time.sleep(0.05)\nfcntl.flock = held_flock\n` + grantScript());
        })));
        expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 0, stderr: "" })));
        expect(snapshot().access).toEqual(canonical());
        expect(snapshot(child)).toEqual(childBefore);
    });

    it.each(["ancestor", "final"])("refuses a symlink in the %s path without touching its target", (kind) => {
        const before = snapshot();
        const childBefore = snapshot(child);
        const link = join(state.home, "link");
        symlinkSync(kind === "ancestor" ? join(state.home, ".local") : directory, link);
        const result = grant(kind === "ancestor" ? join(link, "share", "opencode") : link);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/Not a directory|Too many levels of symbolic links/);
        expect(snapshot()).toEqual(before);
        expect(snapshot(child)).toEqual(childBefore);
    });

    it.each([
        ["custom access", "access", canonical(5, 1, grantUid + 1)],
        ["masked access", "access", canonical().map((entry) => entry[0] === 16 ? [16, 5, undefinedId] : entry)],
        ["default", "default", [[1, 7, undefinedId], [4, 5, undefinedId], [32, 1, undefinedId]]],
    ] as const)("refuses an existing %s ACL without changing any metadata", (_name, kind, entries) => {
        setAcl(kind, entries.map((entry) => [...entry]));
        const before = snapshot();
        const childBefore = snapshot(child);
        const result = grant();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`existing ${kind} ACL requires manual inspection`);
        expect(snapshot()).toEqual(before);
        expect(snapshot(child)).toEqual(childBefore);
    });

    it.each(["getxattr", "setxattr"])("fails closed on unsupported %s without chmod fallback", (operation) => {
        const before = snapshot();
        const childBefore = snapshot(child);
        const result = grant(directory, `import errno, os\ndef unsupported(*args, **kwargs):\n    raise OSError(errno.EOPNOTSUPP, "fixture xattrs unsupported")\nos.${operation} = unsupported\ndef forbidden(*args, **kwargs):\n    raise AssertionError("chmod fallback attempted")\nos.chmod = os.fchmod = forbidden\n`);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("fixture xattrs unsupported");
        expect(result.stderr).not.toContain("chmod fallback attempted");
        expect(snapshot()).toEqual(before);
        expect(snapshot(child)).toEqual(childBefore);
    });

    it("keeps all mutations on the pinned inode after its path is replaced", () => {
        const before = snapshot();
        const childBefore = snapshot(child);
        const pinned = join(state.home, "pinned-original");
        const result = grant(directory, `import fcntl, os\noriginal_flock = fcntl.flock\ndef replace_after_lock(fd, operation):\n    original_flock(fd, operation)\n    os.rename(${JSON.stringify(directory)}, ${JSON.stringify(pinned)})\n    os.mkdir(${JSON.stringify(directory)}, 0o751)\nfcntl.flock = replace_after_lock\n`);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(snapshot(pinned)).toMatchObject({ inode: before.inode, uid: before.uid, gid: before.gid, access: canonical() });
        expect(snapshot(directory)).toMatchObject({ access: null, defaults: null, mode: 0o751 });
        expect(snapshot(directory).inode).not.toBe(before.inode);
        expect(snapshot(join(pinned, "existing-data"))).toEqual(childBefore);
        expect(readFileSync(join(pinned, "existing-data"), "utf8")).toBe("preserve this data\n");
    });
});
