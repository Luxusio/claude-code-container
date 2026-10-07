import type { ClipboardStartupSlot, HomeLayoutMigrationPorts, HomeLayoutMigrationResult, ManagedHomeEntry } from "../ports/home-layout-migration.js";

const DEFAULT_PROFILE_ENTRIES = ["claude", "claude.json", "codex"] as const;
const MOVES: readonly ManagedHomeEntry[] = ["clipboard.port", ...DEFAULT_PROFILE_ENTRIES, "locks", "clipboard-files", "bin"];
const STARTUP_SLOTS: readonly ClipboardStartupSlot[] = [
    { namespace: "legacy", name: "clipboard.starting" },
    { namespace: "legacy", name: "clipboard.starting.v2" },
    { namespace: "run", name: "clipboard.starting" },
    { namespace: "run", name: "clipboard.starting.v2" },
];

export function createHomeLayoutMigration<StartupReceipt>(ports: HomeLayoutMigrationPorts<StartupReceipt>): () => HomeLayoutMigrationResult {
    for (const name of [
        "homeExists", "readReportedConflicts", "defaultProfileExists", "defaultProfileMarkerExists", "profileNameExists",
        "legacyEntryExists", "targetEntryExists", "startupSlotExists", "clipboardPortIsRegular", "listLegacyRemoteNames",
        "legacyRemoteDirectoryIsEmpty", "remoteEntryKey", "readLegacyRemoteText", "acquireMigrationLock", "releaseMigrationLock",
        "ensureRuntimeDirectory", "claimStartupSlot", "releaseStartupReceipt", "renameDefaultProfile", "ensureDefaultProfileDirectory",
        "moveEntry", "updateConfig", "removeLegacyRemoteFile", "removeEmptyLegacyRemoteDirectory", "recordReportedConflicts",
        "hasLiveSessions", "hasContainerMounts", "currentTime", "report",
    ] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Home layout migration requires a callable ${name} port.`);
    }

    function unmarkedDefaultProfile(): boolean {
        return ports.defaultProfileExists() && !ports.defaultProfileMarkerExists()
            && DEFAULT_PROFILE_ENTRIES.some((entry) => ports.legacyEntryExists(entry));
    }

    function legacyRemoteFiles(): string[] {
        return ports.listLegacyRemoteNames().filter((name) => name.endsWith(".json"));
    }

    function pendingWork(reported: Set<string>): boolean {
        if (unmarkedDefaultProfile()) return true;
        for (const entry of MOVES) {
            if (!ports.legacyEntryExists(entry)) continue;
            if (!ports.targetEntryExists(entry) || !reported.has(entry)) return true;
        }
        if (STARTUP_SLOTS.slice(0, 2).some((slot) => ports.startupSlotExists(slot))) return true;
        if (legacyRemoteFiles().some((name) => !reported.has(ports.remoteEntryKey(name)))) return true;
        return ports.legacyRemoteDirectoryIsEmpty();
    }

    function mergeLegacyRemoteConfigs(reported: Set<string>): string[] {
        const merged: string[] = [];
        const parsed: Record<string, unknown> = {};
        for (const name of legacyRemoteFiles()) {
            try {
                parsed[name.slice(0, -".json".length)] = JSON.parse(ports.readLegacyRemoteText(name));
                merged.push(name);
            } catch {
                const key = ports.remoteEntryKey(name);
                if (!reported.has(key)) {
                    ports.report({ kind: "invalid-remote", name });
                    reported.add(key);
                }
            }
        }
        if (merged.length > 0) {
            ports.updateConfig((config) => {
                const remote = config.remote && typeof config.remote === "object" && !Array.isArray(config.remote)
                    ? config.remote as Record<string, unknown>
                    : {};
                for (const [hash, value] of Object.entries(parsed)) {
                    if (!(hash in remote)) remote[hash] = value;
                }
                config.remote = remote;
                return undefined;
            });
            for (const name of merged) ports.removeLegacyRemoteFile(name);
        }
        ports.removeEmptyLegacyRemoteDirectory();
        return merged.map((name) => ports.remoteEntryKey(name));
    }

    return () => {
        if (!ports.homeExists()) return { status: "not-needed" };
        const reported = ports.readReportedConflicts();
        if (!pendingWork(reported)) return { status: "not-needed" };
        if (!ports.acquireMigrationLock(ports.currentTime())) return { status: "busy" };
        const reportedBefore = reported.size;
        const clipboardLocks: StartupReceipt[] = [];
        try {
            if (ports.hasLiveSessions()) return { status: "sessions-active" };
            if (ports.hasContainerMounts()) return { status: "mounts-active" };
            if (STARTUP_SLOTS.some((slot) => ports.startupSlotExists(slot))) return { status: "busy" };
            if (ports.legacyEntryExists("clipboard.port") && ports.targetEntryExists("clipboard.port")) {
                ports.report({ kind: "clipboard-conflict" });
                return { status: "busy" };
            }
            for (const namespace of ["legacy", "run"] as const) {
                const present = namespace === "legacy" ? ports.legacyEntryExists("clipboard.port") : ports.targetEntryExists("clipboard.port");
                if (present && !ports.clipboardPortIsRegular(namespace)) {
                    ports.report({ kind: "unsafe-clipboard", namespace });
                    return { status: "busy" };
                }
            }
            ports.ensureRuntimeDirectory();
            for (const slot of STARTUP_SLOTS) {
                try {
                    clipboardLocks.push(ports.claimStartupSlot(slot));
                } catch {
                    return { status: "busy" };
                }
            }
            const moved: string[] = [];
            const failed: string[] = [];
            try {
                if (unmarkedDefaultProfile()) {
                    let name = "default-pre-layout";
                    for (let suffix = 2; ports.profileNameExists(name); suffix++) name = `default-pre-layout-${suffix}`;
                    ports.renameDefaultProfile(name);
                    ports.report({ kind: "default-profile-renamed", name });
                }
                if (DEFAULT_PROFILE_ENTRIES.some((entry) => ports.legacyEntryExists(entry))) ports.ensureDefaultProfileDirectory();
            } catch (error) {
                ports.report({ kind: "profile-prepare-failed", error });
                return { status: "migrated", moved, failed: [...DEFAULT_PROFILE_ENTRIES] };
            }
            for (const entry of MOVES) {
                if (!ports.legacyEntryExists(entry)) continue;
                if (ports.targetEntryExists(entry)) {
                    if (!reported.has(entry)) {
                        ports.report({ kind: "entry-conflict", entry });
                        reported.add(entry);
                    }
                    continue;
                }
                try {
                    ports.moveEntry(entry);
                    moved.push(entry);
                } catch (error) {
                    failed.push(entry);
                    if (entry === "clipboard.port") {
                        ports.report({ kind: "clipboard-move-failed" });
                        return { status: "migrated", moved, failed };
                    }
                    ports.report({ kind: "entry-move-failed", entry, error });
                }
            }
            try {
                moved.push(...mergeLegacyRemoteConfigs(reported));
            } catch (error) {
                failed.push("remote");
                ports.report({ kind: "remote-merge-failed", error });
            }
            return { status: "migrated", moved, failed };
        } finally {
            for (const receipt of clipboardLocks) ports.releaseStartupReceipt(receipt);
            if (reported.size !== reportedBefore) ports.recordReportedConflicts(reported);
            ports.releaseMigrationLock();
        }
    };
}
