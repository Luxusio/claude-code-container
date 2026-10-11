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
export type HyperVLinuxImageReadinessInput = Pick<HyperVReadiness, "linuxImageMissing" | "qemuImgSignatureStatus"> | null;

export type HyperVLinuxImageReadiness = {
    // Codes that keep create from getting a base image now; empty when it can.
    blockers: string[];
    // qemu-img codes that do not block because create reuses the cached image.
    advisories: string[];
    baseImage: { state: LinuxImageCache["state"]; source: "owner" | "global" | null };
    // Whether a fresh acquisition could run; null when the readiness probe gave no answer.
    imageAcquisition: { available: boolean; missing: string[] } | null;
};

export type SmokeMode = "prerequisite" | "real-provider";
export type SmokeOptions = { mode?: SmokeMode; mcpSurface?: boolean };
export type DiagnosticProbeReason = "command-failed" | "prerequisite-missing" | "installed-server-missing" | "installed-script-missing";
export type DiagnosticProbe<Evidence> = { state: "available" | "missing" | "failed" | "invalid"; reason?: DiagnosticProbeReason; evidence?: Evidence; tokens?: readonly string[]; readiness?: HyperVReadiness };
export type DiagnosticAvailability = { adb: boolean; emulator: boolean; xcrun: boolean; wsb: boolean; powershell: boolean; ssh: boolean; scp: boolean; tart: boolean; vz: boolean; utmctl: boolean; windowsHost: boolean };
export type DiagnosticReason = "missing-tools" | "probe-failed" | "prerequisite-missing" | "optional-inventory-unavailable" | "responded" | "not-windows" | "invalid-readiness" | "hyper-v-unavailable" | "linux-image" | "macos-responded" | "macos-real-responded" | "missing-bridge" | "installed-server-missing" | "installed-script-missing";
export type DiagnosticRow<Evidence> = { backend: string; status: "PASS" | "SKIP" | "FAIL"; reason: DiagnosticReason; missing?: readonly string[]; evidence: Evidence[] };
export type BenchDeviceStatus = "healthy" | "lease-ok" | "missing-hardware-id" | "missing-lease" | "expired-lease" | "foreign-lease" | "device-mismatch" | "inventory-missing";
export type BenchDeviceCheck = { deviceId: string; name: string; status: BenchDeviceStatus; hardwareId: string | null; inventoryState: "present" | "missing" | "unknown"; expiresAt?: string };
export type BenchHealth<Evidence> = { ownerId: string; backends: { backend: "android-device" | "ios-device"; status: "PASS" | "SKIP" | "FAIL"; reason: "missing-tools" | "probe-failed" | "responded"; evidence?: Evidence; devices: BenchDeviceCheck[] }[] };
