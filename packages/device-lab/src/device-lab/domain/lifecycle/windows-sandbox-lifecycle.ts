export interface BrokerWindowsSandboxRequest {
    ok: true;
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
    force: boolean;
    dryRun: boolean;
    minimized?: boolean;
}
export interface BrokerWindowsSandboxCommand {
    mode: 'exec' | 'detached' | 'noop';
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    reason?: string;
    sandboxId?: string;
    requestedSandboxId?: string;
    windowStyle?: 'minimized';
    waitForExit?: boolean;
    windowsHiddenLauncher?: boolean;
    env?: Record<string, string | undefined>;
    cwd?: string;
}
export interface BrokerWindowsSandboxResult {
    mode: string;
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    pid?: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
}
export type BrokerWindowsSandboxPlannedCommand = BrokerWindowsSandboxCommand | {
    error: string;
    missing: string[];
};
export interface BrokerWindowsSandboxPlan {
    create?: unknown;
    device?: unknown;
    idempotent?: boolean;
    providerCommand?: BrokerWindowsSandboxPlannedCommand;
}
export interface BrokerWindowsSandboxInput {
    ownerId: string;
    parsed: BrokerWindowsSandboxRequest;
    plan: BrokerWindowsSandboxPlan | undefined;
    expectedDevice: unknown;
}
export type BrokerWindowsSandboxResponse = {
    status: number;
    payload: unknown;
};
export type BrokerWindowsSandboxPublication = {
    found: boolean;
    matched: boolean;
    device: unknown;
};
export interface BrokerWindowsSandboxChange {
    kind: 'start' | 'stop' | 'delete';
    minimized?: boolean;
    command: BrokerWindowsSandboxCommand;
    watchdog: BrokerWindowsSandboxResult | null;
    confirmation: BrokerWindowsSandboxResult | null;
    watchdogCancelPath?: string;
}
export function brokerWindowsSandboxField(value: unknown, name: string): string | null {
    if (!value || typeof value !== 'object')
        return null;
    const field = (value as Record<string, unknown>)[name];
    return typeof field === 'string' && field ? field : null;
}
export function brokerWindowsSandboxCommandSucceeded(result: BrokerWindowsSandboxResult): boolean { return result.status === 0 && !result.error; }
export function brokerWindowsSandboxRuntimeChoice(ids: string[], baseline: string[], expected: string): {
    kind: 'requested' | 'single';
    id: string;
} | {
    kind: 'ambiguous' | 'preexisting';
    error: string;
} | {
    kind: 'waiting';
} {
    const before = new Set(baseline.map(id => id.toLowerCase()));
    const launched = ids.filter(id => !before.has(id));
    if (launched.includes(expected.toLowerCase()))
        return { kind: 'requested', id: expected.toLowerCase() };
    if (launched.length === 1)
        return { kind: 'single', id: launched[0] };
    if (launched.length > 1)
        return { kind: 'ambiguous', error: `Windows Sandbox launch produced ambiguous runtimes: ${launched.join(', ')}` };
    if (before.has(expected.toLowerCase()))
        return { kind: 'preexisting', error: `Windows Sandbox runtime ${expected} existed before launch; no new owned runtime appeared` };
    return { kind: 'waiting' };
}
export function brokerWindowsSandboxReplacement(candidate: unknown, change: BrokerWindowsSandboxChange): Record<string, unknown> | null {
    if (change.kind === 'delete')
        return null;
    const device = candidate as Record<string, unknown>;
    return {
        ...device, status: change.kind === 'start' ? 'running' : 'stopped',
        ...(change.kind === 'start' ? {
            minimized: typeof change.minimized === 'boolean' ? change.minimized : device.minimized !== false,
            minimizeConfirmed: change.command.windowStyle === 'minimized' && Boolean(change.confirmation && brokerWindowsSandboxCommandSucceeded(change.confirmation)),
            minimizeWarning: change.command.windowStyle === 'minimized' && (!change.confirmation || !brokerWindowsSandboxCommandSucceeded(change.confirmation))
                ? change.confirmation?.error || change.confirmation?.stderr || 'Windows Sandbox started, but window minimization was not confirmed' : null,
            ...(change.command.sandboxId ? { sandboxId: change.command.sandboxId } : {}),
            ...(change.command.requestedSandboxId ? { requestedSandboxId: change.command.requestedSandboxId } : {}),
            ...(typeof change.watchdog?.pid === 'number' ? { minimizeWatchdog: { pid: change.watchdog.pid, processOwner: 'host-broker', startedBy: 'broker.windows-sandbox.minimize-watchdog', timeoutMs: 180000, cancelPath: change.watchdogCancelPath } } : {}),
        } : {}),
    };
}
