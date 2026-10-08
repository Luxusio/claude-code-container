import type { CodexStateDirectory, CodexStateRuntime, CodexStateRootReceipt } from "../../domain/credentials/codex-state-ownership.js";

/** Synchronous semantic observations and one fixed native ownership effect. */
export interface CodexStateOwnershipPorts {
    managedRoot(profile?: string): string;
    nestedContainerMarker(): string | undefined;
    runtime(): CodexStateRuntime;
    platform(): string;
    effectiveUid(): number | undefined;
    effectiveGid(): number | undefined;
    normalizeImage(image: string): string;
    previousAccount(image: string): string;
    directory(path: string): CodexStateDirectory;
    parent(path: string): string;
    activeIds(): string;
    inspectActive(ids: string[]): string;
    isAbsolute(path: string): boolean;
    realpath(path: string): string;
    readonly separator: string;
    migrate(root: string, image: string, oldUid: string, oldGid: string, newUid: string, newGid: string, receipt: CodexStateRootReceipt): undefined;
}
