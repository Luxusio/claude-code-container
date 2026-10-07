// Imported trust is authoritative. A changed authority resets learned additions,
// including ambiguous hashed/wildcard entries; stable authority keeps additions.
export const SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT = String.raw`
import hashlib, json, os, stat, sys

MARKER = ".ccc-known-hosts-origin.json"
LIMIT = 16 * 1024 * 1024

def read_entry(directory, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return False, b""
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
            raise ValueError("unsafe entry")
        data = stream.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("oversized entry")
        return True, data

def remove_entry(directory, name):
    try:
        os.unlink(name, dir_fd=directory)
    except FileNotFoundError:
        pass

def write_entry(directory, name, data):
    remove_entry(directory, name)
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)

def merge(previous_path, stage_path):
    stage = os.open(stage_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Never accept provenance supplied by the host SSH tree as our record.
        remove_entry(stage, MARKER)
        source_info = None
        try:
            source_info = os.stat("known_hosts", dir_fd=stage, follow_symlinks=False)
        except FileNotFoundError:
            pass
        if source_info is not None and not stat.S_ISREG(source_info.st_mode):
            # Preserve upstream's copied links without following them; no carryover.
            return
        present, authority = read_entry(stage, "known_hosts")
        origin = {"version": 1, "present": present, "sha256": hashlib.sha256(authority).hexdigest()}
        learned = b""
        previous = None
        try:
            previous = os.open(previous_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            marker = os.stat(MARKER, dir_fd=previous, follow_symlinks=False)
            if not stat.S_ISREG(marker.st_mode) or marker.st_uid != os.geteuid() or marker.st_mode & 0o022:
                raise ValueError("untrusted provenance")
            exists, raw = read_entry(previous, MARKER)
            recorded = json.loads(raw) if exists else None
            valid = (isinstance(recorded, dict) and set(recorded) == set(origin)
                     and type(recorded["version"]) is int and type(recorded["present"]) is bool
                     and recorded == origin)
            if valid:
                _, learned = read_entry(previous, "known_hosts")
        except (OSError, ValueError, TypeError):
            # Missing, malformed or linked old evidence cannot preserve old trust.
            pass
        finally:
            if previous is not None:
                os.close(previous)
        if present or learned:
            lines = list(dict.fromkeys(line for line in (authority + b"\n" + learned).splitlines() if line.strip()))
            write_entry(stage, "known_hosts", b"\n".join(lines) + (b"\n" if lines else b""))
        write_entry(stage, MARKER, json.dumps(origin, sort_keys=True).encode("ascii") + b"\n")
    finally:
        os.close(stage)

try:
    merge(sys.argv[1], sys.argv[2])
except Exception:
    # Caller invalidates the whole snapshot; never print keys, paths or contents.
    sys.exit(1)
`;
