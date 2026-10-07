// Linux file ACLs are applied directly: setfacl can fall back to chmod on
// filesystems without ACL support, even when it ultimately reports failure.
export const CODEX_CONFIG_FILE_ACL = String.raw`
import errno, os, stat, struct, sys

USER_OBJ, USER, GROUP_OBJ, GROUP, MASK, OTHER = 1, 2, 4, 8, 16, 32
UNDEFINED = 0xffffffff
container_uid = int(sys.argv[1])
if not 0 <= container_uid < UNDEFINED:
    raise RuntimeError("invalid container user identity")

flags = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW
directory = os.open("/", flags)
try:
    # Pin every directory component; O_NOFOLLOW on only the final path would
    # still allow /home or /home/ccc to redirect the root ACL effect elsewhere.
    for component in "/home/ccc/.codex".strip("/").split("/"):
        child = os.open(component, flags, dir_fd=directory)
        os.close(directory)
        directory = child
    host_uid = os.fstat(directory).st_uid
    file = os.open("config.toml", os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
    try:
        metadata = os.fstat(file)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("config must be a regular non-symlink, single-link file")
        # O_PATH pins even an unreadable file. xattr calls through its procfs
        # descriptor link operate on that inode, including after a rename.
        target = "/proc/self/fd/" + str(file)
        attribute = "system.posix_acl_access"
        try:
            data = os.getxattr(target, attribute)
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise
            data = None
        if data is None:
            entries = [(USER_OBJ, (metadata.st_mode >> 6) & 7, UNDEFINED),
                       (GROUP_OBJ, (metadata.st_mode >> 3) & 7, UNDEFINED),
                       (OTHER, metadata.st_mode & 7, UNDEFINED)]
        else:
            if len(data) < 4 or len(data) % 8 != 4 or struct.unpack("<I", data[:4])[0] != 2:
                raise RuntimeError("malformed config ACL")
            entries = list(struct.iter_unpack("<HHI", data[4:]))
        acl = {}
        for tag, permissions, uid in entries:
            if (tag not in (USER_OBJ, USER, GROUP_OBJ, GROUP, MASK, OTHER)
                    or permissions > 7 or (tag, uid) in acl
                    or ((tag in (USER, GROUP)) == (uid == UNDEFINED))):
                raise RuntimeError("malformed config ACL")
            acl[tag, uid] = permissions
        if (any((tag, UNDEFINED) not in acl for tag in (USER_OBJ, GROUP_OBJ, OTHER))
                or list(acl) != sorted(acl)
                or (any(tag in (USER, GROUP) for tag, _ in acl) and (MASK, UNDEFINED) not in acl)):
            raise RuntimeError("malformed config ACL")

        principals = {host_uid, container_uid}
        old_mask = acl.get((MASK, UNDEFINED), acl[GROUP_OBJ, UNDEFINED])
        new_mask = old_mask | 6 if principals - {metadata.st_uid} else old_mask
        for (tag, uid), permissions in acl.items():
            if tag in (GROUP_OBJ, GROUP) or (tag == USER and uid not in principals):
                if permissions & (new_mask & ~old_mask):
                    raise RuntimeError("config ACL mask expansion would grant unrelated access; inspect ACL manually")
        for uid in principals:
            key = (USER_OBJ, UNDEFINED) if uid == metadata.st_uid else (USER, uid)
            acl[key] = acl.get(key, 0) | 6
        if principals - {metadata.st_uid} or (MASK, UNDEFINED) in acl:
            acl[MASK, UNDEFINED] = new_mask
        encoded = struct.pack("<I", 2) + b"".join(
            struct.pack("<HHI", tag, acl[tag, uid], uid) for tag, uid in sorted(acl))
        # Refuse an observed link/entry replacement before changing access.
        current = os.fstat(file)
        entry = os.stat("config.toml", dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or current.st_nlink != 1
                or (entry.st_dev, entry.st_ino) != (metadata.st_dev, metadata.st_ino)
                or (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino)):
            raise RuntimeError("config identity changed before ACL grant")
        os.setxattr(target, attribute, encoded)
    finally:
        os.close(file)
finally:
    os.close(directory)
`;

export function codexConfigFileAclScript(containerUid: string): string {
    if (!/^\d+$/.test(containerUid) || Number(containerUid) >= 0xffffffff) {
        throw new Error("Unable to prepare Codex credentials: invalid container user identity");
    }
    return `python3 - ${containerUid} <<'CCC_CODEX_FILE_ACL'\n${CODEX_CONFIG_FILE_ACL}\nCCC_CODEX_FILE_ACL`;
}

// The caller validates the profile's host-owned bind source before invoking
// this script as container root. The pinned directory owner is the host
// principal in the container namespace; raw host UIDs are not portable to Podman.
export const CODEX_CONFIG_DIRECTORY_ACL = String.raw`
import errno, fcntl, os, struct, sys

uid = int(sys.argv[1])
if not 0 <= uid < 0xffffffff:
    raise RuntimeError("invalid container user identity")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open("/", flags)
try:
    for component in "/home/ccc/.codex".strip("/").split("/"):
        child = os.open(component, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    fcntl.flock(fd, fcntl.LOCK_EX)
    metadata = os.fstat(fd)
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

export function codexConfigDirectoryAclScript(containerUid: string): string {
    if (!/^\d+$/.test(containerUid) || Number(containerUid) >= 0xffffffff) {
        throw new Error("Unable to prepare Codex credentials: invalid container user identity");
    }
    return `/usr/bin/timeout -k 1s 8s /usr/bin/python3 -I - ${containerUid} <<'CCC_CODEX_DIRECTORY_ACL'\n${CODEX_CONFIG_DIRECTORY_ACL}\nCCC_CODEX_DIRECTORY_ACL`;
}
