param([string]$OnceRequestPath = '')
$ErrorActionPreference = 'Stop'
$Inbox = 'C:\ccc\scratch\inbox'
$Outbox = 'C:\ccc\scratch\outbox'
$Uploads = 'C:\ccc\scratch\uploads'
$Downloads = 'C:\ccc\scratch\downloads'
$Recordings = @{}
New-Item -ItemType Directory -Force -Path $Inbox,$Outbox,$Uploads,$Downloads | Out-Null
$HeartbeatPath = Join-Path $Downloads 'ccc-guest-helper.heartbeat.txt'
function Write-CccHeartbeat {
    try {
      $Names = @(Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
      Set-Content -Path $HeartbeatPath -Value @(
        ('heartbeat ' + (Get-Date).ToString('o')),
        ('inbox-exists ' + (Test-Path $Inbox)),
        ('outbox-exists ' + (Test-Path $Outbox)),
        ('inbox-count ' + $Names.Count),
        ('inbox-files ' + (($Names | Select-Object -First 20) -join ', '))
      ) -Encoding UTF8
    } catch {
      Set-Content -Path $HeartbeatPath -Value ('heartbeat-error ' + $_.Exception.Message) -Encoding UTF8
    }
}
function Write-CccJson {
    param([string]$Path, [object]$Value)
    $Json = $Value | ConvertTo-Json -Depth 32
    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Json, $Utf8NoBom)
}
function Compress-CccDirectory {
    param([string]$SourcePath, [string]$DestinationPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $DestinationPath) { Remove-Item -Force -LiteralPath $DestinationPath }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($SourcePath, $DestinationPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
}
function Invoke-CccRequest {
    param([string]$RequestPath)
    $Request = $null
    try {
      if (-not (Test-Path -LiteralPath $RequestPath)) { return }
      $Request = Get-Content -Raw -LiteralPath $RequestPath | ConvertFrom-Json
      $Response = [ordered]@{ id = $Request.id; ok = $true; type = $Request.type }
      switch ($Request.type) {
        'exec' {
          $CommandText = [string]$Request.command
          $TimeoutSec = if ($Request.commandTimeoutSec) { [Math]::Max(1, [int]$Request.commandTimeoutSec) } else { 30 }
          $Job = Start-Job -ArgumentList $CommandText -ScriptBlock {
            param($CommandText)
            try {
              $global:LASTEXITCODE = 0
              $Output = Invoke-Expression $CommandText 2>&1
              $Status = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
              [pscustomobject][ordered]@{ stdout = (($Output | Out-String) -replace "`r?`n$", ''); stderr = ''; status = $Status }
            } catch {
              [pscustomobject][ordered]@{ stdout = ''; stderr = $_.Exception.Message; status = 1 }
            }
          }
          $Completed = Wait-Job -Job $Job -Timeout $TimeoutSec
          if ($null -eq $Completed) {
            Stop-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null
            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
            $Response.stdout = ''
            $Response.stderr = "Command timed out after $TimeoutSec seconds"
            $Response.status = 124
          } else {
            $JobResult = Receive-Job -Job $Job -ErrorAction SilentlyContinue | Select-Object -First 1
            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
            $Response.stdout = if ($JobResult.stdout) { [string]$JobResult.stdout } else { '' }
            $Response.stderr = if ($JobResult.stderr) { [string]$JobResult.stderr } else { '' }
            $Response.status = if ($null -ne $JobResult.status) { [int]$JobResult.status } else { 0 }
          }
        }
        'screenshot' {
          $OutputPath = Join-Path $Downloads ($Request.id + '.png')
          $Job = Start-Job -ArgumentList $OutputPath -ScriptBlock {
            param($OutputPath)
            try {
              Add-Type -AssemblyName System.Windows.Forms
              Add-Type -AssemblyName System.Drawing
              $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
              if ($Bounds.Width -le 0 -or $Bounds.Height -le 0) { throw 'No interactive display is available' }
              $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
              $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
              try {
                $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)
                $Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
              } finally { $Graphics.Dispose(); $Bitmap.Dispose() }
              [pscustomobject]@{ ok = $true; error = '' }
            } catch { [pscustomobject]@{ ok = $false; error = $_.Exception.Message } }
          }
          $Completed = Wait-Job -Job $Job -Timeout 30
          if ($null -eq $Completed) {
            Stop-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null
            Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
            throw 'Screenshot timed out after 30 seconds'
          }
          $JobResult = Receive-Job -Job $Job -ErrorAction SilentlyContinue | Select-Object -First 1
          Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
          if (-not $JobResult.ok) { throw ('Screenshot failed: ' + [string]$JobResult.error) }
          $Response.imagePath = $OutputPath
        }
        'click' {
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)
          $Button = if ($Request.button) { [string]$Request.button } else { 'left' }
          $Down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 }
          $Up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 }
          [CccMouse]::mouse_event($Down, 0, 0, 0, 0); Start-Sleep -Milliseconds 50; [CccMouse]::mouse_event($Up, 0, 0, 0, 0)
          $Response.clicked = @{ x = [int]$Request.x; y = [int]$Request.y; button = $Button }
        }
        'double_click' {
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)
          $Button = if ($Request.button) { [string]$Request.button } else { 'left' }
          $Down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 }
          $Up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 }
          1..2 | ForEach-Object { [CccMouse]::mouse_event($Down, 0, 0, 0, 0); Start-Sleep -Milliseconds 50; [CccMouse]::mouse_event($Up, 0, 0, 0, 0); Start-Sleep -Milliseconds 80 }
          $Response.doubleClicked = @{ x = [int]$Request.x; y = [int]$Request.y; button = $Button }
        }
        'key' {
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.SendKeys]::SendWait([string]$Request.keys)
          $Response.key = @{ key = $Request.key; keys = $Request.keys }
        }
        'type' {
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.SendKeys]::SendWait([string]$Request.keys)
          $Response.typed = @{ text = $Request.text; keys = $Request.keys }
        }
        'scroll' {
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          if (-not ([System.Management.Automation.PSTypeName]'CccMouse').Type) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CccMouse { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo); }' }
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$Request.x, [int]$Request.y)
          $Amount = if ($Request.amount) { [int]$Request.amount } else { 1 }
          $Direction = if ($Request.direction) { [string]$Request.direction } else { 'down' }
          $WheelData = 120 * $Amount
          if ($Direction -eq 'down' -or $Direction -eq 'right') { $WheelData = -1 * $WheelData }
          $WheelFlag = if ($Direction -eq 'left' -or $Direction -eq 'right') { 0x01000 } else { 0x0800 }
          [CccMouse]::mouse_event($WheelFlag, 0, 0, $WheelData, 0)
          $Response.scrolled = @{ x = [int]$Request.x; y = [int]$Request.y; direction = $Direction; amount = $Amount }
        }
        'cursor_position' {
          Add-Type -AssemblyName System.Windows.Forms
          $Position = [System.Windows.Forms.Cursor]::Position
          $Response.cursor = @{ x = $Position.X; y = $Position.Y }
        }
        'window_list' {
          $Windows = Get-Process | Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
            @{ processId = $_.Id; processName = $_.ProcessName; title = $_.MainWindowTitle; handle = [string]$_.MainWindowHandle }
          }
          $Response.windows = @($Windows)
          $Response.provider = 'windows-process-main-window'
        }
        'accessibility_snapshot' {
          Add-Type -AssemblyName UIAutomationClient
          Add-Type -AssemblyName UIAutomationTypes
          $MaxDepth = if ($Request.maxDepth -ne $null) { [Math]::Max(0, [Math]::Min([int]$Request.maxDepth, 8)) } else { 3 }
          $MaxNodes = if ($Request.maxNodes -ne $null) { [Math]::Max(1, [Math]::Min([int]$Request.maxNodes, 1000)) } else { 200 }
          $script:CccNodeCount = 0
          function Convert-CccAutomationElement {
            param($Element, [int]$Depth)
            if ($null -eq $Element -or $script:CccNodeCount -ge $MaxNodes) { return $null }
            $script:CccNodeCount += 1
            $Rect = $Element.Current.BoundingRectangle
            $Node = [ordered]@{
              name = $Element.Current.Name
              automationId = $Element.Current.AutomationId
              className = $Element.Current.ClassName
              controlType = $Element.Current.ControlType.ProgrammaticName
              processId = $Element.Current.ProcessId
              isEnabled = $Element.Current.IsEnabled
              isOffscreen = $Element.Current.IsOffscreen
              bounds = @{ x = [double]$Rect.X; y = [double]$Rect.Y; width = [double]$Rect.Width; height = [double]$Rect.Height }
              children = @()
            }
            if ($Depth -lt $MaxDepth -and $script:CccNodeCount -lt $MaxNodes) {
              $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
              $Child = $Walker.GetFirstChild($Element)
              while ($null -ne $Child -and $script:CccNodeCount -lt $MaxNodes) {
                $ChildNode = Convert-CccAutomationElement $Child ($Depth + 1)
                if ($null -ne $ChildNode) { $Node.children += $ChildNode }
                $Child = $Walker.GetNextSibling($Child)
              }
            }
            return $Node
          }
          $Root = [System.Windows.Automation.AutomationElement]::RootElement
          $Tree = Convert-CccAutomationElement $Root 0
          $Response.accessibility = @{ provider = 'windows-uiautomation'; maxDepth = $MaxDepth; maxNodes = $MaxNodes; nodeCount = $script:CccNodeCount; root = $Tree }
        }
        'upload' {
          Copy-Item -Force -Path $Request.uploadPath -Destination $Request.remotePath
          $Response.uploaded = @{ remotePath = $Request.remotePath }
        }
        'download' {
          $OutputPath = Join-Path $Downloads ($Request.id + '-' + [IO.Path]::GetFileName($Request.remotePath))
          Copy-Item -Force -Path $Request.remotePath -Destination $OutputPath
          $Response.downloadPath = $OutputPath
        }
        'record_start' {
          $SessionId = if ($Request.sessionId) { $Request.sessionId } else { $Request.id }
          if ($Recordings.ContainsKey($SessionId)) { throw "Recording already active: $SessionId" }
          $FrameDir = Join-Path $Downloads ($SessionId + '-frames')
          New-Item -ItemType Directory -Force -Path $FrameDir | Out-Null
          $IntervalMs = if ($Request.intervalMs) { [int]$Request.intervalMs } else { 1000 }
          $TimeLimitSec = if ($Request.timeLimitSec) { [int]$Request.timeLimitSec } else { 0 }
          $Job = Start-Job -ArgumentList $FrameDir,$IntervalMs,$TimeLimitSec -ScriptBlock {
            param($FrameDir,$IntervalMs,$TimeLimitSec)
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $Index = 0
            $StopAt = if ($TimeLimitSec -gt 0) { [DateTime]::UtcNow.AddSeconds($TimeLimitSec) } else { $null }
            while ($true) {
              if ($StopAt -and [DateTime]::UtcNow -ge $StopAt) { break }
              $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
              $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
              $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
              $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)
              $FramePath = Join-Path $FrameDir ('frame-{0:D6}.png' -f $Index)
              $Bitmap.Save($FramePath, [System.Drawing.Imaging.ImageFormat]::Png)
              $Graphics.Dispose(); $Bitmap.Dispose()
              $Index += 1
              Start-Sleep -Milliseconds $IntervalMs
            }
          }
          $Recordings[$SessionId] = @{ job = $Job; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; startedAt = (Get-Date).ToString('o') }
          $Response.recording = @{ sessionId = $SessionId; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; provider = 'windows-helper-frame-archive' }
        }
        'record_status' {
          $SessionId = $Request.sessionId
          if ($SessionId -and $Recordings.ContainsKey($SessionId)) {
            $Entry = $Recordings[$SessionId]
            if ($Entry.job.State -eq 'Running') {
              $Response.recording = @{ sessionId = $SessionId; active = $true; state = $Entry.job.State; frameDir = $Entry.frameDir; provider = 'windows-helper-frame-archive' }
            } else {
              $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')
              if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }
              if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {
                @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before completion.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8
              }
              Compress-CccDirectory -SourcePath $Entry.frameDir -DestinationPath $ArchivePath
              Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null
              $Recordings.Remove($SessionId)
              $Response.recording = @{ sessionId = $SessionId; active = $false; state = $Entry.job.State; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }
            }
          } else {
            $Response.recording = $null
          }
        }
        'record_stop' {
          $SessionId = $Request.sessionId
          if (-not $SessionId -or -not $Recordings.ContainsKey($SessionId)) { throw "No recording active: $SessionId" }
          $Entry = $Recordings[$SessionId]
          Stop-Job -Job $Entry.job -ErrorAction SilentlyContinue | Out-Null
          Wait-Job -Job $Entry.job -Timeout 3 -ErrorAction SilentlyContinue | Out-Null
          Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null
          $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')
          if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }
          if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {
            @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before stop.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8
          }
          Compress-CccDirectory -SourcePath $Entry.frameDir -DestinationPath $ArchivePath
          $Recordings.Remove($SessionId)
          $Response.recording = @{ sessionId = $SessionId; active = $false; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }
        }
        default { throw "Unknown request type: $($Request.type)" }
      }
    } catch {
      if ($null -eq $Request -and -not (Test-Path -LiteralPath $RequestPath)) { return }
      $RequestId = if ($Request -and $Request.id) { $Request.id } else { [IO.Path]::GetFileNameWithoutExtension($RequestPath) }
      $RequestType = if ($Request -and $Request.type) { $Request.type } else { '' }
      $Response = [ordered]@{ id = $RequestId; ok = $false; type = $RequestType; error = $_.Exception.Message }
    }
    $ResponsePath = Join-Path $Outbox ($Response.id + '.json')
    $ResponseTempPath = $ResponsePath + '.tmp'
    Write-CccJson -Path $ResponseTempPath -Value $Response
    Move-Item -Force -Path $ResponseTempPath -Destination $ResponsePath
    Remove-Item -Force -Path $RequestPath
}
if ($OnceRequestPath) { Invoke-CccRequest $OnceRequestPath; exit }
Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8
while ($true) {
  Write-CccHeartbeat
  Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object { Invoke-CccRequest $_.FullName }
  Start-Sleep -Milliseconds 250
}
