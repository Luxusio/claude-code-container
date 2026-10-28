import { describe, expect, it } from "vitest";
import { createBrokerIosSimulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import { brokerIosReplacement, type BrokerIosLifecycleInput, type BrokerIosLifecycleResponse, type BrokerIosProviderResult, type BrokerIosCreateResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosSimulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/ios-simulator-lifecycle.js";

type Effect = { readonly token: unique symbol };

// Consumed by the normal strict compiler; this function is never invoked.
function contracts(ports: BrokerIosSimulatorLifecyclePorts<Effect>, input: BrokerIosLifecycleInput<Effect>, effect: Effect, outcome: BrokerIosLifecycleResponse<Effect>) {
    const app = createBrokerIosSimulatorLifecycle(ports);
    const outcomes: Promise<BrokerIosLifecycleResponse<Effect>>[] = [app.create(input), app.start(input), app.stop(input), app.delete(input)];
    const plan = app.planExisting(input.ownerId, input.parsed, input.expectedDevice);
    if (plan.kind === "ready") {
        const prepared: Effect = plan.effect;
        const result: BrokerIosProviderResult = ports.execute(prepared, { timeoutMs: 5000, outputLimit: 32768 });
        void result;
        // @ts-expect-error opaque native effects expose no process arguments
        prepared.args;
    }
    const deletion: Effect = ports.prepareDelete(effect, "owned");
    const creation: BrokerIosCreateResult = ports.executeCreate(effect, { timeoutMs: 5000, outputLimit: 32768 });
    const { executeCreate, ...withoutCreateObservation } = ports;
    // @ts-expect-error create requires its settled native identity observation
    createBrokerIosSimulatorLifecycle(withoutCreateObservation);
    const { prepareCreate, ...withoutPreparation } = ports;
    // @ts-expect-error finite native preparation is required
    createBrokerIosSimulatorLifecycle(withoutPreparation);
    // @ts-expect-error preparation settles synchronously before execution
    createBrokerIosSimulatorLifecycle({ ...ports, prepareExisting: async () => ({ kind: "metadata-only" }) });
    // @ts-expect-error native effect observations are synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, execute: async () => ({ ok: true, mode: "exec", provider: "simctl", receipt: null }) });
    // @ts-expect-error create identity observations are synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, executeCreate: async () => ({ ok: true, mode: "exec", provider: "simctl", createdUdid: "created-udid", receipt: null }) });
    // @ts-expect-error publication reports found and matched independently
    createBrokerIosSimulatorLifecycle({ ...ports, publish: () => ({ matched: true, device: null }) });
    // @ts-expect-error complete-record publication is synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, publish: async () => ({ found: true, matched: true, device: null }) });
    // @ts-expect-error cleanup identifies committed expected-record advancement
    createBrokerIosSimulatorLifecycle({ ...ports, cleanupAuxiliary: () => ({ committed: true }) });
    // @ts-expect-error semantic outcomes have no HTTP status
    outcome.status;
    // @ts-expect-error semantic outcomes have no HTTP payload
    outcome.payload;
    // @ts-expect-error owned target verification is synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, verifyOwnedTarget: async () => ({ ok: true, target: "udid" }) });
    const { observeShutdown, ...withoutShutdownObservation } = ports;
    // @ts-expect-error native shutdown confirmation is required
    createBrokerIosSimulatorLifecycle(withoutShutdownObservation);
    const { now, ...withoutMonotonicClock } = ports;
    // @ts-expect-error shutdown execution and observation share a monotonic allowance
    createBrokerIosSimulatorLifecycle(withoutMonotonicClock);
    const { sleep, ...withoutPause } = ports;
    // @ts-expect-error shutdown polling must yield through its required pause port
    createBrokerIosSimulatorLifecycle(withoutPause);
    // @ts-expect-error each native inventory observation settles synchronously
    createBrokerIosSimulatorLifecycle({ ...ports, observeShutdown: async () => ({ ok: true, state: "Shutdown" }) });
    void [outcomes, deletion, creation, executeCreate, prepareCreate];
    void [observeShutdown, now, sleep];
}
void contracts;

it("stops an iOS record without removing unrelated ownership metadata", () => {
    const device = { id: "owned", status: "running", udid: "owned-udid", ownerId: "owner", extra: { retained: true } };
    expect(brokerIosReplacement(device, { kind: "stop" })).toEqual({ ...device, status: "stopped" });
    expect(device.status).toBe("running");
});

type ShutdownState = "Shutdown" | "Booted" | "Shutting Down" | null;
type StopEffect = { kind: "shutdown" };
function shutdownFixture(options: {
    nativeDuration?: number; observationDuration?: number; timeoutMs?: number;
    states?: ShutdownState[]; nativeOk?: boolean; observationOk?: boolean;
    auxiliaryCommitted?: boolean; auxiliaryFailed?: boolean; successor?: boolean; publicationDuration?: number;
} = {}) {
    let clock = 0, observationCount = 0;
    const original = { id: "ios-unit", udid: "owned-udid", simulatorName: "ccc-owner-unit", status: "running", extra: "retained" };
    const cleaned = { ...original, recording: null };
    const successor = { ...original, name: "Successor", extra: "winner" };
    let current: unknown = options.successor ? successor : original;
    const trace: string[] = [], executions: Array<{ timeoutMs: number; outputLimit: number }> = [];
    const observations: Array<{ effect: StopEffect; owner: string; device: unknown; timeoutMs: number; outputLimit: number }> = [];
    const pauses: number[] = [], publications: Array<{ expected: unknown; kind: string }> = [];
    const execution: BrokerIosProviderResult = { ok: options.nativeOk !== false, mode: "exec", provider: "xcrun", receipt: { status: options.nativeOk === false ? 7 : 0, signal: null, timedOut: false } };
    const effect: StopEffect = { kind: "shutdown" };
    const ports: BrokerIosSimulatorLifecyclePorts<StopEffect> = {
        execute(_effect, allowance) { trace.push("execute"); executions.push(allowance); clock += options.nativeDuration || 0; return execution; },
        executeCreate() { throw new Error("unexpected create"); },
        prepareCreate() { throw new Error("unexpected create planning"); },
        prepareExisting() { return { kind: "ready", effect, provider: "xcrun", canCompensate: true, bootEligible: false }; },
        prepareDelete() { throw new Error("unexpected delete planning"); },
        timestamp: () => "2031-01-02T03:04:05.000Z",
        claimDefinition() { throw new Error("unexpected definition claim"); },
        cleanupAuxiliary() {
            trace.push("auxiliary");
            clock += 6000; // The command allowance starts after auxiliary cleanup.
            if (options.auxiliaryCommitted) current = cleaned;
            return { committed: Boolean(options.auxiliaryCommitted), device: options.auxiliaryCommitted ? cleaned : original,
                result: { ok: !options.auxiliaryFailed, changed: Boolean(options.auxiliaryCommitted), appium: {}, recording: {}, minimizeWatchdog: {} } };
        },
        publish(_owner, _state, _id, expected, change, allowance) {
            trace.push("publish"); publications.push({ expected, kind: change.kind });
            clock += options.publicationDuration || 0;
            const matched = JSON.stringify(current) === JSON.stringify(expected);
            if (matched && allowance && !(allowance.remainingMs() > 0)) return { found: true, matched: true, device: current, deadlineExpired: true };
            if (matched) current = { ...(current as Record<string, unknown>), status: "stopped" };
            return { found: true, matched, device: current };
        },
        stateErrorCode: () => null,
        commandTimeoutMs: options.timeoutMs ?? 1000, outputLimit: 32768,
        verifyOwnedTarget: () => ({ ok: true, target: original.udid }),
        observeShutdown(observedEffect, owner, device, allowance) {
            trace.push("observe"); observations.push({ effect: observedEffect, owner, device, ...allowance });
            clock += options.observationDuration || 0;
            const states = options.states || ["Shutdown"];
            const state = states[Math.min(observationCount++, states.length - 1)];
            return { ok: options.observationOk !== false, state };
        },
        now: () => clock,
        async sleep(ms) { trace.push("pause"); pauses.push(ms); clock += ms; },
    };
    const input: BrokerIosLifecycleInput<StopEffect> = { ownerId: "owner", expectedDevice: original,
        parsed: { ok: true, backend: "ios-simulator", stateKey: "ios", command: "device_stop", deviceId: original.id, force: false, dryRun: false },
        plan: { device: original, providerCommand: { kind: "ready", effect, provider: "xcrun", canCompensate: true, bootEligible: false } } };
    return { ports, input, execution, original, cleaned, successor, trace, executions, observations, pauses, publications, current: () => current };
}

describe("broker iOS shutdown settlement allowance", () => {
    it("confirms native Shutdown after execution before publishing while excluding prior cleanup time", async () => {
        const f = shutdownFixture({ nativeDuration: 17 });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", shutdown: { ok: true, attempts: 1, lastState: "Shutdown" } });
        expect(f.trace).toEqual(["auxiliary", "execute", "observe", "publish"]);
        expect(f.executions).toEqual([{ timeoutMs: 1000, outputLimit: 32768 }]);
        expect(f.observations).toEqual([{ effect: { kind: "shutdown" }, owner: "owner", device: f.original, timeoutMs: 983, outputLimit: 32768 }]);
        expect(f.current()).toEqual({ ...f.original, status: "stopped" });
    });
    it("rechecks Booted and Shutting Down without repeating shutdown and reduces every native allowance", async () => {
        const f = shutdownFixture({ nativeDuration: 20, observationDuration: 10, states: ["Booted", "Shutting Down", "Shutdown"] });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", shutdown: { ok: true, attempts: 3, lastState: "Shutdown" } });
        expect(f.executions).toHaveLength(1); expect(f.pauses).toEqual([100, 100]);
        expect(f.observations.map(observation => observation.timeoutMs)).toEqual([980, 870, 760]);
        expect(f.trace.at(-1)).toBe("publish");
    });
    it("retains successful native execution but refuses publication when Booted exhausts the same allowance", async () => {
        const f = shutdownFixture({ timeoutMs: 240, nativeDuration: 30, observationDuration: 5, states: ["Booted"] });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "operation-failed", success: false, execution: { receipt: { status: 0 } }, shutdown: { ok: false, reason: "timed-out", lastState: "Booted" } });
        expect(f.executions).toHaveLength(1); expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
        expect(f.observations.map(observation => observation.timeoutMs)).toEqual([210, 105]);
        expect(f.pauses).toEqual([100, 100]);
    });
    it("does not start an inventory call after shutdown consumes the allowance", async () => {
        const f = shutdownFixture({ timeoutMs: 240, nativeDuration: 240 });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed", shutdown: { ok: false, reason: "timed-out", attempts: 0 } });
        expect(f.observations).toEqual([]); expect(f.pauses).toEqual([]); expect(f.publications).toEqual([]);
    });
    it("does not execute a native shutdown when the admitted command allowance is already exhausted", async () => {
        const f = shutdownFixture({ timeoutMs: 0 });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed", shutdown: { ok: false, reason: "timed-out", attempts: 0 } });
        expect(f.executions).toEqual([]); expect(f.observations).toEqual([]); expect(f.publications).toEqual([]);
    });
    it("rejects native Shutdown observed at the deadline without a fresh allowance", async () => {
        const f = shutdownFixture({ nativeDuration: 40, observationDuration: 960 });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed", shutdown: { ok: false, reason: "timed-out" }, execution: { receipt: { status: 0 } } });
        expect(f.observations).toHaveLength(1); expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
    });
    it("preserves an actual shutdown failure without inventory calls or a fabricated settlement", async () => {
        const f = shutdownFixture({ nativeOk: false });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "operation-failed", execution: { receipt: { status: 7 } } });
        expect(result).not.toHaveProperty("shutdown"); expect(f.observations).toEqual([]); expect(f.pauses).toEqual([]); expect(f.publications).toEqual([]);
    });
    it("fails a rejected native observation immediately instead of treating it as transient Booted", async () => {
        const f = shutdownFixture({ observationOk: false, states: [null] });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed", shutdown: { ok: false, reason: "observation-failed", attempts: 1, lastState: null } });
        expect(f.observations).toHaveLength(1); expect(f.pauses).toEqual([]); expect(f.publications).toEqual([]);
    });
    it("observes and conditionally publishes the auxiliary-cleaned complete expected record", async () => {
        const f = shutdownFixture({ auxiliaryCommitted: true });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "completed" });
        expect(f.observations[0].device).toEqual(f.cleaned); expect(f.publications).toEqual([{ expected: f.cleaned, kind: "stop" }]);
    });
    it("does not execute shutdown after auxiliary cleanup refusal", async () => {
        const f = shutdownFixture({ auxiliaryFailed: true });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "auxiliary-failed" });
        expect(f.executions).toEqual([]); expect(f.observations).toEqual([]); expect(f.publications).toEqual([]);
    });
    it("retains a successor after native shutdown confirmation instead of adopting it", async () => {
        const f = shutdownFixture({ successor: true });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "state-conflict", shutdown: { ok: true, lastState: "Shutdown" } });
        expect(f.current()).toEqual(f.successor); expect(f.publications).toEqual([{ expected: f.original, kind: "stop" }]);
    });
    it("does not publish stopped when acquiring the final state lock consumes the remaining allowance", async () => {
        const f = shutdownFixture({ nativeDuration: 40, observationDuration: 10, publicationDuration: 950 });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed", shutdown: { ok: false, reason: "timed-out", lastState: "Shutdown" }, execution: { receipt: { status: 0 } } });
        expect(f.publications).toEqual([{ expected: f.original, kind: "stop" }]);
        expect(f.current()).toEqual(f.original);
    });
});
