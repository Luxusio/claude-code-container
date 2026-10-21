import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";
import { confirmAndroidEmulatorBoot, createAndroidEmulatorLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs";
import type { AndroidEmulatorBootConfirmationPorts, AndroidEmulatorDevice, AndroidEmulatorStopObservation } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import { brokerLifecyclePorts, deferredAndroidEffect, directLifecyclePorts, type BrokerAndroidTestPorts } from "../helpers/android-emulator-lifecycle-fixture.js";
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
    it("create allocation preserves preview refusal and awaits live inventory before augmenting the same carrier", async () => {
        const parsed = brokerLifecyclePorts().input("device_create").parsed, trace: string[] = [], live = new Set([5630]);
        const refusal = { ok: false as const, reason: "invalid" as const, error: "invalid-android-emulator-port" };
        const ports: BrokerAndroidCreatePortAllocationPorts = {
            previewAllocation: () => refusal,
            livePorts: () => { trace.push("live"); return { ok: true, ports: live }; },
        };
        expect(await allocateBrokerAndroidCreatePort("owner", parsed, ports)).toBe(refusal); expect(trace).toEqual([]);
        const preview = (owner: string, observed: typeof parsed, additional?: Iterable<number>) => {
            expect(owner).toBe("owner"); expect(observed).toBe(parsed); trace.push("allocate");
            if (additional) expect(additional).toBe(live);
            return { ok: true as const, port: additional ? 5632 : 5630 };
        };
        const inventory = deferredAndroidEffect<Awaited<ReturnType<typeof ports.livePorts>>>();
        let settled = false;
        const pending = allocateBrokerAndroidCreatePort("owner", parsed, {
            ...ports, previewAllocation: preview, livePorts: () => { trace.push("live"); return inventory.promise; },
        }).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(trace).toEqual(["allocate", "live"]);
            inventory.resolve({ ok: true, ports: live });
            expect(await pending).toEqual({ ok: true, port: 5632 });
            expect(trace).toEqual(["allocate", "live", "allocate"]);
        } finally { inventory.resolve({ ok: true, ports: live }); }
    });
    it("a live start port refuses before provider execution/publication", async () => {
        const f = brokerLifecyclePorts(brokerDevice());
        f.ports.livePorts = () => { f.trace.push("live"); return { ok: true, ports: new Set([5630]) }; };
        const app = createBrokerAndroidEmulatorLifecycle(f.ports); expect(f.trace).toEqual([]);
        const result = await app.start(f.input("device_start"));
        expect(result).toMatchObject({ kind: "refused", reason: "conflict", error: "android-emulator-port-conflict", detail: "port-5630-already-in-use" });
        expect(f.trace).toEqual(["live"]); expect(f.publications).toEqual([]);
    });
    it("broker create awaits failed native execution and compensation before returning the exact diagnostics", async () => {
        const native = { status: 17, error: "raw error", stderr: "raw stderr", stdout: "raw stdout" };
        const f = brokerLifecyclePorts(), failure = { ok: false, mode: "exec", provider: "avdmanager", receipt: { sequence: 0, native } };
        const execution = deferredAndroidEffect<typeof failure>(), entered = deferredAndroidEffect<void>();
        const removal = deferredAndroidEffect<void>(), removing = deferredAndroidEffect<void>();
        f.ports.executePrepared = () => { entered.resolve(); return execution.promise; };
        f.ports.removeAvdArtifacts = async (_name, _owner, _root, verifyInactive) => {
            f.trace.push("remove-avd"); removing.resolve(); await removal.promise;
            if (!await verifyInactive()) throw Error("Native liveness unavailable");
            return { removed: ["owned-partial-avd"] };
        };
        let settled = false;
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).create(f.input("device_create", { create: { createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64", avdName: "ccc-owner-unit" } }))
            .then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([entered.promise, pending.then(() => { throw Error("Lifecycle settled before the held effect was entered"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.trace).not.toContain("remove-avd"); expect(f.trace).not.toContain("claim"); expect(f.current()).toBeUndefined();
            execution.resolve(failure);
            await Promise.race([removing.promise, pending.then(() => { throw Error("Create settled before compensation"); })]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.trace).not.toContain("claim"); expect(f.current()).toBeUndefined();
            removal.resolve();
            const result = await pending;
            expect(result).toMatchObject({ kind: "provider-failed", error: "provider-command-failed", rollback: { ok: true, artifactsRemoved: ["owned-partial-avd"] } });
            expect(result.execution).toBe(failure); expect(result.execution?.receipt?.native).toBe(native);
            expect(f.trace).toContain("live-avds"); expect(f.trace).toContain("processes"); expect(f.trace).not.toContain("claim"); expect(f.current()).toBeUndefined();
        } finally { execution.resolve(failure); removal.resolve(); }
    });
    it("start awaits execution, each boot observation and pacing before publishing readiness", async () => {
        const original: Record<string, unknown> = { ...brokerDevice(), bootReady: true, lastBootCheck: { ready: true, skipped: false } }, f = brokerLifecyclePorts(original);
        const execution = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.executePrepared>>>(), executing = deferredAndroidEffect<void>();
        const probe = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.observeBootProbe>>>(), probing = deferredAndroidEffect<void>();
        const pacing = deferredAndroidEffect<void>(), sleeping = deferredAndroidEffect<void>();
        const sleep = f.ports.sleep; let probes = 0, settled = false;
        f.ports.executePrepared = () => { f.trace.push("execute-held"); executing.resolve(); return execution.promise; };
        f.ports.observeBootProbe = () => {
            probes++; f.trace.push("probe:" + probes);
            if (probes === 1) { probing.resolve(); return probe.promise; }
            return { ok: true, ready: true, mode: "exec", provider: "adb", receipt: { sequence: probes } };
        };
        f.ports.sleep = ms => { sleep(ms); sleeping.resolve(); return pacing.promise; };
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }))
            .then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([executing.promise, pending.then(() => { throw Error("Start settled before native execution"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(probes).toBe(0); expect(f.publications).toEqual([original]);
            const reservation = f.current();
            expect(reservation).toMatchObject({ status: "starting", bootReady: false, lastBootCheck: null, lifecycle: { runtimeId: "android-broker-runtime-1", operation: "start", claimedAt: "native-timestamp" } });
            execution.resolve({ ok: true, mode: "detached", provider: "emulator", receipt: { sequence: 1 } });
            await Promise.race([probing.promise, pending.then(() => { throw Error("Start settled before boot observation"); })]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(probes).toBe(1); expect(f.trace.some(step => step.startsWith("sleep:"))).toBe(false); expect(f.publications).toEqual([original]); expect(f.current()).toBe(reservation);
            probe.resolve({ ok: true, ready: false, mode: "exec", provider: "adb", receipt: { sequence: 2 } });
            await Promise.race([sleeping.promise, pending.then(() => { throw Error("Start settled before boot pacing"); })]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(probes).toBe(1); expect(f.publications).toEqual([original]); expect(f.current()).toBe(reservation);
            pacing.resolve();
            expect(await pending).toMatchObject({ kind: "completed", device: { status: "running", bootReady: true }, boot: { ok: true, ready: true } });
            expect(probes).toBe(2); expect(f.publications).toEqual([original, reservation]); expect(f.current()?.lifecycle).toBeFalsy();
        } finally {
            execution.resolve({ ok: true, mode: "detached", provider: "emulator" });
            probe.resolve({ ok: true, ready: false, mode: "exec", provider: "adb" }); pacing.resolve();
        }
    });
    it("stop awaits inventory before process observation and both before stopped publication", async () => {
        const original = { ...brokerDevice(), status: "running" }, f = brokerLifecyclePorts(original);
        const inventory = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.observeStopInventory>>>(), inventoryEntered = deferredAndroidEffect<void>();
        const processes = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.avdProcesses>>>(), processesEntered = deferredAndroidEffect<void>();
        f.ports.observeStopInventory = () => { f.trace.push("inventory-held"); inventoryEntered.resolve(); return inventory.promise; };
        f.ports.avdProcesses = () => { f.trace.push("processes-held"); processesEntered.resolve(); return processes.promise; };
        let settled = false;
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop")).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([inventoryEntered.promise, pending.then(() => { throw Error("Stop settled before inventory observation"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.trace).not.toContain("processes-held"); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
            inventory.resolve({ ok: true, mode: "exec", provider: "adb", available: true, serialPresent: false });
            await Promise.race([processesEntered.promise, pending.then(() => { throw Error("Stop settled before process inventory"); })]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.publications).toEqual([]); expect(f.trace.some(step => step.startsWith("sleep:"))).toBe(false);
            processes.resolve({ ok: true, active: false });
            expect(await pending).toMatchObject({ kind: "completed", device: { status: "stopped" } });
            expect(f.publications).toEqual([original]);
        } finally { inventory.resolve({ ok: true, mode: "exec", provider: "adb", available: true, serialPresent: false }); processes.resolve({ ok: true, active: false }); }
    });
    it("broker create loser preserves an external winner and removes only its inactive owned artifacts", async () => {
        const f = brokerLifecyclePorts(), winner = { ...brokerDevice(), avdName: "ccc-owner-winner", extra: { raw: "winner" } };
        f.ports.claimDefinition = () => { f.replace(winner); return { ok: false, error: "owner-device-id-conflict", field: "id", value: "android-unit", existing: winner }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).create(f.input("device_create", { create: { createAvd: true, avdName: "ccc-owner-unit", systemImage: "system-images;android-35;google_apis;x86_64" } }));
        expect(result).toMatchObject({ kind: "refused", reason: "conflict", error: "owner-device-id-conflict", rollback: { attempted: true, ok: true } });
        expect(f.current()).toBe(winner); expect(f.trace).toContain("remove-avd");
    });
    it("awaited committed auxiliary cleanup advances the complete snapshot before stopped publication", async () => {
        const original: Record<string, unknown> = { ...brokerDevice(), status: "running", recording: { active: false, raw: "metadata" } }, f = brokerLifecyclePorts(original);
        const cleaned = { ...original, recording: null }, cleanup = deferredAndroidEffect<void>(), entered = deferredAndroidEffect<void>();
        f.ports.cleanupAuxiliary = async (_owner, _parsed, expected) => {
            expect(expected).toBe(original); f.trace.push("cleanup"); entered.resolve(); await cleanup.promise;
            f.replace(cleaned); return { committed: true, device: cleaned, result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } };
        };
        let settled = false;
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop")).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([entered.promise, pending.then(() => { throw Error("Lifecycle settled before the held effect was entered"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
            cleanup.resolve();
            expect(await pending).toMatchObject({ kind: "completed", device: { status: "stopped", recording: null, extra: original.extra }, auxiliaryCleanup: { changed: true, recording: { cleared: true } } });
            expect(f.publications).toEqual([cleaned]); expect(f.trace.indexOf("cleanup")).toBeLessThan(f.trace.indexOf("execute:adb"));
            expect(f.trace).toContain("processes");
        } finally { cleanup.resolve(); }
    });
    it("keeps committed auxiliary facts and a successor when later awaited native execution loses publication CAS", async () => {
        const original = { ...brokerDevice(), status: "running", recording: { active: false, raw: "metadata" } }, f = brokerLifecyclePorts(original);
        const cleaned = { ...original, recording: null }, successor = { ...cleaned, extra: { raw: "successor" } };
        const execution = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.executePrepared>>>(), entered = deferredAndroidEffect<void>();
        f.ports.cleanupAuxiliary = async () => { f.replace(cleaned); return { committed: true, device: cleaned, result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } }; };
        f.ports.executePrepared = () => { entered.resolve(); return execution.promise; };
        let settled = false;
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop")).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([entered.promise, pending.then(() => { throw Error("Lifecycle settled before the held effect was entered"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.current()).toBe(cleaned); expect(f.publications).toEqual([]);
            f.replace(successor); execution.resolve({ ok: true, mode: "exec", provider: "adb", receipt: { sequence: 1 } });
            expect(await pending).toMatchObject({ kind: "publication-conflict", error: "owner-device-state-conflict", auxiliaryCleanup: { changed: true, recording: { cleared: true } }, invoked: true, mutatesHost: true });
            expect(f.publications).toEqual([cleaned]); expect(f.current()).toBe(successor);
        } finally { execution.resolve({ ok: true, mode: "exec", provider: "adb" }); }
    });
    it("auxiliary cleanup failure blocks provider execution and reports its committed native change truthfully", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), changed = { ...original, recording: null };
        f.ports.cleanupAuxiliary = () => { f.replace(changed); return { committed: true, device: changed, result: { ok: false, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).stop(f.input("device_stop"));
        expect(result).toMatchObject({ kind: "auxiliary-failed", error: "auxiliary-runtime-cleanup-failed", invoked: false, mutatesHost: true });
        expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(changed);
    });
    it("a broker start boot failure retains its recovery reservation and reports possible host mutation", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original);
        const unavailable = { ok: false, mode: "noop", provider: "adb", receipt: { sequence: 0, native: { status: null, error: "missing-adb" } } };
        f.ports.prepareBootProbe = () => ({ kind: "unavailable", observation: unavailable });
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "provider-failed", error: "provider-command-failed", invoked: true, mutatesHost: true, boot: { ok: false } });
        expect(result.boot).toMatchObject({ reason: "probe-unavailable", error: unavailable });
        expect(result.boot && !result.boot.ok && result.boot.reason === "probe-unavailable" ? result.boot.error : null).toBe(unavailable);
        expect(f.current()).toMatchObject({ status: "starting", lifecycle: { runtimeId: "android-broker-runtime-1", operation: "start" } });
        expect(f.current()).not.toBe(original); expect(f.publications).toEqual([original]); expect(f.commands).toHaveLength(1);
    });
    it("stop inventory uncertainty refuses final publication; a successful native effect cannot replace a successor", async () => {
        const original = { ...brokerDevice(), status: "running" }, f = brokerLifecyclePorts(original), app = createBrokerAndroidEmulatorLifecycle(f.ports);
        const inventory = f.ports.observeStopInventory;
        f.ports.observeStopInventory = async (...args) => ({ ...await inventory(...args), available: false });
        const uncertain = await app.stop(f.input("device_stop"));
        expect(uncertain).toMatchObject({ kind: "stop-unconfirmed", error: "android-emulator-stop-unconfirmed" }); expect(f.current()).toBe(original); expect(f.publications).toEqual([]);
        const successor = { ...original, extra: { raw: "successor" } };
        f.ports.observeStopInventory = inventory;
        const execute = f.ports.executePrepared;
        f.ports.executePrepared = (effect, options) => { if (effect.action === "stop") f.replace(successor); return execute(effect, options); };
        const conflicted = await app.stop(f.input("device_stop"));
        expect(conflicted).toMatchObject({ kind: "publication-conflict", error: "owner-device-state-conflict" }); expect(f.current()).toBe(successor);
    });
    it("delete awaits fresh inactivity inside artifact removal and keeps metadata when that observation refuses", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original);
        const fresh = deferredAndroidEffect<Awaited<ReturnType<typeof f.ports.liveAvds>>>(), removing = deferredAndroidEffect<void>();
        let observations = 0, settled = false;
        f.ports.liveAvds = () => ++observations === 1 ? { ok: true, names: new Set<string>() } : fresh.promise;
        f.ports.removeAvdArtifacts = (_name, _owner, _root, verifyInactive) => {
            const removal = (async () => {
                removing.resolve();
                if (!await verifyInactive()) throw Error("Native liveness unavailable");
                return { removed: ["owned-avd"] };
            })();
            void removal.catch(() => undefined);
            return removal;
        };
        const pending = createBrokerAndroidEmulatorLifecycle(f.ports).delete(f.input("device_delete", { deleteAvd: true }))
            .then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await Promise.race([removing.promise, pending.then(() => { throw Error("Delete settled before artifact removal"); })]); await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(observations).toBe(2); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
            fresh.resolve({ ok: false, reason: "provider-failed", detail: "fresh inventory unavailable" });
            expect(await pending).toMatchObject({ kind: "refused", reason: "provider-failed", error: "android-avd-artifact-cleanup-failed" });
            expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
        } finally { fresh.resolve({ ok: false, reason: "provider-failed", detail: "fresh inventory unavailable" }); }
    });
    it("AVD delete liveness/root refusals precede destructive provider execution and state removal", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), app = createBrokerAndroidEmulatorLifecycle(f.ports);
        f.ports.liveAvds = () => ({ ok: true, names: new Set(["ccc-owner-unit"]) });
        const active = await app.delete(f.input("device_delete", { deleteAvd: true }));
        expect(active).toMatchObject({ kind: "refused", reason: "conflict", error: "android-avd-active" }); expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
        f.ports.liveAvds = () => ({ ok: true, names: new Set() }); f.ports.approvedAvdRoot = () => null;
        const root = await app.delete(f.input("device_delete", { deleteAvd: true }));
        expect(root).toMatchObject({ kind: "refused", reason: "conflict", error: "android-avd-root-unavailable" }); expect(f.commands).toEqual([]); expect(f.current()).toBe(original);
    });
});

function expectBrokerStartReservation(f: ReturnType<typeof brokerLifecyclePorts>) {
    const reservation = f.current();
    expect(reservation).toMatchObject({ status: "starting", bootReady: false, lastBootCheck: null, lifecycle: { runtimeId: "android-broker-runtime-1", operation: "start", claimedAt: "native-timestamp" } });
    if (!reservation) throw Error("Start recovery reservation is missing");
    expect(Object.keys(reservation.lifecycle as object).sort()).toEqual(["claimedAt", "operation", "runtimeId"]);
    return reservation;
}

describe("authenticated Android launch recovery responsibility", () => {
    it.each(["refused", "throw"] as const)("reservation %s dispatches no native launch and preserves the current record", async mode => {
        const original = brokerDevice(), successor = { ...original, extra: { raw: "successor" } }, f = brokerLifecyclePorts(original);
        f.ports.transition = () => {
            if (mode === "throw") throw Error("private reservation exception credential=reserve-secret");
            f.replace(successor); return { found: true, matched: false, device: successor };
        };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start"));
        expect(result).toMatchObject({ kind: "refused", invoked: false, mutatesHost: false });
        expect(f.commands).toEqual([]); expect(f.current()).toBe(mode === "throw" ? original : successor);
        expect(JSON.stringify(result)).not.toContain("reserve-secret"); expect(result).not.toHaveProperty("cause");
    });

    it("a throwing admission observation refuses before reservation and dispatch", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original);
        f.ports.livePorts = () => { throw Error("private admission exception password=admission-secret"); };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start"));
        expect(result).toMatchObject({ kind: "refused", invoked: false, mutatesHost: false });
        expect(f.publications).toEqual([]); expect(f.commands).toEqual([]); expect(f.current()).toBe(original);
        expect(JSON.stringify(result)).not.toContain("admission-secret");
    });

    it("unavailable launch preparation cannot reserve or execute", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), input = f.input("device_start");
        input.plan!.preparation = { kind: "unavailable", error: "missing-provider-command", missing: ["emulator"] };
        expect(await createBrokerAndroidEmulatorLifecycle(f.ports).start(input)).toMatchObject({ kind: "refused", error: "missing-provider-command" });
        expect(f.publications).toEqual([]); expect(f.commands).toEqual([]); expect(f.current()).toBe(original);
    });

    it.each([
        { status: "starting" },
        { status: "stopped", lifecycle: { runtimeId: "prior-runtime", operation: "start", claimedAt: "prior-time" } },
    ])("a prior unresolved start requires recovery: %j", async pending => {
        const original = { ...brokerDevice(), ...pending }, f = brokerLifecyclePorts(original);
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start"));
        expect(result).toMatchObject({ kind: "refused", reason: "conflict", invoked: false, mutatesHost: false });
        expect(f.commands).toEqual([]); expect(f.publications).toEqual([]); expect(f.current()).toBe(original);
    });

    it.each(["nonzero", "throw", "rejection", "null", "missing-ok", "missing-provider"] as const)("%s launch result retains a bounded recovery marker and reports possible mutation", async mode => {
        const original: Record<string, unknown> = { ...brokerDevice(), bootReady: true, lastBootCheck: { ready: true, skipped: false } }, f = brokerLifecyclePorts(original);
        const failed = { ok: false, mode: "detached", provider: "emulator", receipt: { sequence: 1, native: { status: 17 } } };
        let dispatched = 0;
        f.ports.executePrepared = () => {
            dispatched++;
            if (mode === "throw") throw Error("private native exception token=launch-secret");
            if (mode === "rejection") return Promise.reject(Error("private native exception token=launch-secret"));
            if (mode === "nonzero") return failed;
            return (mode === "null" ? null : mode === "missing-ok" ? { mode: "detached", provider: "emulator" } : { ok: true }) as unknown as Awaited<ReturnType<BrokerAndroidTestPorts["executePrepared"]>>;
        };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true });
        expect(dispatched).toBe(1); expect(f.publications).toEqual([original]);
        const reservation = expectBrokerStartReservation(f);
        expect(reservation.extra).toBe(original.extra); expect(f.trace).not.toContain("execute:adb");
        expect(reservation.lifecycle).not.toHaveProperty("receipt"); expect(reservation.lifecycle).not.toHaveProperty("cause");
        expect(JSON.stringify(reservation.lifecycle)).not.toContain("launch-secret");
        expect(JSON.stringify(result)).not.toContain("launch-secret"); expect(result).not.toHaveProperty("cause");
    });

    it.each(["prepare-throw", "probe-throw", "probe-rejection", "sleep-rejection"] as const)("%s after dispatch becomes a redacted semantic partial effect", async mode => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), secret = "post-launch-private-command-password";
        if (mode === "prepare-throw") f.ports.prepareBootProbe = () => { throw Error(secret); };
        if (mode === "probe-throw") f.ports.observeBootProbe = () => { throw Error(secret); };
        if (mode === "probe-rejection") f.ports.observeBootProbe = () => Promise.reject(Error(secret));
        if (mode === "sleep-rejection") {
            f.ports.observeBootProbe = () => ({ ok: true, ready: false, mode: "exec", provider: "adb" });
            f.ports.sleep = () => Promise.reject(Error(secret));
        }
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true, bootTimeoutMs: 1000 }));
        expect(result).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true });
        expectBrokerStartReservation(f); expect(f.publications).toEqual([original]);
        expect(f.commands.filter(command => command.effect.action === "start")).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(secret); expect(result).not.toHaveProperty("cause");
    });

    it.each([false, true])("waitForBoot=%s finalizes the complete reservation returned by storage", async waitForBoot => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), transition = f.ports.transition;
        let returnedReservation: Record<string, unknown> | undefined;
        f.ports.transition = (...args) => {
            const publication = transition(...args);
            if (!returnedReservation && publication.matched) {
                returnedReservation = { ...(publication.device as Record<string, unknown>), repositoryFact: "returned-reservation" };
                f.replace(returnedReservation); return { ...publication, device: returnedReservation };
            }
            return publication;
        };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot }));
        expect(result).toMatchObject({ kind: "completed", invoked: true, mutatesHost: true, device: { status: "running", bootReady: waitForBoot, repositoryFact: "returned-reservation", extra: original.extra } });
        expect(f.publications).toEqual([original, returnedReservation]); expect(returnedReservation?.status).toBe("starting");
        expect(f.current()?.lifecycle).toBeFalsy();
        expect(f.commands.filter(command => command.effect.action === "boot-probe")).toHaveLength(waitForBoot ? 1 : 0);
    });

    it("final publication throw preserves starting and reports redacted partial execution", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), transition = f.ports.transition;
        let publications = 0;
        f.ports.transition = (...args) => {
            if (++publications === 2) throw Error("final-cas-private-record-and-credential");
            return transition(...args);
        };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: false }));
        expect(result).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true });
        expect(publications).toBe(2); expectBrokerStartReservation(f);
        expect(JSON.stringify(result)).not.toContain("final-cas-private-record-and-credential"); expect(result).not.toHaveProperty("cause");
        expect(f.commands.map(command => command.effect.action)).toEqual(["start"]);
    });

    it("a classified final publication exception retains its known state code and partial execution", async () => {
        const f = brokerLifecyclePorts(brokerDevice()), transition = f.ports.transition, failure = Error("private state-file details");
        let publications = 0;
        f.ports.stateErrorCode = error => error === failure ? "owner-devices-state-invalid" : null;
        f.ports.transition = (...args) => {
            if (++publications === 2) throw failure;
            return transition(...args);
        };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: false }));
        expect(result).toMatchObject({ kind: "provider-failed", stateError: "owner-devices-state-invalid", invoked: true, mutatesHost: true });
        expectBrokerStartReservation(f); expect(publications).toBe(2);
        expect(JSON.stringify(f.current()?.lifecycle)).not.toContain("private state-file details");
    });

    it.each([false, true])("a same-target successor during waitForBoot=%s survives without name-based compensation", async waitForBoot => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), execute = f.ports.executePrepared;
        const successor = { ...original, status: "running", lifecycle: { runtimeId: "successor-runtime", operation: "start", claimedAt: "later" } };
        f.ports.executePrepared = (effect, options) => { const result = execute(effect, options); f.replace(successor); return result; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot }));
        expect(result).toMatchObject({ kind: "publication-conflict", invoked: true, mutatesHost: true });
        expect(f.current()).toBe(successor); expect(f.publications).toHaveLength(2);
        expect(f.commands.some(command => command.effect.action === "stop")).toBe(false);
        expect(f.trace).not.toContain("cleanup"); expect(f.trace).not.toContain("remove-avd");
    });

    it("each boot probe receives the captured monotonic remainder, including less than one second", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original), allowances: number[] = [], pacing: number[] = [];
        f.ports.observeBootProbe = (_effect, options) => {
            allowances.push(options.timeoutMs);
            if (allowances.length === 1) { f.advanceTime(400); return { ok: true, ready: false, mode: "exec", provider: "adb" }; }
            f.advanceTime(1); return { ok: true, ready: true, mode: "exec", provider: "adb" };
        };
        f.ports.sleep = milliseconds => { pacing.push(milliseconds); f.advanceTime(200); return undefined; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true, bootTimeoutMs: 1000 }));
        expect(result).toMatchObject({ kind: "completed", boot: { ok: true, ready: true } });
        expect(allowances).toEqual([1000, 400]); expect(pacing).toEqual([600]);
    });

    it.each([1000, 1001])("readiness observed at monotonic elapsed %i is too late and remains recoverable", async elapsed => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original);
        f.ports.observeBootProbe = () => { f.advanceTime(elapsed); return { ok: true, ready: true, mode: "exec", provider: "adb" }; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true, bootTimeoutMs: 1000 }));
        expect(result).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true, boot: { ok: false, ready: false, reason: "deadline-exceeded" } });
        expectBrokerStartReservation(f); expect(f.publications).toEqual([original]);
    });

    it("expired pacing cannot authorize a further boot probe or finalize stopped state", async () => {
        const original = brokerDevice(), f = brokerLifecyclePorts(original); let probes = 0;
        f.ports.observeBootProbe = () => { probes++; f.advanceTime(300); return { ok: true, ready: false, mode: "exec", provider: "adb" }; };
        f.ports.sleep = milliseconds => { expect(milliseconds).toBe(700); f.advanceTime(700); return undefined; };
        const result = await createBrokerAndroidEmulatorLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true, bootTimeoutMs: 1000 }));
        expect(result).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true, boot: { ok: false, reason: "deadline-exceeded" } });
        expect(probes).toBe(1); expectBrokerStartReservation(f); expect(f.publications).toEqual([original]);
    });
});

const stoppedDevice = (): AndroidEmulatorDevice => ({ id: "android-unit", backend: "android-emulator", avdName: "ccc-owner-unit", serial: "emulator-5630", port: 5630, status: "stopped", extra: { raw: "retained" } });

function bootConfirmationObservations() {
    let time = 0, probes = 0;
    let exit: { exitCode: number | null; signal: string | null } | null = null;
    const sleeps: number[] = [];
    const ports: AndroidEmulatorBootConfirmationPorts = {
        now: () => time,
        processExit: () => exit,
        probeBootCompleted: () => { probes++; return false; },
        sleep: async ms => { sleeps.push(ms); time += ms; },
    };
    return { ports, sleeps, probes: () => probes, time: () => time,
        exit: (observed: NonNullable<ReturnType<AndroidEmulatorBootConfirmationPorts["processExit"]>>) => { exit = observed; } };
}

describe("direct Android boot confirmation", () => {
    it("skips missing ADB without consulting the clock, process, probe or timer", async () => {
        const unexpected = () => { throw Error("Missing ADB must not observe or wait"); };
        expect(await confirmAndroidEmulatorBoot(false, 1000, {
            now: unexpected, processExit: unexpected, probeBootCompleted: unexpected, sleep: unexpected,
        })).toEqual({ ready: false, skipped: true, reason: "adb missing" });
    });

    it("paces an incomplete boot before retrying to readiness", async () => {
        const f = bootConfirmationObservations(), observe = f.ports.probeBootCompleted;
        f.ports.probeBootCompleted = () => { observe(); return f.probes() === 2; };
        expect(await confirmAndroidEmulatorBoot(true, 1000, f.ports)).toEqual({ ready: true });
        expect(f.probes()).toBe(2); expect(f.sleeps).toEqual([0, 250, 0]); expect(f.time()).toBe(250);
    });

    it("reports an already exited emulator before any ADB probe", async () => {
        const f = bootConfirmationObservations(); f.exit({ exitCode: 17, signal: null });
        expect(await confirmAndroidEmulatorBoot(true, 1000, f.ports)).toEqual({
            ready: false, skipped: false, reason: "emulator-process-exited", exitCode: 17, signal: null,
        });
        expect(f.probes()).toBe(0); expect(f.sleeps).toEqual([]);
    });

    it("refuses readiness when the emulator exits during the boot probe", async () => {
        const f = bootConfirmationObservations();
        f.ports.probeBootCompleted = () => { f.exit({ exitCode: null, signal: "SIGTERM" }); return true; };
        expect(await confirmAndroidEmulatorBoot(true, 1000, f.ports)).toEqual({
            ready: false, skipped: false, reason: "emulator-process-exited", exitCode: null, signal: "SIGTERM",
        });
        expect(f.sleeps).toEqual([0]);
    });

    it("awaits the yielded native observation and gives its process exit precedence over readiness", async () => {
        const f = bootConfirmationObservations(), yielded = deferredAndroidEffect<void>(), resume = deferredAndroidEffect<void>();
        f.ports.probeBootCompleted = () => true;
        f.ports.sleep = ms => { expect(ms).toBe(0); yielded.resolve(); return resume.promise; };
        let settled = false;
        const pending = confirmAndroidEmulatorBoot(true, 1000, f.ports).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await yielded.promise; expect(settled).toBe(false);
            f.exit({ exitCode: 0, signal: null }); resume.resolve();
            expect(await pending).toEqual({
                ready: false, skipped: false, reason: "emulator-process-exited", exitCode: 0, signal: null,
            });
        } finally { resume.resolve(); }
    });

    it("allows a probe at the exact deadline but does not retry after pacing crosses it", async () => {
        const f = bootConfirmationObservations();
        expect(await confirmAndroidEmulatorBoot(true, 250, f.ports)).toEqual({ ready: false, skipped: false, reason: "timeout" });
        expect(f.probes()).toBe(2); expect(f.sleeps).toEqual([0, 250, 0, 250]); expect(f.time()).toBe(500);
    });

    it("preserves the immediate readiness observation for a zero boot budget", async () => {
        const f = bootConfirmationObservations(); f.ports.probeBootCompleted = () => true;
        expect(await confirmAndroidEmulatorBoot(true, 0, f.ports)).toEqual({ ready: true });
        expect(f.sleeps).toEqual([0]); expect(f.time()).toBe(0);
    });
});

describe("canonical direct Android emulator lifecycle policy", () => {
    it("allocation refusal precedes native discovery/read/provision", async () => {
        const f = directLifecyclePorts();
        f.ports.resolveAndroidEmulatorPort = () => { f.trace.push("allocate"); return { ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" }; };
        const app = createAndroidEmulatorLifecycle(f.ports); expect(f.trace).toEqual([]);
        expect(await app.create({ backend: "other" })).toBeUndefined(); expect(f.trace).toEqual([]);
        expect(await app.create({ backend: "android-emulator", name: "Unit", port: 5555 })).toEqual({ kind: "refused", message: "invalid-android-emulator-port (even integer 5554-5682)" });
        expect(f.trace).toEqual(["allocate"]);
    });
    it("create reallocates a live default port before duplicate admission and keeps raw created carriers", async () => {
        const f = directLifecyclePorts(), live = new Set([5630]); let allocations = 0;
        f.ports.liveAndroidEmulatorPortsForAllocation = () => ({ ok: true, ports: live });
        f.ports.resolveAndroidEmulatorPort = (_owner, _id, _port, additional) => { f.trace.push("allocate"); allocations++; if (allocations === 2) expect(additional).toBe(live); return { ok: true, port: allocations === 1 ? 5630 : 5632 }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).create({ backend: "android-emulator", name: "Unit" });
        expect(result).toMatchObject({ kind: "created", device: { id: "android-unit", port: 5632, serial: "emulator-5632", avdRoot: null, systemImage: null, deviceProfile: null, provisioned: false, status: "stopped", headless: true } });
        expect(f.trace).toEqual(["allocate", "allocate", "read", "claim"]);
    });
    it("failed provisioning compensates only owned inactive artifacts and forwards the exact native failure", async () => {
        const f = directLifecyclePorts(), failure = { status: 17, stdout: "raw stdout", stderr: "raw stderr", native: {} };
        f.ports.provisionAndroidAvd = () => ({ ok: false, diagnostic: failure });
        const result = await createAndroidEmulatorLifecycle(f.ports).create({ backend: "android-emulator", name: "Unit", createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64" });
        expect(result && "diagnostic" in result ? result.diagnostic : undefined).toBe(failure); expect(f.trace.slice(-2)).toEqual(["remove-avd", "inactive"]); expect(f.current()).toBeUndefined();
    });
    it("claim throw preserves error identity after compensation and refuses unverified rollback", async () => {
        const f = directLifecyclePorts(), thrown = new Error("native claim failure");
        f.ports.claimAndroidDevice = () => { throw thrown; };
        const app = createAndroidEmulatorLifecycle(f.ports), args = { backend: "android-emulator", name: "Unit", createAvd: true, systemImage: "system-images;android-35;google_apis;x86_64" };
        await expect(app.create(args)).rejects.toBe(thrown); expect(f.trace).toContain("remove-avd");
        f.trace.length = 0; f.ports.androidAvdIsInactive = () => false;
        expect(await app.create(args)).toEqual({ kind: "refused", message: "Owner device state update failed; Android AVD rollback blocked because liveness is unverified" });
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
        expect(result).toMatchObject({ kind: "started", boot: { ready: true }, device: { status: "running", bootReady: true, extra: original.extra } });
        expect(f.trace).toEqual(["discovery", "live-ports", "transition", "spawn", "identity:1000", "transition", "boot", "transition"]);
        expect(f.transitions[0].expected).toBe(original); expect(f.current()?.runtime).toMatchObject({ pid: f.child.pid, processIdentity: { startToken: "native-token" } });
    });
    it("unavailable identity contains the actual child and retains unresolved runtime only when native termination fails", async () => {
        const original = stoppedDevice(), f = directLifecyclePorts(original); f.ports.waitForProcessIdentity = async () => null;
        const app = createAndroidEmulatorLifecycle(f.ports);
        const contained = await app.start({ deviceId: original.id });
        expect(contained).toMatchObject({ kind: "identity-unavailable", stateReverted: true, runtimeStatePreserved: false }); expect(f.current()).toBe(original);
        f.ports.terminateFreshAndroidEmulatorProcessTree = async child => { expect(child).toBe(f.child); return { ok: false, exited: false }; };
        const unresolved = await app.start({ deviceId: original.id });
        expect(unresolved).toMatchObject({ stateReverted: false, runtimeStatePreserved: true });
        expect(f.current()?.runtime).toMatchObject({ pid: f.child.pid, processIdentity: null, identityUnavailable: true });
    });
    it("superseded boot publication rolls back only the previous runtime and preserves successor state", async () => {
        const original = stoppedDevice(), successor = { ...original, status: "stopped", extra: { raw: "successor" } }, f = directLifecyclePorts(original);
        f.ports.waitForAndroidBoot = async () => { f.replace(successor); return { ready: true }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).start({ deviceId: original.id });
        expect(result).toMatchObject({ kind: "conflict", operation: "start-complete", rollback: { ok: true } }); expect(f.current()).toBe(successor);
        expect(f.trace.slice(-3)).toEqual(["transition", "stop-emulator", "terminate:Android Emulator superseded startup:3000"]);
    });
    it("stop recorder observations precede ADB/runtime cleanup and clear metadata through exact current-record CAS", async () => {
        const original: AndroidEmulatorDevice = { ...stoppedDevice(), status: "running", recording: { active: true, pid: 8 }, runtime: { pid: 9 }, appium: { raw: true } }, f = directLifecyclePorts(original);
        f.ports.signalAndroidRecorder = () => { f.trace.push("recorder-signal"); return { signaled: true }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(result).toMatchObject({ kind: "stopped", device: { status: "stopped", pid: null, runtime: null, appium: null, recording: null, lifecycle: null, extra: original.extra } });
        expect(f.trace.indexOf("observe-emulator")).toBeLessThan(f.trace.indexOf("recorder-signal"));
        expect(f.trace.indexOf("stop-recorder")).toBeLessThan(f.trace.indexOf("stop-emulator"));
        expect(f.trace.filter(step => step === "stop-emulator")).toHaveLength(1);
        expect(f.trace.filter(step => step === "observe-emulator").length).toBeGreaterThanOrEqual(2);
        expect(f.trace).toContain("wait-exit:1000");
        expect(f.trace.indexOf("terminate:Android Emulator:3000")).toBeLessThan(f.trace.lastIndexOf("transition"));
    });
    it("uncertain native stop restores original lifecycle presence and keeps a successor during abort", async () => {
        const original = { ...stoppedDevice(), status: "running", runtime: { pid: 9 } }, f = directLifecyclePorts(original);
        f.ports.terminateOwnedRuntimeProcessTree = async () => ({ exited: false, reason: "native identity mismatch" });
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(result).toMatchObject({ kind: "runtime-stop-failed", runtimeStop: { exited: false, reason: "native identity mismatch" } });
        expect(f.current()).toMatchObject({ status: "running", runtime: original.runtime }); expect(f.current()).not.toHaveProperty("lifecycle");
        const successor = { ...original, lifecycle: { runtimeId: "successor", operation: "start", claimedAt: "successor" } };
        f.ports.terminateOwnedRuntimeProcessTree = async () => { f.replace(successor); return { exited: false }; };
        await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id }); expect(f.current()).toBe(successor);
    });
    it("delete refuses running or foreign/live AVD state before removal and preserves native artifact errors", async () => {
        const original = { ...stoppedDevice(), status: "running" }, f = directLifecyclePorts(original), app = createAndroidEmulatorLifecycle(f.ports);
        expect(await app.delete({ deviceId: original.id })).toEqual({ kind: "refused", message: "Refusing to delete android-unit while status is running" }); expect(f.trace).toEqual(["read"]);
        f.replace(stoppedDevice()); f.ports.isOwnedAvdName = (_name: unknown): _name is string => false;
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ kind: "refused", message: "Refusing to delete non-owned Android AVD name: ccc-owner-unit" });
        f.ports.isOwnedAvdName = (name: unknown): name is string => typeof name === "string"; f.ports.androidAvdIsInactive = () => false;
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ kind: "refused", message: "android-avd-active-or-liveness-unverified" }); expect(f.trace).not.toContain("remove-avd");
        f.ports.androidAvdIsInactive = () => true; f.ports.deleteOwnedAndroidAvd = () => ({ ok: false, error: "raw artifact error" });
        expect(await app.delete({ deviceId: original.id, deleteAvd: true })).toEqual({ kind: "refused", message: "Android AVD artifact cleanup failed: raw artifact error" }); expect(f.current()?.status).toBe("stopped");
    });
    it("force-delete uncertainty restores state; successful removal passes the current snapshot to native CAS", async () => {
        const original = { ...stoppedDevice(), status: "running", runtime: { pid: 9 } }, f = directLifecyclePorts(original);
        f.ports.terminateOwnedRuntimeProcessTree = async () => ({ exited: false }); f.ports.waitForProcessExit = async () => false;
        const refused = await createAndroidEmulatorLifecycle(f.ports).delete({ deviceId: original.id, force: true });
        expect(refused).toMatchObject({ kind: "force-delete-stop-failed", stateReverted: true }); expect(f.current()?.status).toBe("running");
        f.replace(stoppedDevice()); const deleted = await createAndroidEmulatorLifecycle(f.ports).delete({ deviceId: original.id });
        expect(deleted).toEqual({ kind: "deleted", deviceId: original.id, avdDeleted: false }); expect(f.transitions.at(-1)?.replacement).toBeNull(); expect(f.transitions.at(-1)?.expected.status).toBe("deleting"); expect(f.current()).toBeUndefined();
    });
});

describe("direct Android stop requires trustworthy completion", () => {
    const operationNames = ["stop", "forced-delete"] as const;
    const live = (): AndroidEmulatorStopObservation => ({ kind: "observed", serialPresent: true, processActive: true });
    const absent = (): AndroidEmulatorStopObservation => ({ kind: "observed", serialPresent: false, processActive: false });
    const recoverable = (): AndroidEmulatorDevice => ({ ...stoppedDevice(), status: "running", pid: 9,
        runtime: { pid: 9, runtimeId: "owned-runtime", processIdentity: { startToken: "owned-token" } },
        recording: { active: true, pid: 8, runtimeId: "owned-recorder" }, appium: { sessionId: "retained-appium" } });

    for (const operation of operationNames) {
        it.each(["inventory-unavailable", "inventory-invalid", "target-unavailable", "identity-unavailable", "identity-mismatch", "process-unavailable"] as const)(`${operation} preserves all recovery evidence when admission is %s`, async reason => {
            const original = recoverable(), f = directLifecyclePorts(original);
            f.ports.observeAndroidEmulator = () => ({ kind: "unavailable", reason });
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true, deleteAvd: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stop-unconfirmed" : "force-delete-stop-failed", reason, stateReverted: true });
            expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined });
            expect(f.current()?.runtime).toBe(original.runtime); expect(f.current()?.recording).toBe(original.recording); expect(f.current()?.appium).toBe(original.appium);
            expect(f.trace).not.toContain("recorder-signal"); expect(f.trace).not.toContain("stop-recorder");
            expect(f.trace).not.toContain("stop-emulator"); expect(f.trace).not.toContain("remove-avd");
            expect(f.trace.some(step => step.startsWith("terminate:"))).toBe(false);
        });

        it(`${operation} converts a thrown native read into uncertainty without clearing metadata`, async () => {
            const original = recoverable(), f = directLifecyclePorts(original);
            f.ports.observeAndroidEmulator = () => { throw new Error("native inventory disappeared"); };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stop-unconfirmed" : "force-delete-stop-failed", reason: "observation-failed", stateReverted: true });
            expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined }); expect(f.trace).not.toContain("stop-emulator");
        });

        it.each(["serial", "process", "both"] as const)(`${operation} waits for delayed %s absence after one kill acknowledgement`, async delayed => {
            const original = recoverable(), f = directLifecyclePorts(original), observations: number[] = [];
            f.ports.observeAndroidEmulator = () => {
                observations.push(f.time());
                if (observations.length === 1) return live();
                if (observations.length === 2) return { kind: "observed", serialPresent: delayed !== "process", processActive: delayed !== "serial" };
                return absent();
            };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stopped" : "deleted" });
            expect(observations).toHaveLength(3); expect(observations[2] - observations[1]).toBe(250);
            expect(f.trace.filter(step => step === "stop-emulator")).toHaveLength(1);
            expect(f.trace.filter(step => step.startsWith("stop-budget:"))).toEqual(["stop-budget:30000:250"]);
            if (operation === "stop") expect(f.current()).toMatchObject({ status: "stopped", runtime: null, recording: null, appium: null });
            else expect(f.current()).toBeUndefined();
        });

        it(`${operation} rejects acknowledgement while the target remains and never renews the observation budget`, async () => {
            const original = recoverable(), f = directLifecyclePorts(original); let observations = 0;
            f.ports.observeAndroidEmulator = () => { observations++; return live(); };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true, deleteAvd: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stop-unconfirmed" : "force-delete-stop-failed", stateReverted: true });
            expect(observations).toBeGreaterThan(1); expect(f.time()).toBe(30000);
            expect(f.trace.filter(step => step === "stop-emulator")).toHaveLength(1);
            expect(f.trace.filter(step => step.startsWith("stop-budget:"))).toHaveLength(1);
            expect(f.trace).not.toContain("remove-avd"); expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined });
        });

        it.each(["running", "stopped"])(`${operation} accepts already absent native state with stale %s metadata and no runtime`, async status => {
            const original = { ...stoppedDevice(), status }, f = directLifecyclePorts(original);
            f.ports.observeAndroidEmulator = absent;
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stopped" : "deleted" });
            expect(f.trace).not.toContain("stop-emulator"); expect(f.trace.some(step => step.startsWith("terminate:"))).toBe(false);
        });

        it(`${operation} refuses a late absent result and dispatches no effect after admission exhausts the allowance`, async () => {
            const original = recoverable(), f = directLifecyclePorts(original); let observations = 0;
            f.ports.observeAndroidEmulator = () => { observations++; f.advanceTime(30000); return absent(); };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stop-unconfirmed" : "force-delete-stop-failed", reason: "deadline-exhausted", stateReverted: true });
            expect(observations).toBe(1); expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined });
            expect(f.trace).not.toContain("stop-emulator"); expect(f.trace).not.toContain("stop-recorder");
        });

        it(`${operation} cannot publish absence returned at the confirmation deadline`, async () => {
            const original = recoverable(), f = directLifecyclePorts(original); let observations = 0;
            f.ports.observeAndroidEmulator = () => { if (++observations === 1) return live(); f.advanceTime(30001); return absent(); };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result).toMatchObject({ kind: operation === "stop" ? "stop-unconfirmed" : "force-delete-stop-failed", reason: "deadline-exhausted", stateReverted: true });
            expect(observations).toBe(2); expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined }); expect(f.trace).not.toContain("remove-avd");
        });

        it.each(["admission", "abort", "publication"] as const)(`${operation} preserves an exact successor installed during %s`, async phase => {
            const original = recoverable(), successor = { ...original, lifecycle: { operation: "start", runtimeId: "successor", claimedAt: "successor-time" }, extra: { raw: "successor" } }, f = directLifecyclePorts(original);
            if (phase === "publication") f.ports.terminateOwnedRuntimeProcessTree = async () => { f.replace(successor); return { exited: true }; };
            else f.ports.observeAndroidEmulator = () => { f.replace(successor); return phase === "abort" ? { kind: "unavailable", reason: "inventory-unavailable" } : live(); };
            const app = createAndroidEmulatorLifecycle(f.ports);
            const result = operation === "stop" ? await app.stop({ deviceId: original.id }) : await app.delete({ deviceId: original.id, force: true });
            expect(result && "kind" in result ? result.kind : undefined).not.toBe(operation === "stop" ? "stopped" : "deleted");
            expect(f.current()).toBe(successor); expect(f.trace).not.toContain("remove-avd");
            if (phase !== "publication") { expect(f.trace).not.toContain("stop-emulator"); expect(f.trace).not.toContain("stop-recorder"); }
        });
    }

    it("recorder cleanup may consume the remaining allowance but cannot authorize another native callback", async () => {
        const original = recoverable(), f = directLifecyclePorts(original); let observations = 0;
        f.ports.observeAndroidEmulator = () => { observations++; return live(); };
        f.ports.stopAndroidRecorder = () => { f.advanceTime(30000); return { ok: true, diagnostic: {} }; };
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(result).toMatchObject({ kind: "stop-unconfirmed", reason: "deadline-exhausted", stateReverted: true });
        expect(observations).toBe(1); expect(f.trace).not.toContain("stop-emulator"); expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined });
    });

    it("force-delete requires recorded owned-runtime exit rather than falling back to a live PID observation", async () => {
        const original = recoverable(), f = directLifecyclePorts(original);
        f.ports.terminateOwnedRuntimeProcessTree = async () => ({ exited: false, reason: "identity-unverified" });
        f.ports.waitForProcessExit = async () => { throw new Error("PID-only fallback must never be used"); };
        const result = await createAndroidEmulatorLifecycle(f.ports).delete({ deviceId: original.id, force: true });
        expect(result).toMatchObject({ kind: "force-delete-stop-failed", runtimeStop: { exited: false }, stateReverted: true });
        expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined });
    });

    it("a recorder identity refusal keeps all recoverable evidence and does not send emulator kill", async () => {
        const original = recoverable(), f = directLifecyclePorts(original), diagnostic = { error: "identity-mismatch" };
        f.ports.stopAndroidRecorder = () => ({ ok: false, diagnostic });
        const result = await createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id });
        expect(result).toMatchObject({ kind: "native-failure", diagnostic });
        expect({ ...f.current(), updatedAt: undefined }).toEqual({ ...original, updatedAt: undefined }); expect(f.trace).not.toContain("stop-emulator");
    });

    it("repository publication failures retain their original storage error identity", async () => {
        const original = recoverable(), f = directLifecyclePorts(original), storageError = new Error("state file cannot be replaced");
        const transition = f.ports.transitionAndroidDevice;
        f.ports.transitionAndroidDevice = (...args) => { if (args[2]?.status === "stopped") throw storageError; return transition(...args); };
        await expect(createAndroidEmulatorLifecycle(f.ports).stop({ deviceId: original.id })).rejects.toBe(storageError);
        expect(f.current()?.runtime).toBe(original.runtime);
    });
});
