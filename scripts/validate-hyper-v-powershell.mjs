import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hiddenWindowsPowerShellArgs } from "../device-lab-mcp/src/state/windows-system-powershell.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "scripts", "host-control", "hyper-v");
const requireParser = process.argv.includes("--require-parser");
const runPester = process.argv.includes("--pester");

function validationPowerShellArgs(args) {
    return process.platform === "win32" ? hiddenWindowsPowerShellArgs(args) : [...args];
}

function filesUnder(root) {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

function powershellCandidates() {
    const candidates = [];
    if (process.platform === "win32" && process.env.SystemRoot) {
        candidates.push(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    }
    candidates.push("pwsh", "powershell.exe", "powershell");
    return candidates;
}

function findPowerShell() {
    for (const executable of powershellCandidates()) {
        if (executable.includes(join("", "System32")) && !existsSync(executable)) continue;
        const probe = spawnSync(executable, validationPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]), {
            encoding: "utf8",
            windowsHide: true,
        });
        if (!probe.error && probe.status === 0) return executable;
    }
    return null;
}

const executable = findPowerShell();
if (!executable) {
    if (requireParser) throw new Error("PowerShell parser is required but unavailable");
    console.log("SKIP Hyper-V PowerShell parser: PowerShell unavailable");
    process.exit(0);
}

const files = filesUnder(assetRoot).filter((candidate) => /\.ps(?:1|m1)$/i.test(candidate));
const parser = [
    "$ErrorActionPreference = 'Stop'",
    "$Files = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$Failures = @()",
    "foreach ($File in $Files) {",
    "  $Tokens = $null; $Errors = $null",
    "  [Management.Automation.Language.Parser]::ParseFile([string]$File, [ref]$Tokens, [ref]$Errors) | Out-Null",
    "  foreach ($ParseError in @($Errors)) { $Failures += ([string]$File + ':' + [string]$ParseError.Extent.StartLineNumber + ':' + [string]$ParseError.Message) }",
    "}",
    "if ($Failures.Count -gt 0) { [Console]::Error.WriteLine(($Failures -join [Environment]::NewLine)); exit 1 }",
    "[Console]::Out.WriteLine(('PASS PowerShell parser files=' + $Files.Count))",
].join("\n");
const parsed = spawnSync(executable, validationPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", parser]), {
    input: JSON.stringify(files),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
});
if (parsed.status !== 0 || parsed.error) {
    process.stderr.write(parsed.stderr || String(parsed.error || "PowerShell parser failed"));
    process.exit(parsed.status || 1);
}
process.stdout.write(parsed.stdout);

if (runPester) {
    const pesterScript = join(assetRoot, "run-pester.ps1");
    const tested = spawnSync(executable, validationPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", pesterScript]), {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(tested.stdout || "");
    process.stderr.write(tested.stderr || "");
    if (tested.status !== 0 || tested.error) process.exit(tested.status || 1);
}
