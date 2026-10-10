/** Raw mutable broker carriers remain independent of direct-provider DTOs. */
export interface BrokerMacosLifecycleRequest {
    ok: true; backend: string; stateKey: string; command: string; deviceId: string;
    force: boolean; dryRun: boolean; headless?: boolean; waitForBoot?: boolean;
    bootTimeoutMs?: number; create?: Record<string, unknown>;
}
export interface BrokerMacosProviderCommand {
    mode: "exec" | "detached" | "noop"; provider: string;
    executable?: string; args?: string[]; input?: string; reason?: string;
}
export interface BrokerMacosProviderResult {
    mode: string; provider: string; executable?: string; args?: string[]; input?: string;
    status?: number | null; signal?: string | null; stdout?: string; stderr?: string;
    error?: string; timedOut?: boolean; outputLimitExceeded?: boolean; typedCreateInvalidResult?: boolean;
}
export type BrokerMacosPlannedCommand = BrokerMacosProviderCommand | { error: string; missing: string[] };
export interface BrokerMacosLifecyclePlan {
    create?: unknown; device?: unknown; idempotent?: boolean; providerCommand?: BrokerMacosPlannedCommand;
}
export interface BrokerMacosLifecycleInput {
    ownerId: string; parsed: BrokerMacosLifecycleRequest; plan: BrokerMacosLifecyclePlan | undefined; expectedDevice: unknown;
}
export type BrokerMacosLifecycleResponse = { status: number; payload: unknown };
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
    { ok: true; ready: boolean; skipped?: boolean; sshHost?: string; result?: BrokerMacosProviderResult; attempts?: BrokerMacosProviderResult[] } |
    { ok: false; error: BrokerMacosProviderResult; attempts?: BrokerMacosProviderResult[] };
export type BrokerMacosPublicationChange = { kind: "start" | "stop" | "delete"; boot: BrokerMacosBoot | null };
export function brokerMacosCreateCommand(provider: string, image: string, instance: string, executable: string | null): BrokerMacosProviderCommand {
    return { mode: "exec", provider, executable: executable || undefined, args: ["clone",image,instance] };
}
export function brokerMacosExistingCommand(parsed: BrokerMacosLifecycleRequest, device: unknown, provider: string, instance: string, executable: string | null): BrokerMacosProviderCommand {
    if (parsed.command === "device_status") return { mode: "exec", provider, executable: executable || undefined, args: provider === "tart" ? ["get",instance] : ["status",instance] };
    if (parsed.command === "device_start") {
        if (provider === "tart") {
            const headless = typeof parsed.headless === "boolean" ? parsed.headless : Boolean(device && typeof device === "object" && (device as Record<string, unknown>).headless === true);
            return { mode: "detached", provider, executable: executable || undefined, args: ["run",...(headless ? ["--no-graphics"] : []),instance] };
        }
        return { mode: "exec", provider, executable: executable || undefined, args: ["start",instance] };
    }
    if (parsed.command === "device_stop") return { mode: "exec", provider, executable: executable || undefined, args: ["stop",instance] };
    return { mode: "exec", provider, executable: executable || undefined, args: ["delete",instance] };
}
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
