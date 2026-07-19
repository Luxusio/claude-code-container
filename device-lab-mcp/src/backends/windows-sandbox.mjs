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
import { recordingGenerationMatches, transitionRecordingGeneration } from "../state/runtime-generation.mjs";
import { readWindowsSandboxLockStateFile, validateWindowsSandboxLock } from "../state/ownership-state.mjs";
import { copyFileAtomically, withSharedMutationLock, writeFileAtomically, writeJsonFileAtomically } from "../state/shared-mutation-lock.mjs";
import { assertDeviceLabPathWithinRoot, readDeviceLabBinaryFile, readDeviceLabTextFile } from "../state/state-file.mjs";
import { withTargetStatus } from "../status.mjs";

const WINDOWS_SANDBOX_START_TIMEOUT_MS = 120000;
const WINDOWS_SANDBOX_STOP_TIMEOUT_MS = 60000;
const WINDOWS_SANDBOX_EXEC_TIMEOUT_MS = 30000;
const WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS = 60000;
const WINDOWS_SANDBOX_LIST_TIMEOUT_MS = 10000;
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

export function windowsDiscovery() {
    const wsb = commandPath("wsb");
    const missing = [];
    if (!wsb) missing.push("wsb");
    return {
        wsb,
        available: missing.length === 0,
        missing,
    };
}

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

function listWindowsSandboxRuntimeIds(wsb) {
    const result = runWithTimeout(wsb, ["list", "--raw"], WINDOWS_SANDBOX_LIST_TIMEOUT_MS);
    return {
        ok: result.status === 0,
        ids: result.status === 0 ? windowsSandboxSessionIdsFromListOutput(result.stdout || "") : [],
        result,
    };
}

function stopWindowsSandboxRuntimeIds(wsb, ids) {
    const stopped = [];
    const failed = [];
    for (const id of ids) {
        const result = runWithTimeout(wsb, ["stop", "--id", id], WINDOWS_SANDBOX_STOP_TIMEOUT_MS);
        if (result.status === 0) stopped.push(id);
        else failed.push({ id, result });
    }
    return { ok: failed.length === 0, stopped, failed };
}

async function waitForWindowsSandboxRuntime(wsb, sandboxId, timeoutMs = WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS, options = {}) {
    if (process.platform !== "win32") return { ok: true, skipped: true, sandboxId };
    const expected = String(sandboxId).toLowerCase();
    const previousIds = (options.previousIds || []).map((id) => String(id).toLowerCase());
    const requireNewRuntime = options.requireNewRuntime === true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastResult = null;
    let lastIds = [];
    let lastNewIds = [];
    while (Date.now() <= deadline) {
        lastResult = runWithTimeout(wsb, ["list", "--raw"], Math.min(WINDOWS_SANDBOX_LIST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())));
        if (lastResult.status === 0) {
            const ids = windowsSandboxSessionIdsFromListOutput(lastResult.stdout || "");
            lastIds = ids;
            lastNewIds = windowsSandboxRuntimeDelta(previousIds, ids);
            if (requireNewRuntime) {
                if (lastNewIds.includes(expected)) {
                    return { ok: true, sandboxId: expected, matchedRequested: true, result: lastResult, observedIds: ids, newIds: lastNewIds };
                }
                if (lastNewIds.length === 1) {
                    return { ok: true, sandboxId: lastNewIds[0], requestedSandboxId: sandboxId, matchedRequested: false, result: lastResult, observedIds: ids, newIds: lastNewIds };
                }
                if (lastNewIds.length > 1) {
                    return { ok: false, result: lastResult, observedIds: ids, newIds: lastNewIds, error: `Windows Sandbox launch produced multiple new runtimes: ${lastNewIds.join(", ")}` };
                }
                await sleep(500);
                continue;
            }
            if (ids.includes(expected)) {
                return { ok: true, sandboxId: expected, matchedRequested: true, result: lastResult };
            }
            if (ids.length === 1) {
                return { ok: true, sandboxId: ids[0], requestedSandboxId: sandboxId, matchedRequested: false, result: lastResult };
            }
        }
        await sleep(500);
    }
    return {
        ok: false,
        result: lastResult,
        observedIds: lastIds,
        newIds: lastNewIds,
        error: `Windows Sandbox runtime ${sandboxId} did not appear in wsb list within ${timeoutMs}ms`,
    };
}

function windowsRuntimeSandboxId(device) {
    return isGuid(device?.sandboxId) ? device.sandboxId : randomUUID();
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

export function windowsBackend() {
    const discovery = windowsDiscovery();
    return {
        name: "windows-sandbox",
        host: "windows-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { wsb: discovery.wsb },
        capabilities: [
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
            "device_accessibility_snapshot",
            "device_record_video_start",
            "device_record_video_stop",
            "device_record_video_status",
            "device_upload",
            "device_download",
        ],
    };
}

function windowsInventoryDevice(device) {
    return withTargetStatus({
        ...device,
        ownerId: ownerId(),
        helper: windowsHelperMetadata(device),
        configPath: wsbConfigPath(device),
    });
}

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
        bootstrapStdoutPath: join(downloadsDir, "ccc-guest-helper-bootstrap.stdout.txt"),
        bootstrapStderrPath: join(downloadsDir, "ccc-guest-helper-bootstrap.stderr.txt"),
        helperStdoutPath: join(downloadsDir, "ccc-guest-helper.stdout.txt"),
        helperStderrPath: join(downloadsDir, "ccc-guest-helper.stderr.txt"),
        helperHeartbeatPath: join(downloadsDir, "ccc-guest-helper.heartbeat.txt"),
        minimizeWatchdogCancelPath: join(downloadsDir, "ccc-minimize-watchdog.cancel"),
        minimizeWatchdogResultPath: join(downloadsDir, "ccc-minimize-watchdog.result.txt"),
        status: "file-channel",
        requiredFor: ["device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_accessibility_snapshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
}

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

function windowsSendKeysExpression(key) {
    const value = String(key || "");
    const aliases = {
        Enter: "{ENTER}",
        Return: "{ENTER}",
        Escape: "{ESC}",
        Esc: "{ESC}",
        Tab: "{TAB}",
        Backspace: "{BACKSPACE}",
        Delete: "{DELETE}",
        Del: "{DELETE}",
        Insert: "{INSERT}",
        Space: " ",
        ArrowUp: "{UP}",
        Up: "{UP}",
        ArrowDown: "{DOWN}",
        Down: "{DOWN}",
        ArrowLeft: "{LEFT}",
        Left: "{LEFT}",
        ArrowRight: "{RIGHT}",
        Right: "{RIGHT}",
        PageUp: "{PGUP}",
        PageDown: "{PGDN}",
        Home: "{HOME}",
        End: "{END}",
    };
    for (let index = 1; index <= 24; index += 1) aliases[`F${index}`] = `{F${index}}`;
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) return aliases[value] || value;
    const keyPart = parts[parts.length - 1];
    const base = aliases[keyPart] || (keyPart.length === 1 ? keyPart.toLowerCase() : keyPart);
    const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
    let prefix = "";
    if (modifiers.some((part) => part === "control" || part === "ctrl")) prefix += "^";
    if (modifiers.includes("alt")) prefix += "%";
    if (modifiers.includes("shift")) prefix += "+";
    return `${prefix}${base}`;
}

function windowsSendKeysLiteralText(text) {
    return String(text ?? "").replace(/[+^%~()[\]{}]/g, (match) => `{${match}}`);
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
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
        "        'cursor_position' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
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
        "Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "while ($true) {",
        "  Write-CccHeartbeat",
        "  Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object { Invoke-CccRequest $_.FullName }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "",
    ].join("\n");
}

function windowsHelperBootstrapScript(helper) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$ToolsHelper = '${helper.guestToolsDir}\\ccc-guest-helper.ps1'`,
        `$ScratchHelper = '${helper.guestHelperScript}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        `$BootstrapStdoutPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stdout.txt'`,
        `$BootstrapStderrPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stderr.txt'`,
        `$StdoutPath = Join-Path $Downloads 'ccc-guest-helper.stdout.txt'`,
        `$StderrPath = Join-Path $Downloads 'ccc-guest-helper.stderr.txt'`,
        "try {",
        "  New-Item -ItemType Directory -Force -Path $Downloads,(Split-Path $ScratchHelper) | Out-Null",
        "  Set-Content -Path $BootstrapStdoutPath -Value ('bootstrap-start ' + (Get-Date).ToString('o')) -Encoding UTF8",
        "  Copy-Item -Force -Path $ToolsHelper -Destination $ScratchHelper",
        "  $Process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ScratchHelper) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru",
        "  Add-Content -Path $BootstrapStdoutPath -Value ('helper-pid ' + $Process.Id)",
        "  Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper-bootstrap.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "} catch {",
        "  Set-Content -Path $BootstrapStderrPath -Value $_.Exception.ToString() -Encoding UTF8",
        "  throw",
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

function windowsMinimizedStartProcessArgs(executable, args, wait) {
    const waitFlags = wait ? " -Wait" : "";
    const exitCheck = wait ? "if ($null -ne $Process.ExitCode) { exit $Process.ExitCode }" : "";
    const argumentLine = args.map(quoteWindowsProcessArgument).join(" ");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${psSingleQuote(executable)}`,
        `$Arguments = ${psSingleQuote(argumentLine)}`,
        `$Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized${waitFlags} -PassThru`,
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

export function windowsWsbConfigLaunchArgs(configPath) {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$ConfigPath = ${psSingleQuote(configPath)}`,
        "$WindowStyle = 'Normal'",
        "$Process = Start-Process -FilePath $ConfigPath -WindowStyle $WindowStyle -PassThru",
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
    const candidates = [
        device?.minimizeWatchdogLaunch?.pid,
        device?.helperSessionLaunch?.minimizeWatchdogPid,
    ].filter((pid, index, values) => Number.isInteger(pid) && pid > 0 && values.indexOf(pid) === index);
    const hasWatchdog = candidates.length > 0 || device?.minimizeWatchdogLaunch != null;
    const cancelPath = windowsHelperMetadata(device).minimizeWatchdogCancelPath;
    const cancellation = hasWatchdog ? cancelWatchdog(cancelPath) : { attempted: false, ok: true, cancelPath };
    if (!cancellation?.ok) return { ok: false, changed: false, cancellation, attempts: [cancellation], device };

    const helperSessionLaunch = device?.helperSessionLaunch && typeof device.helperSessionLaunch === "object"
        ? { ...device.helperSessionLaunch, minimizeWatchdogPid: null }
        : device?.helperSessionLaunch;
    return {
        ok: true,
        changed: hasWatchdog,
        cancellation,
        attempts: cancellation.attempted ? [cancellation] : [],
        device: {
            ...device,
            minimizeWatchdogLaunch: null,
            ...(helperSessionLaunch ? { helperSessionLaunch } : {}),
        },
    };
}

function runWindowsSandboxCommand(wsb, args, timeoutMs, minimized = true, waitForExit = true) {
    if (process.platform === "win32" && minimized) {
        return runWithTimeout("powershell.exe", windowsMinimizedStartProcessArgs(wsb, args, waitForExit), timeoutMs);
    }
    return runWithTimeout(wsb, args, timeoutMs);
}

function startWindowsSandboxDeviceRuntime(wsb, claimedSandboxId, configPath, config, minimized, cancelPath, resultPath) {
    if (process.platform === "win32") {
        const startedAfter = new Date(Date.now() - 2000).toISOString();
        const baselineHandles = minimized ? windowsSandboxWindowHandles() : null;
        const result = runWithTimeout("powershell.exe", windowsWsbConfigLaunchArgs(configPath), WINDOWS_SANDBOX_START_TIMEOUT_MS);
        const minimizeWatchdogLaunch = minimized ? launchWindowsSandboxMinimizeWatchdog(startedAfter, cancelPath, WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, baselineHandles, resultPath) : { ok: true, skipped: true };
        return { ...result, launchMode: "wsb-file", minimizeWatchdogLaunch };
    }
    const result = runWindowsSandboxCommand(wsb, ["start", "--id", claimedSandboxId, "--config", config], WINDOWS_SANDBOX_START_TIMEOUT_MS, minimized, false);
    return { ...result, launchMode: "wsb-cli-start" };
}

function launchWindowsSandboxSession(wsb, sandboxId, minimized = true, options = {}) {
    try {
        const autoMinimizeAfterVisible = options.autoMinimizeAfterVisible === true;
        if (process.platform === "win32" && autoMinimizeAfterVisible) {
            const startedAfter = new Date(Date.now() - 2000).toISOString();
            const baselineHandles = windowsSandboxWindowHandles();
            const child = spawn(wsb, ["connect", "--id", sandboxId], {
                detached: true,
                stdio: "ignore",
                windowsHide: false,
            });
            child.unref();
            const watchdog = spawn("powershell.exe", windowsReadyMinimizeWatchdogArgs(startedAfter, options.cancelPath, WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, baselineHandles), {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            watchdog.unref();
            return { ok: true, pid: child.pid, minimizeWatchdogPid: watchdog.pid, autoMinimizeAfterVisible };
        }
        const useHiddenPowerShell = process.platform === "win32" && (minimized || autoMinimizeAfterVisible);
        const executable = useHiddenPowerShell ? "powershell.exe" : wsb;
        const args = process.platform === "win32" && minimized
            ? windowsMinimizedStartProcessArgs(wsb, ["connect", "--id", sandboxId], false)
            : ["connect", "--id", sandboxId];
        const child = spawn(executable, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: useHiddenPowerShell,
        });
        child.unref();
        return { ok: true, pid: child.pid, autoMinimizeAfterVisible };
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

async function runWindowsHelperBootstrapFallback(device, helper, wsb, timeoutMs) {
    const deadline = Date.now() + Math.min(Math.max(1000, Math.floor(timeoutMs * 0.75)), 45000);
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${helper.guestBootstrapScript}`;
    let lastResult = null;
    let lastAttempts = [];
    let visibleConnectFallback = null;
    while (Date.now() <= deadline) {
        if (existsSync(helper.readyMarkerPath)) {
            return { attempted: true, ok: true, ready: true, command, result: lastResult, attempts: lastAttempts, visibleConnectFallback };
        }
        const remainingMs = Math.max(1000, deadline - Date.now());
        const execution = windowsSandboxExec(wsb, device.sandboxId, command, Math.min(WINDOWS_SANDBOX_EXEC_TIMEOUT_MS, remainingMs));
        lastResult = execution.result;
        lastAttempts = execution.attempts;
        if (execution.ok) {
            return { attempted: true, ok: true, ready: existsSync(helper.readyMarkerPath), command, result: lastResult, attempts: lastAttempts, runAs: execution.runAs, visibleConnectFallback };
        }
        if (!visibleConnectFallback && device.minimized !== false && existingLoginUnavailable(lastResult)) {
            visibleConnectFallback = launchWindowsSandboxSession(wsb, device.sandboxId, false, {
                autoMinimizeAfterVisible: true,
                cancelPath: helper.minimizeWatchdogCancelPath,
            });
            await sleep(2000);
            continue;
        }
        await sleep(500);
    }
    return { attempted: true, ok: false, ready: existsSync(helper.readyMarkerPath), command, result: lastResult, attempts: lastAttempts, visibleConnectFallback };
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

async function runWindowsHelperRequestOnce(device, helper, wsb, requestPath, responsePath, timeoutMs) {
    if (!isGuid(device?.sandboxId)) {
        return { attempted: false, ok: false, command: "", result: null, error: "missing valid sandboxId" };
    }
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const waitMs = Math.min(5000, Math.max(1000, deadline - Date.now()));
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
    const firstTimeoutMs = Math.min(WINDOWS_SANDBOX_EXEC_TIMEOUT_MS, Math.max(1000, deadline - Date.now()));
    try {
        let execution = windowsSandboxExec(wsb, device.sandboxId, command, firstTimeoutMs);
        let visibleConnectFallback = null;
        if (!execution.ok && device.minimized !== false && existingLoginUnavailable(execution.result)) {
            visibleConnectFallback = launchWindowsSandboxSession(wsb, device.sandboxId, false, {
                autoMinimizeAfterVisible: true,
                cancelPath: helper.minimizeWatchdogCancelPath,
            });
            await sleep(2000);
            const remainingMs = Math.max(1000, deadline - Date.now());
            const retry = windowsSandboxExec(wsb, device.sandboxId, command, Math.min(WINDOWS_SANDBOX_EXEC_TIMEOUT_MS, remainingMs));
            execution = {
                ...retry,
                attempts: [...execution.attempts, ...retry.attempts],
            };
        }
        return { attempted: true, ok: execution.ok, command, diagnosticPath, guestStatus: execution.guestStatus, result: execution.result, attempts: execution.attempts, runAs: execution.runAs, visibleConnectFallback };
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
            return { helper, error: `Windows Sandbox helper requires a running sandbox with a valid GUID sandboxId for ${device?.id || "unknown"}` };
        }
        const discovery = windowsDiscovery();
        if (!discovery.available) {
            return { helper, error: `Windows Sandbox helper connect missing prerequisites: ${discovery.missing.join(", ")}` };
        }
        const connected = launchWindowsSandboxSession(discovery.wsb, device.sandboxId, device.minimized !== false);
        if (!connected.ok) {
            return { helper, error: `Windows Sandbox helper session connect launch failed: ${connected.error}` };
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
    while (Date.now() <= deadline) {
        if (existsSync(responsePath)) {
            const parsed = tryReadJsonFile(responsePath);
            if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
                && parsed.value.id === id && parsed.value.type === type) return { helper, response: parsed.value };
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
                    && parsed.value.id === id && parsed.value.type === type) return { helper, response: parsed.value };
                lastResponseParseError = parsed.ok ? "response id or type mismatch" : parsed.error;
            }
        }
        await sleep(100);
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
        bootstrapFallback?.visibleConnectFallback ? `Bootstrap visible connect fallback: ok=${bootstrapFallback.visibleConnectFallback.ok} autoMinimizeAfterVisible=${bootstrapFallback.visibleConnectFallback.autoMinimizeAfterVisible === true} ${bootstrapFallback.visibleConnectFallback.pid ? `pid=${bootstrapFallback.visibleConnectFallback.pid}` : ""} ${bootstrapFallback.visibleConnectFallback.error || ""}` : "",
        bootstrapFallback?.attempts?.length ? `Bootstrap exec attempts: ${execAttemptSummary(bootstrapFallback.attempts)}` : "",
        requestFallback ? `Request exec fallback: attempted=${requestFallback.attempted} ok=${requestFallback.ok} guestStatus=${requestFallback.guestStatus ?? "unknown"} command=${requestFallback.command} ${requestFallback.error || commandSummary(requestFallback.result)}` : "",
        requestFallback?.diagnosticPath ? `Request script stderr: ${readDiagnosticSnippet(requestFallback.diagnosticPath)}` : "",
        requestFallback?.visibleConnectFallback ? `Request visible connect fallback: ok=${requestFallback.visibleConnectFallback.ok} autoMinimizeAfterVisible=${requestFallback.visibleConnectFallback.autoMinimizeAfterVisible === true} ${requestFallback.visibleConnectFallback.pid ? `pid=${requestFallback.visibleConnectFallback.pid}` : ""} ${requestFallback.visibleConnectFallback.error || ""}` : "",
        requestFallback?.attempts?.length ? `Request exec attempts: ${execAttemptSummary(requestFallback.attempts)}` : "",
    ];
    const error = `Windows Sandbox helper did not respond within ${timeoutMs}ms. ${diagnostics.filter(Boolean).join(" | ")}`;
    rmSync(requestPath, { force: true });
    rmSync(responsePath, { force: true });
    rmSync(`${responsePath}.tmp`, { force: true });
    return { helper, error };
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

async function reconcileWindowsRecording(device, helperTimeoutMs = 1000) {
    if (!device?.recording?.active) return { device, statusCheck: null };
    const result = await windowsHelperRequest(device, "record_status", { sessionId: device.recording.sessionId }, helperTimeoutMs);
    if (result.error || !result.response?.ok) return {
        device,
        statusCheck: result.error || result.response?.error || "Windows helper recording status failed",
    };
    if (!result.response.recording?.active) {
        if (device.recording?.localPath) {
            const hostArchivePath = verifiedHelperOutputPath(result.helper, result.response.recording.archivePath || result.response.recording.hostArchivePath, `${device.recording.sessionId}.zip`);
            if (!hostArchivePath) return { device, statusCheck: "Windows helper recording output is missing or unsafe" };
            const localPolicy = validateLocalOutputPath(device.recording.localPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return { device, statusCheck: localPolicy.message };
            mkdirSync(dirname(localPolicy.path), { recursive: true });
            if (hostArchivePath) {
                const copied = copyWindowsSandboxFile(hostArchivePath, localPolicy.path, "windows-helper-recording", WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES);
                if (!copied.ok) return { device, statusCheck: copied.error };
            }
        }
        const expected = device.recording;
        const updated = updateWindowsDevice(device.id, (item) => recordingGenerationMatches(expected, item.recording)
            ? { ...item, recording: null, updatedAt: new Date().toISOString() }
            : item);
        return { device: updated || device, statusCheck: result.response.recording || null };
    }
    return { device, statusCheck: result.response.recording };
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

function claimWindowsLifecycle(deviceId, device, operation) {
    const singleton = readWindowsSingletonLock();
    const singletonClaimId = sameWindowsSingletonOwner(singleton, device, device?.sandboxId) ? singleton?.claimId : null;
    const lifecycle = {
        runtimeId: randomUUID(),
        operation,
        claimedAt: new Date().toISOString(),
        ...(singletonClaimId ? { singletonClaimId } : {}),
    };
    const claimed = {
        ...device,
        status: operation === "delete" ? "deleting" : operation === "stop" ? "stopping" : "starting",
        lifecycle,
        ...(singletonClaimId ? { singletonClaimId } : {}),
        updatedAt: new Date().toISOString(),
    };
    return { lifecycle, claimed, transition: transitionWindowsDevice(deviceId, device, claimed) };
}

function currentWindowsLifecycleDevice(deviceId, lifecycle) {
    const current = findWindowsDevice(deviceId);
    return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
}

function abortWindowsLifecycle(deviceId, lifecycle, original, updates = null) {
    const current = currentWindowsLifecycleDevice(deviceId, lifecycle);
    if (!current) return { matched: false, found: Boolean(findWindowsDevice(deviceId)) };
    const restored = {
        ...current,
        ...(updates || {}),
        status: original.status,
        updatedAt: new Date().toISOString(),
    };
    if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
    else delete restored.lifecycle;
    if (Object.prototype.hasOwnProperty.call(original, "singletonClaimId")) restored.singletonClaimId = original.singletonClaimId;
    else delete restored.singletonClaimId;
    return transitionWindowsDevice(deviceId, current, restored);
}

function bindWindowsLifecycleSingleton(deviceId, claim, original) {
    if (original.status === "stopped" || claim.lifecycle.singletonClaimId) return { ok: true, claim };
    if (!isGuid(original.sandboxId)) {
        return { ok: false, error: `Windows Sandbox device ${original.id} is running but has no valid GUID sandboxId` };
    }
    const singleton = claimWindowsSingleton(original, original.sandboxId, claim.lifecycle.runtimeId);
    if (!singleton.ok) return { ok: false, error: singleton.error };
    const lifecycle = { ...claim.lifecycle, singletonClaimId: singleton.lock.claimId };
    const claimed = {
        ...claim.claimed,
        singletonClaimId: singleton.lock.claimId,
        lifecycle,
        updatedAt: new Date().toISOString(),
    };
    const transition = transitionWindowsDevice(deviceId, claim.claimed, claimed);
    if (!transition.matched) {
        releaseWindowsSingleton({ ...original, singletonClaimId: singleton.lock.claimId }, singleton.lock.claimId);
        return { ok: false, conflict: transition };
    }
    return { ok: true, claim: { ...claim, lifecycle, claimed } };
}

function stopWindowsSandboxDevice(device) {
    if (device.status === "stopped") {
        const singleton = readWindowsSingletonLock();
        if (singleton?.claimId === device.singletonClaimId
            && isGuid(singleton?.sandboxId)
            && sameWindowsSingletonOwner(singleton, device, singleton.sandboxId)) {
            device = {
                ...device,
                status: "running",
                sandboxId: singleton.sandboxId,
            };
        }
    }
    if (device.status !== "stopped" && !windowsSingletonGenerationMatches(device)) {
        return {
            ok: false,
            error: `Windows Sandbox singleton generation is unavailable for ${device.id}; runtime was not stopped`,
        };
    }
    const watchdogCleanup = cleanupWindowsSandboxMinimizeWatchdogs(device);
    if (!watchdogCleanup.ok) {
        return {
            ok: false,
            error: `Failed to stop Windows Sandbox minimize watchdog for ${device.id}: ${watchdogCleanup.attempts.filter((attempt) => !attempt?.ok).map((attempt) => attempt?.error || `pid ${attempt?.pid}`).join(", ")}`,
            watchdogCleanup,
        };
    }
    if (watchdogCleanup.changed) {
        device = watchdogCleanup.device;
    }
    if (device.status === "stopped") {
        const updated = {
            ...device,
            status: "stopped",
            recording: null,
            minimizeWatchdogLaunch: null,
            updatedAt: new Date().toISOString(),
        };
        return { ok: true, device: updated, watchdogCleanup };
    }

    const discovery = windowsDiscovery();
    if (!discovery.available) {
        return {
            ok: false,
            error: `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`,
            device,
        };
    }

    if (!isGuid(device.sandboxId)) {
        return {
            ok: false,
            error: `Windows Sandbox device ${device.id} is running but has no valid GUID sandboxId`,
            device,
        };
    }

    const r = runWithTimeout(discovery.wsb, ["stop", "--id", device.sandboxId], WINDOWS_SANDBOX_STOP_TIMEOUT_MS);
    if (r.status !== 0) {
        return { ok: false, result: r, device };
    }

    const updated = {
        ...device,
        status: "stopped",
        recording: null,
        minimizeWatchdogLaunch: null,
        updatedAt: new Date().toISOString(),
    };
    return { ok: true, device: updated, watchdogCleanup };
}

export function listWindowsDevices() {
    return readWindowsDevices().map((device) => withTargetStatus({ ...device, ownerId: ownerId() }));
}

async function handleWindowsToolUnlocked(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "windows-sandbox" } = args;
            if (backend !== "windows-sandbox") return undefined;
            const discovery = windowsDiscovery();
            return jsonResult({
                ownerId: ownerId(),
                backend,
                devices: readWindowsDevices().map(windowsInventoryDevice),
                discovery,
                hostSandboxes: {
                    provider: "wsb",
                    available: discovery.available,
                    command: discovery.wsb,
                    missing: discovery.missing,
                    lazy: true,
                    singleton: true,
                    lock: readWindowsSingletonLock(),
                    note: "Windows Sandbox does not expose a stable all-sandbox inventory through the baseline wsb CLI; owner definitions are listed without starting sandboxes.",
                },
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, networking = false, clipboard = false, vgpu = false, memoryMb = 4096, minimized = true } = args;
            if (backend !== "windows-sandbox") return undefined;

            const id = deviceId || windowsDeviceId(deviceName);
            const devices = readWindowsDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "windows",
                ownerId: ownerId(),
                networking: Boolean(networking),
                clipboard: Boolean(clipboard),
                vgpu: Boolean(vgpu),
                memoryMb,
                minimized: minimized !== false,
                helper: ensureHelperWorkspace({ id }),
                recording: null,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            const claim = claimWindowsDevice(device);
            if (!claim.ok) {
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${claim.value})`);
            }
            return jsonResult({ device: withTargetStatus(device) });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readWindowsDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            let claim = claimWindowsLifecycle(deviceId, device, "delete");
            if (!claim.transition.matched) return windowsLifecycleConflict(deviceId, "delete-claim", claim.transition);
            const singleton = bindWindowsLifecycleSingleton(deviceId, claim, device);
            if (!singleton.ok) {
                abortWindowsLifecycle(deviceId, claim.lifecycle, device);
                if (singleton.conflict) return windowsLifecycleConflict(deviceId, "delete-singleton", singleton.conflict);
                return textResult(false, singleton.error);
            }
            claim = singleton.claim;
            const stopped = stopWindowsSandboxDevice({ ...claim.claimed, status: device.status });
            if (!stopped.ok) {
                abortWindowsLifecycle(deviceId, claim.lifecycle, device, stopped.device ? {
                    minimizeWatchdogLaunch: stopped.device.minimizeWatchdogLaunch,
                    ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                        ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                        : {}),
                } : null);
                if (stopped.result) return fail(stopped.result);
                return textResult(false, stopped.error || `Failed to stop Windows Sandbox before deleting ${deviceId}`);
            }
            const current = currentWindowsLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) {
                releaseWindowsSingleton(stopped.device, claim.lifecycle.singletonClaimId);
                return windowsLifecycleConflict(deviceId, "delete", { found: Boolean(findWindowsDevice(deviceId)), matched: false });
            }
            const transition = transitionWindowsDevice(deviceId, current, null);
            releaseWindowsSingleton(stopped.device, claim.lifecycle.singletonClaimId);
            if (!transition.matched) return windowsLifecycleConflict(deviceId, "delete", transition);
            removeWindowsScratch(stopped.device);
            return jsonResult({ deleted: deviceId, scratchRemoved: windowsScratchDir(device) });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: withTargetStatus({ ...device, helper: windowsHelperMetadata(device) }), backend: windowsBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (device.status !== "stopped") {
                return textResult(false, `Refusing to start ${deviceId} while status is ${device.status}`);
            }

            const discovery = windowsDiscovery();
            if (!discovery.available) {
                return textResult(false, `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            const lifecycleClaim = claimWindowsLifecycle(deviceId, device, "start");
            if (!lifecycleClaim.transition.matched) return windowsLifecycleConflict(deviceId, "start-claim", lifecycleClaim.transition);

            const helper = windowsHelperMetadata(device);
            const configPath = writeWsbConfig(device);
            const config = readWsbConfig(configPath);
            resetWindowsHelperSessionMarkers(helper);
            const claimedSandboxId = windowsRuntimeSandboxId(device);
            const lock = claimWindowsSingleton(device, claimedSandboxId, lifecycleClaim.lifecycle.runtimeId);
            if (!lock.ok) {
                abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                return textResult(false, lock.error);
            }
            const starting = {
                ...lifecycleClaim.claimed,
                sandboxId: claimedSandboxId,
                singletonClaimId: lock.lock.claimId,
                lifecycle: { ...lifecycleClaim.lifecycle, singletonClaimId: lock.lock.claimId },
                updatedAt: new Date().toISOString(),
            };
            const lockTransition = transitionWindowsDevice(deviceId, lifecycleClaim.claimed, starting);
            if (!lockTransition.matched) {
                releaseWindowsSingleton({ ...device, sandboxId: claimedSandboxId }, lock.lock.claimId);
                return windowsLifecycleConflict(deviceId, "start-lock", lockTransition);
            }
            const minimized = typeof args.minimized === "boolean" ? args.minimized : device.minimized !== false;
            let previousRuntimeIds = [];
            if (process.platform === "win32") {
                const beforeLaunch = listWindowsSandboxRuntimeIds(discovery.wsb);
                if (!beforeLaunch.ok) {
                    releaseWindowsSingleton(starting, lock.lock.claimId);
                    abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                    return fail(beforeLaunch.result);
                }
                if (beforeLaunch.ids.length > 0) {
                    releaseWindowsSingleton(starting, lock.lock.claimId);
                    abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                    return textResult(false, `Windows Sandbox already has a running runtime before ${deviceId} start: ${beforeLaunch.ids.join(", ")}. Stop it before starting an owner-scoped device.`);
                }
                previousRuntimeIds = beforeLaunch.ids;
            }
            const r = startWindowsSandboxDeviceRuntime(discovery.wsb, claimedSandboxId, configPath, config, minimized, helper.minimizeWatchdogCancelPath, helper.minimizeWatchdogResultPath);
            if (r.status !== 0) {
                releaseWindowsSingleton(starting, lock.lock.claimId);
                abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                return fail(r);
            }
            const registered = await waitForWindowsSandboxRuntime(discovery.wsb, claimedSandboxId, WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS, {
                previousIds: previousRuntimeIds,
                requireNewRuntime: r.launchMode === "wsb-file",
            });
            if (!registered.ok) {
                const watchdogCleanup = cleanupWindowsSandboxMinimizeWatchdogs({
                    ...device,
                    minimizeWatchdogLaunch: r.minimizeWatchdogLaunch,
                });
                const cleanupIds = r.launchMode === "wsb-file" ? (registered.newIds || []) : [claimedSandboxId];
                const cleanup = stopWindowsSandboxRuntimeIds(discovery.wsb, cleanupIds);
                let releaseLockAfterFailure = cleanupIds.length === 0 && registered.result?.status === 0;
                let cleanupVerify = null;
                if (cleanupIds.length > 0) {
                    if (cleanup.ok) {
                        releaseLockAfterFailure = true;
                    } else {
                        cleanupVerify = listWindowsSandboxRuntimeIds(discovery.wsb);
                        releaseLockAfterFailure = cleanupVerify.ok
                            && cleanupIds.every((id) => !cleanupVerify.ids.includes(String(id).toLowerCase()));
                    }
                }
                const runtimeGone = releaseLockAfterFailure;
                if (!watchdogCleanup.ok) {
                    const current = currentWindowsLifecycleDevice(deviceId, lifecycleClaim.lifecycle);
                    if (current) transitionWindowsDevice(deviceId, current, {
                        ...current,
                        minimizeWatchdogLaunch: r.minimizeWatchdogLaunch,
                        updatedAt: new Date().toISOString(),
                    });
                    releaseLockAfterFailure = false;
                }
                if (releaseLockAfterFailure) {
                    releaseWindowsSingleton(starting, lock.lock.claimId);
                    abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                }
                const detail = registered.result
                    ? ` status=${registered.result.status} stderr=${registered.result.stderr || ""} stdout=${registered.result.stdout || ""} error=${registered.result.error?.message || ""}`
                    : "";
                const cleanupDetail = cleanupIds.length > 0
                    ? ` cleanupStopped=${cleanup.stopped.join(",") || "<none>"} cleanupFailed=${cleanup.failed.map((item) => item.id).join(",") || "<none>"} cleanupVerifiedGone=${cleanupVerify ? runtimeGone : cleanup.ok} lockRetained=${!releaseLockAfterFailure}`
                    : " cleanupSkipped=no-new-runtime-observed";
                const watchdogDetail = watchdogCleanup.ok
                    ? " minimizeWatchdogCleaned=true"
                    : ` minimizeWatchdogCleaned=false error=${watchdogCleanup.attempts.filter((attempt) => !attempt?.ok).map((attempt) => attempt?.error || `pid ${attempt?.pid}`).join(",")}`;
                return textResult(false, `${registered.error}.${detail}${cleanupDetail}${watchdogDetail}`);
            }
            const sandboxId = registered.sandboxId || claimedSandboxId;
            if (sandboxId !== claimedSandboxId) {
                const singletonUpdated = updateWindowsSingletonRuntimeId(starting, claimedSandboxId, sandboxId, lock.lock.claimId);
                if (!singletonUpdated) {
                    const watchdogCleanup = cleanupWindowsSandboxMinimizeWatchdogs({ ...starting, sandboxId, minimizeWatchdogLaunch: r.minimizeWatchdogLaunch });
                    const cleanup = stopWindowsSandboxRuntimeIds(discovery.wsb, [sandboxId]);
                    if (cleanup.ok && watchdogCleanup.ok) abortWindowsLifecycle(deviceId, lifecycleClaim.lifecycle, device);
                    return textResult(false, JSON.stringify({
                        ok: false,
                        error: "windows-sandbox-singleton-generation-conflict",
                        backend: "windows-sandbox",
                        deviceId,
                        runtimeStopped: cleanup.ok,
                        watchdogCleaned: watchdogCleanup.ok,
                    }));
                }
            }
            let minimizeConfirmation = null;
            if (r.minimizeWatchdogLaunch?.ok === false) {
                minimizeConfirmation = {
                    ok: false,
                    error: r.minimizeWatchdogLaunch.error || "Windows Sandbox minimize watchdog failed to start",
                };
            } else if (minimized && process.platform === "win32") {
                minimizeConfirmation = await waitForWindowsSandboxMinimizeConfirmation(helper.minimizeWatchdogResultPath);
            }
            const helperSessionLaunch = r.launchMode === "wsb-file"
                ? { ok: true, skipped: true, reason: "wsb-file launch creates the interactive Sandbox session", launchMode: r.launchMode, minimizeWatchdogLaunch: r.minimizeWatchdogLaunch }
                : launchWindowsSandboxSession(discovery.wsb, sandboxId, minimized);

            const updated = {
                ...starting,
                status: "running",
                sandboxId,
                ...(sandboxId !== claimedSandboxId ? { requestedSandboxId: claimedSandboxId } : {}),
                configPath,
                launchMode: r.launchMode,
                minimizeWatchdogLaunch: r.minimizeWatchdogLaunch,
                minimized,
                minimizeConfirmed: minimizeConfirmation?.ok === true,
                minimizeWarning: minimizeConfirmation?.ok === false ? minimizeConfirmation.error : null,
                helper: windowsHelperMetadata(starting),
                helperSessionLaunch,
                updatedAt: new Date().toISOString(),
            };
            const transition = transitionWindowsDevice(deviceId, starting, updated);
            if (!transition.matched) {
                const watchdogCleanup = cleanupWindowsSandboxMinimizeWatchdogs({ ...starting, sandboxId, minimizeWatchdogLaunch: r.minimizeWatchdogLaunch, helperSessionLaunch });
                const cleanup = stopWindowsSandboxRuntimeIds(discovery.wsb, [sandboxId]);
                if (cleanup.ok && watchdogCleanup.ok) releaseWindowsSingleton({ ...starting, sandboxId }, lock.lock.claimId);
                return windowsLifecycleConflict(deviceId, "start-complete", transition, {
                    runtimeStopped: cleanup.ok,
                    watchdogCleaned: watchdogCleanup.ok,
                    singletonReleased: cleanup.ok && watchdogCleanup.ok,
                });
            }
            return jsonResult({ device: withTargetStatus(updated) });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            let claim = claimWindowsLifecycle(deviceId, device, "stop");
            if (!claim.transition.matched) return windowsLifecycleConflict(deviceId, "stop-claim", claim.transition);
            const singleton = bindWindowsLifecycleSingleton(deviceId, claim, device);
            if (!singleton.ok) {
                abortWindowsLifecycle(deviceId, claim.lifecycle, device);
                if (singleton.conflict) return windowsLifecycleConflict(deviceId, "stop-singleton", singleton.conflict);
                return textResult(false, singleton.error);
            }
            claim = singleton.claim;
            const stopped = stopWindowsSandboxDevice({ ...claim.claimed, status: device.status });
            if (!stopped.ok) {
                abortWindowsLifecycle(deviceId, claim.lifecycle, device, stopped.device ? {
                    minimizeWatchdogLaunch: stopped.device.minimizeWatchdogLaunch,
                    ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                        ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                        : {}),
                } : null);
                if (stopped.result) return fail(stopped.result);
                return textResult(false, stopped.error || `Failed to stop Windows Sandbox device ${deviceId}`);
            }
            const current = currentWindowsLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) {
                releaseWindowsSingleton(stopped.device, claim.lifecycle.singletonClaimId);
                return windowsLifecycleConflict(deviceId, "stop", { found: Boolean(findWindowsDevice(deviceId)), matched: false });
            }
            const updated = {
                ...current,
                ...(Object.prototype.hasOwnProperty.call(stopped.device, "helperSessionLaunch")
                    ? { helperSessionLaunch: stopped.device.helperSessionLaunch }
                    : {}),
                lifecycle: null,
                singletonClaimId: null,
                status: "stopped",
                updatedAt: new Date().toISOString(),
            };
            const transition = transitionWindowsDevice(deviceId, current, updated);
            releaseWindowsSingleton(stopped.device, claim.lifecycle.singletonClaimId);
            if (!transition.matched) return windowsLifecycleConflict(deviceId, "stop", transition);
            return jsonResult({ device: withTargetStatus(updated) });
        }

        case "device_exec": {
            const { deviceId, command, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "exec", { command }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper exec failed");
            return jsonResult({
                stdout: result.response.stdout || "",
                stderr: result.response.stderr || "",
                status: result.response.status ?? 0,
                provider: "windows-helper",
            });
        }

        case "device_screenshot": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "screenshot", {}, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper screenshot failed");
            const imagePath = verifiedHelperOutputPath(result.helper, result.response.imagePath || result.response.hostImagePath, `${result.response.id}.png`);
            if (!imagePath) return textResult(false, "Windows helper screenshot output is missing or unsafe");
            try {
                const image = readDeviceLabBinaryFile(imagePath, "windows-helper-screenshot", WINDOWS_SANDBOX_SCREENSHOT_LIMIT_BYTES);
                if (!image) return textResult(false, `Windows helper screenshot output missing: ${imagePath}`);
                return { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
            } catch (error) {
                return textResult(false, `Windows helper screenshot output is invalid: ${error?.code || error?.message || String(error)}`);
            }
        }

        case "device_click":
        case "device_double_click": {
            const { deviceId, x, y, button = "left", helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return textResult(false, `${name} requires numeric x and y`);
            const type = name === "device_double_click" ? "double_click" : "click";
            const result = await windowsHelperRequest(device, type, { x: Number(x), y: Number(y), button }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || `Windows helper ${type} failed`);
            return jsonResult({
                provider: "windows-helper",
                [name === "device_double_click" ? "doubleClicked" : "clicked"]: result.response.doubleClicked || result.response.clicked || { x: Number(x), y: Number(y), button },
                response: result.response,
            });
        }

        case "device_key": {
            const { deviceId, key, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!key) return textResult(false, "device_key requires key");
            const keys = windowsSendKeysExpression(key);
            const result = await windowsHelperRequest(device, "key", { key, keys }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper key failed");
            return jsonResult({ provider: "windows-helper", key: result.response.key || { key, keys }, response: result.response });
        }

        case "device_type": {
            const { deviceId, text, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (text === undefined || text === null) return textResult(false, "device_type requires text");
            const literalText = String(text);
            const keys = windowsSendKeysLiteralText(literalText);
            const result = await windowsHelperRequest(device, "type", { text: literalText, keys }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper type failed");
            return jsonResult({ provider: "windows-helper", typed: result.response.typed || { text: literalText, keys }, response: result.response });
        }

        case "device_scroll": {
            const { deviceId, x, y, direction = "down", amount = 1, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return textResult(false, "device_scroll requires numeric x and y");
            if (!["up", "down", "left", "right"].includes(direction)) return textResult(false, "device_scroll direction must be up, down, left, or right");
            const result = await windowsHelperRequest(device, "scroll", { x: Number(x), y: Number(y), direction, amount: Number(amount) || 1 }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper scroll failed");
            return jsonResult({ provider: "windows-helper", scrolled: result.response.scrolled || { x: Number(x), y: Number(y), direction, amount: Number(amount) || 1 }, response: result.response });
        }

        case "device_cursor_position": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "cursor_position", {}, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper cursor position failed");
            return jsonResult({ provider: "windows-helper", cursor: result.response.cursor || null, response: result.response });
        }

        case "device_window_list": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "window_list", {}, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper window list failed");
            return jsonResult({
                provider: result.response.provider || "windows-process-main-window",
                windows: Array.isArray(result.response.windows) ? result.response.windows : [],
                response: result.response,
            });
        }

        case "device_accessibility_snapshot": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const maxDepth = Math.max(0, Math.min(Number.isFinite(Number(args.maxDepth)) ? Number(args.maxDepth) : 3, 8));
            const maxNodes = Math.max(1, Math.min(Number.isFinite(Number(args.maxNodes)) ? Number(args.maxNodes) : 200, 1000));
            const result = await windowsHelperRequest(device, "accessibility_snapshot", { maxDepth, maxNodes }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper accessibility snapshot failed");
            return jsonResult({
                provider: result.response.accessibility?.provider || "windows-uiautomation",
                accessibility: result.response.accessibility || null,
                response: result.response,
            });
        }

        case "device_record_video_status": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const reconciled = await reconcileWindowsRecording(device, helperTimeoutMs || 1000);
            return jsonResult({
                deviceId,
                recording: reconciled.device.recording || null,
                provider: "windows-helper-frame-archive",
                helper: reconciled.statusCheck || null,
            });
        }

        case "device_record_video_start": {
            const { deviceId, localPath, timeLimitSec, helperTimeoutMs } = args;
            let device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (device.recording?.active) {
                const reconciled = await reconcileWindowsRecording(device, helperTimeoutMs || 1000);
                device = reconciled.device;
                if (device.recording?.active) return textResult(false, `Windows Sandbox recording already active for ${deviceId}`);
            }
            const sessionId = `recording-${randomUUID()}`;
            const resolvedLocalPath = localPath || windowsRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const intervalMs = timeLimitSec && timeLimitSec < 30 ? 500 : 1000;
            const result = await windowsHelperRequest(device, "record_start", { sessionId, intervalMs, timeLimitSec: timeLimitSec || 0 }, helperTimeoutMs || 5000);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper recording start failed");
            const recording = {
                active: true,
                provider: "windows-helper-frame-archive",
                runtimeId: randomUUID(),
                sessionId,
                localPath: safeLocalPath,
                remotePath: result.response.recording?.frameDir || null,
                timeLimitSec: timeLimitSec || null,
                startedAt: new Date().toISOString(),
            };
            const committed = transitionRecordingGeneration(updateWindowsDevice, deviceId, device.recording ?? null, recording);
            if (!committed.committed) {
                await windowsHelperRequest(device, "record_stop", { sessionId }, helperTimeoutMs || 5000);
                return textResult(false, `Windows Sandbox recording state changed while starting for ${deviceId}; the new recorder was stopped.`);
            }
            return jsonResult({ deviceId, recording: committed.device.recording, helper: result.response.recording || null });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording?.active) return textResult(false, `No Windows Sandbox recording active for ${deviceId}`);
            const previous = device.recording;
            const resolvedLocalPath = localPath || previous.localPath || windowsRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            const result = await windowsHelperRequest(device, "record_stop", { sessionId: device.recording.sessionId }, helperTimeoutMs || 10000);
            if (result.error) {
                return textResult(false, `${result.error}. Windows Sandbox recording state preserved for retry for ${deviceId}.`);
            }
            if (!result.response.ok) {
                return textResult(false, `${result.response.error || "Windows helper recording stop failed"}. Windows Sandbox recording state preserved for retry for ${deviceId}.`);
            }
            const hostArchivePath = verifiedHelperOutputPath(result.helper, result.response.recording?.archivePath || result.response.recording?.hostArchivePath, `${previous.sessionId}.zip`);
            if (!hostArchivePath) return textResult(false, `Windows helper recording output is missing or unsafe. Windows Sandbox recording state preserved for retry for ${deviceId}.`);
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const copied = copyWindowsSandboxFile(hostArchivePath, safeLocalPath, "windows-helper-recording", WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES);
            if (!copied.ok) return textResult(false, `Windows helper recording output copy failed: ${copied.error}. Windows Sandbox recording state preserved for retry for ${deviceId}.`);
            const cleared = transitionRecordingGeneration(updateWindowsDevice, deviceId, previous, null);
            const updated = cleared.device;
            if (!cleared.committed && updated?.recording) {
                return textResult(false, `Windows Sandbox recording state changed while stopping for ${deviceId}; successor state was preserved.`);
            }
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "windows-helper-frame-archive",
                recording: { ...previous, active: false, localPath: safeLocalPath, stoppedAt: new Date().toISOString() },
                device: updated,
                helper: result.response.recording || null,
            });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const helper = ensureHelperWorkspace(device, false);
            const remotePolicy = validateWindowsGuestTransferPath(remotePath, helper, "upload-remote-path");
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localPolicy = validateLocalInputPath(localPath, { label: "upload-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const uploadId = randomUUID();
            const uploadName = `${uploadId}-${basename(localPath).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            const hostUploadPath = join(helper.uploadsDir, uploadName);
            try {
                assertDeviceLabPathWithinRoot(helper.uploadsDir, hostUploadPath, "windows-helper-upload");
            } catch (error) {
                return textResult(false, `Windows helper upload staging path is unsafe: ${error?.code || error?.message || String(error)}`);
            }
            const staged = copyWindowsSandboxFile(localPolicy.path, hostUploadPath, "windows-helper-upload", WINDOWS_SANDBOX_UPLOAD_LIMIT_BYTES);
            if (!staged.ok) return textResult(false, `Windows helper upload staging failed: ${staged.error}`);
            try {
                const result = await windowsHelperRequest(device, "upload", {
                    uploadPath: `${helper.guestUploadsDir}\\${uploadName}`,
                    remotePath: remotePolicy.path,
                }, helperTimeoutMs);
                if (result.error) return textResult(false, result.error);
                if (!result.response.ok) return textResult(false, result.response.error || "Windows helper upload failed");
                return jsonResult({ uploaded: { localPath: localPolicy.path, remotePath: remotePolicy.path }, provider: "windows-helper", response: result.response });
            } finally {
                rmSync(hostUploadPath, { force: true });
            }
        }

        case "device_download": {
            const { deviceId, remotePath, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const helper = ensureHelperWorkspace(device, false);
            const remotePolicy = validateWindowsGuestTransferPath(remotePath, helper, "download-remote-path");
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localPolicy = validateLocalOutputPath(localPath, { label: "download-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const result = await windowsHelperRequest(device, "download", { remotePath: remotePolicy.path }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper download failed");
            const hostDownloadPath = verifiedHelperOutputPath(result.helper, result.response.downloadPath || result.response.hostDownloadPath, `${result.response.id}-${windowsPathBasename(remotePolicy.path)}`);
            if (!hostDownloadPath) return textResult(false, "Windows helper download output is missing or unsafe");
            const copied = copyWindowsSandboxFile(hostDownloadPath, localPolicy.path, "windows-helper-download", WINDOWS_SANDBOX_OUTPUT_LIMIT_BYTES);
            if (!copied.ok) return textResult(false, `Windows helper download output copy failed: ${copied.error}`);
            return jsonResult({ downloaded: { remotePath: remotePolicy.path, localPath: localPolicy.path }, provider: "windows-helper", response: result.response });
        }

        default:
            return undefined;
    }
}

export async function handleWindowsTool(name, args) {
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
