import { describe, expect, it } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import { snapshotCheckpointPolicy, type SnapshotAllowance, type SnapshotJournal, type SnapshotOwnerTarget, type SnapshotRepairResult, type SnapshotOutcome, type SnapshotExecution, type SnapshotVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts, SnapshotPublication } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";

type Connection = { readonly providerId: string };
type Receipt = { readonly nativeEvidence: string };

function snapshotCapabilityContracts(ports: BrokerHyperVSnapshotPorts<Connection, Receipt>, target: SnapshotOwnerTarget, connection: Connection): void {
    const application = createBrokerHyperVSnapshotApplication(ports);
    const allowance: SnapshotAllowance = { operationDeadlineAt: 75000, cleanupDeadlineAt: 105000 };
    const operation: Promise<SnapshotOutcome<Receipt>> = application.invoke("owner", {
        tool: "device_snapshot_create", deviceId: "vm", params: { snapshotName: "baseline", incarnationId: "generation" },
    }, target, allowance);
    const repair: Promise<SnapshotRepairResult> = application.repair("owner", {
        backend: "linux-vm", deviceId: "vm", device: target.device, connection,
    }, "exact-checkpoint-id");
    const completed: SnapshotExecution<Receipt> = { ok: true };
    const failed: SnapshotExecution<Receipt> = { ok: false, receipt: { nativeEvidence: "opaque" } };
    const providerErrorKind: "validation" | "untrusted-response" | null = ports.providerErrorKind(new Error("provider failure"));
    const status: Promise<{ execution: SnapshotExecution<Receipt>; observation: SnapshotVmObservation | null }> = ports.status(connection,
        { ownerId: "owner", deviceId: "vm", incarnationId: "generation", vmName: "vm", vmId: "native-vm" }, 45000, 30000);
    const readiness: Promise<{ ready: boolean; execution: SnapshotExecution<Receipt> }> = ports.sshReady(connection,
        { deviceRoot: "/device", sshPrivateKeyPath: "/key", knownHostsPath: "/known-hosts", guestUsername: "guest", networkAddress: "192.0.2.5" }, allowance.operationDeadlineAt);
    const journal: SnapshotJournal = ports.writeJournal("owner", "linux-vm", "vm", "generation",
        "device_snapshot_create", "baseline", "owned-provider-name", undefined, "Production");
    const recorded: SnapshotJournal | null = ports.recordCreatedId("owner", "linux-vm", "vm", target.device, journal, "created-checkpoint");
    const cleared: SnapshotPublication = ports.clearJournal("owner", "linux-vm", "vm", target.device, journal, () => undefined);
    const repaired: SnapshotPublication = ports.removeRepairJournal("owner", "linux-vm", "vm", target.device, journal, () => undefined);
    ports.publish("owner", "linux-vm", "vm", target.device, target.device, () => undefined);
    ports.restore(connection, { vmId: "vm", providerName: "owned", snapshotId: "checkpoint" },
        { force: false, startAfterRestore: true, deadlineAt: allowance.operationDeadlineAt });
    ports.delete(connection, { vmId: "vm", providerName: "owned", snapshotId: "checkpoint" }, allowance.cleanupDeadlineAt);
    ports.create(connection, { vmId: "vm", providerName: "owned", snapshotId: null }, {
        timeoutMilliseconds: () => 45000, remainingMilliseconds: () => 75000,
        monotonicNow: () => 0, onCreatedId: () => undefined,
    });
    // @ts-expect-error The immutable allowance cannot be renewed during a later phase.
    allowance.operationDeadlineAt = 120000;
    // @ts-expect-error Cleanup retains the same admission-captured immutable deadline.
    allowance.cleanupDeadlineAt = 150000;
    // @ts-expect-error Exact created-ID evidence requires its captured target and whole journal.
    ports.recordCreatedId("owner", "linux-vm", "vm", "generation", "owned-provider-name", "created-checkpoint");
    // @ts-expect-error Three IDs alone cannot authorize clearing recovery evidence.
    ports.clearJournal("owner", "linux-vm", "vm");
    // @ts-expect-error Repair clearing also needs a guard at its actual authority boundary.
    ports.removeRepairJournal("owner", "linux-vm", "vm", target.device, journal);
    // @ts-expect-error A journal write must return the actual captured journal, not unqualified void success.
    createBrokerHyperVSnapshotApplication({ ...ports, writeJournal: () => undefined });
    // @ts-expect-error Journal clearing must return a qualified settled publication result.
    createBrokerHyperVSnapshotApplication({ ...ports, clearJournal: () => undefined });
    // @ts-expect-error Repair clearing must also return its qualified settled publication result.
    createBrokerHyperVSnapshotApplication({ ...ports, removeRepairJournal: () => undefined });
    // @ts-expect-error Refused exact-ID recording is explicitly null, never unqualified void success.
    createBrokerHyperVSnapshotApplication({ ...ports, recordCreatedId: () => undefined });
    // @ts-expect-error Native restore must receive the invocation's remaining deadline authority.
    ports.restore(connection, { vmId: "vm", providerName: "owned", snapshotId: "checkpoint" }, { force: false, startAfterRestore: true });
    // @ts-expect-error Native deletion must receive action or cleanup deadline authority.
    ports.delete(connection, { vmId: "vm", providerName: "owned", snapshotId: "checkpoint" });
    ports.diagnosticCode(failed, "fallback", "typed-provider-code");
    ports.diagnosticCode(null, "fallback");
    // @ts-expect-error A validation-only predicate cannot distinguish an untrusted response from a native failure.
    ports.isValidationError(new Error("provider failure"));
    // @ts-expect-error Provider classification supplies semantic evidence rather than a boolean predicate.
    createBrokerHyperVSnapshotApplication({ ...ports, providerErrorKind: () => true });
    // @ts-expect-error Native protocol details must be mapped to the inward untrusted-response classification.
    createBrokerHyperVSnapshotApplication({ ...ports, providerErrorKind: () => "protocol" });
    const { providerErrorKind: classifyProviderError, ...withoutProviderErrorKind } = ports;
    // @ts-expect-error Failure reconciliation requires semantic provider classification at the boundary.
    createBrokerHyperVSnapshotApplication(withoutProviderErrorKind);
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
    void [operation, repair, completed, failed, providerErrorKind, status, readiness, journal, recorded, cleared, repaired,
        unclassified, rawExecution, readJournal, recordCreatedId, publish, classifyProviderError];
}
void snapshotCapabilityContracts;

describe("Hyper-V snapshot consumed policy types", () => {
    it("uses production checkpoints for Linux and production-only checkpoints for Windows", () => {
        expect(snapshotCheckpointPolicy("linux-vm")).toBe("Production");
        expect(snapshotCheckpointPolicy("windows-vm")).toBe("ProductionOnly");
    });
});
