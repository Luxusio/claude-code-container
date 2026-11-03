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

const liveRepairFilesystem = String.raw`
import ctypes, os, shutil, stat, sys, tempfile
scenario = sys.argv[1]
state = tempfile.mkdtemp(prefix='ccc-codex-private-repair-')
os.mkdir(state + '/tmp', 0o700)
with open(state + '/config.toml', 'w') as file: file.write('keep configuration')
os.chmod(state + '/config.toml', 0o644)
with open(state + '/tmp/stable', 'w') as file: file.write('running session')
os.chmod(state + '/tmp/stable', 0o600)
if scenario == 'parent-replaced':
    with open(state + '/tmp/repair', 'w') as file: file.write('original')
    os.chmod(state + '/tmp/repair', 0o644)
sys.argv = ['repair', str(os.getuid()), str(os.getgid())]
real_listdir, real_chmod, real_cdll = os.listdir, os.chmod, ctypes.CDLL
writes = []
def chmod(path, mode, **options):
    writes.append(os.path.realpath(path))
    return real_chmod(path, mode, **options)
os.chmod = chmod
changed = False
def listdir(path):
    global changed
    names = real_listdir(path)
    if scenario.startswith('runtime-') and isinstance(path, int) and os.path.realpath('/proc/self/fd/' + str(path)) == state + '/tmp' and not changed:
        changed = True
        # Rotate a file after enumeration, as another same-user Codex session does.
        if scenario == 'runtime-removed': os.unlink(state + '/tmp/stable')
        with open(state + '/tmp/rotated', 'w') as file: file.write('new runtime state')
        real_chmod(state + '/tmp/rotated', 0o600)
    return names
os.listdir = listdir
def cdll(*args, **options):
    if scenario == 'parent-replaced':
        os.rename(state + '/tmp', state + '/original-tmp')
        os.mkdir(state + '/tmp', 0o700)
        with open(state + '/tmp/repair', 'w') as file: file.write('replacement')
        real_chmod(state + '/tmp/repair', 0o644)
    if scenario == 'selected-replaced':
        os.rename(state + '/config.toml', state + '/original-config')
        with open(state + '/config.toml', 'w') as file: file.write('replacement')
        real_chmod(state + '/config.toml', 0o644)
    return real_cdll(*args, **options)
ctypes.CDLL = cdll
`;

describe.skipIf(!available || process.platform !== "linux")("Codex private repair with live runtime state", () => {
    it.each(["runtime-churn", "runtime-removed", "selected-replaced", "parent-replaced"])("handles %s without rewriting unrelated state", scenario => {
        const production = CODEX_PRIVATE_STATE_GRANT.replace("root = '/home/ccc/.codex'", "root = state");
        const assertion = String.raw`
except RuntimeError as error:
    assert scenario in ('selected-replaced', 'parent-replaced'), str(error)
    assert 'identity changed' in str(error), str(error)
    assert writes == [], writes
    assert stat.S_IMODE(os.stat(state + '/config.toml').st_mode) == 0o644
    if scenario == 'selected-replaced':
        assert open(state + '/config.toml').read() == 'replacement'
        assert stat.S_IMODE(os.stat(state + '/original-config').st_mode) == 0o644
    else:
        assert open(state + '/tmp/repair').read() == 'replacement'
        assert stat.S_IMODE(os.stat(state + '/original-tmp/repair').st_mode) == 0o644
else:
    assert scenario.startswith('runtime-')
    assert changed
    assert writes == [state + '/config.toml'], writes
    assert open(state + '/config.toml').read() == 'keep configuration'
    assert stat.S_IMODE(os.stat(state + '/config.toml').st_mode) == 0o600
    assert open(state + '/tmp/rotated').read() == 'new runtime state'
finally:
    shutil.rmtree(state)
`;
        const script = liveRepairFilesystem + "\ntry:\n" + production.split("\n").map(line => "    " + line).join("\n") + assertion;
        const result = spawnSync(python!, ["-I", "-", scenario], { input: script, encoding: "utf8", windowsHide: true, timeout: 5000 });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });
});
