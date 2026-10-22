import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_PRIVATE_STATE_GRANT, CODEX_STATE_OWNER_PROBE } from "../adapters/windows-credential-access.js";

// Execute the production Python rather than substituting a successful Docker probe.
const python = process.platform === "win32"
    ? spawnSync("where.exe", ["python"], { encoding: "utf8", windowsHide: true }).stdout?.trim().split(/\r?\n/).find(path => !/\\WindowsApps\\/i.test(path))
    : "python3";
const version = python ? spawnSync(python, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 }) : undefined;
const available = version?.status === 0 && /^Python 3\./.test(version.stdout ?? "");

const filesystem = String.raw`
import os, posixpath, stat, sys
from types import SimpleNamespace
root = '/home/ccc/.codex'
scenario = sys.argv[1]
walked = []
os.geteuid = lambda: 1000
os.listdir = lambda path: ['installation_id', 'sessions', 'archived_sessions', 'logs', 'tmp', 'app-server-control', 'app-server-daemon']
def metadata(path):
    if scenario == 'vanished_runtime' and path == root + '/tmp/record': raise FileNotFoundError(path)
    if scenario == 'denied_runtime' and path == root + '/tmp/record': raise PermissionError(path)
    directory = path == root or path.rsplit('/', 1)[-1] in ('sessions', 'archived_sessions', 'logs', 'tmp', 'app-server-control', 'app-server-daemon')
    foreign = (scenario == 'root' and path == root) or (scenario == 'installation_id' and path == root + '/installation_id') or (scenario == 'private_file' and path == root + '/tmp/record')
    return SimpleNamespace(st_uid=1001 if foreign else 1000, st_mode=(stat.S_IFDIR if directory else stat.S_IFREG) | 0o700)
os.lstat = metadata
os.path.lexists = lambda path: True
os.path.islink = lambda path: (scenario == 'linked_private_root' and path == root + '/tmp') or path.endswith('/link')
def walk(path, **options):
    if path.rsplit('/', 1)[-1] in ('sessions', 'archived_sessions', 'logs'):
        raise RuntimeError('Traversing large historical state exceeds the short probe budget')
    walked.append(path)
    yield path, [], ['record', 'link']
os.walk = walk
os.path.join = posixpath.join
`;

describe.skipIf(!available)("executable Codex owner probe", () => {
    it("ignores large history trees while checking all private state roots", () => {
        const script = filesystem + CODEX_STATE_OWNER_PROBE + "\nassert walked == [root+'/app-server-control', root+'/app-server-daemon', root+'/tmp']\nprint('private state checked without history traversal')\n";
        const result = spawnSync(python!, ["-I", "-", "healthy"], { input: script, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("private state checked without history traversal");
    });

    it("tolerates a runtime file removed while the ownership probe is walking", () => {
        const result = spawnSync(python!, ["-I", "-", "vanished_runtime"], { input: filesystem + CODEX_STATE_OWNER_PROBE, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });

    it("does not treat a permission-denied runtime file as a transient disappearance", () => {
        const result = spawnSync(python!, ["-I", "-", "denied_runtime"], { input: filesystem + CODEX_STATE_OWNER_PROBE, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("PermissionError");
    });

    it.each(["root", "installation_id", "private_file", "linked_private_root"])("still requests repair for %s", scenario => {
        const result = spawnSync(python!, ["-I", "-", scenario], { input: filesystem + CODEX_STATE_OWNER_PROBE, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(1);
    });
});

const repairFilesystem = String.raw`
import builtins, ctypes, io, os, stat, sys
from types import SimpleNamespace
scenario = sys.argv[1]
os.O_DIRECTORY, os.O_NOFOLLOW, os.O_PATH = 0, 0, 0
sys.argv = ['repair', '1000', '1000']
root = '/home/ccc/.codex'
owner = 1001 if scenario in ('foreign', 'foreign-user') else 0
group = 1001 if scenario in ('foreign', 'foreign-group') else 0
metadata = {
    10: SimpleNamespace(st_dev=1, st_ino=10, st_mode=stat.S_IFDIR | 0o700, st_uid=1000, st_gid=1000, st_nlink=1),
    11: SimpleNamespace(st_dev=2 if scenario == 'filesystem' else 1, st_ino=11, st_mode=stat.S_IFREG | 0o600, st_uid=owner, st_gid=group, st_nlink=1),
}
os.open = lambda name, flags, **kw: 11 if name == 'config.toml' else 10
os.close = lambda fd: None
os.listdir = lambda fd: ['config.toml']
os.fstat = lambda fd: metadata[fd]
def observed(name, **kw):
    if name == root: return metadata[10]
    if name == 'config.toml': return metadata[11]
    raise FileNotFoundError(name)
os.stat = observed
builtins.open = lambda *a, **kw: io.StringIO('')
writes = []
def chown(fd, name, uid, gid, flags):
    writes.append(fd)
    metadata[fd].st_uid, metadata[fd].st_gid = uid, gid
    return 0
libc = SimpleNamespace(fchownat=chown)
ctypes.CDLL = lambda *a, **kw: libc
os.chmod = lambda *a: None
os.fchown = lambda *a: None
os.fchmod = lambda *a: None
`;

describe.skipIf(!available)("executable Codex private state repair", () => {
    it.each(["root-owned", "foreign", "foreign-user", "foreign-group", "filesystem"])("validates %s entries before ownership writes", scenario => {
        const script = repairFilesystem + "\ntry:\n" + CODEX_PRIVATE_STATE_GRANT.split("\n").map(line => "    " + line).join("\n")
            + "\nexcept RuntimeError:\n    assert scenario != 'root-owned'\n    assert writes == []\nelse:\n    assert scenario == 'root-owned'\n    assert writes == [11]\n    assert metadata[11].st_uid == 1000\n";
        const result = spawnSync(python!, ["-I", "-", scenario], { input: script, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
});
