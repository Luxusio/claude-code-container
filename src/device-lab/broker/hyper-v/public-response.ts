type ProviderExecution = {
    mode: string;
    provider: string;
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
    "hyper-v-base-image-archive-check-failed",
    "hyper-v-base-image-checksum-mismatch",
    "hyper-v-base-image-download-failed",
    "hyper-v-base-image-extract-failed",
    "hyper-v-base-image-finalize-failed",
    "hyper-v-base-image-hash-failed",
    "hyper-v-base-image-hash-mismatch",
    "hyper-v-base-image-inspection-failed",
    "hyper-v-base-image-normalize-failed",
    "hyper-v-vm-configure-failed",
    "hyper-v-vm-create-failed",
    "hyper-v-vm-disk-create-failed",
    "hyper-v-vm-disk-inspection-failed",
    "hyper-v-vm-preflight-failed",
    "hyper-v-path-reparse-point-rejected",
    "hyper-v-path-root-invalid",
    "hyper-v-powershell-execution-failed",
    "hyper-v-powershell-program-invalid",
    "hyper-v-powershell-parse-failed",
    "hyper-v-vm-ownership-mismatch",
    "hyper-v-guest-provision-credential-command-failed",
    "hyper-v-guest-provision-input-validation-command-failed",
    "hyper-v-guest-provision-media-attach-command-failed",
    "hyper-v-guest-provision-media-build-command-failed",
    "hyper-v-guest-provision-media-check-command-failed",
    "hyper-v-guest-provision-media-content-command-failed",
    "hyper-v-guest-provision-password-invalid",
    "hyper-v-guest-provision-requires-stopped-vm",
    "hyper-v-guest-provision-username-mismatch",
    "hyper-v-guest-provision-vm-lookup-command-failed",
    "hyper-v-guest-provision-vm-state-command-failed",
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
    "hyper-v-network-cleanup-failed",
    "hyper-v-network-setup-failed",
    "hyper-v-recovery-failed",
    "hyper-v-snapshot-reconciliation-failed",
    "hyper-v-state-reconciliation-failed",
]);

export function hyperVBoundedErrorCode(
    error: unknown,
    fallback: string,
): string {
    const message = error instanceof Error ? error.message : String(error || "");
    const match = /^(hyper-v-[a-z0-9-]{3,128})(?::[\s\S]*)?$/.exec(message);
    return match?.[1] || fallback;
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
        || reportedDiagnosticCodes.at(-1)
        || fallbackDiagnosticCode;
}

export function redactProviderCommandInput(
    result: ProviderExecution,
    redactOutput = false,
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
    return {
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
        result.error = hyperVBoundedErrorCode(
            record.error,
            "hyper-v-guest-not-ready",
        );
    }
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
        "incarnationId",
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
        "diskMaxBytes",
        "networking",
        "switchName",
        "networkAddress",
        "macAddress",
        "networkGateway",
        "networkPrefix",
        "outboundPolicy",
        "secureBootTemplate",
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
            "secureBootTemplate",
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
