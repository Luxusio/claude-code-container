import { describe, expect, it } from "vitest";
import { createBrokerDeviceStatus, createBrokerService, createBrokerStatus } from "@ccc/device-lab/device-lab/application/broker-observation-status.js";
import type { BrokerDeviceStatusPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { DeviceStatusRequest } from "@ccc/device-lab/device-lab/domain/broker-observation.js";

function deviceStatusFixture(backend = "android-emulator") {
    const request: DeviceStatusRequest = { backend, stateKey: backend, deviceId: "device", command: "device_status", dryRun: false };
    const device = { id: "device", status: "stopped", vmId: "owned-vm", vmName: "owned-name" };
    const ports: BrokerDeviceStatusPorts = {
        preview: () => ({ ok: true, plan: { device, providerCommand: { mode: "exec", provider: "adb", executable: "adb" } } }),
        refreshPhysicalLease: () => null,
        execute: () => ({ mode: "exec", provider: "adb", status: 0, stdout: "device\n", stderr: "" }),
        executeHyperV: async () => { throw new Error("record-qualified status must use the typed VM observation"); },
        typedStatus: async () => ({ mode: "exec", provider: "hyper-v", status: 0, stdout: "observation" }),
        succeeded: execution => execution.status === 0,
        parseVm: () => ({ vmId: "owned-vm", vmName: "owned-name", state: "Running", status: "OK" }),
        incarnation: () => "a".repeat(32), validIncarnation: (value): value is string => typeof value === "string",
        deadlineExpired: () => false, assertDeadline: () => undefined, timestamp: () => "2026-10-11T00:00:00.000Z",
        redactPlan: plan => plan, redactDevice: value => value, redactExecution: value => value,
        failureDetail: execution => execution.stderr || "provider failure", diagnosticCode: (_execution, fallback) => fallback,
        operationPending: () => false, snapshotPending: () => false, readDevices: () => [device],
        readOperationJournal: () => null, readSnapshotJournal: () => null,
        reconcileOperation: async () => ({ ok: true }), repairSnapshots: async () => ({ ok: true }),
        executable: () => "powershell", stateErrorCode: () => null,
        stateFailure: () => ({ status: 409, payload: { ok: false } }), errorCode: (_error, fallback) => fallback,
        withHostLock: async (_deadline, operation) => operation(), lockTimedOut: () => false,
    };
    return { request, device, ports };
}

describe("broker device status", () => {
    it("does not tolerate an absent physical ADB target as a stopped emulator", async () => {
        const f = deviceStatusFixture("android-device");
        f.ports.execute = () => ({ mode: "exec", provider: "adb", status: 1, stdout: "", stderr: "target absent" });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            status: 502, payload: { ok: false, error: "provider-command-failed", detail: "target absent",
                result: { device: f.device, execution: { command: { status: 1 } } } },
        });
    });

    it("reports offline ADB state without inventing readiness or changing the stored definition", async () => {
        const f = deviceStatusFixture();
        f.ports.execute = () => ({ mode: "exec", provider: "adb", status: 0, stdout: "offline\n" });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            status: 200, payload: { result: { device: { status: "stopped", runtimeState: "offline" } } },
        });
        expect(f.device).toEqual({ id: "device", status: "stopped", vmId: "owned-vm", vmName: "owned-name" });
    });

    it("refuses a successful native command whose Hyper-V observation is malformed", async () => {
        const f = deviceStatusFixture("windows-vm"); f.ports.parseVm = () => null;
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            status: 502, payload: { ok: false, error: "provider-command-failed", detail: "hyper-v-provider-command-failed", result: { device: f.device } },
        });
    });

    it("reports deadline expiry after a native observation instead of publishing apparent success", async () => {
        const f = deviceStatusFixture("linux-vm");
        f.ports.typedStatus = async () => { f.ports.deadlineExpired = () => true; return { mode: "exec", provider: "hyper-v", status: 0 }; };
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {}, 10)).toMatchObject({
            status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded" },
        });
        expect(f.device.status).toBe("stopped");
    });

    it("refuses a valid Hyper-V observation belonging to another VM", async () => {
        const f = deviceStatusFixture("windows-vm");
        f.ports.parseVm = () => ({ vmId: "foreign-vm", vmName: "owned-name", state: "Running", status: "OK" });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            status: 502, payload: { ok: false, error: "provider-command-failed", result: { device: f.device } },
        });
    });

    it("retains operation-only recovery without introducing snapshot incarnation admission", async () => {
        const f = deviceStatusFixture("linux-vm");
        f.ports.operationPending = () => true;
        f.ports.validIncarnation = (_value): _value is string => { throw new Error("operation-only recovery must not require snapshot incarnation admission"); };
        f.ports.reconcileOperation = async (_owner, _backend, _id, _deadline, preserveNetwork) => {
            expect(preserveNetwork).toBe(true);
            return { ok: false, status: 502, error: "recovery-native-failed", detail: "retained network" };
        };
        expect(await createBrokerDeviceStatus(f.ports).invoke("owner", f.request, {})).toMatchObject({
            status: 502, payload: { ok: false, error: "recovery-native-failed", detail: "retained network" },
        });
    });

    it("projects only this owner's live snapshots without modifying stored status", async () => {
        const f = deviceStatusFixture("windows-vm");
        f.ports.parseVm = () => ({ vmId: "owned-vm", vmName: "owned-name", state: "Running", status: "OK", snapshots: [
            { snapshotId: "ABC", snapshotName: "ccc-owner-baseline", snapshotType: "Production" },
            { snapshotId: "DEF", snapshotName: "ccc-foreign-baseline" },
        ] });
        expect(await createBrokerDeviceStatus(f.ports).execute("owner", f.request, {})).toMatchObject({
            status: 200, payload: { result: { device: { status: "running", liveSnapshots: [
                { id: "abc", providerName: "ccc-owner-baseline", snapshotType: "Production" },
            ] } } },
        });
        expect(f.device.status).toBe("stopped");
    });
});

describe("broker status fact sequencing", () => {
    it("retains separate presence reads and compares service ownership only after its projection", () => {
        const trace: string[] = []; let exists = 0;
        const owner = { get ownerId() { trace.push("owner-id"); return "owner"; } };
        const observe = createBrokerStatus({
            root: () => { trace.push("root"); return "root"; }, service: () => { trace.push("service"); return {}; },
            serviceOwner: () => { trace.push("owner"); return owner; }, runtimeFile: () => { trace.push("runtime-file"); return "runtime"; },
            runtime: () => { trace.push("runtime"); return null; }, address: () => { trace.push("address"); return {}; },
            hostId: () => { trace.push("host"); return "host"; }, pid: () => { trace.push("pid-field"); return 1; },
            startToken: () => { trace.push("pid-token"); return "token"; }, startedAt: () => { trace.push("started"); return "started"; },
            paths: () => { trace.push("paths"); return {}; }, exists: () => { trace.push("exists"); return ++exists === 2; },
            persistence: () => { trace.push("persistence"); return {}; }, serviceFacts: () => { trace.push("service-facts"); return {}; },
            elevation: () => { trace.push("elevation"); return {}; },
        });
        const value = observe("owner", {});
        expect(trace).toEqual(["root", "service", "owner", "runtime-file", "runtime", "address", "host", "pid-field", "pid-token", "started", "paths", "exists", "exists", "persistence", "service-facts", "owner-id", "elevation"]);
        expect(value.rootExists).toBe(false); expect(value.deviceStateMounted).toBe(true); expect(value.runtimeFacts.present).toBe(false); expect(value.ownedByCurrentOwner).toBe(true);
    });
});

function serviceFixture(supported = true, dryRun = false) {
    const trace: string[] = [];
    const plan = { supported, definitionPath: "definition", diagnostics: ["diagnostic"] };
    const observe = createBrokerService({
        plan: () => { trace.push("plan"); return plan; }, commands: () => { trace.push("commands"); return [1, 2]; },
        dryRun: () => { trace.push("dry-run"); return dryRun; }, owner: () => { trace.push("owner"); return { ownerId: "owner" }; },
        installed: () => { trace.push("installed"); return false; },
        query: (_context: object, command: number) => { trace.push("query:" + command); return { mode: "observed", provider: "service", command }; },
        succeeded: () => { trace.push("succeeded"); return false; },
        projection: (source, commands) => { trace.push("projection"); return { ...source, commands }; },
        diagnostics: source => { trace.push("diagnostics"); return source.diagnostics; },
    }, new Set(["status"]));
    return { trace, observe: (action = "status") => observe("owner", action, {}) };
}

describe("broker service status policy", () => {
    it("runs all queries before classifying the first and keeps failed query as a false running observation", () => {
        const f = serviceFixture(); const value = f.observe();
        expect(value.kind).toBe("observed"); if (value.kind === "observed") expect(value.value.running).toBe(false);
        expect(f.trace).toEqual(["plan", "commands", "dry-run", "owner", "installed", "query:1", "query:2", "succeeded", "projection", "diagnostics"]);
    });
    it.each([[false, false, "unsupported"], [true, true, "dry-run"]] as const)("reads existing facts before %s/%s branch", (supported, dryRun, kind) => {
        const f = serviceFixture(supported, dryRun); expect(f.observe().kind).toBe(kind);
        expect(f.trace).toEqual(["plan", "commands", "dry-run", "owner", "installed", "projection", "diagnostics"]);
    });
    it("refuses a mutating action without constructing a native plan", () => {
        const f = serviceFixture(); expect(f.observe("start")).toEqual({ kind: "invalid-action", action: "start", allowed: ["status"] }); expect(f.trace).toEqual([]);
    });
});
