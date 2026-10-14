import type { QemuExecution } from "./qemu-lifecycle.mjs";
import type { QemuTarget } from "../domain/qemu-image-disk-target.mjs";
import type { QemuAccessLab as QemuLab } from "../domain/qemu-guest-access.mjs";
export interface QemuAccessArguments {
    labId?: unknown;
    targetId?: unknown;
    sessionId?: unknown;
    sessionType?: unknown;
    timeoutMs?: unknown;
    command?: unknown;
}
export type QemuProbeObservation = { [key: string]: unknown; then?: never; state?: string; ok?: boolean; ready?: boolean; checks?: unknown[]; diagnostics?: unknown };
export interface QemuGuestAccessPorts {
    ownerId(): string;
    readLab(labId: string): { ok: true; lab: QemuLab } | { ok: false; error: string; [key: string]: unknown };
    writeLab(lab: QemuLab): undefined;
    clock(): string;
    processExists(pid: unknown, lab: QemuLab): boolean;
    sshAvailable(): boolean;
    executeGuestCommand(lab: QemuLab, commandText: string | undefined, timeoutMs: number): { result: (QemuExecution & { then?: never }) | null | undefined; redactionPaths: string[]; then?: never };
    sshReadinessTimeoutMs(): number | undefined;
    guestAgentReadinessTimeoutMs(): number | undefined;
    hasReadinessObservation(): boolean;
    observeReadiness(lab: QemuLab, facts: { target: QemuTarget; checkedAt: string }): QemuProbeObservation | null | undefined;
}
