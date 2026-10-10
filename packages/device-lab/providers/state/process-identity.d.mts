/** Native process birth and command-line identity, independent of a PID alone. */
export interface ProcessIdentity {
    pid: number;
    startToken: string;
    commandHash: string;
}

export interface RuntimeProcessRecord {
    runtimeId?: string;
    pid?: number;
    processIdentity?: ProcessIdentity | null;
    [field: string]: unknown;
}

export type ProcessLiveness = "alive" | "exited" | "unknown";
export type ProcessObservation =
    | { status: "match"; current: ProcessIdentity; liveness: "alive" }
    | { status: "mismatch"; current: ProcessIdentity | null; liveness: "alive" }
    | { status: "exited"; current: null; liveness: "exited" }
    | { status: "unavailable"; current: null; liveness: "alive" | "unknown" };

export interface ProcessIdentityReadOptions {
    readIdentity?: (pid: number) => ProcessIdentity | null | undefined;
}

export interface ProcessObservationOptions extends ProcessIdentityReadOptions {
    probeLiveness?: (pid: number) => ProcessLiveness;
}

/** The wait function forwards its raw PID to injected readers before validation. */
export interface ProcessIdentityWaitOptions<Pid = unknown> {
    readIdentity?: (pid: Pid) => ProcessIdentity | null | undefined;
    probeLiveness?: (pid: Pid) => ProcessLiveness;
    sleep?: (milliseconds: number) => void | PromiseLike<void>;
}

export type ProcessSignal = string | number;
export interface ProcessSignalOptions extends ProcessObservationOptions {
    /** Synchronous effect; the native caller ignores its return value. */
    kill?: (pid: number, signal: ProcessSignal) => boolean | void;
}

export type ProcessSignalReason =
    | "runtime-process-identity-missing"
    | "runtime-process-identity-mismatch"
    | "runtime-process-identity-unavailable"
    | "runtime-process-exited"
    | "runtime-process-signal-failed";

interface ProcessSignalFields {
    attempted: boolean;
    signaled: boolean;
    exited?: boolean;
    reason?: ProcessSignalReason;
    pid?: number;
    signal?: ProcessSignal;
    current?: ProcessIdentity;
    observation?: ProcessObservation;
    error?: string;
}

export type ProcessSignalResult = ProcessSignalFields & (
    | { attempted: false; signaled: false; reason: "runtime-process-identity-missing" }
    | {
        attempted: false; signaled: false;
        reason: "runtime-process-identity-mismatch" | "runtime-process-identity-unavailable";
        observation: Exclude<ProcessObservation, { status: "match" | "exited" }>;
    }
    | {
        attempted: false; signaled: false; exited: true; reason: "runtime-process-exited";
        observation: Extract<ProcessObservation, { status: "exited" }>;
    }
    | { attempted: true; signaled: true; pid: number; signal: ProcessSignal }
    | {
        attempted: true; signaled: false; exited: true; pid: number; signal: ProcessSignal;
        reason: "runtime-process-exited"; error: string;
    }
    | {
        attempted: true; signaled: false; exited: false; pid: number; signal: ProcessSignal;
        reason: "runtime-process-signal-failed"; error: string;
    }
);

export interface ProcessTerminationOptions extends ProcessSignalOptions {
    timeoutMs?: unknown;
    sleep?: (milliseconds: number) => void | PromiseLike<void>;
}

/** Only these taskkill fields are consumed; native spawn results fit this shape. */
export interface ProcessTaskkillResult {
    status?: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
    error?: unknown;
}

export interface ProcessTreeTerminationOptions extends ProcessTerminationOptions {
    platform?: NodeJS.Platform;
    /** POSIX receives the negative process-group PID. */
    killTree?: (processGroupPid: number, signal: ProcessSignal) => boolean | void;
    taskkill?: (pid: number) => ProcessTaskkillResult | null | undefined;
}

interface ProcessTerminationFields {
    exited: boolean;
    signaled: boolean;
    reason?: ProcessSignalReason;
    error?: string;
    method?: "taskkill-tree";
    status?: number | null;
}

export type ProcessTerminationResult = ProcessTerminationFields & (
    | { exited: true; signaled: false; reason: "runtime-process-exited" }
    | { exited: true; signaled: true }
    | { exited: false; signaled: false; reason: ProcessSignalReason; error: string }
    | { exited: false; signaled: true; error: string }
);

export type ProcessTreeTerminationResult = ProcessTerminationResult | (ProcessTerminationFields & (
    | { exited: true; signaled: false; reason: "runtime-process-exited" }
    | {
        exited: false; signaled: false;
        reason: "runtime-process-identity-mismatch" | "runtime-process-identity-unavailable"; error: string;
    }
    | { exited: true; signaled: boolean; method: "taskkill-tree"; status: number | null }
    | { exited: false; signaled: boolean; method: "taskkill-tree"; status: number | null; error: string }
));

export type RefreshedRuntimeProcessRecord<Runtime> = Runtime extends object
    ? Runtime | (Omit<Runtime, "processIdentity"> & { processIdentity: ProcessIdentity })
    : Runtime;

export function readProcessIdentity(pid: unknown): ProcessIdentity | null;
export function readProcessIdentityAsync(pid: unknown): Promise<ProcessIdentity | null>;
export function waitForProcessIdentity(pid: unknown, timeoutMs?: unknown): Promise<ProcessIdentity | null>;
export function waitForProcessIdentity<Pid>(pid: Pid, timeoutMs?: unknown, options?: ProcessIdentityWaitOptions<Pid>): Promise<ProcessIdentity | null | undefined>;
export function processIdentityMatches(expected: unknown, current: unknown): boolean;
export function refreshOwnedRuntimeProcessIdentity<Runtime>(runtime: Runtime, options?: ProcessIdentityReadOptions): RefreshedRuntimeProcessRecord<Runtime>;
export function inspectProcessIdentity(expected: unknown, pid: unknown, options?: ProcessObservationOptions): ProcessObservation;
export function signalOwnedRuntimeProcess(runtime: unknown, signal?: ProcessSignal, options?: ProcessSignalOptions): ProcessSignalResult;
export function terminateOwnedRuntimeProcess(runtime: unknown, label: string, options?: ProcessTerminationOptions): Promise<ProcessTerminationResult>;
export function terminateOwnedRuntimeProcessTree(runtime: unknown, label: string, options?: ProcessTreeTerminationOptions): Promise<ProcessTreeTerminationResult>;
