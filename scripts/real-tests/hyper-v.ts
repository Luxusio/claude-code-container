import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import { repoRoot } from "./helpers.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { runSupervisedProcess } from "./supervised-process.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";
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

export async function runHyperVTests(target: string, dependencies: any = {}) {
    const testFiles = hyperVTestFiles(target);
    const env = dependencies.env || process.env;
    const build = dependencies.buildLevel3ArtifactsImpl || buildLevel3Artifacts;
    const ensureBroker = dependencies.ensureHostBrokerReadyImpl || ensureHostBrokerReady;
    const runProcess = dependencies.runSupervisedProcessImpl || runSupervisedProcess;
    const ensureLicense = dependencies.ensureWindowsEvaluationLicenseImpl || ensureWindowsServerEvaluationLicense;
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
