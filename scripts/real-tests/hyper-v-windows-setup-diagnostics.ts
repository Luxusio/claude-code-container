import { randomBytes } from "crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hyperVVmName } from "../../src/host-control/hyper-v/index.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOGS = 4;
const MAX_LINES_PER_LOG = 120;
const MAX_LINE_CHARS = 768;
const MOUNT_MAX_ATTEMPTS = 10;
// A flat 1000 ms between attempts gave the VHD handle 10 seconds total to be released after the
// disk was detached, which a real host exhausted on every attempt. Backing off to a 15 s ceiling
// spends longer without unbounding the diagnostic.
const MOUNT_BACKOFF_CEILING_MS = 15000;
// The retry budget must stay a known share of the process budget below. Unbounded, ten backed-off
// attempts sleep 90 s, leaving under 30 s for module autoload, the identity reads, a Stop-VM on a
// VM that is hung — the exact case being diagnosed — the detach, and the mount latency itself.
// Overrunning kills the process, and then the attempts/category/message this whole change exists to
// capture are never read: the result degrades to hyper-v-setup-diagnostics-process-timeout.
const MOUNT_RETRY_BUDGET_MS = 60000;
const MOUNT_MESSAGE_MAX_CHARS = 200;
const DIAGNOSTICS_PROCESS_TIMEOUT_MS = 180000;
const MOUNT_ERROR_CATEGORIES = new Set([
    "NotSpecified", "OpenError", "CloseError", "DeviceError", "DeadlockDetected",
    "InvalidArgument", "InvalidData", "InvalidOperation", "InvalidResult", "InvalidType",
    "MetadataError", "NotImplemented", "NotInstalled", "ObjectNotFound", "OperationStopped",
    "OperationTimeout", "SyntaxError", "ParserError", "PermissionDenied", "ResourceBusy",
    "ResourceExists", "ResourceUnavailable", "ReadError", "WriteError", "FromStdErr",
    "SecurityError", "ProtocolError", "ConnectionError", "AuthenticationError", "LimitsExceeded",
    "QuotaExceeded", "NotEnabled",
]);
const LATEST_RELATIVE_PATH = "results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json";
const ALLOWED_LOG_PATHS = new Set([
    "Windows\\Panther\\setupact.log",
    "Windows\\Panther\\setuperr.log",
    "Windows\\Panther\\UnattendGC\\setupact.log",
    "Windows\\Panther\\UnattendGC\\setuperr.log",
]);
const SAFE_CODES = new Set([
    "hyper-v-setup-diagnostics-host-not-windows",
    "hyper-v-setup-diagnostics-identity-invalid",
    "hyper-v-setup-diagnostics-powershell-unavailable",
    "hyper-v-setup-diagnostics-process-timeout",
    "hyper-v-setup-diagnostics-process-failed",
    "hyper-v-setup-diagnostics-cleanup-failed",
    "hyper-v-setup-diagnostics-output-invalid",
    "hyper-v-setup-diagnostics-vm-not-exact",
    "hyper-v-setup-diagnostics-disk-not-exact",
    "hyper-v-setup-diagnostics-stop-failed",
    "hyper-v-setup-diagnostics-detach-failed",
    "hyper-v-setup-diagnostics-mount-failed",
    "hyper-v-setup-diagnostics-disk-observation-failed",
    "hyper-v-setup-diagnostics-volume-not-exact",
    "hyper-v-setup-diagnostics-read-failed",
    "hyper-v-setup-diagnostics-dismount-failed",
    "hyper-v-setup-diagnostics-artifact-publish-failed",
]);

type SpawnResult = {
    status?: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: NodeJS.ErrnoException;
};

export type HyperVWindowsSetupDiagnosticsResult =
    | { ok: true; latestRelativePath: string; latestPath: string; timestampedPath: string }
    | { ok: false; code: string };

export type HyperVWindowsSetupDiagnosticsInput = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmId: string;
    powershell?: string;
    platform?: NodeJS.Platform | string;
    outputRoot?: string;
    now?: () => Date;
    spawnSyncImpl?: (command: string, args: string[], options: Record<string, unknown>) => SpawnResult;
};

function psQuote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function encodedPowerShell(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function ownershipMarker(input: Pick<HyperVWindowsSetupDiagnosticsInput, "ownerId" | "deviceId" | "incarnationId">): string {
    return `ccc-device-lab:${input.ownerId}:${input.deviceId}:${input.incarnationId}`;
}

function preflightProgram(vmName: string, vmId: string, marker: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        "$Stage = 'hyper-v-setup-diagnostics-vm-not-exact'",
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-vm-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-not-exact'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $DiskPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [IO.Path]::IsPathRooted($DiskPath) -or [IO.Path]::GetExtension($DiskPath) -notin @('.vhd','.vhdx')) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  [ordered]@{ ok = $true; diskPath = $DiskPath } | ConvertTo-Json -Compress",
        "} catch {",
        "  $Message = [string]$_.Exception.Message",
        "  if ($Message -match '^hyper-v-setup-diagnostics-[a-z-]+$') { $Code = $Message } else { $Code = $Stage }",
        "  [ordered]@{ ok = $false; code = $Code } | ConvertTo-Json -Compress",
        "}",
    ].join("\n");
}

function diagnosticsProgram(vmName: string, vmId: string, marker: string, expectedDiskPath: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$ExpectedDisk = ${psQuote(expectedDiskPath)}`,
        "$Stage = 'hyper-v-setup-diagnostics-vm-not-exact'",
        "$Mounted = $false",
        "$DiskPath = $null",
        "$Result = $null",
        "$MountAttempts = 0",
        "$MountCategory = $null",
        "$MountHResult = $null",
        "$MountMessage = $null",
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-vm-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-not-exact'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $DiskPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [string]::Equals($DiskPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-stop-failed'",
        "  if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop }",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker -or $Vm.State -ne 'Off') { throw 'hyper-v-setup-diagnostics-stop-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-detach-failed'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  $DetachPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [string]::Equals($DetachPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  Remove-VMHardDiskDrive -VMHardDiskDrive $Drives[0] -ErrorAction Stop",
        "  $RemainingDrives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($RemainingDrives.Count -ne 0) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-mount-failed'",
        "  $MountedImage = $null",
        `  $MountDeadline = [DateTime]::UtcNow.AddMilliseconds(${MOUNT_RETRY_BUDGET_MS})`,
        `  for ($Attempt = 1; $Attempt -le ${MOUNT_MAX_ATTEMPTS}; $Attempt++) {`,
        "    $MountAttempts = $Attempt",
        "    try {",
        "      $MountedImage = Mount-VHD -Path $DiskPath -ReadOnly -PassThru -ErrorAction Stop",
        "      $Mounted = $true",
        "      break",
        "    } catch {",
        "      $MountCategory = [string]$_.CategoryInfo.Category",
        "      $MountHResult = [Math]::Abs([long]$_.Exception.HResult)",
        // The category and HRESULT alone came back as NotSpecified/0x80131500 on a real host, which
        // names no cause. The message is host text; it is bounded here and redacted on the reading
        // side by mountFailureMessage, which is the only path by which this field reaches output.
        //
        // Neither redaction NOR truncation is attempted here — both fragment. A user-profile rule at
        // this stage stopped at the first space, so `C:\Users\Kyeong Jae\disk.vhdx` arrived at the
        // reader already split into `[user-profile] Jae\disk.vhdx`, a fragment with no drive letter
        // for the reader's whole-path rule to match. A length cap does the same thing for a longer
        // message: cutting at 200 chars can land inside the segment after a space and leave `Jae`
        // behind, beside a marker that reads as though redaction had completed.
        //
        // So the stage that redacts is also the stage that bounds. `mountFailureMessage` truncates
        // AFTER redacting, which is the only order that cannot manufacture a fragment. Wire size
        // stays bounded by the MAX_OUTPUT_BYTES check on the whole stdout; a message large enough to
        // breach that fails the diagnostic outright, which loses the diagnosis but leaks nothing.
        "      $MountMessage = [string]$_.Exception.Message",
        // The deadline, not the attempt count, is what keeps the retry budget inside the process
        // budget: a slow mount failure costs wall-clock the sleeps do not account for. The sleep is
        // included in the comparison, so a check passing just under the deadline cannot then add a
        // full ceiling on top of it — the budget is the stated one, not the stated one plus 15 s.
        `      $MountSleep = [Math]::Min(${MOUNT_BACKOFF_CEILING_MS}, 1000 * [Math]::Pow(2, $Attempt - 1))`,
        `      if ($Attempt -lt ${MOUNT_MAX_ATTEMPTS} -and [DateTime]::UtcNow.AddMilliseconds($MountSleep) -lt $MountDeadline) { Start-Sleep -Milliseconds $MountSleep }`,
        `      elseif ($Attempt -lt ${MOUNT_MAX_ATTEMPTS}) { break }`,
        "    }",
        "  }",
        "  if (-not $Mounted) { throw 'hyper-v-setup-diagnostics-mount-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-observation-failed'",
        "  $Disk = $MountedImage | Get-Disk -ErrorAction Stop",
        "  $Stage = 'hyper-v-setup-diagnostics-volume-not-exact'",
        "  $Roots = @()",
        "  foreach ($Partition in @(Get-Partition -DiskNumber $Disk.Number -ErrorAction Stop)) {",
        "    $Volume = $Partition | Get-Volume -ErrorAction SilentlyContinue",
        "    if ($null -ne $Volume -and $null -ne $Volume.DriveLetter) {",
        "      $Root = ([string]$Volume.DriveLetter) + ':\\'",
        "      if (Test-Path -LiteralPath ($Root + 'Windows\\Panther') -PathType Container) { $Roots += $Root }",
        "    }",
        "  }",
        "  if ($Roots.Count -ne 1) { throw 'hyper-v-setup-diagnostics-volume-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-read-failed'",
        "  $RelativePaths = @('Windows\\Panther\\setupact.log','Windows\\Panther\\setuperr.log','Windows\\Panther\\UnattendGC\\setupact.log','Windows\\Panther\\UnattendGC\\setuperr.log')",
        "  $Logs = @()",
        "  foreach ($RelativePath in $RelativePaths) {",
        "    $LogPath = Join-Path $Roots[0] $RelativePath",
        "    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { continue }",
        "    $Lines = @(Get-Content -LiteralPath $LogPath -Tail 600 -ErrorAction Stop | Where-Object { $_ -match '(?i)unattend|oobe|shell.setup|error|fail|0x[0-9a-f]+' } | Select-Object -Last 120)",
        "    $SafeLines = @()",
        "    foreach ($LineValue in $Lines) {",
        "      $Line = [string]$LineValue",
        "      $Line = [regex]::Replace($Line, '(?is)<Value>.*?</Value>', '<Value>[redacted]</Value>')",
        "      $Line = [regex]::Replace($Line, '(?i)(password|token|secret)\\s*[:=].*$', '$1=[redacted]')",
        "      $Line = [regex]::Replace($Line, '(?i)[A-Z]:\\\\Users\\\\[^\\\\\\s]+', '[user-profile]')",
        "      if ($Line.Length -gt 768) { $Line = $Line.Substring(0, 768) + '[truncated]' }",
        "      $SafeLines += $Line",
        "    }",
        "    $Logs += [ordered]@{ path = $RelativePath; lines = $SafeLines }",
        "  }",
        "  $Result = [ordered]@{ ok = $true; logs = $Logs }",
        "} catch {",
        "  $Message = [string]$_.Exception.Message",
        "  if ($Message -eq 'hyper-v-setup-diagnostics-mount-failed' -and $MountAttempts -gt 0) {",
        "    $Result = [ordered]@{ ok = $false; code = $Message; mount = [ordered]@{ attempts = $MountAttempts; category = $MountCategory; hresult = $MountHResult; message = $MountMessage } }",
        "  } else {",
        "    if ($Message -match '^hyper-v-setup-diagnostics-[a-z-]+$') { $Code = $Message } else { $Code = $Stage }",
        "    $Result = [ordered]@{ ok = $false; code = $Code }",
        "  }",
        "} finally {",
        "  if ($Mounted -and $DiskPath) {",
        "    try { Dismount-VHD -Path $DiskPath -ErrorAction Stop } catch { $Result = [ordered]@{ ok = $false; code = 'hyper-v-setup-diagnostics-dismount-failed' } }",
        "  }",
        "}",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ].join("\n");
}

function cleanupProgram(vmName: string, vmId: string, marker: string, expectedDiskPath: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$ExpectedDisk = ${psQuote(expectedDiskPath)}`,
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -gt 1) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  if ($Drives.Count -eq 1) {",
        "    if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "    $AttachedPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "    if (-not [string]::Equals($AttachedPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "    [ordered]@{ ok = $true; detached = $false } | ConvertTo-Json -Compress",
        "    exit 0",
        "  }",
        "  $DiskImages = @(Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction Stop)",
        "  if ($DiskImages.Count -ne 1) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  if ([bool]$DiskImages[0].Attached) { Dismount-VHD -Path $ExpectedDisk -ErrorAction Stop }",
        "  $VerifiedImages = @(Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction Stop)",
        "  if ($VerifiedImages.Count -ne 1 -or [bool]$VerifiedImages[0].Attached) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  [ordered]@{ ok = $true; detached = $true } | ConvertTo-Json -Compress",
        "} catch {",
        "  [ordered]@{ ok = $false; code = 'hyper-v-setup-diagnostics-cleanup-failed' } | ConvertTo-Json -Compress",
        "}",
    ].join("\n");
}

function failure(code: string): HyperVWindowsSetupDiagnosticsResult {
    return { ok: false, code: SAFE_CODES.has(code) ? code : "hyper-v-setup-diagnostics-output-invalid" };
}

function mountFailureCode(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const attempts = (value as { attempts?: unknown }).attempts;
    const category = (value as { category?: unknown }).category;
    const hresult = (value as { hresult?: unknown }).hresult;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > MOUNT_MAX_ATTEMPTS) return null;
    if (typeof category !== "string" || !MOUNT_ERROR_CATEGORIES.has(category)) return null;
    if (typeof hresult !== "number" || !Number.isSafeInteger(hresult) || hresult < 0 || hresult > 2147483648) return null;
    // Additive: the bracketed a/c/h shape stays exactly as before so existing parsing keeps working,
    // and the message — the only field that ever names the actual cause — is appended when the host
    // supplied one that survives redaction to printable single-line text.
    //
    // `m` is always last and its value may contain `,` and `=`, so read it greedily to the closing
    // `]` rather than splitting the bracket body on `,`.
    const message = mountFailureMessage((value as { message?: unknown }).message);
    return `hyper-v-setup-diagnostics-mount-failed[a=${attempts},c=${category},h=${hresult}${message ? `,m=${message}` : ""}]`;
}

// A drive-lettered or UNC path, continuing across spaces while the run of following segments still
// reaches another separator. Stopping at the first space left a fragment — a surname, for
// `C:\Users\Kyeong Jae\x.vhdx` — beside a marker that read as if redaction had completed, which is
// worse than no marker at all. Looking past a whole run rather than one segment is what carries
// `C:\Program Files\Virtual Hard Disks\x.vhdx`, the default Hyper-V VHD location, which a
// one-segment form truncated to `(host-path) Hard Disks\x.vhdx`. Prose after an unquoted path is
// not swallowed, because it never reaches another separator.
//
// `;` is excluded alongside the quotes so trailing message punctuation is not swallowed into the
// path and can still be mapped to `,` below.
const HOST_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'";]*(?:(?:\s[^\s'";]*)*?\s[^\s'";]*\\[^\s'";]*)*/g;

function mountFailureMessage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // Newlines collapse FIRST. `redactLine`'s secret rule is anchored with `$` and no `m` flag, so
    // on a multi-line message it only ever fired on the last line — a secret on any earlier line
    // passed through verbatim.
    //
    // Host paths go next, BEFORE `redactLine`: its user-profile rule stops at the first space, so
    // letting it run first would consume `C:\Users\Kyeong` and leave `Jae\...` with no drive letter
    // for the broader rule to match. Dropping the path whole costs little — the mount target is the
    // device's own disk, which the caller supplied and already knows.
    //
    // Brackets become parentheses rather than being dropped: the code itself is bracketed, so a
    // nested `[` would break its shape, but the redaction markers stay legible as `(redacted)`.
    // `;` becomes `,` for the same reason one level up — the e2e failure line is `;`-separated.
    const collapsed = String(value).replace(/[\r\n\t]+/g, " ").replace(HOST_PATH_PATTERN, "[host-path]");
    const redacted = redactLine(collapsed)
        ?.replace(/;/g, ",")
        .replace(/\[/g, "(")
        .replace(/\]/g, ")")
        .trim()
        .slice(0, MOUNT_MESSAGE_MAX_CHARS);
    return redacted || null;
}

function redactLine(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return value
        .replace(/<Value>[\s\S]*?<\/Value>/gi, "<Value>[redacted]</Value>")
        .replace(/(password|token|secret)\s*[:=].*$/gi, "$1=[redacted]")
        .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "[user-profile]")
        .slice(0, MAX_LINE_CHARS);
}

function validatedLogs(value: unknown): Array<{ path: string; lines: string[] }> | null {
    if (!Array.isArray(value) || value.length > MAX_LOGS) return null;
    const logs: Array<{ path: string; lines: string[] }> = [];
    for (const candidate of value) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
        const path = (candidate as { path?: unknown }).path;
        const lines = (candidate as { lines?: unknown }).lines;
        if (typeof path !== "string" || !ALLOWED_LOG_PATHS.has(path) || !Array.isArray(lines) || lines.length > MAX_LINES_PER_LOG) return null;
        const safeLines: string[] = [];
        for (const line of lines) {
            const redacted = redactLine(line);
            if (redacted === null) return null;
            safeLines.push(redacted);
        }
        logs.push({ path, lines: safeLines });
    }
    return logs;
}

function writeExclusiveThenRename(target: string, content: string): void {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
        writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        const stat = lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(content)) throw new Error("invalid diagnostic artifact");
        renameSync(temporary, target);
        renamed = true;
    } finally {
        if (!renamed) rmSync(temporary, { force: true });
    }
}

function recoverDiagnosticMount(input: HyperVWindowsSetupDiagnosticsInput, vmName: string, marker: string, diskPath: string): boolean {
    let cleanup: SpawnResult;
    try {
        cleanup = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(cleanupProgram(vmName, input.vmId, marker, diskPath)),
        ], {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
    } catch {
        return false;
    }
    if (cleanup.error || cleanup.status !== 0) return false;
    try {
        const parsed = JSON.parse(String(cleanup.stdout || "").trim());
        return parsed?.ok === true && typeof parsed.detached === "boolean";
    } catch {
        return false;
    }
}

export function captureHyperVWindowsSetupDiagnostics(input: HyperVWindowsSetupDiagnosticsInput): HyperVWindowsSetupDiagnosticsResult {
    if ((input.platform || process.platform) !== "win32") return failure("hyper-v-setup-diagnostics-host-not-windows");
    if (!String(input.powershell || "").trim()) return failure("hyper-v-setup-diagnostics-powershell-unavailable");
    let vmName: string;
    let marker: string;
    try {
        vmName = hyperVVmName(input.ownerId, input.deviceId, input.incarnationId);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.vmId)) throw new Error("invalid vm id");
        marker = ownershipMarker(input);
    } catch {
        return failure("hyper-v-setup-diagnostics-identity-invalid");
    }
    let preflight: SpawnResult;
    try {
        preflight = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(preflightProgram(vmName, input.vmId, marker)),
        ], {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
    } catch {
        return failure("hyper-v-setup-diagnostics-process-failed");
    }
    if (preflight.error?.code === "ETIMEDOUT") return failure("hyper-v-setup-diagnostics-process-timeout");
    if (preflight.error || preflight.status !== 0) return failure("hyper-v-setup-diagnostics-process-failed");
    let preflightResult: any;
    try {
        const text = String(preflight.stdout || "").trim();
        if (!text || Buffer.byteLength(text) > 64 * 1024) return failure("hyper-v-setup-diagnostics-output-invalid");
        preflightResult = JSON.parse(text);
    } catch {
        return failure("hyper-v-setup-diagnostics-output-invalid");
    }
    if (preflightResult?.ok === false) return failure(typeof preflightResult.code === "string" ? preflightResult.code : "");
    const diskPath = typeof preflightResult?.diskPath === "string" ? preflightResult.diskPath : "";
    if (preflightResult?.ok !== true || diskPath.length < 4 || diskPath.length > 4096 || diskPath.includes("\0") || !/^[A-Za-z]:\\/.test(diskPath) || !/\.vhdx?$/i.test(diskPath)) {
        return failure("hyper-v-setup-diagnostics-output-invalid");
    }

    let spawned: SpawnResult;
    try {
        spawned = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(diagnosticsProgram(vmName, input.vmId, marker, diskPath)),
        ], {
            encoding: "utf8",
            timeout: DIAGNOSTICS_PROCESS_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
        });
    } catch {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-failed" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (spawned.error?.code === "ETIMEDOUT") {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-timeout" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (spawned.error || spawned.status !== 0) {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-failed" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    const stdout = String(spawned.stdout || "").trim();
    if (!stdout || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (parsed?.ok === false) {
        const code = typeof parsed.code === "string" ? parsed.code : "";
        if (code === "hyper-v-setup-diagnostics-mount-failed") {
            const observedCode = mountFailureCode(parsed.mount);
            if (!recoverDiagnosticMount(input, vmName, marker, diskPath)) return failure("hyper-v-setup-diagnostics-cleanup-failed");
            return observedCode ? { ok: false, code: observedCode } : failure("");
        }
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? code : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (parsed?.ok !== true) return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    const logs = validatedLogs(parsed.logs);
    if (!logs) return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");

    const outputRoot = input.outputRoot || join(repoRoot, "results", "device-lab-real");
    const generatedAt = (input.now || (() => new Date()))().toISOString();
    const timestamp = generatedAt.replace(/[:.]/g, "-");
    const timestampedPath = join(outputRoot, `hyper-v-windows-setup-diagnostics-${timestamp}.json`);
    const latestPath = join(outputRoot, "hyper-v-windows-setup-diagnostics-latest.json");
    const content = `${JSON.stringify({ version: 1, generatedAt, logs }, null, 2)}\n`;
    try {
        mkdirSync(outputRoot, { recursive: true });
        writeExclusiveThenRename(timestampedPath, content);
        writeExclusiveThenRename(latestPath, content);
    } catch {
        return failure("hyper-v-setup-diagnostics-artifact-publish-failed");
    }
    return { ok: true, latestRelativePath: LATEST_RELATIVE_PATH, latestPath, timestampedPath };
}
