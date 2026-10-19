import { lstatSync } from "fs";
import { join } from "path";
import { collectRuntimeBindUsers } from "./adapters/runtime-bind-users.js";
import { runtimeBindAdmission } from "./application/runtime-bind-admission.js";
import { DEFAULT_PROFILE_MARKER } from "./home-layout.js";
import type { RuntimeBindGuard } from "./ports/runtime-bind-authority.js";

const LEGACY_ENTRIES = ["claude", "claude.json", "codex", "locks", "clipboard-files", "bin", "clipboard.port"];

function present(path: string): boolean {
    try { lstatSync(path); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Only a qualified global guard can admit migration of its own home sources. */
export function hasLegacyHomeLayoutContainerMounts(guard?: RuntimeBindGuard): boolean {
    if (!guard) return true;
    try {
        const home = guard.root;
        const paths = LEGACY_ENTRIES.map(entry => join(home, entry)).filter(present);
        // An unmarked named default profile is also renamed by home migration.
        const defaultProfile = join(home, "profiles", "default");
        if (["claude", "claude.json", "codex"].some(entry => present(join(home, entry)))
            && present(defaultProfile) && !present(join(defaultProfile, DEFAULT_PROFILE_MARKER))) paths.push(defaultProfile);
        const observed = collectRuntimeBindUsers(paths, guard);
        return !runtimeBindAdmission(observed.history, observed.users).allowed;
    } catch {
        return true;
    }
}
