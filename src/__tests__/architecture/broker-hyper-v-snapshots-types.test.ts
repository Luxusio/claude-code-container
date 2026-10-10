import { describe, expect, it } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import { snapshotCheckpointPolicy, type SnapshotOwnerTarget, type SnapshotRepairResult, type SnapshotRpcResponse } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";

function snapshotCapabilityContracts(ports: BrokerHyperVSnapshotPorts, target: SnapshotOwnerTarget): void {
    const application = createBrokerHyperVSnapshotApplication(ports);
    const operation: Promise<SnapshotRpcResponse> = application.invoke("owner", {
        tool: "device_snapshot_create", deviceId: "vm", params: { snapshotName: "baseline", incarnationId: "generation" },
    }, target);
    const repair: Promise<SnapshotRepairResult> = application.repair("owner", {
        backend: "linux-vm", deviceId: "vm", device: target.device, executable: "/controlled/provider",
    }, "exact-checkpoint-id");
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
    void [operation, repair, readJournal, recordCreatedId, publish];
}
void snapshotCapabilityContracts;

describe("Hyper-V snapshot consumed policy types", () => {
    it("uses production checkpoints for Linux and production-only checkpoints for Windows", () => {
        expect(snapshotCheckpointPolicy("linux-vm")).toBe("Production");
        expect(snapshotCheckpointPolicy("windows-vm")).toBe("ProductionOnly");
    });
});
