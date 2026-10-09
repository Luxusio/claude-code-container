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

export interface BrokerAndroidProviderCommand {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    reason?: string;
    windowsHiddenLauncher?: boolean;
}

export interface BrokerAndroidProviderResult {
    mode: string;
    provider: string;
    executable?: string;
    args?: string[];
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
    typedCreateInvalidResult?: boolean;
}

export type BrokerAndroidBoot =
    | { ok: true; ready: boolean; skipped?: boolean; result?: BrokerAndroidProviderResult; attempts?: BrokerAndroidProviderResult[] }
    | { ok: false; ready: false; error: BrokerAndroidProviderResult; attempts?: BrokerAndroidProviderResult[] };

export interface BrokerAndroidLifecyclePlan {
    create?: unknown;
    device?: unknown;
    idempotent?: boolean;
    providerCommand?: BrokerAndroidProviderCommand | { error: string; missing: string[] };
}

export interface BrokerAndroidLifecycleInput {
    ownerId: string;
    parsed: BrokerAndroidLifecycleRequest;
    plan: BrokerAndroidLifecyclePlan | undefined;
    expectedDevice: unknown;
    createAvdRoot: string | null;
}

export type BrokerAndroidLifecycleResponse = { status: number; payload: Record<string, unknown> };
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

export function brokerAndroidCommandSucceeded(result: BrokerAndroidProviderResult): boolean {
    return result.status === 0 && !result.error;
}

export function brokerAndroidStartArgs(parsed: BrokerAndroidLifecycleRequest, device: unknown): string[] {
    const deviceHeadless = device && typeof device === "object" ? (device as Record<string, unknown>).headless : undefined;
    const headless = typeof parsed.headless === "boolean" ? parsed.headless : deviceHeadless !== false;
    return [...(headless ? ["-no-window", "-no-audio"] : []), "-netsim-args", "--no-cli-ui --no-web-ui"];
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

export function brokerAndroidReplacement(candidate: Record<string, unknown>, parsed: BrokerAndroidLifecycleRequest, boot: BrokerAndroidBoot | null) {
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
