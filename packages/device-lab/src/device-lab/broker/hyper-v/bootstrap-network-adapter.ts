import type { HyperVWindowsNetworkClient } from "@ccc/hyper-v/low-level/index.js";
import { HyperVOperationDeadlineError } from "./deadline.js";
import type { DeviceLabHyperVCommandResult, DeviceLabHyperVWindowsClientOptions } from "./lifecycle-adapter.js";
import { createDeviceLabHyperVWindowsNetworkClient } from "./network-adapter.js";
import {
    discoverDeviceLabHyperVBootstrapNetwork,
    teardownDeviceLabHyperVBootstrapNetwork,
    type DeviceLabHyperVBootstrapCleanupObservation,
    type DeviceLabHyperVBootstrapNetworkObservation,
    type DeviceLabHyperVOwnedVm,
    type DeviceLabHyperVVmNetworkClient,
} from "./vm-network-adapter.js";

type BootstrapExecution = DeviceLabHyperVCommandResult & {
    readonly mode: "exec";
    readonly provider: "hyper-v";
};

function bootstrapNetworkClient(options: DeviceLabHyperVWindowsClientOptions): DeviceLabHyperVVmNetworkClient {
    if (!options.executable) throw new Error("hyper-v-provider-executable-missing");
    const invoke = async <Result>(operation: (client: HyperVWindowsNetworkClient) => Promise<Result>): Promise<Result> => {
        // Discovery fans out reads. Each primitive must restore only its own local refusal,
        // so a sibling's expired allowance cannot replace the rejection selected by Promise.all.
        let callbackRefusal: HyperVOperationDeadlineError | undefined;
        const client = createDeviceLabHyperVWindowsNetworkClient({
            ...options,
            timeoutMilliseconds: () => {
                try {
                    return typeof options.timeoutMilliseconds === "function"
                        ? options.timeoutMilliseconds() : options.timeoutMilliseconds;
                } catch (error) {
                    if (error instanceof HyperVOperationDeadlineError) callbackRefusal = error;
                    throw error;
                }
            },
        });
        try {
            return await operation(client);
        } catch (error) {
            // The typed client normalizes executor throws. Native and runner failures retain
            // that normalization; only the actual timeout callback can supply this exception.
            throw callbackRefusal ?? error;
        }
    };
    return {
        getVMsByExactNames: (request, callOptions) => invoke((client) => client.getVMsByExactNames(request, callOptions)),
        getVMNetworkAdapters: (request, callOptions) => invoke((client) => client.getVMNetworkAdapters(request, callOptions)),
        getManagementNetworkAdapters: (request, callOptions) => invoke((client) => client.getManagementNetworkAdapters(request, callOptions)),
        getNetIPAddresses: (request, callOptions) => invoke((client) => client.getNetIPAddresses(request, callOptions)),
        getNetNeighbors: (request, callOptions) => invoke((client) => client.getNetNeighbors(request, callOptions)),
        getAllVMNetworkAdapters: (callOptions) => invoke((client) => client.getAllVMNetworkAdapters(callOptions)),
        removeVMNetworkAdapter: (request, callOptions) => invoke((client) => client.removeVMNetworkAdapter(request, callOptions)),
    };
}

/** A completed native failure remains an observation; a local refusal supplies no new observation. */
export async function probeDeviceLabHyperVBootstrapNetwork(
    options: DeviceLabHyperVWindowsClientOptions,
    vm: DeviceLabHyperVOwnedVm,
): Promise<{ execution: BootstrapExecution; observation: DeviceLabHyperVBootstrapNetworkObservation | null }> {
    try {
        const observation = await discoverDeviceLabHyperVBootstrapNetwork(bootstrapNetworkClient(options), vm);
        return { execution: { mode: "exec", provider: "hyper-v", status: 0 }, observation };
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        const code = error instanceof Error ? error.message : String(error);
        return { execution: { mode: "exec", provider: "hyper-v", status: 1, error: code }, observation: null };
    }
}

/** No success is reported until adapter removal and host-wide containment have both completed. */
export async function cleanupDeviceLabHyperVBootstrapNetwork(
    options: DeviceLabHyperVWindowsClientOptions,
    vm: DeviceLabHyperVOwnedVm,
    managedMacAddress: string,
): Promise<{ execution: BootstrapExecution; observation: DeviceLabHyperVBootstrapCleanupObservation | null }> {
    try {
        const observation = await teardownDeviceLabHyperVBootstrapNetwork(bootstrapNetworkClient(options), vm, managedMacAddress);
        return { execution: { mode: "exec", provider: "hyper-v", status: 0 }, observation };
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        const code = error instanceof Error ? error.message : String(error);
        return { execution: { mode: "exec", provider: "hyper-v", status: 1, error: code }, observation: null };
    }
}
