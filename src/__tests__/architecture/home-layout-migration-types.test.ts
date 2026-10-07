import { describe, expect, it } from "vitest";
import { createHomeLayoutMigration } from "../../application/home-layout-migration.js";
import type { ClipboardNamespace, ClipboardStartupSlot, HomeLayoutMigrationNotice, HomeLayoutMigrationOptions, HomeLayoutMigrationPorts, HomeLayoutMigrationResult, ManagedHomeEntry } from "../../ports/home-layout-migration.js";
import type { HomeLayoutMigrationOptions as PublicOptions, HomeLayoutMigrationResult as PublicResult } from "../../home-layout.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Keys = "homeExists" | "readReportedConflicts" | "defaultProfileExists" | "defaultProfileMarkerExists" | "profileNameExists" | "legacyEntryExists" | "targetEntryExists" | "startupSlotExists" | "clipboardPortIsRegular" | "listLegacyRemoteNames" | "legacyRemoteDirectoryIsEmpty" | "remoteEntryKey" | "readLegacyRemoteText" | "acquireMigrationLock" | "releaseMigrationLock" | "ensureRuntimeDirectory" | "claimStartupSlot" | "releaseStartupReceipt" | "renameDefaultProfile" | "ensureDefaultProfileDirectory" | "moveEntry" | "updateConfig" | "removeLegacyRemoteFile" | "removeEmptyLegacyRemoteDirectory" | "recordReportedConflicts" | "hasLiveSessions" | "hasContainerMounts" | "currentTime" | "report";
type ExactPorts = Assert<Equal<keyof HomeLayoutMigrationPorts<string>, Keys>>;
type ExactOptions = Assert<Equal<HomeLayoutMigrationOptions, {
    hasLiveSessions: () => boolean;
    hasContainerMounts?: () => boolean;
    retireLegacyClipboard?: (portFile: string) => void;
    warn?: (message: string) => void;
    now?: () => number;
}>>;
type ExactResult = Assert<Equal<HomeLayoutMigrationResult,
    { status: "not-needed" | "busy" | "sessions-active" | "mounts-active" }
    | { status: "migrated"; moved: string[]; failed: string[] }>>;
type SameOptions = Assert<Equal<HomeLayoutMigrationOptions, PublicOptions>>;
type SameResult = Assert<Equal<HomeLayoutMigrationResult, PublicResult>>;
type ExactEntries = Assert<Equal<ManagedHomeEntry, "clipboard.port" | "claude" | "claude.json" | "codex" | "locks" | "clipboard-files" | "bin">>;
type ExactNamespaces = Assert<Equal<ClipboardNamespace, "legacy" | "run">>;
type ExactSlots = Assert<Equal<ClipboardStartupSlot, { readonly namespace: ClipboardNamespace; readonly name: "clipboard.starting" | "clipboard.starting.v2" }>>;
type ExactNotice = Assert<Equal<HomeLayoutMigrationNotice,
    | { kind: "clipboard-conflict" }
    | { kind: "unsafe-clipboard"; namespace: ClipboardNamespace }
    | { kind: "default-profile-renamed"; name: string }
    | { kind: "profile-prepare-failed"; error: unknown }
    | { kind: "entry-conflict"; entry: ManagedHomeEntry }
    | { kind: "clipboard-move-failed" }
    | { kind: "entry-move-failed"; entry: ManagedHomeEntry; error: unknown }
    | { kind: "invalid-remote"; name: string }
    | { kind: "remote-merge-failed"; error: unknown }>>;
function contracts(ports: HomeLayoutMigrationPorts<number>, slot: ClipboardStartupSlot) {
    const run: () => HomeLayoutMigrationResult = createHomeLayoutMigration(ports);
    const receipt: number = ports.claimStartupSlot(slot);
    const release: undefined = ports.releaseStartupReceipt(receipt);
    const primitive = createHomeLayoutMigration({ ...ports, claimStartupSlot: () => false, releaseStartupReceipt: (_value: boolean) => undefined });
    const opaque = createHomeLayoutMigration({ ...ports, claimStartupSlot: () => null, releaseStartupReceipt: (_value: null) => undefined });
    const legacy: HomeLayoutMigrationOptions = { hasLiveSessions: () => false,
        warn: async (_message: string) => {}, retireLegacyClipboard: async (_path: string) => {} };
    legacy.warn = () => {};
    legacy.retireLegacyClipboard = () => {};
    void [run, receipt, release, primitive, opaque, legacy];
    // @ts-expect-error Ports are required.
    createHomeLayoutMigration();
    // @ts-expect-error New effects cannot return void.
    createHomeLayoutMigration({ ...ports, moveEntry: (): void => {} });
    // @ts-expect-error Config mutators must finish with undefined.
    ports.updateConfig((_config): void => {});
    // @ts-expect-error Config mutators cannot be asynchronous.
    ports.updateConfig(async _config => {});
    // @ts-expect-error Config mutators receive unknown values.
    ports.updateConfig(config => { const host: string = config.host; void host; return undefined; });
    // @ts-expect-error Receipt remains the caller's opaque numeric token.
    ports.releaseStartupReceipt({ dev: 1, ino: 2 });
    // @ts-expect-error Observation returns a boolean rather than native stats.
    createHomeLayoutMigration({ ...ports, clipboardPortIsRegular: () => ({ dev: 1, ino: 2, isFile: () => true }) });
    // @ts-expect-error Notice union is closed.
    ports.report({ kind: "unknown" });
    // @ts-expect-error Raw diagnostic is required.
    ports.report({ kind: "remote-merge-failed" });
    // @ts-expect-error Managed entry excludes arbitrary native paths.
    ports.moveEntry("/private/home/.ccc/auth");
    // @ts-expect-error Native paths are not startup slots.
    ports.startupSlotExists("/private/home/.ccc/clipboard.starting");
    // @ts-expect-error The application is synchronous.
    const promise: Promise<HomeLayoutMigrationResult> = run();
    void promise;
    // @ts-expect-error homeExists is readonly.
    ports.homeExists = ports.homeExists;
    { const { homeExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error homeExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error readReportedConflicts is readonly.
    ports.readReportedConflicts = ports.readReportedConflicts;
    { const { readReportedConflicts: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error readReportedConflicts is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error defaultProfileExists is readonly.
    ports.defaultProfileExists = ports.defaultProfileExists;
    { const { defaultProfileExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error defaultProfileExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error defaultProfileMarkerExists is readonly.
    ports.defaultProfileMarkerExists = ports.defaultProfileMarkerExists;
    { const { defaultProfileMarkerExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error defaultProfileMarkerExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error profileNameExists is readonly.
    ports.profileNameExists = ports.profileNameExists;
    { const { profileNameExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error profileNameExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error legacyEntryExists is readonly.
    ports.legacyEntryExists = ports.legacyEntryExists;
    { const { legacyEntryExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error legacyEntryExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error targetEntryExists is readonly.
    ports.targetEntryExists = ports.targetEntryExists;
    { const { targetEntryExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error targetEntryExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error startupSlotExists is readonly.
    ports.startupSlotExists = ports.startupSlotExists;
    { const { startupSlotExists: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error startupSlotExists is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error clipboardPortIsRegular is readonly.
    ports.clipboardPortIsRegular = ports.clipboardPortIsRegular;
    { const { clipboardPortIsRegular: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error clipboardPortIsRegular is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error listLegacyRemoteNames is readonly.
    ports.listLegacyRemoteNames = ports.listLegacyRemoteNames;
    { const { listLegacyRemoteNames: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error listLegacyRemoteNames is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error legacyRemoteDirectoryIsEmpty is readonly.
    ports.legacyRemoteDirectoryIsEmpty = ports.legacyRemoteDirectoryIsEmpty;
    { const { legacyRemoteDirectoryIsEmpty: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error legacyRemoteDirectoryIsEmpty is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error remoteEntryKey is readonly.
    ports.remoteEntryKey = ports.remoteEntryKey;
    { const { remoteEntryKey: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error remoteEntryKey is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error readLegacyRemoteText is readonly.
    ports.readLegacyRemoteText = ports.readLegacyRemoteText;
    { const { readLegacyRemoteText: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error readLegacyRemoteText is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error acquireMigrationLock is readonly.
    ports.acquireMigrationLock = ports.acquireMigrationLock;
    { const { acquireMigrationLock: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error acquireMigrationLock is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error releaseMigrationLock is readonly.
    ports.releaseMigrationLock = ports.releaseMigrationLock;
    { const { releaseMigrationLock: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error releaseMigrationLock is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error ensureRuntimeDirectory is readonly.
    ports.ensureRuntimeDirectory = ports.ensureRuntimeDirectory;
    { const { ensureRuntimeDirectory: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error ensureRuntimeDirectory is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error claimStartupSlot is readonly.
    ports.claimStartupSlot = ports.claimStartupSlot;
    { const { claimStartupSlot: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error claimStartupSlot is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error releaseStartupReceipt is readonly.
    ports.releaseStartupReceipt = ports.releaseStartupReceipt;
    { const { releaseStartupReceipt: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error releaseStartupReceipt is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error renameDefaultProfile is readonly.
    ports.renameDefaultProfile = ports.renameDefaultProfile;
    { const { renameDefaultProfile: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error renameDefaultProfile is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error ensureDefaultProfileDirectory is readonly.
    ports.ensureDefaultProfileDirectory = ports.ensureDefaultProfileDirectory;
    { const { ensureDefaultProfileDirectory: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error ensureDefaultProfileDirectory is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error moveEntry is readonly.
    ports.moveEntry = ports.moveEntry;
    { const { moveEntry: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error moveEntry is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error updateConfig is readonly.
    ports.updateConfig = ports.updateConfig;
    { const { updateConfig: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error updateConfig is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error removeLegacyRemoteFile is readonly.
    ports.removeLegacyRemoteFile = ports.removeLegacyRemoteFile;
    { const { removeLegacyRemoteFile: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error removeLegacyRemoteFile is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error removeEmptyLegacyRemoteDirectory is readonly.
    ports.removeEmptyLegacyRemoteDirectory = ports.removeEmptyLegacyRemoteDirectory;
    { const { removeEmptyLegacyRemoteDirectory: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error removeEmptyLegacyRemoteDirectory is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error recordReportedConflicts is readonly.
    ports.recordReportedConflicts = ports.recordReportedConflicts;
    { const { recordReportedConflicts: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error recordReportedConflicts is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error hasLiveSessions is readonly.
    ports.hasLiveSessions = ports.hasLiveSessions;
    { const { hasLiveSessions: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error hasLiveSessions is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error hasContainerMounts is readonly.
    ports.hasContainerMounts = ports.hasContainerMounts;
    { const { hasContainerMounts: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error hasContainerMounts is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error currentTime is readonly.
    ports.currentTime = ports.currentTime;
    { const { currentTime: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error currentTime is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error report is readonly.
    ports.report = ports.report;
    { const { report: omitted, ...remaining } = ports; void omitted;
        // @ts-expect-error report is required.
        createHomeLayoutMigration(remaining);
    }
    // @ts-expect-error homeExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, homeExists: async (...args: Parameters<typeof ports.homeExists>) => ports.homeExists(...args) });
    // @ts-expect-error readReportedConflicts cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, readReportedConflicts: async (...args: Parameters<typeof ports.readReportedConflicts>) => ports.readReportedConflicts(...args) });
    // @ts-expect-error defaultProfileExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, defaultProfileExists: async (...args: Parameters<typeof ports.defaultProfileExists>) => ports.defaultProfileExists(...args) });
    // @ts-expect-error defaultProfileMarkerExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, defaultProfileMarkerExists: async (...args: Parameters<typeof ports.defaultProfileMarkerExists>) => ports.defaultProfileMarkerExists(...args) });
    // @ts-expect-error profileNameExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, profileNameExists: async (...args: Parameters<typeof ports.profileNameExists>) => ports.profileNameExists(...args) });
    // @ts-expect-error legacyEntryExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, legacyEntryExists: async (...args: Parameters<typeof ports.legacyEntryExists>) => ports.legacyEntryExists(...args) });
    // @ts-expect-error targetEntryExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, targetEntryExists: async (...args: Parameters<typeof ports.targetEntryExists>) => ports.targetEntryExists(...args) });
    // @ts-expect-error startupSlotExists cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, startupSlotExists: async (...args: Parameters<typeof ports.startupSlotExists>) => ports.startupSlotExists(...args) });
    // @ts-expect-error clipboardPortIsRegular cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, clipboardPortIsRegular: async (...args: Parameters<typeof ports.clipboardPortIsRegular>) => ports.clipboardPortIsRegular(...args) });
    // @ts-expect-error listLegacyRemoteNames cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, listLegacyRemoteNames: async (...args: Parameters<typeof ports.listLegacyRemoteNames>) => ports.listLegacyRemoteNames(...args) });
    // @ts-expect-error legacyRemoteDirectoryIsEmpty cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, legacyRemoteDirectoryIsEmpty: async (...args: Parameters<typeof ports.legacyRemoteDirectoryIsEmpty>) => ports.legacyRemoteDirectoryIsEmpty(...args) });
    // @ts-expect-error remoteEntryKey cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, remoteEntryKey: async (...args: Parameters<typeof ports.remoteEntryKey>) => ports.remoteEntryKey(...args) });
    // @ts-expect-error readLegacyRemoteText cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, readLegacyRemoteText: async (...args: Parameters<typeof ports.readLegacyRemoteText>) => ports.readLegacyRemoteText(...args) });
    // @ts-expect-error acquireMigrationLock cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, acquireMigrationLock: async (...args: Parameters<typeof ports.acquireMigrationLock>) => ports.acquireMigrationLock(...args) });
    // @ts-expect-error releaseMigrationLock cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, releaseMigrationLock: async (...args: Parameters<typeof ports.releaseMigrationLock>) => ports.releaseMigrationLock(...args) });
    // @ts-expect-error ensureRuntimeDirectory cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, ensureRuntimeDirectory: async (...args: Parameters<typeof ports.ensureRuntimeDirectory>) => ports.ensureRuntimeDirectory(...args) });
    // @ts-expect-error releaseStartupReceipt cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, releaseStartupReceipt: async (...args: Parameters<typeof ports.releaseStartupReceipt>) => ports.releaseStartupReceipt(...args) });
    // @ts-expect-error renameDefaultProfile cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, renameDefaultProfile: async (...args: Parameters<typeof ports.renameDefaultProfile>) => ports.renameDefaultProfile(...args) });
    // @ts-expect-error ensureDefaultProfileDirectory cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, ensureDefaultProfileDirectory: async (...args: Parameters<typeof ports.ensureDefaultProfileDirectory>) => ports.ensureDefaultProfileDirectory(...args) });
    // @ts-expect-error moveEntry cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, moveEntry: async (...args: Parameters<typeof ports.moveEntry>) => ports.moveEntry(...args) });
    // @ts-expect-error updateConfig cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, updateConfig: async (...args: Parameters<typeof ports.updateConfig>) => ports.updateConfig(...args) });
    // @ts-expect-error removeLegacyRemoteFile cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, removeLegacyRemoteFile: async (...args: Parameters<typeof ports.removeLegacyRemoteFile>) => ports.removeLegacyRemoteFile(...args) });
    // @ts-expect-error removeEmptyLegacyRemoteDirectory cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, removeEmptyLegacyRemoteDirectory: async (...args: Parameters<typeof ports.removeEmptyLegacyRemoteDirectory>) => ports.removeEmptyLegacyRemoteDirectory(...args) });
    // @ts-expect-error recordReportedConflicts cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, recordReportedConflicts: async (...args: Parameters<typeof ports.recordReportedConflicts>) => ports.recordReportedConflicts(...args) });
    // @ts-expect-error hasLiveSessions cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, hasLiveSessions: async (...args: Parameters<typeof ports.hasLiveSessions>) => ports.hasLiveSessions(...args) });
    // @ts-expect-error hasContainerMounts cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, hasContainerMounts: async (...args: Parameters<typeof ports.hasContainerMounts>) => ports.hasContainerMounts(...args) });
    // @ts-expect-error currentTime cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, currentTime: async (...args: Parameters<typeof ports.currentTime>) => ports.currentTime(...args) });
    // @ts-expect-error report cannot be implemented asynchronously.
    createHomeLayoutMigration({ ...ports, report: async (...args: Parameters<typeof ports.report>) => ports.report(...args) });
}
void contracts;
export type MigrationContractProofs = [ExactPorts, ExactOptions, ExactResult, SameOptions, SameResult, ExactEntries, ExactNamespaces, ExactSlots, ExactNotice];
describe("home layout migration type contracts", () => {
    it("keeps the result vocabulary synchronous and relative", () => {
        const result: HomeLayoutMigrationResult = { status: "migrated", moved: ["codex"], failed: [] };
        expect(result).toEqual({ status: "migrated", moved: ["codex"], failed: [] });
    });
});

