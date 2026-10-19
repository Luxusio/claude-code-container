import { lstatSync, realpathSync } from "fs";
import { dirname, isAbsolute, normalize, relative, sep } from "path";
import { bindNativeRuntimeInvocation, peekRuntimeInvocation } from "../container-runtime.js";
import type { RuntimeBindAuthorityFacts, RuntimeBindGuard, RuntimeBindUsers } from "../ports/runtime-bind-authority.js";
import { validateNativeRuntimeInvocation } from "./container-runtime-invocation.js";
import { assertRuntimeBindAuthorityCurrent, readRuntimeBindAuthority } from "./runtime-bind-authority.js";

const SCAN_MS = 10_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const LIST_LIMIT = 4 * 1024 * 1024;
const INSPECT_BATCH = 128;
const CONTAINER_LIMIT = 4096;
const UNKNOWN_HISTORY: RuntimeBindAuthorityFacts = Object.freeze({ coverage: "unknown", pending: true, authorities: [] });

function contains(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return !suffix || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function overlaps(left: string, right: string): boolean {
    return contains(left, right) || contains(right, left);
}

/** An inaccessible or aliased native path cannot prove an unrelated bind source. */
function canonicalWithoutSymlinks(path: string): string {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Unknown bind path");
    const normalized = normalize(path);
    for (let current = normalized; ; current = dirname(current)) {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Unknown bind path");
        if (dirname(current) === current) break;
    }
    return realpathSync(normalized);
}

/** Native facts only. Its caller applies the shared admission policy while this guard remains held. */
export function collectRuntimeBindUsers(paths: readonly string[], guard: RuntimeBindGuard): {
    readonly history: RuntimeBindAuthorityFacts;
    readonly users: RuntimeBindUsers;
} {
    let history = UNKNOWN_HISTORY;
    try {
        const snapshot = readRuntimeBindAuthority(guard);
        history = snapshot;
        if (history.coverage !== "complete" || history.pending) return { history, users: "unknown" };
        const deadline = performance.now() + SCAN_MS;
        const root = canonicalWithoutSymlinks(guard.root);
        const scopes = paths.map(path => {
            const lexical = normalize(path);
            const canonical = canonicalWithoutSymlinks(path);
            if (!contains(normalize(guard.root), lexical) || !contains(root, canonical)) throw new Error("Bind scope is outside its guard");
            return { lexical, canonical };
        });
        // Nothing is going to move when there is no pending layout source.
        if (!scopes.length) {
            assertRuntimeBindAuthorityCurrent(guard, snapshot);
            return { history, users: performance.now() < deadline ? "absent" : "unknown" };
        }
        const current = peekRuntimeInvocation();
        if (!current) return { history, users: "unknown" };
        const authorities = new Map(
            [current, ...history.authorities].map(value => {
                const invocation = validateNativeRuntimeInvocation(value);
                return [JSON.stringify(invocation), invocation] as const;
            }),
        );
        let outputRemaining = OUTPUT_LIMIT;
        for (const invocation of authorities.values()) {
            const runner = bindNativeRuntimeInvocation(invocation);
            const observe = (args: readonly string[], maximum: number): string => {
                const timeout = Math.floor(deadline - performance.now());
                if (timeout <= 0 || outputRemaining <= 0) throw new Error("Bind inventory budget exhausted");
                const result = runner.spawnSync(args, { encoding: "utf-8", timeout, killSignal: "SIGKILL",
                    maxBuffer: Math.min(maximum, outputRemaining), windowsHide: true });
                if (result.error || result.status !== 0 || typeof result.stdout !== "string"
                    || performance.now() >= deadline) throw new Error("Bind inventory is unavailable");
                outputRemaining -= Buffer.byteLength(result.stdout, "utf8")
                    + (typeof result.stderr === "string" ? Buffer.byteLength(result.stderr, "utf8") : 0);
                if (outputRemaining < 0 || Buffer.byteLength(result.stdout, "utf8") > maximum) throw new Error("Bind inventory output is too large");
                return result.stdout;
            };
            const listed = observe(["ps", "-aq", "--no-trunc"], LIST_LIMIT).trim();
            const ids = listed ? listed.split(/\s+/) : [];
            if (ids.length > CONTAINER_LIMIT || ids.some(id => !/^[a-f0-9]{64}$/.test(id))
                || new Set(ids).size !== ids.length) throw new Error("Unknown container inventory");
            for (let offset = 0; offset < ids.length; offset += INSPECT_BATCH) {
                const batch = ids.slice(offset, offset + INSPECT_BATCH);
                const containers: unknown = JSON.parse(observe(["inspect", ...batch], OUTPUT_LIMIT));
                if (!Array.isArray(containers) || containers.length !== batch.length) throw new Error("Unknown container inspection");
                const remaining = new Set(batch);
                for (const container of containers) {
                    if (!container || typeof container.Id !== "string" || !remaining.delete(container.Id)
                        || typeof container.State?.Running !== "boolean" || !Array.isArray(container.Mounts)) throw new Error("Unknown container inspection");
                    // Stopped containers retain their binds for a subsequent start.
                    for (const mount of container.Mounts) {
                        if (!mount || !["bind", "volume", "tmpfs", "npipe"].includes(mount.Type)
                            || typeof mount.Destination !== "string" || !mount.Destination
                            || /[\x00-\x1f\x7f]/.test(mount.Destination)) throw new Error("Unknown mount metadata");
                        if (mount.Type !== "bind") continue;
                        if (typeof mount.Source !== "string" || !isAbsolute(mount.Source)
                            || /[\x00-\x1f\x7f]/.test(mount.Source)) throw new Error("Unknown mount metadata");
                        const source = normalize(mount.Source);
                        const canonical = canonicalWithoutSymlinks(source);
                        if (scopes.some(scope => overlaps(source, scope.lexical)
                            || overlaps(canonical, scope.canonical))) return { history, users: "present" };
                    }
                }
                if (remaining.size) throw new Error("Incomplete container inspection");
            }
        }
        for (const scope of scopes) {
            if (canonicalWithoutSymlinks(scope.lexical) !== scope.canonical) throw new Error("Bind scope changed");
        }
        assertRuntimeBindAuthorityCurrent(guard, snapshot);
        return { history, users: performance.now() < deadline ? "absent" : "unknown" };
    } catch {
        return { history, users: "unknown" };
    }
}
