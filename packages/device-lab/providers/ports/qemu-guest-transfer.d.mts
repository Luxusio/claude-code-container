import type { QemuLab, QemuFailure } from "./qemu-lifecycle.mjs";
export type { QemuLab, QemuFailure } from "./qemu-lifecycle.mjs";
export interface QemuGuestTransferArgs {
    labId?: unknown;
    guestPath?: unknown;
    sourcePath?: unknown;
    destinationPath?: unknown;
    replace?: unknown;
    dryRun?: unknown;
    maxFiles?: unknown;
    maxFileBytes?: unknown;
    maxTotalBytes?: unknown;
}
export interface QemuCopyPolicy {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
}
export interface QemuCopyPlan {
    ok: true;
    sourceRoot: string;
    rootIsFile: boolean;
    files: {
        absPath: string;
        relPath: string;
        size: number;
    }[];
    totalBytes: number;
}
export interface QemuGuestTransport {
    action: "push" | "pull";
    labId: string;
    guestPath: string;
    allowedGuestRoots: string[];
    replace: boolean;
    sourcePath?: string;
    stagedPath?: string;
    destinationPath?: string;
    files?: number;
    bytes?: number;
}
export interface QemuFileOperation {
    type: string;
    guestPath?: string;
    sourcePath?: string;
    destinationPath?: string;
    stagedPath?: string;
    files?: number;
    bytes?: number;
    completedAt: unknown;
    error?: string;
}
export interface QemuGuestTransferPorts {
    ownerId(): string;
    readLab(labId: string): {
        ok: true;
        lab: QemuLab;
    } | QemuFailure;
    allowedGuestRoots(): unknown;
    pathWithinRoots(roots: string[], path: string): boolean;
    workspaceRoot(): string;
    sourcePathFacts(path: string): {
        sourcePath: string;
        allowedRoots: string[];
        withinRoots: boolean;
    };
    workspacePathFacts(lab: QemuLab): {
        workspaceDir: string;
        insideLab: boolean;
    };
    defaultPullDestination(lab: QemuLab, name: string): string;
    destinationTimestamp(): string;
    resolvePullDestination(lab: QemuLab, path: unknown): {
        ok: true;
        destinationPath: string;
    } | QemuFailure;
    scanCopySource(path: string, policy: QemuCopyPolicy): QemuCopyPlan | QemuFailure;
    copyPlan(plan: QemuCopyPlan, destination: string, replace: boolean): {
        ok: true;
        destinationPath: string;
        files: number;
        bytes: number;
    } | QemuFailure;
    transportRunner(lab: QemuLab): ((transport: QemuGuestTransport) => unknown) | null;
    preflightTransport(lab: QemuLab, transport: QemuGuestTransport): {
        ok: true;
    } | QemuFailure;
    exists(path: string): boolean;
    removeDirectory(path: string): undefined;
    ensureDirectory(path: string): undefined;
    writeLab(lab: QemuLab): undefined;
    clock(): unknown;
}
