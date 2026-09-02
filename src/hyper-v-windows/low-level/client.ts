import type {
    HyperVCheckpointVirtualMachineRequest,
    HyperVDvdDrive,
    HyperVHardDiskDrive,
    HyperVRemoveSnapshotRequest,
    HyperVRemoveVirtualMachineRequest,
    HyperVRestoreSnapshotRequest,
    HyperVSnapshotSelector,
    HyperVStartVirtualMachineRequest,
    HyperVStopVirtualMachineRequest,
    HyperVVirtualMachine,
    HyperVVirtualMachineSelector,
    HyperVVirtualMachineSnapshot,
    HyperVWindowsCallOptions,
    HyperVWindowsClient,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
    HyperVWindowsOperation,
} from "./contracts.js";
import { HyperVWindowsError } from "./errors.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MILLISECONDS = 120 * 1000;
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

function normalizeSelector(
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
    if (execution.outputLimitExceeded || Buffer.byteLength(execution.stdout, "utf8") > MAX_RESPONSE_BYTES) {
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
        if (!hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "errorCode"])
            || typeof envelope.errorCode !== "string"
            || !NATIVE_ERROR_CODE_PATTERN.test(envelope.errorCode)) {
            throw error("protocol", operation, "response-envelope-invalid");
        }
        throw error("native", operation, envelope.errorCode, execution.status ?? undefined);
    }
    if (!hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "items"]) || !Array.isArray(envelope.items)) {
        throw error("protocol", operation, "response-envelope-invalid");
    }
    if (execution.status !== 0) throw error("protocol", operation, "response-status-conflict");
    return envelope as SuccessEnvelope;
}

async function execute(
    executor: HyperVWindowsExecutor,
    request: HyperVWindowsExecutionRequest,
    options?: HyperVWindowsCallOptions,
): Promise<SuccessEnvelope> {
    if (options?.signal?.aborted) throw error("transport", request.operation, "cancelled");
    let execution: HyperVWindowsExecutionResult;
    try {
        execution = await executor.execute(request, {
            timeoutMilliseconds: EXECUTION_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: MAX_RESPONSE_BYTES,
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

export function createHyperVWindowsClient(executor: HyperVWindowsExecutor): HyperVWindowsClient {
    return {
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
        async startVM(request: HyperVStartVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Start-VM";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
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
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                mode: request.mode,
                force: request.force ?? false,
            }, options);
            expectNoItems(operation, envelope);
        },
        async removeVM(request: HyperVRemoveVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VM";
            if (request?.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                force: request.force ?? false,
            }, options);
            expectNoItems(operation, envelope);
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
    };
}
