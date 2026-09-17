import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP } from "../../hyper-v-windows/index.js";
import { existsSync, readFileSync } from "fs";

type ProviderCommand = { readonly args?: readonly string[]; readonly input?: string };

type OperationRequest = {
    readonly schemaVersion: 1;
    readonly operation: string;
    readonly names?: readonly string[];
    readonly name?: string;
    readonly notes?: string;
    readonly identity?: { readonly id?: string; readonly instanceId?: string; readonly name?: string };
    readonly interfaceIndex?: number;
    readonly address?: string;
    readonly prefixLength?: number;
    readonly internalAddressPrefix?: string;
};

type NativeItem = Record<string, unknown>;

export type TypedHyperVNetworkSimulationOptions = {
    readonly stateFile?: string;
    readonly natInstanceIdOverride?: string;
    readonly beforeOperation?: (request: OperationRequest) => Record<string, unknown> | null;
    readonly onOperation?: (request: OperationRequest) => void;
};

const configuredRunners = new WeakMap<object, TypedHyperVNetworkSimulationOptions>();

export function configureTypedHyperVNetworkOperations<Runner extends object>(
    runner: Runner,
    options: TypedHyperVNetworkSimulationOptions,
): Runner {
    configuredRunners.set(runner, options);
    return runner;
}

function requestOf(command: ProviderCommand): OperationRequest | null {
    if (command.args?.at(-1) !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP || !command.input) return null;
    const envelope = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { input?: unknown };
    if (typeof envelope.input !== "string") return null;
    return JSON.parse(envelope.input) as OperationRequest;
}

function success(operation: string, items: readonly NativeItem[] = []) {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
        stderr: "",
    };
}

export function createTypedHyperVNetworkOperationSimulator(options: TypedHyperVNetworkSimulationOptions = {}) {
    const switches: NativeItem[] = [];
    const addresses: NativeItem[] = [];
    const nats: NativeItem[] = [];
    const virtualMachines: NativeItem[] = [];
    let nextSwitchId = 1;
    let nextNatId = 1;
    if (options.stateFile && existsSync(options.stateFile)) {
        const state = JSON.parse(readFileSync(options.stateFile, "utf8")) as Record<string, unknown>;
        if (typeof state.switchId === "string" && typeof state.switchName === "string") {
            switches.push({
                id: state.switchId,
                name: state.switchName,
                switchType: "Internal",
                notes: typeof state.marker === "string" ? state.marker : "ccc-device-lab:hyper-v-network:v1",
            });
            addresses.push({
                interfaceIndex: 42,
                address: typeof state.gateway === "string" ? state.gateway : "172.29.0.1",
                prefixLength: 24,
                prefixOrigin: "Manual",
                suffixOrigin: "Manual",
                addressState: "Preferred",
                interfaceAlias: `vEthernet (${state.switchName})`,
            });
        }
        if (typeof state.natInstanceId === "string" && typeof state.natName === "string") {
            nats.push({
                instanceId: options.natInstanceIdOverride ?? state.natInstanceId,
                name: state.natName,
                internalAddressPrefix: typeof state.prefix === "string" ? state.prefix : "172.29.0.0/24",
            });
        }
        if (Array.isArray(state.allocations)) {
            for (const candidate of state.allocations) {
                if (!candidate || typeof candidate !== "object") continue;
                const allocation = candidate as Record<string, unknown>;
                if (typeof allocation.ownerId !== "string" || typeof allocation.deviceId !== "string"
                    || typeof allocation.incarnationId !== "string") continue;
                virtualMachines.push({
                    id: "12345678-1234-1234-1234-123456789abc",
                    name: `ccc-${allocation.ownerId}-${allocation.deviceId}-${allocation.incarnationId}`,
                    notes: `ccc-device-lab:${allocation.ownerId}:${allocation.deviceId}:${allocation.incarnationId}`,
                });
            }
        }
    }

    return (command: ProviderCommand) => {
        const request = requestOf(command);
        if (!request) return null;
        options.onOperation?.(request);
        const intercepted = options.beforeOperation?.(request);
        if (intercepted) return intercepted;
        switch (request.operation) {
            case "Get-VMSwitch": return success(request.operation, switches);
            case "New-VMSwitch": {
                const item = {
                    id: `00000000-0000-0000-0000-${String(nextSwitchId++).padStart(12, "0")}`,
                    name: request.name,
                    switchType: "Internal",
                    notes: request.notes,
                };
                switches.push(item);
                return success(request.operation, [item]);
            }
            case "Set-VMSwitch": {
                const found = switches.find((item) => item.id === request.identity?.id);
                if (found) found.notes = request.notes;
                return success(request.operation);
            }
            case "Remove-VMSwitch": {
                const index = switches.findIndex((item) => item.id === request.identity?.id);
                if (index >= 0) switches.splice(index, 1);
                return success(request.operation);
            }
            case "Get-VMNetworkAdapter": return success(request.operation);
            case "Get-VM": return request.names ? success(
                request.operation,
                virtualMachines.filter((item) => request.names?.includes(String(item.name))),
            ) : null;
            case "Get-NetAdapter": return success(request.operation, switches.length === 0 ? [] : [{
                interfaceIndex: 42,
                name: `vEthernet (${String(switches[0]?.name)})`,
                status: "Up",
                interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
            }]);
            case "Get-NetIPAddress": return success(request.operation, addresses);
            case "New-NetIPAddress": {
                const item = {
                    interfaceIndex: request.interfaceIndex,
                    address: request.address,
                    prefixLength: request.prefixLength,
                    prefixOrigin: "Manual",
                    suffixOrigin: "Manual",
                    addressState: "Preferred",
                    interfaceAlias: `vEthernet (${String(switches[0]?.name ?? "")})`,
                };
                addresses.push(item);
                return success(request.operation, [item]);
            }
            case "Remove-NetIPAddress": {
                const index = addresses.findIndex((item) => item.interfaceIndex === request.interfaceIndex
                    && item.address === request.address && item.prefixLength === request.prefixLength);
                if (index >= 0) addresses.splice(index, 1);
                return success(request.operation);
            }
            case "Get-NetNat": return success(request.operation, nats);
            case "New-NetNat": {
                const item = {
                    instanceId: `ccc-test-nat-${nextNatId++}`,
                    name: request.name,
                    internalAddressPrefix: request.internalAddressPrefix,
                };
                nats.push(item);
                return success(request.operation, [item]);
            }
            case "Remove-NetNat": {
                const index = nats.findIndex((item) => item.instanceId === request.identity?.instanceId);
                if (index >= 0) nats.splice(index, 1);
                return success(request.operation);
            }
            default: return null;
        }
    };
}

export function withTypedHyperVNetworkOperations<Command extends ProviderCommand, Options, Result>(
    runner: (command: Command, options: Options) => Result,
    options: TypedHyperVNetworkSimulationOptions = {},
): (command: Command, options: Options) => Result {
    const simulate = createTypedHyperVNetworkOperationSimulator({
        ...options,
        ...(configuredRunners.get(runner) ?? {}),
    });
    return (command, options) => (simulate(command) as Result | null) ?? runner(command, options);
}
