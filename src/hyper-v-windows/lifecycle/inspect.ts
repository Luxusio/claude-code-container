import type {
    HyperVVirtualMachineSelector,
    HyperVWindowsCallOptions,
    HyperVWindowsClient,
} from "../low-level/index.js";
import type { HyperVVirtualMachineInspection } from "./contracts.js";

export async function inspectHyperVVirtualMachine(
    client: HyperVWindowsClient,
    selector: HyperVVirtualMachineSelector,
    options?: HyperVWindowsCallOptions,
): Promise<HyperVVirtualMachineInspection> {
    const virtualMachines = await client.getVM(selector, options);
    if (virtualMachines.length !== 1) {
        return { virtualMachines, hardDiskDrives: [], dvdDrives: [] };
    }

    const selected = { kind: "id", id: virtualMachines[0].id } as const;
    const [hardDiskDrives, dvdDrives] = await Promise.all([
        client.getVMHardDiskDrives(selected, options),
        client.getVMDvdDrives(selected, options),
    ]);
    return { virtualMachines, hardDiskDrives, dvdDrives };
}
