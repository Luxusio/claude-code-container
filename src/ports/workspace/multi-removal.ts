import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";

export interface MultiRemovalRequest {
    readonly repositoryPath: string;
    readonly destinationPath: string;
    readonly branch: string;
    readonly options: { force?: boolean } | undefined;
}

export interface MultiRemovalPorts<WorkspaceIdentity, EntryIdentity, Registration> {
    readonly scanSource: (request: MultiRemovalRequest) => WorkspaceEntry[];
    readonly destinationPath: (request: MultiRemovalRequest, name: string) => string;
    readonly pathExists: (path: string) => boolean;
    readonly assertWorkspaceIdentity: (request: MultiRemovalRequest, identity: WorkspaceIdentity) => void;
    readonly worktreeMatches: (source: string, destination: string) => boolean;
    readonly unmanagedPathRefusal: (destination: string) => string;
    readonly captureWorktreeIdentity: (destination: string) => EntryIdentity;
    readonly captureRegistration: (
        request: MultiRemovalRequest, source: string, destination: string, identity: EntryIdentity,
    ) => Registration;
    readonly removeRegisteredEntry: (
        request: MultiRemovalRequest, source: string, destination: string,
        identity: EntryIdentity, receipt: Registration, force: boolean,
    ) => void;
    readonly scanWorkspace: (request: MultiRemovalRequest) => WorkspaceEntry[];
    readonly captureCopiedIdentity: (destination: string) => EntryIdentity;
    readonly quarantineCopiedEntry: (
        request: MultiRemovalRequest, destination: string, identity: EntryIdentity,
    ) => void;
    readonly remainingNames: (request: MultiRemovalRequest) => string[];
    readonly quarantineWorkspace: (request: MultiRemovalRequest, identity: WorkspaceIdentity) => void;
    readonly relayEntryError: (name: string, destination: string, error: unknown) => string;
}
