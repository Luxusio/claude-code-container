import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { createHyperVCreateStartApplication, waitHyperVWindowsGuestReadiness } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartPorts, WindowsReadinessPorts, WindowsReadinessRequest } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartRequest, HyperVLifecyclePlan, HyperVLinuxReadinessObservation, HyperVNativeExecution, HyperVPowerObservation, HyperVVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.js";

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

    it.each([-1, 1] as const)("keeps readiness on its fractional caller clock when wall time jumps %s", async direction => {
        const f = readinessFixture();
        let monotonicNow = 17.25, wallNow = Date.now();
        const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        f.ports.now = () => monotonicNow;
        const probe = f.ports.probe.getMockImplementation()!;
        f.ports.probe.mockImplementation(async () => {
            monotonicNow += 0.5;
            wallNow += direction * 86_400_000;
            return probe();
        });
        try {
            expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({ ok: true, attempts: 1 });
            expect(f.ports.probe).toHaveBeenCalledWith(f.request.identity, 5000);
            expect(f.ports.detachMedia).toHaveBeenCalledWith(f.request.identity, f.request.provisioningMediaPath, 4999.5);
            expect(f.mediaExists()).toBe(false);
        } finally { wallClock.mockRestore(); }
    });

    it("refuses a late scrubbed probe before media effects even after a backward wall jump", async () => {
        const f = readinessFixture();
        let monotonicNow = 17.25, wallNow = Date.now();
        const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        f.ports.now = () => monotonicNow;
        const probe = f.ports.probe.getMockImplementation()!;
        f.ports.probe.mockImplementation(async () => {
            monotonicNow += 5000;
            wallNow -= 86_400_000;
            return probe();
        });
        try {
            expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({
                ok: false, reason: "hyper-v-guest-ready-deadline-exceeded", attempts: 1, scrubConfirmed: true, mediaDetached: false,
            });
            expect(f.ports.detachMedia).not.toHaveBeenCalled();
            expect(f.ports.removeMedia).not.toHaveBeenCalled();
            expect(f.attached()).toBe(true);
            expect(f.mediaExists()).toBe(true);
        } finally { wallClock.mockRestore(); }
    });

    it("refuses native work when the original remainder is less than one millisecond", async () => {
        const f = readinessFixture();
        let now = 17.25, nativeMediaEffects = 0;
        const probe = f.ports.probe.getMockImplementation()!;
        const detach = f.ports.detachMedia.getMockImplementation()!;
        f.ports.probe.mockImplementation(async () => { now += 4999.25; return probe(); });
        const detachMedia = vi.fn<WindowsReadinessPorts["detachMedia"]>(async (_identity, _path, budget) => {
            // Stand in the existing integer-duration native boundary if core reaches it.
            if (budget < 1) throw new Error("no integral native allowance");
            nativeMediaEffects += 1;
            return detach();
        });
        Object.assign(f.ports, {
            now: () => now,
            sleep: async (milliseconds: number) => { now += milliseconds; },
            detachMedia,
        });

        expect(await waitHyperVWindowsGuestReadiness(f.request, f.ports)).toMatchObject({ ok: false });
        expect(f.ports.probe).toHaveBeenCalledExactlyOnceWith(f.request.identity, 5000);
        for (const [, , budget] of detachMedia.mock.calls) expect(budget).toBeLessThanOrEqual(0.75);
        expect(nativeMediaEffects).toBe(0);
        expect(now).toBeLessThanOrEqual(5017.25);
        expect(f.attached()).toBe(true);
        expect(f.mediaExists()).toBe(true);
        expect(f.ports.removeMedia).not.toHaveBeenCalled();
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

type PowerReceipt = { nativeEvidence: string; error?: string; status?: number; stdout?: string };
type PowerPorts = HyperVCreateStartPorts<undefined, { providerId: string }, PowerReceipt, undefined>;

function powerFixture(deviceInPlan = true) {
    const device = { id: "owned", vmId: "12345678-1234-1234-1234-123456789abc", vmName: "owned-vm", incarnationId: "incarnation", status: "stopped", runtimeState: "Off", memoryMb: 4096, cpus: 2 };
    const observation: HyperVVmObservation = { ok: true, vmId: device.vmId, vmName: device.vmName, state: "Running", status: "Operating normally" };
    const execution: HyperVNativeExecution<PowerReceipt> = { required: true, dispatched: true, ok: true, receipt: { nativeEvidence: "power", status: 0, stdout: "native evidence is intentionally not JSON" } };
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
        assertDeadline: vi.fn((_deadline: number) => undefined),
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
        diagnosticCode: vi.fn((current: HyperVNativeExecution<PowerReceipt>, fallback?: string) => current.failureCode || fallback),
    } satisfies Pick<PowerPorts, "planning" | "forgetConsole" | "incarnation" | "power" | "observePlannedPower" | "assertDeadline" | "deadlineExpired" | "remaining" | "outputLimit" | "deviceRoot" | "mediaRetained" | "timestamp" | "publish" | "diagnosticCode">;
    // Only leaves reachable in this settled power path are supplied; an unexpected effect fails.
    const application = createHyperVCreateStartApplication(ports as unknown as PowerPorts);
    const request: HyperVCreateStartRequest = { ok: true, backend: "windows-vm", stateKey: "windows-vm", command: "device_start", deviceId: device.id, force: false, dryRun: false, waitForBoot: false };
    return { device, observation, execution, result, ports, request, application };
}

describe("Hyper-V inward power observations", () => {
    it.each([
        { claimFailure: "deadline", rollbackFails: false },
        { claimFailure: "deadline", rollbackFails: true },
        { claimFailure: "owner-state", rollbackFails: false },
    ] as const)("retains the first claim compensation through invoke for $claimFailure (rollbackFails=$rollbackFails)", async ({ claimFailure, rollbackFails }) => {
        const f = powerFixture(), originalDevice = structuredClone(f.device);
        let now = 17.25, claimed: unknown;
        const deadline = now + 5000, cleanupDeadline = deadline + 30_000;
        const expired = new Error("hyper-v-operation-deadline-exceeded");
        const ownerStateError = new Error("owner-state-write-failed");
        // This isolates the actual create claim/compensation caller; no VM creation is simulated.
        f.ports.planning.mockReturnValue({ kind: "planned", availability: { kind: "not-required" } });
        const request: HyperVCreateStartRequest = { ...f.request, command: "device_create", create: {
            name: "owned", incarnationId: f.device.incarnationId, vmId: f.device.vmId, networking: false,
        } };
        const params = { ...request.create };
        const ports = {
            read: () => [], exists: () => false, hasNetworkAllocation: () => false,
            journalPath: () => "private-operation-journal", snapshotJournalPath: () => "private-snapshot-journal",
            quota: { maxDefinedVms: 16, maxConfiguredMemoryMb: 65536, maxConfiguredCpus: 32, maxConfiguredDiskBytes: 1024 ** 4,
                maxRunningVms: 4, maxRunningMemoryMb: 32768, maxRunningCpus: 16 },
            resolveImage: vi.fn<PowerPorts["resolveImage"]>(async () => ({ kind: "resolved", params, imagePath: "prepared-base.vhdx", prepared: true })),
            parse: vi.fn<PowerPorts["parse"]>(() => ({ ok: true, request })),
            newIncarnation: () => f.device.incarnationId,
            writeIncarnation: vi.fn(() => undefined),
            deadlineError: (error: unknown) => error === expired ? expired.message : null,
            privateRoot: () => resolve("owned-private"),
            vmName: () => f.device.vmName,
            validIncarnation: (value: unknown): value is string => value === f.device.incarnationId,
            connection: () => ({ providerId: "powershell" }),
            marker: () => "owned-incarnation",
            claim: vi.fn((_owner: string, _state: string, device: Record<string, unknown>, _fields: Array<string | string[]>, operationDeadline: number) => {
                // The broker's repository guard runs only after the claim's inventory lock.
                now = deadline + 0.25;
                if (now >= operationDeadline) throw claimFailure === "deadline" ? expired : ownerStateError;
                claimed = device;
                return { ok: true as const, device };
            }),
            recoverVM: vi.fn<PowerPorts["recoverVM"]>()
                .mockImplementationOnce(async () => {
                    if (rollbackFails) throw new Error("first rollback failed");
                    return { recoveredVm: true, removedDisk: true };
                })
                .mockRejectedValue(new Error("a second compensation must never run")),
            releaseNetwork: vi.fn<PowerPorts["releaseNetwork"]>(async () => ({ ok: true, released: true, statePresent: true, remaining: 0 })),
            cleanupArtifacts: vi.fn(() => ({ ok: true, removed: true })),
            stateErrorCode: () => null,
            // Production owner-state mapping rethrows a deadline that is not an owner-state error.
            stateFailure: vi.fn<PowerPorts["stateFailure"]>((error, target) => {
                if (error !== ownerStateError) throw error;
                return { reason: "state-write-failed", error: ownerStateError.message, ...target };
            }),
            typedErrorCode: (_error: unknown, fallback: string) => fallback,
            errorInfo: () => null,
            boundedErrorCode: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
        } satisfies Pick<PowerPorts, "read" | "exists" | "hasNetworkAllocation" | "journalPath" | "snapshotJournalPath" | "quota" | "resolveImage" | "parse" | "newIncarnation" | "writeIncarnation" | "deadlineError" | "privateRoot" | "vmName" | "validIncarnation" | "connection" | "marker" | "claim" | "recoverVM" | "releaseNetwork" | "cleanupArtifacts" | "stateErrorCode" | "stateFailure" | "typedErrorCode" | "errorInfo" | "boundedErrorCode">;
        Object.assign(f.ports, ports);
        f.ports.assertDeadline.mockImplementation(target => {
            if (now >= target) throw expired;
            return undefined;
        });

        const outcome = await f.application.invoke("owner", params, request, deadline, cleanupDeadline);

        expect(ports.claim).toHaveBeenCalledOnce();
        expect(ports.claim.mock.calls[0]?.[4]).toBe(deadline);
        expect(claimed).toBeUndefined();
        expect(outcome).toMatchObject({ kind: "operation-failed", journalDisposition: "retain", recoveryDisposition: "already-handled",
            rollback: { attempted: true, ok: !rollbackFails } });
        if (rollbackFails) expect(outcome).toMatchObject({ reason: "provider-failed", error: "owner-device-state-rollback-failed" });
        else {
            expect(outcome).toMatchObject({ reason: claimFailure === "deadline" ? "deadline" : "state-write-failed",
                error: claimFailure === "deadline" ? expired.message : ownerStateError.message,
                rollback: { providerRecovery: { recoveredVm: true, removedDisk: true } } });
        }
        expect(ports.stateFailure).toHaveBeenCalledTimes(claimFailure === "owner-state" ? 1 : 0);
        expect(ports.recoverVM).toHaveBeenCalledExactlyOnceWith({ providerId: "powershell" }, expect.objectContaining({
            vmName: f.device.vmName, ownershipNotes: "owned-incarnation",
        }), cleanupDeadline);
        expect(ports.releaseNetwork).toHaveBeenCalledTimes(rollbackFails ? 0 : 1);
        expect(ports.cleanupArtifacts).toHaveBeenCalledTimes(rollbackFails ? 0 : 1);
        if (!rollbackFails) {
            expect(ports.releaseNetwork).toHaveBeenCalledWith("owner", f.device.id, f.device.incarnationId, cleanupDeadline, true);
            expect(ports.cleanupArtifacts).toHaveBeenCalledWith("owner", "windows-vm", f.device.id);
        }
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.power).not.toHaveBeenCalled();
        expect(f.device).toEqual(originalDevice);
    });

    it.each(["device_start", "device_reboot"] as const)("refuses a late matched %s replacement after publication waits for the inventory lock", async command => {
        const f = powerFixture(), originalDevice = structuredClone(f.device);
        let now = 123.25, enteredAt: number | undefined, committedReplacement: unknown;
        let replacementAttempts = 0;
        const deadline = now + 5000;
        const deadlineError = new Error("hyper-v-operation-deadline-exceeded");
        Object.assign(f.ports, { now: () => now });
        f.ports.assertDeadline.mockImplementation(target => {
            expect(target).toBe(deadline);
            if (now >= target) throw deadlineError;
            return undefined;
        });
        f.ports.publish.mockImplementation((_owner, _state, _id, expected, replace) => {
            expect(expected).toBe(f.device);
            enteredAt = now;
            // The native repository obtains its synchronous inventory lock inside publish.
            // Advance only after method entry and before its matched replacement builder.
            now = deadline + 0.25;
            replacementAttempts += 1;
            const replacement = replace(f.device);
            committedReplacement = replacement;
            return { found: true, matched: true, device: replacement };
        });

        let outcome: Awaited<ReturnType<typeof f.application.execute>> | undefined, failure: unknown;
        try { outcome = await f.application.execute("owner", { ...f.request, command }, {}, deadline, deadline + 30_000); }
        catch (error) { failure = error; }

        expect(enteredAt).toBe(123.25);
        expect(replacementAttempts).toBe(1);
        if (failure !== undefined) expect(failure).toMatchObject({ message: deadlineError.message });
        else {
            expect(outcome).toMatchObject({ kind: "operation-failed", journalDisposition: "retain" });
            expect(JSON.stringify(outcome)).toContain("hyper-v-operation-deadline-exceeded");
        }
        expect(outcome?.journalDisposition).not.toBe("clear");
        expect(committedReplacement).toBeUndefined();
        expect(f.device).toEqual(originalDevice);
        expect(f.ports.power).toHaveBeenCalledTimes(1);
        expect(f.execution.receipt).toEqual({ nativeEvidence: "power", status: 0, stdout: "native evidence is intentionally not JSON" });
    });

    it.each([
        { command: "device_start", late: "probe" },
        { command: "device_start", late: "prepare" },
        { command: "device_reboot", late: "probe" },
        { command: "device_reboot", late: "prepare" },
    ] as const)("retains recovery evidence when Linux $command GUI $late completes after the parent deadline", async ({ command, late }) => {
        const f = powerFixture();
        const privateRoot = resolve("linux-owned-private"), deviceRoot = resolve(f.ports.deviceRoot());
        const fingerprint = `SHA256:${"A".repeat(43)}`;
        let now = 123.25;
        const deadline = now + 5000, cleanupDeadline = deadline + 30_000;
        Object.assign(f.device, { privateRoot, deviceRoot, networkAddress: "172.29.0.10", guestUsername: "ccc",
            sshPrivateKeyPath: join(privateRoot, "secrets", "id_ed25519"), sshHostKeyFingerprint: fingerprint,
            sshHostPublicKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key.pub"),
            sshKnownHostsPath: join(privateRoot, "secrets", "known_hosts"), macAddress: "02:11:22:33:44:55",
            networkGateway: "172.29.0.1", networkPrefix: "172.29.0.0/24" });
        const managed: HyperVLinuxReadinessObservation<PowerReceipt> = {
            backend: "linux-vm", ok: true, ready: true, execution: { ...f.execution, receipt: { nativeEvidence: "managed-SSH" } },
            failureCode: "", failureDetail: { evidence: "managed-SSH-delivered" }, hostKeyFingerprints: [],
        };
        const gui: HyperVLinuxReadinessObservation<PowerReceipt> = {
            ...managed, execution: { ...f.execution, receipt: { nativeEvidence: "GUI-completed" } },
            failureDetail: { evidence: "GUI-delivered" },
        };
        const ports = {
            privateRoot: () => privateRoot, deviceRoot: () => deviceRoot,
            assertPrivateRoot: () => undefined,
            connection: () => ({ providerId: "ssh" }),
            now: () => now, maxBootTimeout: 20 * 60 * 1000, linuxGuiTimeout: 30_000,
            marker: () => "owned-incarnation",
            reconcileHostIdentity: () => ({ identity: { fingerprint } }),
            validateHostIdentity: () => true,
            remaining: (target: number, cap: number) => {
                if (now >= target) throw new Error("hyper-v-operation-deadline-exceeded");
                return Math.floor(Math.min(cap, target - now));
            },
            deadlineExpired: vi.fn((target: number) => now >= target),
            assertDeadline: (target: number) => {
                if (now >= target) throw new Error("hyper-v-operation-deadline-exceeded");
                return undefined;
            },
            probeLinuxReadiness: vi.fn(async () => managed),
            bootstrapCleanup: vi.fn(async () => ({ execution: f.execution, observation: { ok: true, removed: true, alreadyMissing: false } })),
            probeLinuxGui: vi.fn(async () => {
                if (late === "probe") { now = deadline + 0.25; return gui; }
                return { ...gui, ready: false };
            }),
            prepareLinuxGui: vi.fn(async () => { now = deadline + 0.25; return gui; }),
            readinessFailure: vi.fn<PowerPorts["readinessFailure"]>((_backend, error, source) => ({
                ...managed, ok: false, ready: false, failureCode: error,
                execution: { ...(source?.previous?.execution ?? source?.execution ?? f.execution), ok: false, failureCode: error },
            })),
            bootDiagnostic: vi.fn<PowerPorts["bootDiagnostic"]>(async () => { throw new Error("diagnostic unavailable"); }),
            errorInfo: () => null, boundedErrorCode: (_error: unknown, fallback: string) => fallback,
        } satisfies Pick<PowerPorts, "privateRoot" | "deviceRoot" | "assertPrivateRoot" | "connection" | "now" | "maxBootTimeout" | "linuxGuiTimeout" | "marker" | "reconcileHostIdentity" | "validateHostIdentity" | "remaining" | "deadlineExpired" | "assertDeadline" | "probeLinuxReadiness" | "bootstrapCleanup" | "probeLinuxGui" | "prepareLinuxGui" | "readinessFailure" | "bootDiagnostic" | "errorInfo" | "boundedErrorCode">;
        Object.assign(f.ports, ports);

        const outcome = await f.application.execute("owner", { ...f.request, backend: "linux-vm", stateKey: "linux-vm",
            command, waitForBoot: true, bootTimeoutMs: 10_000 }, {}, deadline, cleanupDeadline);

        expect(ports.probeLinuxGui).toHaveBeenCalledTimes(1);
        expect(ports.prepareLinuxGui).toHaveBeenCalledTimes(late === "prepare" ? 1 : 0);
        expect(now).toBe(deadline + 0.25);
        expect(outcome).toMatchObject({ kind: "operation-failed", journalDisposition: "retain", recoveryDisposition: "required" });
        expect(JSON.stringify(outcome)).toContain("hyper-v-operation-deadline-exceeded");
        expect(outcome.boot?.ready).not.toBe(true);
        expect(outcome.device).not.toEqual(expect.objectContaining({ bootReady: true }));
        expect(f.ports.publish.mock.results.map(publication => publication.value)).not.toContainEqual(
            expect.objectContaining({ device: expect.objectContaining({ bootReady: true }) }));
        expect(outcome.execution?.command?.receipt).toBe(f.execution.receipt);
        expect(f.ports.power).toHaveBeenCalledTimes(1);
    });

    it("admits parent-limited fractional initial readiness through lifecycle execution", async () => {
        const f = powerFixture(), readiness = readinessFixture();
        const privateRoot = resolve("owned-private"), deviceRoot = resolve(f.ports.deviceRoot());
        const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
        const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
        const now = 123.25;
        Object.assign(f.device, { privateRoot, guestCredentialPath: credentialPath,
            guestUnattendPath: provisioningMediaPath, networkAddress: readiness.request.expectedNetworkAddress });
        readiness.ports.now = () => now;
        const ports = {
            privateRoot: () => privateRoot,
            deviceRoot: () => deviceRoot,
            assertPrivateRoot: vi.fn(() => undefined),
            marker: () => readiness.request.identity.expectedNotes,
            now: () => now,
            assertDeadline: vi.fn(() => undefined),
            maxBootTimeout: 20 * 60 * 1000,
            windowsNoProgressTimeout: 30_000,
            windowsReadiness: vi.fn(() => readiness.ports),
            observeWindowsReadiness: vi.fn<PowerPorts["observeWindowsReadiness"]>(outcome => ({
                backend: "windows-vm", ok: outcome.ok, ready: outcome.ok, outcome,
                execution: { ...f.execution, ok: outcome.ok, dispatched: outcome.attempts > 0 },
                failureCode: outcome.ok ? "" : outcome.reason, failureDetail: { evidence: outcome },
            })),
            // Keep the pre-fix refusal observable without making a native diagnostic effect.
            bootDiagnostic: vi.fn<PowerPorts["bootDiagnostic"]>(async () => { throw new Error("readiness refused"); }),
            errorInfo: () => null,
            boundedErrorCode: (_error: unknown, fallback: string) => fallback,
        } satisfies Pick<PowerPorts, "privateRoot" | "deviceRoot" | "assertPrivateRoot" | "marker" | "now" | "assertDeadline" | "maxBootTimeout" | "windowsNoProgressTimeout" | "windowsReadiness" | "observeWindowsReadiness" | "bootDiagnostic" | "errorInfo" | "boundedErrorCode">;
        Object.assign(f.ports, ports);

        const outcome = await f.application.execute("owner", { ...f.request, waitForBoot: true, bootTimeoutMs: 10_000 }, {},
            now + 15_000 + 5000.5, now + 50_000.5);

        expect(readiness.ports.probe).toHaveBeenCalledExactlyOnceWith({
            ...readiness.request.identity, credentialPath,
        }, 5000);
        expect(ports.observeWindowsReadiness).toHaveBeenCalledWith(expect.objectContaining({ ok: true, attempts: 1 }));
        expect(ports.assertPrivateRoot).toHaveBeenCalledExactlyOnceWith("owner", "windows-vm", f.device.id, privateRoot);
        expect(ports.windowsReadiness).toHaveBeenCalledExactlyOnceWith({ providerId: "powershell" }, deviceRoot, provisioningMediaPath);
        expect(readiness.attached()).toBe(false);
        expect(readiness.mediaExists()).toBe(false);
        expect(readiness.ports.now()).toBe(123.25);
        expect(outcome).toMatchObject({ kind: "started", device: { status: "running", runtimeState: "Running", bootReady: true,
            lastBootCheck: { ready: true, attempts: 1 } }, boot: { ready: true, attempts: 1 } });
        expect(f.ports.publish).toHaveBeenCalledTimes(1);
        expect(ports.bootDiagnostic).not.toHaveBeenCalled();
    });

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
        f.ports.power.mockResolvedValue({ ...f.result, ok: false, execution: { ...f.execution, receipt: { nativeEvidence: "successful-looking", status: 0, stdout: JSON.stringify(f.observation) } } });
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
        const execution = { ...f.execution, ok: false, failureCode: "hyper-v-planned-power-refused", receipt: { nativeEvidence: "successful-looking", status: 0, stdout: JSON.stringify(f.observation) } };
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
        const receipt = Object.freeze({ nativeEvidence: "original", status: 0, error: "hyper-v-original-native-error", stdout: "private native evidence" });
        const execution = { ...f.execution, receipt };
        f.ports.power.mockResolvedValue({ ...f.result, execution });
        f.ports.deadlineExpired.mockReturnValue(true);
        const outcome = await f.application.execute("owner", f.request, {}, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "operation-failed", detail: "hyper-v-operation-deadline-exceeded" });
        expect(f.ports.diagnosticCode).toHaveBeenCalledOnce();
        const classified = f.ports.diagnosticCode.mock.calls[0]?.[0];
        expect(classified).toEqual({ ...execution, ok: false, failureCode: "hyper-v-operation-deadline-exceeded" });
        expect(classified).not.toBe(receipt);
        expect(classified?.receipt).toBe(receipt);
        expect(receipt.error).toBe("hyper-v-original-native-error");
        expect(execution).toEqual({ ...f.execution, receipt });
        expect(outcome.execution?.command?.receipt).toBe(receipt);
        expect(f.ports.publish).not.toHaveBeenCalled();
    });
});
