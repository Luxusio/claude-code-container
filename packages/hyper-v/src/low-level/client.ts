import { isAbsolute, resolve, win32 } from "path";

import type {
    HyperVConsoleIdentity,
    HyperVConsoleInput,
    HyperVConsoleCapture,
    HyperVConsoleCursor,
    HyperVAddVMNetworkAdapterRequest,
    HyperVBiosStartupDevice,
    HyperVCheckpointVirtualMachineRequest,
    HyperVConvertVHDRequest,
    HyperVConfigureVMGuestBootRequest,
    HyperVDvdDrive,
    HyperVGetVMDiagnosticRequest,
    HyperVHardDiskDrive,
    HyperVMountVHDRequest,
    HyperVNewVirtualMachineRequest,
    HyperVRemoveSnapshotRequest,
    HyperVRepairVMSnapshotStateRequest,
    HyperVRepairVMSnapshotStateResult,
    HyperVRemoveHostFilesRequest,
    HyperVRemoveHostFilesResult,
    HyperVRemoveVMGuard,
    HyperVRemoveVMDvdDriveRequest,
    HyperVRemoveVirtualMachineRequest,
    HyperVRestartVirtualMachineRequest,
    HyperVResizeVHDRequest,
    HyperVRenameVMNetworkAdapterRequest,
    HyperVRestoreSnapshotRequest,
    HyperVSecureBootSetting,
    HyperVSetVirtualMachineRequest,
    HyperVSetVMBiosRequest,
    HyperVSetVMFirmwareRequest,
    HyperVSetVMMemoryRequest,
    HyperVSetVMNetworkAdapterRequest,
    HyperVSetVMProcessorRequest,
    HyperVSnapshotSelector,
    HyperVStartVirtualMachineRequest,
    HyperVStopVirtualMachineRequest,
    HyperVPowerIdentityExpectation,
    HyperVVirtualMachine,
    HyperVVirtualMachineBios,
    HyperVVirtualMachineFirmware,
    HyperVVirtualHardDisk,
    HyperVVMNetworkAdapterTarget,
    HyperVVirtualMachineSelector,
    HyperVVirtualMachineSnapshot,
    HyperVVhdMutationCallOptions,
    HyperVWindowsCallOptions,
    HyperVWindowsClient,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
    HyperVWindowsOperation,
} from "./contracts.js";
import { parseHyperVWindowsGuestBootDiagnostic } from "./diagnostic.js";
import { HyperVWindowsError, parseHyperVWindowsNativeDiagnostics } from "./errors.js";
import { parseHyperVMacAddress } from "./network-contracts.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONSOLE_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_CONSOLE_PNG_BYTES = 4 * 1024 * 1024;
const CONSOLE_WIDTH = 640;
const CONSOLE_HEIGHT = 480;
const EXECUTION_TIMEOUT_MILLISECONDS = 120 * 1000;
const MAX_VHD_MUTATION_TIMEOUT_MILLISECONDS = 4 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 100;
const MAX_NATIVE_STRING_LENGTH = 32 * 1024;
// The wildcard characters the Hyper-V cmdlets treat as patterns rather than literals.
const NATIVE_NAME_WILDCARDS = ["*", "?", "[", "]"];

type SuccessEnvelope = {
    schemaVersion: 1;
    operation: HyperVWindowsOperation;
    ok: true;
    items: unknown[];
};

function error(
    category: "validation" | "transport" | "protocol" | "native",
    operation: HyperVWindowsOperation,
    code: string,
    nativeStatus?: number,
): HyperVWindowsError {
    return new HyperVWindowsError({ category, operation, code, ...(nativeStatus === undefined ? {} : { nativeStatus }) });
}

// Exported for the network client, which addresses VMs the same way and must not carry a
// second copy of this: it validates the target of Remove-VMNetworkAdapter, and two copies of
// destructive-target validation are two things that can drift apart. Not re-exported from
// the package index -- it is internal to the low-level layer.
export function normalizeSelector(
    operation: HyperVWindowsOperation,
    selector: HyperVVirtualMachineSelector,
): HyperVVirtualMachineSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "selector-invalid");
    if (candidate.kind === "id") {
        if (!hasExactKeys(candidate, ["kind", "id"])) throw error("validation", operation, "selector-invalid");
        if (typeof candidate.id !== "string" || !GUID_PATTERN.test(candidate.id)) {
            throw error("validation", operation, "selector-id-invalid");
        }
        return { kind: "id", id: candidate.id.toLowerCase() };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "selector-invalid");
        if (typeof candidate.name !== "string"
            || candidate.name.length === 0
            || candidate.name.length > MAX_NAME_LENGTH
            || /[\u0000-\u001f*?\[\]]/.test(candidate.name)) {
            throw error("validation", operation, "selector-name-invalid");
        }
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "selector-kind-invalid");
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, allowEmpty = true): value is string {
    return typeof value === "string"
        && (allowEmpty || value.length > 0)
        && value.length <= MAX_NATIVE_STRING_LENGTH
        && !value.includes("\u0000");
}

function normalizeVhdMutationPath(operation: HyperVWindowsOperation, path: unknown): string {
    if (!boundedString(path, false) || !isAbsolute(path) || /[\u0000-\u001f*?\[\]]/.test(path)) {
        throw error("validation", operation, "vhd-path-invalid");
    }
    return path;
}

function normalizeOwnedPath(operation: HyperVWindowsOperation, value: unknown): string {
    if (!boundedString(value, false) || value.length > 4096 || /[\u0000-\u001f*?\[\]]/.test(value)) {
        throw error("validation", operation, "owned-path-invalid");
    }
    // Broker fixtures use host-native temporary paths on Linux. Production runs on Windows and
    // accepts only fully qualified Windows paths; POSIX support never reaches the native script.
    if (process.platform !== "win32" && value.startsWith("/") && isAbsolute(value)) return resolve(value);
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(value)) {
        throw error("validation", operation, "owned-path-invalid");
    }
    return win32.normalize(value);
}

function isInsideOwnedDirectory(directory: string, path: string): boolean {
    if (directory.startsWith("/")) {
        const normalizedDirectory = directory.replace(/\/+$/, "");
        return path.startsWith(`${normalizedDirectory}/`);
    }
    const normalizedDirectory = directory.toLowerCase().replace(/[\\/]+$/, "");
    return path.toLowerCase().startsWith(`${normalizedDirectory}\\`);
}

function normalizeRemoveGuard(operation: HyperVWindowsOperation, value: unknown): HyperVRemoveVMGuard {
    const candidate = record(value);
    if (!candidate || !validNativeName(candidate.expectedName)
        || !boundedString(candidate.expectedNotes) || candidate.expectedNotes.length > 4096
        || /[\u0000-\u001f]/.test(candidate.expectedNotes)
        || !Array.isArray(candidate.expectedDiskPaths) || candidate.expectedDiskPaths.length < 1
        || candidate.expectedDiskPaths.length > 128
        || !Array.isArray(candidate.expectedDvdPaths) || candidate.expectedDvdPaths.length > 128) {
        throw error("validation", operation, "vm-remove-guard-invalid");
    }
    const ownedDiskDirectory = normalizeOwnedPath(operation, candidate.ownedDiskDirectory);
    const expectedDiskPaths = candidate.expectedDiskPaths.map((path) => normalizeOwnedPath(operation, path));
    const expectedDvdPaths = candidate.expectedDvdPaths.map((path) => normalizeOwnedPath(operation, path));
    if (expectedDiskPaths.some((path) => !isInsideOwnedDirectory(ownedDiskDirectory, path))
        || new Set(expectedDiskPaths.map((path) => path.toLowerCase())).size !== expectedDiskPaths.length
        || new Set(expectedDvdPaths.map((path) => path.toLowerCase())).size !== expectedDvdPaths.length) {
        throw error("validation", operation, "vm-remove-guard-invalid");
    }
    const hasUnmarkedRoot = Object.hasOwn(candidate, "unmarkedRootDiskPath");
    if (candidate.expectedNotes.length === 0) {
        if (!hasUnmarkedRoot || expectedDiskPaths.length !== 1) {
            throw error("validation", operation, "vm-remove-guard-invalid");
        }
        const root = normalizeOwnedPath(operation, candidate.unmarkedRootDiskPath);
        if (root.toLowerCase() !== expectedDiskPaths[0]?.toLowerCase()) {
            throw error("validation", operation, "vm-remove-guard-invalid");
        }
        return { expectedName: candidate.expectedName, expectedNotes: "", expectedDiskPaths,
            ownedDiskDirectory, expectedDvdPaths, unmarkedRootDiskPath: root };
    }
    if (hasUnmarkedRoot) throw error("validation", operation, "vm-remove-guard-invalid");
    return { expectedName: candidate.expectedName, expectedNotes: candidate.expectedNotes,
        expectedDiskPaths, ownedDiskDirectory, expectedDvdPaths };
}

function normalizeRemoveHostFiles(operation: HyperVWindowsOperation, value: unknown): HyperVRemoveHostFilesRequest {
    const candidate = record(value);
    if (!candidate || !Array.isArray(candidate.paths) || candidate.paths.length > 128) {
        throw error("validation", operation, "host-files-request-invalid");
    }
    const rootDirectory = normalizeOwnedPath(operation, candidate.rootDirectory);
    const paths = candidate.paths.map((path) => normalizeOwnedPath(operation, path));
    const checkpointDiskDirectory = candidate.checkpointDiskDirectory === undefined
        ? undefined : normalizeOwnedPath(operation, candidate.checkpointDiskDirectory);
    if (paths.some((path) => !isInsideOwnedDirectory(rootDirectory, path))
        || (checkpointDiskDirectory && !isInsideOwnedDirectory(rootDirectory, checkpointDiskDirectory))
        || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
        throw error("validation", operation, "host-files-request-invalid");
    }
    return { rootDirectory, paths, ...(checkpointDiskDirectory ? { checkpointDiskDirectory } : {}) };
}

function vhdMutationTimeout(operation: HyperVWindowsOperation, options?: HyperVVhdMutationCallOptions): number {
    const requested = options?.timeoutMilliseconds;
    if (requested === undefined) return EXECUTION_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_VHD_MUTATION_TIMEOUT_MILLISECONDS) {
        throw error("validation", operation, "timeout-invalid");
    }
    return requested;
}

function safeInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function canonicalGuid(value: unknown): string | null {
    return typeof value === "string" && GUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function parseVirtualMachine(value: unknown): HyperVVirtualMachine | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "id", "name", "state", "status", "notes", "uptimeMilliseconds", "generation", "checkpointType",
    ])) return null;
    const id = canonicalGuid(item.id);
    if (!id
        || !boundedString(item.name, false)
        || !boundedString(item.state, false)
        || !boundedString(item.status)
        || !boundedString(item.notes)
        || !safeInteger(item.uptimeMilliseconds)
        || !safeInteger(item.generation, 1)
        || !boundedString(item.checkpointType)) return null;
    return {
        id,
        name: item.name,
        state: item.state,
        status: item.status,
        notes: item.notes,
        uptimeMilliseconds: item.uptimeMilliseconds,
        generation: item.generation,
        checkpointType: item.checkpointType,
    };
}

function parseNullablePath(value: unknown): string | null | undefined {
    if (value === null) return null;
    return boundedString(value, false) ? value : undefined;
}

function parseHardDiskDrive(value: unknown): HyperVHardDiskDrive | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "vmId", "vmName", "path", "controllerType", "controllerNumber", "controllerLocation", "diskNumber",
    ])) return null;
    const vmId = canonicalGuid(item.vmId);
    const path = parseNullablePath(item.path);
    if (!vmId
        || !boundedString(item.vmName, false)
        || path === undefined
        || !boundedString(item.controllerType, false)
        || !safeInteger(item.controllerNumber)
        || !safeInteger(item.controllerLocation)
        || (item.diskNumber !== null && !safeInteger(item.diskNumber))) return null;
    return {
        vmId,
        vmName: item.vmName,
        path,
        controllerType: item.controllerType,
        controllerNumber: item.controllerNumber,
        controllerLocation: item.controllerLocation,
        diskNumber: item.diskNumber as number | null,
    };
}

function parseDvdDrive(value: unknown): HyperVDvdDrive | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "vmId", "vmName", "path", "controllerType", "controllerNumber", "controllerLocation",
    ])) return null;
    const vmId = canonicalGuid(item.vmId);
    const path = parseNullablePath(item.path);
    if (!vmId
        || !boundedString(item.vmName, false)
        || path === undefined
        || !boundedString(item.controllerType, false)
        || !safeInteger(item.controllerNumber)
        || !safeInteger(item.controllerLocation)) return null;
    return {
        vmId,
        vmName: item.vmName,
        path,
        controllerType: item.controllerType,
        controllerNumber: item.controllerNumber,
        controllerLocation: item.controllerLocation,
    };
}

function parseSnapshot(value: unknown): HyperVVirtualMachineSnapshot | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "id", "name", "vmId", "vmName", "snapshotType",
        "parentSnapshotId", "parentSnapshotName", "creationTimeMilliseconds",
    ])) return null;
    const id = canonicalGuid(item.id);
    const vmId = canonicalGuid(item.vmId);
    // A root checkpoint has no parent, so null is a real value here rather than a decode failure.
    const parentSnapshotId = item.parentSnapshotId === null ? null : canonicalGuid(item.parentSnapshotId);
    if (!id
        || !vmId
        || !boundedString(item.name, false)
        || !boundedString(item.vmName, false)
        || !boundedString(item.snapshotType, false)
        || (item.parentSnapshotId !== null && !parentSnapshotId)
        || (item.parentSnapshotName !== null && !boundedString(item.parentSnapshotName, false))
        || !safeInteger(item.creationTimeMilliseconds)) return null;
    return {
        id,
        name: item.name,
        vmId,
        vmName: item.vmName,
        snapshotType: item.snapshotType,
        parentSnapshotId,
        parentSnapshotName: item.parentSnapshotName as string | null,
        creationTimeMilliseconds: item.creationTimeMilliseconds,
    };
}

// Snapshot names carry the same native restrictions as virtual machine names: non-empty, bounded,
// no control characters, and no cmdlet wildcard characters.
function validNativeName(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME_LENGTH) return false;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 0x20) return false;
        if (NATIVE_NAME_WILDCARDS.includes(character)) return false;
    }
    return true;
}

function normalizePowerIdentity(
    operation: HyperVWindowsOperation,
    request: HyperVPowerIdentityExpectation,
    selector: HyperVVirtualMachineSelector,
): HyperVPowerIdentityExpectation {
    const candidate = record(request);
    const hasName = candidate !== null && Object.hasOwn(candidate, "expectedName");
    const hasNotes = candidate !== null && Object.hasOwn(candidate, "expectedNotes");
    if (!hasName && !hasNotes) return {};
    if (!hasName || !hasNotes || selector.kind !== "id"
        || !validNativeName(candidate.expectedName)
        || !boundedString(candidate.expectedNotes, false)
        || candidate.expectedNotes.length > 4096
        || /[\u0000-\u001f]/.test(candidate.expectedNotes)) {
        throw error("validation", operation, "vm-identity-invalid");
    }
    return { expectedName: candidate.expectedName, expectedNotes: candidate.expectedNotes };
}

function normalizeSnapshotSelector(
    operation: HyperVWindowsOperation,
    selector: HyperVSnapshotSelector,
): HyperVSnapshotSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "snapshot-selector-invalid");
    if (candidate.kind === "id") {
        if (!hasExactKeys(candidate, ["kind", "id"])) throw error("validation", operation, "snapshot-selector-invalid");
        if (typeof candidate.id !== "string" || !GUID_PATTERN.test(candidate.id)) {
            throw error("validation", operation, "snapshot-selector-id-invalid");
        }
        return { kind: "id", id: candidate.id.toLowerCase() };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "snapshot-selector-invalid");
        if (!validNativeName(candidate.name)) throw error("validation", operation, "snapshot-selector-name-invalid");
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "snapshot-selector-kind-invalid");
}

function decodeEnvelope(
    operation: HyperVWindowsOperation,
    execution: HyperVWindowsExecutionResult,
): SuccessEnvelope {
    if (execution.outputLimitExceeded || Buffer.byteLength(execution.stdout, "utf8") >
        (operation === "Capture-VMConsole" ? MAX_CONSOLE_RESPONSE_BYTES : MAX_RESPONSE_BYTES)) {
        throw error("protocol", operation, "response-too-large");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(execution.stdout.trim());
    } catch {
        throw error("protocol", operation, "response-malformed");
    }
    const envelope = record(parsed);
    if (!envelope || envelope.schemaVersion !== 1 || envelope.operation !== operation || typeof envelope.ok !== "boolean") {
        throw error("protocol", operation, "response-envelope-invalid");
    }
    if (envelope.ok === false) {
        const nativeDiagnostics = parseHyperVWindowsNativeDiagnostics(envelope);
        if (!nativeDiagnostics || !hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "errorCode",
            ...["nativeHResult", "nativeErrorCategory"].filter((key) => Object.hasOwn(envelope, key))])
            || typeof envelope.errorCode !== "string"
            || !NATIVE_ERROR_CODE_PATTERN.test(envelope.errorCode)) {
            throw error("protocol", operation, "response-envelope-invalid");
        }
        throw new HyperVWindowsError({ category: "native", operation, code: envelope.errorCode,
            ...(execution.status === null ? {} : { nativeStatus: execution.status }), ...nativeDiagnostics });
    }
    if (!hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "items"]) || !Array.isArray(envelope.items)) {
        throw error("protocol", operation, "response-envelope-invalid");
    }
    if (execution.status !== 0) throw error("protocol", operation, "response-status-conflict");
    return envelope as SuccessEnvelope;
}

export async function execute(
    executor: HyperVWindowsExecutor,
    request: HyperVWindowsExecutionRequest,
    options?: HyperVWindowsCallOptions,
    timeoutMilliseconds = EXECUTION_TIMEOUT_MILLISECONDS,
): Promise<SuccessEnvelope> {
    if (options?.signal?.aborted) throw error("transport", request.operation, "cancelled");
    let execution: HyperVWindowsExecutionResult;
    try {
        execution = await executor.execute(request, {
            timeoutMilliseconds,
            maximumOutputBytes: request.operation === "Capture-VMConsole" ? MAX_CONSOLE_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
    } catch (cause) {
        const code = cause instanceof Error && cause.name === "AbortError" ? "cancelled" : "executor-failed";
        throw error("transport", request.operation, code);
    }
    if (!execution || typeof execution !== "object"
        || (execution.status !== null && !Number.isInteger(execution.status))
        || typeof execution.stdout !== "string") {
        throw error("transport", request.operation, "executor-result-invalid");
    }
    if (execution.outputLimitExceeded) throw error("protocol", request.operation, "response-too-large");
    if (execution.cancelled) throw error("transport", request.operation, "cancelled");
    if (execution.timedOut) throw error("transport", request.operation, "timeout");
    if (execution.error || execution.status === null) throw error("transport", request.operation, "executor-failed");
    return decodeEnvelope(request.operation, execution);
}

function decodeItems<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    decoder: (value: unknown) => T | null,
): readonly T[] {
    if (envelope.items.length > 4096) throw error("protocol", operation, "result-count-exceeded");
    const decoded = envelope.items.map(decoder);
    if (decoded.some((item) => item === null)) throw error("protocol", operation, "result-shape-invalid");
    return decoded as T[];
}

function expectNoItems(operation: HyperVWindowsOperation, envelope: SuccessEnvelope): void {
    if (envelope.items.length !== 0) throw error("protocol", operation, "result-ambiguous");
}

const BIOS_STARTUP_DEVICES: readonly HyperVBiosStartupDevice[] = ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"];
// Hyper-V's own floor. Below it native refuses, and a request that cannot succeed should fail
// here rather than after a process launch.
const MINIMUM_MEMORY_BYTES = 32 * 1024 * 1024;
// Hyper-V's own per-VM ceiling. Like the memory floor above it this is a native fact, not a
// consumer policy: a request above it cannot succeed, so it fails here rather than after a
// process launch.
const MAXIMUM_PROCESSOR_COUNT = 512;

function parseVirtualMachineFirmware(value: unknown): HyperVVirtualMachineFirmware | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["vmId", "secureBoot", "secureBootTemplate", "firstBootDevicePath"])) return null;
    const vmId = canonicalGuid(item.vmId);
    if (!vmId || !boundedString(item.secureBoot, false) || !boundedString(item.secureBootTemplate)) return null;
    // Absent is a real answer here: the first boot entry may be a network or DVD device, which
    // has no path. A caller checking "does the VM boot from my disk" must be able to tell that
    // apart from a path that failed to decode, so only null and a usable string are accepted.
    if (item.firstBootDevicePath !== null && !boundedString(item.firstBootDevicePath, false)) return null;
    return {
        vmId,
        secureBoot: item.secureBoot,
        secureBootTemplate: item.secureBootTemplate,
        firstBootDevicePath: item.firstBootDevicePath as string | null,
    };
}

function parseVirtualMachineBios(value: unknown): HyperVVirtualMachineBios | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["vmId", "startupOrder"])) return null;
    const vmId = canonicalGuid(item.vmId);
    if (!vmId || !Array.isArray(item.startupOrder) || item.startupOrder.length < 1
        || item.startupOrder.length > BIOS_STARTUP_DEVICES.length
        || !item.startupOrder.every((device) => BIOS_STARTUP_DEVICES.includes(device))
        || new Set(item.startupOrder).size !== item.startupOrder.length) return null;
    return { vmId, startupOrder: Object.freeze([...item.startupOrder as HyperVBiosStartupDevice[]]) };
}

function parseVirtualHardDisk(value: unknown): HyperVVirtualHardDisk | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["path", "vhdFormat", "vhdType", "parentPath", "virtualSizeBytes", "fileSizeBytes"])) return null;
    if (!boundedString(item.path, false) || !boundedString(item.vhdFormat, false)
        || !boundedString(item.vhdType, false)
        || (item.parentPath !== null && !boundedString(item.parentPath, false))
        || !safeInteger(item.virtualSizeBytes, 1) || !safeInteger(item.fileSizeBytes)) return null;
    return item as HyperVVirtualHardDisk;
}

// Secure Boot off carries no template, because native rejects one. Validating the pair here
// keeps the client from sending a combination the host will only reject after a process launch.
function normalizeSecureBoot(
    operation: HyperVWindowsOperation,
    setting: HyperVSecureBootSetting,
): HyperVSecureBootSetting {
    const candidate = record(setting);
    if (!candidate) throw error("validation", operation, "secure-boot-invalid");
    if (candidate.enabled === false) {
        if (!hasExactKeys(candidate, ["enabled"])) throw error("validation", operation, "secure-boot-invalid");
        return { enabled: false };
    }
    if (candidate.enabled === true) {
        if (!hasExactKeys(candidate, ["enabled", "template"])) throw error("validation", operation, "secure-boot-invalid");
        if (!validNativeName(candidate.template)) throw error("validation", operation, "secure-boot-template-invalid");
        return { enabled: true, template: candidate.template };
    }
    throw error("validation", operation, "secure-boot-invalid");
}

// The adapter New-VM creates carries a display-language name, so a literal for it is wrong on
// a localized host. `sole` says "the VM's only adapter" and resolves only when that is true --
// the same assertion the PowerShell this replaces made before it took index 0.
function normalizeAdapterTarget(
    operation: HyperVWindowsOperation,
    target: HyperVVMNetworkAdapterTarget,
): HyperVVMNetworkAdapterTarget {
    const candidate = record(target);
    if (!candidate) throw error("validation", operation, "adapter-target-invalid");
    if (candidate.kind === "sole") {
        if (!hasExactKeys(candidate, ["kind"])) throw error("validation", operation, "adapter-target-invalid");
        return { kind: "sole" };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "adapter-target-invalid");
        if (!validNativeName(candidate.name)) throw error("validation", operation, "adapter-target-name-invalid");
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "adapter-target-kind-invalid");
}

function decodeSingleItem<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    decoder: (value: unknown) => T | null,
): T {
    if (envelope.items.length !== 1) throw error("protocol", operation, "result-ambiguous");
    const decoded = decoder(envelope.items[0]);
    if (decoded === null) throw error("protocol", operation, "result-shape-invalid");
    return decoded;
}

function normalizeConsoleIdentity(operation: HyperVWindowsOperation, input: HyperVConsoleIdentity) {
    const candidate = record(input);
    if (!candidate || !validNativeName(candidate.expectedName) || !boundedString(candidate.expectedNotes, false)
        || candidate.expectedNotes.length > 4096 || /[\u0000-\u001f]/.test(candidate.expectedNotes)) {
        throw error("validation", operation, "console-identity-invalid");
    }
    const selector = normalizeSelector(operation, input.selector);
    if (selector.kind !== "id") throw error("validation", operation, "selector-id-required");
    return { selector, expectedName: input.expectedName, expectedNotes: input.expectedNotes };
}

function consoleDimension(value: unknown, maximum = 8192): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function decodeConsoleCapture(value: unknown): HyperVConsoleCapture | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["pngBase64", "width", "height", "nativeWidth", "nativeHeight"])
        || item.width !== CONSOLE_WIDTH || item.height !== CONSOLE_HEIGHT
        || !consoleDimension(item.nativeWidth) || !consoleDimension(item.nativeHeight)
        || typeof item.pngBase64 !== "string" || item.pngBase64.length > Math.ceil(MAX_CONSOLE_PNG_BYTES / 3) * 4
        || item.pngBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.pngBase64)) return null;
    const png = Buffer.from(item.pngBase64, "base64");
    if (png.length < 33 || png.length > MAX_CONSOLE_PNG_BYTES || png.toString("base64") !== item.pngBase64
        || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.subarray(12, 16).toString("ascii") !== "IHDR"
        || png.readUInt32BE(8) !== 13
        || png.readUInt32BE(16) !== CONSOLE_WIDTH || png.readUInt32BE(20) !== CONSOLE_HEIGHT) return null;
    let offset = 8;
    let sawImage = false;
    let ended = false;
    while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString("ascii", offset + 4, offset + 8);
        if (offset + 12 + length > png.length) return null;
        if (type === "IDAT") sawImage = true;
        offset += 12 + length;
        if (type === "IEND") {
            if (length !== 0) return null;
            ended = true;
            break;
        }
    }
    if (!sawImage || !ended || offset !== png.length) return null;
    return item as HyperVConsoleCapture;
}

function decodeConsoleCursor(value: unknown): HyperVConsoleCursor | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["x", "y", "width", "height", "nativeWidth", "nativeHeight"])
        || item.width !== CONSOLE_WIDTH || item.height !== CONSOLE_HEIGHT
        || !consoleDimension(item.nativeWidth) || !consoleDimension(item.nativeHeight)
        || !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)
        || (item.x as number) < 0 || (item.x as number) >= CONSOLE_WIDTH
        || (item.y as number) < 0 || (item.y as number) >= CONSOLE_HEIGHT) return null;
    return item as HyperVConsoleCursor;
}

const CONSOLE_KEYS = new Set([
    "CTRL", "ALT", "SHIFT", "WIN", "ENTER", "TAB", "ESC", "SPACE", "BACKSPACE", "DELETE", "INSERT",
    "HOME", "END", "PAGEUP", "PAGEDOWN", "UP", "DOWN", "LEFT", "RIGHT",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const CONSOLE_MODIFIERS = new Set(["CTRL", "ALT", "SHIFT", "WIN"]);

function normalizeConsoleInput(operation: HyperVWindowsOperation, input: HyperVConsoleInput) {
    const candidate = record(input);
    if (!candidate) throw error("validation", operation, "console-input-invalid");
    const identity = normalizeConsoleIdentity(operation, input);
    if (candidate.action === "key") {
        if (!hasExactKeys(candidate, ["selector", "expectedName", "expectedNotes", "action", "keys"])
            || !Array.isArray(candidate.keys) || candidate.keys.length < 1 || candidate.keys.length > 4) {
            throw error("validation", operation, "console-keys-invalid");
        }
        const keys = candidate.keys.map((key) => typeof key === "string" ? key.toUpperCase() : "");
        if (keys.some((key) => !CONSOLE_KEYS.has(key)) || CONSOLE_MODIFIERS.has(keys.at(-1) || "")
            || keys.slice(0, -1).some((key) => !CONSOLE_MODIFIERS.has(key)) || new Set(keys).size !== keys.length) {
            throw error("validation", operation, "console-keys-invalid");
        }
        return { ...identity, action: "key" as const, keys };
    }
    if (candidate.action === "type") {
        if (!hasExactKeys(candidate, ["selector", "expectedName", "expectedNotes", "action", "text"])
            || typeof candidate.text !== "string" || candidate.text.length < 1 || candidate.text.length > 2048
            || candidate.text.includes("\u0000") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(candidate.text)) {
            throw error("validation", operation, "console-text-invalid");
        }
        return { ...identity, action: "type" as const, text: candidate.text };
    }
    const pointer = candidate as Record<string, unknown>;
    const expectedKeys = ["selector", "expectedName", "expectedNotes", "action", "x", "y", "width", "height", "nativeWidth", "nativeHeight",
        ...((candidate.action === "click" || candidate.action === "doubleClick") ? ["button"] : []),
        ...(candidate.action === "scroll" ? ["direction", "amount"] : []),
        ...(candidate.action === "drag" ? ["x2", "y2", "durationMs"] : [])];
    if (!["click", "doubleClick", "cursor", "scroll", "drag"].includes(String(candidate.action))
        || !hasExactKeys(candidate, expectedKeys)
        || pointer.width !== CONSOLE_WIDTH || pointer.height !== CONSOLE_HEIGHT
        || !consoleDimension(pointer.nativeWidth) || !consoleDimension(pointer.nativeHeight)
        || !Number.isSafeInteger(pointer.x) || !Number.isSafeInteger(pointer.y)
        || (pointer.x as number) < 0 || (pointer.x as number) >= CONSOLE_WIDTH
        || (pointer.y as number) < 0 || (pointer.y as number) >= CONSOLE_HEIGHT) {
        throw error("validation", operation, "console-pointer-invalid");
    }
    if ((candidate.action === "click" || candidate.action === "doubleClick") && candidate.button !== "left" && candidate.button !== "right") {
        throw error("validation", operation, "console-button-invalid");
    }
    if (candidate.action === "scroll" && (!["up", "down", "left", "right"].includes(String(candidate.direction))
        || !Number.isSafeInteger(candidate.amount) || (candidate.amount as number) < 1 || (candidate.amount as number) > 10)) {
        throw error("validation", operation, "console-scroll-invalid");
    }
    if (candidate.action === "drag" && (!Number.isSafeInteger(candidate.x2) || !Number.isSafeInteger(candidate.y2)
        || (candidate.x2 as number) < 0 || (candidate.x2 as number) >= CONSOLE_WIDTH
        || (candidate.y2 as number) < 0 || (candidate.y2 as number) >= CONSOLE_HEIGHT
        || !Number.isSafeInteger(candidate.durationMs) || (candidate.durationMs as number) < 1 || (candidate.durationMs as number) > 10000)) {
        throw error("validation", operation, "console-drag-invalid");
    }
    return { ...input, ...identity };
}

export function createHyperVWindowsClient(executor: HyperVWindowsExecutor): HyperVWindowsClient {
    return {
        async captureVMConsole(request: HyperVConsoleIdentity, options?: HyperVWindowsCallOptions) {
            const operation = "Capture-VMConsole";
            const identity = normalizeConsoleIdentity(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...identity }, options, 30000);
            return decodeSingleItem(operation, envelope, decodeConsoleCapture);
        },
        async getVMConsoleCursor(request: HyperVConsoleIdentity, options?: HyperVWindowsCallOptions) {
            const operation = "Get-VMConsoleCursor";
            const identity = normalizeConsoleIdentity(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...identity }, options, 15000);
            return decodeSingleItem(operation, envelope, decodeConsoleCursor);
        },
        async sendVMConsoleInput(request: HyperVConsoleInput, options?: HyperVWindowsCallOptions) {
            const operation = "Send-VMConsoleInput";
            const normalized = normalizeConsoleInput(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...normalized }, options, 30000);
            expectNoItems(operation, envelope);
        },
        async configureVMGuestBoot(request: HyperVConfigureVMGuestBootRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Configure-VMGuestBoot";
            const candidate = record(request);
            const guestKind = candidate?.guestKind === undefined ? "windows" : candidate.guestKind;
            if (!candidate || (guestKind !== "windows" && guestKind !== "linux")
                || (guestKind === "windows" && (Object.hasOwn(candidate, "expectedBootstrapAdapterName")
                    || Object.hasOwn(candidate, "expectedBootstrapSwitchName")
                    || Object.hasOwn(candidate, "expectedBootstrapMacAddress")))
                || !hasExactKeys(candidate, [
                "selector", "expectedName", "expectedNotes", "osDiskPath", "mediaPath", "bootSettings",
                ...(candidate.guestKind === undefined ? [] : ["guestKind"]),
                ...(guestKind === "linux" ? [
                    "expectedBootstrapAdapterName", "expectedBootstrapSwitchName", "expectedBootstrapMacAddress",
                ] : []),
            ])) throw error("validation", operation, "request-invalid");
            let expectedBootstrapAdapterName: string | undefined;
            let expectedBootstrapSwitchName: string | undefined;
            let expectedBootstrapMacAddress: string | undefined;
            if (guestKind === "linux") {
                if (!validNativeName(candidate.expectedBootstrapAdapterName)
                    || !validNativeName(candidate.expectedBootstrapSwitchName)) {
                    throw error("validation", operation, "bootstrap-name-invalid");
                }
                expectedBootstrapAdapterName = candidate.expectedBootstrapAdapterName;
                expectedBootstrapSwitchName = candidate.expectedBootstrapSwitchName;
                const rawMac = candidate.expectedBootstrapMacAddress;
                try {
                    if (typeof rawMac !== "string") throw new Error("bootstrap-mac-invalid");
                    expectedBootstrapMacAddress = parseHyperVMacAddress(rawMac).toUpperCase();
                    if (expectedBootstrapMacAddress.length !== 12
                        || (/[:-]/.test(rawMac) && rawMac.split(/[:-]/).some((part) => part.length !== 2))) {
                        throw new Error("bootstrap-mac-invalid");
                    }
                } catch {
                    throw error("validation", operation, "bootstrap-mac-invalid");
                }
            }
            const selector = normalizeSelector(operation, request.selector);
            if (selector.kind !== "id") throw error("validation", operation, "selector-id-required");
            if (!validNativeName(request.expectedName)
                || !boundedString(request.expectedNotes, false) || request.expectedNotes.length > 4096
                || /[\u0000-\u001f]/.test(request.expectedNotes)) {
                throw error("validation", operation, "vm-identity-invalid");
            }
            const validPath = (path: unknown): path is string => boundedString(path, false)
                && path.length <= 4096
                && ((win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(path))
                    || (process.platform !== "win32" && isAbsolute(path)))
                && !/[\u0000-\u001f*?\[\]]/.test(path);
            if (!validPath(request.osDiskPath)) throw error("validation", operation, "os-disk-path-invalid");
            if (!validPath(request.mediaPath)) throw error("validation", operation, "media-path-invalid");
            const bootSettings = record(request.bootSettings);
            if (!bootSettings) throw error("validation", operation, "boot-settings-invalid");
            let normalizedBootSettings: HyperVConfigureVMGuestBootRequest["bootSettings"];
            if (bootSettings.generation === 2) {
                if (!hasExactKeys(bootSettings, ["generation", "secureBoot"])) {
                    throw error("validation", operation, "boot-settings-invalid");
                }
                const secureBoot = normalizeSecureBoot(operation, request.bootSettings.generation === 2
                    ? request.bootSettings.secureBoot : { enabled: false });
                if (guestKind === "windows" && !secureBoot.enabled) throw error("validation", operation, "secure-boot-required");
                if (guestKind === "linux" && secureBoot.enabled) throw error("validation", operation, "secure-boot-must-be-disabled");
                normalizedBootSettings = { generation: 2, secureBoot };
            } else if (bootSettings.generation === 1) {
                if (!hasExactKeys(bootSettings, ["generation", "startupOrder"])
                    || !Array.isArray(bootSettings.startupOrder) || bootSettings.startupOrder.length < 1
                    || bootSettings.startupOrder.length > BIOS_STARTUP_DEVICES.length
                    || !bootSettings.startupOrder.every((device) => BIOS_STARTUP_DEVICES.includes(device))
                    || new Set(bootSettings.startupOrder).size !== bootSettings.startupOrder.length) {
                    throw error("validation", operation, "boot-settings-invalid");
                }
                normalizedBootSettings = { generation: 1, startupOrder: [...bootSettings.startupOrder as HyperVBiosStartupDevice[]] };
                if (guestKind === "linux" && normalizedBootSettings.startupOrder[0] !== "IDE") {
                    throw error("validation", operation, "linux-bios-disk-first-required");
                }
            } else {
                throw error("validation", operation, "boot-settings-invalid");
            }
            const payload = {
                schemaVersion: 1, operation, selector,
                expectedName: request.expectedName, expectedNotes: request.expectedNotes,
                osDiskPath: request.osDiskPath, mediaPath: request.mediaPath,
                bootSettings: normalizedBootSettings,
            } as const;
            const executionRequest: HyperVWindowsExecutionRequest = guestKind === "linux"
                ? {
                    ...payload, guestKind: "linux" as const,
                    expectedBootstrapAdapterName: expectedBootstrapAdapterName!,
                    expectedBootstrapSwitchName: expectedBootstrapSwitchName!,
                    expectedBootstrapMacAddress: expectedBootstrapMacAddress!,
                }
                : candidate.guestKind === undefined ? payload : { ...payload, guestKind: "windows" as const };
            const envelope = await execute(executor, executionRequest, options);
            expectNoItems(operation, envelope);
        },
        async getVMDiagnostic(request: HyperVGetVMDiagnosticRequest, options?: HyperVWindowsCallOptions & { readonly timeoutMilliseconds?: number }) {
            const operation = "Get-VMDiagnostic";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["selector", "expectedName", "expectedNotes"])) {
                throw error("validation", operation, "request-invalid");
            }
            const selector = normalizeSelector(operation, request.selector);
            if (selector.kind !== "id") throw error("validation", operation, "selector-id-required");
            if (!boundedString(request.expectedName, false) || request.expectedName.length > MAX_NAME_LENGTH
                || !boundedString(request.expectedNotes, false) || request.expectedNotes.length > 4096
                || /[\u0000-\u001f]/.test(request.expectedName)
                || /[\u0000-\u001f]/.test(request.expectedNotes)) {
                throw error("validation", operation, "vm-identity-invalid");
            }
            const timeout = options?.timeoutMilliseconds ?? 15000;
            if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000) {
                throw error("validation", operation, "timeout-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, selector,
                expectedName: request.expectedName, expectedNotes: request.expectedNotes,
            }, options, timeout);
            if (envelope.items.length !== 1) throw error("protocol", operation, "result-ambiguous");
            const diagnostic = parseHyperVWindowsGuestBootDiagnostic(envelope.items[0]);
            if (!diagnostic) throw error("protocol", operation, "result-shape-invalid");
            if (diagnostic.vmId !== selector.id || diagnostic.vmName !== request.expectedName) {
                throw error("protocol", operation, "result-identity-mismatch");
            }
            return diagnostic;
        },
        async getVHD(path, options) {
            const operation = "Get-VHD";
            if (!boundedString(path, false) || !isAbsolute(path)) {
                throw error("validation", operation, "vhd-path-invalid");
            }
            const envelope = await execute(executor, { schemaVersion: 1, operation, path }, options);
            return decodeSingleItem(operation, envelope, parseVirtualHardDisk);
        },
        async mountVHD(request: HyperVMountVHDRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Mount-VHD";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["path", "readOnly", "noDriveLetter"])) {
                throw error("validation", operation, "request-invalid");
            }
            const path = normalizeVhdMutationPath(operation, candidate.path);
            if (typeof candidate.readOnly !== "boolean" || typeof candidate.noDriveLetter !== "boolean") {
                throw error("validation", operation, "vhd-flags-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, path,
                readOnly: candidate.readOnly, noDriveLetter: candidate.noDriveLetter,
            }, options);
            expectNoItems(operation, envelope);
        },
        async dismountVHD(path, options) {
            const operation = "Dismount-VHD";
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, path: normalizeVhdMutationPath(operation, path),
            }, options);
            expectNoItems(operation, envelope);
        },
        async convertVHD(request: HyperVConvertVHDRequest, options?: HyperVVhdMutationCallOptions) {
            const operation = "Convert-VHD";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["sourcePath", "destinationPath", "vhdType"])) {
                throw error("validation", operation, "request-invalid");
            }
            const sourcePath = normalizeVhdMutationPath(operation, candidate.sourcePath);
            const destinationPath = normalizeVhdMutationPath(operation, candidate.destinationPath);
            if (resolve(sourcePath).toLowerCase() === resolve(destinationPath).toLowerCase()) {
                throw error("validation", operation, "vhd-path-conflict");
            }
            if (candidate.vhdType !== "Dynamic" && candidate.vhdType !== "Fixed") {
                throw error("validation", operation, "vhd-type-invalid");
            }
            const timeout = vhdMutationTimeout(operation, options);
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, sourcePath, destinationPath, vhdType: candidate.vhdType,
            }, options, timeout);
            expectNoItems(operation, envelope);
        },
        async resizeVHD(request: HyperVResizeVHDRequest, options?: HyperVVhdMutationCallOptions) {
            const operation = "Resize-VHD";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["path", "sizeBytes"])) {
                throw error("validation", operation, "request-invalid");
            }
            const path = normalizeVhdMutationPath(operation, candidate.path);
            if (!safeInteger(candidate.sizeBytes, 1)) throw error("validation", operation, "vhd-size-invalid");
            const timeout = vhdMutationTimeout(operation, options);
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, path, sizeBytes: candidate.sizeBytes,
            }, options, timeout);
            expectNoItems(operation, envelope);
        },
        async getVM(selector, options) {
            const operation = "Get-VM";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseVirtualMachine);
        },
        async getVMHardDiskDrives(selector, options) {
            const operation = "Get-VMHardDiskDrive";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseHardDiskDrive);
        },
        async getVMDvdDrives(selector, options) {
            const operation = "Get-VMDvdDrive";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseDvdDrive);
        },
        async removeVMDvdDrive(request: HyperVRemoveVMDvdDriveRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VMDvdDrive";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["selector", "expectedName", "expectedNotes", "path"])) {
                throw error("validation", operation, "request-invalid");
            }
            const selector = normalizeSelector(operation, request.selector);
            if (selector.kind !== "id") throw error("validation", operation, "selector-id-required");
            if (!boundedString(request.expectedName, false) || request.expectedName.length > MAX_NAME_LENGTH
                || !boundedString(request.expectedNotes, false) || request.expectedNotes.length > 4096) {
                throw error("validation", operation, "vm-identity-invalid");
            }
            if (!boundedString(request.path, false) || !(isAbsolute(request.path) || win32.isAbsolute(request.path))
                || /[\u0000-\u001f*?]/.test(request.path)) {
                throw error("validation", operation, "dvd-path-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1, operation, selector,
                expectedName: request.expectedName, expectedNotes: request.expectedNotes, path: request.path,
            }, options);
            expectNoItems(operation, envelope);
        },
        async startVM(request: HyperVStartVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Start-VM";
            const selector = normalizeSelector(operation, request?.selector);
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector,
                ...normalizePowerIdentity(operation, request, selector),
            }, options);
            expectNoItems(operation, envelope);
        },
        async stopVM(request: HyperVStopVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Stop-VM";
            if (!request || (request.mode !== "shutdown" && request.mode !== "turn-off")) {
                throw error("validation", operation, "mode-invalid");
            }
            if (request.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const selector = normalizeSelector(operation, request.selector);
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector,
                mode: request.mode,
                force: request.force ?? false,
                ...normalizePowerIdentity(operation, request, selector),
            }, options);
            expectNoItems(operation, envelope);
        },
        async restartVM(request: HyperVRestartVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Restart-VM";
            if (request?.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const selector = normalizeSelector(operation, request?.selector);
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector,
                force: request.force ?? false,
                ...normalizePowerIdentity(operation, request, selector),
            }, options);
            expectNoItems(operation, envelope);
        },
        async removeVM(request: HyperVRemoveVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VM";
            if (request?.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const selector = normalizeSelector(operation, request?.selector);
            if (request?.guard !== undefined && selector.kind !== "id") {
                throw error("validation", operation, "vm-remove-guard-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector,
                force: request.force ?? false,
                ...(request?.guard === undefined ? {} : { guard: normalizeRemoveGuard(operation, request.guard) }),
            }, options);
            expectNoItems(operation, envelope);
        },
        async removeHostFiles(request: HyperVRemoveHostFilesRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-HostFiles";
            const normalized = normalizeRemoveHostFiles(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...normalized }, options);
            const items = decodeItems<HyperVRemoveHostFilesResult>(operation, envelope, (value) => {
                const item = record(value);
                return item && hasExactKeys(item, ["removedCount"]) && safeInteger(item.removedCount)
                    ? { removedCount: item.removedCount } : null;
            });
            if (items.length !== 1) throw error("protocol", operation, "result-ambiguous");
            return items[0]!;
        },
        async getVMSnapshots(selector, options) {
            const operation = "Get-VMSnapshot";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseSnapshot);
        },
        async checkpointVM(request: HyperVCheckpointVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Checkpoint-VM";
            if (!request || !validNativeName(request.snapshotName)) {
                throw error("validation", operation, "snapshot-name-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                snapshotName: request.snapshotName,
            }, options);
            return decodeSingleItem(operation, envelope, parseSnapshot);
        },
        async removeVMSnapshot(request: HyperVRemoveSnapshotRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VMSnapshot";
            if (request?.includeDescendants !== undefined && typeof request.includeDescendants !== "boolean") {
                throw error("validation", operation, "include-descendants-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                snapshot: normalizeSnapshotSelector(operation, request.snapshot),
                includeDescendants: request.includeDescendants ?? false,
            }, options);
            expectNoItems(operation, envelope);
        },
        async restoreVMSnapshot(request: HyperVRestoreSnapshotRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Restore-VMSnapshot";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                snapshot: normalizeSnapshotSelector(operation, request?.snapshot),
            }, options);
            expectNoItems(operation, envelope);
        },
        async repairVMSnapshotState(request: HyperVRepairVMSnapshotStateRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Repair-VMSnapshotState";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["selector", "expectedName", "expectedNotes", "snapshotName", "expectedCheckpointPolicy"])) {
                throw error("validation", operation, "repair-request-invalid");
            }
            const selector = normalizeSelector(operation, request.selector);
            if (selector.kind !== "id") throw error("validation", operation, "selector-id-required");
            if (!validNativeName(request.expectedName)
                || !boundedString(request.expectedNotes, false)
                || request.expectedNotes.length > 4096
                || /[\u0000-\u001f]/.test(request.expectedNotes)) {
                throw error("validation", operation, "vm-identity-invalid");
            }
            if (typeof request.snapshotName !== "string" || request.snapshotName.length < 1
                || request.snapshotName.length > 256 || /[\u0000-\u001f*?\[\]]/.test(request.snapshotName)) {
                throw error("validation", operation, "snapshot-name-invalid");
            }
            if (request.expectedCheckpointPolicy !== "Production" && request.expectedCheckpointPolicy !== "ProductionOnly") {
                throw error("validation", operation, "snapshot-policy-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector,
                expectedName: request.expectedName,
                expectedNotes: request.expectedNotes,
                snapshotName: request.snapshotName,
                expectedCheckpointPolicy: request.expectedCheckpointPolicy,
            }, options);
            return decodeSingleItem(operation, envelope, (value): HyperVRepairVMSnapshotStateResult | null => {
                const item = record(value);
                return item && hasExactKeys(item, ["checkpointPolicy", "candidateCount"])
                    && (item.checkpointPolicy === "Production" || item.checkpointPolicy === "ProductionOnly")
                    && (item.candidateCount === 0 || item.candidateCount === 1)
                    ? { checkpointPolicy: item.checkpointPolicy, candidateCount: item.candidateCount } : null;
            });
        },
        async newVM(request: HyperVNewVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "New-VM";
            if (!request || !validNativeName(request.name)) throw error("validation", operation, "name-invalid");
            if (request.generation !== 1 && request.generation !== 2) {
                throw error("validation", operation, "generation-invalid");
            }
            if (!safeInteger(request.memoryStartupBytes, MINIMUM_MEMORY_BYTES)) {
                throw error("validation", operation, "memory-startup-bytes-invalid");
            }
            if (request.vhdPath !== undefined && !boundedString(request.vhdPath, false)) {
                throw error("validation", operation, "vhd-path-invalid");
            }
            if (request.switchName !== undefined && !validNativeName(request.switchName)) {
                throw error("validation", operation, "switch-name-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                name: request.name,
                generation: request.generation,
                memoryStartupBytes: request.memoryStartupBytes,
                ...(request.vhdPath === undefined ? {} : { vhdPath: request.vhdPath }),
                ...(request.switchName === undefined ? {} : { switchName: request.switchName }),
            }, options);
            // Decoded, not assumed: the id native assigns is what every following step selects
            // by, so reading it back from the creating call is what keeps the rest of creation
            // from having to re-find the VM by a name that is not unique until it exists.
            return decodeSingleItem(operation, envelope, parseVirtualMachine);
        },
        async setVM(request: HyperVSetVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VM";
            if (!request) throw error("validation", operation, "request-invalid");
            if (request.notes !== undefined && !boundedString(request.notes)) {
                throw error("validation", operation, "notes-invalid");
            }
            if (request.automaticCheckpointsEnabled !== undefined
                && typeof request.automaticCheckpointsEnabled !== "boolean") {
                throw error("validation", operation, "automatic-checkpoints-enabled-invalid");
            }
            if (request.checkpointType !== undefined
                && !["Disabled", "Production", "ProductionOnly", "Standard"].includes(request.checkpointType)) {
                throw error("validation", operation, "checkpoint-type-invalid");
            }
            // Native applies only the parameters it is given, so a request naming none of them
            // is a call that mutates nothing. Refusing it keeps a caller from reading success
            // as "the settings I meant were applied".
            if (request.notes === undefined
                && request.automaticCheckpointsEnabled === undefined
                && request.checkpointType === undefined) {
                throw error("validation", operation, "request-empty");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                ...(request.notes === undefined ? {} : { notes: request.notes }),
                ...(request.automaticCheckpointsEnabled === undefined
                    ? {}
                    : { automaticCheckpointsEnabled: request.automaticCheckpointsEnabled }),
                ...(request.checkpointType === undefined ? {} : { checkpointType: request.checkpointType }),
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMMemory(request: HyperVSetVMMemoryRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMMemory";
            if (!request || typeof request.dynamicMemoryEnabled !== "boolean") {
                throw error("validation", operation, "dynamic-memory-enabled-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                dynamicMemoryEnabled: request.dynamicMemoryEnabled,
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMProcessor(request: HyperVSetVMProcessorRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMProcessor";
            if (!request || !safeInteger(request.count, 1) || request.count > MAXIMUM_PROCESSOR_COUNT) {
                throw error("validation", operation, "count-invalid");
            }
            if (request.exposeVirtualizationExtensions !== undefined && typeof request.exposeVirtualizationExtensions !== "boolean") {
                throw error("validation", operation, "virtualization-extensions-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                count: request.count,
                ...(request.exposeVirtualizationExtensions !== undefined ? { exposeVirtualizationExtensions: request.exposeVirtualizationExtensions } : {}),
            }, options);
            expectNoItems(operation, envelope);
        },
        async getVMFirmware(selector: HyperVVirtualMachineSelector, options?: HyperVWindowsCallOptions) {
            const operation = "Get-VMFirmware";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeSingleItem(operation, envelope, parseVirtualMachineFirmware);
        },
        async getVMBios(selector: HyperVVirtualMachineSelector, options?: HyperVWindowsCallOptions) {
            const operation = "Get-VMBios";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeSingleItem(operation, envelope, parseVirtualMachineBios);
        },
        async setVMFirmware(request: HyperVSetVMFirmwareRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMFirmware";
            if (!request) throw error("validation", operation, "request-invalid");
            if (request.firstBootDiskPath !== undefined && !boundedString(request.firstBootDiskPath, false)) {
                throw error("validation", operation, "first-boot-disk-path-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                secureBoot: normalizeSecureBoot(operation, request.secureBoot),
                ...(request.firstBootDiskPath === undefined ? {} : { firstBootDiskPath: request.firstBootDiskPath }),
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMBios(request: HyperVSetVMBiosRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMBios";
            if (!request || !Array.isArray(request.startupOrder) || request.startupOrder.length === 0) {
                throw error("validation", operation, "startup-order-invalid");
            }
            for (const device of request.startupOrder) {
                if (!BIOS_STARTUP_DEVICES.includes(device)) {
                    throw error("validation", operation, "startup-order-device-invalid");
                }
            }
            // Native keeps the order given and ignores a repeat, so a duplicate means the
            // caller believes it asked for something the host will not do.
            if (new Set(request.startupOrder).size !== request.startupOrder.length) {
                throw error("validation", operation, "startup-order-duplicated");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                startupOrder: [...request.startupOrder],
            }, options);
            expectNoItems(operation, envelope);
        },
        async addVMNetworkAdapter(request: HyperVAddVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Add-VMNetworkAdapter";
            if (!request || !validNativeName(request.name)) throw error("validation", operation, "name-invalid");
            if (!validNativeName(request.switchName)) throw error("validation", operation, "switch-name-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                name: request.name,
                switchName: request.switchName,
            }, options);
            expectNoItems(operation, envelope);
        },
        async renameVMNetworkAdapter(request: HyperVRenameVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Rename-VMNetworkAdapter";
            if (!request || !validNativeName(request.newName)) throw error("validation", operation, "new-name-invalid");
            const adapter = normalizeAdapterTarget(operation, request.adapter);
            // A rename to the name it already has is not a rename. Native accepts it, but the
            // caller asking for it has confused two adapters or two states of one. Only
            // checkable when the target names one; `sole` does not know its own name yet.
            if (adapter.kind === "name" && adapter.name === request.newName) {
                throw error("validation", operation, "new-name-unchanged");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                adapter,
                newName: request.newName,
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMNetworkAdapter(request: HyperVSetVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMNetworkAdapter";
            if (!request) throw error("validation", operation, "request-invalid");
            const adapter = normalizeAdapterTarget(operation, request.adapter);
            // Canonicalised to bare uppercase hex, which is the only spelling native accepts
            // for -StaticMacAddress. The all-zero address is refused: native reports it for an
            // adapter with no address yet, so setting it would be asking for that state rather
            // than for an address.
            const macAddress = typeof request.staticMacAddress === "string"
                ? request.staticMacAddress.replace(/[:-]/g, "").toUpperCase()
                : "";
            if (!/^[0-9A-F]{12}$/.test(macAddress)) throw error("validation", operation, "static-mac-address-invalid");
            if (macAddress === "000000000000") throw error("validation", operation, "static-mac-address-unassigned");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                adapter,
                staticMacAddress: macAddress,
            }, options);
            expectNoItems(operation, envelope);
        },
    };
}
