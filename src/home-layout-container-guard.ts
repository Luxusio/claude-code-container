import { spawnSync } from "child_process";
import { lstatSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "path";
import { runtimeCli } from "./container-runtime.js";
import { cccHome, DEFAULT_PROFILE_MARKER } from "./home-layout.js";

const LEGACY_ENTRIES = ["claude", "claude.json", "codex", "locks", "clipboard-files", "bin", "clipboard.port"];

function present(path: string): boolean {
    try { lstatSync(path); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Do not silently follow an alias when proving a migration source is unmounted. */
function canonicalWithoutSymlinks(path: string): string {
    if (!isAbsolute(path)) throw new Error("Nonabsolute container mount source");
    const normalized = normalize(path);
    for (let current = normalized; ; current = dirname(current)) {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink in container mount source");
        if (dirname(current) === current) break;
    }
    return realpathSync(normalized);
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return !suffix || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function overlaps(left: string, right: string): boolean {
    return contains(left, right) || contains(right, left);
}

/**
 * Include stopped containers: their retained bind source is required at the next
 * start and is proof for ownership migration. Unknown runtime/filesystem state
 * defers layout migration. This function only reads metadata.
 */
export function hasLegacyHomeLayoutContainerMounts(): boolean {
    try {
        const home = cccHome();
        const paths = LEGACY_ENTRIES.map(entry => join(home, entry)).filter(present);
        if (!paths.length) return false;
        // An unmarked named default profile is also renamed by home migration.
        const defaultProfile = join(home, "profiles", "default");
        if (["claude", "claude.json", "codex"].some(entry => present(join(home, entry)))
            && present(defaultProfile) && !present(join(defaultProfile, DEFAULT_PROFILE_MARKER))) paths.push(defaultProfile);
        const canonicalPaths = paths.map(canonicalWithoutSymlinks);
        const runtime = runtimeCli();
        const listed = spawnSync(runtime, ["ps", "-aq", "--no-trunc"], { encoding: "utf-8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
        if (listed.error || listed.status !== 0 || typeof listed.stdout !== "string") return true;
        const ids = listed.stdout.trim() ? listed.stdout.trim().split(/\s+/) : [];
        if (ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) return true;
        if (!ids.length) return false;
        const inspected = spawnSync(runtime, ["inspect", ...ids], { encoding: "utf-8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
        if (inspected.error || inspected.status !== 0 || typeof inspected.stdout !== "string") return true;
        const containers: unknown = JSON.parse(inspected.stdout);
        if (!Array.isArray(containers) || containers.length !== ids.length) return true;
        const remaining = new Set(ids);
        for (const container of containers) {
            if (!container || typeof container.Id !== "string" || !remaining.delete(container.Id) || !Array.isArray(container.Mounts)) return true;
            for (const mount of container.Mounts) {
                if (!mount || !["bind", "volume", "tmpfs", "npipe"].includes(mount.Type)
                    || typeof mount.Destination !== "string" || !mount.Destination) return true;
                if (mount.Type !== "bind") continue;
                if (typeof mount.Source !== "string" || !isAbsolute(mount.Source)) return true;
                const normalized = normalize(mount.Source);
                if (paths.some(path => overlaps(normalized, path))) return true;
                // An opaque Desktop/VM source may alias the host state. Do not
                // invent /host_mnt or WSL translations to declare it unrelated.
                const source = canonicalWithoutSymlinks(normalized);
                if (canonicalPaths.some(path => overlaps(source, path))) return true;
            }
        }
        return remaining.size !== 0;
    } catch {
        return true;
    }
}
