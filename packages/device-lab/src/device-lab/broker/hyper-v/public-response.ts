import type { HyperVMemoryCapacity } from "./power.js";
import {
    HYPER_V_WINDOWS_OPERATIONS,
    HYPER_V_WINDOWS_SESSION_ERROR_CODES,
    HyperVWindowsError,
    type HyperVWindowsOperation,
} from "@ccc/hyper-v/low-level/index.js";
import { HYPER_V_ELEVATED_NETWORK_ERROR_CODES } from "./elevated-network-session.js";

type ProviderExecution = {
    mode?: string;
    provider?: string;
    executable?: string;
    args?: string[];
    input?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
    [key: string]: unknown;
};

const REDACTED_PROVIDER_DIAGNOSTIC_CODES = new Set([
    "hyper-v-base-image-acl-failed",
    "hyper-v-base-image-archive-check-failed",
    "hyper-v-base-image-checksum-mismatch",
    "hyper-v-base-image-download-failed",
    "hyper-v-base-image-efi-cleanup-failed",
    "hyper-v-base-image-efi-fallback-failed",
    "hyper-v-base-image-efi-fallback-missing",
    "hyper-v-base-image-efi-loader-copy-failed",
    "hyper-v-base-image-efi-loader-missing",
    "hyper-v-base-image-efi-partition-invalid",
    "hyper-v-base-image-extract-failed",
    "hyper-v-base-image-final-inspection-failed",
    "hyper-v-base-image-final-hash-mismatch",
    "hyper-v-base-image-final-move-failed",
    "hyper-v-base-image-final-observation-failed",
    "hyper-v-base-image-finalize-failed",
    "hyper-v-base-image-filesystem-attributes-invalid",
    "hyper-v-base-image-hash-failed",
    "hyper-v-base-image-hash-mismatch",
    "hyper-v-base-image-inspection-failed",
    "hyper-v-base-image-generation-mismatch",
    "hyper-v-base-image-not-found",
    "hyper-v-base-image-normalize-failed",
    "hyper-v-base-image-native-finalize-failed",
    "hyper-v-base-image-parent-invalid",
    "hyper-v-base-image-partial-mutated",
    "hyper-v-base-image-partial-identity-changed",
    "hyper-v-base-image-partition-style-unsupported",
    "hyper-v-base-image-partial-generation-failed",
    "hyper-v-base-image-partial-hash-failed",
    "hyper-v-base-image-partial-inspection-failed",
    "hyper-v-base-image-partial-open-failed",
    "hyper-v-base-image-source-mutated",
    "hyper-v-base-image-source-identity-changed",
    "hyper-v-base-image-file-identity-unavailable",
    "hyper-v-base-image-source-hash-failed",
    "hyper-v-base-image-source-inspection-failed",
    "hyper-v-base-image-source-open-failed",
    "hyper-v-base-image-unmanaged-existing",
    "hyper-v-base-image-artifact-owner-unknown",
    "hyper-v-base-image-convert-failed",
    "hyper-v-base-image-content-verify-failed",
    "hyper-v-base-image-destination-create-failed",
    "hyper-v-bootstrap-dhcp-switch-unavailable",
    "hyper-v-bootstrap-address-selection-failed",
    "hyper-v-bootstrap-host-prefix-inspection-failed",
    "hyper-v-bootstrap-management-adapter-inspection-failed",
    "hyper-v-bootstrap-mac-address-conflict",
    "hyper-v-bootstrap-mac-address-missing",
    "hyper-v-bootstrap-neighbor-inspection-failed",
    "hyper-v-bootstrap-network-adapter-ambiguous",
    "hyper-v-bootstrap-network-adapter-identity-mismatch",
    "hyper-v-bootstrap-network-adapter-unavailable",
    "hyper-v-bootstrap-network-command-failed",
    "hyper-v-bootstrap-network-containment-failed",
    "hyper-v-bootstrap-network-switch-conflict",
    "hyper-v-bootstrap-network-switch-required",
    "hyper-v-bootstrap-vm-adapter-inspection-failed",
    "hyper-v-created-disk-attachment-mismatch",
    "hyper-v-created-disk-boot-order-mismatch",
    "hyper-v-created-disk-dismount-failed",
    "hyper-v-created-disk-format-mismatch",
    "hyper-v-created-disk-hash-mismatch",
    "hyper-v-created-disk-length-mismatch",
    "hyper-v-created-disk-not-found",
    "hyper-v-device-root-acl-failed",
    "hyper-v-host-cpu-capacity-exceeded",
    "hyper-v-host-disk-capacity-exceeded",
    "hyper-v-host-disk-capacity-invalid",
    "hyper-v-host-capacity-inspection-failed",
    "hyper-v-host-memory-capacity-exceeded",
    "hyper-v-host-storage-inspection-failed",
    "hyper-v-linux-bootstrap-mac-identity-mismatch",
    "hyper-v-linux-disk-boot-order-mismatch",
    "hyper-v-managed-network-adapter-unavailable",
    "hyper-v-network-deadline-invalid",
    "hyper-v-network-elevated-child-termination-unconfirmed",
    "hyper-v-network-elevated-operation-failed",
    "hyper-v-network-elevation-cancelled",
    "hyper-v-network-elevation-failed",
    "hyper-v-network-elevation-required",
    "hyper-v-network-elevation-suppressed",
    "hyper-v-network-gateway-conflict",
    "hyper-v-network-gateway-invalid",
    "hyper-v-network-marker-invalid",
    "hyper-v-network-module-import-failed",
    "hyper-v-network-nat-ambiguous",
    "hyper-v-network-nat-identity-conflict",
    "hyper-v-network-nat-identity-unavailable",
    "hyper-v-network-nat-instance-id-invalid",
    "hyper-v-network-nat-name-invalid",
    "hyper-v-network-nat-ownership-conflict",
    "hyper-v-network-nat-prefix-conflict",
    "hyper-v-network-allocation-inspection-failed",
    "hyper-v-network-allocation-vm-ambiguous",
    "hyper-v-network-allocation-vm-ownership-conflict",
    "hyper-v-network-adapter-inspection-failed",
    "hyper-v-network-gateway-create-failed",
    "hyper-v-network-gateway-inspection-failed",
    "hyper-v-network-identity-adoption-failed",
    "hyper-v-network-identity-evidence-inspection-failed",
    "hyper-v-network-identity-repair-failed",
    "hyper-v-network-marker-classification-failed",
    "hyper-v-network-marker-inspection-failed",
    "hyper-v-network-persisted-marker-repair-failed",
    "hyper-v-network-persisted-marker-rollback-conflict",
    "hyper-v-network-persisted-marker-rollback-failed",
    "hyper-v-network-nat-create-failed",
    "hyper-v-network-nat-inspection-failed",
    "hyper-v-network-nat-rollback-identity-conflict",
    "hyper-v-network-operation-deadline-exceeded",
    "hyper-v-network-pipe-client-mismatch",
    "hyper-v-network-pipe-handshake-timeout",
    "hyper-v-network-pipe-name-invalid",
    "hyper-v-network-prefix-invalid",
    "hyper-v-network-program-invalid",
    "hyper-v-network-result-invalid",
    "hyper-v-network-result-too-large",
    "hyper-v-network-subnet-conflict",
    "hyper-v-network-subnet-inspection-failed",
    "hyper-v-network-switch-ambiguous",
    "hyper-v-network-switch-attachment-inspection-failed",
    "hyper-v-network-switch-id-invalid",
    "hyper-v-network-switch-create-failed",
    "hyper-v-network-switch-identity-inspection-failed",
    "hyper-v-network-switch-inspection-failed",
    "hyper-v-network-switch-identity-conflict",
    "hyper-v-network-switch-in-use",
    "hyper-v-network-switch-name-invalid",
    "hyper-v-network-switch-name-inspection-failed",
    "hyper-v-network-switch-not-found",
    "hyper-v-network-switch-ownership-conflict",
    "hyper-v-network-switch-type-conflict",
    "hyper-v-network-switch-unavailable",
    "hyper-v-network-stage-invalid",
    "hyper-v-reboot-command-failed",
    "hyper-v-reboot-start-failed",
    "hyper-v-reboot-requires-running-vm",
    "hyper-v-reboot-invalid-state",
    "hyper-v-start-command-failed",
    "hyper-v-stop-command-failed",
    "hyper-v-lifecycle-timeout",
    "hyper-v-lifecycle-vm-lookup-command-failed",
    "hyper-v-vm-configure-failed",
    "hyper-v-vm-create-failed",
    "hyper-v-vm-disk-create-failed",
    "hyper-v-vm-disk-inspection-failed",
    "hyper-v-vm-identity-inspection-failed",
    "hyper-v-vm-path-inspection-failed",
    "hyper-v-vm-preflight-failed",
    "hyper-v-vm-already-exists",
    "hyper-v-path-reparse-point-rejected",
    "hyper-v-path-root-invalid",
    "hyper-v-powershell-execution-failed",
    "hyper-v-powershell-program-invalid",
    "hyper-v-powershell-parse-failed",
    "hyper-v-qemu-img-mutated",
    "hyper-v-qemu-img-unavailable",
    "hyper-v-qemu-img-untrusted",
    "hyper-v-vm-ownership-mismatch",
    "hyper-v-status-identity-invalid",
    "hyper-v-status-timeout",
    "hyper-v-status-vm-lookup-command-failed",
    "hyper-v-status-disk-lookup-command-failed",
    "hyper-v-status-disk-identity-mismatch",
    "hyper-v-status-vhd-chain-invalid",
    "hyper-v-status-vhd-lookup-command-failed",
    "hyper-v-status-snapshot-lookup-command-failed",
    "hyper-v-status-snapshot-identity-mismatch",
    "hyper-v-guest-provision-credential-command-failed",
    "hyper-v-guest-provision-input-validation-command-failed",
    "hyper-v-guest-provision-media-attach-command-failed",
    "hyper-v-guest-provision-media-build-command-failed",
    "hyper-v-guest-provision-media-check-command-failed",
    "hyper-v-guest-provision-media-content-command-failed",
    "hyper-v-guest-provision-password-invalid",
    "hyper-v-guest-provision-requires-stopped-vm",
    "hyper-v-guest-provision-username-mismatch",
    "hyper-v-guest-disk-attachment-mismatch",
    "hyper-v-guest-secure-boot-not-enabled",
    "hyper-v-guest-integration-services-not-enabled",
    "hyper-v-guest-provision-generation-mismatch",
    "hyper-v-guest-provision-path-invalid",
    "hyper-v-guest-provision-media-unavailable",
    "hyper-v-guest-provision-boot-settings-invalid",
    "hyper-v-guest-provision-bios-order-mismatch",
    "hyper-v-guest-provision-boot-settings-command-failed",
    "hyper-v-guest-provision-preflight-command-failed",
    "hyper-v-guest-provision-media-cleanup-failed",
    "hyper-v-guest-provision-vm-state-changed",
    "hyper-v-guest-provision-vm-lookup-command-failed",
    "hyper-v-guest-provision-vm-state-command-failed",
    "hyper-v-guest-boot-diagnostic-command-failed",
    "hyper-v-provisioning-source-missing",
    "hyper-v-provisioning-media-create-failed",
    "hyper-v-provisioning-media-block-invalid",
    "hyper-v-provisioning-media-stream-invalid",
    "hyper-v-provisioning-media-output-open-failed",
    "hyper-v-provisioning-media-copy-incomplete",
    "hyper-v-provisioning-media-com-unavailable",
    "hyper-v-provisioning-media-configure-failed",
    "hyper-v-provisioning-media-filesystem-selection-failed",
    "hyper-v-provisioning-media-volume-name-invalid",
    "hyper-v-provisioning-media-volume-name-failed",
    "hyper-v-provisioning-media-source-entry-invalid",
    "hyper-v-provisioning-media-source-directory-failed",
    "hyper-v-provisioning-media-source-file-invalid",
    "hyper-v-provisioning-media-source-file-failed",
    "hyper-v-provisioning-media-source-cleanup-failed",
    "hyper-v-provisioning-media-add-tree-failed",
    "hyper-v-provisioning-media-result-image-failed",
    "hyper-v-provisioning-media-invalid",
    "hyper-v-guest-provisioning-media-already-attached",
    "hyper-v-guest-provisioning-media-attach-failed",
    "hyper-v-linux-seed-media-already-attached",
    "hyper-v-linux-seed-media-attach-failed",
    "hyper-v-linux-seed-media-attach-command-failed",
    "hyper-v-linux-seed-media-build-command-failed",
    "hyper-v-linux-seed-media-check-command-failed",
    "hyper-v-linux-seed-known-hosts-command-failed",
    "hyper-v-linux-seed-host-keygen-command-failed",
    "hyper-v-linux-seed-path-validation-command-failed",
    "hyper-v-linux-seed-requires-stopped-vm",
    "hyper-v-linux-seed-user-keygen-command-failed",
    "hyper-v-linux-seed-vm-lookup-command-failed",
    "hyper-v-linux-seed-vm-state-command-failed",
    "hyper-v-linux-ssh-host-keygen-failed",
    "hyper-v-linux-ssh-host-public-key-invalid",
    "hyper-v-linux-ssh-keygen-arguments-invalid",
    "hyper-v-linux-ssh-keygen-failed",
    "hyper-v-linux-ssh-keygen-start-failed",
    "hyper-v-linux-ssh-keygen-unavailable",
    "hyper-v-linux-ssh-public-key-invalid",
    "hyper-v-delete-reconciliation-failed",
    "hyper-v-vm-identity-conflict",
    "hyper-v-vm-disk-ownership-mismatch",
    "hyper-v-vm-media-ownership-mismatch",
    "hyper-v-vm-delete-stop-timeout",
    "hyper-v-network-cleanup-failed",
    "hyper-v-network-setup-failed",
    "hyper-v-recovery-failed",
    "hyper-v-snapshot-reconciliation-failed",
    "hyper-v-snapshot-reconciliation-ambiguous",
    "hyper-v-snapshot-policy-restore-failed",
    "hyper-v-snapshot-policy-invalid",
    "hyper-v-snapshot-policy-quarantine-failed",
    "hyper-v-snapshot-policy-quarantined",
    "hyper-v-snapshot-standard-fallback-failed",
    "hyper-v-snapshot-already-exists",
    "hyper-v-snapshot-create-invalid-result",
    "hyper-v-snapshot-observed-count-invalid",
    "hyper-v-snapshot-observed-none-created",
    "hyper-v-snapshot-observed-name-mismatch",
    "hyper-v-snapshot-observed-duplicate",
    "hyper-v-snapshot-observed-id-invalid",
    "hyper-v-snapshot-observed-name-invalid",
    "hyper-v-snapshot-observed-type-invalid",
    "hyper-v-snapshot-name-invalid",
    "hyper-v-vm-identity-ambiguous",
    "hyper-v-vm-not-found",
    "hyper-v-powershell-contract-invalid",
    "hyper-v-powershell-contract-version-unsupported",
    "hyper-v-state-reconciliation-failed",
    // Typed create-path codes (runTypedHyperVCreate and the modules it drives). Without them a
    // failed create reported only hyper-v-provider-command-failed, whatever had actually failed.
    "hyper-v-base-image-copy-short-read",
    "hyper-v-base-image-copy-short-write",
    "hyper-v-base-image-identity-changed",
    "hyper-v-base-image-invalid",
    "hyper-v-create-bootstrap-mac-address-invalid",
    "hyper-v-create-bootstrap-mac-address-conflict",
    "hyper-v-create-compensation-failed",
    "hyper-v-create-invalid-result",
    "hyper-v-create-plan-invalid",
    "hyper-v-created-disk-short-read",
    "hyper-v-disk-identity-changed",
    "hyper-v-operation-deadline-exceeded",
    // cloneHyperVBaseImage's path assertions append these to their hyper-v-base-image,
    // hyper-v-device-root and hyper-v-disk labels, so a symlinked or junctioned ancestor, or a
    // path swapped during the clone, names itself instead of reading as a command failure.
    "hyper-v-base-image-path-invalid",
    "hyper-v-base-image-path-outside-root",
    "hyper-v-base-image-path-symlink-rejected",
    "hyper-v-device-root-path-symlink-rejected",
    "hyper-v-disk-path-invalid",
    "hyper-v-disk-path-outside-root",
    "hyper-v-disk-path-symlink-rejected",
    // The operation asset's own native codes that hyperVTypedErrorCode passes through unchanged.
    // Its trusted module resolution runs ahead of every typed operation, New-VM included.
    "hyper-v-module-missing",
    "hyper-v-module-path-invalid",
    // The closed elevation union the typed network client forwards verbatim as transport codes.
    // Spread from its single source so a code added there is admitted here rather than flattened.
    // The session codes it also forwards stay out: a session failure's redacted payload has to
    // match the one-shot transport's, which has no such code to report. On the typed paths
    // hyperVTypedErrorCode re-homes them into the transport family instead.
    ...HYPER_V_ELEVATED_NETWORK_ERROR_CODES,
]);

// The bounded families hyperVTypedErrorCode mints from a typed library failure. Unlike the
// literals above these are patterns, so they are admitted only as the entire `error` field — the
// broker's own projection on the typed paths — and never as a token found inside stderr or a
// longer message, where host text could happen to spell one.
const HYPER_V_TYPED_ERROR_FAMILY_PATTERN =
    /^(?:hyper-v-ps(?:-[a-z0-9]+)+|hyper-v-windows-(?:native|transport|protocol|validation)(?:-[a-z0-9]+)*)$/;
const HYPER_V_TYPED_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
    "native",
    "transport",
    "protocol",
    "validation",
]);
const HYPER_V_WINDOWS_SESSION_ERROR_SET: ReadonlySet<string> = new Set(HYPER_V_WINDOWS_SESSION_ERROR_CODES);
// The client's bounded diagnostic pattern is /^[a-z0-9-]{1,80}$/; a longer code is dropped there.
const HYPER_V_DIAGNOSTIC_CODE_MAX_LENGTH = 80;

// Every non-`hyper-v-` reason hyperVGuestReadinessFailureCode can return, for both guest lanes.
// Kept as literals rather than a pattern: a pattern over `powershell-direct-*` / `ssh-*` would
// admit whatever a future caller invents, and the point of this projection is that the set of
// codes that can reach a reader is closed.
const HYPER_V_GUEST_TRANSPORT_REASONS = new Set([
    "powershell-direct-attempt-timeout",
    "powershell-direct-authentication-failed",
    "powershell-direct-session-unavailable",
    "powershell-direct-unavailable",
    "powershell-direct-timeout",
    "ssh-connection-refused",
    "ssh-connection-timeout",
    "ssh-host-unreachable",
    "ssh-host-key-rejected",
    "ssh-authentication-failed",
    "ssh-unavailable",
    // Not from hyperVGuestReadinessFailureCode — the linux lane refines its code afterwards through
    // hyperVLinuxGuestReadyTraceFailureCode, which can return this one verbatim. It means SSH
    // connected, authenticated and exited zero but cloud-init had not written the readiness marker:
    // the guest is up and answering, its provisioning is unfinished. Flattening that to
    // hyper-v-guest-not-ready made it identical to nothing-at-that-address, which is the opposite
    // diagnosis. The four ssh-host-key-* members of that same allowlist are deliberately absent:
    // nothing produces them, and admitting codes the broker cannot emit is how a closed set stops
    // being closed.
    "ssh-readiness-marker-missing",
]);

export function hyperVBoundedErrorCode(
    error: unknown,
    fallback: string,
): string {
    const message = error instanceof Error ? error.message : String(error || "");
    const match = /^(hyper-v-[a-z0-9-]{3,128})(?::[\s\S]*)?$/.exec(message);
    return match?.[1] || fallback;
}

function boundedHyperVDiagnosticCode(prefix: string, value: string): string {
    const segment = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (segment ? `${prefix}-${segment}` : prefix)
        .slice(0, HYPER_V_DIAGNOSTIC_CODE_MAX_LENGTH)
        .replace(/-+$/, "");
}

/**
 * The bounded code for a failure on a typed Hyper-V path, keeping what hyperVBoundedErrorCode
 * throws away. A HyperVWindowsError's message is `hyper-v-windows-<category>:<operation>:<code>`,
 * and cutting it at the first colon left only the category, so every native New-VM failure read
 * as hyper-v-windows-native. Here a session code the typed network client forwarded becomes
 * `hyper-v-windows-transport-session-<reason>`, which the 502 detail admits through the transport
 * family; any other code the library already bounded as `hyper-v-*` (a forwarded elevation code,
 * or the asset's own) passes through; a native code, which the asset only ever reports as a
 * normalized FullyQualifiedErrorId or one of its bounded tokens, becomes `hyper-v-ps-<code>` like
 * boundedPowerShellErrorId; the library's own transport, protocol and validation codes become
 * `hyper-v-windows-<category>-<code>`. Everything minted is [a-z0-9-] and at most 80 characters.
 * Any other error keeps the hyperVBoundedErrorCode projection.
 */
export function hyperVTypedErrorCode(error: unknown, fallback: string): string {
    if (error instanceof HyperVWindowsError) {
        const code = String(error.code);
        if (error.category === "transport" && HYPER_V_WINDOWS_SESSION_ERROR_SET.has(code)) {
            return boundedHyperVDiagnosticCode("hyper-v-windows-transport", code.slice("hyper-v-windows-".length));
        }
        if (/^hyper-v-[a-z0-9-]{3,72}$/.test(code)) return code;
        if (!HYPER_V_TYPED_ERROR_CATEGORIES.has(error.category)) return fallback;
        return error.category === "native" && /[a-z0-9]/i.test(code)
            ? boundedHyperVDiagnosticCode("hyper-v-ps", code)
            : boundedHyperVDiagnosticCode(`hyper-v-windows-${error.category}`, code);
    }
    const code = hyperVBoundedErrorCode(error, fallback);
    return code.length <= HYPER_V_DIAGNOSTIC_CODE_MAX_LENGTH ? code : fallback;
}

/**
 * The typed primitive that failed, admitted only from the library's closed operation list. A stage
 * error that wraps a typed failure as its `cause` (hyperVCreateVhdReadError) names it too.
 */
export function hyperVTypedErrorOperation(error: unknown): HyperVWindowsOperation | undefined {
    const typed = error instanceof HyperVWindowsError
        ? error
        : error instanceof Error && error.cause instanceof HyperVWindowsError ? error.cause : null;
    return typed && (HYPER_V_WINDOWS_OPERATIONS as readonly string[]).includes(typed.operation)
        ? typed.operation
        : undefined;
}

/** Project only bounded numeric native facts, never exception messages or host identifiers. */
export function hyperVTypedNativeDiagnostics(error: unknown): { nativeHResult?: number; nativeErrorCategory?: number } {
    const typed = error instanceof HyperVWindowsError
        ? error
        : error instanceof Error && error.cause instanceof HyperVWindowsError ? error.cause : null;
    if (!typed || typed.category !== "native" || !hyperVTypedErrorOperation(typed)) return {};
    return {
        ...(typeof typed.nativeHResult === "number" && Number.isInteger(typed.nativeHResult)
            && typed.nativeHResult >= -2147483648 && typed.nativeHResult <= 2147483647
            ? { nativeHResult: typed.nativeHResult } : {}),
        ...(typeof typed.nativeErrorCategory === "number" && Number.isInteger(typed.nativeErrorCategory)
            && typed.nativeErrorCategory >= 0 && typed.nativeErrorCategory <= 31
            ? { nativeErrorCategory: typed.nativeErrorCategory } : {}),
    };
}

function hyperVTypedErrorFamilyCode(error: unknown): string | undefined {
    return typeof error === "string"
        && error.length <= HYPER_V_DIAGNOSTIC_CODE_MAX_LENGTH
        && HYPER_V_TYPED_ERROR_FAMILY_PATTERN.test(error)
        ? error
        : undefined;
}

export function hyperVBoundedErrorDetail(
    error: unknown,
    fallback: string,
): string {
    const message = error instanceof Error ? error.message : String(error || "");
    return /^(?:hyper-v-[a-z0-9-]{3,128})(?::hyper-v-[a-z0-9-]{3,128})?$/.test(message)
        ? message
        : fallback;
}

export function hyperVProviderDiagnosticCode(
    result: Pick<ProviderExecution, "error" | "stdout" | "stderr">,
    fallbackDiagnosticCode: string,
): string;
export function hyperVProviderDiagnosticCode(
    result: Pick<ProviderExecution, "error" | "stdout" | "stderr">,
    fallbackDiagnosticCode?: string,
): string | undefined;
export function hyperVProviderDiagnosticCode(
    result: Pick<ProviderExecution, "error" | "stdout" | "stderr">,
    fallbackDiagnosticCode?: string,
): string | undefined {
    const reportedDiagnosticCodes = String(
        `${result.error || ""}\n${result.stderr || ""}`,
    )
        .match(/\bhyper-v-[a-z0-9-]{3,128}\b/gi)
        ?.map((candidate) => candidate.toLowerCase())
        .filter((candidate) => REDACTED_PROVIDER_DIAGNOSTIC_CODES.has(candidate)) || [];
    const specificReportedDiagnosticCode = reportedDiagnosticCodes
        .filter((candidate) => candidate !== "hyper-v-powershell-execution-failed")
        .at(-1);
    const stageDiagnosticCode = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .map((line) => /^ccc_hyper_v_stage:(hyper-v-[a-z0-9-]{3,128})$/.exec(line)?.[1])
        .filter((line): line is string => Boolean(
            line && REDACTED_PROVIDER_DIAGNOSTIC_CODES.has(line),
        ))
        .at(-1);
    return specificReportedDiagnosticCode
        || stageDiagnosticCode
        || hyperVTypedErrorFamilyCode(result.error)
        || boundedPowerShellErrorId(result.error, result.stderr)
        || reportedDiagnosticCodes.at(-1)
        || fallbackDiagnosticCode;
}

// Last-resort diagnostic when no ccc `hyper-v-*` code is present: surface the PowerShell
// FullyQualifiedErrorId (a cmdlet-author identifier such as
// "ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.NewVMSnapshot") as a bounded code.
// The capture charset excludes path separators (\ / :) and whitespace, so host paths,
// credentials, VM names, and command output can never leak; the result is capped and matches
// the client's bounded diagnostic pattern /^[a-z0-9-]{1,80}$/.
export function boundedPowerShellErrorId(error?: string | null, stderr?: string | null): string | undefined {
    const match = /FullyQualifiedErrorId\s*:\s*([A-Za-z0-9._,+-]+)/.exec(`${error || ""}\n${stderr || ""}`);
    if (!match) return undefined;
    const sanitized = match[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!sanitized) return undefined;
    return `hyper-v-ps-${sanitized}`.slice(0, 80).replace(/-+$/, "");
}

/** Only numeric admission evidence crosses the provider redaction boundary. */
export function publicHyperVMemoryCapacity(value: unknown): HyperVMemoryCapacity | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { requestedMb, availableMb, reserveMb, shortfallMb } = value as HyperVMemoryCapacity;
    if (![requestedMb, availableMb, reserveMb, shortfallMb].every((item) => Number.isSafeInteger(item) && item >= 0)) return undefined;
    return { requestedMb, availableMb, reserveMb, shortfallMb };
}

export function redactProviderCommandInput(
    result: ProviderExecution,
    // Required, not defaulted. Every call site passes true, and only the redacted form is
    // transport-independent: unredacted, a one-shot execution carries executable/args/stderr and a
    // session-served one does not, so a future call site taking a default would silently emit a
    // payload whose shape depends on which transport happened to serve the primitive.
    redactOutput: boolean,
    fallbackDiagnosticCode?: string,
): Record<string, unknown> {
    const { input, ...publicResult } = result;
    if (!redactOutput) {
        return {
            ...publicResult,
            ...(input !== undefined ? { inputConfigured: true } : {}),
        };
    }
    const diagnosticCode = hyperVProviderDiagnosticCode(
        publicResult,
        fallbackDiagnosticCode,
    );
    const capacity = diagnosticCode === "hyper-v-host-memory-capacity-exceeded"
        ? publicHyperVMemoryCapacity(publicResult.capacity) : undefined;
    return {
        ...(capacity ? { capacity } : {}),
        mode: publicResult.mode,
        provider: publicResult.provider,
        ...(publicResult.status !== undefined ? { status: publicResult.status } : {}),
        ...(publicResult.signal !== undefined ? { signal: publicResult.signal } : {}),
        ...(publicResult.timedOut !== undefined ? { timedOut: publicResult.timedOut } : {}),
        stdoutPresent: Boolean(publicResult.stdout),
        stderrPresent: Boolean(publicResult.stderr),
        outputRedacted: true,
        ...(diagnosticCode ? { diagnosticCode } : {}),
        ...(input !== undefined ? { inputConfigured: true } : {}),
    };
}

export function publicHyperVArtifactCleanup(
    value: unknown,
): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cleanup = value as Record<string, unknown>;
    const reason = typeof cleanup.reason === "string"
        ? hyperVBoundedErrorCode(cleanup.reason, "hyper-v-artifact-cleanup-preserved")
        : null;
    const error = typeof cleanup.error === "string"
        ? hyperVBoundedErrorCode(cleanup.error, "hyper-v-artifact-cleanup-failed")
        : null;
    return {
        ok: cleanup.ok === true,
        removed: cleanup.removed === true,
        ...(cleanup.preserved === true ? { preserved: true } : {}),
        ...(reason ? { reason } : {}),
        ...(error ? { error } : {}),
    };
}

export function publicHyperVNetworkCleanup(
    value: unknown,
): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cleanup = value as Record<string, unknown>;
    const networkCleanup = cleanup.networkCleanup
        && typeof cleanup.networkCleanup === "object"
        && !Array.isArray(cleanup.networkCleanup)
        ? cleanup.networkCleanup as Record<string, unknown>
        : null;
    const error = typeof cleanup.error === "string"
        ? hyperVBoundedErrorCode(cleanup.error, "hyper-v-network-cleanup-failed")
        : null;
    const cleanupReason = typeof networkCleanup?.reason === "string"
        ? hyperVBoundedErrorCode(networkCleanup.reason, "hyper-v-network-cleanup-skipped")
        : null;
    const cleanupDiagnostic = typeof networkCleanup?.diagnosticCode === "string"
        ? hyperVBoundedErrorCode(networkCleanup.diagnosticCode, "hyper-v-network-cleanup-failed")
        : null;
    return {
        ok: cleanup.ok === true,
        released: cleanup.released === true,
        statePresent: cleanup.statePresent === true,
        ...(typeof cleanup.remaining === "number" ? { remaining: cleanup.remaining } : {}),
        ...(error ? { error } : {}),
        ...(networkCleanup ? {
            networkCleanup: {
                ...(networkCleanup.skipped === true ? { skipped: true } : {}),
                ...(cleanupReason ? { reason: cleanupReason } : {}),
                ...(cleanupDiagnostic ? { diagnosticCode: cleanupDiagnostic } : {}),
                ...(networkCleanup.removedSwitch === true ? { removedSwitch: true } : {}),
                ...(networkCleanup.removedNat === true ? { removedNat: true } : {}),
                ...(networkCleanup.removedGateway === true ? { removedGateway: true } : {}),
                ...(networkCleanup.alreadyMissing === true ? { alreadyMissing: true } : {}),
            },
        } : {}),
    };
}

function pickPublicFields(
    source: Record<string, unknown>,
    keys: readonly string[],
): Record<string, unknown> {
    return Object.fromEntries(keys.flatMap((key) => (
        source[key] === undefined ? [] : [[key, source[key]]]
    )));
}

function publicHyperVSnapshots(value: unknown): unknown[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return [];
        }
        return [pickPublicFields(candidate as Record<string, unknown>, [
            "id",
            "name",
            "providerName",
            "snapshotType",
            "createdAt",
        ])];
    });
}

function publicHyperVBootCheck(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const result = pickPublicFields(record, [
        "ready",
        "provider",
        "computerName",
        "attempts",
    ]);
    if (record.error !== undefined) {
        // The transport reasons are checked before the generic bounder, which only admits
        // `hyper-v-*` and rewrites everything else to the fallback. That flattening meant a stalled
        // OOBE persisted as a bare `hyper-v-guest-not-ready`: the reply still carried the truth in
        // `detail`, but `device_status` has no `detail`, so the real reason was unrecoverable from
        // the record — the surface that is supposed to outlive the reply. These are the exact
        // strings hyperVGuestReadinessFailureCode can return for the two guest lanes, a closed set
        // of literals, so admitting them widens nothing.
        result.error = HYPER_V_GUEST_TRANSPORT_REASONS.has(String(record.error))
            ? String(record.error)
            : hyperVBoundedErrorCode(record.error, "hyper-v-guest-not-ready");
    }
    // Projected as a literal true, never the stored value. Without this the flag was persisted into
    // lastBootCheck and then stripped right back out by this allowlist, so device_status reported a
    // scrub-failure reason with no indication that containment had not actually powered the guest
    // off — the operator reads "readiness failed, containment presumably handled it" while the
    // guest is still up with a live autologon. The whole point of persisting it is that the HTTP
    // reply carrying it can be lost to the caller's own timeout while containment is still running.
    if (record.scrubContainmentFailed === true) result.scrubContainmentFailed = true;
    const diagnostic = record.diagnostic;
    if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
        const publicDiagnostic = pickPublicFields(
            diagnostic as Record<string, unknown>,
            [
                "state",
                "uptimeMs",
                "generation",
                "secureBootEnabled",
                "heartbeatEnabled",
                "heartbeatPrimaryStatus",
                "heartbeatSecondaryStatus",
                "hardDiskCount",
                "dvdCount",
                "hardDiskControllers",
                "bootDeviceTypes",
            ],
        );
        const services = (diagnostic as Record<string, unknown>).integrationServices;
        if (Array.isArray(services)) {
            publicDiagnostic.integrationServices = services.flatMap((service) => (
                service && typeof service === "object" && !Array.isArray(service)
                    ? [pickPublicFields(service as Record<string, unknown>, [
                        "name",
                        "enabled",
                        "primaryStatus",
                        "secondaryStatus",
                    ])]
                    : []
            ));
        }
        result.diagnostic = publicDiagnostic;
    }
    return result;
}

export function redactHyperVDeviceSecrets(device: unknown): unknown {
    if (!device || typeof device !== "object" || Array.isArray(device)) {
        return device;
    }
    const record = device as Record<string, unknown>;
    const publicRecord = pickPublicFields(record, [
        "id",
        "name",
        "backend",
        "kind",
        "platform",
        "ownerId",
        "provider",
        "vmName",
        "vmId",
        "profile",
        "baseImageSha256",
        "baseImageGeneration",
        "guestTransport",
        "sshHostKeyFingerprint",
        "guestUsername",
        "guestProvisioned",
        "memoryMb",
        "cpus",
        "nestedVirtualization",
        "diskMaxBytes",
        "networking",
        "switchName",
        "networkAddress",
        "macAddress",
        "networkGateway",
        "networkPrefix",
        "outboundPolicy",
        "secureBootTemplate",
        "secureBootEnabled",
        "activeSnapshotId",
        "status",
        "runtimeState",
        "hyperVStatus",
        "bootReady",
        "creatable",
        "createdAt",
        "updatedAt",
        "authority",
    ]);
    publicRecord.snapshots = publicHyperVSnapshots(record.snapshots);
    if (record.lastBootCheck !== undefined) {
        publicRecord.lastBootCheck = publicHyperVBootCheck(record.lastBootCheck);
    }
    return publicRecord;
}

export function publicHyperVCreateConfiguration(
    create: unknown,
): Record<string, unknown> | null {
    if (!create || typeof create !== "object" || Array.isArray(create)) return null;
    const record = create as Record<string, unknown>;
    return {
        ...pickPublicFields(record, [
            "name",
            "profile",
            "memoryMb",
            "cpus",
            "diskMaxBytes",
            "networking",
            "nestedVirtualization",
            "secureBootTemplate",
            "secureBootEnabled",
        ]),
        ...(typeof record.sourceImage === "string"
            || typeof record.image === "string"
            ? { sourceImageConfigured: true }
            : {}),
        ...(typeof record.sshPassword === "string"
            ? { sshPasswordConfigured: true }
            : {}),
    };
}

function publicHyperVExecution(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const execution = pickPublicFields(record, [
        "mode",
        "providerExecution",
        "mutatesHost",
        "provider",
        "status",
    ]);
    if (record.provisioning && typeof record.provisioning === "object"
        && !Array.isArray(record.provisioning)) {
        execution.provisioning = pickPublicFields(
            record.provisioning as Record<string, unknown>,
            ["provider", "status"],
        );
    }
    return execution;
}

export function redactHyperVResultSecrets(
    result: unknown,
): Record<string, unknown> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return {};
    const record = result as Record<string, unknown>;
    const publicResult = pickPublicFields(record, [
        "ownerId",
        "backend",
        "stateKey",
        "command",
        "deviceId",
        "force",
        "dryRun",
        "idempotent",
        "alreadyMissing",
        "invoked",
    ]);
    if ("device" in record) {
        publicResult.device = redactHyperVDeviceSecrets(record.device);
    }
    const create = publicHyperVCreateConfiguration(record.create);
    if (create) publicResult.create = create;
    const execution = publicHyperVExecution(record.execution);
    if (execution) publicResult.execution = execution;
    if (record.rollback && typeof record.rollback === "object"
        && !Array.isArray(record.rollback)) {
        const rollback = record.rollback as Record<string, unknown>;
        publicResult.rollback = {
            ...pickPublicFields(rollback, ["ok", "removed", "preserved"]),
            ...(typeof rollback.error === "string"
                ? {
                    error: hyperVBoundedErrorCode(
                        rollback.error,
                        "hyper-v-rollback-failed",
                    ),
                }
                : {}),
        };
    }
    return publicResult;
}
