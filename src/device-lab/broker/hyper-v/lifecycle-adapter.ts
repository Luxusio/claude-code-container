import { win32 } from "path";

import { hiddenWindowsPowerShellArgs } from "../../../windows-system-powershell.js";
import {
    createHyperVWindowsClient,
    createHyperVWindowsPowerShellExecutor,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    hyperVWindowsPowerShellMemoryInput,
    inspectHyperVVirtualMachine,
    reconcileHyperVVirtualMachine,
    type HyperVVirtualMachineExpectation,
    type HyperVVirtualMachineIntent,
    type HyperVVirtualMachineReconciliationOutcome,
    type HyperVWindowsClient,
    type HyperVWindowsExecutionResult,
} from "../../../hyper-v-windows/index.js";
import type { HyperVProviderCommand } from "../../../host-control/hyper-v/index.js";
import type { HyperVOperationJournal } from "./operation-journal.js";

export type DeviceLabHyperVCommandResult = {
    readonly status?: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly error?: string;
    readonly timedOut?: boolean;
    readonly outputLimitExceeded?: boolean;
};

export type DeviceLabHyperVCommandRunner = (
    command: HyperVProviderCommand,
    options: { readonly timeoutMs: number; readonly outputLimit: number },
) => DeviceLabHyperVCommandResult | Promise<DeviceLabHyperVCommandResult>;

export type DeviceLabHyperVWindowsClientOptions = {
    readonly executable: string;
    readonly timeoutMilliseconds: number | (() => number);
    readonly run: DeviceLabHyperVCommandRunner;
};

export type DeviceLabHyperVExpectationOptions = {
    readonly ownerId: string;
    readonly journal: HyperVOperationJournal;
    readonly auxiliaryMediaPaths?: readonly string[];
};

function providerResult(result: DeviceLabHyperVCommandResult): HyperVWindowsExecutionResult {
    return {
        status: result.status ?? null,
        stdout: result.stdout ?? "",
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
        ...(result.outputLimitExceeded === undefined ? {} : { outputLimitExceeded: result.outputLimitExceeded }),
    };
}

export function createDeviceLabHyperVWindowsClient(
    options: DeviceLabHyperVWindowsClientOptions,
): HyperVWindowsClient {
    const executor = createHyperVWindowsPowerShellExecutor({
        executable: options.executable,
        run: async (request, context) => {
            const timeoutMilliseconds = typeof options.timeoutMilliseconds === "function"
                ? options.timeoutMilliseconds()
                : options.timeoutMilliseconds;
            return providerResult(await options.run({
                mode: "exec",
                provider: "hyper-v",
                executable: request.executable,
                args: hiddenWindowsPowerShellArgs([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
                ]),
                input: hyperVWindowsPowerShellMemoryInput(request),
            }, {
                timeoutMs: Math.min(context.timeoutMilliseconds, timeoutMilliseconds),
                outputLimit: context.maximumOutputBytes,
            }));
        },
    });
    return createHyperVWindowsClient(executor);
}

export function deviceLabHyperVOperationIntent(
    command: HyperVOperationJournal["command"],
): HyperVVirtualMachineIntent {
    switch (command) {
        case "device_start": return "start";
        case "device_stop": return "stop";
        case "device_reboot": return "restart";
        case "device_delete": return "remove";
    }
}

export function deviceLabHyperVExpectation(
    options: DeviceLabHyperVExpectationOptions,
): HyperVVirtualMachineExpectation {
    const { journal } = options;
    const auxiliaryMediaPaths = options.auxiliaryMediaPaths ?? [];
    return {
        id: journal.vmId,
        name: journal.vmName,
        notes: `ccc-device-lab:${options.ownerId}:${journal.deviceId}:${journal.incarnationId}`,
        attachments: {
            allowedPaths: [journal.diskPath, ...auxiliaryMediaPaths],
            allowedHardDiskRoots: [win32.dirname(journal.diskPath)],
            expectedPaths: [journal.diskPath],
        },
    };
}

export async function reconcileDeviceLabHyperVOperation(
    client: HyperVWindowsClient,
    options: DeviceLabHyperVExpectationOptions,
): Promise<HyperVVirtualMachineReconciliationOutcome> {
    let inspection = await inspectHyperVVirtualMachine(client, {
        kind: "id",
        id: options.journal.vmId,
    });
    if (inspection.virtualMachines.length === 0) {
        inspection = await inspectHyperVVirtualMachine(client, {
            kind: "name",
            name: options.journal.vmName,
        });
    }
    return reconcileHyperVVirtualMachine(
        inspection,
        deviceLabHyperVExpectation(options),
        deviceLabHyperVOperationIntent(options.journal.command),
    );
}
