import { describe, expect, it } from "vitest";
import { createBrokerDeviceStatus, createBrokerService } from "@ccc/device-lab/device-lab/application/broker-observation-status.js";
import type { BrokerDeviceStatusPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { DeviceStatusExecution, DeviceStatusRequest } from "@ccc/device-lab/device-lab/domain/broker-observation.js";

function deviceStatusFixture(backend = "android-emulator") {
    const request: DeviceStatusRequest = { backend, stateKey: backend, deviceId: "device", command: "device_status", dryRun: false };
    const device = { id: "device", status: "stopped", vmId: "owned-vm", vmName: "owned-name" };
    const connection = { token: "controlled-status" };
    const vmExecution: DeviceStatusExecution<object> = {
        mode: "exec", provider: "hyper-v", ok: true, adbState: null,
        vm: { vmId: "owned-vm", vmName: "owned-name", state: "Running", status: "OK" },
        receipt: { status: 0, stdout: "observation" },
    };
    const ports: BrokerDeviceStatusPorts<typeof connection, object> = {
        preview: () => ({ kind: "prepared", plan: { ownerId: "owner", backend, stateKey: backend, command: "device_status", deviceId: "device", device,
            availability: { kind: "available", connection, mode: "exec", provider: "adb" } } }),
        refreshPhysicalLease: () => ({ kind: "admitted" }),
        observe: () => ({ mode: "exec", provider: "adb", ok: true, adbState: "device", vm: null, receipt: { status: 0, stdout: "device\n", stderr: "" } }),
        observeHyperVFallback: async () => { throw new Error("record-qualified status must use the typed VM observation"); },
        typedStatus: async () => vmExecution,
        incarnation: () => "a".repeat(32), validIncarnation: (value): value is string => typeof value === "string",
        deadlineExpired: () => false, assertDeadline: () => undefined, timestamp: () => "2026-10-11T00:00:00.000Z",
        diagnosticCode: (_execution, fallback) => fallback,
        operationPending: () => false, snapshotPending: () => false, readDevices: () => [device],
        readOperationJournal: () => null, readSnapshotJournal: () => null,
        reconcileOperation: async () => ({ ok: true, reconciled: false }),
        repairSnapshots: async () => ({ ok: true, device, reconciled: false, journalDisposition: "clear" }),
        recoveryConnection: () => connection, stateErrorCode: () => null,
        stateFailure: () => ({ reason: "conflict", error: "owner-device-state-read-failed" }), errorCode: (_error, fallback) => fallback,
        withHostLock: async (_deadline, operation) => operation(), lockTimedOut: () => false,
    };
    return { request, device, ports, vmExecution };
}

describe("broker device status", () => {
    it("does not tolerate an absent physical ADB target as a stopped emulator", async () => {
        const f = deviceStatusFixture("android-device");
        f.ports.observe = () => ({ mode: "exec", provider: "adb", ok: false, adbState: null, vm: null, receipt: { status: 1, stdout: "", stderr: "target absent" } });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            kind: "provider-failed", error: "provider-command-failed", device: f.device,
            execution: { ok: false, receipt: { status: 1, stderr: "target absent" } },
        });
    });

    it("reports offline ADB state without inventing readiness or changing the stored definition", async () => {
        const f = deviceStatusFixture();
        f.ports.observe = () => ({ mode: "exec", provider: "adb", ok: true, adbState: "offline", vm: null, receipt: { status: 0, stdout: "offline\n" } });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            kind: "observed", device: { status: "stopped", runtimeState: "offline" },
        });
        expect(f.device).toEqual({ id: "device", status: "stopped", vmId: "owned-vm", vmName: "owned-name" });
    });

    it("refuses a successful native command whose Hyper-V observation is malformed", async () => {
        const f = deviceStatusFixture("windows-vm"); f.vmExecution.vm = null;
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            kind: "provider-failed", error: "provider-command-failed", diagnostic: "hyper-v-provider-command-failed", device: f.device,
        });
    });

    it("reports deadline expiry after a native observation instead of publishing apparent success", async () => {
        const f = deviceStatusFixture("linux-vm");
        f.ports.typedStatus = async () => { f.ports.deadlineExpired = () => true; return f.vmExecution; };
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {}, 10)).toMatchObject({
            kind: "refused", reason: "deadline", error: "hyper-v-operation-deadline-exceeded",
        });
        expect(f.device.status).toBe("stopped");
    });

    it("refuses a valid Hyper-V observation belonging to another VM", async () => {
        const f = deviceStatusFixture("windows-vm");
        f.vmExecution.vm = { vmId: "foreign-vm", vmName: "owned-name", state: "Running", status: "OK" };
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            kind: "provider-failed", error: "provider-command-failed", device: f.device,
        });
    });

    it("retains operation-only recovery without introducing snapshot incarnation admission", async () => {
        const f = deviceStatusFixture("linux-vm");
        f.ports.operationPending = () => true;
        f.ports.validIncarnation = (_value): _value is string => { throw new Error("operation-only recovery must not require snapshot incarnation admission"); };
        f.ports.reconcileOperation = async (_owner, _backend, _id, _deadline, preserveNetwork) => {
            expect(preserveNetwork).toBe(true);
            return { ok: false, reason: "provider-failed", journalDisposition: "retain", error: "recovery-native-failed", detail: "retained network" };
        };
        expect(await createBrokerDeviceStatus(f.ports).invoke("owner", f.request, {})).toMatchObject({
            kind: "refused", reason: "provider-failed", error: "recovery-native-failed", detail: "retained network",
        });
    });

    it("projects only this owner's live snapshots without modifying stored status", async () => {
        const f = deviceStatusFixture("windows-vm");
        f.vmExecution.vm = { vmId: "owned-vm", vmName: "owned-name", state: "Running", status: "OK", snapshots: [
            { snapshotId: "ABC", snapshotName: "ccc-owner-baseline", snapshotType: "Production" },
            { snapshotId: "DEF", snapshotName: "ccc-foreign-baseline" },
        ] };
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            kind: "observed", device: { status: "running", liveSnapshots: [
                { id: "abc", providerName: "ccc-owner-baseline", snapshotType: "Production" },
            ] },
        });
        expect(f.device.status).toBe("stopped");
    });
});

function serviceFixture(supported = true, dryRun = false) {
    const queries: number[] = []; let planCalls = 0;
    const plan = { supported, definitionPath: "definition", diagnostics: ["diagnostic"] };
    const observe = createBrokerService({
        plan: () => { planCalls++; return plan; }, commands: () => [1, 2],
        dryRun: () => dryRun, owner: () => ({ ownerId: "owner" }), installed: () => false,
        query: (_context: object, command: number) => { queries.push(command); return { mode: "observed", provider: "service", command }; },
        succeeded: () => false, projection: (source, commands) => ({ ...source, commands }),
        diagnostics: source => source.diagnostics,
    }, new Set(["status"]));
    return { queries, planCalls: () => planCalls, observe: (action = "status") => observe("owner", action, {}) };
}

describe("broker service status policy", () => {
    it("observes both planned queries and reports failed status as not running", () => {
        const f = serviceFixture(); const value = f.observe();
        expect(value.kind).toBe("observed"); if (value.kind === "observed") expect(value.value.running).toBe(false);
        expect(f.queries).toEqual([1, 2]);
    });
    it.each([[false, false, "unsupported"], [true, true, "dry-run"]] as const)("does not query native status for supported:%s dryRun:%s", (supported, dryRun, kind) => {
        const f = serviceFixture(supported, dryRun); expect(f.observe().kind).toBe(kind);
        expect(f.queries).toEqual([]);
    });
    it("refuses a mutating action without constructing a native plan", () => {
        const f = serviceFixture(); expect(f.observe("start")).toEqual({ kind: "invalid-action", action: "start", allowed: ["status"] });
        expect(f.planCalls()).toBe(0); expect(f.queries).toEqual([]);
    });
});
