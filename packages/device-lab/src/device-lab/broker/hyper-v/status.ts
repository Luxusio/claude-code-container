import { isAbsolute, win32 } from "path";

import { HyperVWindowsError, type HyperVWindowsExecutor } from "@ccc/hyper-v/index.js";
import type { HyperVVmObservation } from "../../../host-control/hyper-v/index.js";
import { createDeviceLabHyperVWindowsClient, type DeviceLabHyperVCommandRunner } from "./lifecycle-adapter.js";

export type DeviceLabHyperVStatusOptions = {
    readonly executable: string;
    readonly run: DeviceLabHyperVCommandRunner;
    readonly timeoutMilliseconds: () => number;
    readonly now?: () => number;
    readonly vmId: string;
    readonly vmName: string;
    readonly expectedNotes: string;
    readonly ownerId: string;
    readonly session?: HyperVWindowsExecutor;
    readonly requireCompleteVhdChain?: boolean;
};

export type DeviceLabHyperVStatusResult =
    | { readonly ok: true; readonly observation: HyperVVmObservation }
    | { readonly ok: false; readonly code: string };

const MAX_VHD_CHAIN_DEPTH = 32;

function failure(code: string): DeviceLabHyperVStatusResult {
    return { ok: false, code };
}

function readFailure(cause: unknown, fallback: string, remaining: () => boolean): DeviceLabHyperVStatusResult {
    return failure(!remaining() || cause instanceof HyperVWindowsError && cause.category === "transport" && cause.code === "timeout"
        ? "hyper-v-status-timeout" : fallback);
}

function pathKey(path: string): string {
    return win32.normalize(path).toLowerCase();
}

function absolutePath(path: string): boolean {
    return isAbsolute(path) || win32.isAbsolute(path);
}

/** Compose the legacy status observation from owner-fenced typed reads. */
export async function observeDeviceLabHyperVStatus(
    options: DeviceLabHyperVStatusOptions,
): Promise<DeviceLabHyperVStatusResult> {
    if (!/^[a-f0-9]{16}$/.test(options.ownerId)
        || !options.expectedNotes.startsWith(`ccc-device-lab:${options.ownerId}:`)) {
        return failure("hyper-v-status-identity-invalid");
    }
    const remaining = () => {
        try {
            const milliseconds = options.timeoutMilliseconds();
            return Number.isFinite(milliseconds) && milliseconds >= 1;
        } catch {
            return false;
        }
    };
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
        return readFailure(cause, "hyper-v-status-vm-lookup-command-failed", remaining);
    }
    const selector = { kind: "id" as const, id: options.vmId };
    const expectedId = options.vmId.toLowerCase();
    let machines;
    try {
        if (!remaining()) return failure("hyper-v-status-timeout");
        machines = await client.getVM(selector);
    } catch (cause) {
        return readFailure(cause, "hyper-v-status-vm-lookup-command-failed", remaining);
    }
    if (machines.length !== 1 || machines[0].id !== expectedId
        || machines[0].name !== options.vmName || machines[0].notes !== options.expectedNotes) {
        return failure("hyper-v-vm-ownership-mismatch");
    }
    let disks;
    try {
        if (!remaining()) return failure("hyper-v-status-timeout");
        disks = await client.getVMHardDiskDrives(selector);
    } catch (cause) {
        return readFailure(cause, "hyper-v-status-disk-lookup-command-failed", remaining);
    }
    if (disks.some((disk) => disk.vmId !== expectedId || disk.vmName !== options.vmName)) {
        return failure("hyper-v-status-disk-identity-mismatch");
    }

    let diskPath = disks[0]?.path ?? undefined;
    if (diskPath) {
        if (!absolutePath(diskPath)) return failure("hyper-v-status-vhd-chain-invalid");
        const visited = new Set<string>();
        for (let depth = 0; depth < MAX_VHD_CHAIN_DEPTH; depth += 1) {
            const key = pathKey(diskPath);
            if (visited.has(key)) return failure("hyper-v-status-vhd-chain-invalid");
            visited.add(key);
            if (!remaining()) return failure("hyper-v-status-timeout");
            let vhd;
            try {
                vhd = await client.getVHD(diskPath);
            } catch (cause) {
                // The legacy status command retained the last known active/parent path on a
                // native Get-VHD read error. Protocol and transport failures are not evidence
                // about a VHD and cannot produce a successful partial observation.
                if (!remaining()) return failure("hyper-v-status-timeout");
                if (cause instanceof HyperVWindowsError && cause.category === "native"
                    && (cause.code === "vhd-not-found" || cause.code === "vhd-metadata-read-failed")) {
                    if (options.requireCompleteVhdChain) return failure("hyper-v-status-vhd-lookup-command-failed");
                    break;
                }
                return readFailure(cause, "hyper-v-status-vhd-lookup-command-failed", remaining);
            }
            if (pathKey(vhd.path) !== key) return failure("hyper-v-status-vhd-chain-invalid");
            if (!vhd.parentPath) break;
            if (!absolutePath(vhd.parentPath)) return failure("hyper-v-status-vhd-chain-invalid");
            diskPath = vhd.parentPath;
            if (depth === MAX_VHD_CHAIN_DEPTH - 1) return failure("hyper-v-status-vhd-chain-invalid");
        }
    }

    let snapshots;
    try {
        if (!remaining()) return failure("hyper-v-status-timeout");
        snapshots = await client.getVMSnapshots(selector);
    } catch (cause) {
        return readFailure(cause, "hyper-v-status-snapshot-lookup-command-failed", remaining);
    }
    if (snapshots.some((snapshot) => snapshot.vmId !== expectedId || snapshot.vmName !== options.vmName)
        || new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) {
        return failure("hyper-v-status-snapshot-identity-mismatch");
    }

    // The native reads are separate transactions. Re-read the VM before publishing their
    // combined observation so a replacement or changed ownership does not look coherent.
    let finalMachines;
    try {
        if (!remaining()) return failure("hyper-v-status-timeout");
        finalMachines = await client.getVM(selector);
    } catch (cause) {
        return readFailure(cause, "hyper-v-status-vm-lookup-command-failed", remaining);
    }
    if (!remaining()) return failure("hyper-v-status-timeout");
    if (finalMachines.length !== 1 || finalMachines[0].id !== expectedId
        || finalMachines[0].name !== options.vmName || finalMachines[0].notes !== options.expectedNotes) {
        return failure("hyper-v-vm-ownership-mismatch");
    }
    const finalVm = finalMachines[0];
    return {
        ok: true,
        observation: {
            ok: true,
            vmId: expectedId,
            vmName: options.vmName,
            state: finalVm.state,
            status: finalVm.status,
            uptimeMs: finalVm.uptimeMilliseconds,
            ...(diskPath ? { diskPath } : {}),
            ...(finalVm.generation === 1 || finalVm.generation === 2 ? { generation: finalVm.generation } : {}),
            ...(["Disabled", "Production", "ProductionOnly", "Standard"].includes(finalVm.checkpointType)
                ? { checkpointPolicy: finalVm.checkpointType as HyperVVmObservation["checkpointPolicy"] } : {}),
            snapshots: snapshots.filter((snapshot) => snapshot.name.toLowerCase().startsWith(`ccc-${options.ownerId}-`))
                .map((snapshot) => ({ ok: true, snapshotId: snapshot.id, snapshotName: snapshot.name,
                    snapshotType: snapshot.snapshotType })),
        },
    };
}
