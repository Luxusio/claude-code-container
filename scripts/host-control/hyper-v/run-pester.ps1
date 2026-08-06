$ErrorActionPreference = 'Stop'
Import-Module PSScriptAnalyzer -RequiredVersion 1.24.0 -Force -ErrorAction Stop
if ((Get-Module PSScriptAnalyzer).Version -ne [Version]'1.24.0') { throw 'Unexpected PSScriptAnalyzer version' }
$AnalyzerFindings = @(Invoke-ScriptAnalyzer -Path $PSScriptRoot -Recurse -Severity Error)
if ($AnalyzerFindings.Count -gt 0) {
    $AnalyzerFindings | Format-Table -AutoSize | Out-String | Write-Error
    exit 1
}

Import-Module Pester -RequiredVersion 5.7.1 -Force -ErrorAction Stop
if ((Get-Module Pester).Version -ne [Version]'5.7.1') { throw 'Unexpected Pester version' }
$Result = Invoke-Pester -Path (Join-Path $PSScriptRoot 'tests') -PassThru
if ($Result.FailedCount -gt 0) { exit 1 }
