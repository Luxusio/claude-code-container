import { spawnSync } from "child_process";
import { lstatSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runtimeCli } from "./container-runtime.js";

const containerDirectory = "/home/ccc/.local/share/opencode";
const accessProbe = `dir=${containerDirectory}; if [ ! -L "$dir" ] && [ -d "$dir" ] && [ -r "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]; then exit 0; fi; exit 3`;

// Pin every path component; flock serializes CCC repairs on the mounted inode.
// Direct xattrs never fall back to chmod on a filesystem without ACL support.
export const OPENCODE_DATA_DIRECTORY_ACL = String.raw`
import errno, fcntl, os, struct, sys

uid, host_uid = map(int, sys.argv[1:])
if not all(0 <= identity < 0xffffffff for identity in (uid, host_uid)):
    raise RuntimeError("invalid container user identity")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open("/", flags)
try:
    for component in "/home/ccc/.local/share/opencode".strip("/").split("/"):
        child = os.open(component, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    fcntl.flock(fd, fcntl.LOCK_EX)
    metadata = os.fstat(fd)
    if metadata.st_uid != host_uid:
        raise RuntimeError("mounted data directory is not owned by the host user; inspect permissions manually")
    def attribute(name):
        try:
            return os.getxattr(fd, name)
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise
            return None
    if attribute("system.posix_acl_default") is not None:
        raise RuntimeError("existing default ACL requires manual inspection")
    existing = attribute("system.posix_acl_access")
    owner = (metadata.st_mode >> 6) & 7
    group = (metadata.st_mode >> 3) & 7
    other = metadata.st_mode & 7
    undefined = 0xffffffff
    if existing is not None:
        # A competing invocation may have completed this exact grant already.
        if len(existing) != 44 or struct.unpack("<I", existing[:4])[0] != 2:
            raise RuntimeError("existing access ACL requires manual inspection")
        entries = list(struct.iter_unpack("<HHI", existing[4:]))
        group = entries[2][1]
        expected = [(1, owner, undefined), (2, 7, uid), (4, group, undefined),
                    (16, 7, undefined), (32, other, undefined)]
        if group > 7 or entries != expected:
            raise RuntimeError("existing access ACL requires manual inspection")
    else:
        if uid == metadata.st_uid:
            raise RuntimeError("directory owner lacks access; inspect permissions manually")
        entries = [(1, owner, undefined), (2, 7, uid), (4, group, undefined),
                   (16, 7, undefined), (32, other, undefined)]
        encoded = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
        os.setxattr(fd, "system.posix_acl_access", encoded)
finally:
    os.close(fd)
`;

export function prepareOpenCodeDataDirectory(containerName: string): void {
    const hostDirectory = join(homedir(), ".local", "share", "opencode");
    const run = (operation: string, script: string, root = false, probe = false) => {
        const result = spawnSync(runtimeCli(), [
            "exec", ...(root ? ["--user", "root"] : []), "-w", "/", containerName, "/bin/sh", "-c", script,
        ], { encoding: "utf-8", timeout: 10000 });
        if (result.error || (result.status !== 0 && !(probe && result.status === 3))) {
            throw new Error(`${operation} failed (${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status ?? "unknown"}`)})`);
        }
        return result;
    };
    try {
        if (run("access check", accessProbe, false, true).status === 0) return;
        const host = lstatSync(hostDirectory);
        if (typeof process.getuid !== "function" || !host.isDirectory() || host.uid !== process.getuid()) {
            throw new Error("automatic repair requires a non-symlink directory owned by the host user; inspect permissions manually");
        }
        const uid = run("container user lookup", "/usr/bin/id -u").stdout.trim();
        if (!/^\d+$/.test(uid) || Number(uid) >= 0xffffffff) {
            throw new Error("invalid container user identity");
        }
        run("directory ACL grant", `/usr/bin/timeout 8s /usr/bin/python3 -I - ${uid} ${host.uid} <<'CCC_OPENCODE_ACL'\n${OPENCODE_DATA_DIRECTORY_ACL}\nCCC_OPENCODE_ACL`, true);
        run("access verification", accessProbe);
    } catch (error) {
        throw new Error(`Unable to prepare OpenCode data at ${hostDirectory}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
