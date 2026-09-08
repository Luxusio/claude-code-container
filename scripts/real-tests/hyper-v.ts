import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import { repoRoot } from "./helpers.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { runSupervisedProcess } from "./supervised-process.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";
import { isAdministrator, resolveTrustedWindowsPowerShell } from "./hyper-v-windows-library-elevation.mjs";
import { selectHyperVWindowsProfile } from "./select-windows-profile.ts";
// Import ONLY the leaf contracts module (no transitive src imports) — importing the deeper
// hyper-v-images.ts pulls `.js` src imports the real-test source loader can't resolve on Windows.
import {
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE,
    HYPER_V_WINDOWS_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_URL,
    isHyperVWindowsEvaluationReceipt,
} from "../../src/device-lab/hyper-v-image-contracts.ts";

const targets = {
    all: ["level2-hyper-v-windows-vm.ts", "level2-hyper-v-linux-vm.ts"],
    windows: ["level2-hyper-v-windows-vm.ts"],
    linux: ["level2-hyper-v-linux-vm.ts"],
};

export function hyperVTestFiles(target: string) {
    const selected = targets[target as keyof typeof targets];
    if (!selected) throw new Error("--target must be one of: all, windows, linux");
    return selected.map((file) => join(repoRoot, "scripts", "real-tests", file));
}

function defaultPromptYesNo(question: string, deps: any = {}): Promise<boolean> {
    const input = deps.stdin || process.stdin;
    const output = deps.stdout || process.stdout;
    const rl = createInterface({ input, output });
    return new Promise<boolean>((resolvePrompt) => {
        rl.question(question, (answer) => {
            rl.close();
            resolvePrompt(/^y(es)?$/i.test(String(answer).trim()));
        });
    });
}

function windowsEvaluationSetupDir(): string {
    return join(homedir(), ".ccc", "device-broker-private", "setup");
}

function windowsEvaluationReceiptPath(): string {
    return join(windowsEvaluationSetupDir(), HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE);
}

// Read the acceptance receipt the broker writes/reads. Uses the authoritative validator from the
// leaf contracts module so there is no drift; the broker still re-validates at device_create.
function readWindowsEvaluationReceipt(): unknown | null {
    try {
        const parsed = JSON.parse(readFileSync(windowsEvaluationReceiptPath(), "utf8"));
        return isHyperVWindowsEvaluationReceipt(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// Write the exact receipt shape acceptHyperVWindowsEvaluationLicense produces, from the same leaf
// constants, to the same setup path — so the next windows-server device_create passes its gate.
function recordWindowsEvaluationLicense(): void {
    mkdirSync(windowsEvaluationSetupDir(), { recursive: true });
    const receipt = {
        version: 2,
        licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
        licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
        sourceTrustId: HYPER_V_WINDOWS_SOURCE_TRUST_ID,
        sourceUrl: HYPER_V_WINDOWS_SOURCE_URL,
        acceptedAt: new Date().toISOString(),
    };
    writeFileSync(windowsEvaluationReceiptPath(), JSON.stringify(receipt, null, 2));
}

// Windows uses the Microsoft Windows Server evaluation image for the zero-config path; unlike the
// Linux cloud image it carries a license that must be accepted once. Rather than force a separate
// `ccc devices setup ... --accept-windows-evaluation-license` command, prompt interactively here in
// the launcher (which still owns the terminal stdin — provider workers are spawned with stdin
// ignored, so the E2E module itself cannot prompt). The acceptance receipt written here is the same
// one the broker's image-store reads, so the next windows-server device_create passes its gate.
export async function ensureWindowsServerEvaluationLicense(target: string, deps: any = {}) {
    const platform = deps.platform || process.platform;
    const selectProfile = deps.selectHyperVWindowsProfileImpl || selectHyperVWindowsProfile;
    const readReceipt = deps.readReceiptImpl || readWindowsEvaluationReceipt;
    const acceptLicense = deps.acceptLicenseImpl || recordWindowsEvaluationLicense;
    const output = deps.stdout || process.stdout;
    const promptYesNo = deps.promptYesNoImpl || defaultPromptYesNo;
    const isInteractive = deps.isInteractive ?? Boolean((deps.stdin || process.stdin)?.isTTY);

    if (platform !== "win32") return { ok: true, reason: "non-windows-host" };
    if (target !== "windows" && target !== "all") return { ok: true, reason: "linux-target" };
    if (selectProfile(deps.selectOptions || {}) !== "windows-server") return { ok: true, reason: "not-windows-server-profile" };
    if (readReceipt()) return { ok: true, reason: "already-accepted" };

    output.write(
        "\nThis Hyper-V Windows test uses the Microsoft Windows Server evaluation image (auto-downloaded and generalized).\n"
        + `Evaluation license terms: ${HYPER_V_WINDOWS_EVALUATION_LICENSE_URL}\n`,
    );
    if (!isInteractive) return { ok: false, reason: "license-required-non-interactive" };
    const accepted = await promptYesNo("Accept the Microsoft Windows Server evaluation license terms to continue? [y/N] ", deps);
    if (!accepted) return { ok: false, reason: "license-declined" };
    acceptLicense();
    output.write("Windows Server evaluation license accepted (recorded for future runs).\n");
    return { ok: true, reason: "accepted-now" };
}

// Says up front what a real host only revealed after two minutes of booting: Mount-VHD needs a
// privilege that Hyper-V VM management does not carry, so an unelevated run creates the VM, waits
// for it, fails, and only then reports the setup diagnostic as unavailable — with a host-locale
// message this pipeline mangles. The diagnostic is what would have explained the failure.
//
// A warning rather than a prompt. The launcher owns the terminal stdin the evaluation-licence
// question runs through, and re-launching it under UAC detaches that; a diagnostic is not worth
// trading the interactive flow for. Elevation stays the operator's call, made before the wait
// rather than discovered after it.
// The two production defaults, exported as values so a test can assert the BINDING rather than the
// spelling. Pinning the `|| resolveTrustedWindowsPowerShell` expression as source text closed the
// mutation it named and missed the same deletion one line up: repoint the import at a weakened
// module, leave the expression byte-identical, and the hardening is gone from the live path with
// the suite green. It also failed on a behaviour-preserving line wrap, which is a false alarm any
// formatter would trip. Comparing these against the module's own exports catches both, and executes
// neither — which matters, because executing them on Windows spawns the powershell.exe this whole
// change exists to keep out of unit tests.
export const PRIVILEGE_PROBE_DEFAULTS = { resolveTrustedWindowsPowerShell, isAdministrator };

export function warnIfSetupDiagnosticsWillLackPrivilege(target: string, dependencies: any = {}): boolean {
    const platform = dependencies.platform || process.platform;
    if (platform !== "win32") return false;
    // Windows-only diagnostic. captureHyperVWindowsSetupDiagnostics is reached solely through
    // level2-hyper-v-windows-vm.ts; the linux target never touches it. Warning there would ask the
    // operator to redo a Level 3 run for something that target does not capture.
    if (target !== "all" && target !== "windows") return false;
    const write = dependencies.writeImpl || ((line: string) => process.stderr.write(line));
    let elevated: boolean;
    try {
        const resolvePowerShell = dependencies.resolveTrustedWindowsPowerShellImpl || PRIVILEGE_PROBE_DEFAULTS.resolveTrustedWindowsPowerShell;
        const probe = dependencies.isAdministratorImpl || PRIVILEGE_PROBE_DEFAULTS.isAdministrator;
        elevated = probe({ powerShellPath: resolvePowerShell() });
    } catch {
        // The probe itself failing is not a reason to block or to claim elevation is missing. Say
        // only what is true: it could not be determined.
        write(
            "NOTE Could not determine whether this run is elevated. If a guest fails to boot, the\n"
            + "     Windows Setup diagnostic may ask you to approve elevation, which lets it\n"
            + "     force-stop the test VM, detach and read-only mount its disk, then re-attach it —\n"
            + "     specifically as a member of local Administrators, since Hyper-V Administrators\n"
            + "     alone runs VMs but is not believed to grant the mount privilege.\n"
            + "     The VM lifecycle itself is unaffected.\n"
            // The two probes fail in OPPOSITE directions, and this note is the one place that
            // matters. This one throwing produced the message above; the in-guest probe defaults to
            // "assume elevated", which biases it AGAINST emitting the code this note tells the
            // operator to watch for, leaving the message match as the only detector. So the absence
            // of that code here is weaker evidence than it looks.
            + "     If the probe failed for an environmental reason the in-guest check may fail the\n"
            + "     same way, so the absence of that code is not proof the diagnostics were captured.\n",
        );
        return false;
    }
    if (elevated) return false;
    write(
        "NOTE This run is not elevated. Windows Setup diagnostics mount the guest VHDX to read Panther\n"
        + "     logs, which needs a privilege Hyper-V VM management does not grant.\n"
        + "     The VM lifecycle itself is unaffected, and nothing is asked of you now.\n"
        // Says what will happen, not what to do. The run no longer asks the operator to start over
        // with more rights: if a guest fails to boot, the diagnostic requests elevation for that one
        // mount, at that moment. Warning here is still worth it — an unattended run should know a
        // UAC dialog may appear rather than meet one silently — but the old "re-run from an elevated
        // terminal" line was telling them to pay for a build and a two-minute boot again.
        // Says what the approval actually buys, not the flattering version. Review caught the
        // earlier wording ("that single mount") describing less than the elevated child does: it
        // force-stops the VM, detaches the disk, mounts it read-only, reads the logs, dismounts and
        // re-attaches — all as Administrator, all confined to this test VM by its ownership marker
        // and id. Consent given on a description that understates the action is not consent.
        + "     If a guest fails to boot, Windows will ask you to approve elevation. That approval\n"
        + "     lets the diagnostic force-stop THIS test VM, detach its disk, mount it read-only to\n"
        + "     read the logs, then dismount and re-attach it. Nothing else is touched.\n"
        + "     Declining costs only the Panther logs, and the result then says\n"
        + "     hyper-v-setup-diagnostics-mount-privilege-required, which is what to grep for.\n"
        // The caveat names its audience. Unqualified it landed on the common reader — a local admin
        // on a UAC-filtered token, for whom approving DOES fix it — and read as "approving might not
        // help", contradicting the sentence directly above.
        + "     (If your only administrative right is Hyper-V Administrators membership, approving\n"
        + "     will not help either: the mount checks the local Administrators role.)\n",
    );
    return true;
}

export async function runHyperVTests(target: string, dependencies: any = {}) {
    const testFiles = hyperVTestFiles(target);
    const env = dependencies.env || process.env;
    const build = dependencies.buildLevel3ArtifactsImpl || buildLevel3Artifacts;
    const ensureBroker = dependencies.ensureHostBrokerReadyImpl || ensureHostBrokerReady;
    const runProcess = dependencies.runSupervisedProcessImpl || runSupervisedProcess;
    const ensureLicense = dependencies.ensureWindowsEvaluationLicenseImpl || ensureWindowsServerEvaluationLicense;
    // Above the build, not below it. The action this NOTE asks for is a re-run, and a re-run costs
    // another buildLevel3Artifacts — warning afterwards makes the operator pay for the build twice.
    // hyperVTestFiles(target) has already validated the target, and the probe needs nothing the
    // build establishes.
    const warnPrivilege = dependencies.warnSetupDiagnosticsPrivilegeImpl || warnIfSetupDiagnosticsWillLackPrivilege;
    warnPrivilege(target, dependencies);
    const buildStatus = build(repoRoot, { env });
    if (buildStatus !== 0) return buildStatus;
    const license = await ensureLicense(target, dependencies.licenseDeps || {});
    if (!license.ok) {
        process.stderr.write(
            license.reason === "license-declined"
                ? "Windows Server evaluation license declined; skipping the Hyper-V Windows test.\n"
                : "Windows Server evaluation license required but this run is non-interactive.\n"
                    + "Re-run in an interactive terminal to accept, or accept once with:\n"
                    + "  ccc devices setup hyper-v --confirm --accept-windows-evaluation-license\n",
        );
        return 1;
    }
    const brokerStatus = await ensureBroker(repoRoot, { env });
    if (brokerStatus !== 0) return brokerStatus;
    const runner = join(repoRoot, "scripts", "real-tests", "run.ts");
    const sourceLoader = pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href;
    const result = await runProcess(process.execPath, ["--import", sourceLoader, runner, "--compact", ...testFiles], {
        cwd: repoRoot,
        env,
    });
    return result.status ?? 1;
}

export async function runHyperVLevel3(args = process.argv.slice(2), dependencies: any = {}) {
    const targetIndex = args.indexOf("--target");
    const target = targetIndex >= 0 ? String(args[targetIndex + 1] || "") : "all";
    hyperVTestFiles(target);
    const withExclusive = dependencies.withExclusiveRealProviderRunImpl || withExclusiveRealProviderRun;
    return withExclusive(`test:level3:hyper-v:${target}`, () => runHyperVTests(target, dependencies));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    try {
        process.exitCode = await runHyperVLevel3();
    } catch (error: any) {
        process.stderr.write(`FAIL Hyper-V Level 3 launcher: ${error?.message || String(error)}\n`);
        process.exitCode = 1;
    }
}
