/** Raw metadata stays mutable and retains fields outside these operations. */
export interface QemuRuntime { [key: string]: unknown; pid?: unknown; command?: unknown; startedAt?: unknown; }
export interface QemuLab {
    [key: string]: unknown;
    id: string;
    name: string;
    provider?: string;
    runtimeState: string;
    image?: { [key: string]: unknown; sourceImage?: string; diskImage?: string; format?: unknown; };
    paths: { [key: string]: unknown; labDir: string; workspaceDir: string; artifactsDir: string; };
    runtime?: unknown;
    readiness?: { [key: string]: unknown; latest?: { [key: string]: unknown; state?: unknown; } | null; };
    guest?: { [key: string]: unknown; ssh?: unknown; agent?: unknown; };
}
export interface QemuFailure { [key: string]: unknown; ok: false; error: string; }
export interface QemuImageSource { [key: string]: unknown; ok: true; path: string; format: string; }
export interface QemuProviderStatus { [key: string]: unknown; available: boolean; qemuImg?: string | null; }
export interface QemuExecution { [key: string]: unknown; ok?: boolean; args?: unknown; }
export interface QemuDiskArguments { [key: string]: unknown; labId?: unknown; force?: unknown; dryRun?: unknown; }
export interface QemuTargetArguments { [key: string]: unknown; labId?: unknown; }
export interface QemuImageDiskTargetPorts {
    ownerId: string;
    providerCommandTimeoutMs?: unknown;
    imagesRootExists(): boolean;
    imageEntries(): Array<{ name: string; isDirectory(): boolean; }>;
    readImageMetadata(name: string): QemuImageMetadata;
    readLab(labId: string): { ok: true; lab: QemuLab; } | QemuFailure;
    validateImageSource(sourcePath: string | undefined, format: unknown): QemuImageSource | QemuFailure;
    validateDiskPath(lab: QemuLab): { ok: true; diskPath: string; } | QemuFailure;
    diskExists(diskPath: string): boolean;
    providerStatus(): QemuProviderStatus;
    createOverlay(input: { sourcePath: string; sourceFormat: string; diskPath: string; labDirectory: string; dryRun: boolean; timeoutMs: number; }, status: QemuProviderStatus): QemuOverlayResult;
    now(): string;
    writeLab(lab: QemuLab): undefined;
    presentLab(lab: QemuLab): QemuLab;
    presentExecution<T>(execution: T): T;
    ownerLabs(): QemuLab[];
}

export type QemuImageMetadata = null | boolean | number | string | QemuImageMetadata[] | { [key: string]: QemuImageMetadata };
export interface QemuDiskMetadata { kind: string; path: string; backingPath: string; backingFormat: string; materializedAt: string; forced: boolean; }
export interface QemuOverlaySuccess { ok: true; command: string; args: string[]; dryRun?: boolean; providerStatus?: QemuProviderStatus; result?: QemuExecution | null; }
export type QemuOverlayResult = QemuOverlaySuccess | QemuFailure;
export interface QemuDiskSuccess { ok: true; ownerId: string; lab: QemuLab; materialized: boolean; diskImage: string; reused?: boolean; dryRun?: boolean; plan?: QemuOverlaySuccess; disk?: QemuDiskMetadata; result?: QemuExecution | null; }
export type QemuDiskResult = QemuDiskSuccess | QemuFailure;
export interface QemuTarget {
    id: string; labId: string; name: string; targetKind: string; provider: string; runtimeState: string;
    readiness: string; sessionState: string; attachable: boolean; creatable: boolean;
    runtime: { pid: unknown; command: unknown; startedAt: unknown; } | null;
    readinessProbe: { [key: string]: unknown; state?: unknown; } | null;
    paths: { workspaceDir: string; artifactsDir: string; };
    sessionHints: { monitor: string; metadata: string; guestSsh: string; guestAgent: string; };
}
export type QemuTargetResult = { ok: true; ownerId: string; targets: QemuTarget[]; } | QemuFailure;
