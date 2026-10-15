import { describe, expect, it, vi } from "vitest";
import { createHyperVCreateStartApplication, waitHyperVWindowsGuestReadiness } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartPorts, WindowsReadinessPorts, WindowsReadinessRequest } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartRequest, HyperVLifecyclePlan, HyperVNativeExecution, HyperVPowerObservation, HyperVVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.js";

function readinessFixture() {
    const request = {
        identity: { selector: { kind: "id", id: "12345678-1234-1234-1234-123456789abc" }, expectedName: "owned-vm", expectedNotes: "ccc-owner-incarnation", credentialPath: "C:\\private\\guest.xml" },
        provisioningMediaPath: "C:\\owned\\unattend.iso", expectedNetworkAddress: "172.29.0.10", timeoutMilliseconds: 5000,
    } satisfies WindowsReadinessRequest;
    let now = 100000;
    let attached = true;
    let mediaExists = true;
    const ports = {
        probe: vi.fn(async (): Promise<{ kind: "valid"; probe: { computerName: string; addresses: string[]; firstLogonCompleted: string; provisioningSecretsPresent: boolean } }> => ({ kind: "valid", probe: {
            computerName: "CCC-WIN", addresses: ["172.29.0.10"], firstLogonCompleted: request.identity.expectedNotes, provisioningSecretsPresent: false,
        } })),
        detachMedia: vi.fn(async (): Promise<undefined> => { attached = false; }),
        machines: vi.fn(async () => [{ name: request.identity.expectedName, notes: request.identity.expectedNotes }]),
        media: vi.fn(async () => attached ? [{ path: request.provisioningMediaPath }] : []),
        removeMedia: vi.fn(async (): Promise<undefined> => { expect(attached).toBe(false); mediaExists = false; }),
        errorInfo: (_error: unknown) => null,
        now: () => now,
        sleep: async (milliseconds: number) => { now += milliseconds; },
    } satisfies WindowsReadinessPorts;
    return { request, ports, now: () => now, attached: () => attached, mediaExists: () => mediaExists };
}

describe("Hyper-V inward create/start readiness policy", () => {
    it("reports ready only after scrubbed identity and provisioning media cleanup", async () => {
        const f = readinessFixture();
        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toEqual({
            ok: true, vmId: f.request.identity.selector.id, vmName: "owned-vm", computerName: "CCC-WIN", attempts: 1, networkAddress: "172.29.0.10",
        });
        expect(f.attached()).toBe(false);
        expect(f.mediaExists()).toBe(false);
    });

    it("retains mounted answer-file media while provisioning secrets are still present", async () => {
        const f = readinessFixture();
        f.ports.probe.mockResolvedValue({ kind: "valid", probe: {
            computerName: "CCC-WIN", addresses: ["172.29.0.10"], firstLogonCompleted: f.request.identity.expectedNotes, provisioningSecretsPresent: true,
        } });
        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({
            ok: false, reason: "hyper-v-guest-provisioning-not-scrubbed", scrubConfirmed: false, mediaDetached: false,
        });
        expect(f.attached()).toBe(true);
        expect(f.mediaExists()).toBe(true);
    });

    it("does not claim an uncertain detach succeeded when native observation names a successor", async () => {
        const f = readinessFixture();
        f.ports.detachMedia.mockRejectedValue(new Error("detach result uncertain"));
        f.ports.machines.mockResolvedValue([{ name: "successor-vm", notes: "successor-incarnation" }]);
        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({
            ok: false, error: "hyper-v-guest-ready-failed", scrubConfirmed: true, mediaDetached: false,
        });
        expect(f.attached()).toBe(true);
        expect(f.mediaExists()).toBe(true);
    });

    it("never replays uncertain detach even when owned media is still attached", async () => {
        const f = readinessFixture();
        f.ports.detachMedia.mockRejectedValue(new Error("lost native response"));
        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({ ok: false, scrubConfirmed: true, mediaDetached: false });
        expect(f.ports.detachMedia).toHaveBeenCalledTimes(1);
        expect(f.ports.media).toHaveBeenCalledTimes(1);
        expect(f.ports.removeMedia).not.toHaveBeenCalled();
    });

    it("bounds unchanged semantic probe facts by the no-progress allowance", async () => {
        const f = readinessFixture();
        f.ports.probe.mockResolvedValue({ kind: "valid", probe: {
            computerName: "CCC-WIN", addresses: [], firstLogonCompleted: "", provisioningSecretsPresent: true,
        } });
        expect(await waitHyperVWindowsGuestReadiness({ ...f.request, timeoutMilliseconds: 12000, noProgressTimeoutMilliseconds: 3000 }, f.ports)).toMatchObject({ ok: false, attempts: 2, scrubConfirmed: false, mediaDetached: false });
        expect(f.now()).toBe(103000);
        expect(f.ports.detachMedia).not.toHaveBeenCalled();
    });

    it("retains scrub and detach facts when host media deletion fails", async () => {
        const f = readinessFixture();
        f.ports.removeMedia.mockRejectedValue(new Error("ISO deletion denied"));
        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({
            ok: false, reason: "hyper-v-guest-provisioning-media-delete-failed", scrubConfirmed: true, mediaDetached: true,
        });
        expect(f.attached()).toBe(false);
        expect(f.mediaExists()).toBe(true);
    });
});

type PowerReceipt = { nativeEvidence: string; error?: string };
type PowerPorts = HyperVCreateStartPorts<undefined, { providerId: string }, PowerReceipt, undefined>;

function powerFixture(deviceInPlan = true) {
    const device = { id: "owned", vmId: "12345678-1234-1234-1234-123456789abc", vmName: "owned-vm", incarnationId: "incarnation", status: "stopped", runtimeState: "Off", memoryMb: 4096, cpus: 2 };
    const observation: HyperVVmObservation = { ok: true, vmId: device.vmId, vmName: device.vmName, state: "Running", status: "Operating normally" };
    const execution: HyperVNativeExecution<PowerReceipt> = { mode: "exec", provider: "hyper-v", status: 0, stdout: "native evidence is intentionally not JSON", receipt: { nativeEvidence: "power" } };
    const result: HyperVPowerObservation<PowerReceipt> = { ok: true, observation, execution };
    const ports = {
        planning: vi.fn((_owner: string, _params: unknown, expected?: { device?: unknown }): HyperVLifecyclePlan<{ providerId: string }, PowerReceipt> => {
            if (expected) expected.device = device;
            return { kind: "planned" as const, device: deviceInPlan ? device : undefined, availability: { kind: "available" as const, connection: { providerId: "powershell" } } };
        }),
        forgetConsole: vi.fn(() => undefined),
        incarnation: () => device.incarnationId,
        power: vi.fn(async () => result),
        observePlannedPower: vi.fn(async () => result),
        deadlineExpired: vi.fn(() => false),
        remaining: () => 30000,
        outputLimit: 1024,
        deviceRoot: () => "owned-root",
        mediaRetained: () => false,
        timestamp: () => "2026-10-15T00:00:00.000Z",
        publish: vi.fn((_owner: string, _state: string, _id: string, expected: unknown, replace: (current: Record<string, unknown>) => unknown) => {
            expect(expected).toBe(device);
            return { found: true, matched: true, device: replace(device) };
        }),
        diagnosticCode: vi.fn((current: HyperVNativeExecution<PowerReceipt>, fallback?: string) => current.error || fallback),
    } satisfies Pick<PowerPorts, "planning" | "forgetConsole" | "incarnation" | "power" | "observePlannedPower" | "deadlineExpired" | "remaining" | "outputLimit" | "deviceRoot" | "mediaRetained" | "timestamp" | "publish" | "diagnosticCode">;
    // Only leaves reachable in this settled power path are supplied; an unexpected effect fails.
    const application = createHyperVCreateStartApplication(ports as unknown as PowerPorts);
    const request: HyperVCreateStartRequest = { ok: true, backend: "windows-vm", stateKey: "windows-vm", command: "device_start", deviceId: device.id, force: false, dryRun: false, waitForBoot: false };
    return { device, observation, execution, result, ports, request, application };
}

describe("Hyper-V inward power observations", () => {
    it.each(["device_start", "device_reboot"] as const)("publishes the captured same-VM observation for %s without parsing native stdout", async (command) => {
        const f = powerFixture();
        const outcome = await f.application.execute("owner", { ...f.request, command }, {}, 100000, 130000);
        expect(outcome.kind).toBe(command === "device_start" ? "started" : "rebooted");
        expect(f.ports.power).toHaveBeenCalledWith({ providerId: "powershell" }, expect.objectContaining({ vmId: f.device.vmId, vmName: f.device.vmName }), command === "device_start" ? "start" : "reboot", 100000, 120000, expect.objectContaining({ memoryMb: 4096, cpus: 2 }));
        expect(outcome.device).toMatchObject({ status: "running", runtimeState: "Running", vmId: f.observation.vmId, vmName: f.observation.vmName, hyperVStatus: f.observation.status });
        expect(f.ports.publish).toHaveBeenCalledTimes(1);
        expect(outcome.execution?.command).toEqual(f.execution);
        expect(outcome.execution?.command).not.toHaveProperty("observation");
        expect(outcome.device).not.toHaveProperty("execution");
    });

    it("refuses semantic failure even when native status and stdout look successful", async () => {
        const f = powerFixture();
        f.ports.power.mockResolvedValue({ ...f.result, ok: false, execution: { ...f.execution, stdout: JSON.stringify(f.observation) } });
        const outcome = await f.application.execute("owner", f.request, {}, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "provider-command-failed", detail: "hyper-v-provider-command-failed" });
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it.each([
        { name: "another VM id", observation: { vmId: "87654321-4321-4321-4321-cba987654321" } },
        { name: "another VM name", observation: { vmName: "successor-vm" } },
        { name: "missing observation", observation: null },
    ])("rejects $name without publishing running state", async ({ observation }) => {
        const f = powerFixture();
        f.ports.power.mockResolvedValue({ ...f.result, observation: observation ? { ...f.observation, ...observation } : null });
        const outcome = await f.application.execute("owner", f.request, {}, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "provider-command-failed" });
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("uses the same normalized planned-power result without dispatching a second power operation", async () => {
        const f = powerFixture(false);
        const execution = { ...f.execution, error: "hyper-v-planned-power-refused", stdout: JSON.stringify(f.observation) };
        f.ports.observePlannedPower.mockResolvedValue({ ok: false, observation: null, execution });
        const outcome = await f.application.execute("owner", f.request, {}, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "operation-failed", detail: "hyper-v-planned-power-refused" });
        expect(f.ports.observePlannedPower).toHaveBeenCalledWith({ providerId: "powershell" }, 30000, 1024);
        expect(f.ports.power).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.diagnosticCode).toHaveBeenCalledWith(execution, "hyper-v-provider-command-failed");
    });

    it("classifies the current post-dispatch deadline overlay instead of the original native receipt", async () => {
        const f = powerFixture();
        const receipt = { nativeEvidence: "original", error: "hyper-v-original-native-error" };
        const execution = { ...f.execution, receipt };
        f.ports.power.mockResolvedValue({ ...f.result, execution });
        f.ports.deadlineExpired.mockReturnValue(true);
        const outcome = await f.application.execute("owner", f.request, {}, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "operation-failed", detail: "hyper-v-operation-deadline-exceeded" });
        expect(f.ports.diagnosticCode).toHaveBeenCalledOnce();
        const classified = f.ports.diagnosticCode.mock.calls[0]?.[0];
        expect(classified).toEqual({ ...execution, error: "hyper-v-operation-deadline-exceeded" });
        expect(classified).not.toBe(receipt);
        expect(classified?.receipt).toBe(receipt);
        expect(receipt.error).toBe("hyper-v-original-native-error");
        expect(f.ports.publish).not.toHaveBeenCalled();
    });
});
