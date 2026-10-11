export type OwnerInventoryEntry<Device> =
    | { stateKey: string; devices: Device[]; exists: false }
    | { stateKey: string; devices: Device[]; exists: true; truncated: true; error: string; maxBytes: number; bytes: number }
    | { stateKey: string; devices: Device[]; exists: true; truncated: boolean; totalDevices: number; maxDevices: number }
    | { stateKey: string; devices: Device[]; exists: true; error: string };

export interface OwnerInventory<Device> {
    ownerId: string;
    root: string;
    ownerRoot: string;
    backends: OwnerInventoryEntry<Device>[];
}

export interface FocusedInventoryRequest { stateKey?: string | null; backend: string | null; tool: string }
export interface MetadataDeviceRequest { stateKey: string; backend: string; deviceId: string }

export interface LeaseDirectoryEntry { name: string; isFile(): boolean }
export interface LeaseDirectoryReader<Entry extends LeaseDirectoryEntry> { readSync(): Entry | null; closeSync(): void }
export type LeaseDirectoryInspection = { ok: true; exists: boolean } | { ok: false };
export type LeaseDirectoryScan<File, Inspection extends LeaseDirectoryInspection> =
    | { kind: "entries"; entries: Array<{ file: File; hardwareId: string }> }
    | { kind: "native-refusal"; evidence: Inspection }
    | { kind: "entry-cap"; backend: string; limit: number }
    | { kind: "directory-failed"; backend: string; detail: string };

export function observedLeaseTtlMs(lease: Record<string, unknown> | null | undefined, fallback: number): number {
    return typeof lease?.ttlMs === "number" && Number.isInteger(lease.ttlMs) && lease.ttlMs > 0
        ? lease.ttlMs : fallback;
}

// Structural facts returned by the existing native readiness/cache authorities.
export type DiscoveryQemuImgSignatureStatus = "Valid" | "NotSigned" | "HashMismatch" | "NotTrusted" | "UnknownError"
    | "NotSupportedFileFormat" | "Incompatible" | "signer-mismatch" | "check-failed";
export type DiscoveryReadiness = {
    ok: boolean;
    available: boolean;
    platform: string;
    moduleAvailable: boolean;
    hypervisorPresent: boolean;
    vmmsRunning: boolean;
    rebootPending: boolean;
    totalMemoryMb: number;
    freeMemoryMb: number;
    logicalProcessors: number;
    missing: string[];
    hyperVAdministratorsMember?: boolean;
    managementAccess?: boolean;
    sessionRefreshRequired?: boolean;
    qemuImgAvailable?: boolean;
    qemuImgTrusted?: boolean;
    qemuImgSignatureStatus?: DiscoveryQemuImgSignatureStatus;
    linuxImageMissing?: string[];
    detail?: string;
};

export type DiscoveryImageCache =
    | { state: "valid"; source: "owner" | "global"; code?: undefined }
    | { state: "acquisition-required"; source?: undefined; code?: undefined }
    | { state: "conflict"; source?: undefined; code: string };
export type DiscoveryMacosProvider = "tart" | "vz" | "utmctl";
export type DiscoveryExecutable = "adb" | "emulator" | "avdmanager" | "xcrun" | "xcodebuild" | "wsb"
    | "powershell.exe" | "pwsh" | "powershell" | "ssh.exe" | "ssh" | "scp.exe" | "scp" | DiscoveryMacosProvider;
export type HostBackendDiscoveryRequest = { ownerId: string; platform: string; commandTimeoutMs: number };
export type HostBackendDiscoveryConfiguration = {
    readonly macosProviders: readonly DiscoveryMacosProvider[];
    readonly capabilities: {
        readonly androidEmulator: readonly string[];
        readonly androidDevice: readonly string[];
        readonly iosSimulator: readonly string[];
        readonly iosDevice: readonly string[];
        readonly windowsSandbox: readonly string[];
        readonly windowsVm: readonly string[];
        readonly linuxVm: readonly string[];
        readonly macosVm: readonly string[];
    };
};

// One linux-vm image readiness decision for the smoke, device_backends, the setup diagnostic and
// the Level 3 Linux E2E gate, so they cannot disagree. qemu-img runs only to acquire the ubuntu-lts
// base image: create reuses a cached image after its own full SHA-256 check and never starts
// qemu-img then. So a cache whose manifest metadata validates turns the qemu-img state into an
// advisory, a cache conflict blocks with its own code, and only a host that still has to acquire
// the image is blocked by qemu-img. Everything here is pure; callers inspect the cache.

type HyperVLinuxImageReadinessInput = Pick<DiscoveryReadiness, "linuxImageMissing" | "qemuImgSignatureStatus"> | null;

export type HyperVLinuxImageReadiness = {
    // Codes that keep create from getting a base image now; empty when it can.
    blockers: string[];
    // qemu-img codes that do not block because create reuses the cached image.
    advisories: string[];
    baseImage: { state: DiscoveryImageCache["state"]; source: "owner" | "global" | null };
    // Whether a fresh acquisition could run; null when the readiness probe gave no answer.
    imageAcquisition: { available: boolean; missing: string[] } | null;
};

export function hyperVLinuxImageBlockers(
    readiness: HyperVLinuxImageReadinessInput,
    cache: DiscoveryImageCache,
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
    cache: DiscoveryImageCache,
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

export interface DeviceStatusRequest {
    backend: string;
    stateKey: string;
    deviceId: string;
    command: "device_status";
    dryRun: boolean;
    expectedIncarnationId?: string;
}
export type DeviceStatusResponse = { status: number; payload: unknown };
export type DeviceStatusCommand = {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    reason?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
};
export type DeviceStatusExecution = {
    mode: string; provider: string; executable?: string; args?: string[]; input?: string;
    status?: number | null; signal?: string | null; stdout?: string; stderr?: string; error?: string;
    timedOut?: boolean; outputLimitExceeded?: boolean;
};
export interface DeviceStatusPlan {
    device?: unknown;
    providerCommand?: DeviceStatusCommand | { error: string; missing: string[] } | null;
}
export interface DeviceStatusVmObservation {
    vmId: string; vmName: string; state: string; status: string;
    snapshots?: { snapshotId: string; snapshotName: string; snapshotType?: string }[];
    uptimeMs?: number; diskPath?: string;
}
export type DeviceStatusReconciliation = { ok: true; reconciled?: boolean } | { ok: false; status: number; error: string; detail?: string };
export function deviceStatusRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function deviceStatusHyperV(backend: string): boolean {
    return backend === "windows-vm" || backend === "linux-vm";
}
export function deviceStatusStoppedAndroid(request: DeviceStatusRequest, device: unknown, execution: DeviceStatusExecution): boolean {
    return request.backend === "android-emulator" && deviceStatusRecord(device) && device.status === "stopped" && execution.provider === "adb";
}
export function projectDeviceStatus(ownerId: string, request: DeviceStatusRequest, device: unknown, execution: DeviceStatusExecution,
    observation: DeviceStatusVmObservation | null, succeeded: boolean, timestamp: () => string): unknown {
    if (!deviceStatusRecord(device)) return device;
    if (deviceStatusHyperV(request.backend)) {
        if (!observation) return device;
        return {
            ...device, vmId: observation.vmId, vmName: observation.vmName,
            status: observation.state.toLowerCase() === "running" ? "running" : "stopped",
            runtimeState: observation.state, hyperVStatus: observation.status,
            liveSnapshots: (observation.snapshots || []).filter(snapshot => snapshot.snapshotName.startsWith(`ccc-${ownerId}-`))
                .map(snapshot => ({ id: snapshot.snapshotId.toLowerCase(), providerName: snapshot.snapshotName,
                    ...(snapshot.snapshotType ? { snapshotType: snapshot.snapshotType } : {}) })),
            ...(typeof observation.uptimeMs === "number" ? { uptimeMs: observation.uptimeMs } : {}),
            ...(observation.diskPath ? { diskPath: observation.diskPath } : {}), updatedAt: timestamp(),
        };
    }
    if (request.backend !== "android-emulator" && request.backend !== "android-device") return device;
    if (!succeeded && request.backend === "android-emulator" && device.status === "stopped") {
        return { ...device, runtimeState: "stopped", readiness: { state: "stopped", provider: "adb" } };
    }
    const state = String(execution.stdout || "").trim().toLowerCase();
    if (state !== "device") return { ...device, runtimeState: state || "unknown" };
    return { ...device, status: request.backend === "android-device" ? "attached" : "running", runtimeState: "running", readiness: { state: "ready", provider: "adb" } };
}
