import { describe, expect, it, vi } from "vitest";

import { deviceLabHyperVLinuxGuiReadinessObservation, deviceLabHyperVLinuxReadinessObservation, deviceLabHyperVReadinessFailure, deviceLabWindowsReadinessObservation, deviceLabWindowsReadinessPorts, parseHyperVLinuxEd25519HostKeyFingerprints, parseWindowsReadinessProbe, waitForDeviceLabHyperVGuestReadiness } from "@ccc/device-lab/device-lab/broker/hyper-v/guest-readiness-adapter.js";
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
    it.each([false, true])("carries typed Windows failure and scrub/media facts without reparsing native summary (detached=%s)", mediaDetached => {
        const outcome = { ok: false as const, error: "hyper-v-guest-ready-failed" as const,
            reason: "hyper-v-guest-provisioning-media-delete-failed", attempts: 2, scrubConfirmed: true, mediaDetached };
        const observed = deviceLabWindowsReadinessObservation(outcome);
        expect(observed.outcome).toBe(outcome);
        expect(observed).toMatchObject({ backend: "windows-vm", ok: false, ready: false,
            failureCode: outcome.reason, failureDetail: { evidence: { structured: true, status: 1, timedOut: false, stderrBytes: 0, stdoutBytes: Buffer.byteLength(JSON.stringify(outcome), "utf8") } } });
        expect(observed.execution).toMatchObject({ required: true, dispatched: true, ok: false });
        const overridden = deviceLabHyperVReadinessFailure("windows-vm", "hyper-v-operation-deadline-exceeded", { previous: observed });
        expect(overridden).toMatchObject({ ready: false, failureCode: outcome.reason, execution: { failureCode: "hyper-v-operation-deadline-exceeded" } });
        expect(overridden.backend === "windows-vm" ? overridden.outcome : null).toBe(outcome);
    });

    it("normalizes Linux substring readiness while preserving raw native evidence and success semantics", () => {
        const execution = Object.freeze({ mode: "exec", provider: "hyper-v-ssh", status: 0,
            stdout: "prefix ccc-hyper-v-linux-ready suffix\n", stderr: "native diagnostic é", timedOut: true, outputLimitExceeded: true });
        const observed = deviceLabHyperVLinuxReadinessObservation(execution);
        expect(observed).toMatchObject({ backend: "linux-vm", ok: true, ready: true,
            failureDetail: { evidence: { status: 0, timedOut: true, stdoutBytes: Buffer.byteLength(execution.stdout), stderrBytes: Buffer.byteLength(execution.stderr) } } });
        expect(observed.execution).toMatchObject({ required: true, dispatched: true, ok: true });
        expect(observed.execution.receipt).toBe(execution);
        expect(deviceLabHyperVLinuxReadinessObservation({ ...execution, error: "native error" })).toMatchObject({ ok: false, ready: false });
        expect(deviceLabHyperVLinuxReadinessObservation({ ...execution, stdout: "ccc-hyper-v-linux-not-ready" })).toMatchObject({ ok: true, ready: false });
    });

    it("settles GUI marker and native stage failures without changing the command success fact", () => {
        const execution = Object.freeze({ mode: "exec", provider: "hyper-v-ssh", status: 0, stdout: "prefix CCC_HYPER_V_GUI_READY suffix", stderr: "" });
        const ready = deviceLabHyperVLinuxGuiReadinessObservation(execution);
        expect(ready).toMatchObject({ ok: true, ready: true });
        expect(ready.execution.receipt).toBe(execution);
        const missingReceipt = Object.freeze({ ...execution, stdout: "no GUI marker", stderr: "native hyper-v-linux-gui-apt-install-failed detail" });
        const missing = deviceLabHyperVLinuxGuiReadinessObservation(missingReceipt);
        expect(missing).toMatchObject({ ok: true, ready: false, failureCode: "hyper-v-linux-gui-apt-install-failed", execution: { failureCode: "hyper-v-linux-gui-apt-install-failed" } });
        expect(missing.execution.receipt).toBe(missingReceipt);
        expect(execution).not.toHaveProperty("error");
        expect(deviceLabHyperVLinuxGuiReadinessObservation({ ...execution, status: null, stdout: "", timedOut: true }))
            .toMatchObject({ ok: false, ready: false, failureCode: "hyper-v-linux-gui-timeout" });
    });

    it("preserves captured readiness bytes while applying a later deadline failure", () => {
        const receipt = Object.freeze({ mode: "exec", provider: "hyper-v-ssh", status: 0,
            stdout: "ccc-hyper-v-linux-ready", stderr: "native diagnostic é", timedOut: false });
        const observed = deviceLabHyperVLinuxReadinessObservation(receipt);
        const overridden = deviceLabHyperVReadinessFailure("linux-vm", "hyper-v-operation-deadline-exceeded", { previous: observed, deadlineExpired: true });
        expect(overridden).toMatchObject({ ok: false, ready: false, execution: { ok: false, failureCode: "hyper-v-operation-deadline-exceeded" } });
        expect(overridden.execution.receipt).toBe(receipt);
        expect(observed).toMatchObject({ ok: true, ready: true, execution: { ok: true } });
        expect(receipt).toEqual({ mode: "exec", provider: "hyper-v-ssh", status: 0,
            stdout: "ccc-hyper-v-linux-ready", stderr: "native diagnostic é", timedOut: false });
    });

    it("keeps containment failure authoritative after a readiness overlay clears the native timeout", () => {
        const receipt = Object.freeze({ mode: "exec", provider: "hyper-v-ssh", status: 255,
            stdout: "native guest signal absent", stderr: "native diagnostic é", timedOut: true });
        const originalBytes = Buffer.from(JSON.stringify(receipt), "utf8");
        const observed = deviceLabHyperVLinuxReadinessObservation(receipt);
        const first = deviceLabHyperVReadinessFailure("linux-vm", "hyper-v-guest-boot-signal-timeout", {
            previous: observed, deadlineExpired: false,
        });
        const contained = deviceLabHyperVReadinessFailure("linux-vm", "hyper-v-bootstrap-network-containment-failed", { previous: first });
        expect(first).toMatchObject({ ready: false, failureCode: "hyper-v-guest-boot-signal-timeout",
            failureDetail: { evidence: { timedOut: false } } });
        expect(contained).toMatchObject({ ok: false, ready: false,
            failureCode: "hyper-v-bootstrap-network-containment-failed",
            failureDetail: { evidence: { status: 255, timedOut: false } } });
        expect(first.execution.receipt).toBe(receipt);
        expect(contained.execution.receipt).toBe(receipt);
        expect(receipt.timedOut).toBe(true);
        expect(Buffer.from(JSON.stringify(receipt), "utf8")).toEqual(originalBytes);
    });

    it("extracts bounded unique ED25519 evidence from both native SSH diagnostic forms", () => {
        const expected = `SHA256:${"A".repeat(43)}`, other = `SHA256:${"B".repeat(43)}`;
        const diagnostic = `debug1: SERVER HOST KEY: ssh-ed25519 ${expected}=\nThe fingerprint for the ED25519 key sent by the remote host is\n${expected}.\ndebug1: Server host key: ssh-ed25519 ${other}\n`;
        expect(parseHyperVLinuxEd25519HostKeyFingerprints(diagnostic)).toEqual([expected, other]);
        expect(parseHyperVLinuxEd25519HostKeyFingerprints(`${"x".repeat(64 * 1024)}${diagnostic}`)).toEqual([]);
        const observed = deviceLabHyperVLinuxReadinessObservation({ mode: "exec", provider: "hyper-v-ssh", status: 255,
            error: `The fingerprint for the ED25519 key sent by remote host is\n${expected}`, stderr: `debug1: Server host key: ssh-ed25519 ${other}\nHost key verification failed.` });
        expect(observed).toMatchObject({ ok: false, ready: false, failureCode: "ssh-host-key-rejected", hostKeyFingerprints: [other, expected] });
    });

    it("qualifies exact probe fields and strict IPv4, secret and marker facts", () => {
        expect(parseWindowsReadinessProbe(probe())).toEqual({ computerName: "CCC-WIN", addresses: ["172.29.0.10"], firstLogonCompleted: marker, provisioningSecretsPresent: false });
        const valid = JSON.parse(probe());
        for (const change of [{ addresses: ["172.29.0.256"] }, { addresses: ["0172.29.0.10"] }, { addresses: [42] }, { provisioningSecretsPresent: "false" }, { firstLogonCompleted: null }, { extra: true }, { computerName: "" }]) {
            expect(parseWindowsReadinessProbe(JSON.stringify({ ...valid, ...change }))).toBeNull();
        }
    });
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
        expect(job).toMatchObject({ operation: "Invoke-Guest", action: "job" });
        if (job.operation === "Invoke-Guest" && job.action === "job") expect(job.command).toContain("FirstLogonCompleted");
    });

    it("floors fractional caller allowances only at actual typed guest and DVD dispatch", async () => {
        const run = vi.fn((command: { input?: string }, _options: { timeoutMs: number }) => {
            const request = requestOf(command);
            return envelope(request, request.operation === "Invoke-Guest" ? [{ action: "job", output: probe() }] : []);
        });
        const ports = deviceLabWindowsReadinessPorts({
            executable: "powershell.exe", run, timeoutMilliseconds: 1,
            now: () => 17.25, removeProvisioningMedia: vi.fn(),
        });

        expect(await ports.probe(identity, 4999.5)).toEqual({ kind: "valid", probe: {
            computerName: "CCC-WIN", addresses: ["172.29.0.10"], firstLogonCompleted: marker, provisioningSecretsPresent: false,
        } });
        await ports.detachMedia(identity, mediaPath, 1234.75);

        expect(run.mock.calls.map(([command]) => requestOf(command))).toEqual([
            expect.objectContaining({ operation: "Invoke-Guest", action: "job", ...identity }),
            expect.objectContaining({ operation: "Remove-VMDvdDrive", selector: identity.selector,
                expectedName: identity.expectedName, expectedNotes: marker, path: mediaPath }),
        ]);
        expect(run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([4999, 1234]);
        expect(ports.now()).toBe(17.25);
    });

    it("refuses sub-millisecond guest and DVD allowances without provider dispatch", async () => {
        const run = vi.fn((command: { input?: string }, _options: { timeoutMs: number }) => {
            const request = requestOf(command);
            return envelope(request, request.operation === "Invoke-Guest" ? [{ action: "job", output: probe() }] : []);
        });
        const ports = deviceLabWindowsReadinessPorts({
            executable: "powershell.exe", run, timeoutMilliseconds: 1000,
            now: () => 17.25, removeProvisioningMedia: vi.fn(),
        });

        await expect(ports.probe(identity, 0.75)).rejects.toBeInstanceOf(Error);
        await expect(ports.detachMedia(identity, mediaPath, 0.75)).rejects.toBeInstanceOf(Error);
        expect(run).not.toHaveBeenCalled();
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
