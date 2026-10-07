export interface HomeLayoutMigrationOptions {
    /** True when a ccc session may still be using the pre-layout paths. */
    hasLiveSessions: () => boolean;
    /** True if any stopped/running container still references legacy managed paths. */
    hasContainerMounts?: () => boolean;
    /** Deprecated: retained for callers; normal clipboard startup owns retirement. */
    retireLegacyClipboard?: (portFile: string) => void;
    warn?: (message: string) => void;
    now?: () => number;
}

export type HomeLayoutMigrationResult =
    | { status: "not-needed" | "busy" | "sessions-active" | "mounts-active" }
    | { status: "migrated"; moved: string[]; failed: string[] };

export type ManagedHomeEntry = "clipboard.port" | "claude" | "claude.json" | "codex"
    | "locks" | "clipboard-files" | "bin";
export type ClipboardNamespace = "legacy" | "run";
export interface ClipboardStartupSlot {
    readonly namespace: ClipboardNamespace;
    readonly name: "clipboard.starting" | "clipboard.starting.v2";
}
export type HomeLayoutMigrationNotice =
    | { kind: "clipboard-conflict" }
    | { kind: "unsafe-clipboard"; namespace: ClipboardNamespace }
    | { kind: "default-profile-renamed"; name: string }
    | { kind: "profile-prepare-failed"; error: unknown }
    | { kind: "entry-conflict"; entry: ManagedHomeEntry }
    | { kind: "clipboard-move-failed" }
    | { kind: "entry-move-failed"; entry: ManagedHomeEntry; error: unknown }
    | { kind: "invalid-remote"; name: string }
    | { kind: "remote-merge-failed"; error: unknown };
export interface HomeLayoutMigrationPorts<StartupReceipt> {
    readonly homeExists: () => boolean;
    readonly readReportedConflicts: () => Set<string>;
    readonly defaultProfileExists: () => boolean;
    readonly defaultProfileMarkerExists: () => boolean;
    readonly profileNameExists: (name: string) => boolean;
    readonly legacyEntryExists: (entry: ManagedHomeEntry) => boolean;
    readonly targetEntryExists: (entry: ManagedHomeEntry) => boolean;
    readonly startupSlotExists: (slot: ClipboardStartupSlot) => boolean;
    readonly clipboardPortIsRegular: (namespace: ClipboardNamespace) => boolean;
    readonly listLegacyRemoteNames: () => string[];
    readonly legacyRemoteDirectoryIsEmpty: () => boolean;
    readonly remoteEntryKey: (name: string) => string;
    readonly readLegacyRemoteText: (name: string) => string;
    readonly acquireMigrationLock: (now: number) => boolean;
    readonly releaseMigrationLock: () => undefined;
    readonly ensureRuntimeDirectory: () => undefined;
    readonly claimStartupSlot: (slot: ClipboardStartupSlot) => StartupReceipt;
    readonly releaseStartupReceipt: (receipt: StartupReceipt) => undefined;
    readonly renameDefaultProfile: (name: string) => undefined;
    readonly ensureDefaultProfileDirectory: () => undefined;
    readonly moveEntry: (entry: ManagedHomeEntry) => undefined;
    readonly updateConfig: (mutate: (config: Record<string, unknown>) => undefined) => undefined;
    readonly removeLegacyRemoteFile: (name: string) => undefined;
    readonly removeEmptyLegacyRemoteDirectory: () => undefined;
    readonly recordReportedConflicts: (reported: Set<string>) => undefined;
    readonly hasLiveSessions: () => boolean;
    readonly hasContainerMounts: () => boolean;
    readonly currentTime: () => number;
    readonly report: (notice: HomeLayoutMigrationNotice) => undefined;
}
