import type { HyperVReadiness, HyperVLinuxImageReadiness } from "../domain/device-admin-diagnostics.js";
import type { SetupContext, SetupObservation, SetupProbe, HostNetworkResult } from "../domain/device-admin-setup.js";
export type DeviceAdminSetupPorts<Evidence = unknown> = {
    prepareContext(confirm: boolean): SetupContext<Evidence>;
    prepareMutation(): SetupContext<Evidence>;
    now(): number;
    diagnose(timeoutMs: number): SetupProbe<HyperVReadiness, Evidence>;
    linuxImage(ownerId: string, readiness: HyperVReadiness): HyperVLinuxImageReadiness;
    enableFeature(timeoutMs: number): SetupProbe<SetupObservation, Evidence>;
    withMutationLock<T>(operation: () => Promise<T>, options: { waitMs: number; staleMs: number }): Promise<T>;
    ensureHostNetwork(deadlineAt: number): Promise<Extract<HostNetworkResult, { ok: true }> | { ok: false; evidence: Evidence }>;
    mutationFailure(error: unknown): Evidence;
    readEvaluationReceipt(): Evidence | null;
    acceptEvaluationLicense(): Evidence;
};
