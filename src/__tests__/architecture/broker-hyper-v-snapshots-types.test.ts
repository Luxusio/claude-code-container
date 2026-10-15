import { describe, expect, it } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import { snapshotCheckpointPolicy, type SnapshotOwnerTarget, type SnapshotRepairResult, type SnapshotOutcome, type SnapshotExecution, type SnapshotVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";

type Connection = { readonly providerId: string };
type Receipt = { readonly nativeEvidence: string };

function snapshotCapabilityContracts(ports: BrokerHyperVSnapshotPorts<Connection, Receipt>, target: SnapshotOwnerTarget, connection: Connection): void {
    const application = createBrokerHyperVSnapshotApplication(ports);
    const operation: Promise<SnapshotOutcome<Receipt>> = application.invoke("owner", {
        tool: "device_snapshot_create", deviceId: "vm", params: { snapshotName: "baseline", incarnationId: "generation" },
    }, target);
    const repair: Promise<SnapshotRepairResult> = application.repair("owner", {
        backend: "linux-vm", deviceId: "vm", device: target.device, connection,
    }, "exact-checkpoint-id");
    const completed: SnapshotExecution<Receipt> = { ok: true };
    const failed: SnapshotExecution<Receipt> = { ok: false, receipt: { nativeEvidence: "opaque" } };
    const status: Promise<{ execution: SnapshotExecution<Receipt>; observation: SnapshotVmObservation | null }> = ports.status(connection,
        { ownerId: "owner", deviceId: "vm", incarnationId: "generation", vmName: "vm", vmId: "native-vm" }, 45000, 30000);
    const readiness: Promise<{ ready: boolean; execution: SnapshotExecution<Receipt> }> = ports.sshReady(connection,
        { deviceRoot: "/device", sshPrivateKeyPath: "/key", knownHostsPath: "/known-hosts", guestUsername: "guest", networkAddress: "192.0.2.5" });
    ports.diagnosticCode(failed, "fallback", "typed-provider-code");
    ports.diagnosticCode(null, "fallback");
    // @ts-expect-error A native receipt alone cannot classify an execution.
    const unclassified: SnapshotExecution<Receipt> = { receipt: { nativeEvidence: "opaque" } };
    // @ts-expect-error Native process fields do not belong to inward execution facts.
    const rawExecution: SnapshotExecution<Receipt> = { ok: true, status: 0 };
    // @ts-expect-error Application decisions cannot inspect raw native stdout.
    completed.stdout;
    // @ts-expect-error Status decoding belongs to the outer producer, not a separate inward parser.
    ports.parseStatus;
    // @ts-expect-error Status must supply its decoded observation alongside semantic completion.
    createBrokerHyperVSnapshotApplication({ ...ports, status: async () => ({ ok: true }) });
    // @ts-expect-error Status cannot return a native command result instead of semantic completion.
    createBrokerHyperVSnapshotApplication({ ...ports, status: async () => ({ execution: { status: 0 }, observation: null }) });
    // @ts-expect-error SSH completion alone cannot establish guest readiness.
    createBrokerHyperVSnapshotApplication({ ...ports, sshReady: async () => ({ execution: completed }) });
    // @ts-expect-error Diagnostics accept semantic completion or null, not raw process fields.
    ports.diagnosticCode({ status: 0 }, "fallback");
    const { readJournal, ...withoutJournalRead } = ports;
    // @ts-expect-error Pending operation evidence must be read through a required guarded capability.
    createBrokerHyperVSnapshotApplication(withoutJournalRead);
    const { recordCreatedId, ...withoutCreatedId } = ports;
    // @ts-expect-error Native created-ID confirmation must have durable staging authority.
    createBrokerHyperVSnapshotApplication(withoutCreatedId);
    const { publish, ...withoutPublication } = ports;
    // @ts-expect-error Action publication requires its expected-record comparison capability.
    createBrokerHyperVSnapshotApplication(withoutPublication);
    // @ts-expect-error Action publication must return a settled CAS result synchronously.
    createBrokerHyperVSnapshotApplication({ ...ports, publish: async () => ({ found: true, matched: true, device: target.device }) });
    // @ts-expect-error A native deletion result must confirm deletion, not merely identify a checkpoint.
    createBrokerHyperVSnapshotApplication({ ...ports, delete: async () => ({ ok: true, snapshotId: "checkpoint", snapshotName: "owned" }) });
    // @ts-expect-error Repair policy admits only zero or one exact candidate; ambiguity is not a valid result.
    createBrokerHyperVSnapshotApplication({ ...ports, repairPolicy: async () => ({ checkpointPolicy: "Production", candidateCount: 2 }) });
    void [operation, repair, completed, failed, status, readiness, unclassified, rawExecution, readJournal, recordCreatedId, publish];
}
void snapshotCapabilityContracts;

describe("Hyper-V snapshot consumed policy types", () => {
    it("uses production checkpoints for Linux and production-only checkpoints for Windows", () => {
        expect(snapshotCheckpointPolicy("linux-vm")).toBe("Production");
        expect(snapshotCheckpointPolicy("windows-vm")).toBe("ProductionOnly");
    });
});
