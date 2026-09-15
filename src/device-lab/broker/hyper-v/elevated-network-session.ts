import { spawn } from "child_process";
import { gzipSync } from "zlib";
import { randomBytes } from "crypto";

import {
    canonicalWindowsPowerShellPath,
    hiddenWindowsPowerShellArgs,
} from "../../../windows-system-powershell.js";
import {
    createHyperVWindowsPowerShellSession,
    HYPER_V_WINDOWS_SESSION_CLOSE_MARKER,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsPowerShellOperationAsset,
    type HyperVWindowsSessionErrorCode,
    type HyperVWindowsSessionProcess,
} from "../../../hyper-v-windows/index.js";

const ELEVATION_REQUEST_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_REQUEST";
const ELEVATION_READY_MARKER = "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY";
const ELEVATION_FAILURE_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:";
const ELEVATION_TERMINAL_PREFIX = "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:";
const ELEVATION_APPROVAL = "CCC_HYPER_V_ELEVATED_NETWORK_APPROVE";
const MAX_RELAY_LINE_BYTES = 256 * 1024;
const MAX_LAUNCH_ENVELOPE_BYTES = 256 * 1024;
const ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS = 5_000;
const RELAY_FORCE_GRACE_MILLISECONDS = 10_000;
const RELAY_COMPLETION_GRACE_MILLISECONDS = 15_000;
const TERMINATION_UNCONFIRMED_CODE = "hyper-v-network-elevation-termination-unconfirmed";

export const HYPER_V_ELEVATED_NETWORK_ERROR_CODES = [
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
] as const;

export type HyperVElevatedNetworkErrorCode = typeof HYPER_V_ELEVATED_NETWORK_ERROR_CODES[number];
type HyperVElevatedNetworkNonTerminationErrorCode = Exclude<
    HyperVElevatedNetworkErrorCode,
    typeof TERMINATION_UNCONFIRMED_CODE
>;

export const HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES = [
    "elevated-child",
    "relay-terminal-ack-missing",
    "relay-terminal-ack-invalid",
    "relay-process-exit-timeout",
    "relay-output-drain-timeout",
    "relay-input-write",
    "relay-completion-timeout",
] as const;

export type HyperVElevatedNetworkTerminationStage =
    typeof HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES[number];
type HyperVElevatedNetworkRelayTerminationStage = Exclude<
    HyperVElevatedNetworkTerminationStage,
    "relay-completion-timeout"
>;

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

    constructor(code: HyperVElevatedNetworkNonTerminationErrorCode);
    constructor(
        code: typeof TERMINATION_UNCONFIRMED_CODE,
        terminationStage: HyperVElevatedNetworkTerminationStage,
    );
    constructor(
        code: HyperVElevatedNetworkErrorCode,
        terminationStage: HyperVElevatedNetworkTerminationStage | null = null,
    ) {
        super(code);
        this.name = "HyperVElevatedNetworkSessionError";
        this.code = code;
        this.terminationStage = terminationStage;
    }
}

export function getHyperVElevatedNetworkTerminationStage(
    error: unknown,
): HyperVElevatedNetworkTerminationStage | null {
    if (!(error instanceof HyperVElevatedNetworkSessionError)) return null;
    if (error.code !== TERMINATION_UNCONFIRMED_CODE) return null;
    const stage = error.terminationStage;
    return stage !== null && HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES.includes(stage)
        ? stage
        : null;
}

export type HyperVElevatedNetworkRelayProcess = HyperVWindowsSessionProcess & {
    readonly close: () => void;
    readonly completion: Promise<HyperVElevatedNetworkRelayCompletion>;
    readonly failureCode: () => HyperVElevatedNetworkErrorCode | null;
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

// This process remains medium-integrity. It owns the administrator-only pipe and performs exactly
// one ShellExecute/RunAs transition; the elevated child then runs the existing correlated session
// bootstrap, so no Hyper-V operation logic is duplicated here.
export const HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP = [
    "$ErrorActionPreference='Stop'",
    "$F=$null;$P=$null;$C=$null;$CS=$null;$Q=$null;$R=$null;$W=$null;$Z=$null",
    "function Send-Failure([string]$Code){[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:'+$Code);[Console]::Out.Flush()}",
    "try{",
    "$L=[Console]::In.ReadLine();if(-not $L-or $L.Length-gt 349528-or $L-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}",
    "$E=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($L))|ConvertFrom-Json -ErrorAction Stop",
    "$P=[string]$E.pipeName;$N=[string]$E.nonce;$Z=[string]$E.terminalToken;$X=[string]$E.executable;$D=[long]$E.deadlineUnixMilliseconds;$I=[string]$E.childEncoded;$B=[string]$E.sessionBootstrapEncoded",
    String.raw`if($P-notmatch '^ccc-hyper-v-network-[a-f0-9]{32}$'-or $N-notmatch '^[a-f0-9]{64}$'-or $Z-notmatch '^[a-f0-9]{64}$'-or $X-notmatch '^[A-Za-z]:\\[^\x00-\x1f]{1,1024}\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$'-or $I.Length-gt 8000-or $I-notmatch '^[A-Za-z0-9+/]+={0,2}$'-or $B.Length-gt 131072-or $B-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'protocol'}`,
    "if($D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-le 0){throw 'deadline'}",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CccHvPipe{[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool GetNamedPipeClientProcessId(IntPtr h,out uint p);}'",
    "$S=[IO.Pipes.PipeSecurity]::new();$A=[Security.Principal.SecurityIdentifier]'S-1-5-32-544';$S.SetAccessRule([IO.Pipes.PipeAccessRule]::new($A,[IO.Pipes.PipeAccessRights]::ReadWrite,[Security.AccessControl.AccessControlType]::Allow))",
    "$Q=[IO.Pipes.NamedPipeServerStream]::new($P,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$S)",
    "[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_REQUEST');[Console]::Out.Flush();if([Console]::In.ReadLine()-cne 'CCC_HYPER_V_ELEVATED_NETWORK_APPROVE'){throw 'request'}",
    "$H=$Q.BeginWaitForConnection($null,$null)",
    "try{$C=Start-Process -FilePath $X -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$I) -WindowStyle Hidden -PassThru -ErrorAction Stop}catch{if($_.Exception-is [ComponentModel.Win32Exception]-and $_.Exception.NativeErrorCode-eq 1223){throw 'cancelled'};throw 'launch'}",
    "$CS=$C.StartTime.ToUniversalTime().Ticks;$M=[int][Math]::Min([long]120000,[Math]::Max([long]1,$D-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));if(-not $H.AsyncWaitHandle.WaitOne($M)){throw 'handshake'};$Q.EndWaitForConnection($H)",
    "[uint32]$CP=0;if(-not [CccHvPipe]::GetNamedPipeClientProcessId($Q.SafePipeHandle.DangerousGetHandle(),[ref]$CP)-or $CP-ne [uint32]$C.Id){throw 'authentication'}",
    "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true);$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
    "$AL=$R.ReadLine();if(-not $AL-or $AL.Length-gt 4096-or -not $AL.StartsWith('AUTH:')){throw 'authentication'};$AJ=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AL.Substring(5)))|ConvertFrom-Json -ErrorAction Stop",
    "if([string]$AJ.nonce-cne $N-or [uint32]$AJ.pid-ne [uint32]$C.Id-or [long]$AJ.startTicks-ne [long]$CS){throw 'authentication'};if(-not [bool]$AJ.administrator){throw 'administrator'}",
    "$W.WriteLine($B);$W.Flush();$R.Dispose();$W.Dispose();[Console]::Out.WriteLine('CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY');[Console]::Out.Flush()",
    "$U=[Console]::OpenStandardInput();$O=[Console]::OpenStandardOutput();$TC=$U.CopyToAsync($Q);$TP=$Q.CopyToAsync($O);$Done=[Threading.Tasks.Task]::WhenAny(@($TC,$TP)).GetAwaiter().GetResult()",
    "if($Done-eq $TP){$TP.GetAwaiter().GetResult()}else{$TC.GetAwaiter().GetResult();$Q.Flush()}",
    "}catch{$M=[string]$_.Exception.Message;$F=switch($M){'cancelled'{'hyper-v-network-elevation-cancelled'}'launch'{'hyper-v-network-elevation-launch-failed'}'handshake'{'hyper-v-network-elevation-handshake-timeout'}'authentication'{'hyper-v-network-elevation-authentication-failed'}'administrator'{'hyper-v-network-elevation-administrator-required'}'deadline'{'hyper-v-network-elevation-deadline-exceeded'}'request'{'hyper-v-network-elevation-request-failed'}'protocol'{'hyper-v-network-elevation-protocol-invalid'}default{'hyper-v-network-elevation-relay-failed'}};Send-Failure $F",
    `}finally{try{$Q.Dispose()}catch{};if($C-and $CS){$Y=Get-Process -Id $C.Id -ErrorAction SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){Stop-Process -Id $C.Id -Force -ErrorAction SilentlyContinue;$Y.WaitForExit(${ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS})};$Y=Get-Process -Id $C.Id -ErrorAction SilentlyContinue;if($Y-and $Y.StartTime.ToUniversalTime().Ticks-eq $CS){Send-Failure 'hyper-v-network-elevation-termination-unconfirmed';$F='termination'}}}`,
    `if($Z-match '^[a-f0-9]{64}$'){[Console]::Out.WriteLine('${ELEVATION_TERMINAL_PREFIX}'+$Z);[Console]::Out.Flush()}`,
    "if($F){exit 1}",
].join(";");

function parseElevationFailure(line: string): HyperVElevatedNetworkErrorCode | null {
    if (!line.startsWith(ELEVATION_FAILURE_PREFIX)) return null;
    const code = line.slice(ELEVATION_FAILURE_PREFIX.length);
    return HYPER_V_ELEVATED_NETWORK_ERROR_CODES.find((candidate) => candidate === code)
        ?? "hyper-v-network-elevation-protocol-invalid";
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
    let forcedKill: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveCompletion = (_result: HyperVElevatedNetworkRelayCompletion) => undefined as void;
    const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
        resolveCompletion = resolve;
    });

    const failQueued = (error: Error) => {
        for (const entry of queued.splice(0)) entry.settled?.(error);
    };
    const finish = (reason: HyperVWindowsSessionErrorCode) => {
        if (exited) return;
        exited = true;
        exitReason = reason;
        if (forcedKill) clearTimeout(forcedKill);
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
    const finishAfterTerminalExit = () => {
        if (terminalAcknowledged && relayProcessExited && relayStdoutDrained) finish(normalExitReason());
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
            child.stdin?.end();
            if (relayProcessExited) finish(normalExitReason());
            else child.kill();
        }, RELAY_FORCE_GRACE_MILLISECONDS);
        forcedKill.unref?.();
    };
    const stop = () => {
        if (killed) return;
        killed = true;
        child.stdin?.end();
        armForcedKill();
    };
    const close = () => {
        if (closing || killed || exited) return;
        closing = true;
        if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
        }
        child.stdin?.write(`${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}\n`, (error) => {
            if (!error || exited) return;
            recordTerminationFailure({
                kind: "termination",
                stage: "relay-input-write",
                replaceFailure: false,
            });
            stop();
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
                stop();
                return true;
            }
            elevationRequested = true;
            try {
                request.onBeforeElevation();
                child.stdin?.write(`${ELEVATION_APPROVAL}\n`);
            } catch {
                recordPrimaryFailure("hyper-v-network-elevation-request-failed");
                child.stdin?.end();
            }
            return true;
        }
        if (line === ELEVATION_READY_MARKER) {
            if (!elevationRequested || relayReady) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                stop();
                return true;
            }
            relayReady = true;
            flushQueued();
            return true;
        }
        if (line.startsWith(ELEVATION_TERMINAL_PREFIX)) {
            if (terminalAcknowledged || line !== `${ELEVATION_TERMINAL_PREFIX}${terminalToken}`) {
                recordTerminationFailure({
                    kind: "termination",
                    stage: "relay-terminal-ack-invalid",
                    replaceFailure: false,
                });
                stop();
                return true;
            }
            terminalAcknowledged = true;
            child.stdin?.end();
            finishAfterTerminalExit();
            return true;
        }
        return false;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        let index = buffered.indexOf("\n");
        while (index >= 0) {
            const line = buffered.slice(0, index).replace(/\r$/, "");
            buffered = buffered.slice(index + 1);
            if (Buffer.byteLength(line, "utf8") > MAX_RELAY_LINE_BYTES) {
                recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
                stop();
                return;
            }
            if (!handleControlLine(line) && relayReady) {
                for (const listener of [...lineListeners]) listener(line);
            }
            index = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered, "utf8") > MAX_RELAY_LINE_BYTES) {
            recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
            stop();
        }
    });
    child.stdout?.once("end", () => {
        relayStdoutDrained = true;
        if (buffered.length > 0) {
            recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
        }
        finishAfterTerminalExit();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_RELAY_LINE_BYTES) {
            recordPrimaryFailure("hyper-v-network-elevation-protocol-invalid");
            stop();
        }
    });
    child.once("error", () => {
        recordPrimaryFailureIfAbsent("hyper-v-network-elevation-launch-failed");
        finish(requestAttempted ? "hyper-v-windows-session-exited" : "hyper-v-windows-session-spawn-failed");
    });
    child.once("exit", () => {
        relayProcessExited = true;
        if (!relayReady) recordPrimaryFailureIfAbsent("hyper-v-network-elevation-relay-failed");
        if (forceExpired) finish(normalExitReason());
        else finishAfterTerminalExit();
    });
    child.once("close", () => {
        if (exited) return;
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
        if (relayProcessExited) finish(normalExitReason());
        else stop();
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
    const currentRelayCompletion = () => relayCompletion;
    let startupFailure: HyperVElevatedNetworkErrorCode | null = null;
    const session = createHyperVWindowsPowerShellSession({
        maximumStarts: 1,
        ...(options.operationAsset ? { operationAsset: options.operationAsset } : {}),
        spawn: async (sessionBootstrap) => {
            if (relay) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-relay-failed");
            try {
                relay = await spawnRelay({
                    executable: options.executable,
                    sessionBootstrap,
                    deadlineUnixMilliseconds: options.deadlineUnixMilliseconds,
                    onBeforeElevation: options.onBeforeElevation ?? (() => undefined),
                });
                relayCompletion = relay.completion;
                relayFailureCode = relay.failureCode;
                return relay;
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
            if (options.signal?.aborted || context.signal?.aborted) {
                return failedExecution("hyper-v-network-elevation-cancelled");
            }
            const remaining = options.deadlineUnixMilliseconds - Date.now();
            if (remaining <= 0) return failedExecution("hyper-v-network-elevation-deadline-exceeded");
            const result = await session.execute(request, {
                ...context,
                timeoutMilliseconds: Math.min(context.timeoutMilliseconds, remaining),
                ...(options.signal ? { signal: options.signal } : {}),
            });
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
        session.close();
    }

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
        terminationStage = completion === null
            ? "relay-completion-timeout"
            : completion.errorCode === TERMINATION_UNCONFIRMED_CODE
                ? completion.terminationStage
                : null;
    }
    if (terminationStage) {
        throw new HyperVElevatedNetworkSessionError(TERMINATION_UNCONFIRMED_CODE, terminationStage);
    }
    if (!outcome) throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-relay-failed");
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
}
