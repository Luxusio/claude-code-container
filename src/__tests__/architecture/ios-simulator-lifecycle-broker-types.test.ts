import { describe, expect, it } from "vitest";
import { createBrokerIosSimulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import { brokerIosReplacement, type BrokerIosLifecycleInput, type BrokerIosLifecycleResponse, type BrokerIosProviderResult, type BrokerIosCreateResult, type BrokerIosConditionalShutdownExecution } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/ios-simulator-lifecycle.js";
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
    const { executeShutdownIfCurrent, ...withoutConditionalShutdown } = ports;
    // @ts-expect-error a reissue requires the complete-record guard and execution in one port
    createBrokerIosSimulatorLifecycle(withoutConditionalShutdown);
    const conditional: BrokerIosConditionalShutdownExecution = ports.executeShutdownIfCurrent(input.ownerId, input.parsed,
        input.expectedDevice, effect, { remainingMs: () => 100, outputLimit: 32768 });
    if (conditional.kind === "executed") {
        const observed: BrokerIosProviderResult = conditional.execution;
        void observed;
    }
    // @ts-expect-error the guarded native leaf must settle while holding the synchronous state lock
    createBrokerIosSimulatorLifecycle({ ...ports, executeShutdownIfCurrent: async () => ({ kind: "timed-out" }) });
    // @ts-expect-error a conflict must report whether the current record was found
    createBrokerIosSimulatorLifecycle({ ...ports, executeShutdownIfCurrent: () => ({ kind: "state-conflict", device: null }) });
    void [outcomes, deletion, creation, executeCreate, prepareCreate];
    void [observeShutdown, now, sleep, executeShutdownIfCurrent, conditional];
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
    retryOk?: boolean; conditionalDuration?: number; replaceOnObservation?: boolean;
} = {}) {
    let clock = 0, observationCount = 0;
    const original = { id: "ios-unit", udid: "owned-udid", simulatorName: "ccc-owner-unit", status: "running", extra: "retained" };
    const cleaned = { ...original, recording: null };
    const successor = { ...original, name: "Successor", extra: "winner" };
    let current: unknown = options.successor ? successor : original;
    const trace: string[] = [], executions: Array<{ timeoutMs: number; outputLimit: number }> = [];
    const executedEffects: StopEffect[] = [], conditionalGuards: Array<{ owner: string; parsed: unknown; expected: unknown; effect: StopEffect; remainingMs: number }> = [];
    const observations: Array<{ effect: StopEffect; owner: string; device: unknown; timeoutMs: number; outputLimit: number }> = [];
    const pauses: number[] = [], publications: Array<{ expected: unknown; kind: string }> = [];
    const execution: BrokerIosProviderResult = { ok: options.nativeOk !== false, mode: "exec", provider: "xcrun", receipt: { status: options.nativeOk === false ? 7 : 0, signal: null, timedOut: false } };
    const retryExecution: BrokerIosProviderResult = { ok: options.retryOk !== false, mode: "exec", provider: "xcrun", receipt: { status: options.retryOk === false ? 9 : 0, signal: null, timedOut: false } };
    const effect: StopEffect = { kind: "shutdown" };
    const ports: BrokerIosSimulatorLifecyclePorts<StopEffect> = {
        execute(executedEffect, allowance) { trace.push("execute"); executions.push(allowance); executedEffects.push(executedEffect); clock += options.nativeDuration || 0; return executions.length === 1 ? execution : retryExecution; },
        executeShutdownIfCurrent(owner, parsed, expected, guardedEffect, allowance) {
            trace.push("conditional");
            conditionalGuards.push({ owner, parsed, expected, effect: guardedEffect, remainingMs: allowance.remainingMs() });
            clock += options.conditionalDuration || 0;
            if (!(Math.floor(allowance.remainingMs()) > 0)) return { kind: "timed-out" };
            if (JSON.stringify(current) !== JSON.stringify(expected)) return { kind: "state-conflict", found: current !== null, device: current };
            return { kind: "executed", execution: ports.execute(guardedEffect, { timeoutMs: Math.floor(allowance.remainingMs()), outputLimit: allowance.outputLimit }) };
        },
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
            if (options.replaceOnObservation) current = successor;
            return { ok: options.observationOk !== false, state };
        },
        now: () => clock,
        async sleep(ms) { trace.push("pause"); pauses.push(ms); clock += ms; },
    };
    const input: BrokerIosLifecycleInput<StopEffect> = { ownerId: "owner", expectedDevice: original,
        parsed: { ok: true, backend: "ios-simulator", stateKey: "ios", command: "device_stop", deviceId: original.id, force: false, dryRun: false },
        plan: { device: original, providerCommand: { kind: "ready", effect, provider: "xcrun", canCompensate: true, bootEligible: false } } };
    return { ports, input, execution, retryExecution, original, cleaned, successor, trace, executions, executedEffects, conditionalGuards,
        observations, pauses, publications, current: () => current, replace: (value: unknown) => { current = value; }, advance: (ms: number) => { clock += ms; } };
}

describe("broker iOS shutdown settlement allowance", () => {
    it("reissues shutdown once when native state remains Booted until the second command", async () => {
        const f = shutdownFixture({ nativeDuration: 10 });
        const ports: BrokerIosSimulatorLifecyclePorts<StopEffect> = {
            ...f.ports,
            executeShutdownIfCurrent(owner, parsed, expected, effect, options): BrokerIosConditionalShutdownExecution {
                expect(owner).toBe(f.input.ownerId);
                expect(parsed).toBe(f.input.parsed);
                expect(expected).toBe(f.original);
                expect(effect).toBe(f.executedEffects[0]);
                return { kind: "executed", execution: f.ports.execute(effect, { timeoutMs: options.remainingMs(), outputLimit: options.outputLimit }) };
            },
            observeShutdown() { return { ok: true, state: f.executions.length < 2 ? "Booted" : "Shutdown" }; },
        };
        const result = await createBrokerIosSimulatorLifecycle(ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", shutdown: { ok: true, commandAttempts: 2, lastState: "Shutdown" } });
        expect(f.executions).toHaveLength(2);
        expect(f.current()).toEqual({ ...f.original, status: "stopped" });
    });
    it("confirms native Shutdown after execution before publishing while excluding prior cleanup time", async () => {
        const f = shutdownFixture({ nativeDuration: 17 });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", shutdown: { ok: true, attempts: 1, commandAttempts: 1, lastState: "Shutdown" } });
        expect(f.trace).toEqual(["auxiliary", "execute", "observe", "publish"]);
        expect(f.executions).toEqual([{ timeoutMs: 1000, outputLimit: 32768 }]);
        expect(f.observations).toEqual([{ effect: { kind: "shutdown" }, owner: "owner", device: f.original, timeoutMs: 983, outputLimit: 32768 }]);
        expect(f.current()).toEqual({ ...f.original, status: "stopped" });
        expect(f.conditionalGuards).toEqual([]); expect(result).not.toHaveProperty("retryExecution");
    });
    it("reissues only once for Booted and reduces every native allowance through Shutting Down", async () => {
        const f = shutdownFixture({ nativeDuration: 20, observationDuration: 10, states: ["Booted", "Shutting Down", "Shutdown"] });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", shutdown: { ok: true, attempts: 3, commandAttempts: 2, lastState: "Shutdown" } });
        expect(f.executions).toHaveLength(2);
        expect(f.conditionalGuards).toHaveLength(1);
        expect(f.executedEffects[1]).toBe(f.executedEffects[0]);
        expect(f.executions[1].timeoutMs).toBeLessThan(f.observations[0].timeoutMs);
        expect(f.observations[1].timeoutMs).toBeLessThan(f.executions[1].timeoutMs);
        expect(f.observations[2].timeoutMs).toBeLessThan(f.observations[1].timeoutMs);
        expect(f.executions.every(call => call.outputLimit === 32768 && call.timeoutMs > 0)).toBe(true);
        expect(f.trace.at(-1)).toBe("publish");
    });
    it("retains successful native execution but refuses publication when Booted exhausts the same allowance", async () => {
        const f = shutdownFixture({ timeoutMs: 240, nativeDuration: 30, observationDuration: 5, states: ["Booted"] });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "operation-failed", success: false, execution: { receipt: { status: 0 } }, shutdown: { ok: false, commandAttempts: 2, reason: "timed-out", lastState: "Booted" } });
        expect(f.executions).toHaveLength(2); expect(f.conditionalGuards).toHaveLength(1);
        expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
        expect(f.observations[0].timeoutMs).toBe(210);
        expect(f.executions[1].timeoutMs).toBeLessThan(210);
        expect(f.observations.every(call => call.timeoutMs > 0 && call.timeoutMs <= 210)).toBe(true);
        expect(f.pauses.every(pause => pause > 0 && pause <= 100)).toBe(true);
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
        expect(f.executions).toHaveLength(1); expect(f.conditionalGuards).toEqual([]);
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
    it("polls Shutting Down without issuing a second shutdown", async () => {
        const f = shutdownFixture({ states: ["Shutting Down", "Shutting Down", "Shutdown"] });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "completed",
            shutdown: { ok: true, commandAttempts: 1, attempts: 3, lastState: "Shutdown" } });
        expect(f.executions).toHaveLength(1); expect(f.conditionalGuards).toEqual([]);
        expect(f.pauses).toEqual([100, 100]);
    });
    it("refuses a Booted observation that arrives at the deadline before considering reissue", async () => {
        const f = shutdownFixture({ nativeDuration: 40, observationDuration: 960, states: ["Booted"] });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed",
            execution: { receipt: { status: 0 } }, shutdown: { ok: false, reason: "timed-out", commandAttempts: 1 } });
        expect(f.executions).toHaveLength(1); expect(f.conditionalGuards).toEqual([]);
        expect(f.observations).toHaveLength(1); expect(f.publications).toEqual([]);
    });
    it("spends the same command allowance waiting for the conditional guard and dispatches nothing after expiry", async () => {
        const f = shutdownFixture({ nativeDuration: 20, observationDuration: 10, states: ["Booted"], conditionalDuration: 1000 });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "operation-failed", execution: { receipt: { status: 0 } },
            shutdown: { ok: false, reason: "timed-out", commandAttempts: 1, lastState: "Booted" } });
        expect(f.conditionalGuards).toHaveLength(1);
        expect(f.conditionalGuards[0].remainingMs).toBeGreaterThan(0);
        expect(f.conditionalGuards[0].remainingMs).toBeLessThanOrEqual(970);
        expect(f.executions).toHaveLength(1); expect(f.observations).toHaveLength(1);
        expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
        expect(result).not.toHaveProperty("retryExecution");
    });
    it.each(["during-observation", "before-dispatch", "missing"])("refuses the reissue when the expected record changes %s", async replacement => {
        const f = shutdownFixture({ states: ["Booted"], replaceOnObservation: replacement === "during-observation" });
        const ports: BrokerIosSimulatorLifecyclePorts<StopEffect> = {
            ...f.ports,
            executeShutdownIfCurrent(...args: Parameters<BrokerIosSimulatorLifecyclePorts<StopEffect>["executeShutdownIfCurrent"]>) {
                if (replacement !== "during-observation") f.replace(replacement === "missing" ? null : f.successor);
                return f.ports.executeShutdownIfCurrent(...args);
            },
        };
        const result = await createBrokerIosSimulatorLifecycle(ports).stop(f.input);
        expect(result).toMatchObject({ kind: "state-conflict", execution: { receipt: { status: 0 } },
            shutdown: { ok: false, commandAttempts: 1, lastState: "Booted" } });
        expect(f.executions).toHaveLength(1); expect(f.conditionalGuards).toHaveLength(1);
        expect(f.conditionalGuards[0].expected).toBe(f.original);
        expect(f.current()).toEqual(replacement === "missing" ? null : f.successor);
        expect(f.observations).toHaveLength(1); expect(f.publications).toEqual([]);
        expect(result).not.toHaveProperty("retryExecution");
    });
    it("guards the auxiliary-cleaned full record and reuses the exact prepared effect", async () => {
        const f = shutdownFixture({ auxiliaryCommitted: true, states: ["Booted", "Shutdown"] });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "completed",
            shutdown: { commandAttempts: 2, ok: true } });
        expect(f.conditionalGuards).toHaveLength(1);
        expect(f.conditionalGuards[0]).toMatchObject({ owner: "owner", parsed: f.input.parsed, expected: f.cleaned });
        expect(f.conditionalGuards[0].expected).toEqual(f.cleaned);
        expect(f.executedEffects[1]).toBe(f.executedEffects[0]);
        for (const observation of f.observations) expect(observation.device).toEqual(f.cleaned);
        expect(f.publications).toEqual([{ expected: f.cleaned, kind: "stop" }]);
    });
    it("continues confirmation after a failed reissue and preserves both immutable receipts on success", async () => {
        const f = shutdownFixture({ retryOk: false, states: ["Booted", "Shutdown"] });
        const result = await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input);
        expect(result).toMatchObject({ kind: "completed", execution: { ok: true, receipt: { status: 0 } },
            retryExecution: { ok: false, receipt: { status: 9 } }, shutdown: { ok: true, commandAttempts: 2, lastState: "Shutdown" } });
        if ("execution" in result) expect(result.execution).toBe(f.execution);
        if ("retryExecution" in result) expect(result.retryExecution).toBe(f.retryExecution);
        expect(f.execution.receipt).toEqual({ status: 0, signal: null, timedOut: false });
        expect(f.executions).toHaveLength(2); expect(f.observations).toHaveLength(2);
        expect(f.current()).toEqual({ ...f.original, status: "stopped" });
    });
    it("keeps a failed reissue distinct while permanent Booted still fails without a third command", async () => {
        const f = shutdownFixture({ retryOk: false, timeoutMs: 240, states: ["Booted"] });
        expect(await createBrokerIosSimulatorLifecycle(f.ports).stop(f.input)).toMatchObject({ kind: "operation-failed",
            execution: { ok: true, receipt: { status: 0 } }, retryExecution: { ok: false, receipt: { status: 9 } },
            shutdown: { ok: false, reason: "timed-out", commandAttempts: 2, lastState: "Booted" } });
        expect(f.executions).toHaveLength(2); expect(f.conditionalGuards).toHaveLength(1);
        expect(f.observations.length).toBeGreaterThan(1);
        expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
    });
    it.each(["Booted", "Shutting Down"] as const)("preserves the last valid %s state when a later observation is unavailable", async state => {
        const f = shutdownFixture({ states: [state, null] });
        const ports: BrokerIosSimulatorLifecyclePorts<StopEffect> = {
            ...f.ports,
            observeShutdown(...args: Parameters<BrokerIosSimulatorLifecyclePorts<StopEffect>["observeShutdown"]>) {
                const observation = f.ports.observeShutdown(...args);
                return observation.state === null ? { ok: false, state: null } : observation;
            },
        };
        expect(await createBrokerIosSimulatorLifecycle(ports).stop(f.input)).toMatchObject({ kind: "operation-failed",
            execution: { receipt: { status: 0 } }, shutdown: { ok: false, reason: "observation-failed", attempts: 2,
                commandAttempts: state === "Booted" ? 2 : 1, lastState: state } });
        expect(f.publications).toEqual([]); expect(f.current()).toEqual(f.original);
        expect(f.executions).toHaveLength(state === "Booted" ? 2 : 1);
    });
});
