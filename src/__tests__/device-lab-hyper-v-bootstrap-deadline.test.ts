import { describe, expect, it, vi } from "vitest";
import {
    cleanupDeviceLabHyperVBootstrapNetwork,
    probeDeviceLabHyperVBootstrapNetwork,
} from "@ccc/device-lab/device-lab/broker/hyper-v/bootstrap-network-adapter.js";
import { HyperVOperationDeadlineError, hyperVRemainingTimeout } from "@ccc/device-lab/device-lab/broker/hyper-v/deadline.js";
import type { DeviceLabHyperVWindowsClientOptions } from "@ccc/device-lab/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { HyperVWindowsExecutionRequest, HyperVWindowsExecutionResult } from "@ccc/hyper-v/index.js";

const VM = { vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", vmName: "owned-vm", ownershipMarker: "ccc-device-lab:owner:device:incarnation" };
const MANAGED_MAC = "02:15:5d:01:1a:2c";
const BOOTSTRAP_MAC = "06:15:5d:01:1a:2c";
const ADAPTER = {
    vmId: VM.vmId, vmName: VM.vmName, name: "CCC Bootstrap DHCP", switchId: null,
    switchName: "Default Switch", status: "Ok", managementOperatingSystem: false,
    macAddress: BOOTSTRAP_MAC, ipAddresses: ["172.20.0.9"],
};

type Request = HyperVWindowsExecutionRequest;
type Dispatch = (request: Request) => HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>;
function success(operation: Request["operation"], items: readonly unknown[] = []): HyperVWindowsExecutionResult {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }) };
}

// Every call still traverses the production typed client and transport; only the native boundary is inert.
function fixture(transport: "one-shot" | "session") {
    let now = 100;
    let deadlineAt = 1100;
    let removed = false;
    const requests: Request[] = [];
    const callbackErrors: HyperVOperationDeadlineError[] = [];
    const respond: Dispatch = request => {
        switch (request.operation) {
            case "Get-VM": return success(request.operation, [{ id: VM.vmId, name: VM.vmName, notes: VM.ownershipMarker }]);
            case "Get-VMNetworkAdapter":
                return success(request.operation, "managementSwitchName" in request
                    ? [{ ...ADAPTER, vmId: null, vmName: null, managementOperatingSystem: true, ipAddresses: ["172.20.0.1"] }]
                    : "selector" in request && !removed ? [ADAPTER] : []);
            case "Get-NetIPAddress": return success(request.operation, [{ interfaceIndex: 12, address: "172.20.0.1", prefixLength: 24,
                prefixOrigin: "Dhcp", suffixOrigin: "Dhcp", addressState: "Preferred", interfaceAlias: "vEthernet (Default Switch)" }]);
            case "Get-NetNeighbor": return success(request.operation);
            case "Remove-VMNetworkAdapter": removed = true; return success(request.operation);
            default: throw new Error(`unexpected-native-operation:${request.operation}`);
        }
    };
    let dispatch: Dispatch = respond;
    const execute = vi.fn((request: Request) => { requests.push(request); return dispatch(request); });
    const run = vi.fn<DeviceLabHyperVWindowsClientOptions["run"]>(command => {
        const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
        return execute(JSON.parse(memory.input) as Request);
    });
    const session = { execute };
    const options: DeviceLabHyperVWindowsClientOptions = {
        executable: "powershell.exe", now: () => now,
        timeoutMilliseconds: () => {
            try { return hyperVRemainingTimeout(deadlineAt, 30000, () => now); }
            catch (error) {
                if (error instanceof HyperVOperationDeadlineError) callbackErrors.push(error);
                throw error;
            }
        },
        run, ...(transport === "session" ? { session } : {}),
    };
    return { options, requests, run, execute, callbackErrors, respond,
        setNow: (value: number) => { now = value; },
        setDeadline: (value: number) => { deadlineAt = value; },
        dispatch: (value: Dispatch) => { dispatch = value; },
        removed: () => removed,
    };
}

for (const transport of ["one-shot", "session"] as const) {
    describe(`Device Lab bootstrap deadline through ${transport}`, () => {
        it("discovers and tears down through the actual typed transport", async () => {
            const f = fixture(transport);
            expect(await probeDeviceLabHyperVBootstrapNetwork(f.options, VM)).toEqual({
                execution: { mode: "exec", provider: "hyper-v", status: 0 }, observation: { ok: true, addresses: ["172.20.0.9"] },
            });
            expect(await cleanupDeviceLabHyperVBootstrapNetwork(f.options, VM, MANAGED_MAC)).toEqual({
                execution: { mode: "exec", provider: "hyper-v", status: 0 }, observation: { ok: true, removed: true, alreadyMissing: false },
            });
            expect(f.requests.map(request => request.operation)).toEqual([
                "Get-VM", "Get-VMNetworkAdapter", "Get-VMNetworkAdapter", "Get-NetIPAddress", "Get-NetNeighbor",
                "Get-VM", "Get-VMNetworkAdapter", "Remove-VMNetworkAdapter", "Get-VMNetworkAdapter",
            ]);
            expect(f.requests.find(request => request.operation === "Remove-VMNetworkAdapter")).toMatchObject({
                selector: { kind: "id", id: VM.vmId }, adapterName: ADAPTER.name,
                macAddress: "06155d011a2c", expectedNotes: VM.ownershipMarker,
            });
            if (transport === "session") expect(f.run).not.toHaveBeenCalled();
        });

        it("refuses a fractional first allowance before dispatch and preserves the exact callback error", async () => {
            const f = fixture(transport);
            f.setNow(1099.5);
            const caught = await probeDeviceLabHyperVBootstrapNetwork(f.options, VM).catch(error => error);
            expect(caught).toBeInstanceOf(HyperVOperationDeadlineError);
            expect(caught).toBe(f.callbackErrors[0]);
            expect(f.execute).not.toHaveBeenCalled();
            expect(f.run).not.toHaveBeenCalled();
        });

        it.each([
            ["a deadline-shaped message", () => { throw new Error("hyper-v-operation-deadline-exceeded"); }, "transport:Get-VM:executor-failed"],
            ["a deadline class thrown by the native runner", () => { throw new HyperVOperationDeadlineError(); }, "transport:Get-VM:executor-failed"],
            ["a returned transport timeout", () => ({ status: null, stdout: "", timedOut: true }), "transport:Get-VM:timeout"],
            ["a native failure envelope", () => ({ status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VM", ok: false, errorCode: "native-read-failed" }) }), "native:Get-VM:native-read-failed"],
            ["a malformed response", () => ({ status: 0, stdout: "not-json" }), "protocol:Get-VM:response-malformed"],
        ] satisfies readonly [string, Dispatch, string][])("keeps %s distinct from local refusal", async (_label, dispatch, expected) => {
            const f = fixture(transport);
            f.dispatch(dispatch);
            const outcome = await probeDeviceLabHyperVBootstrapNetwork(f.options, VM);
            expect(outcome).toEqual({ execution: { mode: "exec", provider: "hyper-v", status: 1, error: `hyper-v-windows-${expected}` }, observation: null });
            expect(f.callbackErrors).toEqual([]);
            expect(f.execute).toHaveBeenCalledOnce();
        });

        it("preserves a local neighbor cutoff without inventing a failed neighbor observation", async () => {
            const f = fixture(transport);
            f.dispatch(request => {
                const result = f.respond(request);
                if (request.operation === "Get-NetIPAddress") f.setNow(1099.5);
                return result;
            });
            const caught = await probeDeviceLabHyperVBootstrapNetwork(f.options, VM).catch(error => error);
            expect(caught).toBe(f.callbackErrors[0]);
            expect(caught).toBeInstanceOf(HyperVOperationDeadlineError);
            expect(f.requests.some(request => request.operation === "Get-NetNeighbor")).toBe(false);
        });

        it("retains the neighbor diagnostic for an actual native failure", async () => {
            const f = fixture(transport);
            f.dispatch(request => request.operation === "Get-NetNeighbor" ? { status: null, stdout: "", timedOut: true } : f.respond(request));
            expect(await probeDeviceLabHyperVBootstrapNetwork(f.options, VM)).toEqual({
                execution: { mode: "exec", provider: "hyper-v", status: 1, error: "hyper-v-bootstrap-neighbor-inspection-failed" }, observation: null,
            });
            expect(f.callbackErrors).toEqual([]);
        });

        it("keeps the first native rejection when concurrent sibling reads are refused locally", async () => {
            const f = fixture(transport);
            f.dispatch(request => {
                if (request.operation === "Get-VMNetworkAdapter" && "selector" in request) {
                    // The first parallel read fails natively; later sibling callbacks refuse before dispatch.
                    f.setNow(1099.5);
                    throw new Error("first-native-read-failed");
                }
                return f.respond(request);
            });
            expect(await probeDeviceLabHyperVBootstrapNetwork(f.options, VM)).toEqual({
                execution: { mode: "exec", provider: "hyper-v", status: 1, error: "hyper-v-windows-transport:Get-VMNetworkAdapter:executor-failed" }, observation: null,
            });
            expect(f.callbackErrors.length).toBeGreaterThan(0);
            expect(f.requests.map(request => request.operation)).toEqual(["Get-VM", "Get-VMNetworkAdapter"]);
        });

        it.each(["before-remove", "after-remove"] as const)("refuses teardown confirmation %s without reporting containment", async stage => {
            const f = fixture(transport);
            f.dispatch(request => {
                const result = f.respond(request);
                if (stage === "before-remove" && request.operation === "Get-VMNetworkAdapter" && "selector" in request
                    || stage === "after-remove" && request.operation === "Remove-VMNetworkAdapter") f.setNow(1099.5);
                return result;
            });
            const caught = await cleanupDeviceLabHyperVBootstrapNetwork(f.options, VM, MANAGED_MAC).catch(error => error);
            expect(caught).toBeInstanceOf(HyperVOperationDeadlineError);
            expect(caught).toBe(f.callbackErrors[0]);
            expect(f.removed()).toBe(stage === "after-remove");
            expect(f.requests.some(request => request.operation === "Get-VMNetworkAdapter" && !("selector" in request))).toBe(false);
            if (stage === "before-remove") expect(f.requests.some(request => request.operation === "Remove-VMNetworkAdapter")).toBe(false);
            // A different, explicitly supplied containment allowance may inspect/retry safely.
            f.setDeadline(2000);
            expect(await cleanupDeviceLabHyperVBootstrapNetwork(f.options, VM, MANAGED_MAC)).toMatchObject({
                execution: { status: 0 }, observation: { ok: true, removed: stage === "before-remove", alreadyMissing: stage === "after-remove" },
            });
        });
    });
}
