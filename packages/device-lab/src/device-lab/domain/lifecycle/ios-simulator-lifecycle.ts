/** Raw mutable broker carriers remain independent of direct-provider DTOs. */
export interface BrokerIosLifecycleRequest {
    ok: true; backend: string; stateKey: string; command: string; deviceId: string;
    force: boolean; dryRun: boolean; headless?: boolean; waitForBoot?: boolean;
    bootTimeoutMs?: number; create?: Record<string, unknown>;
}
/** Settled native facts; command diagnostics remain in the opaque receipt. */
export interface BrokerIosProviderResult {
    ok: boolean; mode: string; provider: string;
    typedCreateInvalidResult?: boolean; receipt: unknown;
}
export interface BrokerIosCreateResult extends BrokerIosProviderResult {
    createdUdid: string | null;
}
export type BrokerIosShutdownState = "Shutdown" | "Booted" | "Shutting Down" | null;
export interface BrokerIosShutdownObservation { ok: boolean; state: BrokerIosShutdownState; }
export type BrokerIosShutdownSettlement =
    {ok: true; attempts: number; lastState: "Shutdown"} |
    {ok: false; reason: "timed-out" | "observation-failed"; attempts: number; lastState: BrokerIosShutdownState};
export type BrokerIosPlannedCommand<Effect> =
    {kind: "unavailable"; error: string; missing: string[]} |
    {kind: "metadata-only"} |
    {kind: "ready"; effect: Effect; provider: string; canCompensate: boolean; bootEligible: boolean};
export interface BrokerIosLifecyclePlan<Effect> {
    create?: unknown; device?: unknown; idempotent?: boolean; providerCommand?: BrokerIosPlannedCommand<Effect>;
}
export interface BrokerIosLifecycleInput<Effect> {
    ownerId: string; parsed: BrokerIosLifecycleRequest; plan: BrokerIosLifecyclePlan<Effect> | undefined; expectedDevice: unknown;
}
export type BrokerIosRollback = {attempted: false; ok: boolean; reason: string} | {attempted: true; ok: boolean; result: BrokerIosProviderResult};
export type BrokerIosLifecycleResponse<Effect> =
    {kind: "refused"; error: string; missing: string[]; plan: BrokerIosLifecyclePlan<Effect> | null} |
    {kind: "provider-failed"; error: string; plan: BrokerIosLifecyclePlan<Effect> | undefined; execution: BrokerIosProviderResult} |
    {kind: "state-failed"; cause: unknown; rollback: BrokerIosRollback} |
    {kind: "rollback-failed"; error: string; stateError: string; rollback: BrokerIosRollback} |
    {kind: "claim-conflict"; error: string; field: string; value: unknown; existing: Record<string,unknown>; rollback: BrokerIosRollback} |
    {kind: "auxiliary-failed"; plan: BrokerIosLifecyclePlan<Effect> | undefined; device: unknown; auxiliary: BrokerIosAuxiliaryFacts} |
    {kind: "completed" | "state-conflict" | "operation-failed"; plan: BrokerIosLifecyclePlan<Effect> | undefined; device: unknown; execution: BrokerIosProviderResult; success: boolean; publication?: BrokerIosPublication; auxiliary?: BrokerIosAuxiliaryFacts; shutdown?: BrokerIosShutdownSettlement; invoked?: boolean; mutatesHost?: boolean; recoveryRequired?: boolean};
export interface BrokerIosAuxiliaryFacts {
    ok: boolean; changed: boolean; stateConflict?: boolean; appium: Record<string,unknown>; recording: Record<string,unknown>; minimizeWatchdog: Record<string,unknown>;
}
export type BrokerIosPublication = { found: boolean; matched: boolean; device: unknown; deadlineExpired?: boolean };
export type BrokerIosClaim = { ok: true; device: Record<string, unknown> } |
    { ok: false; error: string; field: string; value: unknown; existing: Record<string, unknown> };
export function brokerIosField(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}
export function brokerIosCommandSucceeded(result: BrokerIosProviderResult): boolean { return result.ok; }
function slug(value: unknown): string {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0,48) || "device";
}

export function brokerIosRecord(ownerId: string, parsed: BrokerIosLifecycleRequest, create: Record<string, unknown>, now: string): Record<string, unknown> {
    const name = String(create.name || parsed.deviceId);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "mobile",
            platform: "ios",
            ownerId,
            simulatorName: create.simulatorName || `ccc-${ownerId}-${slug(name)}`,
            ...(typeof create.deviceType === "string" ? { deviceType: create.deviceType } : {}),
            ...(typeof create.runtime === "string" ? { runtime: create.runtime } : {}),
            ...(typeof create.udid === "string" ? { udid: create.udid } : {}),
            createSimulator: create.createSimulator === true,
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
}

export type BrokerIosPublicationChange = { kind: "start" | "stop" | "delete" };
export function brokerIosCreateCommand(ownerId: string, parsed: BrokerIosLifecycleRequest, create: Record<string, unknown>) {
    const name = String(create.name || parsed.deviceId);
    const ownerPrefix = `ccc-${ownerId}-`;
    const simulatorName = typeof create.simulatorName === "string" && create.simulatorName ? create.simulatorName : `${ownerPrefix}${slug(name)}`;
    return { simulatorName, ownerPrefix, deviceType: create.deviceType, runtime: create.runtime };
}
export function brokerIosReplacement(candidate: Record<string, unknown>, change: BrokerIosPublicationChange): Record<string, unknown> | null {
    if (change.kind === "delete") return null;
    return { ...candidate, status: change.kind === "start" ? "running" : "stopped" };
}

export function brokerIosUniqueFields(): Array<string | string[]> {
    return ["id", "udid", "simulatorName"];
}
