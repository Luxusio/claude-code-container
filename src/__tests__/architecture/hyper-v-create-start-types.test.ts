import { describe, expectTypeOf, it } from "vitest";
import { createHyperVCreateStartApplication, executeHyperVVmCreation, waitHyperVWindowsGuestReadiness } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { WindowsReadinessOutcome, WindowsReadinessPorts, WindowsReadinessRequest, VmCreationPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateRecovery, HyperVLifecycleRequest, HyperVNativeExecution, VmCreationEffect, VmCreationObservation, VmCreationRequest } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.js";

function readinessCapabilities(request: WindowsReadinessRequest, ports: WindowsReadinessPorts): void {
    const result: Promise<WindowsReadinessOutcome> = waitHyperVWindowsGuestReadiness(request, ports);
    const { probe, ...withoutProbe } = ports;
    // @ts-expect-error Readiness requires the native guest provisioning observation.
    waitHyperVWindowsGuestReadiness(request, withoutProbe);
    const { machines, ...withoutMachineIdentity } = ports;
    // @ts-expect-error Uncertain detach needs a current native VM identity observation.
    waitHyperVWindowsGuestReadiness(request, withoutMachineIdentity);
    const { detachMedia, ...withoutDetach } = ports;
    // @ts-expect-error Readiness requires guarded provisioning-media detach authority.
    waitHyperVWindowsGuestReadiness(request, withoutDetach);
    const { removeMedia, ...withoutRemoval } = ports;
    // @ts-expect-error Successful readiness requires host media cleanup authority.
    waitHyperVWindowsGuestReadiness(request, withoutRemoval);
    // @ts-expect-error Typed probe transport settles asynchronously.
    waitHyperVWindowsGuestReadiness(request, { ...ports, probe: () => ({ action: "unexpected" as const }) });
    // @ts-expect-error Host media removal must return its settled asynchronous completion.
    waitHyperVWindowsGuestReadiness(request, { ...ports, removeMedia: () => undefined });
    // @ts-expect-error The deadline clock cannot return a deferred observation.
    waitHyperVWindowsGuestReadiness(request, { ...ports, now: async () => 100000 });
    // @ts-expect-error Error classification must settle before retry decisions.
    waitHyperVWindowsGuestReadiness(request, { ...ports, errorInfo: async () => null });
    void [result, probe, machines, detachMedia, removeMedia];
}
void readinessCapabilities;

function creationCapabilities(request: VmCreationRequest, ports: VmCreationPorts, effects: VmCreationEffect[]): void {
    const result: Promise<VmCreationObservation> = executeHyperVVmCreation(request, ports, effects, 100000, () => undefined);
    const { newVM, ...withoutCreation } = ports;
    // @ts-expect-error Native VM creation is a required capability.
    executeHyperVVmCreation(request, withoutCreation, effects, 100000, () => undefined);
    const { getVMHardDiskDrives, ...withoutDiskObservation } = ports;
    // @ts-expect-error Firmware success requires observation of the selected attached disk.
    executeHyperVVmCreation(request, withoutDiskObservation, effects, 100000, () => undefined);
    const { setVMFirmware, ...withoutFirmware } = ports;
    // @ts-expect-error Generation-two configuration requires native firmware authority.
    executeHyperVVmCreation(request, withoutFirmware, effects, 100000, () => undefined);
    // @ts-expect-error Deadline admission must settle before any native effect starts.
    executeHyperVVmCreation(request, { ...ports, assertDeadline: async () => undefined }, effects, 100000, () => undefined);
    // @ts-expect-error Creation planning is synchronous.
    executeHyperVVmCreation(request, { ...ports, plan: async () => [] }, effects, 100000, () => undefined);
    // @ts-expect-error Native path comparison cannot remain pending at firmware admission.
    executeHyperVVmCreation(request, { ...ports, sameWindowsPath: async () => true }, effects, 100000, () => undefined);
    void [result, newVM, getVMHardDiskDrives, setVMFirmware];
}
void creationCapabilities;

type Session = { sessionId: string };
type WorkflowPorts = Parameters<typeof createHyperVCreateStartApplication<Session>>[0];

function lifecycleCapabilities(ports: WorkflowPorts, request: HyperVLifecycleRequest): void {
    const application = createHyperVCreateStartApplication(ports);
    const created: Promise<HyperVNativeExecution> = application.createVmFromImage("owner", request, "/native/powershell", 100000);
    const recovered: Promise<HyperVCreateRecovery> = application.recoverCreateResidue("owner", "linux-vm", "owned", 100000, "incarnation");
    const { creationEffects, ...withoutNativeCreation } = ports;
    // @ts-expect-error Typed VM creation leaves are required by the actual workflow factory.
    createHyperVCreateStartApplication(withoutNativeCreation);
    const { incarnationRecord, ...withoutIncarnation } = ports;
    // @ts-expect-error Guarded recovery requires current incarnation observation.
    createHyperVCreateStartApplication(withoutIncarnation);
    const { releaseNetwork, ...withoutNetworkRelease } = ports;
    // @ts-expect-error Compensation requires the connected inward network release peer.
    createHyperVCreateStartApplication(withoutNetworkRelease);
    // @ts-expect-error Artifact cleanup must settle its mutation result synchronously.
    createHyperVCreateStartApplication({ ...ports, cleanupArtifacts: async () => ({ ok: true, removed: true }) });
    // @ts-expect-error Host capacity admission cannot remain pending before resource allocation.
    createHyperVCreateStartApplication({ ...ports, hostCapacity: async () => undefined });
    void [created, recovered, creationEffects, incarnationRecord, releaseNetwork];
}
void lifecycleCapabilities;

describe("Hyper-V create/start consumed contracts", () => {
    it("returns the finite asynchronous readiness outcome", () => {
        expectTypeOf<ReturnType<typeof waitHyperVWindowsGuestReadiness>>().toEqualTypeOf<Promise<WindowsReadinessOutcome>>();
    });
});
