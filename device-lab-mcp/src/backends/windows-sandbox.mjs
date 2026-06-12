import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findWindowsDevice, readWindowsDevices, updateWindowsDevice, writeWindowsDevices } from "../state/windows-state.mjs";

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
    return {
        ...device,
        ownerId: ownerId(),
        helper: windowsHelperMetadata(device),
        configPath: wsbConfigPath(device),
    };
}

function windowsDeviceId(name) {
    return `windows-${slug(name)}`;
}

function windowsScratchDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "windows", device.id);
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
        guestScratchDir: "C:\\ccc\\scratch",
        guestToolsDir: "C:\\ccc\\tools",
        guestInboxDir: "C:\\ccc\\scratch\\inbox",
        guestOutboxDir: "C:\\ccc\\scratch\\outbox",
        guestUploadsDir: "C:\\ccc\\scratch\\uploads",
        guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
        status: "file-channel",
        requiredFor: ["device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_accessibility_snapshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
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

function windowsHelperScript(helper) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$Inbox = '${helper.guestInboxDir}'`,
        `$Outbox = '${helper.guestOutboxDir}'`,
        `$Uploads = '${helper.guestUploadsDir}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$Recordings = @{}",
        "New-Item -ItemType Directory -Force -Path $Inbox,$Outbox,$Uploads,$Downloads | Out-Null",
        "while ($true) {",
        "  Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {",
        "    $RequestPath = $_.FullName",
        "    $Request = $null",
        "    try {",
        "      $Request = Get-Content -Raw -Path $RequestPath | ConvertFrom-Json",
        "      $Response = [ordered]@{ id = $Request.id; ok = $true; type = $Request.type }",
        "      switch ($Request.type) {",
        "        'exec' {",
        "          $StdoutPath = Join-Path $Downloads ($Request.id + '.stdout.txt')",
        "          $StderrPath = Join-Path $Downloads ($Request.id + '.stderr.txt')",
        "          $Process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-Command',$Request.command) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -Wait -PassThru",
        "          $Response.stdout = if (Test-Path $StdoutPath) { Get-Content -Raw -Path $StdoutPath } else { '' }",
        "          $Response.stderr = if (Test-Path $StderrPath) { Get-Content -Raw -Path $StderrPath } else { '' }",
        "          $Response.status = $Process.ExitCode",
        "        }",
        "        'screenshot' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "          $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height",
        "          $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)",
        "          $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)",
        "          $OutputPath = Join-Path $Downloads ($Request.id + '.png')",
        "          $Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "          $Graphics.Dispose(); $Bitmap.Dispose()",
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
        "              Compress-Archive -Path (Join-Path $Entry.frameDir '*') -DestinationPath $ArchivePath -Force",
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
        "          Compress-Archive -Path (Join-Path $Entry.frameDir '*') -DestinationPath $ArchivePath -Force",
        "          $Recordings.Remove($SessionId)",
        "          $Response.recording = @{ sessionId = $SessionId; active = $false; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }",
        "        }",
        "        default { throw \"Unknown request type: $($Request.type)\" }",
        "      }",
        "    } catch {",
        "      $RequestId = if ($Request -and $Request.id) { $Request.id } else { [IO.Path]::GetFileNameWithoutExtension($RequestPath) }",
        "      $Response = [ordered]@{ id = $RequestId; ok = $false; error = $_.Exception.Message }",
        "    }",
        "    $Response | ConvertTo-Json -Depth 32 | Set-Content -Path (Join-Path $Outbox ($Response.id + '.json')) -Encoding UTF8",
        "    Remove-Item -Force -Path $RequestPath",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "",
    ].join("\n");
}

function ensureHelperWorkspace(device) {
    const helper = windowsHelperMetadata(device);
    for (const dir of [helper.scratchDir, helper.toolsDir, helper.inboxDir, helper.outboxDir, helper.uploadsDir, helper.downloadsDir, windowsRecordingDir(device)]) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(helper.hostHelperScript, windowsHelperScript(helper), { mode: 0o600 });
    return helper;
}

function writeWsbConfig(device) {
    const helper = ensureHelperWorkspace(device);
    const scratch = helper.scratchDir;
    const tools = helper.toolsDir;
    const networking = device.networking === true ? "Enable" : "Disable";
    const clipboard = device.clipboard === true ? "Enable" : "Disable";
    const vgpu = device.vgpu === true ? "Enable" : "Disable";
    const memoryMb = device.memoryMb || 4096;
    const config = [
        "<Configuration>",
        `  <VGpu>${vgpu}</VGpu>`,
        `  <Networking>${networking}</Networking>`,
        `  <ClipboardRedirection>${clipboard}</ClipboardRedirection>`,
        `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
        "  <MappedFolders>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(scratch)}</HostFolder>`,
        `      <SandboxFolder>${escapeXml(helper.guestScratchDir)}</SandboxFolder>`,
        "      <ReadOnly>false</ReadOnly>",
        "    </MappedFolder>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(tools)}</HostFolder>`,
        `      <SandboxFolder>${escapeXml(helper.guestToolsDir)}</SandboxFolder>`,
        "      <ReadOnly>true</ReadOnly>",
        "    </MappedFolder>",
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>powershell.exe -ExecutionPolicy Bypass -File ${escapeXml(helper.guestToolsDir)}\\ccc-guest-helper.ps1</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\n");
    const path = wsbConfigPath(device);
    writeFileSync(path, config, { mode: 0o600 });
    return path;
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function windowsHelperRequest(device, type, payload = {}, timeoutMs = 5000) {
    const helper = ensureHelperWorkspace(device);
    const id = randomUUID();
    const requestPath = join(helper.inboxDir, `${id}.json`);
    const responsePath = join(helper.outboxDir, `${id}.json`);
    writeFileSync(requestPath, JSON.stringify({ id, type, ...payload }, null, 2), { mode: 0o600 });

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (existsSync(responsePath)) {
            const response = JSON.parse(readFileSync(responsePath, "utf-8"));
            return { helper, response };
        }
        await sleep(100);
    }
    return { helper, error: `Windows Sandbox helper did not respond within ${timeoutMs}ms. Inbox: ${helper.inboxDir}` };
}

function windowsPathBasename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function helperOutputPath(helper, responseValue, fallbackName) {
    if (!responseValue) return join(helper.downloadsDir, fallbackName);
    if (existsSync(responseValue)) return responseValue;
    return join(helper.downloadsDir, windowsPathBasename(responseValue));
}

async function reconcileWindowsRecording(device, helperTimeoutMs = 1000) {
    if (!device?.recording?.active) return { device, statusCheck: null };
    const result = await windowsHelperRequest(device, "record_status", { sessionId: device.recording.sessionId }, helperTimeoutMs);
    if (result.error || !result.response?.ok) return {
        device,
        statusCheck: result.error || result.response?.error || "Windows helper recording status failed",
    };
    if (!result.response.recording?.active) {
        if (result.response.recording?.archivePath && device.recording?.localPath) {
            const hostArchivePath = result.response.recording.hostArchivePath || helperOutputPath(result.helper, result.response.recording.archivePath, `${device.recording.sessionId}.zip`);
            mkdirSync(dirname(device.recording.localPath), { recursive: true });
            if (existsSync(hostArchivePath)) copyFileSync(hostArchivePath, device.recording.localPath);
        }
        const updated = updateWindowsDevice(device.id, (item) => ({
            ...item,
            recording: null,
            updatedAt: new Date().toISOString(),
        }));
        return { device: updated || { ...device, recording: null }, statusCheck: result.response.recording || null };
    }
    return { device, statusCheck: result.response.recording };
}

function stopWindowsSandboxDevice(device) {
    if (device.status === "stopped") {
        const updated = updateWindowsDevice(device.id, (item) => ({
            ...item,
            status: "stopped",
            recording: null,
            updatedAt: new Date().toISOString(),
        }));
        return { ok: true, device: updated || { ...device, status: "stopped", recording: null } };
    }

    const discovery = windowsDiscovery();
    if (!discovery.available) {
        return {
            ok: false,
            error: `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`,
        };
    }

    const r = run(discovery.wsb, ["stop"]);
    if (r.status !== 0) {
        return { ok: false, result: r };
    }

    const updated = updateWindowsDevice(device.id, (item) => ({
        ...item,
        status: "stopped",
        recording: null,
        updatedAt: new Date().toISOString(),
    }));
    return { ok: true, device: updated || { ...device, status: "stopped", recording: null } };
}

export function listWindowsDevices() {
    return readWindowsDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleWindowsTool(name, args) {
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
                    note: "Windows Sandbox does not expose a stable all-sandbox inventory through the baseline wsb CLI; owner definitions are listed without starting sandboxes.",
                },
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, networking = false, clipboard = false, vgpu = false, memoryMb = 4096 } = args;
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
                helper: ensureHelperWorkspace({ id }),
                recording: null,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeWindowsDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readWindowsDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            if (device.status !== "stopped") {
                const stopped = stopWindowsSandboxDevice(device);
                if (!stopped.ok) {
                    if (stopped.result) return fail(stopped.result);
                    return textResult(false, stopped.error || `Failed to stop Windows Sandbox before deleting ${deviceId}`);
                }
            }
            removeWindowsScratch(device);
            writeWindowsDevices(readWindowsDevices().filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId, scratchRemoved: windowsScratchDir(device) });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: { ...device, helper: windowsHelperMetadata(device) }, backend: windowsBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const discovery = windowsDiscovery();
            if (!discovery.available) {
                return textResult(false, `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            const configPath = writeWsbConfig(device);
            const r = run(discovery.wsb, ["start", configPath]);
            if (r.status !== 0) return fail(r);

            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                status: "running",
                configPath,
                helper: windowsHelperMetadata(item),
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const stopped = stopWindowsSandboxDevice(device);
            if (!stopped.ok) {
                if (stopped.result) return fail(stopped.result);
                return textResult(false, stopped.error || `Failed to stop Windows Sandbox device ${deviceId}`);
            }
            return jsonResult({ device: stopped.device });
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
            const imagePath = result.response.hostImagePath || helperOutputPath(result.helper, result.response.imagePath, `${result.response.id}.png`);
            if (!existsSync(imagePath)) return textResult(false, `Windows helper screenshot output missing: ${imagePath}`);
            return { content: [{ type: "image", data: readFileSync(imagePath).toString("base64"), mimeType: "image/png" }] };
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
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            const intervalMs = timeLimitSec && timeLimitSec < 30 ? 500 : 1000;
            const result = await windowsHelperRequest(device, "record_start", { sessionId, intervalMs, timeLimitSec: timeLimitSec || 0 }, helperTimeoutMs || 5000);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper recording start failed");
            const recording = {
                active: true,
                provider: "windows-helper-frame-archive",
                sessionId,
                localPath: resolvedLocalPath,
                remotePath: result.response.recording?.frameDir || null,
                timeLimitSec: timeLimitSec || null,
                startedAt: new Date().toISOString(),
            };
            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                recording,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ deviceId, recording: updated.recording, helper: result.response.recording || null });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording?.active) return textResult(false, `No Windows Sandbox recording active for ${deviceId}`);
            const result = await windowsHelperRequest(device, "record_stop", { sessionId: device.recording.sessionId }, helperTimeoutMs || 10000);
            const previous = device.recording;
            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
            if (result.error) return textResult(false, `${result.error}. Windows Sandbox recording state cleared for ${deviceId}.`);
            if (!result.response.ok) return textResult(false, `${result.response.error || "Windows helper recording stop failed"}. Windows Sandbox recording state cleared for ${deviceId}.`);
            const hostArchivePath = result.response.recording?.hostArchivePath || helperOutputPath(result.helper, result.response.recording?.archivePath, `${previous.sessionId}.zip`);
            const resolvedLocalPath = localPath || previous.localPath || windowsRecordingLocalPath(device);
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            if (existsSync(hostArchivePath)) copyFileSync(hostArchivePath, resolvedLocalPath);
            if (!existsSync(resolvedLocalPath)) return textResult(false, `Windows helper recording output missing: ${hostArchivePath}. Windows Sandbox recording state cleared for ${deviceId}.`);
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "windows-helper-frame-archive",
                recording: { ...previous, active: false, localPath: resolvedLocalPath, stoppedAt: new Date().toISOString() },
                device: updated,
                helper: result.response.recording || null,
            });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const helper = ensureHelperWorkspace(device);
            const uploadId = randomUUID();
            const uploadName = `${uploadId}-${basename(localPath).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            const hostUploadPath = join(helper.uploadsDir, uploadName);
            copyFileSync(localPath, hostUploadPath);
            const result = await windowsHelperRequest(device, "upload", {
                uploadPath: `${helper.guestUploadsDir}\\${uploadName}`,
                remotePath,
            }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper upload failed");
            return jsonResult({ uploaded: { localPath, remotePath }, provider: "windows-helper", response: result.response });
        }

        case "device_download": {
            const { deviceId, remotePath, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "download", { remotePath }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper download failed");
            const hostDownloadPath = result.response.hostDownloadPath || helperOutputPath(result.helper, result.response.downloadPath, `${result.response.id}-${windowsPathBasename(remotePath)}`);
            if (!existsSync(hostDownloadPath)) return textResult(false, `Windows helper download output missing: ${hostDownloadPath}`);
            copyFileSync(hostDownloadPath, localPath);
            return jsonResult({ downloaded: { remotePath, localPath }, provider: "windows-helper", response: result.response });
        }

        default:
            return undefined;
    }
}
