import { resolve, win32 } from "path";

import { HyperVWindowsError, type HyperVWindowsExecutor } from "@ccc/hyper-v/index.js";
import { parseHyperVGuestProvisionObservation, type HyperVGuestProvisionObservation, type HyperVProviderCommand } from "../../../host-control/hyper-v/index.js";
import { createDeviceLabHyperVWindowsClient, type DeviceLabHyperVCommandResult, type DeviceLabHyperVCommandRunner } from "./lifecycle-adapter.js";

export type DeviceLabHyperVWindowsGuestProvisioningOptions = {
    readonly executable: string;
    readonly mediaCommand: HyperVProviderCommand;
    readonly run: DeviceLabHyperVCommandRunner;
    readonly timeoutMilliseconds: () => number;
    readonly session?: HyperVWindowsExecutor;
    readonly vmId: string;
    readonly vmName: string;
    readonly expectedNotes: string;
    readonly generation: 1 | 2;
    readonly osDiskPath: string;
    readonly mediaPath: string;
    readonly credentialPath: string;
    readonly guestUsername: string;
    readonly outputLimit: number;
};

export type DeviceLabHyperVWindowsGuestProvisioningExecution = DeviceLabHyperVCommandResult & {
    readonly mode: "exec";
    readonly provider: "hyper-v";
    readonly executable: string;
    readonly args: string[];
};

export type DeviceLabHyperVWindowsGuestProvisioningResult = {
    readonly ok: boolean;
    readonly observation: HyperVGuestProvisionObservation | null;
    readonly execution: DeviceLabHyperVWindowsGuestProvisioningExecution;
};

function failure(options: DeviceLabHyperVWindowsGuestProvisioningOptions, code: string): DeviceLabHyperVWindowsGuestProvisioningResult {
    return {
        ok: false, observation: null,
        execution: {
            mode: "exec", provider: "hyper-v", executable: options.executable, args: [],
            status: 1, stdout: "", stderr: code,
        },
    };
}

function provisionFailureCode(cause: unknown, fallback: string): string {
    if (cause instanceof HyperVWindowsError) {
        const allowed = new Set([
            "hyper-v-guest-provision-requires-stopped-vm",
            "hyper-v-guest-provisioning-media-already-attached",
            "hyper-v-guest-provisioning-media-attach-failed",
            "hyper-v-guest-disk-attachment-mismatch",
            "hyper-v-guest-secure-boot-not-enabled",
            "hyper-v-guest-integration-services-not-enabled",
            "hyper-v-guest-provision-generation-mismatch",
            "hyper-v-guest-provision-path-invalid",
            "hyper-v-guest-provision-media-unavailable",
            "hyper-v-guest-provision-boot-settings-invalid",
            "hyper-v-guest-provision-bios-order-mismatch",
            "hyper-v-guest-provision-boot-settings-command-failed",
            "hyper-v-guest-provision-preflight-command-failed",
            "hyper-v-guest-provision-media-cleanup-failed",
            "hyper-v-guest-provision-vm-state-changed",
        ]);
        if (allowed.has(cause.code)) return cause.code;
        if (cause.code === "hyper-v-guest-provision-vm-identity-mismatch") return "hyper-v-vm-ownership-mismatch";
    }
    return fallback;
}

export async function provisionDeviceLabHyperVWindowsGuest(
    options: DeviceLabHyperVWindowsGuestProvisioningOptions,
): Promise<DeviceLabHyperVWindowsGuestProvisioningResult> {
    const client = createDeviceLabHyperVWindowsClient({
        executable: options.executable,
        timeoutMilliseconds: options.timeoutMilliseconds,
        run: options.run,
        ...(options.session ? { session: options.session } : {}),
    });
    try {
        const machines = await client.getVM({ kind: "id", id: options.vmId });
        if (machines.length !== 1 || machines[0].id !== options.vmId.toLowerCase()
            || machines[0].name !== options.vmName || machines[0].notes !== options.expectedNotes) {
            return failure(options, "hyper-v-vm-ownership-mismatch");
        }
        if (machines[0].state !== "Off" || machines[0].generation !== options.generation) {
            return failure(options, "hyper-v-guest-provision-requires-stopped-vm");
        }
        const attachedMedia = await client.getVMDvdDrives({ kind: "id", id: options.vmId });
        if (attachedMedia.some((drive) => drive.path !== null
            && win32.normalize(drive.path).toLowerCase() === win32.normalize(options.mediaPath).toLowerCase())) {
            return failure(options, "hyper-v-guest-provisioning-media-already-attached");
        }
    } catch (cause) {
        return failure(options, provisionFailureCode(cause, "hyper-v-guest-provision-vm-lookup-command-failed"));
    }

    let mediaExecution: DeviceLabHyperVCommandResult;
    try {
        mediaExecution = await options.run(options.mediaCommand, {
            timeoutMs: options.timeoutMilliseconds(), outputLimit: options.outputLimit,
        });
    } catch {
        return failure(options, "hyper-v-guest-provision-media-build-command-failed");
    }
    const result: DeviceLabHyperVWindowsGuestProvisioningExecution = {
        ...options.mediaCommand, ...mediaExecution,
        mode: "exec", provider: "hyper-v", executable: options.mediaCommand.executable,
        args: options.mediaCommand.args,
    };
    if (result.status !== 0 || result.error) return { ok: false, observation: null, execution: result };
    if (result.timedOut || result.outputLimitExceeded) {
        return { ok: false, observation: null, execution: { ...result, status: 1, error: "hyper-v-guest-provision-media-build-command-failed" } };
    }
    const observation = parseHyperVGuestProvisionObservation(result.stdout || "");
    if (!observation || observation.vmId !== options.vmId.toLowerCase()
        || observation.vmName !== options.vmName || observation.guestUsername !== options.guestUsername
        || resolve(observation.credentialPath) !== resolve(options.credentialPath)
        || resolve(observation.unattendPath) !== resolve(options.mediaPath)) return { ok: true, observation: null, execution: result };

    try {
        await client.configureVMGuestBoot({
            selector: { kind: "id", id: options.vmId },
            expectedName: options.vmName,
            expectedNotes: options.expectedNotes,
            osDiskPath: options.osDiskPath,
            mediaPath: options.mediaPath,
            bootSettings: options.generation === 2
                ? { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } }
                : { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        });
    } catch (cause) {
        return failure(options, provisionFailureCode(cause, "hyper-v-guest-provision-media-attach-command-failed"));
    }
    return { ok: true, observation, execution: result };
}
