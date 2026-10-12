import { describe, expect, it, vi } from "vitest";
import { waitHyperVWindowsGuestReadiness } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { WindowsReadinessPorts, WindowsReadinessRequest } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";

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
