import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hiddenWindowsPowerShellArgs } from "../device-lab-mcp/src/state/windows-system-powershell.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "scripts", "host-control", "hyper-v");
const requireParser = process.argv.includes("--require-parser");
const runPester = process.argv.includes("--pester");
const libraryFixtureOnly = process.argv.includes("--library-fixture-only");

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

const libraryFixture = join(repoRoot, "scripts", "real-tests", "hyper-v-windows-library-fixture.ps1");

// The session bootstrap is PowerShell too, but it is a TypeScript string array joined with "; ", so
// it is on no disk path this walker would find and has never been parse-checked anywhere. Its shape
// is fragile in a way only a parser catches: the try/catch is one array element concatenated with
// "+" precisely because joining across them would emit `try {...}; catch {...}`, which does not
// parse. Nothing else enforces that. Written to a temp file so the parser sees what the child
// actually runs; a regression here would otherwise surface as a hung session on a Windows host.
async function bootstrapSource() {
    // Read from the built module rather than parsed out of its text, so what the parser checks is
    // the exact string the session hands to PowerShell. Absent before a build, which is why this
    // degrades to skipping that one file rather than failing.
    const built = join(repoRoot, "dist", "hyper-v-windows", "low-level", "powershell-session.js");
    if (!existsSync(built)) return null;
    const { HYPER_V_WINDOWS_SESSION_BOOTSTRAP } = await import(pathToFileURL(built).href);
    if (typeof HYPER_V_WINDOWS_SESSION_BOOTSTRAP !== "string") return null;
    const path = join(mkdtempSync(join(tmpdir(), "ccc-hyper-v-bootstrap-")), "session-bootstrap.ps1");
    writeFileSync(path, HYPER_V_WINDOWS_SESSION_BOOTSTRAP, "utf8");
    return path;
}

const bootstrap = libraryFixtureOnly ? null : await bootstrapSource();
const files = (libraryFixtureOnly ? [libraryFixture] : [
    ...filesUnder(assetRoot),
    libraryFixture,
    ...(bootstrap ? [bootstrap] : []),
]).filter((candidate) => /\.ps(?:1|m1)$/i.test(candidate));
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
