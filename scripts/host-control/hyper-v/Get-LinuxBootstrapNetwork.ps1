$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

try {
    $TrustedModuleRoot = Join-Path $PSHOME 'Modules'
    $env:PSModulePath = $TrustedModuleRoot
    Import-Module Hyper-V -ErrorAction Stop
    Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Core.psm1') -Force -ErrorAction Stop
    Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Linux.psm1') -Force -ErrorAction Stop

    $Contract = Read-CccJsonContract
    $Vm = Get-CccOwnedVm $Contract
    Get-CccLinuxBootstrapNetworkResult $Vm | ConvertTo-Json -Compress -Depth 4
} catch {
    $Reported = [string]$_.Exception.Message
    $DiagnosticCode = if ($Reported -match '^hyper-v-bootstrap-[a-z0-9-]{3,96}$') {
        $Reported
    } else {
        'hyper-v-bootstrap-network-command-failed'
    }
    Write-Output "CCC_HYPER_V_STAGE:$DiagnosticCode"
    exit 1
}
