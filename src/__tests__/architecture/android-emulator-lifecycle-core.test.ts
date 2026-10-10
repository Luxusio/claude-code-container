import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";
import { createAndroidEmulatorLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs";
import type { AndroidEmulatorDevice } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import { brokerLifecyclePorts, directLifecyclePorts } from "../helpers/android-emulator-lifecycle-fixture.js";
import { allocateBrokerAndroidCreatePort, createBrokerAndroidEmulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidCreatePortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/android-emulator-lifecycle.js";

// Existing checked broker policy is a migration prerequisite. These ORIGINAL
// controls retain lazy native port lookup/receiver identity and failure routing;
// they do not pretend the four lifecycle applications already exist.
describe("Android emulator allocation errors", () => {
    it("routes a native inventory error without replacing its identity", () => {
        const sentinel = {native:"inventory failure"};
        const parsed: LifecyclePreviewRequest = {backend:"android-emulator",stateKey:"android",command:"device_create",deviceId:"unit",force:false,dryRun:false,create:{port:5560}};
        const ports: AndroidPreviewPortAllocationPorts<LifecyclePreviewRequest> = {
            valid: (port): port is number => typeof port === "number" && port % 2 === 0,
            allocated: () => {throw sentinel;},
            inventoryError: error => {expect(error).toBe(sentinel);return "inventory error";},
            seed: () => 0,
        };
        expect(createAndroidPreviewPortAllocation(ports,5554,5682)("owner",parsed,[])).toEqual({kind:"inventory-failed",detail:"inventory error"});
    });
});

const brokerDevice = (): Record<string, unknown> => ({ id: "android-unit", backend: "android-emulator", avdName: "ccc-owner-unit", port: 5630, status: "stopped", extra: { raw: "retained" } });
describe("distinct canonical authenticated broker Android policy", () => {
    it("create allocation preserves preview refusal before live inventory and augments the same native live-port carrier", () => {
        const parsed = brokerLifecyclePorts().input("device_create").parsed, trace: string[] = [], live = new Set([5630]);
        const refusal = { ok: false as const, status: 400, error: "invalid-android-emulator-port" };
        const ports: BrokerAndroidCreatePortAllocationPorts = {
            previewAllocation: () => refusal,
            livePorts: () => { trace.push("live"); return { ok: true, ports: live }; },
        };
        expect(allocateBrokerAndroidCreatePort("owner", parsed, ports)).toBe(refusal); expect(trace).toEqual([]);
        const preview = (owner: string, observed: typeof parsed, additional?: Iterable<number>) => {
            expect(owner).toBe("owner"); expect(observed).toBe(parsed); trace.push("allocate");
            if (additional) expect(additional).toBe(live);
            return { ok: true as const, port: additional ? 5632 : 5630 };
        };
        expect(allocateBrokerAndroidCreatePort("owner", parsed, { ...ports, previewAllocation: preview })).toEqual({ ok: true, port: 5632 });
        expect(trace).toEqual(["allocate", "live", "allocate"]);
    });
    it("constructor is lazy and a live start port refuses before provider execution/publication", async () => {
        const f = brokerLifecyclePorts(brokerDevice());
        Object.defineProperty(f.ports, "livePorts", { get() { f.trace.push("get-live"); return () => ({ ok: true, ports: new Set([5630]) }); } });
        const app = createBrokerAndroidEmulatorLifecycle(f.ports); expect(f.trace).toEqual([]);
        const result = await app.start(f.input("device_start"));
        expect(result).toMatchObject({ status: 409, payload: { ok: false, error: "android-emulator-port-conflict", detail: "port-5630-already-in-use" } });
        expect(f.trace).toEqual(["get-live"]); expect(f.publications).toEqual([]);
    });
    it("broker create keeps native error identity and raw diagnostics while compensating before claim", async () => {
        const f = brokerLifecyclePorts(), failure = { mode: "exec", provider: "avdmanager", status: 17, error: "raw error", stderr: "raw stderr", stdout: "raw stdout" };
        f.ports.execute = () => failure;
        const detail = f.ports.failureDetail; f.ports.failureDetail = result => { expect(result).toBe(failure); return detail(result); };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).create(f.input("device_create", { create: { createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64", avdName: "ccc-owner-unit" } }));
        expect(result).toMatchObject({ status: 502, payload: { ok: false, error: "provider-command-failed", detail: "error: raw error\nstderr: raw stderr\nstdout: raw stdout", rollback: { ok: true } } });
        expect(f.trace).toContain("remove-avd"); expect(f.trace).not.toContain("claim"); expect(f.current()).toBeUndefined();
    });
    it("broker create loser preserves an external winner and removes only its inactive owned artifacts", async () => {
        const f = brokerLifecyclePorts(), winner = { ...brokerDevice(), avdName: "ccc-owner-winner", extra: { raw: "winner" } };
        f.ports.claimDefinition = () => { f.replace(winner); return { ok: false, error: "owner-device-id-conflict", field: "id", value: "android-unit", existing: winner }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).create(f.input("device_create", { create: { createAvd: true, avdName: "ccc-owner-unit", systemImage: "system-images;android-35;google_apis;x86_64" } }));
        expect(result).toMatchObject({ status: 409, payload: { ok: false, error: "owner-device-id-conflict", rollback: { attempted: true, ok: true } } });
        expect(f.current()).toBe(winner); expect(f.trace).toContain("remove-avd");
    });
    it("committed auxiliary cleanup advances the complete expected snapshot before stopped publication", async () => {
        const original: Record<string, unknown> = { ...brokerDevice(), status: "running", recording: { active: false, raw: "metadata" } }, f = brokerLifecyclePorts(original);
        const cleaned = { ...original, recording: null };
        f.ports.cleanupAuxiliary = (_owner, _parsed, expected) => { expect(expected).toBe(original); f.trace.push("cleanup"); f.replace(cleaned); return { committed: true, device: cleaned, result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop"));
        expect(result).toMatchObject({ status: 200, payload: { ok: true, result: { device: { status: "stopped", recording: null, extra: original.extra } } } });
        expect(f.publications).toEqual([cleaned]); expect(f.trace.indexOf("cleanup")).toBeLessThan(f.trace.indexOf("execute:adb"));
        expect(f.trace).toContain("processes");
    });
    it("auxiliary cleanup failure blocks provider execution and reports its committed native change truthfully", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), changed = { ...original, recording: null };
        f.ports.cleanupAuxiliary = () => { f.replace(changed); return { committed: true, device: changed, result: { ok: false, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop"));
        expect(result).toMatchObject({ status: 502, payload: { ok: false, error: "auxiliary-runtime-cleanup-failed", result: { invoked: false, execution: { providerExecution: "blocked", mutatesHost: true } } } });
        expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(changed);
    });
    it("a broker start boot failure leaves the original record while reporting the completed provider effect", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original); f.ports.executable = name => name === "adb" ? null : name;
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ status: 502, payload: { ok: false, error: "provider-command-failed", result: { execution: { providerExecution: "executed", mutatesHost: false, command: { registration: null, macosBoot: null, androidBoot: { ok: false } } } } } });
        expect(f.current()).toBe(original); expect(f.publications).toEqual([]); expect(f.commands).toHaveLength(1);
    });
    it("stop inventory uncertainty refuses final publication; a successful native effect cannot replace a successor", async () => {
        const original = { ...brokerDevice(), status: "running" }, f = brokerLifecyclePorts(original), app = createBrokerAndroidEmulatorLifecycle(f.ports);
        f.ports.execute = command => ({ ...command, status: 0, stdout: command.args?.[0] === "devices" ? "missing inventory header" : "", stderr: "" });
        const uncertain = await app.stop(f.input("device_stop"));
        expect(uncertain).toMatchObject({ status: 502, payload: { ok: false, error: "android-emulator-stop-unconfirmed" } }); expect(f.current()).toBe(original); expect(f.publications).toEqual([]);
        const successor = { ...original, extra: { raw: "successor" } };
        f.ports.execute = command => { if (command.args?.includes("kill")) f.replace(successor); return { ...command, status: 0, stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : "", stderr: "" }; };
        const conflicted = await app.stop(f.input("device_stop"));
        expect(conflicted).toMatchObject({ status: 409, payload: { ok: false, error: "owner-device-state-conflict" } }); expect(f.current()).toBe(successor);
    });
    it("AVD delete liveness/root refusals precede destructive provider execution and state removal", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), app = createBrokerAndroidEmulatorLifecycle(f.ports);
        f.ports.liveAvds = () => ({ ok: true, names: new Set(["ccc-owner-unit"]) });
        const active = await app.delete(f.input("device_delete", { deleteAvd: true }));
        expect(active).toMatchObject({ status: 409, payload: { error: "android-avd-active" } }); expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
        f.ports.liveAvds = () => ({ ok: true, names: new Set() }); f.ports.approvedAvdRoot = () => null;
        const root = await app.delete(f.input("device_delete", { deleteAvd: true }));
        expect(root).toMatchObject({ status: 409, payload: { error: "android-avd-root-unavailable" } }); expect(f.commands).toEqual([]); expect(f.current()).toBe(original);
    });
});

const stoppedDevice = (): AndroidEmulatorDevice => ({ id: "android-unit", backend: "android-emulator", avdName: "ccc-owner-unit", serial: "emulator-5630", port: 5630, status: "stopped", extra: { raw: "retained" } });
describe("canonical direct Android emulator lifecycle policy", () => {
    it("constructor defers effect lookup and allocation refusal precedes native discovery/read/provision", async () => {
        const f = directLifecyclePorts();
        Object.defineProperty(f.ports, "resolveAndroidEmulatorPort", { get() { f.trace.push("get-allocate"); return () => ({ ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" }); } });
        const app = createAndroidEmulatorLifecycle(f.ports); expect(f.trace).toEqual([]);
        expect(await app.create({ backend: "other" })).toBeUndefined(); expect(f.trace).toEqual([]);
        expect(await app.create({ backend: "android-emulator", name: "Unit", port: 5555 })).toEqual({ ok: false, text: "invalid-android-emulator-port (even integer 5554-5682)" });
        expect(f.trace).toEqual(["get-allocate"]);
    });
    it("create reallocates a live default port before duplicate admission and keeps raw created carriers", async () => {
        const f = directLifecyclePorts(), live = new Set([5630]); let allocations = 0;
        f.ports.liveAndroidEmulatorPortsForAllocation = () => ({ ok: true, ports: live });
        f.ports.resolveAndroidEmulatorPort = (_owner, _id, _port, additional) => { f.trace.push("allocate"); allocations++; if (allocations === 2) expect(additional).toBe(live); return { ok: true, port: allocations === 1 ? 5630 : 5632 }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).create({ backend: "android-emulator", name: "Unit" });
        expect(result).toMatchObject({ ok: true, payload: { device: { id: "android-unit", port: 5632, serial: "emulator-5632", avdRoot: null, systemImage: null, deviceProfile: null, provisioned: false, status: "stopped", headless: true } } });
        expect(f.trace).toEqual(["allocate", "allocate", "read", "claim"]);
    });
    it("failed provisioning compensates only owned inactive artifacts and forwards the exact native failure", async () => {
        const f = directLifecyclePorts(), failure = { status: 17, stdout: "raw stdout", stderr: "raw stderr", native: {} };
        f.ports.runWithInput = () => failure;
        const result = await createAndroidEmulatorLifecycle(f.ports).create({ backend: "android-emulator", name: "Unit", createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64" });
        expect(result?.failure).toBe(failure); expect(f.trace.slice(-2)).toEqual(["remove-avd", "inactive"]); expect(f.current()).toBeUndefined();
    });
    it("claim throw preserves error identity after compensation and refuses unverified rollback", async () => {
        const f = directLifecyclePorts(), thrown = new Error("native claim failure");
        f.ports.claimAndroidDevice = () => { throw thrown; };
        const app = createAndroidEmulatorLifecycle(f.ports), args = { backend: "android-emulator", name: "Unit", createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64" };
        await expect(app.create(args)).rejects.toBe(thrown); expect(f.trace).toContain("remove-avd");
        f.trace.length = 0; f.ports.androidAvdIsInactive = () => false;
        expect(await app.create(args)).toEqual({ ok: false, text: "Owner device state update failed; Android AVD rollback blocked because liveness is unverified" });
        expect(f.trace).not.toContain("remove-avd");
    });
    it("missing start/stop/delete fall through without discovery or native work", async () => {
        const f = directLifecyclePorts(), app = createAndroidEmulatorLifecycle(f.ports);
        expect(await app.start({ deviceId: "missing" })).toBeUndefined(); expect(await app.stop({ deviceId: "missing" })).toBeUndefined(); expect(await app.delete({ deviceId: "missing" })).toBeUndefined();
        expect(f.trace).toEqual(["read"]);
    });
    it("start claims before spawn and retains the actual opaque child through identity and boot", async () => {
        const original = stoppedDevice(), f = directLifecyclePorts(original);
        const result = await createAndroidEmulatorLifecycle(f.ports).start({ deviceId: original.id });
        expect(result).toMatchObject({ ok: true, payload: { boot: { ready: true }, device: { status: "running", bootReady: true, extra: original.extra } } });
        expect(f.trace).toEqual(["discovery", "live-ports", "transition", "spawn", "identity:1000", "transition", "boot", "transition"]);
        expect(f.transitions[0].expected).toBe(original); expect(f.current()?.runtime).toMatchObject({ pid: f.child.pid, processIdentity: { startToken: "native-token" } });
    });
    it("unavailable identity contains the actual child and retains unresolved runtime only when native termination fails", async () => {
        const original = stoppedDevice(), f = directLifecyclePorts(original); f.ports.waitForProcessIdentity = async () => null;
        const app = createAndroidEmulatorLifecycle(f.ports);
        const contained = await app.start({ deviceId: original.id });
        expect(JSON.parse(contained!.text!)).toMatchObject({ error: "android-emulator-process-identity-unavailable", stateReverted: true, runtimeStatePreserved: false }); expect(f.current()).toBe(original);
        f.ports.terminateFreshAndroidEmulatorProcessTree = async child => { expect(child).toBe(f.child); return { ok: false, exited: false }; };
        const unresolved = await app.start({ deviceId: original.id });
        expect(JSON.parse(unresolved!.text!)).toMatchObject({ stateReverted: false, runtimeStatePreserved: true });
        expect(f.current()?.runtime).toMatchObject({ pid: f.child.pid, processIdentity: null, identityUnavailable: true });
    });
    it("superseded boot publication rolls back only the previous runtime and preserves successor state", async () => {
        const original = stoppedDevice(), successor = { ...original, status: "stopped", extra: { raw: "successor" } }, f = directLifecyclePorts(original);
        f.ports.waitForAndroidBoot = async () => { f.replace(successor); return { ready: true }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).start({ deviceId: original.id });
        expect(result?.payload).toMatchObject({ error: "owner-device-state-conflict", operation: "start-complete", rollback: { ok: true } }); expect(f.current()).toBe(successor);
        expect(f.trace.slice(-3)).toEqual(["transition", "run:-s emulator-5630 emu kill", "terminate:Android Emulator superseded startup:3000"]);
    });
    it("stop recorder observations precede ADB/runtime cleanup and clear metadata through exact current-record CAS", async () => {
        const original: AndroidEmulatorDevice = { ...stoppedDevice(), status: "running", recording: { active: true, pid: 8 }, runtime: { pid: 9 }, appium: { raw: true } }, f = directLifecyclePorts(original);
        f.ports.signalOwnedRuntimeProcess = () => { f.trace.push("recorder-signal"); return { signaled: true }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(result).toMatchObject({ ok: true, payload: { device: { status: "stopped", pid: null, runtime: null, appium: null, recording: null, lifecycle: null, extra: original.extra } } });
        expect(f.trace).toEqual(["transition", "discovery", "recorder-signal", "run:-s emulator-5630 shell pkill -2 screenrecord", "wait-exit:1000", "run:-s emulator-5630 get-state", "run:-s emulator-5630 emu kill", "terminate:Android Emulator:3000", "transition"]);
    });
    it("uncertain native stop restores original lifecycle presence and keeps a successor during abort", async () => {
        const original = { ...stoppedDevice(), status: "running", runtime: { pid: 9 } }, f = directLifecyclePorts(original);
        f.ports.terminateOwnedRuntimeProcessTree = async () => ({ exited: false, reason: "native identity mismatch" });
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(JSON.parse(result!.text!)).toMatchObject({ error: "android-emulator-process-stop-failed", runtimeStop: { exited: false, reason: "native identity mismatch" } });
        expect(f.current()).toMatchObject({ status: "running", runtime: original.runtime }); expect(f.current()).not.toHaveProperty("lifecycle");
        const successor = { ...original, lifecycle: { runtimeId: "successor", operation: "start", claimedAt: "successor" } };
        f.ports.terminateOwnedRuntimeProcessTree = async () => { f.replace(successor); return { exited: false }; };
        await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id }); expect(f.current()).toBe(successor);
    });
    it("delete refuses running or foreign/live AVD state before removal and preserves native artifact errors", async () => {
        const original = { ...stoppedDevice(), status: "running" }, f = directLifecyclePorts(original), app = createAndroidEmulatorLifecycle(f.ports);
        expect(await app.delete({ deviceId: original.id })).toEqual({ ok: false, text: "Refusing to delete android-unit while status is running" }); expect(f.trace).toEqual(["read"]);
        f.replace(stoppedDevice()); f.ports.isOwnedAvdName = (_name: unknown): _name is string => false;
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ ok: false, text: "Refusing to delete non-owned Android AVD name: ccc-owner-unit" });
        f.ports.isOwnedAvdName = (name: unknown): name is string => typeof name === "string"; f.ports.androidAvdIsInactive = () => false;
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ ok: false, text: "android-avd-active-or-liveness-unverified" }); expect(f.trace).not.toContain("remove-avd");
        f.ports.androidAvdIsInactive = () => true; f.ports.deleteOwnedAndroidAvd = () => ({ ok: false, error: "raw artifact error" });
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ ok: false, text: "Android AVD artifact cleanup failed: raw artifact error" }); expect(f.current()?.status).toBe("stopped");
    });
    it("force-delete uncertainty restores state; successful removal passes the current snapshot to native CAS", async () => {
        const original = { ...stoppedDevice(), status: "running", runtime: { pid: 9 } }, f = directLifecyclePorts(original);
        f.ports.terminateOwnedRuntimeProcessTree = async () => ({ exited: false }); f.ports.waitForProcessExit = async () => false;
        const refused = await createAndroidEmulatorLifecycle(f.ports).delete({ deviceId: original.id, force: true });
        expect(JSON.parse(refused!.text!)).toMatchObject({ error: "android-emulator-force-delete-stop-failed", stateReverted: true }); expect(f.current()?.status).toBe("running");
        f.replace(stoppedDevice()); const deleted = await createAndroidEmulatorLifecycle(f.ports).delete({ deviceId: original.id });
        expect(deleted).toEqual({ ok: true, payload: { deleted: original.id, avdDeleted: false } }); expect(f.transitions.at(-1)?.replacement).toBeNull(); expect(f.transitions.at(-1)?.expected.status).toBe("deleting"); expect(f.current()).toBeUndefined();
    });
});
