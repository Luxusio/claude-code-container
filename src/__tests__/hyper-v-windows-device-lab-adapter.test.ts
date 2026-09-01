import { describe, expect, it, vi } from "vitest";

import {
    createDeviceLabHyperVWindowsClient,
    deviceLabHyperVExpectation,
    deviceLabHyperVOperationIntent,
    reconcileDeviceLabHyperVOperation,
} from "../device-lab/broker/hyper-v/lifecycle-adapter.js";
import { hyperVRemainingTimeout } from "../device-lab/broker/hyper-v/deadline.js";
import type { HyperVOperationJournal } from "../device-lab/broker/hyper-v/operation-journal.js";
import {
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    type HyperVWindowsExecutionRequest,
} from "../hyper-v-windows/index.js";

const ownerId = "0123456789abcdef";
const deviceId = "adapter-test";
const incarnationId = "a".repeat(32);
const vmId = "12345678-1234-1234-1234-123456789abc";
const vmName = `ccc-${ownerId}-${deviceId}-${incarnationId}`;
const diskPath = "C:\\Managed\\disks\\root.vhdx";

function journal(command: HyperVOperationJournal["command"] = "device_stop"): HyperVOperationJournal {
    return {
        version: 1,
        operationId: "87654321-4321-4321-4321-cba987654321",
        ownerId,
        deviceId,
        incarnationId,
        command,
        vmId,
        vmName,
        diskPath,
        startedAt: "2026-08-31T00:00:00.000Z",
    };
}

function success(operation: HyperVWindowsExecutionRequest["operation"], items: readonly unknown[] = []) {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    };
}

function vm(state: string) {
    return {
        id: vmId,
        name: vmName,
        state,
        status: "Operating normally",
        notes: `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`,
        uptimeMilliseconds: 42,
        generation: 2,
        checkpointType: "ProductionOnly",
    };
}

function operationRequest(command: { readonly input?: string }): HyperVWindowsExecutionRequest {
    const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { script?: unknown; input?: unknown };
    expect(envelope.script).toEqual(expect.stringContaining("$global:CccHyperVJsonInput"));
    expect(typeof envelope.input).toBe("string");
    return JSON.parse(String(envelope.input)) as HyperVWindowsExecutionRequest;
}

describe("Device Lab Hyper-V lifecycle adapter", () => {
    it("maps the existing journal without moving consumer policy into the library", () => {
        expect(deviceLabHyperVOperationIntent("device_start")).toBe("start");
        expect(deviceLabHyperVOperationIntent("device_stop")).toBe("stop");
        expect(deviceLabHyperVOperationIntent("device_reboot")).toBe("restart");
        expect(deviceLabHyperVOperationIntent("device_delete")).toBe("remove");
        expect(deviceLabHyperVExpectation({
            ownerId,
            journal: journal(),
            auxiliaryMediaPaths: ["C:\\Managed\\disks\\setup.iso"],
        })).toEqual({
            id: vmId,
            name: vmName,
            notes: `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`,
            attachments: {
                allowedPaths: [diskPath, "C:\\Managed\\disks\\setup.iso"],
                allowedHardDiskRoots: ["C:\\Managed\\disks"],
                expectedPaths: [diskPath],
            },
        });
    });

    it("adapts the bounded broker runner to the generic PowerShell executor", async () => {
        const run = vi.fn((command, options) => {
            const request = operationRequest(command);
            return { ...command, ...success(request.operation), observedOptions: options };
        });
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 30_000,
            run,
        });

        await expect(client.getVM({ kind: "id", id: vmId })).resolves.toEqual([]);
        const [command, options] = run.mock.calls[0];
        expect(command.args).not.toContain("-File");
        expect(command.args).toContain("-Command");
        expect(command.args.at(-1)).toBe(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP);
        expect(options).toEqual({ timeoutMs: 30_000, outputLimit: 65_536 });
    });

    it("recomputes the remaining timeout for every native invocation", async () => {
        let now = 1_000_000;
        const deadlineAt = now + 1_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const observedTimeouts: number[] = [];
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 30_000),
            run: (command, options) => {
                observedTimeouts.push(options.timeoutMs);
                now += 900;
                const request = operationRequest(command);
                return success(request.operation);
            },
        });

        try {
            await client.getVM({ kind: "id", id: vmId });
            await client.getVM({ kind: "id", id: vmId });
            expect(observedTimeouts).toEqual([1_000, 100]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("preserves the broker output-limit signal as a protocol failure", async () => {
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 30_000,
            run: () => ({
                status: null,
                stdout: "x".repeat(65_536),
                error: "spawn ENOBUFS: device-lab provider output exceeded limit",
                outputLimitExceeded: true,
            }),
        });

        await expect(client.startVM({ selector: { kind: "id", id: vmId } })).rejects.toMatchObject({
            category: "protocol",
            operation: "Start-VM",
            code: "response-too-large",
        });
    });

    it("fences an absent ID when the managed name belongs to another VM", async () => {
        const replacementVmId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        const run = vi.fn((command) => {
            const request = operationRequest(command);
            if (request.operation !== "Get-VM") return success(request.operation);
            return request.selector.kind === "id"
                ? success(request.operation)
                : success(request.operation, [{ ...vm("Off"), id: replacementVmId }]);
        });
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 30_000,
            run,
        });

        await expect(reconcileDeviceLabHyperVOperation(client, {
            ownerId,
            journal: journal("device_delete"),
        })).resolves.toMatchObject({ kind: "identity-conflict", reason: "id-mismatch" });
        expect(run.mock.calls.map(([command]) => operationRequest(command).selector.kind))
            .toEqual(["id", "name", "id", "id"]);
    });

    it("settles stable zero-disk residue and rejects a foreign disk", async () => {
        let foreignDisk = false;
        const run = vi.fn((command) => {
            const request = operationRequest(command);
            if (request.operation === "Get-VM") return success(request.operation, [vm("Off")]);
            if (request.operation === "Get-VMHardDiskDrive" && foreignDisk) {
                return success(request.operation, [{
                    vmId,
                    vmName,
                    path: "C:\\Foreign\\root.vhdx",
                    controllerType: "SCSI",
                    controllerNumber: 0,
                    controllerLocation: 0,
                    diskNumber: null,
                }]);
            }
            return success(request.operation);
        });
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 30_000,
            run,
        });

        await expect(reconcileDeviceLabHyperVOperation(client, {
            ownerId,
            journal: journal("device_stop"),
        })).resolves.toMatchObject({ kind: "settled", drift: { missingExpectedPaths: [diskPath] } });

        foreignDisk = true;
        await expect(reconcileDeviceLabHyperVOperation(client, {
            ownerId,
            journal: journal("device_delete"),
        })).resolves.toMatchObject({
            kind: "attachment-conflict",
            unexpectedAttachments: [{ kind: "hard-disk", path: "C:\\Foreign\\root.vhdx" }],
        });
    });
});
