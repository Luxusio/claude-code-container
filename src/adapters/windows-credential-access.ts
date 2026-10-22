import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { bindNativeRuntimeInvocation, captureNativeRuntimeInvocation, currentNativeRuntimeInvocation, type BoundNativeSpawnSync } from "../container-runtime.js";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalWindowsPowerShellPath, hiddenWindowsPowerShellArgs } from "@ccc/device-lab/windows-system-powershell.js";
import { createWindowsCodexRecovery } from "../application/credentials/windows-codex-recovery.js";
import type { WindowsCodexRecoveryPorts } from "../ports/credentials/windows-codex-recovery.js";

export const CREDENTIAL_ACCESS_GRANT = String.raw`
import os, stat, struct, sys
import errno
uid = int(sys.argv[1])
groups = {int(group) for group in sys.argv[3].split()}
root_path = sys.argv[2].rstrip("/")
mounts = set()
with open("/proc/self/mountinfo") as mountinfo:
    for line in mountinfo:
        mounted = line.split()[4].replace(r"\040", " ").replace(r"\011", "\t").replace(r"\134", "\\")
        if mounted.startswith(root_path + "/"): mounts.add(mounted)
if not 0 <= uid < 0xffffffff:
    raise RuntimeError("invalid container user identity")
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
def grant(fd, path):
    metadata = os.fstat(fd)
    directory = stat.S_ISDIR(metadata.st_mode)
    if not directory and (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1):
        return
    required = 7 if directory or metadata.st_mode & 0o111 else 6
    effective = (metadata.st_mode >> (6 if metadata.st_uid == uid else 3 if metadata.st_gid in groups else 0)) & 7
    if effective & required == required:
        already_accessible = True
    else:
        already_accessible = False
    try:
        raw = os.getxattr(fd, "system.posix_acl_access")
    except OSError as error:
        if error.errno not in (errno.ENODATA, errno.ENOTSUP):
            raise
        raw = None
    undefined = 0xffffffff
    if raw is None:
        entries = [(1, (metadata.st_mode >> 6) & 7, undefined),
                   (4, (metadata.st_mode >> 3) & 7, undefined),
                   (32, metadata.st_mode & 7, undefined)]
    else:
        if len(raw) < 4 or (len(raw)-4) % 8 or struct.unpack("<I", raw[:4])[0] != 2:
            raise RuntimeError("invalid existing credential ACL")
        entries = list(struct.iter_unpack("<HHI", raw[4:]))
        mask = next((permission for tag, permission, _ in entries if tag == 16), 7)
        entries = [(tag, permission & mask if tag in (2,4,8) else permission, identity)
                   for tag, permission, identity in entries if tag != 16]
    permission = 7 if directory or metadata.st_mode & 0o111 else 6
    if uid == metadata.st_uid:
        entries = [(tag, permission if tag == 1 else old, identity) for tag, old, identity in entries]
    else:
        entries = [entry for entry in entries if not (entry[0] == 2 and entry[2] == uid)]
        entries.append((2, permission, uid))
    mask = 0
    for tag, permission, _ in entries:
        if tag in (2,4,8): mask |= permission
    entries.append((16, mask, undefined))
    entries.sort(key=lambda entry: (entry[0], entry[2]))
    try:
        if not already_accessible:
            os.setxattr(fd, "system.posix_acl_access", struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries))
    except OSError as error:
        if error.errno != errno.ENOTSUP:
            raise
        # Desktop Windows shares may expose mode bits but no POSIX ACLs.
        # Keep owner, group and other permissions, granting through an existing
        # group of the default exec user only after host SID ownership is checked.
        permission = 7 if directory or metadata.st_mode & 0o111 else 6
        if metadata.st_uid == uid:
            os.fchmod(fd, stat.S_IMODE(metadata.st_mode) | (permission << 6))
        elif metadata.st_gid in groups:
            os.fchmod(fd, stat.S_IMODE(metadata.st_mode) | (permission << 3))
        else:
            raise RuntimeError("credential owner group is not a container user group and POSIX ACLs are unavailable")
    if directory:
        for name in os.listdir(fd):
            child_path = path + "/" + name
            if child_path in mounts:
                continue
            metadata = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                continue
            child = os.open(name, flags | (os.O_DIRECTORY if stat.S_ISDIR(metadata.st_mode) else 0), dir_fd=fd)
            try: grant(child, child_path)
            finally: os.close(child)
fd = os.open("/", flags | os.O_DIRECTORY)
try:
    for component in sys.argv[2].strip("/").split("/"):
        if component in ("", ".", ".."):
            raise RuntimeError("invalid credential directory")
        child = os.open(component, flags | os.O_DIRECTORY, dir_fd=fd)
        os.close(fd)
        fd = child
    grant(fd, root_path)
finally:
    os.close(fd)
`;

function windowsCredentialSourcePath(source: string): string {
    const desktop = /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\/(.+)$/i.exec(source);
    const path = desktop ? `${desktop[1]}:/${desktop[2]}` : source;
    if (!/^[a-z]:[\\/]/i.test(path)) throw new Error("Windows credential bind source is unavailable");
    return path;
}

export function assertWindowsCredentialDirectory(source: string): void {
    const path = windowsCredentialSourcePath(source);
    let current = resolve(path);
    while (true) {
        const metadata = lstatSync(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Windows credential directory must not traverse a link");
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) throw new Error("Windows credential owner lookup is unavailable");
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $a=[IO.Directory]::GetAccessControl($env:CCC_CREDENTIAL_ACCESS_SOURCE); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value) { throw 'Credential directory is not owned by the current Windows user' }"]),
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, CCC_CREDENTIAL_ACCESS_SOURCE: path } });
    if (result.error || result.status !== 0) throw new Error("Windows credential directory owner verification failed", { cause: result.error ?? new Error(result.stderr) });
}

export const CODEX_PRIVATE_STATE_GRANT = String.raw`
import ctypes, os, stat, sys
uid, gid = map(int, sys.argv[1:3])
root = '/home/ccc/.codex'
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open('/', flags)
for component in root.strip('/').split('/'):
    child = os.open(component, flags, dir_fd=fd)
    os.close(fd)
    fd = child
root_stat = os.fstat(fd)
root_members = sorted(os.listdir(fd))
def signature(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink)
entries, directories = [], []
def visit(parent, name):
    pinned = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
    s = os.fstat(pinned)
    if stat.S_ISLNK(s.st_mode):
        os.close(pinned)
        return
    entries.append((pinned, parent, name, s))
    # Native admission verified the Windows owner and observed same-bind users on the captured runtime.
    # CCC root setup helpers can create root-owned files on this same bind.
    if s.st_dev != root_stat.st_dev or s.st_uid not in (0, root_stat.st_uid, uid) or s.st_gid not in (0, root_stat.st_gid, gid):
        raise RuntimeError('Unconfirmed owner or filesystem in Codex private state')
    if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) or stat.S_ISSOCK(s.st_mode)):
        raise RuntimeError('Unsupported Codex private state entry')
    if s.st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise RuntimeError('Set-ID entry in Codex private state')
    if not stat.S_ISDIR(s.st_mode) and s.st_nlink != 1:
        raise RuntimeError('Multiply linked Codex private state entry')
    if stat.S_ISDIR(s.st_mode):
        readable = os.open('.', flags, dir_fd=pinned)
        names = sorted(os.listdir(readable))
        directories.append((readable, names))
        for child in names: visit(readable, child)
try:
    names = ('app-server-control', 'app-server-daemon', 'tmp', 'sessions', 'archived_sessions', 'log', 'logs', 'shell_snapshots', 'sqlite', 'memories')
    with open('/proc/self/mountinfo') as mountinfo:
        for line in mountinfo:
            path = line.split()[4]
            if any(path == root + '/' + name or path.startswith(root + '/' + name + '/') for name in names):
                raise RuntimeError('Nested mount in Codex private state')
    for name in names:
        try: os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError: continue
        visit(fd, name)
    # Codex chmods installation_id and other root state files during startup.
    # Group write permission cannot authorize chmod by a different owner.
    for name in root_members:
        if stat.S_ISREG(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
            visit(fd, name)
    for directory, names in directories:
        if sorted(os.listdir(directory)) != names:
            raise RuntimeError('Codex private state changed before repair')
    if sorted(os.listdir(fd)) != root_members:
        raise RuntimeError('Codex state root membership changed before repair')
    for pinned, parent, name, s in entries:
        if signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) != signature(s):
            raise RuntimeError('Codex private state identity changed before repair')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fchownat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
    for pinned, parent, name, s in entries:
        if signature(os.fstat(pinned)) != signature(s) or signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) != signature(s):
            raise RuntimeError('Codex private state changed during repair')
        if (s.st_uid, s.st_gid) != (uid, gid) and libc.fchownat(pinned, b'', uid, gid, 0x1000 | 0x100):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        # Private state remains private after the previous group access repair.
        mode = (stat.S_IMODE(s.st_mode) & ~0o077) | (0o700 if stat.S_ISDIR(s.st_mode) else 0o600)
        os.chmod('/proc/self/fd/' + str(pinned), mode)
        after = os.fstat(pinned)
        if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (uid, gid, mode):
            raise RuntimeError('Codex private state ownership repair did not persist')
    for directory, names in directories:
        if sorted(os.listdir(directory)) != names:
            raise RuntimeError('Codex private state membership changed during repair')
    for pinned, parent, name, s in entries:
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if signature(after) != signature(os.fstat(pinned)) or (after.st_dev, after.st_ino, after.st_uid, after.st_gid) != (s.st_dev, s.st_ino, uid, gid):
            raise RuntimeError('Codex private state identity changed after repair')
    if signature(os.stat(root, follow_symlinks=False)) != signature(root_stat):
        raise RuntimeError('Codex state root changed during private state repair')
    if sorted(os.listdir(fd)) != root_members:
        raise RuntimeError('Codex state root membership changed during repair')
    os.fchown(fd, uid, gid)
    os.fchmod(fd, 0o700)
finally:
    for pinned, *_ in entries: os.close(pinned)
    for directory, _ in directories: os.close(directory)
    os.close(fd)
`;

export const CODEX_STATE_OWNER_PROBE = String.raw`
import os, stat, sys
root = '/home/ccc/.codex'
uid = os.geteuid()
if os.lstat(root).st_uid != uid: sys.exit(1)
for entry in os.listdir(root):
    path = root + '/' + entry
    try: info = os.lstat(path)
    except FileNotFoundError: continue
    if stat.S_ISREG(info.st_mode) and info.st_uid != uid: sys.exit(1)
# Rollout archives and logs are covered by the full state access guard. Walking
# them again over a Windows bind share cannot fit this short ownership probe.
for name in ('app-server-control', 'app-server-daemon', 'tmp'):
    path = root + '/' + name
    if not os.path.lexists(path): continue
    if os.path.islink(path): sys.exit(1)
    def inaccessible(error):
        if not isinstance(error, FileNotFoundError): sys.exit(1)
    for directory, dirs, files in os.walk(path, followlinks=False, onerror=inaccessible):
        for entry in [directory] + [os.path.join(directory, file) for file in files]:
            if os.path.islink(entry): continue
            try: info = os.lstat(entry)
            except FileNotFoundError: continue
            if info.st_uid != uid: sys.exit(1)
`;

function credentialNativeRunner(cli: string, supplied?: BoundNativeSpawnSync) {
    let runner = supplied;
    if (!runner && (cli === "docker" || cli === "podman")) {
        const current = currentNativeRuntimeInvocation();
        runner = bindNativeRuntimeInvocation(current?.runtime === cli ? current : captureNativeRuntimeInvocation(cli)).spawnSync;
    }
    const bound = runner;
    function native(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
    function native(args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
    function native(args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
        return bound ? bound(args, options) : spawnSync(cli, args, options);
    }
    return native;
}

export function repairWindowsCodexPrivateState(cli: string, target: string, runner?: BoundNativeSpawnSync): void {
    if (process.platform !== "win32") return;
    createWindowsCodexRecovery(createNativeWindowsCodexRecoveryPorts(cli, target, runner)).run();
}

const CODEX_CONTROL_SOCKET_RECOVERY = String.raw`
import errno, fcntl, os, re, socket, stat, sys, uuid
path = '/home/ccc/.codex/app-server-control/app-server-control.sock'
if not os.path.lexists(path): raise SystemExit(0)
def peer():
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(1)
    try: return client.connect_ex(path)
    finally: client.close()
code = peer()
if code == 0: raise SystemExit(0)
if code not in (errno.ENOENT, errno.ECONNREFUSED): raise RuntimeError('Control socket availability is inconclusive')
before = os.lstat(path)
if not stat.S_ISLNK(before.st_mode) or not re.match(r'^/tmp/codex-daemon-[0-9]+/[^/]+$', os.readlink(path)):
    raise RuntimeError('Unrecognized disconnected control socket was preserved')
if sys.argv[1] == 'probe': raise SystemExit(10)
lock_fd = os.open(os.path.dirname(path) + '/app-server-startup.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
with os.fdopen(lock_fd, 'a') as lock:
    metadata = os.fstat(lock.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.geteuid():
        raise RuntimeError('Untrusted Codex control startup lock')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    code = peer()
    if code == 0: raise SystemExit(0)
    if code not in (errno.ENOENT, errno.ECONNREFUSED): raise RuntimeError('Control socket became inconclusive during recovery')
    after = os.lstat(path)
    if (before.st_dev,before.st_ino,before.st_mode,before.st_uid) != (after.st_dev,after.st_ino,after.st_mode,after.st_uid):
        raise RuntimeError('Disconnected control socket changed during recovery')
    os.rename(path, path + '.ccc-stale-' + uuid.uuid4().hex)
`;

interface WindowsCodexPrivateStateContext {
    readonly source: string;
    readonly uid: string;
    readonly gid: string;
}

interface WindowsCodexControlSocketContext {
    readonly source: string;
}

function createNativeWindowsCodexRecoveryPorts(cli: string, target: string, runner?: BoundNativeSpawnSync): WindowsCodexRecoveryPorts<WindowsCodexPrivateStateContext, WindowsCodexControlSocketContext> {
    const native = credentialNativeRunner(cli, runner);
    const run = (mode: "probe" | "repair") => native(["exec", "-i", target, "python3", "-I", "-", mode], { input: CODEX_CONTROL_SOCKET_RECOVERY, encoding: "utf8", timeout: 10000 });
    return {
        probePrivateState: () => {
            const probe = native(["exec", target, "python3", "-c", CODEX_STATE_OWNER_PROBE], { encoding: "utf8", timeout: 10000 });
            if (!probe.error && probe.status === 0) return "healthy";
            if (probe.error || probe.status !== 1) throw new Error(`Codex private state ownership probe failed: ${probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status}`}`, { cause: probe.error });
            return "repair-required";
        },
        qualifyPrivateState: () => {
            const inspect = native(["inspect", "-f", "{{json .Mounts}}", target], { encoding: "utf8", timeout: 10000 });
            if (inspect.error || inspect.status !== 0) throw new Error("Codex private state mount inspection failed");
            const mounts = JSON.parse(inspect.stdout) as { Destination: string; Source: string; Type: string; RW: boolean }[];
            const roots = mounts.filter(mount => mount.Destination === "/home/ccc/.codex");
            if (roots.length !== 1 || roots[0].Type !== "bind" || !roots[0].RW) throw new Error("Codex private state requires a writable host bind");
            const source = windowsCredentialSourcePath(roots[0].Source);
            assertWindowsCredentialDirectory(source);
            for (const name of ["app-server-control", "app-server-daemon", "tmp"]) {
                const path = `${source}/${name}`;
                try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
                assertWindowsCredentialDirectory(path);
            }
            const account = native(["exec", target, "sh", "-c", "id -u; id -g"], { encoding: "utf8", timeout: 10000 });
            const [uid, gid] = (account.stdout ?? "").trim().split(/\r?\n/);
            if (account.error || account.status !== 0 || !/^\d+$/.test(uid ?? "") || !/^\d+$/.test(gid ?? "")) throw new Error("Codex private state user lookup failed");
            return { context: { source, uid, gid }, principal: { uid, gid } };
        },
        *privateStatePeers(context) {
            const active = native(["ps", "-q"], { encoding: "utf8", timeout: 10000 });
            if (active.error || active.status !== 0) throw new Error("Codex private state active users could not be checked");
            const ids = active.stdout.trim().split(/\s+/).filter(Boolean);
            if (ids.length) {
                const inspected = native(["inspect", ...ids], { encoding: "utf8", timeout: 10000 });
                if (inspected.error || inspected.status !== 0) throw new Error("Codex private state active users could not be inspected");
                const containers = JSON.parse(inspected.stdout) as { Id: string; Mounts: { Type: string; Source: string; Destination: string }[] }[];
                for (const container of containers) {
                    const usesSource = container.Mounts.some(mount => {
                        if (mount.Type !== "bind") return false;
                        try { return resolve(windowsCredentialSourcePath(mount.Source)).toLowerCase() === resolve(context.source).toLowerCase(); }
                        catch { return false; }
                    });
                    if (!usesSource) continue;
                    yield { id: container.Id };
                }
            }
        },
        privatePeerUser: (_context, peer) => {
            const observed = native(["exec", peer.id, "id", "-u"], { encoding: "utf8", timeout: 10000 });
            if (observed.error || observed.status !== 0) return { kind: "unknown" };
            return { kind: "known", uid: observed.stdout.trim() };
        },
        repairPrivateState: context => {
            const repaired = native(["exec", "--user", "root", "-i", target, "timeout", "-k", "2s", "30s", "python3", "-I", "-", context.uid, context.gid], { input: CODEX_PRIVATE_STATE_GRANT, encoding: "utf8", timeout: 35000 });
            if (repaired.error || repaired.status !== 0) throw new Error(`Codex private state repair failed: ${repaired.stderr?.trim()}`, { cause: repaired.error });
            return undefined;
        },
        probeControlSocket: () => {
            const probe = run("probe");
            if (!probe.error && probe.status === 0) return "connected-or-absent";
            if (probe.error || probe.status !== 10) throw new Error(`Codex control socket check failed: ${probe.stderr?.trim()}`);
            return "recognized-disconnected";
        },
        qualifyControlSocket: () => {
            const inspected = native(["inspect", "-f", "{{json .Mounts}}", target], { encoding: "utf8", timeout: 10000 });
            if (inspected.error || inspected.status !== 0) throw new Error("Codex control socket mount inspection failed");
            const mounts = JSON.parse(inspected.stdout) as { Destination: string; Source: string; Type: string; RW: boolean }[];
            const roots = mounts.filter(mount => mount.Destination === "/home/ccc/.codex");
            if (roots.length !== 1 || roots[0].Type !== "bind" || !roots[0].RW) throw new Error("Codex control socket is not in a writable credential bind");
            const source = windowsCredentialSourcePath(roots[0].Source);
            assertWindowsCredentialDirectory(source + "/app-server-control");
            return { source };
        },
        *otherControlSocketPeers(context) {
            const active = native(["ps", "-q"], { encoding: "utf8", timeout: 10000 });
            if (active.error || active.status !== 0) throw new Error("Codex control socket users could not be checked");
            const ids = active.stdout.trim().split(/\s+/).filter(id => id && !id.startsWith(target) && !target.startsWith(id));
            if (ids.length) {
                const inspected = native(["inspect", ...ids], { encoding: "utf8", timeout: 10000 });
                if (inspected.error || inspected.status !== 0) throw new Error("Codex control socket users could not be inspected");
                const containers = JSON.parse(inspected.stdout) as { Id: string; Mounts: { Type: string; Source: string }[] }[];
                for (const container of containers) {
                    if (!container.Mounts.some(mount => {
                        if (mount.Type !== "bind") return false;
                        try { return resolve(windowsCredentialSourcePath(mount.Source)).toLowerCase() === resolve(context.source).toLowerCase(); } catch { return false; }
                    })) continue;
                    yield { id: container.Id };
                }
            }
        },
        controlPeerServer: (_context, peer) => {
            const processProbe = native(["exec", "--user", "root", peer.id, "python3", "-c", "import glob,os,sys; found=False\nfor path in glob.glob('/proc/[0-9]*/cmdline'):\n try:\n  args=open(path,'rb').read().split(b'\\0'); found=found or (b'codex' in os.path.basename(args[0]) and b'app-server' in args[1:])\n except (FileNotFoundError,PermissionError): pass\nsys.exit(10 if found else 0)"], { encoding: "utf8", timeout: 10000 });
            return processProbe.error || processProbe.status !== 0 ? "may-be-serving" : "absent";
        },
        quarantineControlSocket: _context => {
            const repaired = run("repair");
            if (repaired.error || repaired.status !== 0) throw new Error(`Codex disconnected control socket recovery failed: ${repaired.stderr?.trim()}`);
            return undefined;
        },
    };
}

export function prepareWindowsCredentialAccess(cli: string, target: string, directory: "/home/ccc/.claude" | "/home/ccc/.codex", runner?: BoundNativeSpawnSync): void {
    if (process.platform !== "win32") return;
    const native = credentialNativeRunner(cli, runner);
    const probe = native(["exec", target, "sh", "-c", 'test -d "$1" && test ! -L "$1" && test -r "$1" && test -w "$1" && test -x "$1" || exit 1; for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do test -L "$entry" && continue; test -e "$entry" || continue; test -r "$entry" && test -w "$entry" || exit 1; if test -d "$entry"; then test -x "$entry" || exit 1; fi; done', "ccc-credential-probe", directory],
        { encoding: "utf8", timeout: 15000 });
    if (!probe.error && probe.status === 0) return;
    if (probe.error || probe.status !== 1) throw new Error("Windows credential access probe failed", { cause: probe.error ?? new Error(probe.stderr) });
    const inspected = native(["inspect", "-f", "{{json .Mounts}}", target], { encoding: "utf8", timeout: 10000 });
    if (inspected.error || inspected.status !== 0) throw new Error("Windows credential mount inspection failed");
    const mounts = JSON.parse(inspected.stdout) as { Destination: string; Source: string; Type: string; RW: boolean }[];
    const mounted = mounts.filter(mount => mount.Destination === directory);
    if (mounted.length !== 1 || mounted[0].Type !== "bind" || !mounted[0].RW) throw new Error("Windows credential mount is not a writable bind");
    assertWindowsCredentialDirectory(mounted[0].Source);
    const user = native(["exec", target, "sh", "-c", "id -u; id -G"], { encoding: "utf8", timeout: 10000 });
    const [uid, groups] = (user.stdout ?? "").trim().split(/\r?\n/);
    if (user.error || user.status !== 0 || !/^\d+$/.test(uid ?? "") || Number(uid) >= 0xffffffff
        || !/^\d+(?: \d+)*$/.test(groups ?? "")) throw new Error("Windows credential container user lookup failed");
    const granted = native(["exec", "--user", "root", "-i", target, "timeout", "-k", "2s", "120s", "/usr/bin/python3", "-I", "-", uid, directory, groups],
        { input: CREDENTIAL_ACCESS_GRANT, encoding: "utf8", timeout: 125000 });
    if (granted.error || granted.status !== 0) throw new Error(`Windows credential access grant failed: ${granted.stderr?.trim()}`, { cause: granted.error });
    const verified = native(["exec", target, "sh", "-c", 'test -r "$1" && test -w "$1" && test -x "$1"', "ccc-credential-verify", directory], { timeout: 10000 });
    if (verified.error || verified.status !== 0) throw new Error("Windows credential access verification failed");
}
