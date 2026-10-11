/** Raw mutable broker carriers remain independent of direct-provider DTOs. */
export interface BrokerMacosLifecycleRequest {
    ok: true; backend: string; stateKey: string; command: string; deviceId: string;
    force: boolean; dryRun: boolean; headless?: boolean; waitForBoot?: boolean;
    bootTimeoutMs?: number; create?: Record<string, unknown>;
}
export interface BrokerMacosProviderResult {
    mode: string; provider: string; status?: number | null; signal?: string | null;
    stdout?: string; stderr?: string; error?: string; timedOut?: boolean;
    outputLimitExceeded?: boolean; typedCreateInvalidResult?: boolean; receipt: unknown;
}
export type BrokerMacosPlannedCommand<Effect> =
    {kind: "unavailable"; error: string; missing: string[]} |
    {kind: "metadata-only"; reason: string} |
    {kind: "ready"; effect: Effect; provider: string; canCompensate: boolean; bootEligible: boolean};
export interface BrokerMacosLifecyclePlan<Effect> {
    create?: unknown; device?: unknown; idempotent?: boolean; providerCommand?: BrokerMacosPlannedCommand<Effect>;
}
export interface BrokerMacosLifecycleInput<Effect> {
    ownerId: string; parsed: BrokerMacosLifecycleRequest; plan: BrokerMacosLifecyclePlan<Effect> | undefined; expectedDevice: unknown;
}
export type BrokerMacosRollback = {attempted: false; ok: boolean; reason: string} | {attempted: true; ok: boolean; result: BrokerMacosProviderResult};
export type BrokerMacosLifecycleResponse<Effect> =
    {kind: "refused"; error: string; missing: string[]; plan: BrokerMacosLifecyclePlan<Effect> | null} |
    {kind: "provider-failed"; error: string; plan: BrokerMacosLifecyclePlan<Effect> | undefined; execution: BrokerMacosProviderResult} |
    {kind: "state-failed"; cause: unknown; rollback: BrokerMacosRollback} |
    {kind: "rollback-failed"; error: string; stateError: string; rollback: BrokerMacosRollback} |
    {kind: "claim-conflict"; error: string; field: string; value: unknown; existing: Record<string,unknown>; rollback: BrokerMacosRollback} |
    {kind: "auxiliary-failed"; plan: BrokerMacosLifecyclePlan<Effect> | undefined; device: unknown; auxiliary: BrokerMacosAuxiliaryFacts} |
    {kind: "completed" | "state-conflict" | "operation-failed"; plan: BrokerMacosLifecyclePlan<Effect> | undefined; device: unknown; execution: BrokerMacosProviderResult; success: boolean; publication?: BrokerMacosPublication; auxiliary?: BrokerMacosAuxiliaryFacts; boot?: BrokerMacosBoot | null};
export interface BrokerMacosAuxiliaryFacts {
    ok: boolean; changed: boolean; stateConflict?: boolean; appium: Record<string,unknown>; recording: Record<string,unknown>; minimizeWatchdog: Record<string,unknown>;
}
export type BrokerMacosPublication = { found: boolean; matched: boolean; device: unknown };
export type BrokerMacosClaim = { ok: true; device: Record<string, unknown> } |
    { ok: false; error: string; field: string; value: unknown; existing: Record<string, unknown> };
export function brokerMacosField(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}
export function brokerMacosCommandSucceeded(result: BrokerMacosProviderResult): boolean { return result.status === 0 && !result.error; }
function slug(value: unknown): string {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0,48) || "device";
}

export function brokerMacosRecord(ownerId: string, parsed: BrokerMacosLifecycleRequest, create: Record<string, unknown>, now: string): Record<string, unknown> {
    const name = String(create.name || parsed.deviceId);
        const ssh = brokerMacosSshConfig(create);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "desktop",
            platform: "macos",
            ownerId,
            provider: create.provider === "auto" || !create.provider ? "tart" : create.provider,
            providerInstance: typeof create.providerInstance === "string" && create.providerInstance
                ? create.providerInstance
                : `ccc-${ownerId}-${slug(parsed.deviceId)}`,
            ...(typeof create.image === "string" ? { image: create.image } : {}),
            ...(typeof create.headless === "boolean" ? { headless: create.headless } : {}),
            ...(typeof create.cpus === "number" ? { cpus: create.cpus } : {}),
            ...(ssh ? { ssh } : {}),
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
}

export function brokerMacosDefaultCredentials(create: Record<string, unknown>) {
    const provider = create.provider === "auto" || !create.provider ? "tart" : String(create.provider);
    if (provider !== "tart") return false;
    const image = typeof create.image === "string" ? create.image : "";
    return image === "ccc-macos-base" ||
        /^ghcr\.io\/cirruslabs\/macos-[^:]+(?:[:@].*)?$/.test(image) ||
        /^macos-[^-]+-base$/.test(image);
}

export function brokerMacosSshConfig(create: Record<string, unknown>) {
    const hasExplicitSsh = Boolean(create.sshHost || create.sshUser || create.sshKeyPath || create.sshPassword);
    const useDefaultPassword = !hasExplicitSsh && brokerMacosDefaultCredentials(create);
    if (!hasExplicitSsh && !useDefaultPassword) return null;
    return {
        host: typeof create.sshHost === "string" ? create.sshHost : null,
        port: typeof create.sshPort === "number" ? create.sshPort : 22,
        user: typeof create.sshUser === "string" ? create.sshUser : (useDefaultPassword ? "admin" : null),
        keyPath: typeof create.sshKeyPath === "string" ? create.sshKeyPath : null,
        password: typeof create.sshPassword === "string" ? create.sshPassword : (useDefaultPassword ? "admin" : null),
    };
}


export type BrokerMacosBoot =
    {ok: true; ready: boolean; skipped?: boolean; sshHost?: string; result?: BrokerMacosProviderResult; attempts?: BrokerMacosProviderResult[]} |
    {ok: false; reason: "missing-target" | "timed-out"; instance: string | null; last?: BrokerMacosProviderResult; attempts?: BrokerMacosProviderResult[]};
export type BrokerMacosPublicationChange = {kind: "start" | "stop" | "delete"; boot: BrokerMacosBoot | null};
export function brokerMacosReplacement(candidate: Record<string, unknown>, change: BrokerMacosPublicationChange): Record<string, unknown> | null {
    if (change.kind === "delete") return null;
    const boot = change.boot;
    return { ...candidate, status: change.kind === "start" ? "running" : "stopped",
        ...(change.kind === "start" && boot?.ok ? {
            bootReady: boot.ready,
            lastBootCheck: { ready: boot.ready, skipped: boot.skipped === true, provider: "tart", ip: boot.sshHost || null, result: boot.result || null },
            ...(boot.sshHost ? { ssh: { ...((candidate as { ssh?: object }).ssh || {}), host: boot.sshHost } } : {}),
        } : {}),
    };
}
export function brokerMacosToleratesMissingDelete(parsed: BrokerMacosLifecycleRequest, result: BrokerMacosProviderResult): boolean {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_delete" || !parsed.force) return false;
    if (result.provider !== "tart") return false;
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
    return output.includes("does not exist") || output.includes("not found");
}
export function brokerMacosInstance(ownerId: string, parsed: BrokerMacosLifecycleRequest, create: Record<string, unknown>): string {
    return typeof create.providerInstance === "string" && create.providerInstance ? create.providerInstance : `ccc-${ownerId}-${slug(parsed.deviceId)}`;
}

export function brokerMacosUniqueFields(): Array<string | string[]> {
    return ["id", ["provider", "providerInstance"]];
}
