import { cpus, freemem, totalmem } from "os";

import { HyperVWindowsError, type HyperVWindowsExecutor } from "@ccc/hyper-v/index.js";
import type { HyperVVmObservation } from "../../../host-control/hyper-v/index.js";
import { createDeviceLabHyperVWindowsClient, type DeviceLabHyperVCommandRunner } from "./lifecycle-adapter.js";

type HostCapacity = {
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
    readonly logicalProcessors: number;
};

export type DeviceLabHyperVPowerOptions = {
    readonly executable: string;
    readonly run: DeviceLabHyperVCommandRunner;
    readonly timeoutMilliseconds: () => number;
    readonly now?: () => number;
    readonly session?: HyperVWindowsExecutor;
    readonly vmId: string;
    readonly vmName: string;
    readonly expectedNotes: string;
    readonly operation: "start" | "stop" | "reboot";
    readonly force?: boolean;
    readonly startIfStopped?: boolean;
    readonly memoryMb?: number;
    readonly cpus?: number;
    readonly readHostCapacity?: () => HostCapacity;
};

export type HyperVMemoryCapacity = {
    readonly requestedMb: number;
    readonly availableMb: number;
    readonly reserveMb: number;
    readonly shortfallMb: number;
};

export type DeviceLabHyperVPowerResult =
    | { readonly ok: true; readonly observation: HyperVVmObservation }
    | { readonly ok: false; readonly code: string; readonly capacity?: HyperVMemoryCapacity };

function failure(code: string): DeviceLabHyperVPowerResult {
    return { ok: false, code };
}

function remaining(options: DeviceLabHyperVPowerOptions): boolean {
    try {
        const milliseconds = options.timeoutMilliseconds();
        return Number.isFinite(milliseconds) && milliseconds >= 1;
    } catch {
        return false;
    }
}

function errorCode(cause: unknown, options: DeviceLabHyperVPowerOptions, fallback: string): string {
    if (!remaining(options) || cause instanceof HyperVWindowsError
        && cause.category === "transport" && cause.code === "timeout") {
        return "hyper-v-lifecycle-timeout";
    }
    if (cause instanceof HyperVWindowsError && cause.category === "native"
        && cause.code === "vm-identity-mismatch") {
        return "hyper-v-vm-ownership-mismatch";
    }
    return fallback;
}

/** The legacy start admission check, using current available memory. */
export function hyperVStartCapacityRefusal(
    memoryMb: number,
    requestedCpus: number,
    host: HostCapacity,
): string | null {
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 1024 || memoryMb > 131072
        || !Number.isSafeInteger(requestedCpus) || requestedCpus < 1 || requestedCpus > 64
        || !Number.isSafeInteger(host.totalMemoryBytes) || host.totalMemoryBytes < 0
        || !Number.isSafeInteger(host.freeMemoryBytes) || host.freeMemoryBytes < 0
        || !Number.isSafeInteger(host.logicalProcessors) || host.logicalProcessors < 1) {
        return "hyper-v-host-capacity-inspection-failed";
    }
    const totalMemoryMb = Math.floor(host.totalMemoryBytes / (1024 * 1024));
    const freeMemoryMb = Math.floor(host.freeMemoryBytes / (1024 * 1024));
    const reserveMb = Math.max(2048, Math.floor(totalMemoryMb * 0.1));
    if (memoryMb > freeMemoryMb - reserveMb) return "hyper-v-host-memory-capacity-exceeded";
    if (requestedCpus > host.logicalProcessors * 2) return "hyper-v-host-cpu-capacity-exceeded";
    return null;
}

/** One owner-fenced VM power transaction, with one caller-owned deadline. */
export async function executeDeviceLabHyperVPower(
    options: DeviceLabHyperVPowerOptions,
): Promise<DeviceLabHyperVPowerResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.vmId)
        || !options.vmName || !options.expectedNotes.startsWith("ccc-device-lab:")
        || options.expectedNotes.length > 256 || /[\u0000-\u001f]/.test(options.expectedNotes)) {
        return failure("hyper-v-vm-ownership-mismatch");
    }
    let client;
    try {
        client = createDeviceLabHyperVWindowsClient({
            executable: options.executable,
            run: options.run,
            timeoutMilliseconds: options.timeoutMilliseconds,
            ...(options.session ? { session: options.session } : {}),
            ...(options.now ? { now: options.now } : {}),
        });
    } catch (cause) {
        return failure(errorCode(cause, options, "hyper-v-lifecycle-vm-lookup-command-failed"));
    }
    const selector = { kind: "id" as const, id: options.vmId };
    const expectedId = options.vmId.toLowerCase();
    const owned = (machines: Awaited<ReturnType<typeof client.getVM>>) =>
        machines.length === 1 && machines[0].id === expectedId
        && machines[0].name === options.vmName && machines[0].notes === options.expectedNotes;
    let machines;
    try {
        if (!remaining(options)) return failure("hyper-v-lifecycle-timeout");
        machines = await client.getVM(selector);
    } catch (cause) {
        return failure(errorCode(cause, options, "hyper-v-lifecycle-vm-lookup-command-failed"));
    }
    if (!owned(machines)) return failure("hyper-v-vm-ownership-mismatch");

    const current = machines[0];
    const expectation = { selector, expectedName: options.vmName, expectedNotes: options.expectedNotes };
    if (options.operation === "start" && current.state !== "Running") {
        let host: HostCapacity;
        try {
            host = options.readHostCapacity?.() ?? {
                totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), logicalProcessors: cpus().length,
            };
        } catch {
            return failure("hyper-v-host-capacity-inspection-failed");
        }
        const refusal = hyperVStartCapacityRefusal(options.memoryMb ?? 4096, options.cpus ?? 2, host);
        if (refusal === "hyper-v-host-memory-capacity-exceeded") {
            const requestedMb = options.memoryMb ?? 4096;
            const availableMb = Math.floor(host.freeMemoryBytes / (1024 * 1024));
            const reserveMb = Math.max(2048, Math.floor(Math.floor(host.totalMemoryBytes / (1024 * 1024)) * 0.1));
            return { ok: false, code: refusal, capacity: {
                requestedMb, availableMb, reserveMb, shortfallMb: requestedMb + reserveMb - availableMb,
            } };
        }
        if (refusal) return failure(refusal);
    }
    if (options.operation === "reboot" && current.state === "Off" && options.startIfStopped !== true) {
        return failure("hyper-v-reboot-requires-running-vm");
    }
    if (options.operation === "reboot" && current.state !== "Off" && current.state !== "Running") {
        return failure("hyper-v-reboot-invalid-state");
    }

    const mutation = options.operation === "start" && current.state !== "Running"
        ? () => client.startVM(expectation)
        : options.operation === "stop" && current.state !== "Off"
        ? () => client.stopVM({ ...expectation, mode: options.force ? "turn-off" as const : "shutdown" as const, force: true })
        : options.operation === "reboot" && current.state === "Off"
        ? () => client.startVM(expectation)
        : options.operation === "reboot" && current.state === "Running"
        ? () => client.restartVM({ ...expectation, force: options.force === true })
        : null;
    if (mutation) {
        try {
            if (!remaining(options)) return failure("hyper-v-lifecycle-timeout");
            await mutation();
        } catch (cause) {
            const fallback = options.operation === "reboot"
                ? current.state === "Off" ? "hyper-v-reboot-start-failed" : "hyper-v-reboot-command-failed"
                : options.operation === "start" ? "hyper-v-start-command-failed" : "hyper-v-stop-command-failed";
            return failure(errorCode(cause, options, fallback));
        }
    }

    let finalMachines;
    try {
        if (!remaining(options)) return failure("hyper-v-lifecycle-timeout");
        finalMachines = await client.getVM(selector);
    } catch (cause) {
        return failure(errorCode(cause, options, "hyper-v-lifecycle-vm-lookup-command-failed"));
    }
    if (!remaining(options)) return failure("hyper-v-lifecycle-timeout");
    if (!owned(finalMachines)) return failure("hyper-v-vm-ownership-mismatch");
    const finalVm = finalMachines[0];
    return { ok: true, observation: {
        ok: true, vmId: expectedId, vmName: options.vmName,
        state: finalVm.state, status: finalVm.status,
        uptimeMs: finalVm.uptimeMilliseconds,
    } };
}
