import { describe, expect, it, vi } from "vitest";

import { observeDeviceLabHyperVStatus } from "@ccc/device-lab/device-lab/broker/hyper-v/status.js";
import type { DeviceLabHyperVCommandRunner } from "@ccc/device-lab/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";
import { HyperVOperationDeadlineError } from "@ccc/device-lab/device-lab/broker/hyper-v/deadline.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const snapshotId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const vmName = "ccc-owner-vm-incarnation";
const ownerId = "0123456789abcdef";
const notes = `ccc-device-lab:${ownerId}:device:incarnation`;
const activePath = "/devices/root-child-2.avhdx";
const parentPath = "/devices/root-child-1.avhdx";
const rootPath = "/devices/root.vhdx";

function requestOf(command: { input?: string }): HyperVWindowsExecutionRequest {
    const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(memory.input) as HyperVWindowsExecutionRequest;
}

function vm(overrides: Record<string, unknown> = {}) {
    return { id: vmId, name: vmName, notes, state: "Running", status: "Operating normally",
        uptimeMilliseconds: 42, generation: 2, checkpointType: "ProductionOnly", ...overrides };
}

function disk(overrides: Record<string, unknown> = {}) {
    return { vmId, vmName, path: activePath, controllerType: "SCSI", controllerNumber: 0,
        controllerLocation: 0, diskNumber: null, ...overrides };
}

function vhd(path: string, parent: string | null) {
    return { path, parentPath: parent, vhdFormat: "VHDX", vhdType: "Differencing",
        virtualSizeBytes: 4096, fileSizeBytes: 2048 };
}

function snapshot(overrides: Record<string, unknown> = {}) {
    return { id: snapshotId, name: `ccc-${ownerId}-before-update`, vmId, vmName,
        snapshotType: "Production", parentSnapshotId: null, parentSnapshotName: null,
        creationTimeMilliseconds: 1, ...overrides };
}

function harness(respond?: (request: HyperVWindowsExecutionRequest, count: number) => unknown[] | "fail") {
    const requests: HyperVWindowsExecutionRequest[] = [];
    const run = vi.fn(async (command: { input?: string }) => {
        const request = requestOf(command);
        requests.push(request);
        const items = respond?.(request, requests.length) ?? (request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? [vhd(request.path, request.path === activePath ? parentPath : request.path === parentPath ? rootPath : null)]
                    : request.operation === "Get-VMSnapshot" ? [snapshot(), snapshot({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "unrelated" })] : []);
        return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation,
            ok: items !== "fail", ...(items === "fail" ? { errorCode: "vhd-metadata-read-failed" } : { items }) }) };
    });
    const options = { executable: "powershell.exe", run: run as DeviceLabHyperVCommandRunner,
        timeoutMilliseconds: () => 5000, vmId, vmName, expectedNotes: notes, ownerId };
    return { requests, run, options };
}

describe("Device Lab typed Hyper-V status", () => {
    it.each(["vm", "vhd"] as const)("keeps a local status cap ordinary when it expires at the %s executor callback", async phase => {
        const test = harness();
        const localCap = new HyperVOperationDeadlineError(), parentDeadline = new HyperVOperationDeadlineError();
        const completedReads = phase === "vm" ? 0 : 2;
        let localChecks = 0;
        const timeoutMilliseconds = vi.fn(() => {
            if (test.requests.length === completedReads && ++localChecks > 1) throw localCap;
            return 5000;
        });
        expect(await observeDeviceLabHyperVStatus({ ...test.options, timeoutMilliseconds,
            // Only the separate parent refusal may escape as a lifecycle deadline.
            isDeadlineError: error => error === parentDeadline,
        })).toEqual({ ok: false, code: "hyper-v-status-timeout" });
        expect(localChecks, "one preliminary admission and one refused dispatch, without resampling the expired cap").toBe(2);
        expect(test.requests.map(request => request.operation)).toEqual(phase === "vm" ? [] : ["Get-VM", "Get-VMHardDiskDrive"]);
        expect(test.run).toHaveBeenCalledTimes(completedReads);
    });

    it("preserves the exact opted-in deadline refused by a native timeout callback without dispatch", async () => {
        const test = harness(), expired = new HyperVOperationDeadlineError();
        let checks = 0;
        await expect(observeDeviceLabHyperVStatus({
            ...test.options,
            isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
            timeoutMilliseconds: () => {
                if (++checks > 1) throw expired;
                return 5000;
            },
        })).rejects.toBe(expired);
        expect(test.run).not.toHaveBeenCalled();
        expect(test.requests).toEqual([]);
    });

    it.each(["first-read", "final-read"] as const)("refuses a late successful %s with the parent's exact deadline", async phase => {
        const expired = new HyperVOperationDeadlineError();
        let elapsed = false;
        const test = harness((request, count) => {
            if (request.operation === "Get-VM" && (phase === "first-read" || count === 4)) elapsed = true;
            return request.operation === "Get-VM" ? [vm()] : [];
        });
        await expect(observeDeviceLabHyperVStatus({ ...test.options,
            isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
            timeoutMilliseconds: () => { if (elapsed) throw expired; return 5000; },
        })).rejects.toBe(expired);
        expect(test.requests.map(request => request.operation)).toEqual(phase === "first-read" ? ["Get-VM"] : [
            "Get-VM", "Get-VMHardDiskDrive", "Get-VMSnapshot", "Get-VM",
        ]);
    });

    it.each([
        { operation: "Get-VM", failure: "native", expected: "hyper-v-status-vm-lookup-command-failed" },
        { operation: "Get-VM", failure: "protocol", expected: "hyper-v-status-vm-lookup-command-failed" },
        { operation: "Get-VM", failure: "transport", expected: "hyper-v-status-timeout" },
        { operation: "Get-VHD", failure: "native", expected: "hyper-v-status-vhd-lookup-command-failed" },
        { operation: "Get-VHD", failure: "protocol", expected: "hyper-v-status-vhd-lookup-command-failed" },
        { operation: "Get-VHD", failure: "transport", expected: "hyper-v-status-timeout" },
    ])("retains a real $failure failure from $operation when the parent also expires", async ({ operation, failure, expected }) => {
        const test = harness(), expired = new HyperVOperationDeadlineError();
        let elapsed = false;
        const issued: string[] = [];
        const run: DeviceLabHyperVCommandRunner = (command, options) => {
            const native = requestOf(command);
            issued.push(native.operation);
            if (native.operation !== operation) return test.run(command, options);
            elapsed = true;
            return failure === "protocol" ? { status: 0, stdout: "not-json" }
                : failure === "transport" ? { status: null, stdout: "", timedOut: true }
                    : { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation, ok: false,
                        errorCode: operation === "Get-VHD" ? "vhd-path-reparse-point-rejected" : "vm-not-found" }) };
        };
        expect(await observeDeviceLabHyperVStatus({ ...test.options, run, requireCompleteVhdChain: true,
            isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
            timeoutMilliseconds: () => { if (elapsed) throw expired; return 5000; },
        })).toEqual({ ok: false, code: expected });
        expect(issued).toEqual(operation === "Get-VM" ? ["Get-VM"] : ["Get-VM", "Get-VMHardDiskDrive", "Get-VHD"]);
    });

    it("keeps a non-deadline callback exception as a classified provider failure", async () => {
        const test = harness();
        let checks = 0;
        expect(await observeDeviceLabHyperVStatus({ ...test.options,
            isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
            timeoutMilliseconds: () => {
                if (++checks > 1) throw new Error("not a local deadline");
                return 5000;
            },
        })).toEqual({ ok: false, code: "hyper-v-status-vm-lookup-command-failed" });
        expect(test.run).not.toHaveBeenCalled();
    });

    it("walks nested differencing disks to the root and filters snapshots by owner", async () => {
        const test = harness();
        const result = await observeDeviceLabHyperVStatus(test.options);
        expect(result).toEqual({ ok: true, observation: { ok: true, vmId, vmName,
            state: "Running", status: "Operating normally", uptimeMs: 42,
            diskPath: rootPath, generation: 2, checkpointPolicy: "ProductionOnly",
            snapshots: [{ ok: true, snapshotId, snapshotName: `ccc-${ownerId}-before-update`, snapshotType: "Production" }] } });
        expect(test.requests.map((request) => request.operation)).toEqual([
            "Get-VM", "Get-VMHardDiskDrive", "Get-VHD", "Get-VHD", "Get-VHD", "Get-VMSnapshot", "Get-VM",
        ]);
        expect(test.requests.every((request) => request.operation === "Get-VHD"
            || request.selector?.kind === "id" && request.selector.id === vmId)).toBe(true);
    });

    it("rejects wrong Notes before secondary reads and changed Notes before publishing", async () => {
        const wrong = harness((request) => request.operation === "Get-VM" ? [vm({ notes: "foreign" })] : []);
        expect(await observeDeviceLabHyperVStatus(wrong.options)).toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        expect(wrong.requests).toHaveLength(1);

        const changed = harness((request, count) => request.operation === "Get-VM"
            ? [vm(count === 1 ? {} : { notes: "foreign" })]
            : request.operation === "Get-VMHardDiskDrive" || request.operation === "Get-VMSnapshot" ? [] : []);
        expect(await observeDeviceLabHyperVStatus(changed.options)).toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        expect(changed.requests.map((request) => request.operation)).toEqual([
            "Get-VM", "Get-VMHardDiskDrive", "Get-VMSnapshot", "Get-VM",
        ]);
    });

    it("rejects mixed VM disk and snapshot records", async () => {
        const foreignDisk = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk({ vmName: "foreign" })] : []);
        expect(await observeDeviceLabHyperVStatus(foreignDisk.options)).toEqual({ ok: false, code: "hyper-v-status-disk-identity-mismatch" });
        expect(foreignDisk.requests.map((request) => request.operation)).toEqual(["Get-VM", "Get-VMHardDiskDrive"]);

        const foreignSnapshot = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? []
                : request.operation === "Get-VMSnapshot" ? [snapshot({ vmId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })] : []);
        expect(await observeDeviceLabHyperVStatus(foreignSnapshot.options)).toEqual({ ok: false, code: "hyper-v-status-snapshot-identity-mismatch" });
    });

    it("supports empty disks and retains active-path fallback on Get-VHD failure", async () => {
        const empty = harness((request) => request.operation === "Get-VM" ? [vm()] : []);
        const emptyResult = await observeDeviceLabHyperVStatus(empty.options);
        expect(emptyResult.ok && emptyResult.observation.diskPath).toBeUndefined();
        expect(empty.requests.map((request) => request.operation)).not.toContain("Get-VHD");

        const failedVhd = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? "fail" : []);
        const fallback = await observeDeviceLabHyperVStatus(failedVhd.options);
        expect(fallback.ok && fallback.observation.diskPath).toBe(activePath);
        expect(await observeDeviceLabHyperVStatus({ ...failedVhd.options, requireCompleteVhdChain: true }))
            .toEqual({ ok: false, code: "hyper-v-status-vhd-lookup-command-failed" });

        const failedParent = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? request.path === activePath
                    ? [vhd(activePath, parentPath)] : "fail" : []);
        const parentFallback = await observeDeviceLabHyperVStatus(failedParent.options);
        expect(parentFallback.ok && parentFallback.observation.diskPath).toBe(parentPath);
        expect(await observeDeviceLabHyperVStatus({ ...failedParent.options, requireCompleteVhdChain: true }))
            .toEqual({ ok: false, code: "hyper-v-status-vhd-lookup-command-failed" });
    });

    it("rejects malformed and timed-out VHD reads instead of publishing a fallback", async () => {
        for (const response of [
            { status: 0, stdout: "not-json" },
            { status: null, stdout: "", timedOut: true },
        ]) {
            const test = harness();
            const run: DeviceLabHyperVCommandRunner = (command, options) =>
                requestOf(command).operation === "Get-VHD" ? response : test.run(command, options);
            expect(await observeDeviceLabHyperVStatus({ ...test.options, run })).toEqual({
                ok: false,
                code: response.timedOut ? "hyper-v-status-timeout" : "hyper-v-status-vhd-lookup-command-failed",
            });
        }
    });

    it("rejects native VHD path-safety and result-cardinality failures", async () => {
        for (const errorCode of ["vhd-path-reparse-point-rejected", "vhd-result-ambiguous"]) {
            const test = harness();
            const run: DeviceLabHyperVCommandRunner = (command, options) =>
                requestOf(command).operation === "Get-VHD"
                    ? { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VHD", ok: false, errorCode }) }
                    : test.run(command, options);
            expect(await observeDeviceLabHyperVStatus({ ...test.options, run })).toEqual({
                ok: false, code: "hyper-v-status-vhd-lookup-command-failed",
            });
        }
    });

    it("rejects ambiguous VM and duplicate snapshot IDs", async () => {
        const ambiguous = harness((request) => request.operation === "Get-VM" ? [vm(), vm()] : []);
        expect(await observeDeviceLabHyperVStatus(ambiguous.options)).toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        expect(ambiguous.requests).toHaveLength(1);

        const duplicates = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? []
                : request.operation === "Get-VMSnapshot" ? [snapshot(), snapshot({ name: "unrelated" })] : []);
        expect(await observeDeviceLabHyperVStatus(duplicates.options)).toEqual({ ok: false, code: "hyper-v-status-snapshot-identity-mismatch" });
    });

    it("includes owner snapshots regardless of PowerShell name casing", async () => {
        const test = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMSnapshot" ? [snapshot({ name: `CCC-${ownerId}-baseline` })] : []);
        const result = await observeDeviceLabHyperVStatus(test.options);
        expect(result.ok && result.observation.snapshots).toEqual([{
            ok: true, snapshotId, snapshotName: `CCC-${ownerId}-baseline`, snapshotType: "Production",
        }]);
    });

    it("rejects VHD cycles, depth overflow, and mismatched native paths", async () => {
        const cycle = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? [vhd(request.path, request.path === activePath ? parentPath : activePath)] : []);
        expect(await observeDeviceLabHyperVStatus(cycle.options)).toEqual({ ok: false, code: "hyper-v-status-vhd-chain-invalid" });

        const depth = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? [vhd(request.path, `${request.path}-parent`)] : []);
        expect(await observeDeviceLabHyperVStatus(depth.options)).toEqual({ ok: false, code: "hyper-v-status-vhd-chain-invalid" });
        expect(depth.requests.filter((request) => request.operation === "Get-VHD")).toHaveLength(32);

        const mismatch = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMHardDiskDrive" ? [disk()]
                : request.operation === "Get-VHD" ? [vhd("/foreign/root.vhdx", null)] : []);
        expect(await observeDeviceLabHyperVStatus(mismatch.options)).toEqual({ ok: false, code: "hyper-v-status-vhd-chain-invalid" });
    });

    it("fails closed on snapshot errors and elapsed shared deadline", async () => {
        const failed = harness((request) => request.operation === "Get-VM" ? [vm()]
            : request.operation === "Get-VMSnapshot" ? "fail" : []);
        expect(await observeDeviceLabHyperVStatus(failed.options)).toEqual({ ok: false, code: "hyper-v-status-snapshot-lookup-command-failed" });

        let remaining = 1000;
        const expired = harness((request) => {
            if (request.operation === "Get-VM") remaining = 0;
            return request.operation === "Get-VM" ? [vm()] : [];
        });
        expect(await observeDeviceLabHyperVStatus({ ...expired.options, timeoutMilliseconds: () => remaining }))
            .toEqual({ ok: false, code: "hyper-v-status-timeout" });
        expect(expired.requests.map((request) => request.operation)).toEqual(["Get-VM"]);

        let lateRemaining = 1000;
        const late = harness((request, count) => {
            if (request.operation === "Get-VM" && count === 4) lateRemaining = 0;
            return request.operation === "Get-VM" ? [vm()] : [];
        });
        expect(await observeDeviceLabHyperVStatus({ ...late.options, timeoutMilliseconds: () => lateRemaining }))
            .toEqual({ ok: false, code: "hyper-v-status-timeout" });
        expect(late.requests.map((request) => request.operation)).toEqual([
            "Get-VM", "Get-VMHardDiskDrive", "Get-VMSnapshot", "Get-VM",
        ]);

        let deadlineChecks = 0;
        const raced = harness();
        expect(await observeDeviceLabHyperVStatus({
            ...raced.options,
            timeoutMilliseconds: () => {
                deadlineChecks += 1;
                if (deadlineChecks > 1) throw new Error("deadline-expired");
                return 1000;
            },
        })).toEqual({ ok: false, code: "hyper-v-status-timeout" });
    });
});
