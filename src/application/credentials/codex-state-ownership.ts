import type { CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";
import type { CodexStateOwnershipPorts } from "../../ports/credentials/codex-state-ownership.js";

function assertTrustedRoot(ports: CodexStateOwnershipPorts, CODEX_DIR: string, uid: number, gid: number): { dev: string; ino: string } {
    let identity: { dev: string; ino: string } | undefined;
    // Inspect every ancestor: realpath alone would silently follow a substituted symlink.
    for (let path = CODEX_DIR; ; path = ports.parent(path)) {
        const s = ports.directory(path);
        if (s.mode & 0o022n) {
            throw new Error(`Unsafe Codex state directory: ${path}. Remove group/other write permissions on this directory before retrying.`);
        }
        if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== BigInt(uid) && s.uid !== 0n)) {
            throw new Error(`Unsafe Codex state directory or ancestor: ${path}`);
        }
        if ((path === CODEX_DIR || path === ports.parent(CODEX_DIR)) && (s.uid !== BigInt(uid) || s.gid !== BigInt(gid))) {
            throw new Error(`Codex state directory must belong to the host user: ${path}`);
        }
        if (path === CODEX_DIR) identity = { dev: String(s.dev), ino: String(s.ino) };
        if (ports.parent(path) === path) break;
    }
    return identity!;
}

function assertNoActiveUsers(ports: CodexStateOwnershipPorts, CODEX_DIR: string): void {
    for (const container of ports.activeContainers()) {
        for (const mount of container.mounts) {
            if (mount.kind !== "bind") continue;
            if (!mount.source || !ports.isAbsolute(mount.source)) throw new Error("Cannot resolve active container bind source.");
            let source: string;
            try { source = ports.realpath(mount.source); }
            catch { throw new Error(`Cannot resolve active container bind source: ${mount.source}`); }
            if (source === CODEX_DIR || source.startsWith(CODEX_DIR + ports.separator) || CODEX_DIR.startsWith(source.endsWith(ports.separator) ? source : source + ports.separator)) {
                throw new Error(`Codex state is in use by container ${container.id}. Stop its users before retrying.`);
            }
        }
    }
}

/** The caller retains its startup lock across this synchronous policy and start. */
export function createCodexStateOwnershipMigration(ports: CodexStateOwnershipPorts) {
    function run(observePrevious: () => PreviousCodexStateContainer, imageId: string, identity: CodexStatePrincipal, profile?: string, proveSource?: (source: string) => boolean): undefined {
        const CODEX_DIR = ports.managedRoot(profile);
        if (identity.mapping !== "host" || ports.nestedContainerMarker() === "docker") return undefined;
        const runtime = ports.runtime();
        if (runtime.rootless || runtime.flavor === "podman-machine" || ports.platform() !== "linux") {
            throw new Error("Unsupported host mapping for Codex state migration.");
        }
        const uid = identity.uid;
        if (uid !== ports.effectiveUid()) throw new Error("Unsupported host mapping for Codex state migration.");
        const gid = identity.gid;
        if (gid !== ports.effectiveGid()) throw new Error("Unsupported host mapping for Codex state migration.");
        const previous = observePrevious();
        const mounts = previous.mounts.filter(m => m.destination === "/home/ccc/.codex");
        if (!mounts.length) return undefined; // The previous container never mounted this managed store.
        if (mounts.length !== 1 || mounts[0].kind !== "bind" || (mounts[0].source !== CODEX_DIR && (!mounts[0].source || !proveSource?.(mounts[0].source)))) {
            throw new Error("Cannot prove the previous container used the exact CCC-managed Codex state directory.");
        }
        const previousImage = ports.normalizeImage(previous.image);
        const { uid: oldUid, gid: oldGid } = ports.previousAccount(previousImage);
        if ([oldUid, oldGid].some(id => !Number.isInteger(id) || id <= 0 || id >= 4294967295)) {
            throw new Error("Cannot establish previous ccc UID/GID for Codex state migration.");
        }
        if (oldUid === uid && oldGid === gid) return undefined;
        const rootIdentity = assertTrustedRoot(ports, CODEX_DIR, uid, gid);
        assertNoActiveUsers(ports, CODEX_DIR);
        const rechecked = assertTrustedRoot(ports, CODEX_DIR, uid, gid);
        if (rechecked.dev !== rootIdentity.dev || rechecked.ino !== rootIdentity.ino) {
            throw new Error("Codex state root changed before helper startup. Retry after stopping its writers.");
        }
        if (identity.mapping !== "host" || identity.uid !== uid || identity.gid !== gid ||
            uid !== ports.effectiveUid() || gid !== ports.effectiveGid()) {
            throw new Error("Host principal changed before Codex state migration.");
        }
        ports.migrate(CODEX_DIR, ports.normalizeImage(imageId), String(oldUid), String(oldGid), String(uid), String(gid), rootIdentity);
        return undefined;
    }
    return { run };
}
