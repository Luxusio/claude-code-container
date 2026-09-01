import { spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { realpathSync } from "fs";
import { createServer } from "net";
import { win32 } from "path";
import { gzipSync } from "zlib";

const WINDOWS_SYSTEM_ROOT_ALIAS = "\\\\?\\GLOBALROOT\\SystemRoot";
const ELEVATION_RESULT_MARKER = "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:";
const PIPE_FRAME_MARKER = "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:";
const ELEVATION_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
const ELEVATION_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const ELEVATION_PROGRAM_LIMIT_BYTES = 8 * 1024 * 1024;
const ELEVATION_PIPE_FRAME_LIMIT_BYTES = Math.ceil(ELEVATION_OUTPUT_LIMIT_BYTES * 4 / 3) + 1024;
const ELEVATION_PIPE_AUTH_LIMIT_BYTES = 1024;
const ELEVATION_SERVER_CLOSE_TIMEOUT_MILLISECONDS = 5000;
const ELEVATION_PIPE_SETTLE_TIMEOUT_MILLISECONDS = 5000;

export const HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class CccHyperVWindowsLibraryCaptureResult
{
    public byte[] Stdout;
    public byte[] Stderr;
    public int ExitCode;
    public bool OutputLimitExceeded;
    public bool TimedOut;
    public bool TerminationUnconfirmed;
}

public static class CccHyperVWindowsLibraryBoundedProcess
{
    private static IntPtr currentProcessJob = IntPtr.Zero;
    private sealed class CaptureState
    {
        public readonly object Gate = new object();
        public readonly Process Process;
        public readonly IntPtr Job;
        public readonly int Limit;
        public int Total;
        public bool OutputLimitExceeded;
        public bool TimedOut;
        public bool TerminationFailed;

        public CaptureState(Process process, IntPtr job, int limit) { Process = process; Job = job; Limit = limit; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public long Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr CreateKillOnCloseJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("elevated-job-create-failed");
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
                throw new InvalidOperationException("elevated-job-configure-failed");
            return job;
        }
        catch { CloseHandle(job); throw; }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public static void ContainCurrentProcess()
    {
        if (currentProcessJob != IntPtr.Zero) return;
        var job = CreateKillOnCloseJob();
        if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
        {
            CloseHandle(job);
            throw new InvalidOperationException("elevated-current-process-job-assign-failed");
        }
        currentProcessJob = job;
    }

    private static void TerminateTree(CaptureState state)
    {
        try { if (!TerminateJobObject(state.Job, 1)) state.TerminationFailed = true; }
        catch { state.TerminationFailed = true; }
    }

    private static async Task CopyBoundedAsync(Stream input, MemoryStream output, CaptureState state)
    {
        var buffer = new byte[8192];
        while (true)
        {
            int read;
            try { read = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false); }
            catch (IOException) { lock (state.Gate) { if (state.OutputLimitExceeded || state.TimedOut) return; } throw; }
            catch (ObjectDisposedException) { lock (state.Gate) { if (state.OutputLimitExceeded || state.TimedOut) return; } throw; }
            if (read == 0) return;
            bool terminate = false;
            lock (state.Gate)
            {
                if (state.OutputLimitExceeded || state.TimedOut) continue;
                if (state.Total > state.Limit - read)
                {
                    state.OutputLimitExceeded = true;
                    terminate = true;
                }
                else
                {
                    output.Write(buffer, 0, read);
                    state.Total += read;
                }
            }
            if (terminate) TerminateTree(state);
        }
    }

    public static string ReadBoundedAsciiLine(Stream input, int limit)
    {
        using (var output = new MemoryStream())
        {
            var buffer = new byte[8192];
            while (true)
            {
                var read = input.Read(buffer, 0, buffer.Length);
                if (read == 0) throw new EndOfStreamException("elevation-input-incomplete");
                for (var index = 0; index < read; index++)
                {
                    var value = buffer[index];
                    if (value == 10) return Encoding.ASCII.GetString(output.ToArray()).TrimEnd('\r');
                    if (value > 127 || output.Length >= limit) throw new InvalidDataException("elevation-input-invalid");
                    output.WriteByte(value);
                }
            }
        }
    }

    public static IDisposable ArmCurrentProcessWatchdog(int timeoutMilliseconds)
    {
        return new Timer(_ => { try { Process.GetCurrentProcess().Kill(); } catch { } }, null, timeoutMilliseconds, Timeout.Infinite);
    }

    public static CccHyperVWindowsLibraryCaptureResult Run(
        string executable,
        string arguments,
        int limit,
        int timeoutMilliseconds,
        string workingDirectory,
        string systemRoot,
        string programData)
    {
        var startInfo = new ProcessStartInfo();
        startInfo.FileName = executable;
        startInfo.Arguments = arguments;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.WorkingDirectory = workingDirectory;
        startInfo.EnvironmentVariables.Clear();
        startInfo.EnvironmentVariables["SystemRoot"] = systemRoot;
        startInfo.EnvironmentVariables["WINDIR"] = systemRoot;
        var systemDrive = Path.GetPathRoot(systemRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var system32 = Path.Combine(systemRoot, "System32");
        var powershellRoot = Path.Combine(system32, "WindowsPowerShell", "v1.0");
        startInfo.EnvironmentVariables["SystemDrive"] = systemDrive;
        startInfo.EnvironmentVariables["COMPUTERNAME"] = Environment.MachineName;
        startInfo.EnvironmentVariables["COMSPEC"] = Path.Combine(system32, "cmd.exe");
        startInfo.EnvironmentVariables["PATH"] = String.Join(Path.PathSeparator.ToString(), new [] {
            system32,
            powershellRoot,
            Path.Combine(system32, "Wbem")
        });
        startInfo.EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
        startInfo.EnvironmentVariables["PSModulePath"] = Path.Combine(powershellRoot, "Modules");
        startInfo.EnvironmentVariables["ProgramData"] = programData;
        startInfo.EnvironmentVariables["TEMP"] = workingDirectory;
        startInfo.EnvironmentVariables["TMP"] = workingDirectory;
        startInfo.EnvironmentVariables["NO_COLOR"] = "1";
        startInfo.EnvironmentVariables["FORCE_COLOR"] = "0";
        var job = CreateKillOnCloseJob();
        try
        {
            using (var process = new Process())
            using (var stdout = new MemoryStream())
            using (var stderr = new MemoryStream())
            {
                process.StartInfo = startInfo;
                if (!process.Start()) throw new InvalidOperationException("elevated-child-start-failed");
                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    try { process.Kill(); } catch { }
                    throw new InvalidOperationException("elevated-job-assign-failed");
                }
                var state = new CaptureState(process, job, limit);
                var stdoutTask = CopyBoundedAsync(process.StandardOutput.BaseStream, stdout, state);
                var stderrTask = CopyBoundedAsync(process.StandardError.BaseStream, stderr, state);
                if (!process.WaitForExit(timeoutMilliseconds))
                {
                    lock (state.Gate) { state.TimedOut = true; }
                    TerminateTree(state);
                }
                var exited = process.HasExited || process.WaitForExit(5000);
                var streamsClosed = false;
                try { streamsClosed = Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 5000); }
                catch (AggregateException) { if (!state.OutputLimitExceeded && !state.TimedOut) throw; }
                return new CccHyperVWindowsLibraryCaptureResult {
                    Stdout = stdout.ToArray(),
                    Stderr = stderr.ToArray(),
                    ExitCode = exited ? process.ExitCode : -1,
                    OutputLimitExceeded = state.OutputLimitExceeded,
                    TimedOut = state.TimedOut,
                    TerminationUnconfirmed = state.TerminationFailed || !exited || !streamsClosed
                };
            }
        }
        finally { CloseHandle(job); }
    }
}`;

function encodedPowerShell(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function decodedJsonExpression(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json -ErrorAction Stop)`;
}

export function resolveTrustedWindowsPowerShell(realpath = realpathSync.native) {
    let systemRoot;
    try {
        systemRoot = realpath(WINDOWS_SYSTEM_ROOT_ALIAS);
    } catch {
        throw new Error("hyper-v-library-elevation-system-root-invalid");
    }
    const normalized = win32.normalize(systemRoot);
    if (!win32.isAbsolute(normalized) || normalized === win32.parse(normalized).root) {
        throw new Error("hyper-v-library-elevation-system-root-invalid");
    }
    return win32.join(normalized, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function isAdministrator({ powerShellPath, spawnSyncImpl = spawnSync }) {
    const probe = [
        "$ProgressPreference = 'SilentlyContinue'",
        "$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)",
        "if ($Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }",
        "exit 3",
    ].join("; ");
    const result = spawnSyncImpl(powerShellPath, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedPowerShell(probe),
    ], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    if (result.error || (result.status !== 0 && result.status !== 3)) {
        throw new Error("hyper-v-library-elevation-probe-failed");
    }
    return result.status === 0;
}

export function elevationPowerShellScripts({ powerShellPath, nodePath, nodeDigest, programDigest, pipeName, token }) {
    if (nodePath.includes('"') || !/^[a-f0-9]{64}$/.test(nodeDigest) || !/^[a-f0-9]{64}$/.test(programDigest)) {
        throw new Error("hyper-v-library-elevation-path-invalid");
    }
    const childPayload = decodedJsonExpression({ nodePath, nodeDigest, programDigest, pipeName, token });
    const captureSource = gzipSync(Buffer.from(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP, "utf8")).toString("base64");
    const elevatedScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Watchdog = $null",
        `$Payload = ${childPayload}`,
        "$Pipe = [IO.Pipes.NamedPipeClientStream]::new('.', [string]$Payload.pipeName, [IO.Pipes.PipeDirection]::InOut)",
        "$Pipe.Connect(15000)",
        "$Writer = [IO.StreamWriter]::new($Pipe, [Text.UTF8Encoding]::new($false))",
        "$Writer.AutoFlush = $true",
        `$Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':AUTH:')`,
        "$Root = $null",
        "$OwnedRoot = $false",
        "function Remove-CccProtectedStagingRoot([string]$Path) {",
        "  $CanonicalRoot = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)",
        "  $RootPrefix = $CanonicalRoot + [IO.Path]::DirectorySeparatorChar",
        "  $PendingDirectories = [Collections.Generic.Stack[string]]::new()",
        "  $Entries = [Collections.Generic.List[string]]::new()",
        "  $PendingDirectories.Push($CanonicalRoot)",
        "  while ($PendingDirectories.Count -gt 0) {",
        "    $Directory = $PendingDirectories.Pop()",
        "    foreach ($Entry in [IO.Directory]::EnumerateFileSystemEntries($Directory, '*', [IO.SearchOption]::TopDirectoryOnly)) {",
        "      $CanonicalEntry = [IO.Path]::GetFullPath([string]$Entry)",
        "      if (-not $CanonicalEntry.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'elevation-staging-cleanup-boundary-invalid' }",
        "      $Attributes = [IO.File]::GetAttributes($CanonicalEntry)",
        "      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'elevation-staging-cleanup-reparse-refused' }",
        "      $Entries.Add($CanonicalEntry)",
        "      if (($Attributes -band [IO.FileAttributes]::Directory) -ne 0) { $PendingDirectories.Push($CanonicalEntry) }",
        "    }",
        "  }",
        "  foreach ($CanonicalEntry in @($Entries | Sort-Object { $_.Length } -Descending)) {",
        "    $Attributes = [IO.File]::GetAttributes($CanonicalEntry)",
        "    if (($Attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($CanonicalEntry, $false) } else { [IO.File]::Delete($CanonicalEntry) }",
        "  }",
        "  [IO.Directory]::Delete($CanonicalRoot, $false)",
        "}",
        "try {",
        "  $ProgramData = [Environment]::GetFolderPath('CommonApplicationData')",
        "  $Root = [IO.Path]::Combine($ProgramData, 'ccc-hyper-v-library-elevated-' + [string]$Payload.token)",
        "  if ([IO.Directory]::Exists($Root) -or [IO.File]::Exists($Root)) { throw 'elevation-staging-root-exists' }",
        "  $Security = [Security.AccessControl.DirectorySecurity]::new()",
        "  $Security.SetAccessRuleProtection($true, $false)",
        "  $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
        "  foreach ($SidValue in @('S-1-5-18', 'S-1-5-32-544')) {",
        "    $Rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($SidValue), [Security.AccessControl.FileSystemRights]::FullControl, $Inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
        "    [void]$Security.AddAccessRule($Rule)",
        "  }",
        "  $RootInfo = [IO.DirectoryInfo]::new($Root)",
        "  $RootInfo.Create($Security)",
        "  $RootInfo.Refresh()",
        "  if (($RootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'elevation-staging-root-invalid' }",
        "  $ObservedAcl = $RootInfo.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)",
        "  $ObservedRules = @($ObservedAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))",
        "  if (-not $ObservedAcl.AreAccessRulesProtected -or $ObservedRules.Count -ne 2) { throw 'elevation-staging-dacl-invalid' }",
        "  $ExpectedSids = @('S-1-5-18', 'S-1-5-32-544')",
        "  foreach ($ObservedRule in $ObservedRules) {",
        "    if ($ExpectedSids -notcontains $ObservedRule.IdentityReference.Value -or $ObservedRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $ObservedRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $ObservedRule.InheritanceFlags -ne $Inheritance -or $ObservedRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'elevation-staging-dacl-invalid' }",
        "  }",
        "  $OwnedRoot = $true",
        "  $env:TEMP = $Root",
        "  $env:TMP = $Root",
        `  $CaptureCompressed = [Convert]::FromBase64String('${captureSource}')`,
        "  $CaptureInput = [IO.MemoryStream]::new($CaptureCompressed, $false)",
        "  $CaptureGzip = [IO.Compression.GZipStream]::new($CaptureInput, [IO.Compression.CompressionMode]::Decompress)",
        "  $CaptureReader = [IO.StreamReader]::new($CaptureGzip, [Text.Encoding]::UTF8)",
        "  try { $CaptureSource = $CaptureReader.ReadToEnd() } finally { $CaptureReader.Dispose(); $CaptureGzip.Dispose(); $CaptureInput.Dispose() }",
        "  if (-not ('CccHyperVWindowsLibraryBoundedProcess' -as [type])) { Add-Type -TypeDefinition $CaptureSource }",
        "  [CccHyperVWindowsLibraryBoundedProcess]::ContainCurrentProcess()",
        "  $Watchdog = [CccHyperVWindowsLibraryBoundedProcess]::ArmCurrentProcessWatchdog(540000)",
        "  if ($BootstrapWatchdog -and -not $BootstrapWatchdog.HasExited) { $BootstrapWatchdog.Kill(); $BootstrapWatchdog.WaitForExit(5000) }",
        `  $BundleLine = [CccHyperVWindowsLibraryBoundedProcess]::ReadBoundedAsciiLine($Pipe, ${Math.ceil(ELEVATION_PROGRAM_LIMIT_BYTES * 4 / 3) + 1024})`,
        `  $BundlePrefix = '${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':PROGRAM:'`,
        "  if (-not $BundleLine.StartsWith($BundlePrefix, [StringComparison]::Ordinal)) { throw 'elevation-program-frame-invalid' }",
        "  $ProgramBytes = [Convert]::FromBase64String($BundleLine.Substring($BundlePrefix.Length))",
        `  if ($ProgramBytes.Length -le 0 -or $ProgramBytes.Length -gt ${ELEVATION_PROGRAM_LIMIT_BYTES}) { throw 'elevation-program-size-invalid' }`,
        "  $Sha256 = [Security.Cryptography.SHA256]::Create()",
        "  try { $ObservedProgramDigest = ([BitConverter]::ToString($Sha256.ComputeHash($ProgramBytes))).Replace('-', '').ToLowerInvariant() } finally { $Sha256.Dispose() }",
        "  if ($ObservedProgramDigest -cne [string]$Payload.programDigest) { throw 'elevation-program-integrity-failed' }",
        "  $ProgramPath = [IO.Path]::Combine($Root, 'scenario.mjs')",
        "  $NodePath = [IO.Path]::Combine($Root, 'node.exe')",
        "  [IO.File]::WriteAllBytes($ProgramPath, $ProgramBytes)",
        "  [IO.File]::Copy([string]$Payload.nodePath, $NodePath, $false)",
        "  $NodeStream = [IO.File]::Open($NodePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
        "  $Sha256 = [Security.Cryptography.SHA256]::Create()",
        "  try { $ObservedNodeDigest = ([BitConverter]::ToString($Sha256.ComputeHash($NodeStream))).Replace('-', '').ToLowerInvariant() } finally { $Sha256.Dispose(); $NodeStream.Dispose() }",
        "  if ($ObservedNodeDigest -cne [string]$Payload.nodeDigest) { throw 'elevation-node-integrity-failed' }",
        "  $SystemRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName",
        "  $Arguments = '\"' + $ProgramPath + '\"'",
        `  $Capture = [CccHyperVWindowsLibraryBoundedProcess]::Run($NodePath, $Arguments, ${ELEVATION_OUTPUT_LIMIT_BYTES}, 480000, $Root, $SystemRoot, $ProgramData)`,
        `  if ($Capture.OutputLimitExceeded) { $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':LIMIT:'); exit 1 }`,
        `  if ($Capture.TimedOut) { $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':TIMEOUT:'); exit 1 }`,
        `  if ($Capture.TerminationUnconfirmed) { $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':TERMINATION:'); exit 1 }`,
        "  Remove-CccProtectedStagingRoot $Root",
        "  $OwnedRoot = $false",
        `  $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':STDOUT:' + [Convert]::ToBase64String($Capture.Stdout))`,
        `  $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':STDERR:' + [Convert]::ToBase64String($Capture.Stderr))`,
        "  $ChildExitCode = [int]$Capture.ExitCode",
        `  $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':RESULT:' + [string]$ChildExitCode)`,
        "  exit $ChildExitCode",
        "} catch {",
        `  $Writer.WriteLine('${PIPE_FRAME_MARKER}' + [string]$Payload.token + ':FAILED:')`,
        "  exit 1",
        "} finally {",
        "  if ($OwnedRoot -and $Root) {",
        "    if ([IO.Directory]::Exists($Root)) { Remove-CccProtectedStagingRoot $Root }",
        "  }",
        "  $Writer.Dispose()",
        "  $Pipe.Dispose()",
        "  if ($Watchdog) { $Watchdog.Dispose() }",
        "  if ($BootstrapWatchdog -and -not $BootstrapWatchdog.HasExited) { $BootstrapWatchdog.Kill() }",
        "}",
    ].join("\n");
    const elevatedCompressed = gzipSync(Buffer.from(elevatedScript, "utf8")).toString("base64");
    const elevatedBootstrap = [
        "$BootstrapSystemRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName",
        "$BootstrapPowerShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')",
        "$BootstrapTargetStartTime = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc()",
        "$BootstrapWatchdogInfo = [Diagnostics.ProcessStartInfo]::new()",
        "$BootstrapWatchdogInfo.FileName = $BootstrapPowerShell",
        "$BootstrapWatchdogInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$Target = [Diagnostics.Process]::GetProcessById(' + [string]$PID + '); try { if ($Target.StartTime.ToFileTimeUtc() -ne ' + [string]$BootstrapTargetStartTime + ') { exit 0 }; $Handle = $Target.Handle; if (-not $Target.WaitForExit(540000)) { $Target.Kill() } } finally { $Target.Dispose() }\"'",
        "$BootstrapWatchdogInfo.UseShellExecute = $false",
        "$BootstrapWatchdogInfo.CreateNoWindow = $true",
        "$BootstrapWatchdogInfo.WorkingDirectory = [Environment]::SystemDirectory",
        "$BootstrapWatchdogInfo.EnvironmentVariables.Clear()",
        "$BootstrapWatchdogInfo.EnvironmentVariables['SystemRoot'] = $BootstrapSystemRoot",
        "$BootstrapWatchdogInfo.EnvironmentVariables['WINDIR'] = $BootstrapSystemRoot",
        "$BootstrapWatchdog = [Diagnostics.Process]::Start($BootstrapWatchdogInfo)",
        "if (-not $BootstrapWatchdog) { throw 'elevation-bootstrap-watchdog-start-failed' }",
        "try {",
        `$Compressed = [Convert]::FromBase64String('${elevatedCompressed}')`,
        "$InputStream = [IO.MemoryStream]::new($Compressed, $false)",
        "$Gzip = [IO.Compression.GZipStream]::new($InputStream, [IO.Compression.CompressionMode]::Decompress)",
        "$Reader = [IO.StreamReader]::new($Gzip, [Text.Encoding]::UTF8)",
        "try { $Source = $Reader.ReadToEnd() } finally { $Reader.Dispose(); $Gzip.Dispose(); $InputStream.Dispose() }",
        "& ([ScriptBlock]::Create($Source))",
        "} finally { if ($BootstrapWatchdog) { if (-not $BootstrapWatchdog.HasExited) { $BootstrapWatchdog.Kill() }; $BootstrapWatchdog.Dispose() } }",
    ].join("; ");
    const launcherInput = Buffer.from(JSON.stringify({
        powerShellPath,
        elevatedCommand: encodedPowerShell(elevatedBootstrap),
    }), "utf8").toString("base64");
    const launcherScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "try {",
        "  $LaunchLine = [Console]::In.ReadLine()",
        "  if ([string]::IsNullOrWhiteSpace($LaunchLine)) { throw 'elevation-launch-input-missing' }",
        "  $LaunchJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchLine))",
        "  $Launch = $LaunchJson | ConvertFrom-Json -ErrorAction Stop",
        "  $Process = Start-Process -FilePath ([string]$Launch.powerShellPath) -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',[string]$Launch.elevatedCommand) -Wait -PassThru -ErrorAction Stop",
        `  [Console]::Out.WriteLine('${ELEVATION_RESULT_MARKER}EXIT:' + [string]$Process.ExitCode)`,
        "} catch {",
        "  if ($_.Exception -is [ComponentModel.Win32Exception] -and $_.Exception.NativeErrorCode -eq 1223) {",
        `    [Console]::Out.WriteLine('${ELEVATION_RESULT_MARKER}CANCELLED')`,
        "  } else {",
        `    [Console]::Out.WriteLine('${ELEVATION_RESULT_MARKER}FAILED')`,
        "  }",
        "}",
    ].join("\n");
    return { elevatedScript, elevatedBootstrap, launcherInput, launcherScript };
}

function parseLauncherResult(stdout) {
    const frames = [...stdout.matchAll(new RegExp(`${ELEVATION_RESULT_MARKER}(EXIT:(\\d+)|CANCELLED|FAILED)`, "g"))];
    if (frames.length !== 1) return { errorCode: "elevation-result-missing" };
    if (frames[0][1] === "CANCELLED") return { errorCode: "elevation-cancelled" };
    if (frames[0][1] === "FAILED") return { errorCode: "elevation-launch-failed" };
    const status = Number(frames[0][2]);
    return Number.isSafeInteger(status) && status >= 0 ? { status } : { errorCode: "elevation-result-invalid" };
}

export async function requestAdministrator({
    powerShellPath,
    nodePath,
    nodeDigest,
    programBytes,
    programDigest,
    spawnImpl = spawn,
    createServerImpl = createServer,
    randomBytesImpl = randomBytes,
}) {
    if (!Buffer.isBuffer(programBytes) || programBytes.length === 0 || programBytes.length > ELEVATION_PROGRAM_LIMIT_BYTES
        || !/^[a-f0-9]{64}$/.test(nodeDigest) || !/^[a-f0-9]{64}$/.test(programDigest)) {
        return { status: 1, stdout: "", stderr: "", errorCode: "elevation-program-invalid" };
    }
    const observedProgramDigest = createHash("sha256").update(programBytes).digest("hex");
    if (observedProgramDigest !== programDigest) {
        return { status: 1, stdout: "", stderr: "", errorCode: "elevation-program-integrity-failed" };
    }
    const token = randomBytesImpl(32).toString("hex");
    const pipeName = `ccc-hyper-v-windows-library-${process.pid}-${randomBytesImpl(16).toString("hex")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let pipeStatus = null;
    let pipeError = null;
    let connected = false;
    let lineBuffer = "";
    let serverShutdownTimedOut = false;
    let terminalFrameReceived = false;
    let authenticatedSocketClosed = false;
    const activeSockets = new Set();
    let resolvePipeSettlement;
    const pipeSettlement = new Promise((resolve) => { resolvePipeSettlement = resolve; });

    function maybeResolvePipeSettlement() {
        if (authenticatedSocketClosed && (terminalFrameReceived || pipeError)) resolvePipeSettlement();
    }

    function consumeAuthenticatedChunk(socket, chunk) {
        lineBuffer += chunk;
        if (Buffer.byteLength(lineBuffer, "utf8") > ELEVATION_PIPE_FRAME_LIMIT_BYTES) {
            pipeError = "elevation-output-limit-exceeded";
            socket.destroy();
            return;
        }
        let newline;
        while ((newline = lineBuffer.indexOf("\n")) >= 0) {
            const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
            lineBuffer = lineBuffer.slice(newline + 1);
            const prefix = `${PIPE_FRAME_MARKER}${token}:`;
            if (!line.startsWith(prefix)) {
                pipeError = "elevation-pipe-frame-invalid";
                continue;
            }
            const frame = line.slice(prefix.length);
            const streamMatch = /^(STDOUT|STDERR):(.*)$/.exec(frame);
            if (streamMatch) {
                const encoded = streamMatch[2];
                if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
                    pipeError = "elevation-pipe-frame-invalid";
                    continue;
                }
                const bytes = Buffer.from(encoded, "base64");
                outputBytes += bytes.length;
                if (outputBytes > ELEVATION_OUTPUT_LIMIT_BYTES) pipeError = "elevation-output-limit-exceeded";
                else if (streamMatch[1] === "STDOUT") stdout += bytes.toString("utf8");
                else stderr += bytes.toString("utf8");
            } else if (/^RESULT:\d+$/.test(frame) && pipeStatus === null) {
                pipeStatus = Number(frame.slice("RESULT:".length));
                terminalFrameReceived = true;
            } else if (frame === "FAILED:") {
                pipeError = "elevation-child-failed";
                terminalFrameReceived = true;
            } else if (frame === "LIMIT:") {
                pipeError = "elevation-output-limit-exceeded";
                terminalFrameReceived = true;
            } else if (frame === "TIMEOUT:") {
                pipeError = "elevation-timeout";
                terminalFrameReceived = true;
            } else if (frame === "TERMINATION:") {
                pipeError = "elevation-termination-unconfirmed";
                terminalFrameReceived = true;
            } else {
                pipeError = "elevation-pipe-frame-invalid";
            }
        }
    }

    const server = createServerImpl((socket) => {
        activeSockets.add(socket);
        let authenticated = false;
        let authenticationBuffer = "";
        socket.once("close", () => {
            activeSockets.delete(socket);
            if (authenticated) {
                authenticatedSocketClosed = true;
                if (!terminalFrameReceived) pipeError ??= "elevation-pipe-write-failed";
                maybeResolvePipeSettlement();
            }
        });
        socket.on("error", () => {
            if (authenticated) pipeError ??= "elevation-pipe-write-failed";
        });
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            if (authenticated) {
                consumeAuthenticatedChunk(socket, chunk);
                return;
            }
            authenticationBuffer += chunk;
            if (Buffer.byteLength(authenticationBuffer, "utf8") > ELEVATION_PIPE_AUTH_LIMIT_BYTES) {
                socket.destroy();
                return;
            }
            const newline = authenticationBuffer.indexOf("\n");
            if (newline < 0) return;
            const authenticationLine = authenticationBuffer.slice(0, newline).replace(/\r$/, "");
            const remainder = authenticationBuffer.slice(newline + 1);
            authenticationBuffer = "";
            if (authenticationLine !== `${PIPE_FRAME_MARKER}${token}:AUTH:`) {
                socket.destroy();
                return;
            }
            if (connected) {
                pipeError = "elevation-pipe-duplicate-client";
                socket.destroy();
                return;
            }
            connected = true;
            authenticated = true;
            socket.write(`${PIPE_FRAME_MARKER}${token}:PROGRAM:${programBytes.toString("base64")}\n`, (error) => {
                if (error) pipeError ??= "elevation-pipe-write-failed";
            });
            if (remainder) consumeAuthenticatedChunk(socket, remainder);
            maybeResolvePipeSettlement();
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, resolve);
    });

    const { launcherInput, launcherScript } = elevationPowerShellScripts({
        powerShellPath, nodePath, nodeDigest, programDigest, pipeName, token,
    });
    let launcherStdout = "";
    let launcherStderr = "";
    let launcherError = null;
    let launcherStatus = null;
    try {
        const child = spawnImpl(powerShellPath, [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", encodedPowerShell(launcherScript),
        ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                launcherError = "elevation-timeout";
                child.kill();
            }, ELEVATION_TIMEOUT_MILLISECONDS);
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk) => {
                launcherStdout += chunk;
                if (Buffer.byteLength(launcherStdout, "utf8") > ELEVATION_OUTPUT_LIMIT_BYTES) {
                    launcherError = "elevation-output-limit-exceeded";
                    child.kill();
                }
            });
            child.stderr?.on("data", (chunk) => {
                launcherStderr += chunk;
                if (Buffer.byteLength(launcherStderr, "utf8") > ELEVATION_OUTPUT_LIMIT_BYTES) {
                    launcherError = "elevation-output-limit-exceeded";
                    child.kill();
                }
            });
            child.stdin?.once("error", () => {});
            child.stdin?.end(`${launcherInput}\n`);
            child.once("error", () => {
                launcherError = "elevation-launch-failed";
                clearTimeout(timeout);
                resolve();
            });
            child.once("close", (status) => {
                launcherStatus = status;
                clearTimeout(timeout);
                resolve();
            });
        });
        if (connected || activeSockets.size > 0) {
            const settled = await Promise.race([
                pipeSettlement.then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), ELEVATION_PIPE_SETTLE_TIMEOUT_MILLISECONDS)),
            ]);
            if (!settled) pipeError ??= "elevation-pipe-settle-timeout";
        }
    } finally {
        for (const socket of activeSockets) socket.destroy();
        await new Promise((resolve) => {
            let settled = false;
            const finish = (timedOut) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                serverShutdownTimedOut = timedOut;
                resolve();
            };
            const timer = setTimeout(() => finish(true), ELEVATION_SERVER_CLOSE_TIMEOUT_MILLISECONDS);
            server.close(() => finish(false));
        });
    }

    if (serverShutdownTimedOut) return { status: 1, stdout, stderr, errorCode: "elevation-pipe-shutdown-timeout" };
    if (launcherError) return { status: 1, stdout, stderr, errorCode: launcherError };
    const launcher = parseLauncherResult(launcherStdout);
    if (launcher.errorCode) return { status: 1, stdout, stderr, errorCode: launcher.errorCode };
    if (launcherStatus !== 0 || pipeError) {
        return { status: 1, stdout, stderr, errorCode: pipeError ?? "elevation-launch-failed" };
    }
    if (!connected || pipeStatus === null || pipeStatus !== launcher.status) {
        return { status: 1, stdout, stderr, errorCode: "elevation-pipe-result-invalid" };
    }
    const trimmedLauncherError = launcherStderr.trim();
    if (trimmedLauncherError && !(/^#< CLIXML\s*<Objs[\s\S]*<Obj S="progress"[\s\S]*<\/Objs>\s*$/.test(trimmedLauncherError))) {
        return { status: 1, stdout, stderr, errorCode: "elevation-launch-stderr" };
    }
    return { status: pipeStatus, stdout, stderr };
}
