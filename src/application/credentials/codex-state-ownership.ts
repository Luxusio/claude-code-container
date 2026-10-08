import type { CodexStateMount, CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";
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
    const ids = ports.activeIds().split(/\s+/).filter(Boolean);
    if (!ids.length) return undefined;
    const inspected: Array<{ Id?: string; Mounts?: CodexStateMount[] }> = JSON.parse(ports.inspectActive(ids));
    if (!Array.isArray(inspected) || inspected.length !== ids.length) throw new Error("Cannot inspect active Codex state users.");
    for (const container of inspected) {
        if (!Array.isArray(container.Mounts)) throw new Error("Cannot inspect active container mounts.");
        for (const mount of container.Mounts) {
            if (mount.Type !== "bind") continue;
            if (!mount.Source || !ports.isAbsolute(mount.Source)) throw new Error("Cannot resolve active container bind source.");
            let source: string;
            try { source = ports.realpath(mount.Source); }
            catch { throw new Error(`Cannot resolve active container bind source: ${mount.Source}`); }
            if (source === CODEX_DIR || source.startsWith(CODEX_DIR + ports.separator) || CODEX_DIR.startsWith(source.endsWith(ports.separator) ? source : source + ports.separator)) {
                throw new Error(`Codex state is in use by container ${container.Id || "unknown"}. Stop its users before retrying.`);
            }
        }
    }
}

/** The caller retains its startup lock across this synchronous policy and start. */
export function createCodexStateOwnershipMigration(ports: CodexStateOwnershipPorts) {
    function run(previous: PreviousCodexStateContainer, imageId: string, identity: CodexStatePrincipal, profile?: string, proveSource?: (source: string) => boolean): undefined {
        const CODEX_DIR = ports.managedRoot(profile);
        if (identity.mapping !== "host" || ports.nestedContainerMarker() === "docker") return undefined;
        const runtime = ports.runtime();
        if (runtime.rootless || runtime.flavor === "podman-machine" || ports.platform() !== "linux" ||
            identity.uid !== ports.effectiveUid() || identity.gid !== ports.effectiveGid()) {
            throw new Error("Unsupported host mapping for Codex state migration.");
        }
        const mounts = previous.Mounts?.filter(m => m.Destination === "/home/ccc/.codex") || [];
        if (!mounts.length) return undefined; // The previous container never mounted this managed store.
        if (mounts.length !== 1 || mounts[0].Type !== "bind" || (mounts[0].Source !== CODEX_DIR && (!mounts[0].Source || !proveSource?.(mounts[0].Source)))) {
            throw new Error("Cannot prove the previous container used the exact CCC-managed Codex state directory.");
        }
        const previousImage = ports.normalizeImage(previous.Image || "");
        const ids = ports.previousAccount(previousImage);
        const match = /^(\d+):(\d+)$/.exec(ids);
        if (!match || match.slice(1).some(id => Number(id) <= 0 || Number(id) >= 4294967295)) {
            throw new Error("Cannot establish previous ccc UID/GID for Codex state migration.");
        }
        const [oldUid, oldGid] = match.slice(1).map(Number);
        if (oldUid === identity.uid && oldGid === identity.gid) return undefined;
        const rootIdentity = assertTrustedRoot(ports, CODEX_DIR, identity.uid, identity.gid);
        assertNoActiveUsers(ports, CODEX_DIR);
        const rechecked = assertTrustedRoot(ports, CODEX_DIR, identity.uid, identity.gid);
        if (rechecked.dev !== rootIdentity.dev || rechecked.ino !== rootIdentity.ino) {
            throw new Error("Codex state root changed before helper startup. Retry after stopping its writers.");
        }
        ports.migrate(CODEX_DIR, ports.normalizeImage(imageId), String(oldUid), String(oldGid), String(identity.uid), String(identity.gid), rootIdentity);
        return undefined;
    }
    return { run };
}
