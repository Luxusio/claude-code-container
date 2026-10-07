import { describe, expect, it, vi } from "vitest";

import { waitForDeviceLabHyperVGuestReadiness } from "@ccc/device-lab/device-lab/broker/hyper-v/guest-readiness-adapter.js";
import type { HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";

const id = "12345678-1234-1234-1234-123456789abc";
const marker = "ccc-device-lab:owner:device:incarnation";
const identity = {
    selector: { kind: "id" as const, id }, expectedName: "owned-vm", expectedNotes: marker,
    credentialPath: "C:\\private\\guest.xml",
};
const mediaPath = "C:\\devices\\autounattend.iso";

function requestOf(command: { input?: string }): HyperVWindowsExecutionRequest {
    const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(memory.input) as HyperVWindowsExecutionRequest;
}

function envelope(request: HyperVWindowsExecutionRequest, items: unknown[]) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
}

function probe(markerValue = marker, secrets = false, addresses = ["172.29.0.10"]) {
    return JSON.stringify({ computerName: "CCC-WIN", addresses, firstLogonCompleted: markerValue, provisioningSecretsPresent: secrets });
}

function readinessClock() {
    let now = 100000;
    return {
        now: () => now,
        sleep: async (milliseconds: number) => { now += milliseconds; },
    };
}

describe("Device Lab typed Hyper-V guest readiness", () => {
    it("probes, confirms scrub, detaches media, deletes ISO, then checks network", async () => {
        const clock = readinessClock();
        const calls: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            calls.push(request.operation === "Invoke-Guest" ? request.action : request.operation);
            return envelope(request, request.operation === "Invoke-Guest" ? [{ action: "job", output: probe() }] : []);
        });
        const removeProvisioningMedia = vi.fn(() => { calls.push("delete-iso"); });
        const result = await waitForDeviceLabHyperVGuestReadiness({
            ...clock,
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
        });
        expect(result).toMatchObject({ ok: true, attempts: 1, computerName: "CCC-WIN" });
        expect(calls).toEqual(["job", "Remove-VMDvdDrive", "delete-iso"]);
        expect(removeProvisioningMedia).toHaveBeenCalledTimes(1);
        const job = requestOf(run.mock.calls[0][0]);
        expect(job.operation).toBe("Invoke-Guest");
        if (job.operation === "Invoke-Guest") expect(job.command).toContain("FirstLogonCompleted");
    });

    it("never detaches media when the incarnation marker or secrets gate fails", async () => {
        for (const [output, expectedReason] of [
            [probe("other"), "hyper-v-guest-first-logon-incomplete"],
            [probe(marker, true), "hyper-v-guest-provisioning-not-scrubbed"],
            ["{malformed", "hyper-v-guest-probe-invalid"],
            [JSON.stringify({ computerName: "CCC-WIN", addresses: ["172.29.0.10"], firstLogonCompleted: marker, provisioningSecretsPresent: "false" }), "hyper-v-guest-probe-invalid"],
        ] as const) {
            const clock = readinessClock();
            const requests: HyperVWindowsExecutionRequest[] = [];
            const run = vi.fn((command: { input?: string }) => {
                const request = requestOf(command);
                requests.push(request);
                return envelope(request, [{ action: "job", output }]);
            });
            const removeProvisioningMedia = vi.fn();
            const result = await waitForDeviceLabHyperVGuestReadiness({
                ...clock,
                executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
                expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
            });
            expect(result).toMatchObject({ ok: false, reason: expectedReason, scrubConfirmed: false, mediaDetached: false });
            expect(requests.every((request) => request.operation === "Invoke-Guest" && request.action === "job")).toBe(true);
            expect(removeProvisioningMedia).not.toHaveBeenCalled();
        }
    });

    it("stops after a valid guest observation remains unchanged for the no-progress budget", async () => {
        let now = 100000;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const attemptTimeouts: number[] = [];
        const run = vi.fn((command: { input?: string }, options: { timeoutMs: number }) => {
            const request = requestOf(command);
            attemptTimeouts.push(options.timeoutMs);
            return envelope(request, [{ action: "job", output: probe("", false, ["172.29.0.11"]) }]);
        });
        const removeProvisioningMedia = vi.fn();

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 20000,
            noProgressTimeoutMilliseconds: 5000, removeProvisioningMedia,
            now: () => now, sleep,
        });

        expect(result).toMatchObject({
            ok: false, error: "hyper-v-guest-ready-timeout",
            reason: "hyper-v-guest-first-logon-incomplete", attempts: 3,
            scrubConfirmed: false, mediaDetached: false,
        });
        expect(now).toBe(105000);
        expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2000, 2000, 1000]);
        expect(attemptTimeouts).toEqual([15000, 3000, 1000]);
        expect(removeProvisioningMedia).not.toHaveBeenCalled();
    });

    it.each([
        ["first-logon marker", () => probe("phase-two", false, ["172.29.0.12"])],
        ["provisioning-secret flag", () => probe("", true, ["172.29.0.12"])],
        ["IPv4 address set", () => probe("", false, ["172.29.0.11"])],
    ])("resets the no-progress budget when the %s changes", async (_label, changedProbe) => {
        let now = 100000;
        let probeAttempts = 0;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            if (request.operation !== "Invoke-Guest") return envelope(request, []);
            probeAttempts += 1;
            const output = probeAttempts >= 5
                ? probe()
                : probeAttempts >= 3 ? changedProbe() : probe("", false, ["172.29.0.12"]);
            return envelope(request, [{ action: "job", output }]);
        });
        const removeProvisioningMedia = vi.fn();

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 15000,
            noProgressTimeoutMilliseconds: 5000, removeProvisioningMedia,
            now: () => now, sleep,
        });

        expect(result).toMatchObject({ ok: true, attempts: 5, networkAddress: "172.29.0.10" });
        expect(now).toBe(108000);
        expect(removeProvisioningMedia).toHaveBeenCalledTimes(1);
    });

    it("treats IPv4 ordering and duplicates as the same no-progress observation", async () => {
        let now = 100000;
        let probeAttempts = 0;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            probeAttempts += 1;
            const addresses = probeAttempts % 2 === 0
                ? ["172.29.0.12", "172.29.0.11"]
                : ["172.29.0.11", "172.29.0.12", "172.29.0.11"];
            return envelope(request, [{ action: "job", output: probe("", false, addresses) }]);
        });

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 12000,
            noProgressTimeoutMilliseconds: 5000, removeProvisioningMedia: vi.fn(),
            now: () => now, sleep,
        });

        expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-first-logon-incomplete", attempts: 3 });
        expect(now).toBe(105000);
    });

    it("bounds an unchanged PowerShell Direct transport failure by the no-progress deadline", async () => {
        let now = 100000;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            return {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false, errorCode: "PSSessionOpenFailed" }),
            };
        });

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 6000,
            noProgressTimeoutMilliseconds: 3000, removeProvisioningMedia: vi.fn(),
            now: () => now, sleep,
        });

        expect(result).toMatchObject({
            ok: false, error: "hyper-v-guest-ready-timeout",
            reason: "powershell-direct-session-unavailable", attempts: 2,
        });
        expect(now).toBe(103000);
        expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2000, 1000]);
    });

    it("resets the no-progress deadline when the bounded transport state changes", async () => {
        let now = 100000;
        let attempts = 0;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            attempts += 1;
            return {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false,
                    errorCode: attempts === 1 ? "PSSessionOpenFailed" : "InvalidCredential-PSSessionOpenFailed" }),
            };
        });

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 10000,
            noProgressTimeoutMilliseconds: 3000, removeProvisioningMedia: vi.fn(),
            now: () => now, sleep,
        });

        expect(result).toMatchObject({
            ok: false, reason: "powershell-direct-authentication-failed", attempts: 3,
        });
        expect(now).toBe(105000);
    });

    it("keeps malformed probe output under the overall deadline", async () => {
        let now = 100000;
        const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            return envelope(request, [{ action: "job", output: "{malformed" }]);
        });

        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 6000,
            noProgressTimeoutMilliseconds: 3000, removeProvisioningMedia: vi.fn(),
            now: () => now, sleep,
        });

        expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-probe-invalid", attempts: 3 });
        expect(now).toBe(106000);
    });

    it("does not replay an uncertain DVD removal and can confirm its absence by typed reads", async () => {
        const clock = readinessClock();
        const operations: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            operations.push(request.operation);
            if (request.operation === "Invoke-Guest") return envelope(request, [{ action: "job", output: probe() }]);
            if (request.operation === "Remove-VMDvdDrive") return { status: null, stdout: "", error: "lost response" };
            if (request.operation === "Get-VM") return envelope(request, [{
                id, name: identity.expectedName, state: "Running", status: "Operating normally",
                notes: marker, uptimeMilliseconds: 42, generation: 2, checkpointType: "ProductionOnly",
            }]);
            return envelope(request, []);
        });
        const removeProvisioningMedia = vi.fn();
        const result = await waitForDeviceLabHyperVGuestReadiness({
            ...clock,
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
        });
        expect(result).toMatchObject({ ok: true });
        expect(operations).toEqual(["Invoke-Guest", "Remove-VMDvdDrive", "Get-VM", "Get-VMDvdDrive"]);
        expect(removeProvisioningMedia).toHaveBeenCalledTimes(1);
    });

    it("does not retry an uncertain DVD removal while the attachment remains", async () => {
        const clock = readinessClock();
        const operations: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            operations.push(request.operation);
            if (request.operation === "Invoke-Guest") return envelope(request, [{ action: "job", output: probe() }]);
            if (request.operation === "Remove-VMDvdDrive") return { status: null, stdout: "", error: "lost response" };
            if (request.operation === "Get-VM") return envelope(request, [{
                id, name: identity.expectedName, state: "Running", status: "Operating normally",
                notes: marker, uptimeMilliseconds: 42, generation: 2, checkpointType: "ProductionOnly",
            }]);
            return envelope(request, [{ vmId: id, vmName: identity.expectedName, path: mediaPath,
                controllerType: "SCSI", controllerNumber: 0, controllerLocation: 1 }]);
        });
        const removeProvisioningMedia = vi.fn();
        const result = await waitForDeviceLabHyperVGuestReadiness({
            ...clock,
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
        });
        expect(result).toMatchObject({ ok: false, scrubConfirmed: true, mediaDetached: false });
        expect(operations).toEqual(["Invoke-Guest", "Remove-VMDvdDrive", "Get-VM", "Get-VMDvdDrive"]);
        expect(removeProvisioningMedia).not.toHaveBeenCalled();
    });

    it("keeps attached media unsafe after a native ambiguous-DVD refusal", async () => {
        const clock = readinessClock();
        const operations: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            operations.push(request.operation);
            if (request.operation === "Invoke-Guest") return envelope(request, [{ action: "job", output: probe() }]);
            if (request.operation === "Remove-VMDvdDrive") return {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false, errorCode: "dvd-attachment-ambiguous" }),
            };
            if (request.operation === "Get-VM") return envelope(request, [{
                id, name: identity.expectedName, state: "Running", status: "Operating normally",
                notes: marker, uptimeMilliseconds: 42, generation: 2, checkpointType: "ProductionOnly",
            }]);
            return envelope(request, [{ vmId: id, vmName: identity.expectedName, path: mediaPath,
                controllerType: "SCSI", controllerNumber: 0, controllerLocation: 1 }]);
        });
        const removeProvisioningMedia = vi.fn();
        const result = await waitForDeviceLabHyperVGuestReadiness({
            ...clock,
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
        });
        expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-provisioning-media-attachment-ambiguous", scrubConfirmed: true, mediaDetached: false });
        expect(operations).toEqual(["Invoke-Guest", "Remove-VMDvdDrive", "Get-VM", "Get-VMDvdDrive"]);
        expect(removeProvisioningMedia).not.toHaveBeenCalled();
    });

    it("bounds the whole job attempt by the remaining readiness budget", async () => {
        const removeProvisioningMedia = vi.fn();
        let now = 100000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        const run = vi.fn((command: { input?: string }, options: { timeoutMs: number }) => {
            const request = requestOf(command);
            expect(request.operation).toBe("Invoke-Guest");
            expect(options.timeoutMs).toBeLessThanOrEqual(1000);
            now += 1001;
            return envelope(request, [{ action: "job", output: probe() }]);
        });
        try {
            const result = await waitForDeviceLabHyperVGuestReadiness({
                executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
                expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
            });
            expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-ready-deadline-exceeded", scrubConfirmed: true, mediaDetached: false });
            expect(removeProvisioningMedia).not.toHaveBeenCalled();
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            clock.mockRestore();
        }
    });

    it("does not inspect an uncertain DVD response after the readiness deadline", async () => {
        let now = 100000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        const operations: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            operations.push(request.operation);
            if (request.operation === "Invoke-Guest") return envelope(request, [{ action: "job", output: probe() }]);
            now += 1001;
            return { status: null, stdout: "", error: "lost response" };
        });
        try {
            const result = await waitForDeviceLabHyperVGuestReadiness({
                executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
                expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000,
                removeProvisioningMedia: vi.fn(),
            });
            expect(result).toMatchObject({ ok: false, scrubConfirmed: true, mediaDetached: false });
            expect(operations).toEqual(["Invoke-Guest", "Remove-VMDvdDrive"]);
        } finally {
            clock.mockRestore();
        }
    });

    it("reports failure when ISO deletion completes after the readiness deadline", async () => {
        let now = 100000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            return envelope(request, request.operation === "Invoke-Guest" ? [{ action: "job", output: probe() }] : []);
        });
        const removeProvisioningMedia = vi.fn(() => { now += 1001; });
        try {
            const result = await waitForDeviceLabHyperVGuestReadiness({
                executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
                expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
            });
            expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-ready-deadline-exceeded", scrubConfirmed: true, mediaDetached: true });
            expect(removeProvisioningMedia).toHaveBeenCalledTimes(1);
        } finally {
            clock.mockRestore();
        }
    });

    it("keeps both latches when host ISO deletion fails after a confirmed detach", async () => {
        const clock = readinessClock();
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            return envelope(request, request.operation === "Invoke-Guest" ? [{ action: "job", output: probe() }] : []);
        });
        const result = await waitForDeviceLabHyperVGuestReadiness({
            ...clock,
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000,
            removeProvisioningMedia: () => { throw new Error("disk locked"); },
        });
        expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-provisioning-media-delete-failed", scrubConfirmed: true, mediaDetached: true });
        expect(run.mock.calls.map(([command]) => requestOf(command).operation)).not.toContain("Get-VMDvdDrive");
    });

    it("cleans up media before reporting a network mismatch", async () => {
        let clock = 100000;
        const operations: string[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = requestOf(command);
            operations.push(request.operation);
            return envelope(request, request.operation === "Invoke-Guest"
                ? [{ action: "job", output: probe(marker, false, ["172.29.0.11"]) }] : []);
        });
        const removeProvisioningMedia = vi.fn(() => { operations.push("delete-iso"); });
        const result = await waitForDeviceLabHyperVGuestReadiness({
            executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
            expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000, removeProvisioningMedia,
            now: () => clock,
            sleep: async milliseconds => { clock += milliseconds; },
        });
        expect(result).toMatchObject({ ok: false, reason: "hyper-v-guest-network-not-ready", attempts: 1, scrubConfirmed: true, mediaDetached: true });
        expect(operations).toEqual(["Invoke-Guest", "Remove-VMDvdDrive", "delete-iso"]);
        expect(removeProvisioningMedia).toHaveBeenCalledTimes(1);
    });

    it("maps bounded native authentication and session errors without exposing host text", async () => {
        for (const [nativeCode, reason] of [
            ["InvalidCredential-PSSessionOpenFailed", "powershell-direct-authentication-failed"],
            ["PSSessionOpenFailed", "powershell-direct-session-unavailable"],
        ] as const) {
            const clock = readinessClock();
            const run = vi.fn((command: { input?: string }) => {
                const request = requestOf(command);
                return {
                    status: 1,
                    stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false, errorCode: nativeCode }),
                };
            });
            const result = await waitForDeviceLabHyperVGuestReadiness({
                ...clock,
                executable: "powershell.exe", run, identity, provisioningMediaPath: mediaPath,
                expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 1000,
                removeProvisioningMedia: vi.fn(),
            });
            expect(result).toMatchObject({ ok: false, reason, scrubConfirmed: false, mediaDetached: false });
        }
    });
});
