import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function validateNetworkOperationAsset() {
    const path = join(assetRoot, "Invoke-HyperVWindowsOperation.ps1");
    const source = readFileSync(path, "utf8");
    const requiredTrustFragments = [
        '[Environment]::SystemDirectory',
        '@("WindowsPowerShell", "v1.0", "Modules")',
        '[IO.FileAttributes]::ReparsePoint',
        '$ModuleName -notin @("Hyper-V", "NetAdapter", "NetTCPIP", "NetNat")',
        '$InvalidCode = if ($ModuleName -eq "Hyper-V")',
        'Microsoft.PowerShell.Core\\Import-Module -Name $ModulePath',
    ];
    for (const fragment of requiredTrustFragments) {
        if (!source.includes(fragment)) throw new Error(`Hyper-V operation asset is missing trust fence: ${fragment}`);
    }
    const qualifiedCommands = {
        "Get-VM": "Hyper-V",
        "Get-VMSwitch": "Hyper-V",
        "New-VMSwitch": "Hyper-V",
        "Set-VMSwitch": "Hyper-V",
        "Remove-VMSwitch": "Hyper-V",
        "Get-VMNetworkAdapter": "Hyper-V",
        "Get-NetAdapter": "NetAdapter",
        "Get-NetIPAddress": "NetTCPIP",
        "New-NetIPAddress": "NetTCPIP",
        "Remove-NetIPAddress": "NetTCPIP",
        "Get-NetNat": "NetNat",
        "New-NetNat": "NetNat",
        "Remove-NetNat": "NetNat",
    };
    for (const [command, moduleName] of Object.entries(qualifiedCommands)) {
        if (!source.includes(`${moduleName}\\${command}`)) {
            throw new Error(`Hyper-V operation asset is missing module-qualified command: ${moduleName}\\${command}`);
        }
        const unqualified = new RegExp(`(?:^|[|;{}]\\s*)${command}\\s`, "m");
        if (unqualified.test(source)) throw new Error(`Hyper-V operation asset contains unqualified command: ${command}`);
    }
    console.log(`PASS Hyper-V network PowerShell trust commands=${Object.keys(qualifiedCommands).length}`);
}

validateNetworkOperationAsset();

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
    // This runs inside `npm run build` (via test:hyper-v:static), so on a Linux box it is the last
    // thing standing between an edited .ps1 asset and a green build — and it steps aside. Say so
    // plainly: the previous message named the cause but not the consequence, and a developer reading
    // a passing build had no way to know their PowerShell edit was unverified. The real gate is the
    // windows-latest CI job, which builds and then runs this with --require-parser.
    console.log("SKIP Hyper-V PowerShell parser: no PowerShell on this host.");
    console.log("     .ps1 assets, the session bootstrap and the Windows Setup diagnostics programs");
    console.log("     were NOT syntax-checked by this build.");
    console.log("     They are checked by the hyper-v-powershell-static job on windows-latest.");
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

// The Windows Setup diagnostics module emits three PowerShell programs the same way the session
// bootstrap does — a TypeScript string array joined at runtime — so they are on no disk path the
// walker above can find, and PSScriptAnalyzer's directory walk misses them for the same reason.
// Until this they were checked only by string-containment assertions, which cannot see an
// unterminated string or an unbalanced brace. Loaded through the repo's source loader because the
// module is TypeScript importing further TypeScript by `.js` specifier; plain node resolves those
// to files that do not exist.
async function setupDiagnosticsSources() {
    const loader = pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href;
    const module = pathToFileURL(join(repoRoot, "scripts", "real-tests", "hyper-v-windows-setup-diagnostics.ts")).href;
    const probe = spawnSync(process.execPath, [
        "--import", loader,
        "-e", `import(${JSON.stringify(module)}).then((m) => process.stdout.write(JSON.stringify(m.hyperVWindowsSetupDiagnosticsPrograms())))`,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (probe.error || probe.status !== 0) return null;
    let programs;
    try {
        programs = JSON.parse(String(probe.stdout || ""));
    } catch {
        return null;
    }
    if (!Array.isArray(programs) || programs.length === 0 || programs.some((entry) => typeof entry !== "string" || !entry)) return null;
    const directory = mkdtempSync(join(tmpdir(), "ccc-hyper-v-setup-diagnostics-"));
    return programs.map((entry, index) => {
        const path = join(directory, `setup-diagnostics-${index}.ps1`);
        writeFileSync(path, entry, "utf8");
        return path;
    });
}

// One flag drives all three decisions below — which sources are wanted, whether the bootstrap is
// fetched, and whether its absence is an error. Three separate reads of `libraryFixtureOnly` would
// be three chances to disagree.
const useFullAssetSet = !libraryFixtureOnly;
const bootstrap = useFullAssetSet ? await bootstrapSource() : null;
const setupDiagnostics = useFullAssetSet ? await setupDiagnosticsSources() : null;
// `--library-fixture-only` narrows the file set to the library fixture ON PURPOSE, so a null
// bootstrap there is the mode working, not evidence of a missing build. Before this distinction
// existed the two flags contradicted each other and the combination could never succeed — which is
// exactly how hyper-v-windows-library-command.mjs invokes this on win32, so the Windows library
// test threw every time while Linux (no --require-parser) passed. The thrown message named a build
// as the cause, so the failure read as a local environment problem rather than a flag conflict.
const files = (useFullAssetSet ? [
    ...filesUnder(assetRoot),
    libraryFixture,
    ...(bootstrap ? [bootstrap] : []),
    ...(setupDiagnostics || []),
] : [libraryFixture]).filter((candidate) => /\.ps(?:1|m1)$/i.test(candidate));
// Keyed on the same flag that decided whether to fetch a bootstrap at all, so this asks "a source
// this mode wanted is missing" rather than restating the mode. If the fixture-only set ever gains
// the bootstrap, changing `useFullAssetSet` moves all three together instead of leaving this guard
// behind, silently not covering it — which is how "absence of evidence reported as success" comes
// back through the door this guard was built to close.
// Same principle as the bootstrap: under --require-parser a source that could not be obtained is
// silently unchecked, which is absence of evidence reported as success — the failure this whole
// guard exists to prevent.
if (requireParser && useFullAssetSet && !setupDiagnostics) {
    throw new Error(
        "Windows Setup diagnostics programs unavailable for parsing:"
        + " scripts/real-tests/hyper-v-windows-setup-diagnostics.ts did not yield"
        + " hyperVWindowsSetupDiagnosticsPrograms() through the source loader.",
    );
}
if (requireParser && useFullAssetSet && !bootstrap) {
    // --require-parser already hard-fails when PowerShell is missing; silently dropping a file in
    // that mode is the same defect in a different place. The usual cause is running this before
    // `tsc`, since the bootstrap is read from dist/.
    throw new Error(
        "session bootstrap unavailable for parsing: dist/hyper-v-windows/low-level/powershell-session.js"
        + " is missing or exports no HYPER_V_WINDOWS_SESSION_BOOTSTRAP string."
        + " Run `npm run build:hyper-v:windows:library` (or any tsc build) before --require-parser.",
    );
}
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
