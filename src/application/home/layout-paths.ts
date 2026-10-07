import { normalizeProfile } from "../../domain/profile-request.js";
import type { HomePathPorts } from "../../ports/home/layout-paths.js";

export function createHomeLayoutPaths(
    ports: HomePathPorts,
    defaultProfileName: string,
    defaultProfileMarker: string,
    defaultEntries: readonly string[],
) {
    function cccHome(): string {
        return ports.joinHostPath(ports.homeDirectory(), ".ccc");
    }

    function resolveEntry(legacyRel: string, nextRel: string): string {
        const home = cccHome();
        const legacy = ports.joinHostPath(home, legacyRel);
        const next = ports.joinHostPath(home, nextRel);
        return ports.entryExists(legacy) && !ports.entryExists(next) ? legacy : next;
    }

    function profilesDir(): string {
        return ports.joinHostPath(cccHome(), "profiles");
    }

    // profiles/default is the no-profile account only when ccc made it so. Before
    // this layout, "default" was an ordinary profile name, so a profiles/default
    // without this marker may be another account and must never replace ~/.ccc/claude.
    function defaultProfileDir(): string {
        return ports.joinHostPath(profilesDir(), defaultProfileName);
    }

    function hasDefaultProfileMarker(): boolean {
        return ports.entryExists(ports.joinHostPath(defaultProfileDir(), defaultProfileMarker));
    }

    /** Create profiles/default (0700) and mark it as the no-profile account. */
    function ensureDefaultProfileDir(): undefined {
        ports.createDirectory(defaultProfileDir(), { recursive: true, mode: 0o700 });
        const marker = ports.joinHostPath(defaultProfileDir(), defaultProfileMarker);
        if (!ports.entryExists(marker)) ports.writeMarker(marker, "", { mode: 0o600 });
        return undefined;
    }

    function hasLegacyDefaultEntries(): boolean {
        return defaultEntries.some((entry) => ports.entryExists(ports.joinHostPath(cccHome(), entry)));
    }

    function profileEntry(profile: string | undefined, entry: string): string {
        const named = normalizeProfile(profile);
        if (named) return ports.joinHostPath(profilesDir(), named, entry);
        const legacy = ports.joinHostPath(cccHome(), entry);
        const next = ports.joinHostPath(defaultProfileDir(), entry);
        // Unmarked: a pre-layout home keeps every default entry on its old path (even
        // one that does not exist yet); only a fresh home starts in profiles/default.
        if (!hasDefaultProfileMarker()) return hasLegacyDefaultEntries() ? legacy : next;
        return ports.entryExists(legacy) && !ports.entryExists(next) ? legacy : next;
    }

    function profileClaudeDir(profile?: string): string {
        return profileEntry(profile, "claude");
    }

    function profileClaudeJsonFile(profile?: string): string {
        return profileEntry(profile, "claude.json");
    }

    function profileCodexDir(profile?: string): string {
        return profileEntry(profile, "codex");
    }

    function runDir(): string {
        return ports.joinHostPath(cccHome(), "run");
    }

    function locksDir(): string {
        return resolveEntry("locks", ports.joinHostPath("run", "locks"));
    }

    function clipboardFilesDir(): string {
        return resolveEntry("clipboard-files", ports.joinHostPath("run", "clipboard-files"));
    }

    function helperBinDir(): string {
        return resolveEntry("bin", ports.joinHostPath("run", "bin"));
    }

    /** Startup locks and new port files follow the session lock layout. Existing
     * port inodes remain discoverable independently during a partial migration. */
    function clipboardStateDir(): string {
        return locksDir() === ports.joinHostPath(cccHome(), "locks") ? cccHome() : runDir();
    }

    function clipboardPortFile(): string {
        const legacy = ports.joinHostPath(cccHome(), "clipboard.port");
        if (ports.entryExists(legacy)) return legacy;
        const migrated = ports.joinHostPath(runDir(), "clipboard.port");
        // Retain an already moved inode after a partial migration. If no port file
        // exists yet (or a legacy daemon removed it), follow the active lock layout.
        return ports.entryExists(migrated) ? migrated : ports.joinHostPath(clipboardStateDir(), "clipboard.port");
    }

    function clipboardStartingLock(): string {
        return ports.joinHostPath(clipboardStateDir(), "clipboard.starting.v2");
    }

    function configFile(): string {
        return ports.joinHostPath(cccHome(), "config.json");
    }

    function legacyRemoteConfigDir(): string {
        return ports.joinHostPath(cccHome(), "remote");
    }

    return { cccHome, profilesDir, defaultProfileDir, ensureDefaultProfileDir, profileClaudeDir, profileClaudeJsonFile, profileCodexDir, runDir, locksDir, clipboardFilesDir, helperBinDir, clipboardStateDir, clipboardPortFile, clipboardStartingLock, configFile, legacyRemoteConfigDir };
}
