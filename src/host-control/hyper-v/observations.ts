import {
    type HyperVReadiness,
    type HyperVSetupObservation,
    type HyperVVmObservation,
    type HyperVDeleteObservation,
    type HyperVSnapshotObservation,
    type HyperVSnapshotDeleteObservation,
    type HyperVGuestExecObservation,
    type HyperVGuestTransferObservation,
    type HyperVGuestProvisionObservation,
    type HyperVGuestReadyObservation,
    type HyperVGuestReadyFailureObservation,
    type HyperVGuestBootDiagnosticObservation,
    type HyperVBaseImageObservation,
    type HyperVNetworkObservation,
    type HyperVNetworkCleanupObservation,
    type HyperVNetworkAllocationsObservation,
    type HyperVRecoveryObservation,
    type HyperVBootstrapNetworkCleanupObservation,
    type HyperVBootstrapNetworkObservation,
} from "./contracts.js";

const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIpv4(value: string, label: string): string {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.split(".").some((part) => Number(part) > 255)) {
        throw new Error(`hyper-v-${label}-invalid`);
    }
    return value;
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
    for (const line of String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean).reverse()) {
        try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
            // PowerShell may emit progress or module text before the JSON record.
        }
    }
    return null;
}

function parseMarkedJsonObject(stdout: string): Record<string, unknown> | null {
    const matches = Array.from(String(stdout || "").matchAll(/CCC_HYPER_V_RESULT_B64:([A-Za-z0-9+/=]+)/g));
    const encoded = matches.at(-1)?.[1];
    if (!encoded || encoded.length > 131072) return null;
    try {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.length === 0 || decoded.length > 65536 || decoded.toString("base64") !== encoded) return null;
        const parsed: unknown = JSON.parse(decoded.toString("utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function parseHyperVReadiness(stdout: string): HyperVReadiness | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || typeof parsed.available !== "boolean"
        || typeof parsed.totalMemoryMb !== "number" || !Number.isSafeInteger(parsed.totalMemoryMb) || parsed.totalMemoryMb < 0
        || typeof parsed.freeMemoryMb !== "number" || !Number.isSafeInteger(parsed.freeMemoryMb) || parsed.freeMemoryMb < 0
        || typeof parsed.logicalProcessors !== "number" || !Number.isSafeInteger(parsed.logicalProcessors) || parsed.logicalProcessors < 0) return null;
    return {
        ok: parsed.ok === true,
        available: parsed.available,
        platform: typeof parsed.platform === "string" ? parsed.platform : "win32",
        moduleAvailable: parsed.moduleAvailable === true,
        hypervisorPresent: parsed.hypervisorPresent === true,
        vmmsRunning: parsed.vmmsRunning === true,
        rebootPending: parsed.rebootPending === true,
        totalMemoryMb: parsed.totalMemoryMb,
        freeMemoryMb: parsed.freeMemoryMb,
        logicalProcessors: parsed.logicalProcessors,
        missing: Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === "string") : [],
        ...(typeof parsed.hyperVAdministratorsMember === "boolean" ? { hyperVAdministratorsMember: parsed.hyperVAdministratorsMember } : {}),
        ...(typeof parsed.managementAccess === "boolean" ? { managementAccess: parsed.managementAccess } : {}),
        ...(typeof parsed.sessionRefreshRequired === "boolean" ? { sessionRefreshRequired: parsed.sessionRefreshRequired } : {}),
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
    };
}

export function parseHyperVSetupObservation(stdout: string): HyperVSetupObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || typeof parsed.ok !== "boolean" || parsed.featureName !== "Microsoft-Hyper-V-All"
        || typeof parsed.beforeState !== "string" || !parsed.beforeState
        || typeof parsed.afterState !== "string" || !parsed.afterState
        || typeof parsed.changed !== "boolean" || typeof parsed.elevated !== "boolean"
        || typeof parsed.rebootRequired !== "boolean"
        || (parsed.hyperVAdministratorsMember !== undefined && typeof parsed.hyperVAdministratorsMember !== "boolean")
        || (parsed.membershipChanged !== undefined && typeof parsed.membershipChanged !== "boolean")
        || (parsed.managementAccess !== undefined && typeof parsed.managementAccess !== "boolean")
        || (parsed.sessionRefreshRequired !== undefined && typeof parsed.sessionRefreshRequired !== "boolean")) return null;
    const network = parsed.network === undefined ? undefined : parseHyperVNetworkObservation(JSON.stringify(parsed.network));
    if (parsed.network !== undefined && !network) return null;
    return {
        ok: parsed.ok,
        featureName: parsed.featureName,
        beforeState: parsed.beforeState,
        afterState: parsed.afterState,
        changed: parsed.changed,
        elevated: parsed.elevated,
        rebootRequired: parsed.rebootRequired,
        ...(typeof parsed.hyperVAdministratorsMember === "boolean" ? { hyperVAdministratorsMember: parsed.hyperVAdministratorsMember } : {}),
        ...(typeof parsed.membershipChanged === "boolean" ? { membershipChanged: parsed.membershipChanged } : {}),
        ...(typeof parsed.managementAccess === "boolean" ? { managementAccess: parsed.managementAccess } : {}),
        ...(typeof parsed.sessionRefreshRequired === "boolean" ? { sessionRefreshRequired: parsed.sessionRefreshRequired } : {}),
        ...(network ? { network } : {}),
    };
}

export function parseHyperVBaseImageObservation(stdout: string): HyperVBaseImageObservation | null {
    const parsed = parseMarkedJsonObject(stdout) || parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || (parsed.profile !== "windows-11" && parsed.profile !== "windows-server" && parsed.profile !== "ubuntu-lts") || typeof parsed.imagePath !== "string" || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.sha256) || typeof parsed.sizeBytes !== "number" || !Number.isSafeInteger(parsed.sizeBytes) || parsed.sizeBytes <= 0 || typeof parsed.virtualSizeBytes !== "number" || !Number.isSafeInteger(parsed.virtualSizeBytes) || parsed.virtualSizeBytes < parsed.sizeBytes || (parsed.vhdType !== "Dynamic" && parsed.vhdType !== "Fixed") || (parsed.generation !== 1 && parsed.generation !== 2) || typeof parsed.reused !== "boolean") return null;
    return {
        ok: true,
        profile: parsed.profile,
        imagePath: parsed.imagePath,
        sha256: parsed.sha256.toLowerCase(),
        sizeBytes: parsed.sizeBytes,
        virtualSizeBytes: parsed.virtualSizeBytes,
        vhdType: parsed.vhdType,
        generation: parsed.generation as 1 | 2,
        reused: parsed.reused,
    };
}

export function parseHyperVDeleteObservation(stdout: string): HyperVDeleteObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.deleted !== true) return null;
    const observation = parseHyperVVmObservation(JSON.stringify(parsed));
    return observation ? { ...observation, deleted: true } : null;
}

export function parseHyperVNetworkObservation(stdout: string): HyperVNetworkObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true
        || typeof parsed.switchName !== "string" || !parsed.switchName
        || typeof parsed.switchId !== "string" || !VM_ID_PATTERN.test(parsed.switchId)
        || typeof parsed.natName !== "string" || !parsed.natName
        || typeof parsed.natInstanceId !== "string" || !parsed.natInstanceId || parsed.natInstanceId.length > 256 || /[\u0000-\u001f]/.test(parsed.natInstanceId)
        || typeof parsed.prefix !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(parsed.prefix)
        || typeof parsed.gateway !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.gateway)
        || typeof parsed.interfaceIndex !== "number" || !Number.isSafeInteger(parsed.interfaceIndex) || parsed.interfaceIndex <= 0
        || typeof parsed.createdSwitch !== "boolean"
        || (parsed.createdGateway !== undefined && typeof parsed.createdGateway !== "boolean")
        || typeof parsed.createdNat !== "boolean") return null;
    if (parsed.marker !== undefined
        && (typeof parsed.marker !== "string"
            || !/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(parsed.marker))) return null;
    return parsed as HyperVNetworkObservation;
}

export function parseHyperVNetworkCleanupObservation(stdout: string): HyperVNetworkCleanupObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true
        || typeof parsed.removedSwitch !== "boolean"
        || typeof parsed.removedNat !== "boolean"
        || typeof parsed.removedGateway !== "boolean"
        || typeof parsed.alreadyMissing !== "boolean"
        || (parsed.deferred !== undefined && typeof parsed.deferred !== "boolean")
        || (parsed.reason !== undefined && parsed.reason !== "hyper-v-network-switch-in-use")) return null;
    if (parsed.deferred === true
        && (parsed.reason !== "hyper-v-network-switch-in-use"
            || parsed.removedSwitch || parsed.removedNat || parsed.removedGateway || parsed.alreadyMissing)) return null;
    if (parsed.deferred !== true && parsed.reason !== undefined) return null;
    return parsed as HyperVNetworkCleanupObservation;
}

export function parseHyperVNetworkAllocationsObservation(stdout: string): HyperVNetworkAllocationsObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.allocations) || parsed.allocations.length > 1024) return null;
    const allocations = parsed.allocations.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
        const item = candidate as Record<string, unknown>;
        if (typeof item.ownerId !== "string" || !/^[a-f0-9]{16}$/.test(item.ownerId)
            || typeof item.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/.test(item.deviceId)
            || typeof item.incarnationId !== "string" || !/^[a-f0-9]{32}$/.test(item.incarnationId)
            || typeof item.vmName !== "string" || !item.vmName
            || typeof item.present !== "boolean"
            || (item.present && (typeof item.vmId !== "string" || !VM_ID_PATTERN.test(item.vmId)))
            || (!item.present && item.vmId !== undefined && item.vmId !== null)) return null;
        return {
            ownerId: item.ownerId,
            deviceId: item.deviceId,
            incarnationId: item.incarnationId,
            vmName: item.vmName,
            present: item.present,
            ...(item.present ? { vmId: item.vmId as string } : {}),
        };
    });
    if (allocations.some((candidate) => candidate === null)) return null;
    return { ok: true, allocations: allocations as HyperVNetworkAllocationsObservation["allocations"] };
}

export function parseHyperVRecoveryObservation(stdout: string): HyperVRecoveryObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.recoveredVm !== "boolean" || typeof parsed.removedDisk !== "boolean") return null;
    return parsed as HyperVRecoveryObservation;
}

export function parseHyperVBootstrapNetworkCleanupObservation(stdout: string): HyperVBootstrapNetworkCleanupObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.removed !== "boolean" || typeof parsed.alreadyMissing !== "boolean") return null;
    return parsed as HyperVBootstrapNetworkCleanupObservation;
}

export function parseHyperVBootstrapNetworkObservation(stdout: string): HyperVBootstrapNetworkObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.addresses)) return null;
    const addresses = parsed.addresses.filter((candidate): candidate is string => {
        if (typeof candidate !== "string") return false;
        try {
            return assertIpv4(candidate, "linux-bootstrap-network-address") === candidate
                && !/^(?:0\.|127\.|169\.254\.)/.test(candidate);
        } catch {
            return false;
        }
    });
    if (addresses.length !== parsed.addresses.length || addresses.length > 8 || new Set(addresses).size !== addresses.length) return null;
    return { ok: true, addresses };
}

export function parseHyperVVmObservation(stdout: string): HyperVVmObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string") return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        state: typeof parsed.state === "string" ? parsed.state : "Unknown",
        status: typeof parsed.status === "string" ? parsed.status : "",
        ...(typeof parsed.uptimeMs === "number" && Number.isFinite(parsed.uptimeMs) ? { uptimeMs: parsed.uptimeMs } : {}),
        ...(typeof parsed.diskPath === "string" ? { diskPath: parsed.diskPath } : {}),
        ...(typeof parsed.switchName === "string" ? { switchName: parsed.switchName } : {}),
        ...((parsed.generation === 1 || parsed.generation === 2) ? { generation: parsed.generation } : {}),
        ...(Array.isArray(parsed.snapshots) ? {
            snapshots: parsed.snapshots.flatMap((snapshot) => {
                if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
                const record = snapshot as Record<string, unknown>;
                if (typeof record.snapshotId !== "string" || typeof record.snapshotName !== "string") return [];
                return [{
                    ok: true,
                    snapshotId: record.snapshotId,
                    snapshotName: record.snapshotName,
                    ...(typeof record.snapshotType === "string" ? { snapshotType: record.snapshotType } : {}),
                }];
            }),
        } : {}),
    };
}

export function parseHyperVSnapshotObservation(stdout: string): HyperVSnapshotObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.snapshotId !== "string" || typeof parsed.snapshotName !== "string") return null;
    if (!VM_ID_PATTERN.test(parsed.snapshotId)) return null;
    return {
        ok: true,
        snapshotId: parsed.snapshotId,
        snapshotName: parsed.snapshotName,
        ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
        ...(typeof parsed.snapshotType === "string" ? { snapshotType: parsed.snapshotType } : {}),
    };
}

export function parseHyperVSnapshotDeleteObservation(stdout: string): HyperVSnapshotDeleteObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.deleted !== true) return null;
    const observation = parseHyperVSnapshotObservation(JSON.stringify(parsed));
    return observation ? { ...observation, deleted: true } : null;
}

export function parseHyperVGuestExecObservation(stdout: string): HyperVGuestExecObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.status !== "number" || !Number.isInteger(parsed.status)) return null;
    return {
        ok: true,
        status: parsed.status,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    };
}

export function parseHyperVGuestTransferObservation(stdout: string): HyperVGuestTransferObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.localPath !== "string" || typeof parsed.remotePath !== "string" || typeof parsed.bytes !== "number" || !Number.isFinite(parsed.bytes)) return null;
    return { ok: true, localPath: parsed.localPath, remotePath: parsed.remotePath, bytes: parsed.bytes };
}

export function parseHyperVGuestProvisionObservation(stdout: string): HyperVGuestProvisionObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string" || typeof parsed.guestUsername !== "string" || typeof parsed.credentialPath !== "string" || typeof parsed.unattendPath !== "string") return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        guestUsername: parsed.guestUsername,
        credentialPath: parsed.credentialPath,
        unattendPath: parsed.unattendPath,
    };
}

export function parseHyperVGuestReadyObservation(stdout: string): HyperVGuestReadyObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string" || typeof parsed.computerName !== "string" || !parsed.computerName || typeof parsed.attempts !== "number" || !Number.isSafeInteger(parsed.attempts) || parsed.attempts < 1) return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        computerName: parsed.computerName,
        attempts: parsed.attempts,
        ...(typeof parsed.networkAddress === "string" && parsed.networkAddress ? { networkAddress: parsed.networkAddress } : {}),
    };
}

export function parseHyperVGuestReadyFailureObservation(stdout: string): HyperVGuestReadyFailureObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed
        || parsed.ok !== false
        || parsed.error !== "hyper-v-guest-ready-timeout"
        || typeof parsed.reason !== "string"
        || parsed.reason.length > 128
        || !/^(?:hyper-v-[a-z0-9-]{3,120}|powershell-direct-(?:authentication-failed|session-unavailable|unavailable))$/.test(parsed.reason)
        || typeof parsed.attempts !== "number"
        || !Number.isSafeInteger(parsed.attempts)
        || parsed.attempts < 1) return null;
    return {
        ok: false,
        error: "hyper-v-guest-ready-timeout",
        reason: parsed.reason,
        attempts: parsed.attempts,
    };
}

export function parseHyperVGuestBootDiagnosticObservation(stdout: string): HyperVGuestBootDiagnosticObservation | null {
    const parsed = parseLastJsonObject(stdout);
    const diagnosticErrorCodes = new Set([
        "hyper-v-diagnostic-vm-observation-incomplete",
        "hyper-v-diagnostic-integration-services-unavailable",
        "hyper-v-diagnostic-integration-services-incomplete",
        "hyper-v-diagnostic-firmware-unavailable",
        "hyper-v-diagnostic-firmware-incomplete",
        "hyper-v-diagnostic-bios-unavailable",
        "hyper-v-diagnostic-bios-incomplete",
        "hyper-v-diagnostic-hard-disks-unavailable",
        "hyper-v-diagnostic-hard-disks-incomplete",
        "hyper-v-diagnostic-vhd-inspection-incomplete",
        "hyper-v-diagnostic-dvd-drives-unavailable",
    ]);
    if (!parsed
        || parsed.ok !== true
        || typeof parsed.vmId !== "string"
        || !VM_ID_PATTERN.test(parsed.vmId)
        || typeof parsed.vmName !== "string"
        || typeof parsed.state !== "string"
        || !["Unknown", "Off", "Running", "Starting", "Stopping", "Saving", "Saved", "Pausing", "Paused", "Resuming", "Reset", "FastSaved", "FastSaving", "ForceShutdown", "ForceReboot", "RunningCritical", "OffCritical", "StoppingCritical", "SavedCritical", "PausedCritical", "StartingCritical", "ResetCritical", "SavingCritical", "PausingCritical", "ResumingCritical", "FastSavedCritical", "FastSavingCritical"].includes(parsed.state)
        || typeof parsed.uptimeMs !== "number"
        || !Number.isSafeInteger(parsed.uptimeMs)
        || parsed.uptimeMs < 0
        || (parsed.generation !== null && parsed.generation !== 1 && parsed.generation !== 2)
        || (parsed.secureBootEnabled !== null && typeof parsed.secureBootEnabled !== "boolean")
        || (parsed.heartbeatEnabled !== null && typeof parsed.heartbeatEnabled !== "boolean")
        || (parsed.heartbeatPrimaryStatus !== null && (typeof parsed.heartbeatPrimaryStatus !== "number" || !Number.isSafeInteger(parsed.heartbeatPrimaryStatus) || parsed.heartbeatPrimaryStatus < 0))
        || (parsed.heartbeatSecondaryStatus !== null && (typeof parsed.heartbeatSecondaryStatus !== "number" || !Number.isSafeInteger(parsed.heartbeatSecondaryStatus) || parsed.heartbeatSecondaryStatus < 0))
        || !Array.isArray(parsed.integrationServices)
        || parsed.integrationServices.length > 16
        || parsed.integrationServices.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const service = candidate as Record<string, unknown>;
            return typeof service.name !== "string"
                || service.name.length < 1
                || service.name.length > 128
                || /[\u0000-\u001f]/.test(service.name)
                || typeof service.enabled !== "boolean"
                || (service.primaryStatus !== null && (typeof service.primaryStatus !== "number" || !Number.isSafeInteger(service.primaryStatus) || service.primaryStatus < 0))
                || (service.secondaryStatus !== null && (typeof service.secondaryStatus !== "number" || !Number.isSafeInteger(service.secondaryStatus) || service.secondaryStatus < 0));
        })
        || typeof parsed.hardDiskCount !== "number"
        || !Number.isSafeInteger(parsed.hardDiskCount)
        || parsed.hardDiskCount < 0
        || typeof parsed.dvdCount !== "number"
        || !Number.isSafeInteger(parsed.dvdCount)
        || parsed.dvdCount < 0
        || !Array.isArray(parsed.hardDiskControllers)
        || parsed.hardDiskControllers.length > 8
        || parsed.hardDiskControllers.some((candidate: unknown) => !["ide", "scsi"].includes(String(candidate)))
        || !Array.isArray(parsed.bootDeviceTypes)
        || parsed.bootDeviceTypes.length > 8
        || parsed.bootDeviceTypes.some((candidate: unknown) => !["hard-disk", "dvd", "network", "unknown"].includes(String(candidate)))
        || !Array.isArray(parsed.bootEntries)
        || parsed.bootEntries.length > 8
        || parsed.bootEntries.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const entry = candidate as Record<string, unknown>;
            return typeof entry.bootType !== "string" || entry.bootType.length > 64
                || typeof entry.deviceType !== "string" || entry.deviceType.length > 128
                || typeof entry.controllerType !== "string" || entry.controllerType.length > 32
                || (entry.controllerNumber !== null && (!Number.isSafeInteger(entry.controllerNumber) || Number(entry.controllerNumber) < 0))
                || (entry.controllerLocation !== null && (!Number.isSafeInteger(entry.controllerLocation) || Number(entry.controllerLocation) < 0));
        })
        || !Array.isArray(parsed.hardDisks)
        || parsed.hardDisks.length > 8
        || parsed.hardDisks.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const disk = candidate as Record<string, unknown>;
            const nullableNonNegativeInteger = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
            return !["ide", "scsi"].includes(String(disk.controllerType))
                || !nullableNonNegativeInteger(disk.controllerNumber)
                || !nullableNonNegativeInteger(disk.controllerLocation)
                || typeof disk.vhdFormat !== "string" || disk.vhdFormat.length > 32
                || typeof disk.vhdType !== "string" || disk.vhdType.length > 32
                || !nullableNonNegativeInteger(disk.sizeBytes)
                || !nullableNonNegativeInteger(disk.fileSizeBytes)
                || !nullableNonNegativeInteger(disk.minimumSizeBytes)
                || !nullableNonNegativeInteger(disk.logicalSectorSize)
                || !nullableNonNegativeInteger(disk.physicalSectorSize);
        })
        || !Array.isArray(parsed.dvdDrives)
        || parsed.dvdDrives.length > 8
        || parsed.dvdDrives.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const dvd = candidate as Record<string, unknown>;
            return !["ide", "scsi", ""].includes(String(dvd.controllerType))
                || (dvd.controllerNumber !== null && (!Number.isSafeInteger(dvd.controllerNumber) || Number(dvd.controllerNumber) < 0))
                || (dvd.controllerLocation !== null && (!Number.isSafeInteger(dvd.controllerLocation) || Number(dvd.controllerLocation) < 0))
                || typeof dvd.mediaAttached !== "boolean";
        })
        || typeof parsed.diagnosticComplete !== "boolean"
        || !Array.isArray(parsed.diagnosticErrors)
        || parsed.diagnosticErrors.length > 16
        || new Set(parsed.diagnosticErrors).size !== parsed.diagnosticErrors.length
        || parsed.diagnosticErrors.some((candidate: unknown) => typeof candidate !== "string" || !diagnosticErrorCodes.has(candidate))
        || parsed.diagnosticComplete !== (parsed.diagnosticErrors.length === 0)) return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        state: parsed.state,
        uptimeMs: parsed.uptimeMs,
        generation: parsed.generation as 1 | 2 | null,
        secureBootEnabled: parsed.secureBootEnabled as boolean | null,
        heartbeatEnabled: parsed.heartbeatEnabled as boolean | null,
        heartbeatPrimaryStatus: parsed.heartbeatPrimaryStatus as number | null,
        heartbeatSecondaryStatus: parsed.heartbeatSecondaryStatus as number | null,
        integrationServices: parsed.integrationServices.map((candidate: Record<string, unknown>) => ({
            name: candidate.name as string,
            enabled: candidate.enabled as boolean,
            primaryStatus: candidate.primaryStatus as number | null,
            secondaryStatus: candidate.secondaryStatus as number | null,
        })),
        hardDiskCount: parsed.hardDiskCount,
        dvdCount: parsed.dvdCount,
        hardDiskControllers: parsed.hardDiskControllers,
        bootDeviceTypes: parsed.bootDeviceTypes,
        bootEntries: parsed.bootEntries,
        hardDisks: parsed.hardDisks,
        dvdDrives: parsed.dvdDrives,
        diagnosticComplete: parsed.diagnosticComplete,
        diagnosticErrors: parsed.diagnosticErrors,
    };
}
