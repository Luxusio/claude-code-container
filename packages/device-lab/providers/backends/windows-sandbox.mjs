import { createDirectRecording } from "../adapters/direct-recording.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createWindowsSandboxCreate } from "../application/lifecycle/windows-sandbox-create.mjs";
import { createWindowsSandboxStop, createWindowsSandboxLifecycle } from "../application/lifecycle/windows-sandbox-stop.mjs";
import { createDesktopControlTransfer } from "../application/desktop-control-transfer.mjs";
import { createDesktopDeviceAccess } from "../application/desktop-device-access.mjs";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, hostname, uptime } from "os";
import { basename, dirname, join } from "path";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalInputPath, validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { claimWindowsDevice, findWindowsDevice, readWindowsDevices, transitionWindowsDevice, updateWindowsDevice } from "../state/windows-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { readWindowsSandboxLockStateFile, validateWindowsSandboxLock } from "../state/ownership-state.mjs";
import { copyFileAtomically, withSharedMutationLock, writeFileAtomically, writeJsonFileAtomically } from "../state/shared-mutation-lock.mjs";
import { assertDeviceLabPathWithinRoot, readDeviceLabBinaryFile, readDeviceLabTextFile } from "../state/state-file.mjs";
import { withTargetStatus } from "../status.mjs";

const WINDOWS_SANDBOX_EXEC_TIMEOUT_MS = 30000;
const WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS = 180000;
const WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS = 30000;
const WINDOWS_SANDBOX_CONFIG_LIMIT_BYTES = 256 * 1024;
const WINDOWS_SANDBOX_HELPER_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const WINDOWS_SANDBOX_SCREENSHOT_LIMIT_BYTES = 32 * 1024 * 1024;
const WINDOWS_SANDBOX_DIAGNOSTIC_FILE_LIMIT_BYTES = 4096;
const WINDOWS_SANDBOX_MINIMIZE_RESULT_LIMIT_BYTES = 64;
const WINDOWS_SANDBOX_UPLOAD_LIMIT_BYTES = 16 * 1024 * 1024;
const WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const WINDOWS_SANDBOX_HELPER_TIMEOUT_MS = 30000;
export const WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS = 300000;

export function windowsSandboxHelperTimeoutMs(value, fallback = WINDOWS_SANDBOX_HELPER_TIMEOUT_MS) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(requested)));
}

export function windowsDiscovery() { return deviceObservation.discovery(); }

function isGuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function collectGuids(value, output = new Set()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
            output.add(match[0].toLowerCase());
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectGuids(item, output);
        return output;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectGuids(item, output);
    }
    return output;
}

export function windowsSandboxSessionIdsFromListOutput(stdout) {
    try {
        return [...collectGuids(JSON.parse(stdout))];
    } catch {
        return [...collectGuids(stdout)];
    }
}

export function windowsSandboxRuntimeDelta(previousIds = [], currentIds = []) {
    const previous = new Set(previousIds.map((id) => String(id).toLowerCase()));
    return currentIds.map((id) => String(id).toLowerCase()).filter((id) => !previous.has(id));
}



function windowsSingletonLockPath() {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.json");
}

function windowsSingletonMutationLockPath() {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.mutation.lock");
}

function currentBootId() {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}

function sameBootIdentity(left, right) {
    if (left === right) return true;
    const leftMatch = typeof left === "string" ? left.match(/^(.*):(\d+)$/) : null;
    const rightMatch = typeof right === "string" ? right.match(/^(.*):(\d+)$/) : null;
    return Boolean(leftMatch && rightMatch
        && leftMatch[1] === rightMatch[1]
        && Math.abs(Number(leftMatch[2]) - Number(rightMatch[2])) <= 5);
}

function staleWindowsSingletonLock(lock) {
    return Boolean(lock?.bootId && !sameBootIdentity(lock.bootId, currentBootId()));
}

function sameWindowsSingletonOwner(lock, device, sandboxId) {
    return lock?.ownerId === ownerId()
        && lock?.deviceId === device.id
        && (!lock?.sandboxId || !sandboxId || lock.sandboxId === sandboxId);
}

function readWindowsSingletonLock() {
    return readWindowsSandboxLockStateFile(windowsSingletonLockPath());
}

function claimWindowsSingleton(device, sandboxId, claimId = randomUUID()) {
    return withSharedMutationLock(windowsSingletonMutationLockPath(), () => {
        const lockPath = windowsSingletonLockPath();
        const existing = readWindowsSingletonLock();
        if (staleWindowsSingletonLock(existing)) {
            rmSync(lockPath, { force: true });
        }
        const current = staleWindowsSingletonLock(existing) ? null : existing;
        const lock = {
            provider: "windows-sandbox",
            host: hostname(),
            bootId: currentBootId(),
            ownerId: ownerId(),
            deviceId: device.id,
            sandboxId,
            claimId,
            pid: process.pid,
            acquiredAt: sameWindowsSingletonOwner(current, device, sandboxId) && current?.acquiredAt ? current.acquiredAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        if (!current) {
            validateWindowsSandboxLock(lock);
            writeJsonFileAtomically(lockPath, lock);
            return { ok: true, lock };
        }
        if (current.claimId === claimId && sameWindowsSingletonOwner(current, device, sandboxId)) {
            return { ok: true, lock: current, reused: true };
        }
        return {
            ok: false, busy: current,
            error: `Windows Sandbox is already claimed on this host by owner ${current?.ownerId || "unknown"} device ${current?.deviceId || "unknown"}. Windows Sandbox supports one running instance per host.`,
        };
    });
}

function releaseWindowsSingleton(device, claimId = device?.singletonClaimId) {
    return withSharedMutationLock(windowsSingletonMutationLockPath(), () => {
        const existing = readWindowsSingletonLock();
        if (!claimId || existing?.claimId !== claimId || !sameWindowsSingletonOwner(existing, device, device?.sandboxId)) return false;
        rmSync(windowsSingletonLockPath(), { force: true });
        return true;
    });
}

function updateWindowsSingletonRuntimeId(device, claimedSandboxId, runtimeSandboxId, claimId = device?.singletonClaimId) {
    return withSharedMutationLock(windowsSingletonMutationLockPath(), () => {
        const existing = readWindowsSingletonLock();
        if (!claimId || existing?.claimId !== claimId || !sameWindowsSingletonOwner(existing, device, claimedSandboxId)) return false;
        const updated = {
            ...existing,
            sandboxId: runtimeSandboxId,
            requestedSandboxId: claimedSandboxId,
            updatedAt: new Date().toISOString(),
        };
        validateWindowsSandboxLock(updated);
        writeJsonFileAtomically(windowsSingletonLockPath(), updated);
        return true;
    });
}

function windowsSingletonGenerationMatches(device, claimId = device?.singletonClaimId) {
    if (!claimId) return false;
    return withSharedMutationLock(windowsSingletonMutationLockPath(), () => {
        const existing = readWindowsSingletonLock();
        return existing?.claimId === claimId && sameWindowsSingletonOwner(existing, device, device?.sandboxId);
    });
}

export function windowsBackend() { return deviceObservation.backend(); }



function windowsDeviceId(name) {
    return `windows-${slug(name)}`;
}

function windowsOwnerRoot() {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "windows");
}

function windowsScratchDir(device) {
    return join(windowsOwnerRoot(), device.id);
}

function windowsToolsDir(device) {
    return join(windowsScratchDir(device), "tools");
}

function windowsRecordingDir(device) {
    return join(windowsScratchDir(device), "recordings");
}

function windowsRecordingLocalPath(device) {
    return join(windowsRecordingDir(device), `recording-${Date.now()}.zip`);
}

function wsbConfigPath(device) {
    return join(windowsScratchDir(device), `${device.id}.wsb`);
}

function removeWindowsScratch(device) {
    rmSync(windowsScratchDir(device), { recursive: true, force: true });
}

function windowsHelperMetadata(device) {
    const scratchDir = windowsScratchDir(device);
    const toolsDir = windowsToolsDir(device);
    const inboxDir = join(scratchDir, "inbox");
    const outboxDir = join(scratchDir, "outbox");
    const uploadsDir = join(scratchDir, "uploads");
    const downloadsDir = join(scratchDir, "downloads");
    return {
        scratchDir,
        toolsDir,
        inboxDir,
        outboxDir,
        uploadsDir,
        downloadsDir,
        hostHelperScript: join(toolsDir, "ccc-guest-helper.ps1"),
        hostBootstrapScript: join(toolsDir, "ccc-guest-helper-bootstrap.ps1"),
        hostBootstrapLauncherScript: join(toolsDir, "ccc-guest-helper-bootstrap.vbs"),
        guestScratchDir: "C:\\ccc\\scratch",
        guestToolsDir: "C:\\ccc\\tools",
        guestBootstrapScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.ps1",
        guestBootstrapLauncherScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.vbs",
        guestHelperScript: "C:\\ccc\\scratch\\ccc-guest-helper.ps1",
        guestInboxDir: "C:\\ccc\\scratch\\inbox",
        guestOutboxDir: "C:\\ccc\\scratch\\outbox",
        guestUploadsDir: "C:\\ccc\\scratch\\uploads",
        guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
        readyMarkerPath: join(downloadsDir, "ccc-guest-helper.ready.txt"),
        bootstrapReadyMarkerPath: join(downloadsDir, "ccc-guest-helper-bootstrap.ready.txt"),
        bootstrapPhasePath: join(downloadsDir, "ccc-guest-helper-bootstrap-phase.json"),
        bootstrapStdoutPath: join(downloadsDir, "ccc-guest-helper-bootstrap.stdout.txt"),
        bootstrapStderrPath: join(downloadsDir, "ccc-guest-helper-bootstrap.stderr.txt"),
        helperStdoutPath: join(downloadsDir, "ccc-guest-helper.stdout.txt"),
        helperStderrPath: join(downloadsDir, "ccc-guest-helper.stderr.txt"),
        helperHeartbeatPath: join(downloadsDir, "ccc-guest-helper.heartbeat.txt"),
        minimizeWatchdogCancelPath: join(downloadsDir, "ccc-minimize-watchdog.cancel"),
        minimizeWatchdogResultPath: join(downloadsDir, "ccc-minimize-watchdog.result.txt"),
        status: "file-channel",
        requiredFor: ["device_drag", "device_focus_window", "device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_accessibility_snapshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
}

/**
 * @param {string|undefined} remotePath
 * @param {ReturnType<typeof ensureHelperWorkspace>} helper
 * @param {string} label
 * @returns {ReturnType<typeof validateGuestPath>}
 */
function validateWindowsGuestTransferPath(remotePath, helper, label) {
    const remotePolicy = validateGuestPath(remotePath, { label, platform: "windows" });
    if (!remotePolicy.ok) return remotePolicy;
    const lower = remotePolicy.path.toLowerCase();
    const deniedPrefixes = [
        helper.guestScratchDir,
        helper.guestToolsDir,
        helper.guestInboxDir,
        helper.guestOutboxDir,
        helper.guestUploadsDir,
        helper.guestDownloadsDir,
    ].map((entry) => entry.toLowerCase().replace(/\\+$/, ""));
    if (deniedPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}\\`))) {
        return { ok: false, error: `${label}-helper-path-rejected`, path: remotePolicy.path, message: `${label}-helper-path-rejected: ${remotePolicy.path}` };
    }
    return remotePolicy;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function windowsHelperMutexScriptLines(variable, pathExpression, role) {
    return [
        `$${variable}Hash = [Security.Cryptography.SHA256]::Create()`,
        "try {",
        `  $${variable}Key = [BitConverter]::ToString($${variable}Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath(${pathExpression}).ToUpperInvariant()))).Replace('-', '')`,
        `} finally { $${variable}Hash.Dispose() }`,
        `$${variable} = [Threading.Mutex]::new($false, ('Global\\CccDeviceLab-${role}-' + $${variable}Key))`,
        `$${variable}Owned = $false`,
    ];
}

export function windowsHelperScript(helper) {
    return [
        "param([string]$OnceRequestPath = '')",
        "$ErrorActionPreference = 'Stop'",
        `$Inbox = '${helper.guestInboxDir}'`,
        `$Outbox = '${helper.guestOutboxDir}'`,
        `$Uploads = '${helper.guestUploadsDir}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$Recordings = @{}",
        "New-Item -ItemType Directory -Force -Path $Inbox,$Outbox,$Uploads,$Downloads | Out-Null",
        "$HeartbeatPath = Join-Path $Downloads 'ccc-guest-helper.heartbeat.txt'",
        "function Write-CccHeartbeat {",
        "    try {",
        "      $Names = @(Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)",
        "      Set-Content -Path $HeartbeatPath -Value @(",
        "        ('heartbeat ' + (Get-Date).ToString('o')),",
        "        ('inbox-exists ' + (Test-Path $Inbox)),",
        "        ('outbox-exists ' + (Test-Path $Outbox)),",
        "        ('inbox-count ' + $Names.Count),",
        "        ('inbox-files ' + (($Names | Select-Object -First 20) -join ', '))",
        "      ) -Encoding UTF8",
        "    } catch {",
        "      Set-Content -Path $HeartbeatPath -Value ('heartbeat-error ' + $_.Exception.Message) -Encoding UTF8",
        "    }",
        "}",
        "function Write-CccJson {",
        "    param([string]$Path, [object]$Value)",
        "    $Json = $Value | ConvertTo-Json -Depth 32",
        "    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
        "    [System.IO.File]::WriteAllText($Path, $Json, $Utf8NoBom)",
        "}",
        "function Compress-CccDirectory {",
        "    param([string]$SourcePath, [string]$DestinationPath)",
        "    Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "    if (Test-Path -LiteralPath $DestinationPath) { Remove-Item -Force -LiteralPath $DestinationPath }",
        "    [System.IO.Compression.ZipFile]::CreateFromDirectory($SourcePath, $DestinationPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
        "}",
        "function Invoke-CccRequest {",
        "    param([string]$RequestPath)",
        "    $Request = $null",
        "    try {",
        "      if (-not (Test-Path -LiteralPath $RequestPath)) { return }",
        "      $Request = Get-Content -Raw -LiteralPath $RequestPath | ConvertFrom-Json",
        "      $Response = [ordered]@{ id = $Request.id; ok = $true; type = $Request.type }",
        "      switch ($Request.type) {",
        "        'exec' {",
        "          $CommandText = [string]$Request.command",
        "          $TimeoutSec = if ($Request.commandTimeoutSec) { [Math]::Max(1, [int]$Request.commandTimeoutSec) } else { 30 }",
        "          $Job = Start-Job -ArgumentList $CommandText -ScriptBlock {",
        "            param($CommandText)",
        "            try {",
        "              $global:LASTEXITCODE = 0",
        "              $Output = Invoke-Expression $CommandText 2>&1",
        "              $Status = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }",
        "              [pscustomobject][ordered]@{ stdout = (($Output | Out-String) -replace \"`r?`n$\", ''); stderr = ''; status = $Status }",
        "            } catch {",
        "              [pscustomobject][ordered]@{ stdout = ''; stderr = $_.Exception.Message; status = 1 }",
        "            }",
        "          }",
        "          $Completed = Wait-Job -Job $Job -Timeout $TimeoutSec",
        "          if ($null -eq $Completed) {",
        "            Stop-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null",
        "            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null",
        "            $Response.stdout = ''",
        "            $Response.stderr = \"Command timed out after $TimeoutSec seconds\"",
        "            $Response.status = 124",
        "          } else {",
        "            $JobResult = Receive-Job -Job $Job -ErrorAction SilentlyContinue | Select-Object -First 1",
        "            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null",
        "            $Response.stdout = if ($JobResult.stdout) { [string]$JobResult.stdout } else { '' }",
        "            $Response.stderr = if ($JobResult.stderr) { [string]$JobResult.stderr } else { '' }",
        "            $Response.status = if ($null -ne $JobResult.status) { [int]$JobResult.status } else { 0 }",
        "          }",
        "        }",
        "        'screenshot' {",
        "          $OutputPath = Join-Path $Downloads ($Request.id + '.png')",
        "          $Job = Start-Job -ArgumentList $OutputPath -ScriptBlock {",
        "            param($OutputPath)",
        "            try {",
        "              Add-Type -AssemblyName System.Windows.Forms",
        "              Add-Type -AssemblyName System.Drawing",
        "              $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "              if ($Bounds.Width -le 0 -or $Bounds.Height -le 0) { throw 'No interactive display is available' }",
        "              $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height",
        "              $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)",
        "              try {",
        "                $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)",
        "                $Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "              } finally { $Graphics.Dispose(); $Bitmap.Dispose() }",
        "              [pscustomobject]@{ ok = $true; error = '' }",
        "            } catch { [pscustomobject]@{ ok = $false; error = $_.Exception.Message } }",
        "          }",
        "          $Completed = Wait-Job -Job $Job -Timeout 30",
        "          if ($null -eq $Completed) {",
        "            Stop-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null",
        "            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null",
        "            throw 'Screenshot timed out after 30 seconds'",
        "          }",
        "          $JobResult = Receive-Job -Job $Job -ErrorAction SilentlyContinue | Select-Object -First 1",
        "          Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null",
        "          if (-not $JobResult.ok) { throw ('Screenshot failed: ' + [string]$JobResult.error) }",
        "          $Response.imagePath = $OutputPath",
        "        }",
        "        'click' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }",
        "          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)",
        "          $Button = if ($Request.button) { [string]$Request.button } else { 'left' }",
        "          $Down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 }",
        "          $Up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 }",
        "          [CccMouse]::mouse_event($Down, 0, 0, 0, 0); Start-Sleep -Milliseconds 50; [CccMouse]::mouse_event($Up, 0, 0, 0, 0)",
        "          $Response.clicked = @{ x = [int]$Request.x; y = [int]$Request.y; button = $Button }",
        "        }",
        "        'double_click' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }",
        "          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)",
        "          $Button = if ($Request.button) { [string]$Request.button } else { 'left' }",
        "          $Down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 }",
        "          $Up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 }",
        "          1..2 | ForEach-Object { [CccMouse]::mouse_event($Down, 0, 0, 0, 0); Start-Sleep -Milliseconds 50; [CccMouse]::mouse_event($Up, 0, 0, 0, 0); Start-Sleep -Milliseconds 80 }",
        "          $Response.doubleClicked = @{ x = [int]$Request.x; y = [int]$Request.y; button = $Button }",
        "        }",
        "        'key' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          [System.Windows.Forms.SendKeys]::SendWait([string]$Request.keys)",
        "          $Response.key = @{ key = $Request.key; keys = $Request.keys }",
        "        }",
        "        'type' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          [System.Windows.Forms.SendKeys]::SendWait([string]$Request.keys)",
        "          $Response.typed = @{ text = $Request.text; keys = $Request.keys }",
        "        }",
        "        'scroll' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }",
        "          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)",
        "          $Amount = if ($Request.amount) { [int]$Request.amount } else { 1 }",
        "          $Direction = if ($Request.direction) { [string]$Request.direction } else { 'down' }",
        "          $WheelData = 120 * $Amount",
        "          if ($Direction -eq 'down' -or $Direction -eq 'right') { $WheelData = -1 * $WheelData }",
        "          $WheelFlag = if ($Direction -eq 'left' -or $Direction -eq 'right') { 0x01000 } else { 0x0800 }",
        "          [CccMouse]::mouse_event($WheelFlag, 0, 0, $WheelData, 0)",
        "          $Response.scrolled = @{ x = [int]$Request.x; y = [int]$Request.y; direction = $Direction; amount = $Amount }",
        "        }",
        "        'drag' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "          foreach ($Key in @('x1','y1','x2','y2','durationMs')) {",
        "            $Value = $Request.$Key",
        "            if ($null -eq $Value -or $Value -is [string] -or [double]$Value -ne [Math]::Truncate([double]$Value) -or [double]$Value -lt 0 -or [double]$Value -gt 2147483647) { throw 'invalid-drag-arguments' }",
        "          }",
        "          if ($Request.durationMs -lt 1 -or $Request.durationMs -gt 10000) { throw 'invalid-drag-duration' }",
        "          if (-not $Bounds.Contains([int]$Request.x1, [int]$Request.y1) -or -not $Bounds.Contains([int]$Request.x2, [int]$Request.y2)) { throw 'drag-outside-display' }",
        "          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }",
        "          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x1, [int]$Request.y1)",
        "          try {",
        "            [CccMouse]::mouse_event(2, 0, 0, 0, 0)",
        "            for ($Step = 1; $Step -le 20; $Step++) {",
        "              Start-Sleep -Milliseconds ([Math]::Max(1, [int]($Request.durationMs / 20)))",
        "              $X = [int]($Request.x1 + ($Request.x2 - $Request.x1) * $Step / 20)",
        "              $Y = [int]($Request.y1 + ($Request.y2 - $Request.y1) * $Step / 20)",
        "              [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)",
        "            }",
        "          } finally { [CccMouse]::mouse_event(4, 0, 0, 0, 0) }",
        "        }",
        "        'focus_window' {",
        "          if ([string]$Request.handle -notmatch '^[1-9][0-9]{0,18}$') { throw 'invalid-window-handle' }",
        "          if (-not ([System.Management.Automation.PSTypeName]'CccFocus').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccFocus { [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }' }",
        "          $Handle = [IntPtr]([long]$Request.handle)",
        "          if (-not [CccFocus]::IsWindow($Handle)) { throw 'window-not-found' }",
        "          [CccFocus]::ShowWindowAsync($Handle, 9) | Out-Null",
        "          [CccFocus]::SetForegroundWindow($Handle) | Out-Null",
        "          Start-Sleep -Milliseconds 100",
        "          if ([CccFocus]::GetForegroundWindow() -ne $Handle) { throw 'window-focus-denied' }",
        "        }",
        "        'cursor_position' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          if ($null -ne $Request.x -or $null -ne $Request.y) {",
        "            Add-Type -AssemblyName System.Drawing",
        "            foreach ($Key in @('x','y')) {",
        "              $Value = $Request.$Key",
        "              if ($null -eq $Value -or $Value -is [string] -or [double]$Value -ne [Math]::Truncate([double]$Value) -or [double]$Value -lt 0 -or [double]$Value -gt 2147483647) { throw 'invalid-pointer-coordinates' }",
        "            }",
        "            if (-not [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Contains([int]$Request.x, [int]$Request.y)) { throw 'pointer-outside-display' }",
        "            [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)",
        "          }",
        "          $Position = [System.Windows.Forms.Cursor]::Position",
        "          $Response.cursor = @{ x = $Position.X; y = $Position.Y }",
        "        }",
        "        'window_list' {",
        "          $Windows = Get-Process | Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 } | ForEach-Object {",
        "            @{ processId = $_.Id; processName = $_.ProcessName; title = $_.MainWindowTitle; handle = [string]$_.MainWindowHandle }",
        "          }",
        "          $Response.windows = @($Windows)",
        "          $Response.provider = 'windows-process-main-window'",
        "        }",
        "        'accessibility_snapshot' {",
        "          Add-Type -AssemblyName UIAutomationClient",
        "          Add-Type -AssemblyName UIAutomationTypes",
        "          $MaxDepth = if ($Request.maxDepth -ne $null) { [Math]::Max(0, [Math]::Min([int]$Request.maxDepth, 8)) } else { 3 }",
        "          $MaxNodes = if ($Request.maxNodes -ne $null) { [Math]::Max(1, [Math]::Min([int]$Request.maxNodes, 1000)) } else { 200 }",
        "          $script:CccNodeCount = 0",
        "          function Convert-CccAutomationElement {",
        "            param($Element, [int]$Depth)",
        "            if ($null -eq $Element -or $script:CccNodeCount -ge $MaxNodes) { return $null }",
        "            $script:CccNodeCount += 1",
        "            $Rect = $Element.Current.BoundingRectangle",
        "            $Node = [ordered]@{",
        "              name = $Element.Current.Name",
        "              automationId = $Element.Current.AutomationId",
        "              className = $Element.Current.ClassName",
        "              controlType = $Element.Current.ControlType.ProgrammaticName",
        "              processId = $Element.Current.ProcessId",
        "              isEnabled = $Element.Current.IsEnabled",
        "              isOffscreen = $Element.Current.IsOffscreen",
        "              bounds = @{ x = [double]$Rect.X; y = [double]$Rect.Y; width = [double]$Rect.Width; height = [double]$Rect.Height }",
        "              children = @()",
        "            }",
        "            if ($Depth -lt $MaxDepth -and $script:CccNodeCount -lt $MaxNodes) {",
        "              $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
        "              $Child = $Walker.GetFirstChild($Element)",
        "              while ($null -ne $Child -and $script:CccNodeCount -lt $MaxNodes) {",
        "                $ChildNode = Convert-CccAutomationElement $Child ($Depth + 1)",
        "                if ($null -ne $ChildNode) { $Node.children += $ChildNode }",
        "                $Child = $Walker.GetNextSibling($Child)",
        "              }",
        "            }",
        "            return $Node",
        "          }",
        "          $Root = [System.Windows.Automation.AutomationElement]::RootElement",
        "          $Tree = Convert-CccAutomationElement $Root 0",
        "          $Response.accessibility = @{ provider = 'windows-uiautomation'; maxDepth = $MaxDepth; maxNodes = $MaxNodes; nodeCount = $script:CccNodeCount; root = $Tree }",
        "        }",
        "        'upload' {",
        "          Copy-Item -Force -Path $Request.uploadPath -Destination $Request.remotePath",
        "          $Response.uploaded = @{ remotePath = $Request.remotePath }",
        "        }",
        "        'download' {",
        "          $OutputPath = Join-Path $Downloads ($Request.id + '-' + [IO.Path]::GetFileName($Request.remotePath))",
        "          Copy-Item -Force -Path $Request.remotePath -Destination $OutputPath",
        "          $Response.downloadPath = $OutputPath",
        "        }",
        "        'record_start' {",
        "          $SessionId = if ($Request.sessionId) { $Request.sessionId } else { $Request.id }",
        "          if ($Recordings.ContainsKey($SessionId)) { throw \"Recording already active: $SessionId\" }",
        "          $FrameDir = Join-Path $Downloads ($SessionId + '-frames')",
        "          New-Item -ItemType Directory -Force -Path $FrameDir | Out-Null",
        "          $IntervalMs = if ($Request.intervalMs) { [int]$Request.intervalMs } else { 1000 }",
        "          $TimeLimitSec = if ($Request.timeLimitSec) { [int]$Request.timeLimitSec } else { 0 }",
        "          $Job = Start-Job -ArgumentList $FrameDir,$IntervalMs,$TimeLimitSec -ScriptBlock {",
        "            param($FrameDir,$IntervalMs,$TimeLimitSec)",
        "            Add-Type -AssemblyName System.Windows.Forms",
        "            Add-Type -AssemblyName System.Drawing",
        "            $Index = 0",
        "            $StopAt = if ($TimeLimitSec -gt 0) { [DateTime]::UtcNow.AddSeconds($TimeLimitSec) } else { $null }",
        "            while ($true) {",
        "              if ($StopAt -and [DateTime]::UtcNow -ge $StopAt) { break }",
        "              $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "              $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height",
        "              $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)",
        "              $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)",
        "              $FramePath = Join-Path $FrameDir ('frame-{0:D6}.png' -f $Index)",
        "              $Bitmap.Save($FramePath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "              $Graphics.Dispose(); $Bitmap.Dispose()",
        "              $Index += 1",
        "              Start-Sleep -Milliseconds $IntervalMs",
        "            }",
        "          }",
        "          $Recordings[$SessionId] = @{ job = $Job; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; startedAt = (Get-Date).ToString('o') }",
        "          $Response.recording = @{ sessionId = $SessionId; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; provider = 'windows-helper-frame-archive' }",
        "        }",
        "        'record_status' {",
        "          $SessionId = $Request.sessionId",
        "          if ($SessionId -and $Recordings.ContainsKey($SessionId)) {",
        "            $Entry = $Recordings[$SessionId]",
        "            if ($Entry.job.State -eq 'Running') {",
        "              $Response.recording = @{ sessionId = $SessionId; active = $true; state = $Entry.job.State; frameDir = $Entry.frameDir; provider = 'windows-helper-frame-archive' }",
        "            } else {",
        "              $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')",
        "              if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }",
        "              if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {",
        "                @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before completion.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8",
        "              }",
        "              Compress-CccDirectory -SourcePath $Entry.frameDir -DestinationPath $ArchivePath",
        "              Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null",
        "              $Recordings.Remove($SessionId)",
        "              $Response.recording = @{ sessionId = $SessionId; active = $false; state = $Entry.job.State; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }",
        "            }",
        "          } else {",
        "            $Response.recording = $null",
        "          }",
        "        }",
        "        'record_stop' {",
        "          $SessionId = $Request.sessionId",
        "          if (-not $SessionId -or -not $Recordings.ContainsKey($SessionId)) { throw \"No recording active: $SessionId\" }",
        "          $Entry = $Recordings[$SessionId]",
        "          Stop-Job -Job $Entry.job -ErrorAction SilentlyContinue | Out-Null",
        "          Wait-Job -Job $Entry.job -Timeout 3 -ErrorAction SilentlyContinue | Out-Null",
        "          Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null",
        "          $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')",
        "          if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }",
        "          if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {",
        "            @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before stop.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8",
        "          }",
        "          Compress-CccDirectory -SourcePath $Entry.frameDir -DestinationPath $ArchivePath",
        "          $Recordings.Remove($SessionId)",
        "          $Response.recording = @{ sessionId = $SessionId; active = $false; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }",
        "        }",
        "        default { throw \"Unknown request type: $($Request.type)\" }",
        "      }",
        "    } catch {",
        "      if ($null -eq $Request -and -not (Test-Path -LiteralPath $RequestPath)) { return }",
        "      $RequestId = if ($Request -and $Request.id) { $Request.id } else { [IO.Path]::GetFileNameWithoutExtension($RequestPath) }",
        "      $RequestType = if ($Request -and $Request.type) { $Request.type } else { '' }",
        "      $Response = [ordered]@{ id = $RequestId; ok = $false; type = $RequestType; error = $_.Exception.Message }",
        "    }",
        "    $ResponsePath = Join-Path $Outbox ($Response.id + '.json')",
        "    $ResponseTempPath = $ResponsePath + '.tmp'",
        "    Write-CccJson -Path $ResponseTempPath -Value $Response",
        "    Move-Item -Force -Path $ResponseTempPath -Destination $ResponsePath",
        "    Remove-Item -Force -Path $RequestPath",
        "}",
        "if ($OnceRequestPath) { Invoke-CccRequest $OnceRequestPath; exit }",
        ...windowsHelperMutexScriptLines("DaemonMutex", "$PSCommandPath", "daemon"),
        "try {",
        "  try { $DaemonMutexOwned = $DaemonMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $DaemonMutexOwned = $true }",
        "  if (-not $DaemonMutexOwned) { return }",
        "  Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "  while ($true) {",
        "    Write-CccHeartbeat",
        "    Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object { Invoke-CccRequest $_.FullName }",
        "    Start-Sleep -Milliseconds 250",
        "  }",
        "} finally {",
        "  if ($DaemonMutexOwned) { $DaemonMutex.ReleaseMutex() }",
        "  $DaemonMutex.Dispose()",
        "}",
        "",
    ].join("\n");
}

export function windowsHelperBootstrapScript(helper) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$ToolsHelper = '${helper.guestToolsDir}\\ccc-guest-helper.ps1'`,
        `$ScratchHelper = '${helper.guestHelperScript}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$PowerShellExe = Join-Path $PSHOME 'powershell.exe'",
        "$BootstrapStdoutPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stdout.txt'",
        "$BootstrapStderrPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stderr.txt'",
        "$BootstrapPhasePath = Join-Path $Downloads 'ccc-guest-helper-bootstrap-phase.json'",
        "function Write-CccBootstrapPhase([string]$Stage, [string]$Code = '') {",
        "  if (-not $BootstrapMutexOwned) { return }",
        "  try {",
        "    $Evidence = [ordered]@{ schemaVersion = 1; stage = $Stage }",
        "    if ($Code) { $Evidence.error = $Code }",
        "    [IO.File]::WriteAllText(($BootstrapPhasePath + '.tmp'), ($Evidence | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))",
        "    Move-Item -LiteralPath ($BootstrapPhasePath + '.tmp') -Destination $BootstrapPhasePath -Force",
        "  } catch { }", // Diagnostic I/O cannot replace the primary bootstrap failure.
        "}",
        "$StdoutPath = Join-Path $Downloads 'ccc-guest-helper.stdout.txt'",
        "$StderrPath = Join-Path $Downloads 'ccc-guest-helper.stderr.txt'",
        ...windowsHelperMutexScriptLines("BootstrapMutex", "$ScratchHelper", "bootstrap"),
        "$CanWriteLogs = $false",
        "try {",
        "  try { $BootstrapMutexOwned = $BootstrapMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $BootstrapMutexOwned = $true }",
        "  if (-not $BootstrapMutexOwned) { return }",
        "  Write-CccBootstrapPhase 'inspect-helper'",
        // The live query also covers a launcher crash between child creation and any receipt write.
        "  $ExpectedScript = [regex]::Escape([IO.Path]::GetFullPath($ScratchHelper))",
        "  $ExpectedExe = [regex]::Escape([IO.Path]::GetFullPath($PowerShellExe))",
        `  $ScriptArgument = '(?i)(?:^|\\s)-File\\s+(?:"' + $ExpectedScript + '"|' + $ExpectedScript + ')(?:\\s|$)'`,
        `  $ExactCommand = '(?i)^\\s*(?:"' + $ExpectedExe + '"|' + $ExpectedExe + ')\\s+-NoProfile\\s+-ExecutionPolicy\\s+Bypass\\s+-File\\s+(?:"' + $ExpectedScript + '"|' + $ExpectedScript + ')\\s*$'`,
        "  $CurrentSession = (Get-Process -Id $PID -ErrorAction Stop).SessionId",
        "  $LiveHelpers = @()",
        `  foreach ($Candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -OperationTimeoutSec 2 -ErrorAction Stop)) {`,
        "    if (-not $Candidate.CommandLine) { throw 'helper-process-identity-unavailable' }",
        "    if ($Candidate.CommandLine -notmatch $ScriptArgument) { continue }",
        `    if ($Candidate.CommandLine -match '(?i)(?:^|\\s)-OnceRequestPath(?:\\s|$)') { continue }`,
        "    Write-CccBootstrapPhase 'validate-helper'",
        "    if (-not $Candidate.ExecutablePath) { throw 'helper-process-identity-unavailable' }",
        "    if ($Candidate.CommandLine -notmatch $ExactCommand -or $Candidate.ExecutablePath -ine $PowerShellExe -or $Candidate.SessionId -ne $CurrentSession) { throw 'helper-process-identity-mismatch' }",
        "    $Live = Get-Process -Id $Candidate.ProcessId -ErrorAction Stop",
        "    $CreationTicks = $Candidate.CreationDate.ToUniversalTime().Ticks",
        "    $StartTicks = $Live.StartTime.ToUniversalTime().Ticks",
        // CIM timestamps have microsecond precision; compare at that precision, then pin exact ticks.
        "    if ($Live.HasExited -or $Live.SessionId -ne $CurrentSession -or $Live.Path -ine $PowerShellExe -or [Math]::Abs($StartTicks - $CreationTicks) -ge 10) { throw 'helper-process-creation-mismatch' }",
        "    $Verified = Get-Process -Id $Candidate.ProcessId -ErrorAction Stop",
        "    if ($Verified.HasExited -or $Verified.StartTime.ToUniversalTime().Ticks -ne $StartTicks -or $Verified.Path -ine $PowerShellExe -or $Verified.SessionId -ne $CurrentSession) { throw 'helper-process-creation-mismatch' }",
        "    $LiveHelpers += $Verified",
        "  }",
        "  if ($LiveHelpers.Count -gt 1) { throw 'helper-process-ambiguous' }",
        "  if ($LiveHelpers.Count -eq 1) { Write-CccBootstrapPhase 'helper-reused'; return }",
        "  Write-CccBootstrapPhase 'starting-helper'",
        "  New-Item -ItemType Directory -Force -Path $Downloads,(Split-Path $ScratchHelper) | Out-Null",
        "  $CanWriteLogs = $true",
        "  Set-Content -Path $BootstrapStdoutPath -Value ('bootstrap-start ' + (Get-Date).ToString('o')) -Encoding UTF8",
        "  Copy-Item -Force -LiteralPath $ToolsHelper -Destination $ScratchHelper",
        "  $Process = Start-Process -FilePath $PowerShellExe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ScratchHelper) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru",
        "  Add-Content -Path $BootstrapStdoutPath -Value ('helper-pid ' + $Process.Id)",
        "  Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper-bootstrap.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "  Write-CccBootstrapPhase 'helper-started'",
        "} catch {",
        "  $FailureCode = [string]$_.Exception.Message",
        "  if ($FailureCode -cnotin @('helper-process-identity-unavailable','helper-process-identity-mismatch','helper-process-creation-mismatch','helper-process-ambiguous')) { $FailureCode = 'helper-bootstrap-command-failed' }",
        "  Write-CccBootstrapPhase 'failed' $FailureCode",
        "  if ($BootstrapMutexOwned -and $CanWriteLogs) { Set-Content -Path $BootstrapStderrPath -Value $_.Exception.ToString() -Encoding UTF8 }",
        "  throw",
        "} finally {",
        "  if ($BootstrapMutexOwned) { $BootstrapMutex.ReleaseMutex() }",
        "  $BootstrapMutex.Dispose()",
        "}",
        "",
    ].join("\n");
}

function windowsHelperBootstrapLauncherScript(helper) {
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper.guestBootstrapScript}"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${command.replace(/"/g, "\"\"")}", 0, False`,
        "",
    ].join("\r\n");
}

function writeGeneratedHelperFile(file, value) {
    try {
        if (readFileSync(file, "utf-8") === value) return;
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    writeFileAtomically(file, value);
}

function ensureHelperWorkspace(device, writeScripts = true) {
    const helper = windowsHelperMetadata(device);
    for (const dir of [helper.scratchDir, helper.toolsDir, helper.inboxDir, helper.outboxDir, helper.uploadsDir, helper.downloadsDir, windowsRecordingDir(device)]) {
        mkdirSync(dir, { recursive: true });
    }
    for (const file of [helper.hostHelperScript, helper.hostBootstrapScript, helper.hostBootstrapLauncherScript]) {
        assertDeviceLabPathWithinRoot(windowsOwnerRoot(), file, "windows-helper-workspace");
    }
    if (writeScripts) {
        writeGeneratedHelperFile(helper.hostHelperScript, windowsHelperScript(helper));
        writeGeneratedHelperFile(helper.hostBootstrapScript, windowsHelperBootstrapScript(helper));
        writeGeneratedHelperFile(helper.hostBootstrapLauncherScript, windowsHelperBootstrapLauncherScript(helper));
    }
    return helper;
}

function writeWsbConfig(device) {
    const helper = ensureHelperWorkspace(device);
    const networking = device.networking === true ? "Enable" : "Disable";
    const clipboard = device.clipboard === true ? "Enable" : "Disable";
    const vgpu = device.vgpu === true ? "Enable" : "Disable";
    const memoryMb = device.memoryMb || 4096;
    const mappedFolders = [
        [helper.inboxDir, helper.guestInboxDir, false],
        [helper.outboxDir, helper.guestOutboxDir, false],
        [helper.uploadsDir, helper.guestUploadsDir, false],
        [helper.downloadsDir, helper.guestDownloadsDir, false],
        [helper.toolsDir, helper.guestToolsDir, true],
    ];
    const config = [
        "<Configuration>",
        `  <VGpu>${vgpu}</VGpu>`,
        `  <Networking>${networking}</Networking>`,
        `  <ClipboardRedirection>${clipboard}</ClipboardRedirection>`,
        `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
        "  <MappedFolders>",
        ...mappedFolders.flatMap(([hostFolder, sandboxFolder, readOnly]) => [
            "    <MappedFolder>",
            `      <HostFolder>${escapeXml(hostFolder)}</HostFolder>`,
            `      <SandboxFolder>${escapeXml(sandboxFolder)}</SandboxFolder>`,
            `      <ReadOnly>${readOnly ? "true" : "false"}</ReadOnly>`,
            "    </MappedFolder>",
        ]),
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>wscript.exe //B ${escapeXml(helper.guestBootstrapLauncherScript)}</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\n");
    const path = wsbConfigPath(device);
    assertDeviceLabPathWithinRoot(windowsOwnerRoot(), path, "windows-sandbox-config");
    writeFileAtomically(path, config);
    return path;
}

function readWsbConfig(path) {
    const config = readDeviceLabTextFile(path, "windows-sandbox-config", WINDOWS_SANDBOX_CONFIG_LIMIT_BYTES);
    if (config === null) throw new Error("windows-sandbox-config-missing");
    return config;
}

function resetWindowsHelperSessionMarkers(helper) {
    for (const path of [
        helper.readyMarkerPath,
        helper.bootstrapReadyMarkerPath,
        helper.bootstrapPhasePath,
        `${helper.bootstrapPhasePath}.tmp`,
        helper.bootstrapStdoutPath,
        helper.bootstrapStderrPath,
        helper.helperStdoutPath,
        helper.helperStderrPath,
        helper.helperHeartbeatPath,
        helper.minimizeWatchdogCancelPath,
        helper.minimizeWatchdogResultPath,
    ]) {
        rmSync(path, { force: true });
    }
}

function powershellEncodedCommand(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function quoteWindowsProcessArgument(value) {
    const text = String(value);
    if (text.length === 0) return '""';
    if (!/[ \t\r\n"]/.test(text)) return text;
    let result = '"';
    let backslashes = 0;
    for (const char of text) {
        if (char === "\\") {
            backslashes += 1;
        } else if (char === '"') {
            result += "\\".repeat((backslashes * 2) + 1);
            result += '"';
            backslashes = 0;
        } else {
            result += "\\".repeat(backslashes);
            result += char;
            backslashes = 0;
        }
    }
    result += "\\".repeat(backslashes * 2);
    result += '"';
    return result;
}

export function windowsMinimizedStartProcessArgs(executable, args, wait) {
    const waitFlags = wait ? " -Wait" : "";
    const exitCheck = wait ? "if ($null -ne $Process.ExitCode) { exit $Process.ExitCode }" : "";
    const argumentLine = args.map(quoteWindowsProcessArgument).join(" ");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${psSingleQuote(executable)}`,
        `$Arguments = ${psSingleQuote(argumentLine)}`,
        wait ? `$Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized${waitFlags} -PassThru`
            : `(New-Object -ComObject Shell.Application).ShellExecute($Executable, $Arguments, '', 'open', 7)`,
        exitCheck,
        "exit 0",
    ].filter(Boolean).join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

function windowsSandboxWindowMinimizeScriptLines(options = {}) {
    const timeoutMs = options.timeoutMs || 5000;
    const continuous = options.continuous === true;
    const cancelPath = typeof options.cancelPath === "string" ? options.cancelPath : "";
    const resultPath = typeof options.resultPath === "string" ? options.resultPath : "";
    const startedAfter = typeof options.startedAfter === "string" ? options.startedAfter : "";
    const baselineHandles = Array.isArray(options.baselineHandles)
        ? [...new Set(options.baselineHandles.filter((value) => Number.isSafeInteger(value) && value > 0))]
        : [];
    return [
        `$Continuous = $${continuous ? "true" : "false"}`,
        `$CancelPath = ${psSingleQuote(cancelPath)}`,
        `$ResultPath = ${psSingleQuote(resultPath)}`,
        `$StartedAfter = [DateTime]::Parse(${psSingleQuote(startedAfter)}).ToUniversalTime()`,
        `$HasBaselineSnapshot = $${Array.isArray(options.baselineHandles) ? "true" : "false"}`,
        `$BaselineHandles = @(${baselineHandles.join(",")})`,
        "$Signature = @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class NativeWindow {",
        "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
        "}",
        "'@",
        "Add-Type -TypeDefinition $Signature -ErrorAction SilentlyContinue | Out-Null",
        `$Deadline = (Get-Date).AddMilliseconds(${timeoutMs})`,
        "$Minimized = $false",
        "while ((Get-Date) -lt $Deadline -and (-not $CancelPath -or -not (Test-Path -LiteralPath $CancelPath))) {",
        "  $Handles = @()",
        "  try {",
        "    $Handles += Get-Process -ErrorAction SilentlyContinue | Where-Object {",
        "      $Handle = [Int64]$_.MainWindowHandle",
        "      $Candidate = $Handle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*'))",
        "      $NewHandle = $HasBaselineSnapshot -and -not ($BaselineHandles -contains $Handle)",
        "      $NewProcess = (-not $HasBaselineSnapshot) -and $_.StartTime.ToUniversalTime() -ge $StartedAfter",
        "      $Candidate -and ($NewHandle -or $NewProcess)",
        "    } | ForEach-Object { [Int64]$_.MainWindowHandle }",
        "  } catch {}",
        "  $Handles = @($Handles | Where-Object { $_ -ne 0 } | Select-Object -Unique)",
        "  if ($Handles.Count -gt 0) {",
        "    foreach ($Handle in $Handles) { if ([NativeWindow]::ShowWindowAsync([IntPtr]$Handle, 6)) { $Minimized = $true } }",
        "    if ($Minimized -and $ResultPath) { Set-Content -LiteralPath $ResultPath -Value 'minimized' -NoNewline -Encoding Ascii }",
        "    if ($Minimized -and $Continuous -ne $true) { break }",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "if (-not $Minimized -and $ResultPath -and -not (Test-Path -LiteralPath $ResultPath)) { Set-Content -LiteralPath $ResultPath -Value 'not-minimized' -NoNewline -Encoding Ascii }",
    ];
}

export function windowsReadyMinimizeWatchdogArgs(startedAfter, cancelPath = "", timeoutMs = WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, baselineHandles = null, resultPath = "") {
    const boundedStartedAfter = Number.isNaN(Date.parse(startedAfter)) ? new Date().toISOString() : new Date(startedAfter).toISOString();
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        ...windowsSandboxWindowMinimizeScriptLines({ timeoutMs, continuous: false, cancelPath, startedAfter: boundedStartedAfter, baselineHandles, resultPath }),
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function windowsWsbConfigLaunchArgs(configPath, minimized = true) {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$ConfigPath = ${psSingleQuote(configPath)}`,
        minimized
            ? "(New-Object -ComObject Shell.Application).ShellExecute($ConfigPath, '', '', 'open', 7)"
            : "$Process = Start-Process -FilePath $ConfigPath -WindowStyle Normal -PassThru",
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function windowsSandboxMinimizeWatchdogArgs(timeoutMs = WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, cancelPath = "") {
    const startedAfter = new Date(Date.now() - 2000).toISOString();
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        ...windowsSandboxWindowMinimizeScriptLines({ timeoutMs, continuous: false, cancelPath, startedAfter }),
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

function windowsSandboxWindowHandles() {
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Handles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*')) } | ForEach-Object { [Int64]$_.MainWindowHandle } | Select-Object -Unique)",
        "$Handles | ConvertTo-Json -Compress",
    ].join("\n");
    const result = runWithTimeout("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)], 10000);
    if (result.status !== 0) return null;
    const output = String(result.stdout || "").trim();
    if (!output) return [];
    try {
        const parsed = JSON.parse(output);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
    } catch {
        return null;
    }
}

function launchWindowsSandboxMinimizeWatchdog(startedAfter, cancelPath, timeoutMs = WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, baselineHandles = null, resultPath = "") {
    if (process.platform !== "win32") return { ok: true, skipped: true };
    try {
        const child = spawn("powershell.exe", windowsReadyMinimizeWatchdogArgs(startedAfter, cancelPath, timeoutMs, baselineHandles, resultPath), {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.unref();
        return {
            ok: true,
            pid: child.pid,
            timeoutMs,
            processOwner: "device-lab-mcp",
            startedBy: "windows-sandbox.minimize-watchdog",
            cancelPath,
        };
    } catch (error) {
        return { ok: false, error: error?.message || String(error), timeoutMs };
    }
}

function cancelWindowsMinimizeWatchdog(cancelPath) {
    try {
        mkdirSync(dirname(cancelPath), { recursive: true });
        writeFileSync(cancelPath, new Date().toISOString(), { mode: 0o600 });
        return { attempted: true, ok: true, cancelPath };
    } catch (error) {
        return { attempted: true, ok: false, cancelPath, error: error?.message || String(error) };
    }
}

export function cleanupWindowsSandboxMinimizeWatchdogs(device, cancelWatchdog = cancelWindowsMinimizeWatchdog) {
    return createWindowsSandboxStop(windowsSandboxStopPorts(cancelWatchdog)).cleanupWatchdogs(device);
}

function runWindowsSandboxCommand(wsb, args, timeoutMs, minimized = true, waitForExit = true) {
    if (process.platform === "win32" && minimized) {
        return runWithTimeout("powershell.exe", windowsMinimizedStartProcessArgs(wsb, args, waitForExit), timeoutMs);
    }
    return runWithTimeout(wsb, args, timeoutMs);
}

export function launchWindowsSandboxSession(wsb, sandboxId, minimized = true, timeoutMs = 10000, {
    platform = process.platform, runLauncher = runWithTimeout, spawnSession = spawn,
} = {}) {
    try {
        if (timeoutMs <= 0) return { ok: false, error: "session-connect-deadline-exhausted" };
        const useHiddenPowerShell = platform === "win32" && minimized;
        const executable = useHiddenPowerShell ? "powershell.exe" : wsb;
        const args = useHiddenPowerShell
            ? windowsMinimizedStartProcessArgs(wsb, ["connect", "--id", sandboxId], false)
            : ["connect", "--id", sandboxId];
        if (useHiddenPowerShell) {
            const result = runLauncher(executable, args, Math.min(10000, timeoutMs));
            return result.status === 0 && !result.error ? { ok: true }
                : { ok: false, error: "session-connect-launcher-failed" };
        }
        const child = spawnSession(executable, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: useHiddenPowerShell,
        });
        child.unref();
        return { ok: true, pid: child.pid };
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}

function commandSummary(result) {
    return [
        `status=${result?.status ?? "unknown"}`,
        result?.error?.message ? `error=${result.error.message}` : "",
        result?.stdout ? `stdout=${String(result.stdout).slice(0, 500)}` : "",
        result?.stderr ? `stderr=${String(result.stderr).slice(0, 500)}` : "",
    ].filter(Boolean).join(" ");
}

function execAttemptSummary(attempts) {
    if (!Array.isArray(attempts) || attempts.length === 0) return "";
    return attempts.map((attempt) => `runAs=${attempt.runAs} guestStatus=${attempt.guestStatus ?? "unknown"} ${commandSummary(attempt.result)}`).join(" | ");
}

function readDiagnosticSnippet(path) {
    if (!existsSync(path)) return `${path}: <missing>`;
    try {
        const content = (readDeviceLabTextFile(path, "windows-helper-diagnostic", WINDOWS_SANDBOX_DIAGNOSTIC_FILE_LIMIT_BYTES) || "").slice(0, 1000);
        return `${path}: ${content || "<empty>"}`;
    } catch (error) {
        return `${path}: <read failed: ${error?.message || String(error)}>`;
    }
}

// A classification is evidence about a known log token, not a native root-cause claim.
export function classifyWindowsSandboxHelperStderr(text) {
    if (text === null) return "absent";
    if (typeof text !== "string") return "unreadable";
    if (Buffer.byteLength(text, "utf8") > WINDOWS_SANDBOX_DIAGNOSTIC_FILE_LIMIT_BYTES) return "oversized";
    if (!text.trim()) return "empty";
    if (/\b(?:PSSecurityException|ScriptNotAllowed)\b/i.test(text)) return "script-policy";
    if (/\b(?:UnauthorizedAccessException|PermissionDenied|AccessDenied)\b/i.test(text)) return "access-denied";
    if (/\b(?:ItemNotFoundException|DirectoryNotFoundException|FileNotFoundException|PathNotFound|CommandNotFoundException)\b/i.test(text)) return "path-not-found";
    if (/\b(?:ParserError|ParseException|UnexpectedToken)\b/i.test(text)) return "parse-error";
    return "other-error";
}

export function windowsSandboxHelperLogEvidence(downloadsDir) {
    const read = (name) => {
        try {
            const path = join(downloadsDir, name);
            assertDeviceLabPathWithinRoot(downloadsDir, path, "windows-helper-diagnostic");
            return { text: readDeviceLabTextFile(path, "windows-helper-diagnostic", WINDOWS_SANDBOX_DIAGNOSTIC_FILE_LIMIT_BYTES) };
        } catch (error) {
            return { text: null, failure: error?.code === "windows-helper-diagnostic-file-too-large" ? "oversized" : "unreadable" };
        }
    };
    const bootstrapStdout = read("ccc-guest-helper-bootstrap.stdout.txt");
    const bootstrapReady = read("ccc-guest-helper-bootstrap.ready.txt");
    const heartbeat = read("ccc-guest-helper.heartbeat.txt");
    const bootstrapStderr = read("ccc-guest-helper-bootstrap.stderr.txt");
    const helperStderr = read("ccc-guest-helper.stderr.txt");
    return {
        bootstrapStarted: typeof bootstrapStdout.text === "string" && /^\uFEFF?bootstrap-start\s+\S/m.test(bootstrapStdout.text),
        bootstrapReady: typeof bootstrapReady.text === "string" && bootstrapReady.text.trim().length > 0,
        helperHeartbeat: typeof heartbeat.text === "string" && /^\uFEFF?heartbeat\s+\S/m.test(heartbeat.text),
        bootstrapStderr: bootstrapStderr.failure || classifyWindowsSandboxHelperStderr(bootstrapStderr.text),
        helperStderr: helperStderr.failure || classifyWindowsSandboxHelperStderr(helperStderr.text),
    };
}

function directoryDiagnostic(path) {
    try {
        const entries = readdirSync(path).slice(0, 20).join(", ");
        return `${path}: ${entries || "<empty>"}`;
    } catch (error) {
        return `${path}: <read failed: ${error?.message || String(error)}>`;
    }
}

function tryReadJsonFile(path) {
    try {
        const text = (readDeviceLabTextFile(path, "windows-helper-response", WINDOWS_SANDBOX_HELPER_RESPONSE_LIMIT_BYTES) || "").replace(/^\uFEFF/, "");
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}

function existingLoginUnavailable(result) {
    const text = [
        result?.status,
        result?.stdout,
        result?.stderr,
        result?.error?.message,
    ].filter(Boolean).join(" ");
    return /0x80070520|2147943712|existing\s+login|logon\s+session|로그온|로그인/i.test(text);
}

export function windowsSandboxGuestProcessStatus(result) {
    const text = [result?.stdout, result?.stderr]
        .filter((value) => typeof value === "string" && value)
        .join("\n");
    for (const pattern of [/(?:exit\s+)?code\s*[:=]?\s*(-?\d+)/i, /\([^()\r\n]{0,32}:\s*(-?\d+)\)\.?/]) {
        const match = text.match(pattern);
        if (!match) continue;
        const status = Number(match[1]);
        if (Number.isSafeInteger(status)) return status;
    }
    return null;
}

function windowsSandboxExec(wsb, sandboxId, command, timeoutMs) {
    const runAsModes = ["ExistingLogin"];
    const attempts = [];
    let lastResult = null;
    for (const runAs of runAsModes) {
        const args = ["exec", "--id", sandboxId, "--command", command, ...(runAs ? ["--run-as", runAs] : [])];
        const result = runWithTimeout(wsb, args, timeoutMs);
        const guestStatus = windowsSandboxGuestProcessStatus(result);
        const attempt = { runAs: runAs || "implicit", guestStatus, result };
        attempts.push(attempt);
        lastResult = result;
        if (result.status === 0 && (guestStatus === null || guestStatus === 0)) return { ok: true, runAs: attempt.runAs, guestStatus, result, attempts };
        if (runAs === "ExistingLogin" && !existingLoginUnavailable(result)) break;
    }
    return {
        ok: false,
        runAs: attempts[attempts.length - 1]?.runAs || "unknown",
        guestStatus: attempts[attempts.length - 1]?.guestStatus ?? null,
        result: lastResult,
        attempts,
    };
}

export async function runWindowsHelperBootstrapFallback(device, helper, wsb, timeoutMs, {
    now = Date.now, wait = sleep, execute = windowsSandboxExec,
} = {}) {
    // Reserve the final quarter for the actual request; never round a short
    // caller deadline up to a fresh one-second command budget.
    const deadline = now() + Math.min(Math.max(0, Math.floor(timeoutMs * 0.75)), 45000);
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${helper.guestBootstrapScript}`;
    let lastResult = null;
    let lastAttempts = [];
    let attempted = false;
    let failure = "timeout";
    while (now() < deadline) {
        if (existsSync(helper.readyMarkerPath)) {
            return { attempted, ok: true, ready: true, command, result: lastResult, attempts: lastAttempts };
        }
        const remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        attempted = true;
        const execution = execute(wsb, device.sandboxId, command, Math.min(WINDOWS_SANDBOX_EXEC_TIMEOUT_MS, remainingMs));
        lastResult = execution.result;
        lastAttempts = execution.attempts;
        if (execution.ok && now() <= deadline) {
            return { attempted, ok: true, ready: existsSync(helper.readyMarkerPath), command, result: lastResult, attempts: lastAttempts, runAs: execution.runAs };
        }
        failure = lastResult?.error?.code === "ETIMEDOUT" || now() >= deadline ? "timeout"
            : existingLoginUnavailable(lastResult) ? "login-unavailable" : "command-failed";
        const remainingAfterExec = deadline - now();
        if (remainingAfterExec <= 0) break;
        await wait(Math.min(500, remainingAfterExec));
    }
    return { attempted, ok: false, ready: existsSync(helper.readyMarkerPath), command, result: lastResult,
        attempts: lastAttempts, failure, deadlineExhausted: now() >= deadline };
}

function guestRequestPath(helper, requestPath) {
    return `${helper.guestInboxDir}\\${basename(requestPath)}`;
}

function guestResponsePath(helper, responsePath) {
    return `${helper.guestOutboxDir}\\${basename(responsePath)}`;
}

function psSingleQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

export async function runWindowsHelperRequestOnce(device, helper, wsb, requestPath, responsePath, timeoutMs, { now = Date.now, execute = windowsSandboxExec } = {}) {
    if (!isGuid(device?.sandboxId)) {
        return { attempted: false, ok: false, command: "", result: null, error: "missing valid sandboxId" };
    }
    const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
    if (now() >= deadline) return { attempted: false, ok: false, command: "", result: null, deadlineExhausted: true };
    const waitMs = Math.min(5000, Math.max(0, deadline - now()));
    const requestScriptPath = `${requestPath}.ps1`;
    assertDeviceLabPathWithinRoot(helper.inboxDir, requestScriptPath, "windows-helper-one-shot-script");
    const guestScriptPath = `${helper.guestInboxDir}\\${basename(requestScriptPath)}`;
    const diagnosticName = `${basename(requestPath, ".json")}.one-shot.stderr.txt`;
    const diagnosticPath = join(helper.downloadsDir, diagnosticName);
    assertDeviceLabPathWithinRoot(helper.downloadsDir, diagnosticPath, "windows-helper-one-shot-diagnostic");
    rmSync(diagnosticPath, { force: true });
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `$DiagnosticPath = ${psSingleQuote(`${helper.guestDownloadsDir}\\${diagnosticName}`)}`,
        "try {",
        `$ToolsHelper = ${psSingleQuote(`${helper.guestToolsDir}\\ccc-guest-helper.ps1`)}`,
        `$ScratchHelper = ${psSingleQuote(helper.guestHelperScript)}`,
        `$RequestPath = ${psSingleQuote(guestRequestPath(helper, requestPath))}`,
        `$ResponsePath = ${psSingleQuote(guestResponsePath(helper, responsePath))}`,
        `$Deadline = (Get-Date).AddMilliseconds(${waitMs})`,
        "if (-not (Test-Path -LiteralPath $ScratchHelper)) { Copy-Item -Force -LiteralPath $ToolsHelper -Destination $ScratchHelper }",
        "while (-not (Test-Path -LiteralPath $RequestPath) -and -not (Test-Path -LiteralPath $ResponsePath) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 100 }",
        "if (-not (Test-Path -LiteralPath $RequestPath)) { throw 'Windows Sandbox helper request file is unavailable' }",
        "& $ScratchHelper -OnceRequestPath $RequestPath",
        "} catch {",
        "  [System.IO.File]::WriteAllText($DiagnosticPath, ($_ | Out-String), [System.Text.UTF8Encoding]::new($false))",
        "  exit 1",
        "}",
        "",
    ].join("\r\n");
    writeFileAtomically(requestScriptPath, script);
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${guestScriptPath}`;
    try {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) return { attempted: false, ok: false, command, result: null, deadlineExhausted: true };
        const execution = execute(wsb, device.sandboxId, command, Math.min(WINDOWS_SANDBOX_EXEC_TIMEOUT_MS, remainingMs));
        return { attempted: true, ok: execution.ok && now() <= deadline, command, diagnosticPath,
            guestStatus: execution.guestStatus, result: execution.result, attempts: execution.attempts, runAs: execution.runAs,
            deadlineExhausted: now() > deadline };
    } finally {
        rmSync(requestScriptPath, { force: true });
    }
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWindowsSandboxMinimizeConfirmation(resultPath, timeoutMs = WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (existsSync(resultPath)) {
            let result;
            try {
                result = (readDeviceLabTextFile(resultPath, "windows-sandbox-minimize-result", WINDOWS_SANDBOX_MINIMIZE_RESULT_LIMIT_BYTES) || "").trim();
            } catch (error) {
                return { ok: false, result: "", error: `Windows Sandbox window minimization result is invalid: ${error?.code || error?.message || String(error)}` };
            }
            return result === "minimized"
                ? { ok: true, result }
                : { ok: false, result, error: `Windows Sandbox window minimization reported ${result || "an empty result"}` };
        }
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    return { ok: false, result: "", timedOut: true, error: `Windows Sandbox window was not minimized within ${timeoutMs}ms` };
}

async function windowsHelperRequest(device, type, payload = {}, requestedTimeoutMs = WINDOWS_SANDBOX_HELPER_TIMEOUT_MS) {
    const timeoutMs = windowsSandboxHelperTimeoutMs(requestedTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const helper = ensureHelperWorkspace(device, false);
    let bootstrapFallback = null;
    if (!existsSync(helper.readyMarkerPath)) {
        if (!isGuid(device?.sandboxId)) {
            return { helper, error: `Windows Sandbox helper requires a running sandbox with a valid GUID sandboxId for ${device?.id || "unknown"}`, helperDiagnostic: { stage: "sandbox-id-invalid", readyMarkerPresent: false } };
        }
        const discovery = windowsDiscovery();
        if (!discovery.available) {
            return { helper, error: `Windows Sandbox helper connect missing prerequisites: ${discovery.missing.join(", ")}`, helperDiagnostic: { stage: "prerequisites-missing", readyMarkerPresent: false } };
        }
        // A .wsb-file launch or an earlier successful connect already created the viewer.
        // Missing helper readiness is not evidence that another viewer is needed.
        const connected = device.status === "running" && device.helperSessionLaunch?.ok === true
            ? { ok: true }
            : launchWindowsSandboxSession(discovery.wsb, device.sandboxId, device.minimized !== false, Math.max(0, deadline - Date.now()));
        if (!connected.ok) {
            return { helper, error: `Windows Sandbox helper session connect launch failed: ${connected.error}`, helperDiagnostic: { stage: "session-connect-failed", readyMarkerPresent: false } };
        }
        bootstrapFallback = await runWindowsHelperBootstrapFallback(device, helper, discovery.wsb, Math.max(0, deadline - Date.now()));
    }
    const id = randomUUID();
    const requestPath = join(helper.inboxDir, `${id}.json`);
    const responsePath = join(helper.outboxDir, `${id}.json`);
    writeFileAtomically(requestPath, JSON.stringify({ id, type, ...payload }, null, 2));

    let requestFallback = null;
    let lastResponseParseError = null;
    const requestFallbackAt = Date.now() + Math.min(2000, Math.max(100, Math.floor(timeoutMs / 4)));
    while (Date.now() < deadline) {
        if (existsSync(responsePath)) {
            const parsed = tryReadJsonFile(responsePath);
            if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
                && parsed.value.id === id && parsed.value.type === type) {
                if (Date.now() <= deadline) return { helper, response: parsed.value };
                break;
            }
            lastResponseParseError = parsed.ok ? "response id or type mismatch" : parsed.error;
        }
        if (!requestFallback && Date.now() >= requestFallbackAt) {
            const discovery = windowsDiscovery();
            if (discovery.available) {
                requestFallback = await runWindowsHelperRequestOnce(device, helper, discovery.wsb, requestPath, responsePath, deadline - Date.now());
            } else {
                requestFallback = { attempted: false, ok: false, command: "", result: null, error: `missing prerequisites: ${discovery.missing.join(", ")}` };
            }
            if (existsSync(responsePath)) {
                const parsed = tryReadJsonFile(responsePath);
                if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
                    && parsed.value.id === id && parsed.value.type === type) {
                    if (Date.now() <= deadline) return { helper, response: parsed.value };
                    break;
                }
                lastResponseParseError = parsed.ok ? "response id or type mismatch" : parsed.error;
            }
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(100, remainingMs));
    }
    const diagnostics = [
        `Inbox: ${helper.inboxDir}`,
        `Outbox: ${helper.outboxDir}`,
        `Inbox entries: ${directoryDiagnostic(helper.inboxDir)}`,
        `Outbox entries: ${directoryDiagnostic(helper.outboxDir)}`,
        `Request file: ${readDiagnosticSnippet(requestPath)}`,
        `Response file: ${readDiagnosticSnippet(responsePath)}`,
        lastResponseParseError ? `Last response parse error: ${lastResponseParseError}` : "",
        `Ready marker: ${readDiagnosticSnippet(helper.readyMarkerPath)}`,
        `Bootstrap stdout: ${readDiagnosticSnippet(helper.bootstrapStdoutPath)}`,
        `Bootstrap stderr: ${readDiagnosticSnippet(helper.bootstrapStderrPath)}`,
        `Helper stdout: ${readDiagnosticSnippet(helper.helperStdoutPath)}`,
        `Helper stderr: ${readDiagnosticSnippet(helper.helperStderrPath)}`,
        `Helper heartbeat: ${readDiagnosticSnippet(helper.helperHeartbeatPath)}`,
        bootstrapFallback ? `Bootstrap exec fallback: attempted=${bootstrapFallback.attempted} ok=${bootstrapFallback.ok} ready=${bootstrapFallback.ready} command=${bootstrapFallback.command} ${commandSummary(bootstrapFallback.result)}` : "",
        bootstrapFallback?.attempts?.length ? `Bootstrap exec attempts: ${execAttemptSummary(bootstrapFallback.attempts)}` : "",
        requestFallback ? `Request exec fallback: attempted=${requestFallback.attempted} ok=${requestFallback.ok} guestStatus=${requestFallback.guestStatus ?? "unknown"} command=${requestFallback.command} ${requestFallback.error || commandSummary(requestFallback.result)}` : "",
        requestFallback?.diagnosticPath ? `Request script stderr: ${readDiagnosticSnippet(requestFallback.diagnosticPath)}` : "",
        requestFallback?.attempts?.length ? `Request exec attempts: ${execAttemptSummary(requestFallback.attempts)}` : "",
    ];
    const error = `Windows Sandbox helper did not respond within ${timeoutMs}ms. ${diagnostics.filter(Boolean).join(" | ")}`;
    rmSync(requestPath, { force: true });
    rmSync(responsePath, { force: true });
    rmSync(`${responsePath}.tmp`, { force: true });
    return { helper, error, helperDiagnostic: {
        stage: "response-timeout",
        logEvidence: windowsSandboxHelperLogEvidence(helper.downloadsDir),
        readyMarkerPresent: existsSync(helper.readyMarkerPath),
        bootstrapAttempted: bootstrapFallback?.attempted === true,
        bootstrapOk: bootstrapFallback?.ok === true,
        ...(["login-unavailable", "timeout", "command-failed"].includes(bootstrapFallback?.failure) ? { bootstrapFailure: bootstrapFallback.failure } : {}),
        ...(typeof bootstrapFallback?.deadlineExhausted === "boolean" ? { bootstrapDeadlineExhausted: bootstrapFallback.deadlineExhausted } : {}),
        requestAttempted: requestFallback?.attempted === true,
        requestOk: requestFallback?.ok === true,
        responseParseFailed: lastResponseParseError !== null,
        ...(Number.isInteger(requestFallback?.guestStatus) && requestFallback.guestStatus >= -2147483648
            && requestFallback.guestStatus <= 2147483647 ? { guestStatus: requestFallback.guestStatus } : {}),
    } };
}

function windowsPathBasename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function helperOutputPath(helper, responseValue, fallbackName) {
    const name = windowsPathBasename(responseValue || fallbackName);
    if (!name || name === "." || name === ".." || name.length > 255 || name.includes("\0")) return null;
    return join(helper.downloadsDir, name);
}

function verifiedHelperOutputPath(helper, responseValue, fallbackName) {
    const path = helperOutputPath(helper, responseValue, fallbackName);
    if (!path) return null;
    try {
        assertDeviceLabPathWithinRoot(helper.downloadsDir, path, "windows-helper-output");
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
        return path;
    } catch {
        return null;
    }
}

function copyWindowsSandboxFile(source, destination, prefix, limitBytes) {
    try {
        return { ok: true, bytes: copyFileAtomically(source, destination, { prefix, limitBytes }) };
    } catch (error) {
        return { ok: false, error: error?.code || error?.message || String(error) };
    }
}

function windowsLifecycleConflict(deviceId, operation, transition, rollback = null) {
    return textResult(false, JSON.stringify({
        ok: false,
        error: "owner-device-state-conflict",
        backend: "windows-sandbox",
        deviceId,
        operation,
        found: transition.found,
        ...(rollback ? { rollback } : {}),
    }));
}

function windowsSandboxStopPorts(cancelWatchdog = cancelWindowsMinimizeWatchdog) {
    return {
        readSingleton: () => readWindowsSingletonLock(),
        sameSingletonOwner: (singleton, device, sandboxId) => sameWindowsSingletonOwner(singleton, device, sandboxId),
        newRuntimeId: () => randomUUID(),
        wallTimestamp: () => new Date().toISOString(),
        transitionDevice: (deviceId, expected, replacement) => transitionWindowsDevice(deviceId, expected, replacement),
        findDevice: (deviceId) => findWindowsDevice(deviceId),
        claimSingleton: (device, sandboxId, claimId) => claimWindowsSingleton(device, sandboxId, claimId),
        releaseSingleton: (device, claimId) => releaseWindowsSingleton(device, claimId),
        singletonGenerationMatches: (device) => windowsSingletonGenerationMatches(device),
        watchdogCancelPath: (device) => windowsHelperMetadata(device).minimizeWatchdogCancelPath,
        cancelWatchdog: (cancelPath) => cancelWatchdog(cancelPath),
        discoverRuntime: () => {
            const discovery = windowsDiscovery();
            return {
                get available() { return discovery.available; },
                get missing() { return discovery.missing; },
                binding: discovery,
            };
        },
        stopOwnedRuntime: (discovery, device, timeoutMs) => {
            const result = runWithTimeout(discovery.wsb, ["stop", "--id", device.sandboxId], timeoutMs);
            return { get ok() { return result.status === 0; }, evidence: result };
        },
    };
}

function windowsSandboxLifecyclePorts() {
    return {
        ...windowsSandboxStopPorts(),
        readDevices: () => readWindowsDevices(),
        helperMetadata: device => windowsHelperMetadata(device),
        writeConfig: device => writeWsbConfig(device),
        readConfig: path => readWsbConfig(path),
        resetHelperMarkers: helper => {resetWindowsHelperSessionMarkers(helper); return undefined;},
        listRuntime: (discovery, timeoutMs) => runWithTimeout(discovery.wsb, ["list", "--raw"], timeoutMs),
        runtimeIds: output => windowsSandboxSessionIdsFromListOutput(output),
        stopRuntime: (discovery, id, timeoutMs) => runWithTimeout(discovery.wsb, ["stop", "--id", id], timeoutMs),
        timestampBefore: milliseconds => new Date(Date.now() - milliseconds).toISOString(),
        windowHandles: () => windowsSandboxWindowHandles(),
        launchConfig: (path, minimized, timeoutMs) => runWithTimeout("powershell.exe",windowsWsbConfigLaunchArgs(path,minimized),timeoutMs),
        launchRuntime: (discovery, id, config, minimized, timeoutMs) => runWindowsSandboxCommand(discovery.wsb,["start","--id",id,"--config",config],timeoutMs,minimized,false),
        launchWatchdog: (startedAfter, cancelPath, timeoutMs, handles, resultPath) => launchWindowsSandboxMinimizeWatchdog(startedAfter,cancelPath,timeoutMs,handles,resultPath),
        updateSingletonRuntimeId: (device, claimedId, runtimeId, claimId) => updateWindowsSingletonRuntimeId(device,claimedId,runtimeId,claimId),
        waitForMinimizeConfirmation: path => waitForWindowsSandboxMinimizeConfirmation(path),
        launchSession: (discovery, id, minimized) => launchWindowsSandboxSession(discovery.wsb,id,minimized),
        scratchDirectory: device => windowsScratchDir(device),
        removeScratch: device => {removeWindowsScratch(device); return undefined;},
        platform: process.platform,
        now: () => Date.now(),
        wait: milliseconds => sleep(milliseconds),
        targetStatus: device => withTargetStatus(device),
        lifecycleConflict: (id, operation, transition, detail) => windowsLifecycleConflict(id,operation,transition,detail),
        textResult: (ok, text) => textResult(ok,text),
        jsonResult: value => jsonResult(value),
        fail: result => fail(result),
    };
}

export function listWindowsDevices() { return deviceObservation.owned(); }

/** @type {import('../ports/desktop-control-transfer.mjs').WindowsPorts<NonNullable<ReturnType<typeof findWindowsDevice>>, ReturnType<typeof ensureHelperWorkspace>, string>} */
const windowsDesktopPorts = {
    variant: "windows",
    target: deviceId => findWindowsDevice(deviceId),
    workspace: device => ensureHelperWorkspace(device, false),
    guestPath: (path, helper, label) => validateWindowsGuestTransferPath(path, helper, `${label}-remote-path`),
    inputPath: path => validateLocalInputPath(path, { label: "upload-local-path" }),
    outputPath: path => validateLocalOutputPath(path, { label: "download-local-path" }),
    stageUpload: (helper, path) => {
        const uploadName = `${randomUUID()}-${basename(path).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const hostUploadPath = join(helper.uploadsDir, uploadName);
        try {
            assertDeviceLabPathWithinRoot(helper.uploadsDir, hostUploadPath, "windows-helper-upload");
        } catch (error) {
            const carrier = error !== null && (typeof error === "object" || typeof error === "function") ? error : null;
            const detail = (carrier && "code" in carrier ? carrier.code : undefined)
                || (carrier && "message" in carrier ? carrier.message : undefined) || String(error);
            return { ok: false, message: `Windows helper upload staging path is unsafe: ${detail}` };
        }
        const staged = copyWindowsSandboxFile(path, hostUploadPath, "windows-helper-upload", WINDOWS_SANDBOX_UPLOAD_LIMIT_BYTES);
        if (!staged.ok) return { ok: false, message: `Windows helper upload staging failed: ${staged.error}` };
        return { ok: true, handle: hostUploadPath, guestPath: `${helper.guestUploadsDir}\\${uploadName}` };
    },
    disposeUpload: path => { rmSync(path, { force: true }); },
    request: (device, request, timeoutMs) => {
        const { type, ...payload } = request;
        return windowsHelperRequest(device, type, payload, timeoutMs);
    },
    readyMarkerPresent: helper => existsSync(helper.readyMarkerPath),
    downloadOutput: (helper, response, remotePath) => {
        const path = verifiedHelperOutputPath(helper, response.downloadPath || response.hostDownloadPath, `${response.id}-${windowsPathBasename(remotePath)}`);
        return path ? { ok: true, path } : { ok: false };
    },
    copyDownload: (source, destination) => {
        const result = copyWindowsSandboxFile(source, destination, "windows-helper-download", WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
};
const windowsDesktop = createDesktopControlTransfer(windowsDesktopPorts);

/** @type {import('../ports/desktop-device-access.mjs').WindowsDeviceAccessPorts<NonNullable<ReturnType<typeof findWindowsDevice>>,ReturnType<typeof ensureHelperWorkspace>>} */
const windowsAccessPorts = {
    variant: "windows",
    target: id => findWindowsDevice(id),
    publicDevice: device => withTargetStatus({ ...device, helper: windowsHelperMetadata(device) }),
    backend: () => windowsBackend(),
    request: (device, request, timeoutMs) => {
        const { type, ...payload } = request;
        return windowsHelperRequest(device, type, payload, timeoutMs);
    },
    screenshotPath: (helper, response) => verifiedHelperOutputPath(helper, response.imagePath || response.hostImagePath, `${response.id}.png`),
    readScreenshot: path => {
        try {
            const image = readDeviceLabBinaryFile(path, "windows-helper-screenshot", WINDOWS_SANDBOX_SCREENSHOT_LIMIT_BYTES);
            return image ? { kind: "image", data: image.toString("base64") } : { kind: "missing" };
        } catch (error) {
            const carrier = error !== null && (typeof error === "object" || typeof error === "function") ? error : null;
            const reason = (carrier && "code" in carrier ? carrier.code : undefined)
                || (carrier && "message" in carrier ? carrier.message : undefined) || String(error);
            return { kind: "invalid", reason: String(reason) };
        }
    },
};
const windowsAccess = createDesktopDeviceAccess(windowsAccessPorts);

/** @param {import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined} outcome */
function windowsAccessResult(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "json") return jsonResult(outcome.value);
    if (outcome.kind === "text") return textResult(false, outcome.text);
    if (outcome.kind === "native") return outcome.value;
    if (outcome.kind === "command-failure") return fail(outcome.receipt);
    return { content: [{ type: "image", data: outcome.data, mimeType: "image/png" }] };
}

/** @type {import('../ports/direct-recording.mjs').DirectRecordingNative} */
const windowsRecordingNative = {
    kind: "windows-sandbox",
    findDevice: id => findWindowsDevice(id),
    updateDevice: (id, update) => updateWindowsDevice(id, update),
    localPath: device => windowsRecordingLocalPath(device),
    validateLocalOutputPath: (path, options) => validateLocalOutputPath(path, options),
    helperRequest: async (device, action, request, timeoutMs) => {
        const result = await windowsHelperRequest(device, action, request, timeoutMs);
        return result.error ? { error: result.error } : { response: result.response, helper: result.helper };
    },
    verifiedArchivePath: (helper, path, name) => verifiedHelperOutputPath(helper, path, name),
    copyFile: (source, destination) => copyWindowsSandboxFile(source, destination, "windows-helper-recording", WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES),
};
const windowsRecording = createDirectRecording(windowsRecordingNative);
/** @param {import('../domain/direct-recording.mjs').RecordingOutcome|undefined} outcome */
function windowsRecordingResult(outcome) {
    if (!outcome || outcome.kind === "missing") return undefined;
    if (outcome.kind === "native") return outcome.value;
    if (outcome.kind === "failure") return textResult(false, outcome.message);
    return jsonResult(outcome.value);
}

async function handleWindowsToolUnlocked(name, args) {
    const desktop = await windowsDesktop.handle(name, args);
    if (desktop !== undefined) {
        if (desktop.kind === "json") return jsonResult(desktop.value);
        if (desktop.kind === "text") return textResult(desktop.ok, desktop.text);
        if (desktop.kind === "native") return desktop.value;
        return fail(desktop.receipt);
    }
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_create": {
            const outcome = createWindowsSandboxCreate({
                deriveDeviceId: (name) => windowsDeviceId(name),
                readDefinitions: () => readWindowsDevices(),
                readOwnerId: () => ownerId(),
                ensureHelperWorkspace: (device) => ensureHelperWorkspace(device),
                wallTimestamp: () => new Date().toISOString(),
                claimDefinition: (device) => claimWindowsDevice(device),
            }).create(args);
            if (outcome.kind === "skipped") return undefined;
            if (outcome.kind === "duplicate") return textResult(false, `Device already exists for this owner: ${outcome.id}`);
            if (outcome.kind === "claim-conflict") return textResult(false, `Device identity already exists for this owner (${outcome.field}: ${outcome.value})`);
            return jsonResult({ device: withTargetStatus(outcome.device) });
        }

        case "device_delete": return createWindowsSandboxLifecycle(windowsSandboxLifecyclePorts()).delete(args);

        case "device_status": return windowsAccessResult(await windowsAccess.handle(name, args));

        case "device_start": return createWindowsSandboxLifecycle(windowsSandboxLifecyclePorts()).start(args);

        case "device_stop": return createWindowsSandboxLifecycle(windowsSandboxLifecyclePorts()).stop(args);

        case "device_exec":
        case "device_screenshot":
        case "device_accessibility_snapshot":
            return windowsAccessResult(await windowsAccess.handle(name, args));

        case "device_record_video_status":
        case "device_record_video_start":
        case "device_record_video_stop":
            return windowsRecordingResult(await windowsRecording.request(name, args));

        default:
            return undefined;
    }
}

export async function handleWindowsTool(name, args) {
    if (name === "device_create" && args?.backend && args.backend !== "windows-sandbox") return undefined;
    if (!requiresOwnerDeviceOperation("windows", name)) return handleWindowsToolUnlocked(name, args);
    const createsDevice = name === "device_create";
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : createsDevice && typeof args?.name === "string"
            ? windowsDeviceId(args.name)
            : null;
    if (!deviceId) return handleWindowsToolUnlocked(name, args);
    if (!createsDevice && !findWindowsDevice(deviceId)) return handleWindowsToolUnlocked(name, args);
    try {
        return await withOwnerDeviceOperation("windows", deviceId, () => handleWindowsToolUnlocked(name, args));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `Windows Sandbox device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const deviceObservation = createDeviceObservation({ kind: "windows-sandbox", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: [
        "device_list_files",
        "device_inventory",
        "device_create",
        "device_delete",
        "device_start",
        "device_stop",
        "device_status",
        "device_exec",
        "device_screenshot",
        "device_click",
        "device_double_click",
        "device_key",
        "device_type",
        "device_scroll",
        "device_cursor_position",
        "device_window_list",
        "device_drag",
        "device_focus_window",
        "device_accessibility_snapshot",
        "device_record_video_start",
        "device_record_video_stop",
        "device_record_video_status",
        "device_upload",
        "device_download",
    ], executable: name => commandPath(name), records: () => readWindowsDevices(), helperMetadata: device => windowsHelperMetadata(device), configPath: device => wsbConfigPath(device), singleton: () => readWindowsSingletonLock() });
