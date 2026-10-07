import { spawnSync } from "child_process";
import { lstatSync, realpathSync } from "fs";
import { dirname, isAbsolute, sep } from "path";
import { getCodexDir } from "./utils.js";
import { getRuntimeInfo, runtimeCli } from "./container-runtime.js";
import { normalizeImageId, type ContainerIdentity } from "./container-identity.js";

interface Mount { Type?: string; Source?: string; Destination?: string }
interface PreviousContainer { Image?: string; Mounts?: Mount[] }

function checked(args: string[], input?: string): string {
    const result = spawnSync(runtimeCli(), args, { encoding: "utf-8", input, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
        throw new Error(`Codex state ownership check failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    return result.stdout.trim();
}

/** All descriptors are pinned before the first ownership write, including symlinks. */
export const codexStateMigrationScript = String.raw`
import ctypes, os, stat, sys
root, old_uid, old_gid, new_uid, new_gid, expected_dev, expected_ino = sys.argv[1:]
old_uid, old_gid, new_uid, new_gid = map(int, (old_uid, old_gid, new_uid, new_gid))
def fail(message):
    raise RuntimeError(message)
def signature(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink)
def mount_path(value):
    import re
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)
root = os.path.abspath(root)
with open('/proc/self/mountinfo') as mounts:
    if any(mount_path(line.split()[4]).startswith(root + '/') for line in mounts):
        fail('Nested mount in Codex state; stop and unmount it before retrying')
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if (root_stat.st_dev, root_stat.st_ino) != (int(expected_dev), int(expected_ino)):
    fail('Codex state root identity changed before helper startup')
if root_stat.st_uid != new_uid or root_stat.st_gid != new_gid or root_stat.st_mode & 0o022:
    fail('Codex state root is not a trusted host-owned directory')
entries = []
memberships = []
def visit(directory_fd, relative):
    names = sorted(os.listdir(directory_fd))
    memberships.append((directory_fd, relative, names))
    for name in names:
        fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory_fd)
        s = os.fstat(fd)
        path = relative + '/' + name
        if s.st_dev != root_stat.st_dev:
            fail('Filesystem boundary in Codex state: ' + path)
        if not stat.S_ISDIR(s.st_mode) and s.st_nlink != 1:
            fail('Multiply linked Codex state entry: ' + path)
        if s.st_mode & (stat.S_ISUID | stat.S_ISGID):
            fail('Set-ID Codex state entry: ' + path)
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode) or stat.S_ISSOCK(s.st_mode)):
            fail('Unsupported Codex state entry: ' + path)
        entries.append((fd, directory_fd, name, s, path))
        if stat.S_ISDIR(s.st_mode):
            child_fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
            directory_fds.append(child_fd)
            visit(child_fd, path)
directory_fds = [root_fd]
def validate_memberships():
    if signature(os.lstat(root)) != signature(root_stat) or signature(os.fstat(root_fd)) != signature(root_stat):
        fail('Codex state root changed during migration')
    for fd, path, names in memberships:
        if sorted(os.listdir(fd)) != names:
            fail('Codex state directory membership changed: ' + path)
try:
    visit(root_fd, root)
    # A second complete validation still precedes every ownership write.
    validate_memberships()
    for fd, parent_fd, name, before, path in entries:
        if signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != signature(before):
            fail('Codex state changed during preflight: ' + path)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fchownat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
    libc.fchownat.restype = ctypes.c_int
    changed = 0
    for fd, parent_fd, name, before, path in entries:
        if signature(os.fstat(fd)) != signature(before) or signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != signature(before):
            fail('Codex state changed during migration: ' + path)
        uid = new_uid if before.st_uid == old_uid else before.st_uid
        gid = new_gid if before.st_gid == old_gid else before.st_gid
        if (uid, gid) == (before.st_uid, before.st_gid):
            continue
        # AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW changes the pinned inode itself.
        if libc.fchownat(fd, b'', uid, gid, 0x1000 | 0x100):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), path)
        after = os.fstat(fd)
        if after.st_mode != before.st_mode or (after.st_uid, after.st_gid) != (uid, gid):
            fail('Codex state metadata verification failed: ' + path)
        changed += 1
    validate_memberships()
    for fd, parent_fd, name, before, path in entries:
        uid = new_uid if before.st_uid == old_uid else before.st_uid
        gid = new_gid if before.st_gid == old_gid else before.st_gid
        expected = (before.st_dev, before.st_ino, before.st_mode, uid, gid, before.st_nlink)
        if signature(os.fstat(fd)) != expected or signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != expected:
            fail('Codex state changed before final verification: ' + path)
    print('Migrated %d Codex state entries' % changed)
finally:
    for fd, *_ in entries:
        os.close(fd)
    for fd in directory_fds:
        os.close(fd)
`;

function assertTrustedRoot(CODEX_DIR: string, uid: number, gid: number): { dev: string; ino: string } {
    let identity: { dev: string; ino: string } | undefined;
    // Inspect every ancestor: realpath alone would silently follow a substituted symlink.
    for (let path = CODEX_DIR; ; path = dirname(path)) {
        const s = lstatSync(path, { bigint: true });
        if (s.mode & 0o022n) {
            throw new Error(`Unsafe Codex state directory: ${path}. Remove group/other write permissions on this directory before retrying.`);
        }
        if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== BigInt(uid) && s.uid !== 0n)) {
            throw new Error(`Unsafe Codex state directory or ancestor: ${path}`);
        }
        if ((path === CODEX_DIR || path === dirname(CODEX_DIR)) && (s.uid !== BigInt(uid) || s.gid !== BigInt(gid))) {
            throw new Error(`Codex state directory must belong to the host user: ${path}`);
        }
        if (path === CODEX_DIR) identity = { dev: String(s.dev), ino: String(s.ino) };
        if (dirname(path) === path) break;
    }
    return identity!;
}

function assertNoActiveUsers(CODEX_DIR: string): void {
    const ids = checked(["ps", "-q"]).split(/\s+/).filter(Boolean);
    if (!ids.length) return;
    const inspected: Array<{ Id?: string; Mounts?: Mount[] }> = JSON.parse(checked(["inspect", ...ids]));
    if (!Array.isArray(inspected) || inspected.length !== ids.length) throw new Error("Cannot inspect active Codex state users.");
    for (const container of inspected) {
        if (!Array.isArray(container.Mounts)) throw new Error("Cannot inspect active container mounts.");
        for (const mount of container.Mounts) {
            if (mount.Type !== "bind") continue;
            if (!mount.Source || !isAbsolute(mount.Source)) throw new Error("Cannot resolve active container bind source.");
            let source: string;
            try { source = realpathSync(mount.Source); }
            catch { throw new Error(`Cannot resolve active container bind source: ${mount.Source}`); }
            if (source === CODEX_DIR || source.startsWith(CODEX_DIR + sep) || CODEX_DIR.startsWith(source.endsWith(sep) ? source : source + sep)) {
                throw new Error(`Codex state is in use by container ${container.Id || "unknown"}. Stop its users before retrying.`);
            }
        }
    }
}

/** Caller holds the global startup lock until the replacement container has started. */
export function prepareCodexStateOwnership(previous: PreviousContainer, imageId: string, identity: ContainerIdentity, profile?: string, proveSource?: (source: string) => boolean): void {
    const CODEX_DIR = getCodexDir(profile);
    if (identity.mapping !== "host" || process.env.container === "docker") return;
    const runtime = getRuntimeInfo();
    if (runtime.rootless || runtime.flavor === "podman-machine" || process.platform !== "linux" ||
        identity.uid !== process.geteuid?.() || identity.gid !== process.getegid?.()) {
        throw new Error("Unsupported host mapping for Codex state migration.");
    }
    const mounts = previous.Mounts?.filter(m => m.Destination === "/home/ccc/.codex") || [];
    if (!mounts.length) return; // The previous container never mounted this managed store.
    if (mounts.length !== 1 || mounts[0].Type !== "bind" || (mounts[0].Source !== CODEX_DIR && (!mounts[0].Source || !proveSource?.(mounts[0].Source)))) {
        throw new Error("Cannot prove the previous container used the exact CCC-managed Codex state directory.");
    }
    const previousImage = normalizeImageId(previous.Image || "");
    const ids = checked(["run", "--rm", "--network", "none", "--user", "root", "--entrypoint", "/bin/sh", previousImage,
        "-c", 'set -eu; printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"']);
    const match = /^(\d+):(\d+)$/.exec(ids);
    if (!match || match.slice(1).some(id => Number(id) <= 0 || Number(id) >= 4294967295)) {
        throw new Error("Cannot establish previous ccc UID/GID for Codex state migration.");
    }
    const [oldUid, oldGid] = match.slice(1).map(Number);
    if (oldUid === identity.uid && oldGid === identity.gid) return;
    const rootIdentity = assertTrustedRoot(CODEX_DIR, identity.uid, identity.gid);
    assertNoActiveUsers(CODEX_DIR);
    const rechecked = assertTrustedRoot(CODEX_DIR, identity.uid, identity.gid);
    if (rechecked.dev !== rootIdentity.dev || rechecked.ino !== rootIdentity.ino) {
        throw new Error("Codex state root changed before helper startup. Retry after stopping its writers.");
    }
    checked(["run", "--rm", "--network", "none", "--user", "root", "--mount", `type=bind,src=${CODEX_DIR},dst=/state`,
        "--entrypoint", "python3", normalizeImageId(imageId), "-c", codexStateMigrationScript,
        "/state", String(oldUid), String(oldGid), String(identity.uid), String(identity.gid), rootIdentity.dev, rootIdentity.ino]);
}

export const codexStateAccessScript = String.raw`
import os, stat
root = '/home/ccc/.codex'
uid = os.geteuid()
def fail(message):
    raise RuntimeError(message)
def walk_error(error):
    raise error
if not os.path.isdir(root) or os.path.islink(root):
    fail('Codex state root is missing or symlinked')
for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
    if not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
        fail('Inaccessible Codex state directory: ' + directory)
    relative = os.path.relpath(directory, root)
    top = relative.split('/')[0]
    private = top in ('app-server-daemon', 'app-server-control', 'tmp')
    # Runtime records are updated in place. Plugin and Harness repository files
    # may legitimately be read-only (notably .git objects and packaged assets).
    mutable = relative == '.' or top in ('app-server-daemon', 'app-server-control', 'tmp', 'sessions', 'archived_sessions', 'log', 'logs', 'shell_snapshots', 'sqlite', 'memories')
    if private and os.lstat(directory).st_uid != uid:
        fail('Codex private directory belongs to another user: ' + directory)
    for name in files:
        path = os.path.join(directory, name)
        info = os.lstat(path)
        if stat.S_ISREG(info.st_mode) and not os.access(path, os.R_OK):
            fail('Unreadable Codex state file: ' + path)
        if mutable and stat.S_ISREG(info.st_mode) and not os.access(path, os.W_OK):
            fail('Unwritable Codex runtime state file: ' + path)
        if private and not stat.S_ISLNK(info.st_mode) and info.st_uid != uid:
            fail('Codex private file belongs to another user: ' + path)
`;

export function assertCodexStateAccessible(containerName: string, profile?: string): void {
    const CODEX_DIR = getCodexDir(profile);
    try {
        checked(["exec", containerName, "python3", "-c", codexStateAccessScript]);
    } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}\nCCC-managed Codex state (${CODEX_DIR}) is inaccessible. Stop containers using it and repair its confirmed previous UID/GID ownership. Project-folder chown does not repair this separate store; CCC will not guess the previous owner.`);
    }
}
