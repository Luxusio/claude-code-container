/** The authenticated broker variant deliberately keeps its own lifecycle DTOs. */
export interface BrokerAndroidLifecycleRequest {
    ok: true;
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
    force: boolean;
    dryRun: boolean;
    headless?: boolean;
    waitForBoot?: boolean;
    bootTimeoutMs?: number;
    deleteAvd?: boolean;
    create?: Record<string, unknown>;
}

/** Settled command facts; native command evidence stays in the opaque receipt. */
export interface BrokerAndroidProviderResult<Receipt> {
    ok: boolean;
    mode: string; provider: string; receipt?: Receipt;
    typedCreateInvalidResult?: boolean;
}
export interface BrokerAndroidStopInventoryObservation<Receipt> extends BrokerAndroidProviderResult<Receipt> {
    /** Native inventory has the exact ADB header and is neither timed out nor truncated. */
    available: boolean;
    serialPresent: boolean;
}
export interface BrokerAndroidBootProbeObservation<Receipt> extends BrokerAndroidProviderResult<Receipt> {
    ready: boolean;
}
export type BrokerAndroidPreparation<Effect> =
    | {kind: "ready"; effect: Effect; mode: string; provider: string}
    | {kind: "metadata-only"}
    | {kind: "unavailable"; error: string; missing: string[]};
export type BrokerAndroidBoot<Receipt> =
    | {ok: true; ready: boolean; skipped?: boolean; result?: BrokerAndroidProviderResult<Receipt>; attempts?: BrokerAndroidProviderResult<Receipt>[]}
    | {ok: false; ready: false; reason: "probe-unavailable"; error: BrokerAndroidProviderResult<Receipt>; attempts?: BrokerAndroidProviderResult<Receipt>[]}
    | {ok: false; ready: false; reason: "deadline-exceeded"; serial: string | null; last?: BrokerAndroidProviderResult<Receipt>; attempts: BrokerAndroidProviderResult<Receipt>[]};
export interface BrokerAndroidLifecyclePlan<Effect> {
    ownerId?: string; backend?: string; stateKey?: string; command?: string; deviceId?: string;
    force?: boolean; dryRun?: boolean; create?: unknown; device?: unknown; idempotent?: boolean;
    preparation: BrokerAndroidPreparation<Effect>;
}
export interface BrokerAndroidLifecycleInput<Effect> {
    ownerId: string; parsed: BrokerAndroidLifecycleRequest; plan: BrokerAndroidLifecyclePlan<Effect> | undefined;
    expectedDevice: unknown; createAvdRoot: string | null;
}
export type BrokerAndroidFailureReason = "invalid" | "conflict" | "provider-unavailable" | "provider-failed" | "state-write-failed";
export interface BrokerAndroidRollback {
    attempted?: boolean; ok: boolean; reason?: string; error?: string; artifactsRemoved?: unknown;
}
export interface BrokerAndroidAuxiliaryCleanup {
    result: {
        ok: boolean;
        changed: boolean;
        stateConflict?: boolean;
        appium: Record<string, unknown>;
        recording: Record<string, unknown>;
        minimizeWatchdog: Record<string, unknown>;
    };
    device: unknown;
    committed: boolean;
}

export interface BrokerAndroidOutcomeFacts<Effect, Receipt> {
    ownerId?: string; backend?: string; deviceId?: string; plan?: BrokerAndroidLifecyclePlan<Effect> | null;
    device?: unknown; error?: string; detail?: string; missing?: string[]; field?: string; value?: unknown; existing?: unknown; found?: boolean;
    rollback?: BrokerAndroidRollback; stateError?: string; boot?: BrokerAndroidBoot<Receipt>;
    auxiliaryCleanup?: BrokerAndroidAuxiliaryCleanup["result"];
    execution?: BrokerAndroidProviderResult<Receipt>; invoked?: boolean; mutatesHost?: boolean;
}
export type BrokerAndroidLifecycleOutcome<Effect, Receipt> = BrokerAndroidOutcomeFacts<Effect, Receipt> & (
    {kind: "created"; device: unknown; execution: BrokerAndroidProviderResult<Receipt>; invoked: true; mutatesHost: boolean}
    | {kind: "completed"; device: unknown; execution: BrokerAndroidProviderResult<Receipt>; invoked: true; mutatesHost: boolean}
    | {kind: "refused"; reason: BrokerAndroidFailureReason; error: string}
    | {kind: "state-exception"; cause: unknown; rollback: BrokerAndroidRollback; backend: string; stateKey: string}
    | {kind: "provider-failed"; error: string; execution: BrokerAndroidProviderResult<Receipt>; invoked: true; mutatesHost: false}
    | {kind: "auxiliary-failed"; error: "auxiliary-runtime-cleanup-failed"; device: unknown; auxiliaryCleanup: BrokerAndroidAuxiliaryCleanup["result"]; invoked: false; mutatesHost: boolean}
    | {kind: "stop-unconfirmed"; error: "android-emulator-stop-unconfirmed"; detail: string; execution: BrokerAndroidProviderResult<Receipt>; invoked: true; mutatesHost: true}
    | {kind: "publication-conflict"; error: "owner-device-state-conflict"; found: boolean; device: unknown; execution: BrokerAndroidProviderResult<Receipt>; invoked: true; mutatesHost: boolean});
export type BrokerAndroidPublication = { found: boolean; matched: boolean; device: unknown };
export type BrokerAndroidClaim =
    | { ok: true; device: Record<string, unknown> }
    | { ok: false; error: string; field: string; value: unknown; existing: Record<string, unknown> };

export function brokerAndroidField(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}

export function brokerAndroidNumber(device: unknown, name: string): number | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function brokerAndroidSerial(device: unknown): string | null {
    return brokerAndroidField(device, "serial") || (brokerAndroidNumber(device, "port") ? `emulator-${brokerAndroidNumber(device, "port")}` : null);
}

export function brokerAndroidCommandSucceeded(result: BrokerAndroidProviderResult<unknown>): boolean {
    return result.ok;
}

export function brokerAndroidAvdName(ownerId: string, create: Record<string, unknown>, fallbackName: string): string {
    return typeof create.avdName === "string" && create.avdName ? create.avdName
        : `ccc-${ownerId}-${String(fallbackName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "device"}`;
}

export function brokerAndroidRecord(ownerId: string, parsed: BrokerAndroidLifecycleRequest, create: Record<string, unknown>, name: string, avdName: string, avdRoot: string, now: string): Record<string, unknown> {
    return {
        id: parsed.deviceId, name, backend: parsed.backend, kind: "mobile", platform: "android", ownerId, avdName, avdRoot,
        ...(typeof create.port === "number" ? { port: create.port } : {}),
        ...(typeof create.systemImage === "string" ? { systemImage: create.systemImage } : {}),
        ...(typeof create.deviceProfile === "string" ? { deviceProfile: create.deviceProfile } : {}),
        headless: create.headless !== false, createAvd: create.createAvd === true, provisioned: create.createAvd === true,
        recording: null, status: "stopped", creatable: true, createdAt: now, updatedAt: now, authority: "host-broker",
    };
}

export function brokerAndroidReplacement(candidate: Record<string, unknown>, parsed: BrokerAndroidLifecycleRequest, boot: BrokerAndroidBoot<unknown> | null) {
    if (parsed.command === "device_delete") return null;
    return {
        ...candidate,
        status: parsed.command === "device_start" || parsed.command === "device_reboot" ? "running" : "stopped",
        ...(parsed.command === "device_start" && boot?.ok ? {
            bootReady: boot.ready,
            lastBootCheck: { ready: boot.ready, skipped: boot.skipped === true, provider: "adb", result: boot.result || null },
        } : {}),
        ...(parsed.command === "device_stop" ? { bootReady: false, lastBootCheck: null } : {}),
    };
}
