$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FixtureResultMarker = "CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:"
$DeclaredFixtureErrorCodes = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($DeclaredCode in @(
    "add-vm-dvd-failed", "add-vm-hard-disk-failed", "administrator-required",
    "attachment-outside-root", "fixture-dacl-identity-invalid", "fixture-dacl-inheritance-enabled",
    "fixture-dacl-rule-count-invalid", "fixture-dacl-rule-invalid", "fixture-integrity-conversion-failed",
    "fixture-integrity-protection-failed", "fixture-integrity-query-failed", "fixture-integrity-tool-failed",
    "fixture-parent-not-directory", "fixture-parent-staging-not-empty", "fixture-root-already-exists",
    "fixture-root-missing", "fixture-root-not-empty", "get-default-dvd-failed",
    "high-integrity-directory-required", "hyper-v-module-missing", "hyper-v-module-path-invalid",
    "marker-content-invalid", "marker-path-invalid", "marker-vm-id-invalid", "marker-vm-id-missing",
    "new-vhd-failed", "new-vm-failed", "operation-invalid", "path-invalid",
    "pathless-hard-disk-refused", "remove-default-dvd-failed", "reparse-point-refused",
    "request-schema-invalid", "request-too-large", "required-cmdlet-missing",
    "required-system-tool-missing", "root-parent-invalid", "root-token-invalid", "set-vm-failed",
    "token-invalid", "unexpected-fixture-content", "vhd-already-exists", "vhd-count-invalid",
    "vhd-path-outside-root", "vm-dvds-not-empty", "vm-hard-disks-not-empty", "vm-id-ambiguous",
    "vm-id-not-unique", "vm-identity-mismatch", "vm-name-already-exists", "vm-name-disagreement",
    "vm-name-invalid", "vm-name-present-without-id", "vm-not-off", "vm-notes-invalid",
    "vm-present-without-fixture-root", "vm-removal-not-observed", "vmms-not-running"
)) { [void]$DeclaredFixtureErrorCodes.Add($DeclaredCode) }

if (-not ("CccHyperVWindowsLibraryNativeSecurity" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CccHyperVWindowsLibraryNativeSecurity
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetNamedSecurityInfo(
        string objectName,
        uint objectType,
        uint securityInformation,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr securityDescriptor,
        uint requestedRevision,
        uint securityInformation,
        out IntPtr stringSecurityDescriptor,
        out uint stringSecurityDescriptorLength);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@
}

function Write-FixtureEnvelope([object]$Envelope, [int]$Depth) {
    $Json = $Envelope | ConvertTo-Json -Compress -Depth $Depth
    $Payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))
    [Console]::Out.WriteLine($FixtureResultMarker + $Payload)
}

function Write-FixtureSuccess([string]$Operation, [object]$Result) {
    Write-FixtureEnvelope ([ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $true
        result = $Result
    }) 6
}

function Write-FixtureFailure([string]$Operation, [string]$ErrorCode) {
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
        $ErrorCode = "native-operation-failed"
    }
    Write-FixtureEnvelope ([ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $false
        errorCode = $ErrorCode
    }) 3
}

function Assert-ExactToken([string]$Token) {
    if ($Token -notmatch '^[0-9a-f]{32}$') { throw "token-invalid" }
}

function Get-CanonicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "path-invalid" }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathInside([string]$Root, [string]$Candidate) {
    $CanonicalRoot = Get-CanonicalPath $Root
    $CanonicalCandidate = Get-CanonicalPath $Candidate
    return $CanonicalCandidate.StartsWith(
        $CanonicalRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-FixtureIdentity([object]$Request) {
    Assert-ExactToken ([string]$Request.token)
    $ExpectedName = "ccc-hyper-v-library-real-$([string]$Request.token)"
    $ExpectedNotes = "ccc-hyper-v-windows-library-real:$([string]$Request.token)"
    if ([string]$Request.vmName -cne $ExpectedName) { throw "vm-name-invalid" }
    if ([string]$Request.notes -cne $ExpectedNotes) { throw "vm-notes-invalid" }

    $Root = Get-CanonicalPath ([string]$Request.root)
    if ([IO.Path]::GetFileName($Root) -cne [string]$Request.token) { throw "root-token-invalid" }
    $ExpectedParent = Get-CanonicalPath (Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "ccc-hyper-v-windows-library-real")
    if ((Get-CanonicalPath ([IO.Path]::GetDirectoryName($Root))) -ine $ExpectedParent) {
        throw "root-parent-invalid"
    }
    $ExpectedMarker = Join-Path $Root ".ccc-hyper-v-library-fixture"
    if ((Get-CanonicalPath ([string]$Request.markerPath)) -cne (Get-CanonicalPath $ExpectedMarker)) {
        throw "marker-path-invalid"
    }
    return $Root
}

function Get-VMByExactId([Guid]$Id) {
    return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [Guid]$_.Id -eq $Id })
}

function Get-VMByExactName([string]$Name) {
    return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [string]$_.Name -ceq $Name })
}

function Resolve-TrustedHyperVModulePath {
    $ModuleRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\Modules\Hyper-V"))
    if (-not (Test-Path -LiteralPath $ModuleRoot -PathType Container)) { throw "hyper-v-module-missing" }
    $RootItem = Get-Item -LiteralPath $ModuleRoot -Force -ErrorAction Stop
    if (($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }

    $DirectManifest = Join-Path $ModuleRoot "Hyper-V.psd1"
    if (Test-Path -LiteralPath $DirectManifest -PathType Leaf) {
        $DirectItem = Get-Item -LiteralPath $DirectManifest -Force -ErrorAction Stop
        if (($DirectItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        return [IO.Path]::GetFullPath($DirectManifest)
    }

    $Candidates = @()
    foreach ($VersionDirectory in @(Get-ChildItem -LiteralPath $ModuleRoot -Directory -Force -ErrorAction Stop)) {
        if ($VersionDirectory.Name -notmatch '^\d+(?:\.\d+){1,3}$') { continue }
        if (($VersionDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        $Manifest = Join-Path $VersionDirectory.FullName "Hyper-V.psd1"
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { continue }
        $ManifestItem = Get-Item -LiteralPath $Manifest -Force -ErrorAction Stop
        if (($ManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        $FullManifest = [IO.Path]::GetFullPath($Manifest)
        if (-not $FullManifest.StartsWith(
            $ModuleRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw "hyper-v-module-path-invalid" }
        $Candidates += [pscustomobject]@{
            Version = [Version]$VersionDirectory.Name
            Path = $FullManifest
        }
    }
    if ($Candidates.Count -eq 0) { throw "hyper-v-module-missing" }
    return [string](($Candidates | Sort-Object -Property Version -Descending | Select-Object -First 1).Path)
}

function Import-TrustedHyperVModule {
    $ModulePath = Resolve-TrustedHyperVModulePath
    $ExpectedModuleBase = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($ModulePath))
    $Loaded = @(Import-Module -Name $ModulePath -Force -PassThru -ErrorAction Stop)
    if ($Loaded.Count -eq 0 -or -not ($Loaded | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ieq $ExpectedModuleBase
    })) {
        throw "hyper-v-module-path-invalid"
    }
}

function Assert-NoReparsePoint([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse-point-refused" }
}

function Get-IntegrityLabelSddl([string]$Path) {
    $Owner = [IntPtr]::Zero
    $Group = [IntPtr]::Zero
    $Dacl = [IntPtr]::Zero
    $Sacl = [IntPtr]::Zero
    $Descriptor = [IntPtr]::Zero
    $LabelSecurityInformation = [uint32]0x00000010
    $SeFileObject = [uint32]1
    $Result = [CccHyperVWindowsLibraryNativeSecurity]::GetNamedSecurityInfo(
        $Path,
        $SeFileObject,
        $LabelSecurityInformation,
        [ref]$Owner,
        [ref]$Group,
        [ref]$Dacl,
        [ref]$Sacl,
        [ref]$Descriptor
    )
    if ($Result -ne 0 -or $Descriptor -eq [IntPtr]::Zero) { throw "fixture-integrity-query-failed" }
    try {
        $StringDescriptor = [IntPtr]::Zero
        $StringLength = [uint32]0
        $Converted = [CccHyperVWindowsLibraryNativeSecurity]::ConvertSecurityDescriptorToStringSecurityDescriptor(
            $Descriptor,
            [uint32]1,
            $LabelSecurityInformation,
            [ref]$StringDescriptor,
            [ref]$StringLength
        )
        if (-not $Converted -or $StringDescriptor -eq [IntPtr]::Zero) { throw "fixture-integrity-conversion-failed" }
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringUni($StringDescriptor)
        } finally {
            [void][CccHyperVWindowsLibraryNativeSecurity]::LocalFree($StringDescriptor)
        }
    } finally {
        [void][CccHyperVWindowsLibraryNativeSecurity]::LocalFree($Descriptor)
    }
}

function Assert-HighIntegrityDirectory([string]$Path) {
    Assert-NoReparsePoint $Path
    $Sddl = [string](Get-IntegrityLabelSddl $Path)
    if ($Sddl -notmatch '(?i)(;;;HI\)|S-1-16-12288)') { throw "high-integrity-directory-required" }
}

function Assert-RestrictedDirectoryDacl([string]$Path) {
    $Acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $Acl.AreAccessRulesProtected) { throw "fixture-dacl-inheritance-enabled" }
    $AllowedSids = @("S-1-5-18", "S-1-5-32-544")
    $Rules = @($Acl.Access)
    if ($Rules.Count -ne $AllowedSids.Count) { throw "fixture-dacl-rule-count-invalid" }
    foreach ($Rule in $Rules) {
        try {
            $TranslatedIdentity = $Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
            $Sid = ([Security.Principal.SecurityIdentifier]$TranslatedIdentity).Value
        } catch {
            throw "fixture-dacl-identity-invalid"
        }
        if (($AllowedSids -notcontains $Sid) -or
            $Rule.IsInherited -or
            $Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            [int]$Rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or
            $Rule.InheritanceFlags -ne (
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            ) -or
            $Rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw "fixture-dacl-rule-invalid"
        }
    }
}

function Protect-FixtureDirectory([string]$Path) {
    Assert-NoReparsePoint $Path
    $Security = [Security.AccessControl.DirectorySecurity]::new()
    $Security.SetAccessRuleProtection($true, $false)
    $Inheritance = (
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
    foreach ($SidValue in @("S-1-5-18", "S-1-5-32-544")) {
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($SidValue),
            [Security.AccessControl.FileSystemRights]::FullControl,
            $Inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$Security.AddAccessRule($Rule)
    }
    [IO.Directory]::SetAccessControl($Path, $Security)
    $Icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
    try {
        & $Icacls $Path "/setintegritylevel" "(OI)(CI)H" | Out-Null
    } catch { throw "fixture-integrity-tool-failed" }
    if ($LASTEXITCODE -ne 0) { throw "fixture-integrity-protection-failed" }
    Assert-HighIntegrityDirectory $Path
    Assert-RestrictedDirectoryDacl $Path
}

function Initialize-FixtureParent([string]$Root) {
    $ProgramData = Get-CanonicalPath ([Environment]::GetFolderPath("CommonApplicationData"))
    Assert-NoReparsePoint $ProgramData
    $Parent = Get-CanonicalPath ([IO.Path]::GetDirectoryName($Root))
    if (Test-Path -LiteralPath $Parent -PathType Container) {
        Assert-HighIntegrityDirectory $Parent
        Assert-RestrictedDirectoryDacl $Parent
        return $Parent
    }
    if (Test-Path -LiteralPath $Parent) { throw "fixture-parent-not-directory" }
    $Staging = Join-Path $ProgramData (".ccc-hyper-v-library-stage-" + [Guid]::NewGuid().ToString("N"))
    [IO.Directory]::CreateDirectory($Staging) | Out-Null
    try {
        Protect-FixtureDirectory $Staging
        Assert-HighIntegrityDirectory $Staging
        Assert-RestrictedDirectoryDacl $Staging
        [IO.Directory]::Move($Staging, $Parent)
    } catch {
        if (Test-Path -LiteralPath $Staging -PathType Container) {
            Assert-HighIntegrityDirectory $Staging
            Assert-RestrictedDirectoryDacl $Staging
            if (@(Get-ChildItem -LiteralPath $Staging -Force -ErrorAction Stop).Count -ne 0) {
                throw "fixture-parent-staging-not-empty"
            }
            Remove-Item -LiteralPath $Staging -Force -ErrorAction Stop
        }
        throw
    }
    Assert-HighIntegrityDirectory $Parent
    Assert-RestrictedDirectoryDacl $Parent
    return $Parent
}

function Assert-ProtectedFixtureRoot([string]$Root) {
    $Parent = Get-CanonicalPath ([IO.Path]::GetDirectoryName($Root))
    Assert-HighIntegrityDirectory $Parent
    Assert-RestrictedDirectoryDacl $Parent
    Assert-HighIntegrityDirectory $Root
    Assert-RestrictedDirectoryDacl $Root
}

function Assert-FixtureCleanupBoundary([string]$Root) {
    $Parent = Get-CanonicalPath ([IO.Path]::GetDirectoryName($Root))
    Assert-HighIntegrityDirectory $Parent
    Assert-RestrictedDirectoryDacl $Parent
    Assert-NoReparsePoint $Root
    Assert-HighIntegrityDirectory $Root
    $RootAcl = Get-Acl -LiteralPath $Root -ErrorAction Stop
    if (-not $RootAcl.AreAccessRulesProtected) { throw "fixture-dacl-inheritance-enabled" }
}

function Set-FixtureMarker([object]$Request, [string]$VmId) {
    [ordered]@{
        schemaVersion = 1
        token = [string]$Request.token
        vmId = $VmId
        vmName = [string]$Request.vmName
        notes = [string]$Request.notes
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath ([string]$Request.markerPath) -NoNewline -Encoding Ascii
}

function Get-FixtureMarker([object]$Request) {
    $Marker = Get-Content -LiteralPath ([string]$Request.markerPath) -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if (([int]$Marker.schemaVersion -ne 1) -or
        [string]$Marker.token -cne [string]$Request.token -or
        [string]$Marker.vmName -cne [string]$Request.vmName -or
        [string]$Marker.notes -cne [string]$Request.notes) {
        throw "marker-content-invalid"
    }
    return $Marker
}

function Invoke-Preflight {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
    if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "administrator-required"
    }
    $SystemDirectory = [Environment]::SystemDirectory
    foreach ($Command in @(
        "Hyper-V\Get-VM", "Hyper-V\New-VM", "Hyper-V\Set-VM", "Hyper-V\Start-VM",
        "Hyper-V\Stop-VM", "Hyper-V\Remove-VM", "Hyper-V\Get-VMHardDiskDrive",
        "Hyper-V\Add-VMHardDiskDrive", "Hyper-V\Get-VMDvdDrive", "Hyper-V\Add-VMDvdDrive",
        "Hyper-V\Remove-VMDvdDrive", "Hyper-V\New-VHD"
    )) {
        if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "required-cmdlet-missing" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $SystemDirectory "icacls.exe") -PathType Leaf)) {
        throw "required-system-tool-missing"
    }
    $Vmms = Get-Service -Name vmms -ErrorAction Stop
    if ([string]$Vmms.Status -ne "Running") { throw "vmms-not-running" }
    return [ordered]@{ elevated = $true; vmms = "Running" }
}

function Invoke-Create([object]$Request) {
    $Root = Assert-FixtureIdentity $Request
    $VmName = [string]$Request.vmName
    [void](Initialize-FixtureParent $Root)
    if (Test-Path -LiteralPath $Root) { throw "fixture-root-already-exists" }
    if ((Get-VMByExactName $VmName).Count -ne 0) { throw "vm-name-already-exists" }

    $CreatedVm = $null
    try {
        New-Item -ItemType Directory -Path $Root -ErrorAction Stop | Out-Null
        Protect-FixtureDirectory $Root
        Assert-ProtectedFixtureRoot $Root
        Set-FixtureMarker $Request ""
        try {
            $CreatedVm = Hyper-V\New-VM -Name $VmName -Generation 2 -NoVHD -ErrorAction Stop
        } catch { throw "new-vm-failed" }
        Set-FixtureMarker $Request (([Guid]$CreatedVm.Id).ToString("D").ToLowerInvariant())
        try {
            # Standard, not Disabled: the scenario exercises the library's checkpoint primitives
            # against this fixture. Standard rather than Production because the fixture has blank
            # VHDXs and no guest OS, so there are no integration services to quiesce.
            # Automatic checkpoints stay off so starting the VM never creates one behind the test.
            Hyper-V\Set-VM -VM $CreatedVm -Notes ([string]$Request.notes) -AutomaticCheckpointsEnabled $false -CheckpointType Standard -ErrorAction Stop
        } catch { throw "set-vm-failed" }
        try {
            $DefaultDvds = @(Hyper-V\Get-VMDvdDrive -VM $CreatedVm -ErrorAction Stop)
        } catch { throw "get-default-dvd-failed" }
        $DefaultDvds | ForEach-Object {
            $Dvd = $_
            try {
                Hyper-V\Remove-VMDvdDrive -VMDvdDrive $Dvd -ErrorAction Stop
            } catch { throw "remove-default-dvd-failed" }
        }
        return [ordered]@{
            token = [string]$Request.token
            root = $Root
            markerPath = Get-CanonicalPath ([string]$Request.markerPath)
            vmId = ([Guid]$CreatedVm.Id).ToString("D").ToLowerInvariant()
            vmName = $VmName
            notes = [string]$Request.notes
            vhdPaths = @(
                Join-Path $Root "disk-1.vhdx"
                Join-Path $Root "disk-2.vhdx"
            )
        }
    } catch {
        # The Node scenario always invokes the guarded cleanup operation after a
        # create failure. Preserve evidence here rather than bypassing its
        # DACL, marker, VM identity, attachment, and deletion-time checks.
        throw
    }
}

function Invoke-Attach([object]$Request) {
    $Root = Assert-FixtureIdentity $Request
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "fixture-root-missing" }
    Assert-ProtectedFixtureRoot $Root
    $Marker = Get-FixtureMarker $Request
    if ([Guid][string]$Marker.vmId -ne [Guid][string]$Request.vmId) { throw "marker-vm-id-invalid" }
    $VirtualMachines = Get-VMByExactId ([Guid][string]$Request.vmId)
    if ($VirtualMachines.Count -ne 1) { throw "vm-id-not-unique" }
    $VirtualMachine = $VirtualMachines[0]
    if ([string]$VirtualMachine.Name -cne [string]$Request.vmName -or [string]$VirtualMachine.Notes -cne [string]$Request.notes) {
        throw "vm-identity-mismatch"
    }
    if ([string]$VirtualMachine.State -ne "Off") { throw "vm-not-off" }
    if (@(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop).Count -ne 0) { throw "vm-hard-disks-not-empty" }
    if (@(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop).Count -ne 0) { throw "vm-dvds-not-empty" }
    if (@($Request.vhdPaths).Count -ne 2) { throw "vhd-count-invalid" }

    foreach ($VhdPathValue in @($Request.vhdPaths)) {
        $VhdPath = Get-CanonicalPath ([string]$VhdPathValue)
        if (-not (Test-PathInside $Root $VhdPath)) { throw "vhd-path-outside-root" }
        if (Test-Path -LiteralPath $VhdPath) { throw "vhd-already-exists" }
        try {
            Hyper-V\New-VHD -Path $VhdPath -Dynamic -SizeBytes 64MB -ErrorAction Stop
        } catch { throw "new-vhd-failed" }
        try {
            Hyper-V\Add-VMHardDiskDrive -VM $VirtualMachine -Path $VhdPath -ErrorAction Stop
        } catch { throw "add-vm-hard-disk-failed" }
    }
    try {
        Hyper-V\Add-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop
        Hyper-V\Add-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop
    } catch { throw "add-vm-dvd-failed" }
    return [ordered]@{ attached = $true }
}

function Invoke-Cleanup([object]$Request) {
    $Root = Assert-FixtureIdentity $Request
    if (@($Request.vhdPaths).Count -ne 2) { throw "vhd-count-invalid" }
    $AllowedFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$AllowedFiles.Add((Get-CanonicalPath ([string]$Request.markerPath)))
    foreach ($VhdPathValue in @($Request.vhdPaths)) {
        $VhdPath = Get-CanonicalPath ([string]$VhdPathValue)
        if (-not (Test-PathInside $Root $VhdPath)) { throw "vhd-path-outside-root" }
        [void]$AllowedFiles.Add($VhdPath)
    }

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        if ([string]::IsNullOrWhiteSpace([string]$Request.vmId)) {
            if ((Get-VMByExactName ([string]$Request.vmName)).Count -ne 0) {
                throw "vm-name-present-without-id"
            }
            return [ordered]@{ cleaned = $true }
        }
        if (((Get-VMByExactId ([Guid][string]$Request.vmId)).Count -ne 0) -or
            (Get-VMByExactName ([string]$Request.vmName)).Count -ne 0) {
            throw "vm-present-without-fixture-root"
        }
        return [ordered]@{ cleaned = $true }
    }
    Assert-FixtureCleanupBoundary $Root
    $Marker = Get-FixtureMarker $Request
    if ([string]::IsNullOrWhiteSpace([string]$Marker.vmId)) {
        throw "marker-vm-id-missing"
    } else {
        $MarkerId = ([Guid][string]$Marker.vmId).ToString("D").ToLowerInvariant()
        if ((-not [string]::IsNullOrWhiteSpace([string]$Request.vmId)) -and
            $MarkerId -cne ([Guid][string]$Request.vmId).ToString("D").ToLowerInvariant()) {
            throw "marker-vm-id-invalid"
        }
        $Request.vmId = $MarkerId
    }
    # A checkpoint creates .avhdx differencing disks beside the fixture VHDXs. Removing the
    # checkpoint on an Off VM merges them away, but a scenario that fails between create and remove
    # leaves them behind. They are fixture-owned by construction — every attachment is asserted to
    # live inside this protected root — so admit them to the allowlist and let the sweep below
    # delete them. Without this, guarded cleanup would refuse and orphan the VM.
    foreach ($Item in @(Get-ChildItem -LiteralPath $Root -Force -File -Filter "*.avhdx" -ErrorAction Stop)) {
        [void]$AllowedFiles.Add((Get-CanonicalPath $Item.FullName))
    }
    foreach ($Item in @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop)) {
        if ($Item.PSIsContainer -or -not $AllowedFiles.Contains((Get-CanonicalPath $Item.FullName))) {
            throw "unexpected-fixture-content"
        }
        Assert-NoReparsePoint $Item.FullName
    }

    $VirtualMachines = if ([string]::IsNullOrWhiteSpace([string]$Request.vmId)) { @() } else { Get-VMByExactId ([Guid][string]$Request.vmId) }
    if ($VirtualMachines.Count -gt 1) { throw "vm-id-ambiguous" }
    if ($VirtualMachines.Count -eq 1) {
        $VirtualMachine = $VirtualMachines[0]
        if ([string]$VirtualMachine.Name -cne [string]$Request.vmName -or [string]$VirtualMachine.Notes -cne [string]$Request.notes) {
            throw "vm-identity-mismatch"
        }
        $SameName = Get-VMByExactName ([string]$Request.vmName)
        if ($SameName.Count -ne 1 -or [Guid]$SameName[0].Id -ne [Guid]$VirtualMachine.Id) { throw "vm-name-disagreement" }
        foreach ($Disk in @(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop)) {
            if ([string]::IsNullOrWhiteSpace([string]$Disk.Path)) { throw "pathless-hard-disk-refused" }
            if (-not (Test-PathInside $Root ([string]$Disk.Path))) { throw "attachment-outside-root" }
        }
        foreach ($Dvd in @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$Dvd.Path) -and -not (Test-PathInside $Root ([string]$Dvd.Path))) {
                throw "attachment-outside-root"
            }
        }
        if ([string]$VirtualMachine.State -ne "Off") {
            Hyper-V\Stop-VM -VM $VirtualMachine -TurnOff -Force -ErrorAction Stop | Out-Null
        }
        Hyper-V\Remove-VM -VM $VirtualMachine -Force -ErrorAction Stop
    } elseif ((Get-VMByExactName ([string]$Request.vmName)).Count -ne 0) {
        throw "vm-name-present-without-id"
    }

    $RemainingById = if ([string]::IsNullOrWhiteSpace([string]$Request.vmId)) { @() } else { Get-VMByExactId ([Guid][string]$Request.vmId) }
    if ($RemainingById.Count -ne 0 -or (Get-VMByExactName ([string]$Request.vmName)).Count -ne 0) {
        throw "vm-removal-not-observed"
    }
    Assert-FixtureCleanupBoundary $Root
    Protect-FixtureDirectory $Root
    foreach ($File in $AllowedFiles) {
        Assert-ProtectedFixtureRoot $Root
        if (Test-Path -LiteralPath $File -PathType Leaf) {
            Assert-NoReparsePoint $File
            Remove-Item -LiteralPath $File -Force -ErrorAction Stop
        }
    }
    Assert-ProtectedFixtureRoot $Root
    if (@(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop).Count -ne 0) { throw "fixture-root-not-empty" }
    Remove-Item -LiteralPath $Root -Force -ErrorAction Stop
    return [ordered]@{ cleaned = $true }
}

$Operation = "preflight"
try {
    $RawRequest = [string]$global:CccHyperVJsonInput
    if ([Text.Encoding]::UTF8.GetByteCount($RawRequest) -gt 65536) { throw "request-too-large" }
    $Request = $RawRequest | ConvertFrom-Json -ErrorAction Stop
    if ([int]$Request.schemaVersion -ne 1) { throw "request-schema-invalid" }
    $Operation = [string]$Request.operation
    Import-TrustedHyperVModule
    $Result = switch ($Operation) {
        "preflight" { Invoke-Preflight }
        "create" { Invoke-Create $Request }
        "attach" { Invoke-Attach $Request }
        "cleanup" { Invoke-Cleanup $Request }
        default { throw "operation-invalid" }
    }
    Write-FixtureSuccess $Operation $Result
} catch {
    $ErrorCode = [string]$_.Exception.Message
    if (-not $DeclaredFixtureErrorCodes.Contains($ErrorCode)) {
        $ErrorCode = switch ($Operation) {
            "create" { "create-failed" }
            "attach" { "attach-failed" }
            "cleanup" { "cleanup-failed" }
            default { "preflight-failed" }
        }
    }
    Write-FixtureFailure $Operation $ErrorCode
    exit 1
}
