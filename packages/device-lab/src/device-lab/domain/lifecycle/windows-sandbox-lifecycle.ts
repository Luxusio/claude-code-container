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
export interface BrokerWindowsSandboxResult<Receipt = unknown> {
    status?:number|null;signal?:string|null;stdout?:string;stderr?:string;error?:string;pid?:number;
    timedOut?:boolean;outputLimitExceeded?:boolean;receipt?:Receipt;
}
export type BrokerWindowsSandboxPrepared<Prepared> = {kind:'unavailable';error:string;missing:string[]} |
    {kind:'ready';handle:Prepared;operationKind:'runtime'|'metadata-only';sandboxId?:string;minimized:boolean};
export interface BrokerWindowsSandboxInput<Prepared> {
    ownerId:string;parsed:BrokerWindowsSandboxRequest;device:unknown;
    prepared:BrokerWindowsSandboxPrepared<Prepared>|undefined;expectedDevice:unknown;
}
export type BrokerWindowsSandboxPublication = {found:boolean;matched:boolean;device:unknown};
export interface BrokerWindowsSandboxChange {
    kind:'start'|'stop'|'delete';minimized?:boolean;
    runtime:{sandboxId?:string;requestedSandboxId?:string;minimized:boolean};
    watchdog:BrokerWindowsSandboxResult|null;confirmation:BrokerWindowsSandboxResult|null;watchdogCancelPath?:string;
}
export interface BrokerWindowsSandboxFacts<Receipt> {
    device:unknown;invoked:boolean;mutatesHost:boolean;execution?:BrokerWindowsSandboxResult<Receipt>;
    runtime?:{sandboxId?:string;requestedSandboxId?:string;minimized:boolean};
    registration?:BrokerWindowsSandboxResult<Receipt>|null;watchdog?:BrokerWindowsSandboxResult<Receipt>|null;
    confirmation?:BrokerWindowsSandboxResult<Receipt>|null;watchdogCleanup?:unknown;auxiliaryCleanup?:unknown;artifactCleanup?:unknown;
    publication?:BrokerWindowsSandboxPublication;
}
export type BrokerWindowsSandboxOutcome<Receipt> =
    {kind:'refused';category:'invalid'|'conflict'|'provider-failed'|'state-write-failed';error:string;detail?:string;missing?:string[];lock?:unknown;facts?:BrokerWindowsSandboxFacts<Receipt>} |
    {kind:'completed';success:true;facts:BrokerWindowsSandboxFacts<Receipt>} |
    {kind:'failed';success:false;facts:BrokerWindowsSandboxFacts<Receipt>} |
    {kind:'indeterminate';success:false;facts:BrokerWindowsSandboxFacts<Receipt>};
export function brokerWindowsSandboxRecord(value:unknown):value is Record<string,unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
            minimizeConfirmed: change.runtime.minimized && Boolean(change.confirmation && brokerWindowsSandboxCommandSucceeded(change.confirmation)),
            minimizeWarning: change.runtime.minimized && (!change.confirmation || !brokerWindowsSandboxCommandSucceeded(change.confirmation))
                ? change.confirmation?.error || change.confirmation?.stderr || 'Windows Sandbox started, but window minimization was not confirmed' : null,
            ...(change.runtime.sandboxId ? { sandboxId: change.runtime.sandboxId } : {}),
            ...(change.runtime.requestedSandboxId ? { requestedSandboxId: change.runtime.requestedSandboxId } : {}),
            ...(typeof change.watchdog?.pid === 'number' ? { minimizeWatchdog: { pid: change.watchdog.pid, processOwner: 'host-broker', startedBy: 'broker.windows-sandbox.minimize-watchdog', timeoutMs: 180000, cancelPath: change.watchdogCancelPath } } : {}),
        } : {}),
    };
}
