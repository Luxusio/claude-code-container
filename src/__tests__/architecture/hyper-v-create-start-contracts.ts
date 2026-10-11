import { createHyperVCreateStartApplication, executeHyperVVmCreation, waitHyperVWindowsGuestReadiness } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { WindowsReadinessOutcome, WindowsReadinessPorts, WindowsReadinessRequest, VmCreationPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateRecovery, HyperVLifecycleOutcome, HyperVLifecycleRequest, HyperVNativeExecution, VmCreationEffect, VmCreationObservation, VmCreationRequest } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.js";

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
type Connection = { readonly providerId: string };
type Receipt = { readonly nativeEvidence: string };
type ProvisionMedia = { readonly provisioningId: string };
type WorkflowPorts = Parameters<typeof createHyperVCreateStartApplication<Session, Connection, Receipt, ProvisionMedia>>[0];

function lifecycleCapabilities(ports: WorkflowPorts, request: HyperVLifecycleRequest, connection: Connection): void {
    const application = createHyperVCreateStartApplication(ports);
    const created: Promise<HyperVNativeExecution<Receipt>> = application.createVmFromImage("owner", request, connection, 100000);
    const recovered: Promise<HyperVCreateRecovery> = application.recoverCreateResidue("owner", "linux-vm", "owned", 100000, "incarnation");
    const invoked: Promise<HyperVLifecycleOutcome<Connection, Receipt>> = application.invoke("owner", {}, { ...request, command: "device_create" }, 100000, 100000);
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
    void [created, recovered, invoked, creationEffects, incarnationRecord, releaseNetwork];
}
void lifecycleCapabilities;

function finiteNativeCapabilities(ports: WorkflowPorts): void {
    const { prepareCreateDirectories, ...withoutDirectories } = ports;
    // @ts-expect-error Creation requires its captured native directory preparation effect.
    createHyperVCreateStartApplication(withoutDirectories);
    const { removeCreateArtifact, ...withoutArtifactRemoval } = ports;
    // @ts-expect-error Compensation requires a settled individual artifact-removal effect.
    createHyperVCreateStartApplication(withoutArtifactRemoval);
    const { prepareLinuxSeed, ...withoutSeedPreparation } = ports;
    // @ts-expect-error Linux seed preparation is required before the independently budgeted effect.
    createHyperVCreateStartApplication(withoutSeedPreparation);
    // @ts-expect-error Readiness is a settled asynchronous native observation.
    createHyperVCreateStartApplication({ ...ports, probeLinuxReadiness: () => ({ mode: "exec", provider: "hyper-v", status: 0 }) });
    // @ts-expect-error A prepared seed must return the completion of its native execution.
    createHyperVCreateStartApplication({ ...ports, prepareLinuxSeed: () => () => ({ mode: "exec", provider: "hyper-v", status: 0 }) });
    void [prepareCreateDirectories, removeCreateArtifact, prepareLinuxSeed];
}
void finiteNativeCapabilities;
