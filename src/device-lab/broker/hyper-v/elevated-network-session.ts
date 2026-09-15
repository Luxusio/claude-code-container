import { spawn } from "child_process";
import { gzipSync } from "zlib";
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
} from "../../../hyper-v-windows/index.js";

const ELEVATION_REQUEST_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_REQUEST";
const ELEVATION_READY_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY";
const ELEVATION_FAILURE_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:";
const ELEVATION_CLOSE_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_CLOSE:";
const ELEVATION_TERMINAL_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:";
const ELEVATION_PROGRESS_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:";
const ELEVATION_APPROVAL = "CCC_HYPER_V_ELEVATED_NETWORK_APPROVE";
const MAX_RELAY_LINE_BYTES = 256 * 1024;
const MAX_LAUNCH_ENVELOPE_BYTES = 256 * 1024;
const ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS = 5_000;
const ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS = 4_500;
const ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS = 500;
const RELAY_CLOSE_WRITE_GRACE_MILLISECONDS = 1_000;
const RELAY_FORCE_GRACE_MILLISECONDS = 10_000;
const RELAY_COMPLETION_GRACE_MILLISECONDS = 15_000;
const TERMINATION_UNCONFIRMED_CODE = "hyper-v-network-elevation-termination-unconfirmed";

export const HYPER_V_ELEVATED_NETWORK_ERROR_CODES = Object.freeze([
    "hyper-v-network-elevation-cancelled",
    "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-handshake-timeout",
    "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required",
    "hyper-v-network-elevation-deadline-exceeded",
    "hyper-v-network-elevation-protocol-invalid",
    "hyper-v-network-elevation-relay-failed",
    "hyper-v-network-elevation-request-failed",
    TERMINATION_UNCONFIRMED_CODE,
    "hyper-v-network-elevation-scope-closed",
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
};

export type HyperVElevatedNetworkRelaySpawnRequest = {
    readonly executable: string;
    readonly sessionBootstrap: string;
    readonly deadlineUnixMilliseconds: number;
    readonly onBeforeElevation: () => void;
};

export type HyperVElevatedNetworkRelaySpawn = (
    request: HyperVElevatedNetworkRelaySpawnRequest,
) => HyperVElevatedNetworkRelayProcess | Promise<HyperVElevatedNetworkRelayProcess>;

export type WithElevatedHyperVNetworkExecutorOptions = {
    readonly executable: string;
    readonly deadlineUnixMilliseconds: number;
    readonly signal?: AbortSignal;
    readonly onBeforeElevation?: () => void;
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

function compressedPowerShellLoader(source: string): string {
    const compressed = gzipSync(Buffer.from(source, "utf8"), { level: 9 }).toString("base64");
    return [
        `$B='${compressed}'`,
        "$M=[IO.MemoryStream]::new(,[Convert]::FromBase64String($B))",
        "$G=[IO.Compression.GzipStream]::new($M,[IO.Compression.CompressionMode]::Decompress)",
        "$R=[IO.StreamReader]::new($G,[Text.UTF8Encoding]::new($false))",
        "& ([ScriptBlock]::Create($R.ReadToEnd()))",
    ].join(";");
}

function elevatedChildSource(pipeName: string, nonce: string, deadlineUnixMilliseconds: number): string {
    return [
        "$ErrorActionPreference='Stop'",
        `$P='${pipeName}'`,
        `$N='${nonce}'`,
        `$D=[long]${deadlineUnixMilliseconds}`,
        "$Q=$null;$W=$null;$R=$null;$K=$null;$KT=$null",
        "try{",
        "$X=$D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();if($X-le 0){throw 'deadline'}",
        "$S=(Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        "$Z=[int][Math]::Min([long][int]::MaxValue,[Math]::Max([long]1,$X))",
        "$T=\"Start-Sleep -Milliseconds $Z;`$X=Get-Process -Id $PID -ErrorAction SilentlyContinue;if(`$X-and `$X.StartTime.ToUniversalTime().Ticks-eq $S){Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue}\"",
        "$K=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($T)))) -WindowStyle Hidden -PassThru -ErrorAction Stop",
        "$KT=$K.StartTime.ToUniversalTime().Ticks",
        "$Q=[IO.Pipes.NamedPipeClientStream]::new('.',$P,[IO.Pipes.PipeDirection]::InOut)",
        "$Q.Connect([int][Math]::Min([long]120000,[Math]::Max([long]1,$X)))",
        "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true)",
        "$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
        "$A=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$J=[ordered]@{nonce=$N;pid=$PID;startTicks=$S;administrator=[bool]$A}|ConvertTo-Json -Compress",
        "$W.WriteLine('AUTH:'+([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($J))));$W.Flush()",
        "if(-not $A){throw 'administrator'}",
        "$L=$R.ReadLine();if(-not $L-or $L.Length-gt 131072-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'bootstrap'}",
        "$C=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($L))",
        "$R.Dispose();$W.Dispose();[Console]::SetIn([IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true));[Console]::SetOut([IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true));[Console]::Out.AutoFlush=$true",
        "& ([ScriptBlock]::Create($C))",
        "}finally{try{$Q.Dispose()}catch{};if($K-and $KT){$Y=Get-Process -Id $K.Id -ErrorAction SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $KT){Stop-Process -Id $K.Id -Force -ErrorAction SilentlyContinue}}}",
    ].join(";");
}

function relayProgress(stage: HyperVElevatedNetworkRelayProgressStage): string {
    return `Send-Progress '${stage}'`;
}

// This process remains medium-integrity. It owns the administrator-only pipe, performs exactly one
// ShellExecute/RunAs transition, and synchronously forwards the existing one-in-flight session
// frames. The elevated child still runs the correlated session bootstrap, so no Hyper-V operation
// logic is duplicated here and redirected-stdin EOF is not a transport completion signal.
export const HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP = [
    "$ErrorActionPreference='Stop'",
    "$F=$null;$P=$null;$C=$null;$CS=$null;$Q=$null;$R=$null;$W=$null;$Z=$null;$G=$null;$CL=$false",
    "function Send-Failure([string]$Code){[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:'+$Code);[Console]::Out.Flush()}",
    `function Send-Progress([string]$Stage){try{[Console]::Out.WriteLine('${ELEVATION_PROGRESS_PREFIX}'+$Z+':'+$Stage);[Console]::Out.Flush()}catch{}}`,
    "try{",
    "$L=[Console]::In.ReadLine();if(-not $L-or $L.Length-gt 349528-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}",
    "$E=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($L))|ConvertFrom-Json -ErrorAction Stop",
    "$P=[string]$E.pipeName;$N=[string]$E.nonce;$Z=[string]$E.terminalToken;$X=[string]$E.executable;$D=[long]$E.deadlineUnixMilliseconds;$I=[string]$E.childEncoded;$B=[string]$E.sessionBootstrapEncoded",
    String.raw`if($P-notmatch '^ccc-hyper-v-network-[a-f0-9]{32}$'-or $N-notmatch '^[a-f0-9]{64}$'-or $Z-notmatch '^[a-f0-9]{64}$'-or $X-notmatch '^[A-Za-z]:\\[^\x00-\x1f]{1,1024}\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$'-or $I.Length-gt 8000-or $I-notmatch '^[A-Za-z0-9+/]+={0,2}$'-or $B.Length-gt 131072-or $B-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}`,
    "if($D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-le 0){throw 'deadline'}",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CccHvPipe{[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool GetNamedPipeClientProcessId(IntPtr h,out uint p);}'",
    "$S=[IO.Pipes.PipeSecurity]::new();$A=[Security.Principal.SecurityIdentifier]'S-1-5-32-544';$S.SetAccessRule([IO.Pipes.PipeAccessRule]::new($A,[IO.Pipes.PipeAccessRights]::ReadWrite,[Security.AccessControl.AccessControlType]::Allow))",
    "$Q=[IO.Pipes.NamedPipeServerStream]::new($P,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$S)",
    `[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_REQUEST');[Console]::Out.Flush();if([Console]::In.ReadLine()-cne 'CCC_HYPER_V_ELEVATED_NETWORK_APPROVE'){throw 'request'};${relayProgress("approval-received")}`,
    "$H=$Q.BeginWaitForConnection($null,$null)",
    `try{$C=Start-Process -FilePath $X -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$I) -WindowStyle Hidden -PassThru -ErrorAction Stop}catch{if($_.Exception-is [ComponentModel.Win32Exception]-and $_.Exception.NativeErrorCode-eq 1223){throw 'cancelled'};throw 'launch'};${relayProgress("runas-returned")}`,
    `$CS=$C.StartTime.ToUniversalTime().Ticks;$M=[int][Math]::Min([long]120000,[Math]::Max([long]1,$D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));if(-not $H.AsyncWaitHandle.WaitOne($M)){throw 'handshake'};$Q.EndWaitForConnection($H);${relayProgress("pipe-connected")}`,
    "[uint32]$CP=0;if(-not [CccHvPipe]::GetNamedPipeClientProcessId($Q.SafePipeHandle.DangerousGetHandle(),[ref]$CP)-or $CP-ne [uint32]$C.Id){throw 'authentication'}",
    "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true);$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
    "$AL=$R.ReadLine();if(-not $AL-or $AL.Length-gt 4096-or -not $AL.StartsWith('AUTH:')){throw 'authentication'};$AJ=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AL.Substring(5)))|ConvertFrom-Json -ErrorAction Stop",
    `if([string]$AJ.nonce-cne $N-or [uint32]$AJ.pid-ne [uint32]$C.Id-or [long]$AJ.startTicks-ne [long]$CS){throw 'authentication'};if(-not [bool]$AJ.administrator){throw 'administrator'};${relayProgress("child-authenticated")}`,
    `$W.WriteLine($B);$W.Flush();${relayProgress("session-bootstrap-sent")};[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY');[Console]::Out.Flush();${relayProgress("relay-ready")}`,
    `$L=[Console]::In.ReadLine();if(-not $L-or $L.Length-gt ${MAX_RELAY_LINE_BYTES}-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'};$W.WriteLine($L);$W.Flush();${relayProgress("operation-asset-forwarded")};$V=$R.ReadLine();if($V-cne '${HYPER_V_WINDOWS_SESSION_READY_MARKER}'){throw 'protocol'};${relayProgress("child-ready")};[Console]::Out.WriteLine($V);[Console]::Out.Flush()`,
    `while($true){$L=[Console]::In.ReadLine();if($null-eq $L){throw 'input'};if($L.Length-gt ${MAX_RELAY_LINE_BYTES}){throw 'protocol'};$K='${ELEVATION_CLOSE_PREFIX}'+$Z+':';if($L.StartsWith($K)){${relayProgress("close-received")};$V=$L.Substring($K.Length);[long]$G=0;if($V-notmatch '^[0-9]{13}$'-or -not [long]::TryParse($V,[ref]$G)-or $G-gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS}){throw 'protocol'};$W.WriteLine('${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}');$W.Flush();${relayProgress("child-close-forwarded")};$CL=$true;break};if(-not $L.StartsWith('${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}')){throw 'protocol'};$W.WriteLine($L);$W.Flush();${relayProgress("request-forwarded")};$V=$R.ReadLine();if($null-eq $V-or $V.Length-gt ${MAX_RELAY_LINE_BYTES}-or -not $V.StartsWith('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}')){throw 'protocol'};${relayProgress("response-received")};[Console]::Out.WriteLine($V);[Console]::Out.Flush();${relayProgress("response-forwarded")}}`,
    `$M=[int][Math]::Min([long]${ELEVATED_CHILD_GRACEFUL_EXIT_MILLISECONDS},[Math]::Max([long]0,$G-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-${ELEVATED_CHILD_FORCE_CONFIRMATION_RESERVE_MILLISECONDS}));if($M-gt 0 -and $C -and $CS){try{[void]$C.WaitForExit($M)}catch{}};${relayProgress("child-graceful-wait-finished")}`,
    "}catch{$M=[string]$_.Exception.Message;$F=switch($M){'cancelled'{'hyper-v-network-elevation-cancelled'}'launch'{'hyper-v-network-elevation-launch-failed'}'handshake'{'hyper-v-network-elevation-handshake-timeout'}'authentication'{'hyper-v-network-elevation-authentication-failed'}'administrator'{'hyper-v-network-elevation-administrator-required'}'deadline'{'hyper-v-network-elevation-deadline-exceeded'}'request'{'hyper-v-network-elevation-request-failed'}'protocol'{'hyper-v-network-elevation-protocol-invalid'}default{'hyper-v-network-elevation-relay-failed'}}",
    `}finally{${relayProgress("finalizer-entered")};try{$R.Dispose()}catch{};try{$W.Dispose()}catch{};try{$Q.Dispose()}catch{};${relayProgress("named-pipe-disposed")};if($C-and $CS){$Y=Get-Process -Id $C.Id -ErrorAction SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){${relayProgress("child-force-attempted")};Stop-Process -Id $C.Id -Force -ErrorAction SilentlyContinue;$M=if($G){[int][Math]::Max([long]0,$G-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}else{${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS}};if($M-gt 0){[void]$Y.WaitForExit($M)};${relayProgress("child-force-wait-finished")}};$Y=Get-Process -Id $C.Id -ErrorAction SilentlyContinue;${relayProgress("child-reinspection-finished")};if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){$F='hyper-v-network-elevation-termination-unconfirmed'}}}`,
    "if($F){Send-Failure $F}",
    `if($CL-and $Z-match '^[a-f0-9]{64}$'){${relayProgress("terminal-write-entered")};[Console]::Out.WriteLine('${ELEVATION_TERMINAL_PREFIX}'+$Z);[Console]::Out.Flush()}`,
    "if($F-or -not $CL){exit 1}",
].join(";");

function parseElevationFailure(line: string): HyperVElevatedNetworkErrorCode | null {
    if (!line.startsWith(ELEVATION_FAILURE_PREFIX)) return null;
    const code = line.slice(ELEVATION_FAILURE_PREFIX.length);
    return isElevationErrorCode(code) ? code : "hyper-v-network-elevation-protocol-invalid";
}

function defaultSpawnRelay(request: HyperVElevatedNetworkRelaySpawnRequest): HyperVElevatedNetworkRelayProcess {
    const canonicalExecutable = canonicalWindowsPowerShellPath();
    if (!canonicalExecutable
        || !validSystemPowerShellPath(request.executable)
        || canonicalExecutable.toLocaleLowerCase("en-US") !== request.executable.toLocaleLowerCase("en-US")) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-launch-failed");
    }
    const pipeName = `ccc-hyper-v-network-${randomBytes(16).toString("hex")}`;
    const nonce = randomBytes(32).toString("hex");
    const terminalToken = randomBytes(32).toString("hex");
    const childLoader = compressedPowerShellLoader(elevatedChildSource(
        pipeName,
        nonce,
        request.deadlineUnixMilliseconds,
    ));
    const childEncoded = encodedPowerShell(childLoader);
    if (childEncoded.length > 8_000) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-protocol-invalid");
    }
    const launchEnvelope = Buffer.from(JSON.stringify({
        pipeName,
        nonce,
        terminalToken,
        executable: request.executable,
        deadlineUnixMilliseconds: request.deadlineUnixMilliseconds,
        childEncoded,
        sessionBootstrapEncoded: Buffer.from(request.sessionBootstrap, "utf8").toString("base64"),
    }), "utf8").toString("base64");
    if (Buffer.byteLength(launchEnvelope, "utf8") > MAX_LAUNCH_ENVELOPE_BYTES) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-protocol-invalid");
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
    let forcedKill: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let closeWriteTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveCompletion = (_result: HyperVElevatedNetworkRelayCompletion) => undefined as void;
    const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
        resolveCompletion = resolve;
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
    const finish = (reason: HyperVWindowsSessionErrorCode) => {
        if (exited) return;
        exited = true;
        exitReason = reason;
        if (forcedKill) clearTimeout(forcedKill);
        if (closeWriteTimer) clearTimeout(closeWriteTimer);
        failQueued(new Error(reason));
        for (const listener of [...exitListeners]) listener(reason);
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
        if (forcedKill) return;
        forcedKill = setTimeout(() => {
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
        }, RELAY_FORCE_GRACE_MILLISECONDS);
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
        closeWriteTimer = setTimeout(() => {
            closeWriteTimer = null;
            if (exited || killed) return;
            closeWriteStatus = "timed-out";
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-input-write",
                replaceFailure: false,
            });
            rejectSessionOutput();
        }, RELAY_CLOSE_WRITE_GRACE_MILLISECONDS);
        closeWriteTimer.unref?.();
        const finalizationDeadline = Date.now() + ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS;
        closeWriteStatus = "pending";
        child.stdin?.write(`${ELEVATION_CLOSE_PREFIX}${terminalToken}:${finalizationDeadline}\n`, (error) => {
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
        if (!relayReady || exited) return;
        for (const entry of queued.splice(0)) {
            if (entry.line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) requestAttempted = true;
            child.stdin?.write(`${entry.line}\n`, (error) => {
                entry.settled?.(error ?? undefined);
                if (error) finish("hyper-v-windows-session-stdin-failed");
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
            if (observedFailure === TERMINATION_UNCONFIRMED_CODE) {
                recordTerminationFailure({
                    kind: "termination",
                    stage: "elevated-child",
                    replaceFailure: true,
                });
            } else {
                recordPrimaryFailure(observedFailure);
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
                request.onBeforeElevation();
                child.stdin?.write(`${ELEVATION_APPROVAL}\n`);
            } catch {
                recordPrimaryFailure("hyper-v-network-elevation-request-failed");
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
            if (!handleControlLine(line) && relayReady && !sessionOutputRejected) {
                for (const listener of [...lineListeners]) listener(line);
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
        recordPrimaryFailureIfAbsent("hyper-v-network-elevation-launch-failed");
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
            recordPrimaryFailureIfAbsent("hyper-v-network-elevation-launch-failed");
            finish("hyper-v-windows-session-stdin-failed");
        }
    });
    deadlineTimer = setTimeout(() => {
        recordPrimaryFailureIfAbsent("hyper-v-network-elevation-deadline-exceeded");
        stop();
    }, Math.max(1, Math.min(2_147_483_647, request.deadlineUnixMilliseconds - Date.now())));
    deadlineTimer.unref?.();
    completion.finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }).catch(() => undefined);

    return {
        completion,
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
            if (exited) queueMicrotask(() => listener(exitReason));
        },
        kill: stop,
    };
}

function boundedElevationCode(error: unknown): HyperVElevatedNetworkErrorCode {
    return error instanceof HyperVElevatedNetworkSessionError
        ? error.code
        : "hyper-v-network-elevation-launch-failed";
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
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const status = Reflect.get(value, "status");
    return (status === null || Number.isInteger(status))
        && typeof Reflect.get(value, "stdout") === "string"
        && Reflect.get(value, "error") === code;
}

export async function withElevatedHyperVNetworkExecutor<T>(
    options: WithElevatedHyperVNetworkExecutorOptions,
    operation: (executor: HyperVWindowsExecutor) => T | Promise<T>,
): Promise<T> {
    if (!Number.isSafeInteger(options.deadlineUnixMilliseconds)
        || options.deadlineUnixMilliseconds <= Date.now()) {
        throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
    }
    const spawnRelay = options.spawnRelay ?? defaultSpawnRelay;
    let active = true;
    let relay: HyperVElevatedNetworkRelayProcess | null = null;
    let relayCompletion: HyperVElevatedNetworkRelayProcess["completion"] | null = null;
    let relayFailureCode: (() => HyperVElevatedNetworkErrorCode | null) | null = null;
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
    const session = createHyperVWindowsPowerShellSession({
        maximumStarts: 1,
        ...(options.operationAsset ? { operationAsset: options.operationAsset } : {}),
        spawn: async (sessionBootstrap) => {
            if (relay) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-relay-failed");
            try {
                const spawnedRelay = await spawnRelay({
                    executable: options.executable,
                    sessionBootstrap,
                    deadlineUnixMilliseconds: options.deadlineUnixMilliseconds,
                    onBeforeElevation: options.onBeforeElevation ?? (() => undefined),
                });
                relay = spawnedRelay;
                relayCompletion = spawnedRelay.completion;
                relayFailureCode = spawnedRelay.failureCode;
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
                return spawnedRelay;
            } catch (error) {
                startupFailure = boundedElevationCode(error);
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
            const remaining = options.deadlineUnixMilliseconds - Date.now();
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
            const observedSessionError = boundedSessionError(result.error);
            if (observedSessionError && lastSessionError === null) {
                lastOperation = request.operation;
                lastSessionError = observedSessionError;
            }
            const code = startupFailure ?? relayFailureCode?.() ?? null;
            return result.error && code ? { ...result, error: code } : result;
        },
    };

    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | null = null;
    try {
        outcome = { ok: true, value: await operation(scopedExecutor) };
    } catch (error) {
        outcome = { ok: false, error };
    } finally {
        active = false;
        activeExecutionsAtClose = activeExecutions;
        pendingExecutionsAtClose = session.outstanding().pendingRequests;
        session.close();
    }

    let completionError: HyperVElevatedNetworkNonTerminationErrorCode | null = null;
    let terminationStage: HyperVElevatedNetworkTerminationStage | null = null;
    const completionPromise = currentRelayCompletion();
    if (completionPromise) {
        const completion = await Promise.race([
            completionPromise,
            new Promise<null>((resolve) => {
                const timer = setTimeout(() => resolve(null), RELAY_COMPLETION_GRACE_MILLISECONDS);
                timer.unref?.();
            }),
        ]);
        if (completion === null) {
            terminationStage = safeRelayTerminationStage(currentRelayTerminationStage())
                ?? "relay-completion-timeout";
        } else {
            if (completion.errorCode === TERMINATION_UNCONFIRMED_CODE) {
                terminationStage = completion.terminationStage;
            } else {
                completionError = completion.errorCode;
            }
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
    if (completionError && !reportsRelayCompletionFailure(outcome.value, completionError)) {
        throw new HyperVElevatedNetworkSessionError(completionError);
    }
    return outcome.value;
}
