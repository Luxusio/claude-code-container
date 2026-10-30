import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NESTED_CLAIM_FUNCTIONS, nestedClaimCommand, nestedCompleteClaimCommand } from "../../scripts/real-tests/nested-hyper-v-claim.js";

const runId = "a".repeat(32);
const nextRun = "b".repeat(32);
const boot = "20261003T1200000000000Z";
const nextBoot = "20261003T1300000000000Z";
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const native = process.platform === "win32" && spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;

// Native state-machine tests need Windows PowerShell, but no VM, CIM, reboot or elevation.
// Only ACL application is stubbed so these isolated fixtures remain accessible to the test user.
function execute(body: string) {
    const root = mkdtempSync(join(tmpdir(), "nested-claim-"));
    const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n${NESTED_CLAIM_FUNCTIONS}\n` +
        `function Set-Acl { param($LiteralPath,$AclObject,$ErrorAction) }\n` +
        `$root='${root.replace(/'/g, "''")}'\n` +
        `function Claim($run='${runId}',$boot='${boot}',$op='acquire') { Invoke-NestedClaim -Root $root -RunId $run -BootId $boot -Operation $op -MutexName 'Local\\${root.split(/[\\/]/).pop()}' }\n` +
        `function Refused([scriptblock]$action) { $failed=$false; try { & $action | Out-Null } catch { $failed=$true }; if (-not $failed) { throw 'expected-refusal' } }\n` + body;
    try {
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 45_000 });
        expect(result.error).toBeUndefined();
        expect(result.stderr, result.stdout).toBe("");
        expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("nested guest claim builders", () => {
    it.each(["", "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(32) + "\n", "'; Remove-Item C:\\ -Recurse; '"])("rejects invalid run identity %j", (value) => {
        expect(() => nestedClaimCommand(value)).toThrow("nested-claim-input-invalid");
        expect(() => nestedCompleteClaimCommand(value)).toThrow("nested-claim-input-invalid");
    });
    it("binds both operations to the same production root, guest mutex and verified boot source", () => {
        for (const [builder, operation] of [[nestedClaimCommand, "acquire"], [nestedCompleteClaimCommand, "complete"]] as const) {
            const command = builder(runId);
            expect(command).toContain(NESTED_CLAIM_FUNCTIONS);
            expect(command).toContain("Get-CimInstance Win32_OperatingSystem -ErrorAction Stop");
            expect(command).toContain("$boot -isnot [DateTime]");
            expect(command).toContain(`-Root 'C:\\ccc-nested-development' -RunId '${runId}' -BootId $bootId -Operation '${operation}' -MutexName 'Global\\ccc-nested-development-claim'`);
        }
    });
});

describe.skipIf(!native)("native guest claim state transitions", () => {
    it("serializes competing guest processes so only one acquires", () => execute(`
$definitions=''
foreach ($name in @('Assert-NestedPlainItem','Assert-NestedBootId','Invoke-NestedClaim','Set-Acl')) {
  $definitions += 'function '+$name+' {'+[Environment]::NewLine+(Get-Command $name).Definition+[Environment]::NewLine+'}'+[Environment]::NewLine
}
$jobs=@()
try {
  foreach ($run in @('${runId}','${nextRun}')) {
    $jobs += Start-Job -ArgumentList $definitions,$root,$run -ScriptBlock {
      param($definitions,$root,$run)
      $ErrorActionPreference='Stop'
      $ProgressPreference='SilentlyContinue'
      . ([scriptblock]::Create($definitions))
      try { Invoke-NestedClaim -Root $root -RunId $run -BootId '${boot}' -Operation 'acquire' -MutexName ('Local\\'+(Split-Path $root -Leaf)) } catch { 'refused' }
    }
  }
  $jobs | Wait-Job -Timeout 30 | Out-Null
  $results=@($jobs | Receive-Job)
  if (@($results | Where-Object { $_ -eq 'claimed' }).Count -ne 1 -or @($results | Where-Object { $_ -eq 'refused' }).Count -ne 1) { throw 'competing-claim-failed' }
} finally { $jobs | Stop-Job; $jobs | Remove-Job -Force }
`));
    it("retains completed claim on same boot and reclaims only on a new boot", () => execute(`
Claim | Out-Null
Refused { Claim '${nextRun}' }
Claim '${runId}' '${boot}' 'complete' | Out-Null
Refused { Claim '${nextRun}' }
Claim '${nextRun}' '${nextBoot}' | Out-Null
$claim=Get-Content (Join-Path $root 'active/claim.json') -Raw | ConvertFrom-Json
if ($claim.runId -ne '${nextRun}' -or $claim.state -ne 'active' -or $claim.bootId -ne '${nextBoot}') { throw 'wrong-owner' }
`));
    it("allows the owner to complete after preparation reboot and rejects other owners", () => execute(`
Claim | Out-Null
Refused { Claim '${nextRun}' '${nextBoot}' }
Refused { Claim '${nextRun}' '${nextBoot}' 'complete' }
Claim '${runId}' '${nextBoot}' 'complete' | Out-Null
Refused { Claim '${nextRun}' '${nextBoot}' }
Refused { Claim '${runId}' '${boot}' 'complete' }
`));
    it.each([
        "", "not-json", "{}",
        JSON.stringify({ runId, bootId: boot, state: "active" }),
        JSON.stringify({ runId, bootId: "invalid", state: "completed" }),
        JSON.stringify({ runId: 123, bootId: boot, state: "completed" }),
        JSON.stringify({ runId, bootId: boot, state: "completed", extra: true }),
    ])("preserves legacy, active or malformed claims: %s", (metadata) => execute(`
$active=New-Item -ItemType Directory (Join-Path $root 'active')
${metadata ? `'${metadata.replace(/'/g, "''")}' | Set-Content (Join-Path $active.FullName 'claim.json')` : ""}
Refused { Claim '${nextRun}' '${nextBoot}' }
if (-not (Test-Path $active.FullName)) { throw 'claim-removed' }
`));
    it("refuses unknown files without deleting them", () => execute(`
Claim | Out-Null
Claim '${runId}' '${boot}' 'complete' | Out-Null
$unknown=Join-Path $root 'active/unknown'
'keep' | Set-Content $unknown
Refused { Claim '${nextRun}' '${nextBoot}' }
if ((Get-Content $unknown) -ne 'keep') { throw 'unknown-content-deleted' }
`));
    it("rejects marker hard links", () => execute(`
Claim | Out-Null
Claim '${runId}' '${boot}' 'complete' | Out-Null
$marker=Join-Path $root 'active/claim.json'
$outside=Join-Path $root 'outside.json'
Move-Item $marker $outside
New-Item -ItemType HardLink -Path $marker -Target $outside | Out-Null
Refused { Claim '${nextRun}' '${nextBoot}' }
if (-not (Test-Path $outside)) { throw 'link-target-removed' }
`));
    it.each(["root", "active"])("rejects %s directory junctions", (location) => execute(`
$outside=New-Item -ItemType Directory (Join-Path $root 'outside')
'keep' | Set-Content (Join-Path $outside.FullName 'sentinel')
${location === "root" ? "$root=Join-Path $root 'linked-root'; $link=$root" : "$link=Join-Path $root 'active'"}
New-Item -ItemType Junction -Path $link -Target $outside.FullName | Out-Null
try {
  Refused { Claim }
  if ((Get-Content (Join-Path $outside.FullName 'sentinel')) -ne 'keep') { throw 'junction-target-modified' }
} finally { [IO.Directory]::Delete($link) }
`));
});
