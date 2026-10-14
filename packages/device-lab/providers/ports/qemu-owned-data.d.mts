import type { QemuExecution } from "./qemu-lifecycle.mjs";
import type { QemuCopyPolicy, QemuCopyPlan } from "./qemu-guest-transfer.mjs";
import type { QemuOwnedLab as QemuLab } from "../domain/qemu-owned-data.mjs";
export interface QemuOwnedDataArguments {
    labId?: unknown;
    sourcePath?: unknown;
    destinationPath?: unknown;
    snapshotName?: unknown;
    snapshotId?: unknown;
    replace?: unknown;
    maxFiles?: unknown;
    maxFileBytes?: unknown;
    maxTotalBytes?: unknown;
}
export type QemuOwnedDataFailure = { ok: false; error: string; [key: string]: unknown };
export interface QemuOwnedDataPorts {
    ownerId(): string;
    readLab(labId: string): { ok: true; lab: QemuLab } | QemuOwnedDataFailure;
    writeLab(lab: QemuLab): undefined;
    clock(): string;
    workspaceRoot(): string;
    sourcePathFacts(path: string): { sourcePath: string; allowedRoots: string[]; withinRoots: boolean };
    workspacePathFacts(lab: QemuLab): { destinationPath: string; withinLab: boolean };
    artifactRoots(lab: QemuLab): { artifactsDir: string; workspaceDir: string };
    exportRoot(lab: QemuLab): string;
    defaultExportName(): string;
    resolvePath(base: string, path: string): string;
    pathWithinRoots(roots: string[], path: string): boolean;
    scanCopySource(path: string, policy: QemuCopyPolicy): QemuCopyPlan | QemuOwnedDataFailure;
    copyFiles(plan: QemuCopyPlan, destination: string, replace: boolean): { ok: true; destinationPath: string; files: number; bytes: number } | QemuOwnedDataFailure;
    diskPath(lab: QemuLab): { ok: true; diskPath: string } | QemuOwnedDataFailure;
    fileExists(path: string): boolean;
    qemuImgAvailable(): boolean;
    commandTimeoutMs(): unknown;
    executeSnapshot(action: string, name: string, diskPath: string, lab: QemuLab, timeoutMs: number): QemuExecution & { ok: boolean; then?: never };
}
