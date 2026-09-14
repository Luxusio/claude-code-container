import type {
    HyperVWindowsCallOptions,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
    HyperVWindowsOperation,
} from "./contracts.js";
import { HyperVWindowsError } from "./errors.js";
import {
    parseHyperVInterfaceIndex,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVNetworkAdapterName,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualMachineName,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    parseIPv4Address,
    parseIPv4Cidr,
    parseIPv4PrefixLength,
    type HyperVCreateNetIPAddressRequest,
    type HyperVCreateNetNatRequest,
    type HyperVCreateVMSwitchRequest,
    type HyperVExactNameVirtualMachine,
    type HyperVExactNameVMInventoryRequest,
    type HyperVGetHostNetworkAdaptersRequest,
    type HyperVHostNetworkAdapter,
    type HyperVNatSelector,
    type HyperVNetIPAddress,
    type HyperVNetIPAddressSelector,
    type HyperVNetNat,
    type HyperVRemoveNetIPAddressRequest,
    type HyperVRemoveNetNatRequest,
    type HyperVRemoveVMSwitchRequest,
    type HyperVSetVMSwitchNotesRequest,
    type HyperVVirtualSwitch,
    type HyperVVirtualSwitchSelector,
    type HyperVVMNetworkAdapter,
    type HyperVWindowsNetworkClient,
    HyperVWindowsNetworkValueError,
} from "./network-contracts.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MILLISECONDS = 120 * 1000;
const MAX_NATIVE_STRING_LENGTH = 32 * 1024;
const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORWARDED_EXECUTOR_ERROR_CODES: ReadonlySet<string> = new Set([
    "hyper-v-network-elevation-cancelled",
    "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-handshake-timeout",
    "hyper-v-network-elevation-authentication-failed",
    "hyper-v-network-elevation-administrator-required",
    "hyper-v-network-elevation-deadline-exceeded",
    "hyper-v-network-elevation-protocol-invalid",
    "hyper-v-network-elevation-relay-failed",
    "hyper-v-network-elevation-request-failed",
    "hyper-v-network-elevation-termination-unconfirmed",
    "hyper-v-network-elevation-scope-closed",
]);

type SuccessEnvelope = {
    readonly schemaVersion: 1;
    readonly operation: HyperVWindowsOperation;
    readonly ok: true;
    readonly items: readonly unknown[];
};

function error(
    category: "validation" | "transport" | "protocol" | "native",
    operation: HyperVWindowsOperation,
    code: string,
    nativeStatus?: number,
): HyperVWindowsError {
    return new HyperVWindowsError({ category, operation, code, ...(nativeStatus === undefined ? {} : { nativeStatus }) });
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

function parsed<T>(factory: () => T): T | null {
    try {
        return factory();
    } catch (failure) {
        if (failure instanceof HyperVWindowsNetworkValueError) return null;
        throw failure;
    }
}

function decodeVirtualSwitch(value: unknown): HyperVVirtualSwitch | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["id", "name", "switchType", "notes"])) return null;
    if (!boundedString(item.switchType, false) || !boundedString(item.notes)) return null;
    const id = parsed(() => parseHyperVVirtualSwitchId(String(item.id)));
    const rawName = item.name;
    const name = typeof rawName === "string" ? parsed(() => parseHyperVVirtualSwitchName(rawName)) : null;
    if (!id || !name) return null;
    return { id, name, switchType: item.switchType, notes: item.notes };
}

function decodeVMNetworkAdapter(value: unknown): HyperVVMNetworkAdapter | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "vmId", "vmName", "name", "switchId", "switchName", "status", "managementOperatingSystem",
    ])) return null;
    const rawVmId = item.vmId;
    const vmId = rawVmId === null
        ? null
        : (typeof rawVmId === "string" ? parsed(() => parseHyperVVirtualMachineId(rawVmId)) : null);
    const rawSwitchId = item.switchId;
    const switchId = rawSwitchId === null || rawSwitchId === ""
        ? null
        : (typeof rawSwitchId === "string" ? parsed(() => parseHyperVVirtualSwitchId(rawSwitchId)) : null);
    const rawVmName = item.vmName;
    const rawSwitchName = item.switchName;
    if ((item.vmId !== null && !vmId)
        || (item.switchId !== null && item.switchId !== "" && !switchId)
        || (rawVmName !== null && !boundedString(rawVmName, false))
        || !boundedString(item.name, false)
        || (rawSwitchName !== null && !boundedString(rawSwitchName, false))
        || !boundedString(item.status)
        || typeof item.managementOperatingSystem !== "boolean") return null;
    return {
        vmId,
        vmName: typeof rawVmName === "string" ? rawVmName : null,
        name: item.name,
        switchId,
        switchName: typeof rawSwitchName === "string" ? rawSwitchName : null,
        status: item.status,
        managementOperatingSystem: item.managementOperatingSystem,
    };
}

function decodeExactNameVirtualMachine(value: unknown): HyperVExactNameVirtualMachine | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["id", "name", "notes"])) return null;
    const rawId = item.id;
    const id = typeof rawId === "string" ? parsed(() => parseHyperVVirtualMachineId(rawId)) : null;
    const rawName = item.name;
    const name = typeof rawName === "string" ? parsed(() => parseHyperVVirtualMachineName(rawName)) : null;
    if (!id || !name || !boundedString(item.notes)) return null;
    return { id, name, notes: item.notes };
}

function decodeHostNetworkAdapter(value: unknown): HyperVHostNetworkAdapter | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["interfaceIndex", "name", "status", "interfaceDescription"])) return null;
    const rawInterfaceIndex = item.interfaceIndex;
    const rawName = item.name;
    const interfaceIndex = typeof rawInterfaceIndex === "number"
        ? parsed(() => parseHyperVInterfaceIndex(rawInterfaceIndex))
        : null;
    const name = typeof rawName === "string" ? parsed(() => parseHyperVNetworkAdapterName(rawName)) : null;
    if (!interfaceIndex || !name || !boundedString(item.status) || !boundedString(item.interfaceDescription)) return null;
    return { interfaceIndex, name, status: item.status, interfaceDescription: item.interfaceDescription };
}

function decodeNetIPAddress(value: unknown): HyperVNetIPAddress | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "interfaceIndex", "address", "prefixLength", "prefixOrigin", "suffixOrigin", "addressState",
    ])) return null;
    const rawInterfaceIndex = item.interfaceIndex;
    const rawAddress = item.address;
    const rawPrefixLength = item.prefixLength;
    const interfaceIndex = typeof rawInterfaceIndex === "number"
        ? parsed(() => parseHyperVInterfaceIndex(rawInterfaceIndex))
        : null;
    const address = typeof rawAddress === "string" ? parsed(() => parseIPv4Address(rawAddress)) : null;
    const prefixLength = typeof rawPrefixLength === "number"
        ? parsed(() => parseIPv4PrefixLength(rawPrefixLength))
        : null;
    if (!interfaceIndex || !address || prefixLength === null
        || !boundedString(item.prefixOrigin)
        || !boundedString(item.suffixOrigin)
        || !boundedString(item.addressState)) return null;
    return {
        interfaceIndex,
        address,
        prefixLength,
        prefixOrigin: item.prefixOrigin,
        suffixOrigin: item.suffixOrigin,
        addressState: item.addressState,
    };
}

function decodeNetNat(value: unknown): HyperVNetNat | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["instanceId", "name", "internalAddressPrefix"])) return null;
    const rawInstanceId = item.instanceId;
    const rawName = item.name;
    const rawInternalAddressPrefix = item.internalAddressPrefix;
    const instanceId = typeof rawInstanceId === "string" ? parsed(() => parseHyperVNatInstanceId(rawInstanceId)) : null;
    const name = typeof rawName === "string" ? parsed(() => parseHyperVNatName(rawName)) : null;
    const cidr = typeof rawInternalAddressPrefix === "string"
        ? parsed(() => parseIPv4Cidr(rawInternalAddressPrefix))
        : null;
    if (!instanceId || !name || !cidr) return null;
    return { instanceId, name, internalAddressPrefix: cidr };
}

function decodeEnvelope(
    operation: HyperVWindowsOperation,
    execution: HyperVWindowsExecutionResult,
): SuccessEnvelope {
    if (execution.outputLimitExceeded || Buffer.byteLength(execution.stdout, "utf8") > MAX_RESPONSE_BYTES) {
        throw error("protocol", operation, "response-too-large");
    }
    let parsedEnvelope: unknown;
    try {
        parsedEnvelope = JSON.parse(execution.stdout.trim());
    } catch {
        throw error("protocol", operation, "response-malformed");
    }
    const envelope = record(parsedEnvelope);
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
    return {
        schemaVersion: 1,
        operation,
        ok: true,
        items: envelope.items,
    };
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
    if (execution.error || execution.status === null) {
        const code = execution.error && FORWARDED_EXECUTOR_ERROR_CODES.has(execution.error)
            ? execution.error
            : "executor-failed";
        throw error("transport", request.operation, code);
    }
    return decodeEnvelope(request.operation, execution);
}

function decodeItems<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    maximumCount: number,
    decoder: (value: unknown) => T | null,
): readonly T[] {
    if (envelope.items.length > maximumCount) throw error("protocol", operation, "result-count-exceeded");
    const decoded: T[] = [];
    for (const item of envelope.items) {
        const value = decoder(item);
        if (value === null) throw error("protocol", operation, "result-shape-invalid");
        decoded.push(value);
    }
    return decoded;
}

function decodeSingle<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    decoder: (value: unknown) => T | null,
): T {
    if (envelope.items.length !== 1) throw error("protocol", operation, "result-ambiguous");
    const decoded = decoder(envelope.items[0]);
    if (decoded === null) throw error("protocol", operation, "result-shape-invalid");
    return decoded;
}

function expectNoItems(operation: HyperVWindowsOperation, envelope: SuccessEnvelope): void {
    if (envelope.items.length !== 0) throw error("protocol", operation, "result-ambiguous");
}

function validateNotes(operation: HyperVWindowsOperation, notes: unknown): string {
    if (!boundedString(notes)) throw error("validation", operation, "notes-invalid");
    return notes;
}

function normalizeSwitchSelector(
    operation: "Get-VMSwitch",
    selector: HyperVVirtualSwitchSelector,
): HyperVVirtualSwitchSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "selector-invalid");
    if (candidate.kind === "all" && hasExactKeys(candidate, ["kind"])) return { kind: "all" };
    if (candidate.kind === "id" && hasExactKeys(candidate, ["kind", "id"]) && typeof candidate.id === "string") {
        const rawId = candidate.id;
        const id = parsed(() => parseHyperVVirtualSwitchId(rawId));
        if (id) return { kind: "id", id };
    }
    if (candidate.kind === "name" && hasExactKeys(candidate, ["kind", "name"]) && typeof candidate.name === "string") {
        const rawName = candidate.name;
        const name = parsed(() => parseHyperVVirtualSwitchName(rawName));
        if (name) return { kind: "name", name };
    }
    throw error("validation", operation, "selector-invalid");
}

function normalizeNatSelector(operation: "Get-NetNat", selector: HyperVNatSelector): HyperVNatSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "selector-invalid");
    if (candidate.kind === "all" && hasExactKeys(candidate, ["kind"])) return { kind: "all" };
    if (candidate.kind === "instance-id"
        && hasExactKeys(candidate, ["kind", "instanceId"])
        && typeof candidate.instanceId === "string") {
        const rawInstanceId = candidate.instanceId;
        const instanceId = parsed(() => parseHyperVNatInstanceId(rawInstanceId));
        if (instanceId) return { kind: "instance-id", instanceId };
    }
    if (candidate.kind === "name" && hasExactKeys(candidate, ["kind", "name"]) && typeof candidate.name === "string") {
        const rawName = candidate.name;
        const name = parsed(() => parseHyperVNatName(rawName));
        if (name) return { kind: "name", name };
    }
    throw error("validation", operation, "selector-invalid");
}

function normalizeIPAddressSelector(
    operation: "Get-NetIPAddress",
    selector: HyperVNetIPAddressSelector,
): HyperVNetIPAddressSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "selector-invalid");
    if (candidate.kind === "all-ipv4" && hasExactKeys(candidate, ["kind"])) return { kind: "all-ipv4" };
    if (candidate.kind === "interface"
        && hasExactKeys(candidate, ["kind", "interfaceIndex"])
        && typeof candidate.interfaceIndex === "number") {
        const rawInterfaceIndex = candidate.interfaceIndex;
        const interfaceIndex = parsed(() => parseHyperVInterfaceIndex(rawInterfaceIndex));
        if (interfaceIndex) return { kind: "interface", interfaceIndex };
    }
    throw error("validation", operation, "selector-invalid");
}

function normalizeSwitchIdentity(
    operation: "Set-VMSwitch" | "Remove-VMSwitch",
    input: unknown,
): HyperVRemoveVMSwitchRequest["identity"] {
    const identity = record(input);
    if (!identity || !hasExactKeys(identity, ["id", "name"]) || typeof identity.id !== "string" || typeof identity.name !== "string") {
        throw error("validation", operation, "identity-invalid");
    }
    const rawId = identity.id;
    const rawName = identity.name;
    const id = parsed(() => parseHyperVVirtualSwitchId(rawId));
    const name = parsed(() => parseHyperVVirtualSwitchName(rawName));
    if (!id || !name) throw error("validation", operation, "identity-invalid");
    return { id, name };
}

function normalizeAddressRequest(
    operation: "New-NetIPAddress" | "Remove-NetIPAddress",
    request: HyperVCreateNetIPAddressRequest | HyperVRemoveNetIPAddressRequest,
): HyperVCreateNetIPAddressRequest {
    const candidate = record(request);
    if (!candidate || !hasExactKeys(candidate, ["interfaceIndex", "address", "prefixLength"])
        || typeof candidate.interfaceIndex !== "number"
        || typeof candidate.address !== "string"
        || typeof candidate.prefixLength !== "number") {
        throw error("validation", operation, "request-invalid");
    }
    const rawInterfaceIndex = candidate.interfaceIndex;
    const rawAddress = candidate.address;
    const rawPrefixLength = candidate.prefixLength;
    const interfaceIndex = parsed(() => parseHyperVInterfaceIndex(rawInterfaceIndex));
    const address = parsed(() => parseIPv4Address(rawAddress));
    const prefixLength = parsed(() => parseIPv4PrefixLength(rawPrefixLength));
    if (!interfaceIndex || !address || prefixLength === null) throw error("validation", operation, "request-invalid");
    return { interfaceIndex, address, prefixLength };
}

export function createHyperVWindowsNetworkClient(executor: HyperVWindowsExecutor): HyperVWindowsNetworkClient {
    return {
        async getVMSwitches(selector, options) {
            const operation = "Get-VMSwitch";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSwitchSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, 256, decodeVirtualSwitch);
        },
        async createVMSwitch(request: HyperVCreateVMSwitchRequest, options?: HyperVWindowsCallOptions) {
            const operation = "New-VMSwitch";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["name", "notes"])
                || typeof candidate.name !== "string") throw error("validation", operation, "request-invalid");
            const rawName = candidate.name;
            const name = parsed(() => parseHyperVVirtualSwitchName(rawName));
            if (!name) throw error("validation", operation, "request-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                name,
                notes: validateNotes(operation, candidate.notes),
            }, options);
            return decodeSingle(operation, envelope, decodeVirtualSwitch);
        },
        async setVMSwitchNotes(request: HyperVSetVMSwitchNotesRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMSwitch";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["identity", "notes"])) {
                throw error("validation", operation, "request-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                identity: normalizeSwitchIdentity(operation, candidate.identity),
                notes: validateNotes(operation, candidate.notes),
            }, options);
            expectNoItems(operation, envelope);
        },
        async removeVMSwitch(request: HyperVRemoveVMSwitchRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VMSwitch";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["identity"])) throw error("validation", operation, "request-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                identity: normalizeSwitchIdentity(operation, candidate.identity),
            }, options);
            expectNoItems(operation, envelope);
        },
        async getAllVMNetworkAdapters(options) {
            const operation = "Get-VMNetworkAdapter";
            const envelope = await execute(executor, { schemaVersion: 1, operation }, options);
            return decodeItems(operation, envelope, 4096, decodeVMNetworkAdapter);
        },
        async getVMsByExactNames(request: HyperVExactNameVMInventoryRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Get-VM";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["names"]) || !Array.isArray(candidate.names)
                || candidate.names.length === 0 || candidate.names.length > 32) {
                throw error("validation", operation, "inventory-names-invalid");
            }
            const names = candidate.names.map((value) => typeof value === "string"
                ? parsed(() => parseHyperVVirtualMachineName(value))
                : null);
            if (names.some((name) => name === null)) throw error("validation", operation, "inventory-names-invalid");
            const normalizedNames = names.filter((name) => name !== null);
            if (new Set(normalizedNames).size !== normalizedNames.length) {
                throw error("validation", operation, "inventory-names-duplicate");
            }
            const envelope = await execute(executor, { schemaVersion: 1, operation, names: normalizedNames }, options);
            const items = decodeItems(operation, envelope, 32, decodeExactNameVirtualMachine);
            const requestedNames = new Set(normalizedNames);
            const observedNames = new Set<string>();
            for (const item of items) {
                if (!requestedNames.has(item.name)) throw error("protocol", operation, "inventory-result-unrequested");
                if (observedNames.has(item.name)) throw error("protocol", operation, "inventory-result-duplicate");
                observedNames.add(item.name);
            }
            return items;
        },
        async getHostNetworkAdapters(request: HyperVGetHostNetworkAdaptersRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Get-NetAdapter";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["name"]) || typeof candidate.name !== "string") {
                throw error("validation", operation, "request-invalid");
            }
            const rawName = candidate.name;
            const name = parsed(() => parseHyperVNetworkAdapterName(rawName));
            if (!name) throw error("validation", operation, "request-invalid");
            const envelope = await execute(executor, { schemaVersion: 1, operation, name }, options);
            return decodeItems(operation, envelope, 256, decodeHostNetworkAdapter);
        },
        async getNetIPAddresses(selector, options) {
            const operation = "Get-NetIPAddress";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeIPAddressSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, 4096, decodeNetIPAddress);
        },
        async createNetIPAddress(request, options) {
            const operation = "New-NetIPAddress";
            const normalized = normalizeAddressRequest(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...normalized }, options);
            return decodeSingle(operation, envelope, decodeNetIPAddress);
        },
        async removeNetIPAddress(request, options) {
            const operation = "Remove-NetIPAddress";
            const normalized = normalizeAddressRequest(operation, request);
            const envelope = await execute(executor, { schemaVersion: 1, operation, ...normalized }, options);
            expectNoItems(operation, envelope);
        },
        async getNetNats(selector, options) {
            const operation = "Get-NetNat";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeNatSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, 256, decodeNetNat);
        },
        async createNetNat(request: HyperVCreateNetNatRequest, options?: HyperVWindowsCallOptions) {
            const operation = "New-NetNat";
            const candidate = record(request);
            if (!candidate || !hasExactKeys(candidate, ["name", "internalAddressPrefix"])
                || typeof candidate.name !== "string" || typeof candidate.internalAddressPrefix !== "string") {
                throw error("validation", operation, "request-invalid");
            }
            const rawName = candidate.name;
            const rawInternalAddressPrefix = candidate.internalAddressPrefix;
            const name = parsed(() => parseHyperVNatName(rawName));
            const internalAddressPrefix = parsed(() => parseIPv4Cidr(rawInternalAddressPrefix));
            if (!name || !internalAddressPrefix) throw error("validation", operation, "request-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                name,
                internalAddressPrefix,
            }, options);
            return decodeSingle(operation, envelope, decodeNetNat);
        },
        async removeNetNat(request: HyperVRemoveNetNatRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-NetNat";
            const candidate = record(request);
            const identity = candidate ? record(candidate.identity) : null;
            if (!candidate || !hasExactKeys(candidate, ["identity"])
                || !identity || !hasExactKeys(identity, ["instanceId", "name"])
                || typeof identity.instanceId !== "string" || typeof identity.name !== "string") {
                throw error("validation", operation, "identity-invalid");
            }
            const rawInstanceId = identity.instanceId;
            const rawName = identity.name;
            const instanceId = parsed(() => parseHyperVNatInstanceId(rawInstanceId));
            const name = parsed(() => parseHyperVNatName(rawName));
            if (!instanceId || !name) throw error("validation", operation, "identity-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                identity: { instanceId, name },
            }, options);
            expectNoItems(operation, envelope);
        },
    };
}
