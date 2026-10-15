import { spawn } from "child_process";
import { randomBytes } from "crypto";

import {
    canonicalWindowsPowerShellPath,
    hiddenWindowsPowerShellArgs,
} from "../../../windows-system-powershell.js";
import {
    createHyperVWindowsPowerShellSession,
    HYPER_V_WINDOWS_OPERATIONS,
    HYPER_V_WINDOWS_SESSION_ERROR_CODES,
    HYPER_V_WINDOWS_SESSION_CLOSE_MARKER,
    HYPER_V_WINDOWS_SESSION_READY_MARKER,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsOperation,
    type HyperVWindowsPowerShellOperationAsset,
    type HyperVWindowsSessionErrorCode,
    type HyperVWindowsSessionProcess,
} from "@ccc/hyper-v/index.js";

const ELEVATION_REQUEST_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_REQUEST";
const ELEVATION_READY_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY";
const ELEVATION_FAILURE_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:";
const ELEVATION_CLOSE_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_CLOSE:";
const ELEVATION_TERMINAL_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:";
const ELEVATION_PROGRESS_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:";
const ELEVATION_APPROVAL = "CCC_HYPER_V_ELEVATED_NETWORK_APPROVE";
const MAX_RELAY_LINE_BYTES = 256 * 1024;
const MAX_LAUNCH_ENVELOPE_BYTES = 256 * 1024;
/**
 * The shutdown ladder, innermost rung first.
 *
 * Every bound here contains the one before it, and each is derived from what it contains plus
 * a named margin rather than written as a number. The reason is a specific failure: when one
 * rung was raised on its own, an outer timer fired while an inner stage was still legitimately
 * running, and the failure was then reported under the outer stage — so the diagnosis named
 * the wrong layer, which is the most expensive kind of wrong a message here can be. Derivation
 * makes that impossible to express: raising an inner bound carries the outer ones with it.
 *
 * The margins below reproduce the values this path was proven with on a real host. Retuning
 * any of them is a behaviour change to a destructive elevated path and belongs in its own
 * change, not in a refactor.
 */
const ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS = 500;
const ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS = 4_500;
// What the relay is given for the whole child shutdown, and the deadline it is sent. The
// graceful wait is capped at `deadline - now - reserve`, so the reserve is only real if the
// budget is exactly the two added together: any more and the child gets a wait it was not
// promised, any less and there is nothing left to confirm the kill with.
const ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS =
    ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS + ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS;
/**
 * The relay's bootstrap-only failure vocabulary: each of these is thrown between launching the
 * elevated child and announcing readiness, never from the request loop. Kept as a set so the
 * decoder can reject one that arrives after readiness instead of trusting it.
 */
const RELAY_BOOTSTRAP_ONLY_FAILURES: ReadonlySet<string> = new Set([
    "hyper-v-network-elevation-cancelled",
    "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-handshake-timeout",
    "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required",
    "hyper-v-network-elevation-deadline-exceeded",
]);
const RELAY_CLOSE_WRITE_GRACE_MILLISECONDS = 1_000;
// Force-killing the relay has to stay behind the close frame reaching it plus the entire child
// shutdown it then performs. Cross that and the parent kills a relay that is still doing what
// it was told to, and the run is reported as a relay exit timeout rather than as whatever the
// child was actually stuck on.
const RELAY_FORCE_MARGIN_MILLISECONDS = 4_000;
const RELAY_FORCE_GRACE_MILLISECONDS = ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS
    + RELAY_CLOSE_WRITE_GRACE_MILLISECONDS
    + RELAY_FORCE_MARGIN_MILLISECONDS;
// The caller waits for the relay's completion record. It has to outlast the force-kill, or the
// caller gives up before the path that produces the verdict has produced one.
const RELAY_COMPLETION_MARGIN_MILLISECONDS = 5_000;
const RELAY_COMPLETION_GRACE_MILLISECONDS =
    RELAY_FORCE_GRACE_MILLISECONDS + RELAY_COMPLETION_MARGIN_MILLISECONDS;

/**
 * The shutdown ladder as measured values, exported so the ordering can be asserted and so a
 * retune is a visible, deliberate change rather than a number edited in place.
 */
export const HYPER_V_ELEVATED_NETWORK_SHUTDOWN_LADDER = Object.freeze({
    childForceConfirmationReserveMilliseconds: ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS,
    childGracefulExitMilliseconds: ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS,
    childTerminationConfirmationMilliseconds: ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS,
    relayCloseWriteGraceMilliseconds: RELAY_CLOSE_WRITE_GRACE_MILLISECONDS,
    relayForceMarginMilliseconds: RELAY_FORCE_MARGIN_MILLISECONDS,
    relayForceGraceMilliseconds: RELAY_FORCE_GRACE_MILLISECONDS,
    relayCompletionMarginMilliseconds: RELAY_COMPLETION_MARGIN_MILLISECONDS,
    relayCompletionGraceMilliseconds: RELAY_COMPLETION_GRACE_MILLISECONDS,
});
const TERMINATION_UNCONFIRMED_CODE = "hyper-v-network-elevation-termination-unconfirmed";
const SUPPRESSED_CODE = "hyper-v-network-elevation-suppressed";

export const HYPER_V_ELEVATED_NETWORK_ERROR_CODES = Object.freeze([
    "hyper-v-network-elevation-cancelled",
    // The relay's RunAs (ShellExecute) failed for a reason other than a declined prompt.
    "hyper-v-network-elevation-launch-failed",
    // Node refused the PowerShell path before starting the relay.
    "hyper-v-network-elevation-executable-rejected",
    // Node could not start the unelevated relay or hand it the launch envelope.
    "hyper-v-network-elevation-relay-spawn-failed",
    "hyper-v-network-elevation-handshake-timeout",
    "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required",
    "hyper-v-network-elevation-deadline-exceeded",
    "hyper-v-network-elevation-protocol-invalid",
    "hyper-v-network-elevation-relay-failed",
    "hyper-v-network-elevation-request-failed",
    TERMINATION_UNCONFIRMED_CODE,
    "hyper-v-network-elevation-scope-closed",
    // The broker's elevation gate refused to ask again after a declined or unanswered prompt, so
    // no relay was started. Minted in this process only; a relay that reports it is rejected.
    SUPPRESSED_CODE,
] as const);

export type HyperVElevatedNetworkErrorCode = typeof HYPER_V_ELEVATED_NETWORK_ERROR_CODES[number];
type HyperVElevatedNetworkNonTerminationErrorCode = Exclude<
    HyperVElevatedNetworkErrorCode,
    typeof TERMINATION_UNCONFIRMED_CODE
>;

export const HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES = Object.freeze([
    "elevated-child",
    "relay-terminal-ack-missing",
    "relay-terminal-ack-invalid",
    "relay-process-exit-timeout",
    "relay-output-drain-timeout",
    "relay-input-write",
    "relay-completion-timeout",
] as const);

export type HyperVElevatedNetworkTerminationStage =
    typeof HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES[number];

export const HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES = Object.freeze([
    "approval-received",
    "runas-returned",
    "pipe-connected",
    "child-authenticated",
    "session-bootstrap-sent",
    "relay-ready",
    "operation-asset-forwarded",
    "child-ready",
    "request-forwarded",
    "response-received",
    "response-forwarded",
    "close-received",
    "child-close-forwarded",
    "child-graceful-wait-finished",
    "finalizer-entered",
    "named-pipe-disposed",
    "child-force-attempted",
    "child-force-wait-finished",
    "child-reinspection-finished",
    "terminal-write-entered",
] as const);

export type HyperVElevatedNetworkRelayProgressStage =
    typeof HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES[number];

export const HYPER_V_ELEVATED_NETWORK_SHUTDOWN_MODES = Object.freeze([
    "not-started",
    "graceful",
    "abrupt",
] as const);

export const HYPER_V_ELEVATED_NETWORK_CLOSE_WRITE_STATUSES = Object.freeze([
    "not-started",
    "pending",
    "succeeded",
    "failed",
    "timed-out",
] as const);

export type HyperVElevatedNetworkRelayDiagnostic = {
    readonly shutdownMode: typeof HYPER_V_ELEVATED_NETWORK_SHUTDOWN_MODES[number];
    readonly progressStage: HyperVElevatedNetworkRelayProgressStage | null;
    readonly closeWriteStatus: typeof HYPER_V_ELEVATED_NETWORK_CLOSE_WRITE_STATUSES[number];
    readonly processExited: boolean;
    readonly stdoutDrained: boolean;
    readonly stderrObserved: boolean;
    readonly forceExpired: boolean;
};

export type HyperVElevatedNetworkExecutionDiagnostic = {
    readonly activeExecutions: number;
    readonly pendingExecutions: number;
} & (
    | {
        readonly lastOperation: null;
        readonly lastSessionError: null;
    }
    | {
        readonly lastOperation: HyperVWindowsOperation;
        readonly lastSessionError: HyperVWindowsSessionErrorCode | "non-session-error" | null;
    }
);

export type HyperVElevatedNetworkTerminationDiagnostic = {
    readonly relay: HyperVElevatedNetworkRelayDiagnostic | null;
    readonly execution: HyperVElevatedNetworkExecutionDiagnostic;
};

const RELAY_PROGRESS_STAGE_SET: ReadonlySet<string> = new Set(
    HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES,
);
const SHUTDOWN_MODE_SET: ReadonlySet<string> = new Set(HYPER_V_ELEVATED_NETWORK_SHUTDOWN_MODES);
const CLOSE_WRITE_STATUS_SET: ReadonlySet<string> = new Set(
    HYPER_V_ELEVATED_NETWORK_CLOSE_WRITE_STATUSES,
);
const WINDOWS_OPERATION_SET: ReadonlySet<string> = new Set(HYPER_V_WINDOWS_OPERATIONS);
const WINDOWS_SESSION_ERROR_SET: ReadonlySet<string> = new Set(HYPER_V_WINDOWS_SESSION_ERROR_CODES);
const ELEVATION_ERROR_CODE_SET: ReadonlySet<string> = new Set(HYPER_V_ELEVATED_NETWORK_ERROR_CODES);
const TERMINATION_STAGE_SET: ReadonlySet<string> = new Set(HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelayProgressStage(value: unknown): value is HyperVElevatedNetworkRelayProgressStage {
    return typeof value === "string" && RELAY_PROGRESS_STAGE_SET.has(value);
}

function isShutdownMode(
    value: unknown,
): value is HyperVElevatedNetworkRelayDiagnostic["shutdownMode"] {
    return typeof value === "string" && SHUTDOWN_MODE_SET.has(value);
}

function isCloseWriteStatus(
    value: unknown,
): value is HyperVElevatedNetworkRelayDiagnostic["closeWriteStatus"] {
    return typeof value === "string" && CLOSE_WRITE_STATUS_SET.has(value);
}

function isWindowsOperation(value: unknown): value is HyperVWindowsOperation {
    return typeof value === "string" && WINDOWS_OPERATION_SET.has(value);
}

function isWindowsSessionError(value: unknown): value is HyperVWindowsSessionErrorCode {
    return typeof value === "string" && WINDOWS_SESSION_ERROR_SET.has(value);
}

function isElevationErrorCode(value: unknown): value is HyperVElevatedNetworkErrorCode {
    return typeof value === "string" && ELEVATION_ERROR_CODE_SET.has(value);
}

function isTerminationStage(value: unknown): value is HyperVElevatedNetworkTerminationStage {
    return typeof value === "string" && TERMINATION_STAGE_SET.has(value);
}

function decodeRelayDiagnostic(value: unknown): HyperVElevatedNetworkRelayDiagnostic | null {
    if (!isRecord(value)) return null;
    const shutdownMode = value.shutdownMode;
    const progressStage = value.progressStage;
    const closeWriteStatus = value.closeWriteStatus;
    const processExited = value.processExited;
    const stdoutDrained = value.stdoutDrained;
    const stderrObserved = value.stderrObserved;
    const forceExpired = value.forceExpired;
    let decodedProgressStage: HyperVElevatedNetworkRelayProgressStage | null;
    if (progressStage === null) decodedProgressStage = null;
    else if (isRelayProgressStage(progressStage)) decodedProgressStage = progressStage;
    else return null;
    if (!isShutdownMode(shutdownMode)
        || !isCloseWriteStatus(closeWriteStatus)
        || typeof processExited !== "boolean"
        || typeof stdoutDrained !== "boolean"
        || typeof stderrObserved !== "boolean"
        || typeof forceExpired !== "boolean") {
        return null;
    }
    return {
        shutdownMode,
        progressStage: decodedProgressStage,
        closeWriteStatus,
        processExited,
        stdoutDrained,
        stderrObserved,
        forceExpired,
    };
}

function decodeTerminationDiagnostic(value: unknown): HyperVElevatedNetworkTerminationDiagnostic | null {
    if (!isRecord(value)) return null;
    const relayValue = value.relay;
    const executionValue = value.execution;
    if (!isRecord(executionValue)) return null;
    const relay = relayValue === null ? null : decodeRelayDiagnostic(relayValue);
    const lastOperation = executionValue.lastOperation;
    const lastSessionError = executionValue.lastSessionError;
    const activeExecutions = executionValue.activeExecutions;
    const pendingExecutions = executionValue.pendingExecutions;
    if ((relayValue !== null && !relay)
        || typeof activeExecutions !== "number"
        || !Number.isSafeInteger(activeExecutions)
        || activeExecutions < 0
        || typeof pendingExecutions !== "number"
        || !Number.isSafeInteger(pendingExecutions)
        || pendingExecutions < 0) {
        return null;
    }
    if (lastOperation === null) {
        if (lastSessionError !== null) return null;
        return {
            relay,
            execution: {
                lastOperation: null,
                lastSessionError: null,
                activeExecutions,
                pendingExecutions,
            },
        };
    }
    let decodedSessionError: HyperVWindowsSessionErrorCode | "non-session-error" | null;
    if (lastSessionError === null) decodedSessionError = null;
    else if (lastSessionError === "non-session-error") decodedSessionError = "non-session-error";
    else if (isWindowsSessionError(lastSessionError)) decodedSessionError = lastSessionError;
    else return null;
    if (!isWindowsOperation(lastOperation)) return null;
    return {
        relay,
        execution: {
            lastOperation,
            lastSessionError: decodedSessionError,
            activeExecutions,
            pendingExecutions,
        },
    };
}

function safeTerminationDiagnostic(value: unknown): HyperVElevatedNetworkTerminationDiagnostic | null {
    try {
        return decodeTerminationDiagnostic(value);
    } catch {
        return null;
    }
}

function safeRelayDiagnostic(
    provider: (() => unknown) | null,
): HyperVElevatedNetworkRelayDiagnostic | null {
    if (!provider) return null;
    try {
        return decodeRelayDiagnostic(provider());
    } catch {
        return null;
    }
}
type HyperVElevatedNetworkRelayTerminationStage = Exclude<
    HyperVElevatedNetworkTerminationStage,
    "relay-completion-timeout"
>;

function safeRelayTerminationStage(
    provider: (() => unknown) | null,
): HyperVElevatedNetworkRelayTerminationStage | null {
    if (!provider) return null;
    try {
        const stage = provider();
        return isTerminationStage(stage) && stage !== "relay-completion-timeout" ? stage : null;
    } catch {
        return null;
    }
}

export type HyperVElevatedNetworkRelayCompletion =
    | {
        readonly errorCode: HyperVElevatedNetworkNonTerminationErrorCode | null;
        readonly terminationStage: null;
    }
    | {
        readonly errorCode: typeof TERMINATION_UNCONFIRMED_CODE;
        readonly terminationStage: HyperVElevatedNetworkRelayTerminationStage;
    };

function decodeRelayCompletion(value: unknown): HyperVElevatedNetworkRelayCompletion | undefined {
    if (!isRecord(value)) return undefined;
    const errorCode = value.errorCode;
    const terminationStage = value.terminationStage;
    if (errorCode === null && terminationStage === null) {
        return { errorCode: null, terminationStage: null };
    }
    if (errorCode === TERMINATION_UNCONFIRMED_CODE
        && isTerminationStage(terminationStage)
        && terminationStage !== "relay-completion-timeout") {
        return { errorCode, terminationStage };
    }
    if (isElevationErrorCode(errorCode)
        && errorCode !== TERMINATION_UNCONFIRMED_CODE
        && terminationStage === null) {
        return { errorCode, terminationStage: null };
    }
    return undefined;
}

function safeRelayCompletion(value: unknown): HyperVElevatedNetworkRelayCompletion | undefined {
    try {
        return decodeRelayCompletion(value);
    } catch {
        return undefined;
    }
}

function safeRelayFailureCode(
    provider: (() => unknown) | null,
): HyperVElevatedNetworkErrorCode | null {
    if (!provider) return null;
    try {
        const code = provider();
        if (code === null) return null;
        return isElevationErrorCode(code) ? code : "hyper-v-network-elevation-protocol-invalid";
    } catch {
        return "hyper-v-network-elevation-protocol-invalid";
    }
}

function bestEffortRelayKill(provider: (() => unknown) | null): void {
    try {
        provider?.();
    } catch {
        // Invalid completion evidence remains bounded even when an injected cleanup hook is hostile.
    }
}

export type HyperVElevatedNetworkRelayFailureEvent =
    | {
        readonly kind: "replace-primary";
        readonly code: HyperVElevatedNetworkNonTerminationErrorCode;
    }
    | {
        readonly kind: "primary-if-absent";
        readonly code: HyperVElevatedNetworkNonTerminationErrorCode;
    }
    | {
        readonly kind: "termination";
        readonly stage: "elevated-child";
        readonly replaceFailure: true;
    }
    | {
        readonly kind: "termination";
        readonly stage: Exclude<HyperVElevatedNetworkRelayTerminationStage, "elevated-child">;
        readonly replaceFailure: false;
    };

export function transitionHyperVElevatedNetworkRelayFailure(
    current: HyperVElevatedNetworkRelayCompletion,
    event: HyperVElevatedNetworkRelayFailureEvent,
): HyperVElevatedNetworkRelayCompletion {
    switch (event.kind) {
        case "replace-primary":
            return current.terminationStage === "elevated-child"
                ? current
                : { errorCode: event.code, terminationStage: null };
        case "primary-if-absent":
            return current.errorCode === null
                ? { errorCode: event.code, terminationStage: null }
                : current;
        case "termination":
            return current.errorCode !== null && !event.replaceFailure
                ? current
                : { errorCode: TERMINATION_UNCONFIRMED_CODE, terminationStage: event.stage };
    }
}

export class HyperVElevatedNetworkSessionError extends Error {
    readonly code: HyperVElevatedNetworkErrorCode;
    readonly terminationStage: HyperVElevatedNetworkTerminationStage | null;
    readonly terminationDiagnostic: HyperVElevatedNetworkTerminationDiagnostic | null;

    constructor(code: HyperVElevatedNetworkNonTerminationErrorCode);
    constructor(
        code: typeof TERMINATION_UNCONFIRMED_CODE,
        terminationStage: HyperVElevatedNetworkTerminationStage,
        terminationDiagnostic?: HyperVElevatedNetworkTerminationDiagnostic,
    );
    constructor(
        code: HyperVElevatedNetworkErrorCode,
        terminationStage: HyperVElevatedNetworkTerminationStage | null = null,
        terminationDiagnostic: HyperVElevatedNetworkTerminationDiagnostic | null = null,
    ) {
        super(code);
        this.name = "HyperVElevatedNetworkSessionError";
        this.code = code;
        this.terminationStage = terminationStage;
        this.terminationDiagnostic = code === TERMINATION_UNCONFIRMED_CODE
            ? safeTerminationDiagnostic(terminationDiagnostic)
            : null;
    }
}

export function getHyperVElevatedNetworkTerminationDiagnostic(
    error: unknown,
): HyperVElevatedNetworkTerminationDiagnostic | null {
    try {
        if (!(error instanceof HyperVElevatedNetworkSessionError)) return null;
        if (error.code !== TERMINATION_UNCONFIRMED_CODE) return null;
        const stage = error.terminationStage;
        if (!isTerminationStage(stage)) return null;
        return safeTerminationDiagnostic(error.terminationDiagnostic);
    } catch {
        return null;
    }
}

export function getHyperVElevatedNetworkTerminationStage(
    error: unknown,
): HyperVElevatedNetworkTerminationStage | null {
    try {
        if (!(error instanceof HyperVElevatedNetworkSessionError)) return null;
        if (error.code !== TERMINATION_UNCONFIRMED_CODE) return null;
        const stage = error.terminationStage;
        return isTerminationStage(stage) ? stage : null;
    } catch {
        return null;
    }
}

export type HyperVElevatedNetworkRelayProcess = HyperVWindowsSessionProcess & {
    readonly close: () => void;
    readonly completion: Promise<HyperVElevatedNetworkRelayCompletion>;
    readonly failureCode: () => HyperVElevatedNetworkErrorCode | null;
    readonly terminationStage?: () => unknown;
    readonly diagnostic?: () => unknown;
    // Settles once the relay can forward session frames (the relay-ready marker) or once it can
    // never do so. It never rejects: an unready relay fails through the session's own codes.
    readonly ready?: Promise<void>;
};

export type HyperVElevatedNetworkRelaySpawnRequest = {
    readonly executable: string;
    readonly sessionBootstrap: string;
    readonly deadlineUnixMilliseconds: number;
    readonly maximumDurationMilliseconds?: number;
    readonly onBeforeElevation: () => void;
};

export type HyperVElevatedNetworkRelaySpawn = (
    request: HyperVElevatedNetworkRelaySpawnRequest,
) => HyperVElevatedNetworkRelayProcess | Promise<HyperVElevatedNetworkRelayProcess>;

/**
 * How a scope's one relay acquisition ended. `prompted` means the relay asked for approval and
 * `onBeforeElevation` ran, which is the step immediately before RunAs; it does not prove Windows
 * showed a prompt. `ready` means the relay announced readiness, which it only does after an
 * elevated child authenticated. `code` is the failure on record when it settled, if any — null
 * when it is ready, or when the scope closed before the relay reported anything.
 */
export type HyperVElevatedNetworkAcquisitionSettlement = {
    readonly prompted: boolean;
    readonly ready: boolean;
    readonly code: HyperVElevatedNetworkErrorCode | null;
};

export type WithElevatedHyperVNetworkExecutorOptions = {
    readonly executable: string;
    readonly deadlineUnixMilliseconds: number;
    readonly maximumDurationMilliseconds?: number;
    readonly monotonicNow?: () => number;
    readonly signal?: AbortSignal;
    readonly onBeforeElevation?: () => void;
    // Called at most once per scope, when its relay acquisition settles or, if that is still
    // pending, when the scope closes — always before the scope returns. Never called for a scope
    // whose callback performed no administrator operation. A throwing listener is ignored.
    readonly onAcquisitionSettled?: (settlement: HyperVElevatedNetworkAcquisitionSettlement) => void;
    readonly operationAsset?: HyperVWindowsPowerShellOperationAsset;
    readonly spawnRelay?: HyperVElevatedNetworkRelaySpawn;
};

type QueuedWrite = {
    readonly line: string;
    readonly settled?: (error?: unknown) => void;
};

function validSystemPowerShellPath(value: string): boolean {
    return /^[A-Za-z]:\\[^\u0000-\u001f]{1,1024}\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(value);
}

function encodedPowerShell(source: string): string {
    return Buffer.from(source, "utf16le").toString("base64");
}

function elevatedChildSource(
    pipeName: string,
    nonce: string,
    deadlineUnixMilliseconds: number,
    maximumDurationMilliseconds?: number,
): string {
    return [
        "$ErrorActionPreference='Stop'",
        `$P='${pipeName}'`,
        `$N='${nonce}'`,
        `$D=[long]${deadlineUnixMilliseconds}`,
        `$U=[long]${maximumDurationMilliseconds ?? -1}`,
        "$Q=$null;$K=$null;$KT=$null;$T=[Diagnostics.Stopwatch]::StartNew()",
        "$X=if($U-ge 0){$U}else{$D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}",
        "$S=(Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        "try{",
        "$Q=[IO.Pipes.NamedPipeClientStream]::new('.',$P,[IO.Pipes.PipeDirection]::InOut)",
        "$Z=$X-$T.ElapsedMilliseconds;if($Z-le 0){throw 'deadline'};$Q.Connect([int][Math]::Min([long]120000,$Z))",
        "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true);$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
        "$A=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$J=[ordered]@{nonce=$N;pid=$PID;startTicks=$S;administrator=[bool]$A}|ConvertTo-Json -Compress",
        "$W.WriteLine('AUTH:'+([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($J))));$W.Flush();if(-not $A){throw 'administrator'}",
        "$Z=$X-$T.ElapsedMilliseconds;if($Z-le 0){throw 'deadline'};$H=$R.ReadLineAsync();if(-not $H.Wait([int][Math]::Min([long][int]::MaxValue,$Z))){throw 'deadline'};$L=$H.Result;if(-not $L-or $L.Length-gt 131083){throw 'bootstrap'}",
        "$X-=$T.ElapsedMilliseconds;$T.Restart();if($U-ge 0){$V=$L.Split(':',2);if($V.Count-ne 2-or $V[0]-notmatch '^[0-9]{1,10}$'){throw 'bootstrap'};$M=[long]$V[0];if($M-le 0-or $M-gt [int]::MaxValue){throw 'bootstrap'};$X=[Math]::Min($X,$M);$L=$V[1]}",
        "if($X-$T.ElapsedMilliseconds-le 0-or $L.Length-gt 131072-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'bootstrap'};$C=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($L))",
        "$Z=$X-$T.ElapsedMilliseconds;if($Z-le 0){throw 'deadline'};$V=\"Start-Sleep -Milliseconds $Z;`$X=Get-Process -Id $PID -ErrorAction SilentlyContinue;if(`$X-and `$X.StartTime.ToUniversalTime().Ticks-eq $S){Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue}\"",
        "$K=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($V)))) -WindowStyle Hidden -PassThru -ErrorAction Stop;$KT=$K.StartTime.ToUniversalTime().Ticks",
        // Set AutoFlush on the writer before SetOut wraps it, and preserve the reader's asset bytes.
        "$W.AutoFlush=$true;[Console]::SetIn($R);[Console]::SetOut($W)",
        "if($X-$T.ElapsedMilliseconds-le 0){throw 'deadline'};& ([ScriptBlock]::Create($C))",
        "}finally{try{$Q.Dispose()}catch{};if($K-and $KT){$Y=Get-Process -Id $K.Id -ErrorAction SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $KT){Stop-Process -Id $K.Id -Force -ErrorAction SilentlyContinue}}}",
    ].join(";");
}

function relayProgress(stage: HyperVElevatedNetworkRelayProgressStage): string {
    return `Note '${stage}'`;
}

// The exact PowerShell supplied to -EncodedCommand, also exposed for the parser gate.
// Keep the existing loader field as an alias: the child fits the launch limit directly,
// so no compressed script loader is needed. Sample correlation values only.
export function hyperVElevatedNetworkChildPrograms(
    maximumDurationMilliseconds?: number,
): { readonly loader: string; readonly child: string } {
    const child = elevatedChildSource(
        `ccc-hyper-v-network-${"0".repeat(32)}`,
        "0".repeat(64),
        2_000_000_000_000,
        maximumDurationMilliseconds,
    );
    return { loader: child, child };
}

// This process remains medium-integrity. It owns the administrator-only pipe, performs exactly one
// ShellExecute/RunAs transition, and synchronously forwards the existing one-in-flight session
// frames. The elevated child still runs the correlated session bootstrap, so no Hyper-V operation
// logic is duplicated here and redirected-stdin EOF is not a transport completion signal.
export const HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP = [
    "$ErrorActionPreference='Stop'",
    "$F=$null;$P=$null;$C=$null;$CS=$null;$Q=$null;$R=$null;$W=$null;$Z=$null;$G=$null;$CL=$false;$CG=$null;$CD=0;$BR=$false",
    "function Fail([string]$V){[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:'+$V);[Console]::Out.Flush()}",
    `function Note([string]$T){try{[Console]::Out.WriteLine('${ELEVATION_PROGRESS_PREFIX}'+$Z+':'+$T);[Console]::Out.Flush()}catch{}}`,
    "function Left{[long]$V=$BD-$BT.ElapsedMilliseconds;if($V-le 0){if($BR){throw 'expired'};throw 'deadline'};return $V}",
    "try{",
    "$L=[Console]::In.ReadLine();if(-not $L-or $L.Length-gt 349528-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}",
    "$E=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($L))|ConvertFrom-Json -ea Stop",
    "$P=[string]$E.pipeName;$N=[string]$E.nonce;$Z=[string]$E.terminalToken;$X=[string]$E.executable;$D=[long]$E.deadlineUnixMilliseconds;$I=[string]$E.childEncoded;$B=[string]$E.sessionBootstrapEncoded",
    String.raw`if($P-notmatch '^ccc-hyper-v-network-[a-f0-9]{32}$'-or $N-notmatch '^[a-f0-9]{64}$'-or $Z-notmatch '^[a-f0-9]{64}$'-or $X-notmatch '^[A-Za-z]:\\[^\x00-\x1f]{1,1024}\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$'-or $I.Length-gt 8000-or $I-notmatch '^[A-Za-z0-9+/]+={0,2}$'-or $B.Length-gt 131072-or $B-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}`,
    "if($E.deadlineUnixMilliseconds-isnot [ValueType]-or [string]$E.deadlineUnixMilliseconds-notmatch '^[0-9]{1,16}$'-or $D-le 0-or $D-gt 9007199254740991){throw 'protocol'};$BT=[Diagnostics.Stopwatch]::StartNew();$DU=$E.PSObject.Properties.Name-contains 'maximumDurationMilliseconds';if($DU){if($E.maximumDurationMilliseconds-isnot [ValueType]-or [string]$E.maximumDurationMilliseconds-notmatch '^[0-9]{1,10}$'){throw 'protocol'};$BD=[long]$E.maximumDurationMilliseconds;if($BD-le 0-or $BD-gt [int]::MaxValue){throw 'protocol'}}else{$BD=$D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};[void](Left)",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CccHvPipe{[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool GetNamedPipeClientProcessId(IntPtr h,out uint p);}'",
    "$S=[IO.Pipes.PipeSecurity]::new();$A=[Security.Principal.SecurityIdentifier]'S-1-5-32-544';$S.SetAccessRule([IO.Pipes.PipeAccessRule]::new($A,[IO.Pipes.PipeAccessRights]::ReadWrite,[Security.AccessControl.AccessControlType]::Allow))",
    "$Q=[IO.Pipes.NamedPipeServerStream]::new($P,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$S)",
    `[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_REQUEST');[Console]::Out.Flush();if($null-eq ($AP=[Console]::In.ReadLine())){throw 'request'};if($DU){$AV=$AP.Split(':',2);if($AV.Count-ne 2-or $AV[0]-cne 'CCC_HYPER_V_ELEVATED_NETWORK_APPROVE'-or $AV[1]-notmatch '^[0-9]{1,10}$'){throw 'request'};$AD=[long]$AV[1];if($AD-le 0-or $AD-gt [int]::MaxValue){throw 'deadline'};$BD=[Math]::Min((Left),$AD);$BT.Restart()}elseif($AP-cne 'CCC_HYPER_V_ELEVATED_NETWORK_APPROVE'){throw 'request'};[void](Left);${relayProgress("approval-received")}`,
    "$H=$Q.BeginWaitForConnection($null,$null)",
    // Start-Process wraps the ShellExecute Win32Exception in an InvalidOperationException, so the
    // 1223 (ERROR_CANCELLED) test walks the InnerException chain; testing only the outer exception
    // reported a declined or timed-out UAC prompt as a launch failure.
    `try{$C=Start-Process -FilePath $X -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$I) -WindowStyle Hidden -PassThru -ea Stop}catch{$UE=$_.Exception;while($UE-and -not ($UE-is [ComponentModel.Win32Exception])){$UE=$UE.InnerException};if($UE-and $UE.NativeErrorCode-eq 1223){throw 'cancelled'};throw 'launch'};${relayProgress("runas-returned")}`,
    `$CS=$C.StartTime.ToUniversalTime().Ticks;$M=[int][Math]::Min([long]120000,(Left));if(-not $H.AsyncWaitHandle.WaitOne($M)){throw 'handshake'};$Q.EndWaitForConnection($H);${relayProgress("pipe-connected")}`,
    "[uint32]$CP=0;if(-not [CccHvPipe]::GetNamedPipeClientProcessId($Q.SafePipeHandle.DangerousGetHandle(),[ref]$CP)-or $CP-ne [uint32]$C.Id){throw 'authentication'}",
    "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true);$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
    "$AR=$R.ReadLineAsync();if(-not $AR.Wait([int][Math]::Min([long][int]::MaxValue,(Left)))){throw 'deadline'};$AL=$AR.Result;if(-not $AL-or $AL.Length-gt 4096-or -not $AL.StartsWith('AUTH:')){throw 'authentication'};$AJ=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AL.Substring(5)))|ConvertFrom-Json -ea Stop",
    `if([string]$AJ.nonce-cne $N-or [uint32]$AJ.pid-ne [uint32]$C.Id-or [long]$AJ.startTicks-ne [long]$CS){throw 'authentication'};if(-not [bool]$AJ.administrator){throw 'administrator'};${relayProgress("child-authenticated")}`,
    `$M=Left;if($DU){$W.WriteLine(([string]$M)+':'+$B)}else{$W.WriteLine($B)};$W.Flush();${relayProgress("session-bootstrap-sent")};$BR=$true;[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY');[Console]::Out.Flush();${relayProgress("relay-ready")}`,
    `$L=[Console]::In.ReadLine();if(-not $L-or $L.Length-gt ${MAX_RELAY_LINE_BYTES}-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'};[void](Left);$W.WriteLine($L);$W.Flush();${relayProgress("operation-asset-forwarded")};$V=$R.ReadLine();if($V-cne '${HYPER_V_WINDOWS_SESSION_READY_MARKER}'){throw 'protocol'};${relayProgress("child-ready")};[Console]::Out.WriteLine($V);[Console]::Out.Flush()`,
    `while($true){$L=[Console]::In.ReadLine();if($null-eq $L){throw 'input'};if($L.Length-gt ${MAX_RELAY_LINE_BYTES}){throw 'protocol'};$K='${ELEVATION_CLOSE_PREFIX}'+$Z+':';if($L.StartsWith($K)){${relayProgress("close-received")};$V=$L.Substring($K.Length).Split(':',2);[long]$G=0;if($V[0]-notmatch '^[0-9]{13}$'-or -not [long]::TryParse($V[0],[ref]$G)){throw 'protocol'};$CG=[Diagnostics.Stopwatch]::StartNew();if($V.Count-eq 2){if($V[1]-notmatch '^[0-9]{1,4}$'){throw 'protocol'};$CD=[long]$V[1];if($CD-gt ${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS}){throw 'protocol'}}else{$CD=$G-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();if($CD-gt ${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS}){throw 'protocol'};$CD=[Math]::Max([long]0,$CD)};$W.WriteLine('${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}');$W.Flush();${relayProgress("child-close-forwarded")};$CL=$true;break};if(-not $L.StartsWith('${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}')){throw 'protocol'};[void](Left);$W.WriteLine($L);$W.Flush();${relayProgress("request-forwarded")};$V=$R.ReadLine();if($null-eq $V-or $V.Length-gt ${MAX_RELAY_LINE_BYTES}-or -not $V.StartsWith('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}')){throw 'protocol'};${relayProgress("response-received")};[Console]::Out.WriteLine($V);[Console]::Out.Flush();${relayProgress("response-forwarded")}}`,
    `$M=[int][Math]::Min([long]${ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS},[Math]::Max([long]0,$CD-$CG.ElapsedMilliseconds-${ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS}));if($M-gt 0 -and $C -and $CS){try{[void]$C.WaitForExit($M)}catch{}};${relayProgress("child-graceful-wait-finished")}`,
    "}catch{$M=[string]$_.Exception.Message;$F=switch($M){'cancelled'{'hyper-v-network-elevation-cancelled'}'launch'{'hyper-v-network-elevation-launch-failed'}'handshake'{'hyper-v-network-elevation-handshake-timeout'}'authentication'{'hyper-v-network-elevation-authentication-failed'}'administrator'{'hyper-v-network-elevation-administrator-required'}'deadline'{'hyper-v-network-elevation-deadline-exceeded'}'request'{'hyper-v-network-elevation-request-failed'}'protocol'{'hyper-v-network-elevation-protocol-invalid'}default{'hyper-v-network-elevation-relay-failed'}}",
    `}finally{${relayProgress("finalizer-entered")};try{$R.Dispose()}catch{};try{$W.Dispose()}catch{};try{$Q.Dispose()}catch{};${relayProgress("named-pipe-disposed")};if(-not $CG){$CG=[Diagnostics.Stopwatch]::StartNew();$CD=${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS}};if($C-and $CS){$Y=Get-Process -Id $C.Id -ea SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){${relayProgress("child-force-attempted")};Stop-Process -Id $C.Id -Force -ea SilentlyContinue;$M=[int][Math]::Max([long]0,$CD-$CG.ElapsedMilliseconds);if($M-gt 0){[void]$Y.WaitForExit($M)};${relayProgress("child-force-wait-finished")}};$Y=Get-Process -Id $C.Id -ea SilentlyContinue;${relayProgress("child-reinspection-finished")};if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){$F='hyper-v-network-elevation-termination-unconfirmed'}}}`,
    "if($F){Fail $F}",
    `if($CL-and $Z-match '^[a-f0-9]{64}$'){${relayProgress("terminal-write-entered")};[Console]::Out.WriteLine('${ELEVATION_TERMINAL_PREFIX}'+$Z);[Console]::Out.Flush()}`,
    "if($F-or -not $CL){exit 1}",
].join(";");

function parseElevationFailure(line: string): HyperVElevatedNetworkErrorCode | null {
    if (!line.startsWith(ELEVATION_FAILURE_PREFIX)) return null;
    const code = line.slice(ELEVATION_FAILURE_PREFIX.length);
    // The suppression code is proven-not-started, and only the gate in this process may claim it:
    // accepted from the relay, it would widen what the relay can say about a mutation.
    return isElevationErrorCode(code) && code !== SUPPRESSED_CODE
        ? code
        : "hyper-v-network-elevation-protocol-invalid";
}

function defaultSpawnRelay(
    request: HyperVElevatedNetworkRelaySpawnRequest,
    monotonicNow: () => number,
    cleanupElapsedMilliseconds: () => number,
): HyperVElevatedNetworkRelayProcess {
    const startedAt = monotonicNow();
    const duration = request.maximumDurationMilliseconds
        ?? Math.min(2_147_483_647, request.deadlineUnixMilliseconds - Date.now());
    const remainingMilliseconds = () => {
        const elapsed = monotonicNow() - startedAt;
        return Number.isFinite(elapsed) ? Math.floor(duration - elapsed) : 0;
    };
    const canonicalExecutable = canonicalWindowsPowerShellPath();
    if (!canonicalExecutable
        || !validSystemPowerShellPath(request.executable)
        || canonicalExecutable.toLocaleLowerCase("en-US") !== request.executable.toLocaleLowerCase("en-US")) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-executable-rejected");
    }
    const pipeName = `ccc-hyper-v-network-${randomBytes(16).toString("hex")}`;
    const nonce = randomBytes(32).toString("hex");
    const terminalToken = randomBytes(32).toString("hex");
    const childEncoded = encodedPowerShell(elevatedChildSource(
        pipeName,
        nonce,
        request.deadlineUnixMilliseconds,
        request.maximumDurationMilliseconds,
    ));
    if (childEncoded.length > 8_000) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-protocol-invalid");
    }
    const launchEnvelope = Buffer.from(JSON.stringify({
        pipeName,
        nonce,
        terminalToken,
        executable: request.executable,
        deadlineUnixMilliseconds: request.deadlineUnixMilliseconds,
        ...(request.maximumDurationMilliseconds !== undefined
            ? { maximumDurationMilliseconds: remainingMilliseconds() }
            : {}),
        childEncoded,
        sessionBootstrapEncoded: Buffer.from(request.sessionBootstrap, "utf8").toString("base64"),
    }), "utf8").toString("base64");
    if (Buffer.byteLength(launchEnvelope, "utf8") > MAX_LAUNCH_ENVELOPE_BYTES) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-protocol-invalid");
    }

    if (remainingMilliseconds() <= 0) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    const child = spawn(request.executable, hiddenWindowsPowerShellArgs([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP,
    ]), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: HyperVWindowsSessionErrorCode) => void> = [];
    const queued: QueuedWrite[] = [];
    let buffered = "";
    let stderrBytes = 0;
    let relayReady = false;
    let elevationRequested = false;
    let requestAttempted = false;
    let relayFailure: HyperVElevatedNetworkRelayCompletion = {
        errorCode: null,
        terminationStage: null,
    };
    let exited = false;
    let sessionExitNotified = false;
    let exitReason: HyperVWindowsSessionErrorCode = "hyper-v-windows-session-exited";
    let closing = false;
    let killed = false;
    let terminalAcknowledged = false;
    let relayProcessExited = false;
    let relayStdoutDrained = child.stdout === null;
    let forceExpired = false;
    let shutdownMode: HyperVElevatedNetworkRelayDiagnostic["shutdownMode"] = "not-started";
    let relayProgressStage: HyperVElevatedNetworkRelayProgressStage | null = null;
    let closeWriteStatus: HyperVElevatedNetworkRelayDiagnostic["closeWriteStatus"] = "not-started";
    let relayStderrObserved = false;
    let relayInputEnded = false;
    let sessionOutputRejected = false;
    const cleanupRemainingMilliseconds = (maximum: number) => Math.max(0,
        maximum - cleanupElapsedMilliseconds());
    let forcedKill: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let closeWriteTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveCompletion = (_result: HyperVElevatedNetworkRelayCompletion) => undefined as void;
    const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
        resolveCompletion = resolve;
    });
    let resolveReady = () => undefined as void;
    const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });
    const diagnostic = (): HyperVElevatedNetworkRelayDiagnostic => ({
        shutdownMode,
        progressStage: relayProgressStage,
        closeWriteStatus,
        processExited: relayProcessExited,
        stdoutDrained: relayStdoutDrained,
        stderrObserved: relayStderrObserved,
        forceExpired,
    });

    const failQueued = (error: Error) => {
        for (const entry of queued.splice(0)) entry.settled?.(error);
    };
    const notifySessionExit = (reason: HyperVWindowsSessionErrorCode) => {
        if (sessionExitNotified) return;
        sessionExitNotified = true;
        exitReason = reason;
        for (const listener of [...exitListeners]) listener(reason);
    };
    const finish = (reason: HyperVWindowsSessionErrorCode) => {
        if (exited) return;
        exited = true;
        if (forcedKill) clearTimeout(forcedKill);
        if (closeWriteTimer) clearTimeout(closeWriteTimer);
        failQueued(new Error(reason));
        notifySessionExit(reason);
        resolveReady();
        resolveCompletion(relayFailure);
    };
    const recordPrimaryFailure = (code: HyperVElevatedNetworkNonTerminationErrorCode) => {
        relayFailure = transitionHyperVElevatedNetworkRelayFailure(relayFailure, {
            kind: "replace-primary",
            code,
        });
    };
    const recordPrimaryFailureIfAbsent = (code: HyperVElevatedNetworkNonTerminationErrorCode) => {
        relayFailure = transitionHyperVElevatedNetworkRelayFailure(relayFailure, {
            kind: "primary-if-absent",
            code,
        });
    };
    const recordTerminationFailure = (
        event: Extract<HyperVElevatedNetworkRelayFailureEvent, { readonly kind: "termination" }>,
    ) => {
        relayFailure = transitionHyperVElevatedNetworkRelayFailure(relayFailure, event);
    };
    const normalExitReason = (): HyperVWindowsSessionErrorCode => requestAttempted
        ? "hyper-v-windows-session-exited"
        : "hyper-v-windows-session-start-failed";
    const finishAfterRelayTermination = () => {
        if ((terminalAcknowledged || forceExpired) && relayProcessExited && relayStdoutDrained) {
            finish(normalExitReason());
        }
    };
    const endRelayInput = () => {
        if (relayInputEnded) return;
        relayInputEnded = true;
        child.stdin?.end();
    };
    const armForcedKill = () => {
        if (forcedKill || exited) return;
        const force = () => {
            const remaining = cleanupRemainingMilliseconds(RELAY_FORCE_GRACE_MILLISECONDS);
            if (remaining > 0) {
                forcedKill = setTimeout(force, Math.max(1, remaining));
                forcedKill.unref?.();
                return;
            }
            forceExpired = true;
            recordTerminationFailure({
                kind: "termination",
                stage: !terminalAcknowledged
                    ? "relay-terminal-ack-missing"
                    : !relayProcessExited
                        ? "relay-process-exit-timeout"
                        : "relay-output-drain-timeout",
                replaceFailure: false,
            });
            endRelayInput();
            if (!relayProcessExited) {
                shutdownMode = "abrupt";
                child.kill();
            }
            finishAfterRelayTermination();
        };
        forcedKill = setTimeout(force, Math.max(1, cleanupRemainingMilliseconds(RELAY_FORCE_GRACE_MILLISECONDS)));
        forcedKill.unref?.();
    };
    const stop = () => {
        if (killed) return;
        shutdownMode = "abrupt";
        killed = true;
        endRelayInput();
        armForcedKill();
    };
    const rejectSessionOutput = () => {
        sessionOutputRejected = true;
        buffered = "";
        stop();
    };
    const close = () => {
        if (closing || killed || exited) return;
        shutdownMode = "graceful";
        closing = true;
        if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
        }
        const expireCloseWrite = () => {
            const remaining = cleanupRemainingMilliseconds(RELAY_CLOSE_WRITE_GRACE_MILLISECONDS);
            if (remaining > 0) {
                closeWriteTimer = setTimeout(expireCloseWrite, Math.max(1, remaining));
                closeWriteTimer.unref?.();
                return;
            }
            closeWriteTimer = null;
            if (exited || killed) return;
            closeWriteStatus = "timed-out";
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-input-write",
                replaceFailure: false,
            });
            rejectSessionOutput();
        };
        closeWriteTimer = setTimeout(expireCloseWrite, Math.max(1,
            cleanupRemainingMilliseconds(RELAY_CLOSE_WRITE_GRACE_MILLISECONDS)));
        closeWriteTimer.unref?.();
        const finalizationDeadline = Date.now() + ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS;
        closeWriteStatus = "pending";
        const finalizationDuration = request.maximumDurationMilliseconds !== undefined
            ? `:${Math.floor(cleanupRemainingMilliseconds(ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS))}`
            : "";
        child.stdin?.write(`${ELEVATION_CLOSE_PREFIX}${terminalToken}:${finalizationDeadline}${finalizationDuration}\n`, (error) => {
            if (closeWriteTimer) {
                clearTimeout(closeWriteTimer);
                closeWriteTimer = null;
            }
            if (exited) return;
            if (closeWriteStatus !== "pending") return;
            if (error) {
                closeWriteStatus = "failed";
                recordTerminationFailure({
                    kind: "termination",
                    stage: "relay-input-write",
                    replaceFailure: false,
                });
                rejectSessionOutput();
                return;
            }
            closeWriteStatus = "succeeded";
            endRelayInput();
        });
        armForcedKill();
    };
    const flushQueued = () => {
        if (!relayReady || exited || closing || killed) return;
        if (remainingMilliseconds() <= 0) {
            recordPrimaryFailureIfAbsent("hyper-v-network-elevation-deadline-exceeded");
            failQueued(new Error("hyper-v-network-elevation-deadline-exceeded"));
            stop();
            return;
        }
        for (const entry of queued.splice(0)) {
            if (entry.line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) requestAttempted = true;
            child.stdin?.write(`${entry.line}\n`, (error) => {
                entry.settled?.(error ?? undefined);
                if (error) {
                    recordTerminationFailure({
                        kind: "termination",
                        stage: "relay-input-write",
                        replaceFailure: false,
                    });
                    notifySessionExit("hyper-v-windows-session-stdin-failed");
                    stop();
                    finishAfterRelayTermination();
                }
            });
        }
    };
    const handleControlLine = (line: string): boolean => {
        if (terminalAcknowledged) {
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-terminal-ack-invalid",
                replaceFailure: false,
            });
            rejectSessionOutput();
            return true;
        }
        if (line.startsWith(ELEVATION_PROGRESS_PREFIX)) {
            const correlatedPrefix = `${ELEVATION_PROGRESS_PREFIX}${terminalToken}:`;
            const candidate = line.startsWith(correlatedPrefix)
                ? line.slice(correlatedPrefix.length)
                : "";
            const progress = HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES.find(
                (stage) => stage === candidate,
            ) ?? null;
            if (!progress) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                rejectSessionOutput();
                return true;
            }
            relayProgressStage = progress;
            return true;
        }
        const observedFailure = parseElevationFailure(line);
        if (observedFailure) {
            // Every code in this set is the relay saying the elevated child never ran, and the
            // adapter believes it: `ELEVATED_MUTATION_PROVEN_NOT_STARTED` aborts the
            // transaction on them rather than treating the mutation as indeterminate. The
            // relay can only reach them during bootstrap, before it announces readiness — so
            // today this guard cannot fire. That is exactly why it is here. The safety of a
            // privileged mutation currently rests on an accident of the relay's control flow,
            // and a later second elevation attempt would silently turn a may-have-run mutation
            // into a proven-not-run one with nothing to catch it.
            //
            // Downgraded to `relay-failed` rather than `protocol-invalid`, which looks like the
            // natural choice and is wrong: `protocol-invalid` is itself in the proven-not-started
            // set, so it would preserve the very claim being rejected. `relay-failed` is not,
            // and therefore reads as indeterminate — the conservative direction.
            if (relayReady && RELAY_BOOTSTRAP_ONLY_FAILURES.has(observedFailure)) {
                recordPrimaryFailure("hyper-v-network-elevation-relay-failed");
                rejectSessionOutput();
                return true;
            }
            if (observedFailure === TERMINATION_UNCONFIRMED_CODE) {
                recordTerminationFailure({
                    kind: "termination",
                    stage: "elevated-child",
                    replaceFailure: true,
                });
                rejectSessionOutput();
            } else {
                recordPrimaryFailure(observedFailure);
                if (observedFailure === "hyper-v-network-elevation-protocol-invalid") {
                    rejectSessionOutput();
                }
            }
            return true;
        }
        if (line === ELEVATION_REQUEST_MARKER) {
            if (elevationRequested) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                rejectSessionOutput();
                return true;
            }
            elevationRequested = true;
            try {
                if (remainingMilliseconds() <= 0) throw new HyperVElevatedNetworkSessionError(
                    "hyper-v-network-elevation-deadline-exceeded",
                );
                request.onBeforeElevation();
                const remaining = remainingMilliseconds();
                if (remaining <= 0) throw new HyperVElevatedNetworkSessionError(
                    "hyper-v-network-elevation-deadline-exceeded",
                );
                child.stdin?.write(`${ELEVATION_APPROVAL}${request.maximumDurationMilliseconds !== undefined
                    ? `:${remaining}` : ""}\n`);
            } catch (error) {
                recordPrimaryFailure(error instanceof HyperVElevatedNetworkSessionError
                    && error.code === "hyper-v-network-elevation-deadline-exceeded"
                    ? error.code : "hyper-v-network-elevation-request-failed");
                endRelayInput();
            }
            return true;
        }
        if (line === ELEVATION_READY_MARKER) {
            if (!elevationRequested || relayReady) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                rejectSessionOutput();
                return true;
            }
            relayReady = true;
            resolveReady();
            flushQueued();
            return true;
        }
        if (line.startsWith(ELEVATION_TERMINAL_PREFIX)) {
            if (!closing || line !== `${ELEVATION_TERMINAL_PREFIX}${terminalToken}`) {
                recordTerminationFailure({
                    kind: "termination",
                    stage: "relay-terminal-ack-invalid",
                    replaceFailure: false,
                });
                rejectSessionOutput();
                return true;
            }
            terminalAcknowledged = true;
            finishAfterRelayTermination();
            return true;
        }
        return false;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        if (sessionOutputRejected) return;
        buffered += chunk;
        let index = buffered.indexOf("\n");
        while (index >= 0) {
            const line = buffered.slice(0, index).replace(/\r$/, "");
            buffered = buffered.slice(index + 1);
            if (Buffer.byteLength(line, "utf8") > MAX_RELAY_LINE_BYTES) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                rejectSessionOutput();
                return;
            }
            if (!handleControlLine(line)) {
                if (!relayReady) {
                    recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                    rejectSessionOutput();
                    return;
                }
                if (!sessionOutputRejected) {
                    for (const listener of [...lineListeners]) listener(line);
                }
            }
            if (sessionOutputRejected) return;
            index = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered, "utf8") > MAX_RELAY_LINE_BYTES) {
            recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
            rejectSessionOutput();
        }
    });
    child.stdout?.once("end", () => {
        relayStdoutDrained = true;
        if (buffered.length > 0) {
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-terminal-ack-invalid",
                replaceFailure: false,
            });
            buffered = "";
            rejectSessionOutput();
        }
        finishAfterRelayTermination();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
        relayStderrObserved = true;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_RELAY_LINE_BYTES) {
            recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
            rejectSessionOutput();
        }
    });
    child.once("error", () => {
        recordPrimaryFailureIfAbsent("hyper-v-network-elevation-relay-spawn-failed");
        finish(requestAttempted ? "hyper-v-windows-session-exited" : "hyper-v-windows-session-spawn-failed");
    });
    child.once("exit", () => {
        relayProcessExited = true;
        if (!relayReady) recordPrimaryFailureIfAbsent("hyper-v-network-elevation-relay-failed");
        finishAfterRelayTermination();
    });
    child.once("close", () => {
        if (exited) return;
        if (shutdownMode === "not-started") shutdownMode = "abrupt";
        if (!relayReady) recordPrimaryFailureIfAbsent("hyper-v-network-elevation-relay-failed");
        if (!terminalAcknowledged) {
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-terminal-ack-missing",
                replaceFailure: false,
            });
        } else if (!relayProcessExited) {
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-process-exit-timeout",
                replaceFailure: false,
            });
        } else if (!relayStdoutDrained) {
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-output-drain-timeout",
                replaceFailure: false,
            });
        }
        finish(normalExitReason());
    });
    child.stdin?.on("error", () => {
        recordTerminationFailure({
            kind: "termination",
            stage: "relay-input-write",
            replaceFailure: false,
        });
        stop();
        finishAfterRelayTermination();
    });
    child.stdin?.write(`${launchEnvelope}\n`, (error) => {
        if (error) {
            recordPrimaryFailureIfAbsent("hyper-v-network-elevation-relay-spawn-failed");
            finish("hyper-v-windows-session-stdin-failed");
        }
    });
    const expire = () => {
        const remaining = remainingMilliseconds();
        if (remaining > 0) {
            deadlineTimer = setTimeout(expire, Math.max(1, remaining));
            deadlineTimer.unref?.();
            return;
        }
        recordPrimaryFailureIfAbsent("hyper-v-network-elevation-deadline-exceeded");
        stop();
    };
    deadlineTimer = setTimeout(expire, Math.max(1, remainingMilliseconds()));
    deadlineTimer.unref?.();
    completion.finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }).catch(() => undefined);

    return {
        completion,
        ready,
        failureCode: () => relayFailure.errorCode,
        terminationStage: () => relayFailure.terminationStage,
        diagnostic,
        close,
        write(line, settled) {
            if (exited || closing || killed) {
                settled?.(new Error(exitReason));
                return;
            }
            queued.push({ line, ...(settled ? { settled } : {}) });
            flushQueued();
        },
        onLine(listener) {
            lineListeners.push(listener);
        },
        onExit(listener) {
            exitListeners.push(listener);
            if (sessionExitNotified) queueMicrotask(() => listener(exitReason));
        },
        kill: stop,
    };
}

function boundedElevationCode(error: unknown): HyperVElevatedNetworkErrorCode {
    return error instanceof HyperVElevatedNetworkSessionError
        ? error.code
        : "hyper-v-network-elevation-relay-spawn-failed";
}

function failedExecution(code: HyperVElevatedNetworkErrorCode): HyperVWindowsExecutionResult {
    return { status: null, stdout: "", error: code };
}

function boundedSessionError(error: string | undefined): HyperVWindowsSessionErrorCode | "non-session-error" | null {
    if (!error) return null;
    return isWindowsSessionError(error) ? error : "non-session-error";
}

function reportsRelayCompletionFailure(
    value: unknown,
    code: HyperVElevatedNetworkNonTerminationErrorCode,
): boolean {
    try {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const status = Reflect.get(value, "status");
        const stdout = Reflect.get(value, "stdout");
        const error = Reflect.get(value, "error");
        return (status === null || Number.isInteger(status))
            && typeof stdout === "string"
            && error === code;
    } catch {
        return false;
    }
}

export async function withElevatedHyperVNetworkExecutor<T>(
    options: WithElevatedHyperVNetworkExecutorOptions,
    operation: (executor: HyperVWindowsExecutor) => T | Promise<T>,
): Promise<T> {
    const durationProvided = Object.prototype.hasOwnProperty.call(options, "maximumDurationMilliseconds");
    if (!Number.isSafeInteger(options.deadlineUnixMilliseconds)
        || options.deadlineUnixMilliseconds <= 0
        || (durationProvided && (!Number.isInteger(options.maximumDurationMilliseconds)
            || options.maximumDurationMilliseconds! <= 0
            || options.maximumDurationMilliseconds! > 2_147_483_647))) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    if (!Number.isFinite(startedAt)) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    const duration = durationProvided ? options.maximumDurationMilliseconds!
        : Math.min(2_147_483_647, options.deadlineUnixMilliseconds - Date.now());
    const remainingMilliseconds = () => {
        const elapsed = monotonicNow() - startedAt;
        return Number.isFinite(elapsed) ? Math.floor(duration - elapsed) : 0;
    };
    if (remainingMilliseconds() <= 0) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    let cleanupStartedAt: number | null = null;
    const cleanupElapsedMilliseconds = () => {
        cleanupStartedAt ??= monotonicNow();
        return monotonicNow() - cleanupStartedAt;
    };
    const spawnRelay: HyperVElevatedNetworkRelaySpawn = options.spawnRelay
        ?? ((request) => defaultSpawnRelay(request, monotonicNow, cleanupElapsedMilliseconds));
    let active = true;
    let relay: HyperVElevatedNetworkRelayProcess | null = null;
    type ObservedRelayCompletion =
        | { readonly kind: "resolved"; readonly value: unknown }
        | { readonly kind: "rejected" };
    let relayCompletion: Promise<ObservedRelayCompletion> | null = null;
    let relayFailureCode: (() => unknown) | null = null;
    let relayKill: (() => unknown) | null = null;
    let relayTerminationStage: (() => unknown) | null = null;
    let relayDiagnostic: (() => unknown) | null = null;
    const currentRelayCompletion = () => relayCompletion;
    const currentRelayTerminationStage = () => relayTerminationStage;
    const currentRelayDiagnostic = () => relayDiagnostic;
    let startupFailure: HyperVElevatedNetworkErrorCode | null = null;
    let lastOperation: HyperVWindowsOperation | null = null;
    let lastSessionError: HyperVWindowsSessionErrorCode | "non-session-error" | null = null;
    let activeExecutions = 0;
    let activeExecutionsAtClose = 0;
    let pendingExecutionsAtClose = 0;
    // Acquisition gate. Every per-primitive budget in the session — the caller deadline, the
    // health floor, and the fraction a queued caller may wait — is sized for running primitives.
    // The elevation start is not one: UAC consent, elevated child start, pipe handshake and
    // bootstrap take as long as the person takes. Measured twice on the real host: a concurrent
    // inspection expired in the queue at the 30-second fraction behind the primitive that started
    // the relay, and after that was gated, the starting primitive itself expired at its own
    // 120-second ceiling on a slow consent. So no primitive enters the session until the relay
    // has been started through the session and has reported readiness (or can never do so). The
    // wait is bounded by the relay's own deadline and by the abort signals, and the elevation
    // deadline is re-checked after it, so no primitive gains budget.
    let relayAcquisition: Promise<void> | null = null;
    const currentRelayAcquisition = (): Promise<void> | null => relayAcquisition;
    let relayReadinessSettled = false;
    let settleRelayReadiness = () => undefined as void;
    const relayReadiness = new Promise<void>((resolve) => {
        settleRelayReadiness = () => {
            relayReadinessSettled = true;
            resolve();
        };
    });
    // What `onAcquisitionSettled` reports. `ready` is only true when the relay reported readiness
    // before anything else settled the gate — a start failure, relay completion or the scope
    // closing — and a readiness that arrives after that cannot rewrite it.
    let elevationPrompted = false;
    let relayBecameReady = false;
    const settleRelayReadinessAsReady = () => {
        // A relay's `ready` also settles when it can never become ready, and in that case the relay
        // has recorded why first. The failure on record is what tells the two apart.
        if (!relayReadinessSettled) {
            relayBecameReady = active && remainingMilliseconds() > 0
                && startupFailure === null && safeRelayFailureCode(relayFailureCode) === null;
        }
        settleRelayReadiness();
    };
    const adoptRelayReadiness = (spawnedRelay: HyperVElevatedNetworkRelayProcess) => {
        let readiness: unknown;
        try {
            readiness = spawnedRelay.ready;
        } catch {
            readiness = undefined;
        }
        if (readiness === undefined) {
            settleRelayReadinessAsReady();
            return;
        }
        try {
            Promise.resolve(readiness).then(
                () => settleRelayReadinessAsReady(),
                () => settleRelayReadiness(),
            );
        } catch {
            settleRelayReadiness();
        }
    };
    let acquisitionReported = false;
    const reportAcquisitionSettled = () => {
        if (acquisitionReported) return;
        acquisitionReported = true;
        const listener = options.onAcquisitionSettled;
        if (!listener) return;
        try {
            listener({
                prompted: elevationPrompted,
                ready: relayBecameReady,
                code: relayBecameReady ? null : startupFailure ?? safeRelayFailureCode(relayFailureCode),
            });
        } catch {
            // An observer cannot change how this scope ends.
        }
    };
    const acquireRelay = async () => {
        let started = false;
        try {
            started = await session.start();
        } catch {
            // The session reports its own start failure through the next execute.
        }
        if (!started) settleRelayReadiness();
        await relayReadiness;
        reportAcquisitionSettled();
    };
    const awaitRelayAcquisition = async (context: HyperVWindowsExecutionContext) => {
        relayAcquisition ??= acquireRelay();
        const gate = relayAcquisition;
        const signals = [options.signal, context.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        );
        if (signals.some((signal) => signal.aborted)) return;
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const done = () => {
                if (timer) clearTimeout(timer);
                for (const signal of signals) signal.removeEventListener("abort", done);
                resolve();
            };
            const expire = () => {
                const remaining = remainingMilliseconds();
                if (remaining > 0) {
                    timer = setTimeout(expire, remaining);
                    return;
                }
                startupFailure ??= "hyper-v-network-elevation-deadline-exceeded";
                settleRelayReadiness();
                reportAcquisitionSettled();
                done();
            };
            for (const signal of signals) signal.addEventListener("abort", done, { once: true });
            timer = setTimeout(expire, Math.max(1, remainingMilliseconds()));
            gate.then(done, done);
        });
    };
    const session = createHyperVWindowsPowerShellSession({
        maximumStarts: 1,
        now: monotonicNow,
        ...(options.operationAsset ? { operationAsset: options.operationAsset } : {}),
        spawn: async (sessionBootstrap) => {
            if (relay) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-relay-failed");
            try {
                const remaining = remainingMilliseconds();
                if (!active || remaining <= 0) throw new HyperVElevatedNetworkSessionError(
                    "hyper-v-network-elevation-deadline-exceeded",
                );
                const spawnedRelay = await spawnRelay({
                    executable: options.executable,
                    sessionBootstrap,
                    deadlineUnixMilliseconds: options.deadlineUnixMilliseconds,
                    maximumDurationMilliseconds: remaining,
                    onBeforeElevation: () => {
                        // A scope that has ended, and so has already reported its settlement,
                        // never approves a prompt: the relay reports request-failed instead.
                        if (!active) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-scope-closed");
                        if (remainingMilliseconds() <= 0) throw new HyperVElevatedNetworkSessionError(
                            "hyper-v-network-elevation-deadline-exceeded",
                        );
                        // Recorded before the caller's hook runs: if that hook throws, the relay
                        // reports request-failed and never reaches RunAs.
                        elevationPrompted = true;
                        options.onBeforeElevation?.();
                        if (remainingMilliseconds() <= 0) throw new HyperVElevatedNetworkSessionError(
                            "hyper-v-network-elevation-deadline-exceeded",
                        );
                    },
                });
                relay = spawnedRelay;
                adoptRelayReadiness(spawnedRelay);
                try {
                    const completion: unknown = spawnedRelay.completion;
                    relayCompletion = Promise.resolve(completion).then<
                        ObservedRelayCompletion,
                        ObservedRelayCompletion
                    >(
                        (value) => ({ kind: "resolved", value }),
                        () => ({ kind: "rejected" }),
                    );
                } catch {
                    relayCompletion = Promise.resolve({ kind: "rejected" });
                }
                try {
                    const provider = spawnedRelay.failureCode;
                    relayFailureCode = typeof provider === "function"
                        ? () => provider.call(spawnedRelay)
                        : () => undefined;
                } catch {
                    relayFailureCode = () => undefined;
                }
                try {
                    const provider = spawnedRelay.kill;
                    relayKill = typeof provider === "function"
                        ? () => provider.call(spawnedRelay)
                        : null;
                } catch {
                    relayKill = null;
                }
                try {
                    const provider = spawnedRelay.terminationStage;
                    relayTerminationStage = typeof provider === "function"
                        ? () => provider.call(spawnedRelay)
                        : null;
                } catch {
                    relayTerminationStage = null;
                }
                try {
                    const provider = spawnedRelay.diagnostic;
                    relayDiagnostic = typeof provider === "function"
                        ? () => provider.call(spawnedRelay)
                        : null;
                } catch {
                    relayDiagnostic = null;
                }
                if (relayCompletion) relayCompletion.then(() => settleRelayReadiness(), () => settleRelayReadiness());
                if (!active) {
                    try { spawnedRelay.close(); } catch { bestEffortRelayKill(relayKill); }
                }
                return spawnedRelay;
            } catch (error) {
                startupFailure = boundedElevationCode(error);
                settleRelayReadiness();
                throw error;
            }
        },
    });
    const scopedExecutor: HyperVWindowsExecutor = {
        async execute(
            request: HyperVWindowsExecutionRequest,
            context: HyperVWindowsExecutionContext,
        ): Promise<HyperVWindowsExecutionResult> {
            if (!active) return failedExecution("hyper-v-network-elevation-scope-closed");
            if (lastSessionError === null) lastOperation = request.operation;
            if (options.signal?.aborted || context.signal?.aborted) {
                return failedExecution("hyper-v-network-elevation-cancelled");
            }
            if (remainingMilliseconds() <= 0) return failedExecution("hyper-v-network-elevation-deadline-exceeded");
            // Deliberately not counted in `activeExecutions`. A primitive parked here has
            // written nothing to the host — it is waiting for a human to answer UAC — and the
            // only consumer of that counter is the termination diagnostic, which a reader uses
            // to judge whether a privileged mutation may have been half applied. Counting the
            // wait made a declined prompt report two primitives in flight when zero frames had
            // been sent, which is the opposite of what that field exists to tell them.
            await awaitRelayAcquisition(context);
            if (!active) return failedExecution("hyper-v-network-elevation-scope-closed");
            if (options.signal?.aborted || context.signal?.aborted) {
                return failedExecution("hyper-v-network-elevation-cancelled");
            }
            const remaining = remainingMilliseconds();
            if (remaining <= 0) return failedExecution("hyper-v-network-elevation-deadline-exceeded");
            activeExecutions += 1;
            let result: HyperVWindowsExecutionResult;
            try {
                result = await session.execute(request, {
                    ...context,
                    timeoutMilliseconds: Math.min(context.timeoutMilliseconds, remaining),
                    ...(options.signal ? { signal: options.signal } : {}),
                });
            } catch (error) {
                if (lastSessionError === null) {
                    lastOperation = request.operation;
                    lastSessionError = "non-session-error";
                }
                throw error;
            } finally {
                activeExecutions -= 1;
            }
            if (!result.error && remainingMilliseconds() <= 0) {
                result = { ...result, status: null, error: "hyper-v-windows-session-timeout" };
            }
            const observedSessionError = boundedSessionError(result.error);
            if (observedSessionError && lastSessionError === null) {
                lastOperation = request.operation;
                lastSessionError = observedSessionError;
            }
            const code = startupFailure ?? safeRelayFailureCode(relayFailureCode);
            return result.error && code
                && !(code === "hyper-v-network-elevation-deadline-exceeded" && observedSessionError)
                ? { ...result, error: code } : result;
        },
    };

    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | null = null;
    try {
        outcome = { ok: true, value: await operation(scopedExecutor) };
    } catch (error) {
        outcome = { ok: false, error };
    } finally {
        cleanupStartedAt ??= monotonicNow();
        active = false;
        activeExecutionsAtClose = activeExecutions;
        pendingExecutionsAtClose = session.outstanding().pendingRequests;
        settleRelayReadiness();
        // An acquisition whose relay is still starting reports now, so the verdict is on record
        // before this scope returns; a relay that turns up later cannot rewrite it.
        if (relayAcquisition) reportAcquisitionSettled();
        session.close();
    }

    let completionError: HyperVElevatedNetworkNonTerminationErrorCode | null = null;
    let terminationStage: HyperVElevatedNetworkTerminationStage | null = null;
    const acquisitionPromise = currentRelayAcquisition();
    const completionPromise = acquisitionPromise
        ? acquisitionPromise.then(() => currentRelayCompletion())
        : currentRelayCompletion();
    if (completionPromise) {
        let completionTimer: ReturnType<typeof setTimeout> | null = null;
        let completion: ObservedRelayCompletion | { readonly kind: "timeout" | "absent" };
        try {
            completion = await Promise.race([
                completionPromise.then((value) => value ?? { kind: "absent" as const }),
                new Promise<{ readonly kind: "timeout" }>((resolve) => {
                    const expire = () => {
                        const remaining = RELAY_COMPLETION_GRACE_MILLISECONDS - cleanupElapsedMilliseconds();
                        if (remaining > 0) {
                            completionTimer = setTimeout(expire, Math.max(1, remaining));
                            return;
                        }
                        resolve({ kind: "timeout" });
                    };
                    completionTimer = setTimeout(expire, Math.max(1,
                        RELAY_COMPLETION_GRACE_MILLISECONDS - cleanupElapsedMilliseconds()));
                }),
            ]);
        } finally {
            if (completionTimer) clearTimeout(completionTimer);
        }
        if (completion.kind === "timeout" || completion.kind === "rejected") {
            bestEffortRelayKill(relayKill);
            terminationStage = safeRelayTerminationStage(currentRelayTerminationStage())
                ?? "relay-completion-timeout";
        } else if (completion.kind === "resolved") {
            const decodedCompletion = safeRelayCompletion(completion.value);
            if (!decodedCompletion) {
                bestEffortRelayKill(relayKill);
                terminationStage = safeRelayTerminationStage(currentRelayTerminationStage())
                    ?? "relay-completion-timeout";
            } else if (decodedCompletion.errorCode === TERMINATION_UNCONFIRMED_CODE) {
                terminationStage = decodedCompletion.terminationStage;
            } else {
                completionError = decodedCompletion.errorCode;
            }
        }
    }
    if (!terminationStage) {
        const reportedFailure = startupFailure ?? safeRelayFailureCode(relayFailureCode);
        if (reportedFailure === TERMINATION_UNCONFIRMED_CODE) {
            terminationStage = safeRelayTerminationStage(currentRelayTerminationStage())
                ?? "relay-completion-timeout";
        } else if (reportedFailure && !completionError) {
            completionError = reportedFailure;
        }
    }
    if (terminationStage) {
        const relaySnapshot = safeRelayDiagnostic(currentRelayDiagnostic());
        throw new HyperVElevatedNetworkSessionError(TERMINATION_UNCONFIRMED_CODE, terminationStage, {
            relay: relaySnapshot,
            execution: {
                lastOperation,
                lastSessionError,
                activeExecutions: activeExecutionsAtClose,
                pendingExecutions: pendingExecutionsAtClose,
            },
        });
    }
    if (!outcome) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-relay-failed");
    if ("error" in outcome) throw outcome.error;
    if (completionError
        && !(completionError === "hyper-v-network-elevation-deadline-exceeded" && lastSessionError)
        && !reportsRelayCompletionFailure(outcome.value, completionError)) {
        throw new HyperVElevatedNetworkSessionError(completionError);
    }
    if (remainingMilliseconds() <= 0 && lastSessionError === null
        && !reportsRelayCompletionFailure(outcome.value, "hyper-v-network-elevation-deadline-exceeded")) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    return outcome.value;
}
