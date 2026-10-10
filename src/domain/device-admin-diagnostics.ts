export type CommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
export type QemuImgSignatureStatus = "Valid" | "NotSigned" | "HashMismatch" | "NotTrusted" | "UnknownError"
    | "NotSupportedFileFormat" | "Incompatible" | "signer-mismatch" | "check-failed";
export type HyperVReadiness = {
    available: boolean; moduleAvailable: boolean; hypervisorPresent: boolean; vmmsRunning: boolean;
    rebootPending: boolean; missing: string[]; hyperVAdministratorsMember?: boolean;
    managementAccess?: boolean; sessionRefreshRequired?: boolean; qemuImgAvailable?: boolean;
    qemuImgTrusted?: boolean; qemuImgSignatureStatus?: QemuImgSignatureStatus; linuxImageMissing?: string[];
};
export type LinuxImageCache =
    | { state: "valid"; source: "owner" | "global"; code?: undefined }
    | { state: "acquisition-required"; source?: undefined; code?: undefined }
    | { state: "conflict"; source?: undefined; code: "hyper-v-base-image-profile-conflict" | "hyper-v-base-image-unmanaged-existing" | "hyper-v-base-image-artifact-owner-unknown" };
export type ProviderCommand = { executable: string; args: string[]; input?: string };
export type SmokeResult = { backend: string; status: "PASS" | "SKIP" | "FAIL"; detail: string; commands?: CommandResult[] };
export type SmokeMode = "prerequisite" | "real-provider";
export type SmokeOptions = { mode?: SmokeMode };
export type SmokeFormatOptions = SmokeOptions & { mcpSurface?: boolean; mcpServerPath?: string; mcpSmokeScriptPath?: string };
export type ParsedSmokeArgs = { ok: true; mode: SmokeMode; timeoutMs: number } | { ok: false; message: string };
export type BenchDeviceStatus = "healthy" | "lease-ok" | "missing-hardware-id" | "missing-lease" | "expired-lease" | "foreign-lease" | "device-mismatch" | "inventory-missing";
export type BenchDeviceCheck = {
    deviceId: string;
    name: string;
    status: BenchDeviceStatus;
    detail: string;
    hardwareId: string | null;
    inventoryState: "present" | "missing" | "unknown";
    expiresAt?: string;
};
export type BenchBackendHealth = {
    backend: "android-device" | "ios-device";
    status: "PASS" | "SKIP" | "FAIL";
    detail: string;
    command: { command: string; status: number | null } | null;
    devices: BenchDeviceCheck[];
};
export type DeviceLabBenchHealth = { ownerId: string; backends: BenchBackendHealth[] };
export type DeviceLabWiringDiagnostic = {
    stateRoot: string;
    stateExists: boolean;
    context: "container" | "host";
    environmentRequired: boolean;
    ownerResolution: "host-broker-resolve";
    incomplete: boolean;
};



type HyperVLinuxImageReadinessInput = Pick<HyperVReadiness, "linuxImageMissing" | "qemuImgSignatureStatus"> | null;

export type HyperVLinuxImageReadiness = {
    // Codes that keep create from getting a base image now; empty when it can.
    blockers: string[];
    // qemu-img codes that do not block because create reuses the cached image.
    advisories: string[];
    baseImage: { state: LinuxImageCache["state"]; source: "owner" | "global" | null };
    // Whether a fresh acquisition could run; null when the readiness probe gave no answer.
    imageAcquisition: { available: boolean; missing: string[] } | null;
};

export function hyperVLinuxImageBlockers(
    readiness: HyperVLinuxImageReadinessInput,
    cache: LinuxImageCache,
): HyperVLinuxImageReadiness {
    const acquisitionMissing = [...(readiness?.linuxImageMissing || [])];
    const baseImage = { state: cache.state, source: cache.source ?? null };
    const imageAcquisition = readiness ? { available: acquisitionMissing.length === 0, missing: [...acquisitionMissing] } : null;
    if (cache.state === "valid") return { blockers: [], advisories: acquisitionMissing, baseImage, imageAcquisition };
    if (cache.state === "conflict") return { blockers: [cache.code], advisories: [], baseImage, imageAcquisition };
    return { blockers: acquisitionMissing, advisories: [], baseImage, imageAcquisition };
}

// The skip reason for a blocked image, shared by the smoke and the E2E gate. An untrusted qemu-img
// carries the probe's closed signature status so a results file can tell the causes apart.
export function hyperVLinuxImageSkipReason(readiness: HyperVLinuxImageReadinessInput, image: HyperVLinuxImageReadiness): string {
    const status = image.blockers.includes("hyper-v-qemu-img-untrusted") && readiness?.qemuImgSignatureStatus
        ? ` (qemu-img signature ${readiness.qemuImgSignatureStatus})`
        : "";
    return `missing ${image.blockers.join(", ")}${status}`;
}

function qemuImgAdvisory(readiness: HyperVLinuxImageReadinessInput, advisories: string[]): string | null {
    if (advisories.includes("hyper-v-qemu-img-unavailable")) return "qemu-img unavailable";
    if (advisories.includes("hyper-v-qemu-img-untrusted")) {
        return `qemu-img untrusted${readiness?.qemuImgSignatureStatus ? ` (signature ${readiness.qemuImgSignatureStatus})` : ""}`;
    }
    return advisories.length > 0 ? advisories.join(", ") : null;
}

// The linux-vm smoke outcome once Hyper-V, SSH and SCP are known to be ready. A cache hit never
// claims a trusted qemu-img; it names the cached image and reports qemu-img only as an advisory.
export function hyperVLinuxSmokeImageResult(
    readiness: HyperVLinuxImageReadinessInput,
    cache: LinuxImageCache,
): { status: "PASS" | "SKIP"; detail: string } {
    const image = hyperVLinuxImageBlockers(readiness, cache);
    if (image.blockers.length > 0) return { status: "SKIP", detail: hyperVLinuxImageSkipReason(readiness, image) };
    if (image.baseImage.state !== "valid") {
        return { status: "PASS", detail: "Hyper-V, trusted qemu-img, SSH, and SCP are ready; no VM started" };
    }
    const advisory = qemuImgAdvisory(readiness, image.advisories);
    return {
        status: "PASS",
        detail: `Hyper-V, cached ubuntu-lts base image, SSH, and SCP are ready; ${advisory ? `${advisory}, needed only to re-acquire the image; ` : ""}no VM started`,
    };
}

export function pushDeviceLabWiringDiagnostic(lines: string[], diagnostic: DeviceLabWiringDiagnostic, includeState = true): void {
    if (includeState) {
        lines.push(
            `state: ${diagnostic.stateRoot}`,
            `stateExists: ${diagnostic.stateExists}`,
            `ownerResolution: ${diagnostic.ownerResolution}`,
            `environmentRequired: ${diagnostic.environmentRequired}`,
        );
    }
    if (diagnostic.incomplete) {
        lines.push(
            "",
            "warning: device-lab container wiring is incomplete; the host-backed device state mount is unavailable from this container.",
            "remedy: restart or recreate ccc from the host so the project container has /home/ccc/.ccc/devices mounted.",
        );
    }
}

export function missingPrerequisiteFromCommandFailure(result: CommandResult): string | null {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`;
    const command = result.command;
    if (/\bemulator\b/.test(command) && /\s-list-avds\b/.test(command) && /ETIMEDOUT|timed out|Timeout/i.test(output)) {
        return "emulator inventory timed out";
    }
    if (!/xcrun|xcodebuild/.test(command)) return null;
    if (/unable to find utility "simctl"|not a developer tool/i.test(output) && /\bsimctl\b/.test(command)) return "missing simctl";
    if (/unable to find utility "xctrace"|not a developer tool/i.test(output) && /\bxctrace\b/.test(command)) return "missing xctrace";
    if (/xcode-select: error|No developer tools were found|not a developer tool/i.test(output)) return "missing Xcode developer tools";
    return null;
}

export function smokeDetail(mode: SmokeMode, normal: string, realProvider: string): string {
    return mode === "real-provider" ? realProvider : normal;
}

export function smokePathCheck(command: string): CommandResult {
    return {
        command: `${command} path-check`,
        status: 0,
        stdout: "",
        stderr: "",
    };
}

export function compactSmokeOutput(output: string): string {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");
}

export function inventoryContains(command: CommandResult | null, hardwareId: string): "present" | "missing" | "unknown" {
    if (!command || command.status !== 0) return "unknown";
    const output = `${command.stdout || ""}\n${command.stderr || ""}`;
    const tokens: string[] = output.match(/[A-Za-z0-9._:-]+/g) || [];
    return tokens.includes(hardwareId) ? "present" : "missing";
}

export function admitDeviceAdminSmokeArgs(args: string[]): ParsedSmokeArgs {
    let mode: SmokeMode = "prerequisite";
    let timeoutMs = 5000;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--real-provider" || arg === "--real-lab") {
            mode = "real-provider";
            continue;
        }
        if (arg === "--timeout-ms") {
            const value = args[i + 1];
            i += 1;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600000) {
                return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
            }
            timeoutMs = parsed;
            continue;
        }
        if (arg.startsWith("--timeout-ms=")) {
            const parsed = Number(arg.slice("--timeout-ms=".length));
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600000) {
                return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
            }
            timeoutMs = parsed;
            continue;
        }
        return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
    }
    return { ok: true, mode, timeoutMs };
}
