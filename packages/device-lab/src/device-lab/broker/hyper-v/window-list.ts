import { validateWindowHandle, parseWindowsGuestWindowList } from "../../domain/hyper-v-desktop-transfer.js";
import { X11_WINDOW_LIST_COMMAND, parseX11WindowList } from "../../../../providers/display/window-list.mjs";

export function linuxWindowListCommand(): string {
    const encoded = Buffer.from(X11_WINDOW_LIST_COMMAND, "utf8").toString("base64");
    return `set -eo pipefail\nprintf %s ${encoded} | base64 -d | sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority bash`;
}

// Runs only through the existing identity/credential-checked guest transport.
// Remoting runs in session 0: enumerate in the credential user's console via
// an interactive token, never host EnumWindows or remoting MainWindowHandle.
export function windowsWindowListCommand(): string {
    return windowsInteractiveCommand(String.raw`param($Expected)
$ErrorActionPreference='Stop'
try {
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CCCWin {
public delegate bool Callback(IntPtr h,IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumWindows(Callback c,IntPtr p);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
}
"@
if((Get-Process -Id $PID).SessionId -ne [int]$Expected){throw 'window-list-session-changed'}
$rows=[Collections.Generic.List[object]]::new()
$callback=[CCCWin+Callback]{param($h,$unused)
 if([CCCWin]::IsWindowVisible($h)){
  $text=[Text.StringBuilder]::new(513)
  if([CCCWin]::GetWindowText($h,$text,513) -gt 0){
   $processId=[uint32]0
   [void][CCCWin]::GetWindowThreadProcessId($h,[ref]$processId)
   $rows.Add(@{handle=$h.ToString();title=$text.ToString();processId=$processId})
  }
 }
 return ($rows.Count -lt 129)
}
if(![CCCWin]::EnumWindows($callback,[IntPtr]::Zero) -and $rows.Count -lt 129){throw 'window-list-query-failed'}
$result=@{windows=@($rows|Select-Object -First 128);truncated=($rows.Count -gt 128)}
}catch{$result=@{error=$_.Exception.Message}}
$out=Join-Path $PSScriptRoot 'result.json'
$json=$result|ConvertTo-Json -Depth 5 -Compress
while($json.Length -gt 8000){$result.truncated=$true;$result.windows=@($result.windows|Select-Object -First ($result.windows.Count-1));$json=$result|ConvertTo-Json -Depth 5 -Compress}
[IO.File]::WriteAllText(($out+'.tmp'),$json,[Text.UTF8Encoding]::new($false))
[IO.File]::Move(($out+'.tmp'),$out)`);
}


export function linuxFocusWindowCommand(handle: string): string {
    validateWindowHandle(handle);
    return String.raw`sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority bash -c 'set -e; xdotool getwindowname ${handle} >/dev/null; xdotool windowactivate --sync ${handle}; test "$(xdotool getactivewindow)" = "${handle}"; printf "{\"ok\":true}"'`;
}

export function windowsFocusWindowCommand(handle: string): string {
    validateWindowHandle(handle);
    return windowsInteractiveCommand(String.raw`param($Expected)
$ErrorActionPreference='Stop'
try {
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CCCFocus {
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
if((Get-Process -Id $PID).SessionId -ne [int]$Expected){throw 'focus-window-session-changed'}
$h=[IntPtr]::new(${handle})
$processId=[uint32]0
[void][CCCFocus]::GetWindowThreadProcessId($h,[ref]$processId)
if(![CCCFocus]::IsWindowVisible($h) -or !$processId -or (Get-Process -Id $processId).SessionId -ne [int]$Expected){throw 'window-not-found'}
[void][CCCFocus]::ShowWindowAsync($h,9)
[void][CCCFocus]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 100
if([CCCFocus]::GetForegroundWindow() -ne $h){throw 'window-focus-denied'}
$result=@{ok=$true}
}catch{$result=@{error=$_.Exception.Message}}
$out=Join-Path $PSScriptRoot 'result.json'
[IO.File]::WriteAllText(($out+'.tmp'),($result|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
[IO.File]::Move(($out+'.tmp'),$out)`);
}


function windowsInteractiveCommand(worker: string): string {
    return String.raw`$ErrorActionPreference='Stop'
Add-Type 'using System.Runtime.InteropServices; public class CCCCon { [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId(); }'
$sid=[CCCCon]::WTSGetActiveConsoleSessionId()
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if($sid -eq 4294967295 -or (Get-CimInstance Win32_ComputerSystem).UserName -ne $user){throw 'window-list-console-unavailable'}
$name='ccc-windows-'+[guid]::NewGuid().ToString('N')
$dir=Join-Path $env:TEMP $name
$registered=$false
try {
 [IO.Directory]::CreateDirectory($dir)|Out-Null
 $acl=Get-Acl $dir
 $acl.SetAccessRuleProtection($true,$false)
 foreach($id in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
 }
 Set-Acl -LiteralPath $dir -AclObject $acl
 $script=Join-Path $dir 'query.ps1'
 $output=Join-Path $dir 'result.json'
 $worker=@'
${worker}
'@
 [IO.File]::WriteAllText($script,$worker)
 $action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script+'" '+$sid)
 $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 20)
 Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings|Out-Null
 $registered=$true
 Start-ScheduledTask -TaskName $name
 $end=[DateTime]::UtcNow.AddSeconds(22)
 while(!(Test-Path -LiteralPath $output)){
  if([DateTime]::UtcNow -ge $end){throw 'window-list-timeout'}
  Start-Sleep -Milliseconds 100
 }
 if([CCCCon]::WTSGetActiveConsoleSessionId() -ne $sid){throw 'window-list-session-changed'}
 if((Get-Item -LiteralPath $output).Length -gt 1048576){throw 'window-list-result-too-large'}
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
 [IO.File]::ReadAllText($output)
} finally {
 if($registered){Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $dir){Remove-Item -LiteralPath $dir -Recurse -Force}
}`.replace(/^[ \t]+/gm, "");
}

export function parseGuestWindowList(backend: string, stdout: string): Record<string, unknown> {
    return backend === "linux-vm" ? parseX11WindowList(stdout) : parseWindowsGuestWindowList(stdout, Buffer.byteLength(stdout));
}
export { parseGuestFocusWindow } from "../../domain/hyper-v-desktop-transfer.js";
