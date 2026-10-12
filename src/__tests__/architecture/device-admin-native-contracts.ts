import { createDeviceAdminSetup } from "../../application/device-admin-setup.js";
import type { DeviceAdminSetupPorts } from "../../ports/device-admin-setup.js";
import { createDeviceAdminDiagnostics } from "../../application/device-admin-diagnostics.js";
import type { DeviceAdminDiagnosticsPorts } from "../../ports/device-admin-diagnostics.js";
import type { DeviceAdminBackend } from "../../domain/device-admin-inventory.js";
import type { DiagnosticRow } from "../../domain/device-admin-diagnostics.js";

function consumedDiagnosticCapabilities<Backend extends DeviceAdminBackend, Evidence>(ports: DeviceAdminDiagnosticsPorts<Backend, Evidence>): void {
    const diagnostics = createDeviceAdminDiagnostics(ports);
    const smoke = diagnostics.smoke("project", 5_000, undefined, { mcpSurface: true });
    for (const row of smoke.results) {
        const status: "PASS" | "SKIP" | "FAIL" = row.status;
        const reason: DiagnosticRow<Evidence>["reason"] = row.reason;
        const evidence: Evidence[] = row.evidence;
        void [status, reason, evidence];
    }
    for (const backend of diagnostics.benchHealth("project").backends) {
        const evidence: Evidence | undefined = backend.evidence;
        for (const device of backend.devices) {
            const membership: "present" | "missing" | "unknown" = device.inventoryState;
            void membership;
        }
        void evidence;
    }
    const { probeInstalledSurface, ...withoutInstalled } = ports;
    // @ts-expect-error Installed diagnostics require their finite native probe.
    createDeviceAdminDiagnostics(withoutInstalled);
    const { readPhysicalLease, ...withoutLeaseRead } = ports;
    // @ts-expect-error Bench policy requires authoritative physical lease observation.
    createDeviceAdminDiagnostics(withoutLeaseRead);
    // @ts-expect-error Synchronous diagnostics must receive settled physical inventory facts.
    createDeviceAdminDiagnostics<Backend, Evidence>({ ...ports, probeAndroidPhysicalInventory: async () => ({ state: "available" as const, tokens: [] }) });
    const probe = probeInstalledSurface(15_000);
    const state: "available" | "missing" | "failed" | "invalid" = probe.state;
    const evidence: Evidence | undefined = probe.evidence;
    void [state, evidence, readPhysicalLease];
}
void consumedDiagnosticCapabilities;

async function consumedSetupCapabilities<Evidence>(ports: DeviceAdminSetupPorts<Evidence>): Promise<void> {
    const result = await createDeviceAdminSetup(ports).setup(true, { acceptWindowsEvaluationLicense: true });
    if (!result.ok) {
        const reason: string = result.reason;
        const evidence: Evidence | undefined = result.evidence;
        void [reason, evidence];
    } else if (result.mode === "confirmed") {
        const receipt: Evidence | null = result.receipt;
        const gateway: string = result.network.gateway;
        void [receipt, gateway];
    } else {
        const accepted: boolean = result.licenseAccepted;
        const available: boolean = result.readiness.available;
        void [accepted, available];
    }
    const { enableFeature, ...withoutFeature } = ports;
    // @ts-expect-error Confirmed setup requires its named feature effect.
    createDeviceAdminSetup(withoutFeature);
    const { withMutationLock, ...withoutLock } = ports;
    // @ts-expect-error Feature and fabric preparation require guarded host authority.
    createDeviceAdminSetup(withoutLock);
    // @ts-expect-error Feature facts must settle before the fabric effect is selected.
    createDeviceAdminSetup({ ...ports, enableFeature: async () => ({ state: "invalid" as const }) });
    // @ts-expect-error Receipt publication must settle before confirmed success is returned.
    createDeviceAdminSetup<Evidence>({ ...ports, acceptEvaluationLicense: async () => ports.acceptEvaluationLicense() });
    const feature = enableFeature(900_000);
    if (feature.state === "available") {
        const enabled: boolean = feature.value.ok;
        const evidence: Evidence | undefined = feature.evidence;
        void [enabled, evidence];
    }
    void withMutationLock;
}
void consumedSetupCapabilities;

import { createDeviceAdminCleanup, createDeviceAdminAllProjectCleanup } from "../../application/device-admin-cleanup.js";
import type { DeviceAdminAllProjectCleanupPorts } from "../../ports/device-admin-cleanup.js";
import type { CleanupBackend, CleanupStopEffect, CleanupDeviceResult } from "../../domain/device-admin-cleanup.js";

function consumedCleanupCapabilities<Backend extends CleanupBackend>(ports: DeviceAdminAllProjectCleanupPorts<Backend>): void {
    const effects: readonly CleanupStopEffect[] = [{ kind: "android-emulator-stop", device: { id: "owned", serial: "emulator-5554" } }];
    const stopped = ports.executeStopEffects(effects, 5_000);
    const ok: boolean = stopped.ok;
    const commands: CleanupDeviceResult["commands"] = stopped.commands;
    const report = createDeviceAdminAllProjectCleanup(ports).allProjects(5_000);
    for (const project of report.projects) {
        const ownerId: string = project.ownerId;
        const outcomes: CleanupDeviceResult[] = project.results;
        void [ownerId, outcomes];
    }
    const { executeStopEffects, ...withoutEffects } = ports;
    // @ts-expect-error Cleanup requires a finite native stop effect capability.
    createDeviceAdminCleanup(withoutEffects);
    // @ts-expect-error Native effect facts must settle before process waits and publication.
    createDeviceAdminCleanup({ ...ports, executeStopEffects: async () => ({ ok: true, commands: [] }) });
    // @ts-expect-error Arbitrary executable recipes are outside the finite cleanup vocabulary.
    ports.executeStopEffects([{ kind: "command", device: { id: "owned" }, command: "adb", args: [] }], 5_000);
    void [ok, commands, executeStopEffects];
}
void consumedCleanupCapabilities;
