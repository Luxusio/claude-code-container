import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { createBrokerMacosVmLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/macos-vm-lifecycle.js";
import { brokerMacosReplacement, type BrokerMacosLifecycleInput, type BrokerMacosLifecycleRequest, type BrokerMacosProviderResult, type BrokerMacosIpObservation, type BrokerMacosPublicationChange, type BrokerMacosHelperPreparation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/macos-vm-lifecycle.js";

type Effect = { operation: string; target: string };
type MutablePorts = { -readonly [K in keyof BrokerMacosVmLifecyclePorts<Effect>]: BrokerMacosVmLifecyclePorts<Effect>[K] };
const timestamp = "2026-10-19T00:00:00.000Z";
const native = (ok = true): BrokerMacosProviderResult => ({ ok, mode: "exec", provider: "tart", resourceMissing: false, receipt: { nativeOnly: "owned diagnostic" } });
const ip = (address: string | null = "192.0.2.24", ok = true): BrokerMacosIpObservation => ({ ...native(ok), address });
const device = (): Record<string, unknown> => ({ id: "unit", ownerId: "owner", backend: "macos-vm", provider: "tart", providerInstance: "owned-unit", status: "stopped", ssh: { user: "guest", keyPath: "/owned/key" }, extra: { retained: true } });
function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** A complete-record repository: persisted publication metadata is part of the next CAS. */
function fixture(initial: Record<string, unknown> | null = device()) {
    let current = initial, clock = 0, identities = 0, revision = 0;
    const trace: string[] = [];
    const publications: Array<{ expected: unknown; change: BrokerMacosPublicationChange; device: unknown }> = [];
    const claims: Record<string, unknown>[] = [];
    const ports: MutablePorts = {
        runtimeId: () => `launch-${++identities}`,
        timestamp: () => timestamp,
        prepareCreate: input => ({ kind: "ready", effect: { operation: "create", target: input.instance }, provider: input.provider, canCompensate: true, bootEligible: true }),
        prepareExisting: input => ({ kind: "ready", effect: { operation: input.parsed.command, target: input.instance }, provider: input.provider, canCompensate: false, bootEligible: true }),
        prepareDelete: (_effect, target) => { trace.push("prepare-delete"); return { operation: "compensate-delete", target }; },
        execute: effect => { trace.push(`execute:${effect.operation}`); return native(); },
        executeMetadata: purpose => { trace.push(`metadata:${purpose}`); return { ...native(), mode: "noop", provider: "host-broker-state" }; },
        observeIp: (_effect, target, resolver) => { trace.push(`probe:${target}:${resolver}`); return ip(); },
        provisionGuestHelper: () => ({ ok: true, skipped: false, helper: { status: "provisioned" } }),
        sleep: ms => { trace.push(`sleep:${ms}`); clock += ms; return undefined; },
        now: () => clock,
        commandTimeoutMs: 15000,
        outputLimit: 8192,
        claimDefinition: (_owner, _parsed, value) => { trace.push("claim"); claims.push(value); current = value; return { ok: true, device: value }; },
        cleanupAuxiliary: (_owner, _parsed, expected) => { trace.push("auxiliary"); return { committed: false, device: expected, result: { ok: true, changed: false, appium: {}, recording: {}, minimizeWatchdog: {} } }; },
        publish: (_owner, _stateKey, _deviceId, expected, change) => {
            trace.push(`publish:${change.kind}`);
            if (!isDeepStrictEqual(current, expected)) {
                publications.push({ expected, change, device: current });
                return { found: current !== null, matched: false, device: current };
            }
            const replacement = brokerMacosReplacement(current!, change);
            current = replacement ? { ...replacement, repositoryRevision: ++revision } : null;
            publications.push({ expected, change, device: current });
            return { found: true, matched: true, device: current };
        },
        stateErrorCode: () => null,
    };
    const input = (command = "device_start", extra: Partial<BrokerMacosLifecycleRequest> = {}): BrokerMacosLifecycleInput<Effect> => {
        const parsed: BrokerMacosLifecycleRequest = { ok: true, backend: "macos-vm", stateKey: "macos", deviceId: "unit", command, force: false, dryRun: false, waitForBoot: false, bootTimeoutMs: 1000, ...extra };
        const app = createBrokerMacosVmLifecycle(ports);
        return { ownerId: "owner", parsed, expectedDevice: current, plan: { device: current, providerCommand: command === "device_create" ? app.planCreate("owner", parsed) : app.planExisting("owner", parsed, current) } };
    };
    return { ports, trace, publications, claims, input, current: () => current, replace: (value: Record<string, unknown> | null) => { current = value; }, setNow: (value: number) => { clock = value; }, advance: (ms: number) => { clock += ms; } };
}

function expectPending(value: unknown) {
    expect(value).toMatchObject({ status: "starting", providerInstance: "owned-unit", lifecycle: { runtimeId: "launch-1", operation: "start", claimedAt: timestamp } });
    expect(Object.keys((value as { lifecycle: object }).lifecycle).sort()).toEqual(["claimedAt", "operation", "runtimeId"]);
}

describe("broker macOS launch reservation and recovery", () => {
    it.each(["refused", "throws"])("dispatches nothing when the prelaunch reservation %s", async failure => {
        const original = device(), f = fixture(original);
        const publish = f.ports.publish;
        f.ports.publish = (...args) => {
            expect(args[3]).toBe(original);
            expect(args[4]).toMatchObject({ kind: "reserve-start", lifecycle: { runtimeId: "launch-1", operation: "start", claimedAt: timestamp } });
            if (failure === "throws") throw Error("private reservation failure");
            f.replace({ ...original, externalRevision: true });
            return publish(...args);
        };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result.kind).toBe(failure === "throws" ? "state-failed" : "state-conflict");
        if (failure === "refused") expect(result).toMatchObject({ invoked: false, mutatesHost: false, recoveryRequired: false });
        expect(f.trace.filter(step => /^(execute|probe|sleep|auxiliary)/.test(step))).toEqual([]);
        expect(f.current()?.status).toBe("stopped");
    });

    it("completes provider admission before reserving or executing", async () => {
        const original = device(), f = fixture(original), input = f.input();
        input.plan!.providerCommand = { kind: "unavailable", error: "unsupported-provider-command", missing: ["provider"] };
        expect(await createBrokerMacosVmLifecycle(f.ports).start(input)).toMatchObject({ kind: "refused", error: "unsupported-provider-command" });
        expect(f.trace).toEqual([]);
        expect(f.current()).toBe(original);
    });

    it("makes a scalar recovery reservation visible while native launch is held", async () => {
        const f = fixture({ ...device(), bootReady: true, lastBootCheck: { ready: true, ip: "192.0.2.99" } }), held = deferred<BrokerMacosProviderResult>();
        let settled = false;
        f.ports.execute = () => { f.trace.push("execute-held"); return held.promise; };
        const pending = createBrokerMacosVmLifecycle(f.ports).start(f.input()).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(settled).toBe(false);
            expectPending(f.current());
            expect(f.current()).toMatchObject({ bootReady: false, lastBootCheck: null });
            expect(f.trace).toEqual(["publish:reserve-start", "execute-held"]);
            expect(f.publications).toHaveLength(1);
        } finally { held.resolve(native()); await pending.catch(() => undefined); }
    });

    it.each([
        ["nonzero", native(false)],
        ["missing result", undefined],
        ["malformed success", { ok: true }],
    ])("retains recovery and possible mutation after %s execution", async (_name, execution) => {
        const f = fixture();
        f.ports.execute = () => execution as BrokerMacosProviderResult;
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result).toMatchObject({ kind: "operation-failed", success: false, invoked: true, mutatesHost: true, recoveryRequired: true });
        expectPending(f.current());
        expect(result).toHaveProperty("device", f.current());
        expect(f.publications.map(call => call.change.kind)).toEqual(["reserve-start"]);
    });

    it.each([false, true])("turns a thrown launch into redacted partial-effect facts (deferred=%s)", async deferredFailure => {
        const f = fixture();
        f.ports.execute = deferredFailure ? () => {
            const rejected = Promise.reject<BrokerMacosProviderResult>(new Error("secret-launch-command-and-password"));
            void rejected.catch(() => undefined); return rejected;
        } : () => { throw new Error("secret-launch-command-and-password"); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result).toMatchObject({ kind: "operation-failed", invoked: true, mutatesHost: true, recoveryRequired: true, failure: "execution-threw" });
        expect(result).not.toHaveProperty("cause");
        expect(JSON.stringify(result)).not.toContain("secret-launch-command-and-password");
        expectPending(f.current());
    });

    it.each([false, true])("finalizes only the exact returned reservation (waitForBoot=%s)", async waitForBoot => {
        const original = device(), f = fixture(original);
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot }));
        expect(result).toMatchObject({ kind: "completed", success: true, invoked: true, mutatesHost: true, recoveryRequired: false, device: { status: "running", extra: original.extra } });
        expect(f.publications.map(call => call.change.kind)).toEqual(["reserve-start", "start"]);
        expect(f.publications[0].expected).toBe(original);
        expect(f.publications[1].expected).toEqual(f.publications[0].device);
        expect(f.publications[1].expected).toHaveProperty("repositoryRevision", 1);
        expect(f.current()).not.toHaveProperty("lifecycle");
        if (waitForBoot) expect(f.current()).toMatchObject({ bootReady: true, ssh: { host: "192.0.2.24", user: "guest", keyPath: "/owned/key" } });
        else expect(f.trace.filter(step => step.startsWith("probe:"))).toEqual([]);
    });

    it.each(["vz", "utmctl"])("finalizes a successful %s start when boot readiness is explicitly skipped", async provider => {
        const f = fixture({ ...device(), provider });
        f.ports.prepareExisting = input => ({ kind: "ready", effect: { operation: input.parsed.command, target: input.instance }, provider: input.provider, canCompensate: false, bootEligible: false });
        f.ports.execute = effect => { f.trace.push(`execute:${effect.operation}`); return { ...native(), provider }; };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({
            kind: "completed", success: true, invoked: true, mutatesHost: true, recoveryRequired: false,
            boot: { ok: true, ready: false, skipped: true }, device: { status: "running", provider },
        });
        expect(f.current()).toMatchObject({ status: "running", provider });
        expect(f.current()).not.toHaveProperty("lifecycle");
        expect(f.trace).toEqual(["publish:reserve-start", "execute:device_start", "publish:start"]);
    });

    it("requires recovery before another start can replace a pending launch", async () => {
        const original = { ...device(), status: "starting", lifecycle: { runtimeId: "earlier-launch", operation: "start", claimedAt: timestamp } }, f = fixture(original);
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result.kind).toBe("refused");
        expect(f.trace).toEqual([]);
        expect(f.current()).toBe(original);
    });

    it("uses a fresh operation identity for a new launch after confirmed recovery", async () => {
        const f = fixture(), app = createBrokerMacosVmLifecycle(f.ports);
        f.ports.execute = () => native(false);
        await app.start(f.input());
        expectPending(f.current());
        f.ports.execute = () => native();
        expect(await app.stop(f.input("device_stop"))).toMatchObject({ kind: "completed" });
        f.ports.execute = () => native(false);
        expect(await app.start(f.input())).toMatchObject({ kind: "operation-failed", recoveryRequired: true });
        expect(f.current()).toMatchObject({ status: "starting", lifecycle: { runtimeId: "launch-2", operation: "start", claimedAt: timestamp } });
    });

    it("preserves a same-target successor and never compensates by instance name", async () => {
        const f = fixture();
        const successor = { ...device(), status: "running", lifecycle: { runtimeId: "successor", operation: "start", claimedAt: timestamp }, successorMarker: true };
        f.ports.execute = () => { f.trace.push("execute"); f.replace(successor); return native(); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result).toMatchObject({ kind: "state-conflict", invoked: true, mutatesHost: true, recoveryRequired: true });
        expect(f.current()).toBe(successor);
        expect(f.trace).toEqual(["publish:reserve-start", "execute", "publish:start"]);
        expect(f.trace).not.toContain("prepare-delete");
    });

    it.each([false, true])("retains the reservation and semantic mutation when final publication throws (classifierThrows=%s)", async classifierThrows => {
        const f = fixture(), publish = f.ports.publish;
        if (classifierThrows) f.ports.stateErrorCode = () => { throw Error("secret-classifier-error"); };
        f.ports.publish = (...args) => { if (args[4].kind === "start") throw Error("secret-final-publication"); return publish(...args); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input());
        expect(result).toMatchObject({ kind: "operation-failed", invoked: true, mutatesHost: true, recoveryRequired: true, failure: "publication-threw" });
        expect(result).not.toHaveProperty("cause");
        expect(result).not.toHaveProperty("stateError");
        expect(JSON.stringify(result)).not.toContain("secret-final-publication");
        expect(JSON.stringify(result)).not.toContain("secret-classifier-error");
        expectPending(f.current());
        expect(f.trace).not.toContain("prepare-delete");
    });
});

describe("broker macOS finite boot effects", () => {
    it("awaits each IP observation and pacing before asking for another observation", async () => {
        const f = fixture(), probe = deferred<BrokerMacosIpObservation>(), pacing = deferred<undefined>();
        let probes = 0, settled = false;
        f.ports.observeIp = () => { f.trace.push(`probe:${++probes}`); return probes === 1 ? probe.promise : probes === 2 ? ip(null) : ip(); };
        f.ports.sleep = ms => { f.trace.push(`sleep:${ms}`); f.advance(100); return pacing.promise; };
        const pending = createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true })).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(settled).toBe(false);
            expect(probes).toBe(1);
            expect(f.trace.some(step => step.startsWith("sleep:"))).toBe(false);
            expectPending(f.current());
            probe.resolve(ip(null));
            await turn();
            expect(probes).toBe(2);
            expect(settled).toBe(false);
            expect(f.publications).toHaveLength(1);
            pacing.resolve(undefined);
            expect(await pending).toMatchObject({ kind: "completed", boot: { ok: true, ready: true } });
            expect(probes).toBe(3);
        } finally { probe.resolve(ip(null)); pacing.resolve(undefined); await pending.catch(() => undefined); }
    });

    it.each(["probe", "pacing"])("retains redacted recovery when awaited %s rejects", async failure => {
        const f = fixture();
        f.ports.observeIp = failure === "probe" ? () => {
            f.advance(1000);
            const rejected = Promise.reject<BrokerMacosIpObservation>(Error("secret-probe-cause"));
            void rejected.catch(() => undefined); return rejected;
        } : () => ip(null);
        f.ports.sleep = () => {
            f.advance(1000);
            const rejected = Promise.reject<undefined>(Error("secret-pacing-cause"));
            void rejected.catch(() => undefined); return rejected;
        };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "operation-failed", invoked: true, mutatesHost: true, recoveryRequired: true, failure: "boot-threw" });
        expect(result).not.toHaveProperty("cause");
        expect(JSON.stringify(result)).not.toMatch(/secret-(probe|pacing)-cause/);
        expectPending(f.current());
        expect(f.publications).toHaveLength(1);
    });

    it("keeps timed-out launch recovery after charging both probes and pacing", async () => {
        const f = fixture(), allowances: number[] = [];
        f.ports.observeIp = (_effect, _target, _resolver, options) => { allowances.push(options.timeoutMs); f.advance(200); return ip(null, false); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "operation-failed", invoked: true, mutatesHost: true, recoveryRequired: true, boot: { ok: false, reason: "timed-out" } });
        expect(allowances).toEqual([1000, 800]);
        expect(f.trace).toContain("sleep:600");
        expectPending(f.current());
        expect(f.publications).toHaveLength(1);
    });

    it.each([1000, 1001])("refuses a positive IP result settled at monotonic time %s", async completionTime => {
        const f = fixture();
        f.ports.observeIp = async () => { f.setNow(completionTime); return ip(); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "operation-failed", recoveryRequired: true, boot: { ok: false, reason: "timed-out" } });
        expectPending(f.current());
        expect(f.publications).toHaveLength(1);
    });

    it("passes a subsecond monotonic remainder to the next resolver without fabricating 1000 ms", async () => {
        const f = fixture(), allowances: number[] = [];
        f.ports.observeIp = (_effect, _target, resolver, options) => {
            allowances.push(options.timeoutMs);
            if (resolver === "default") { f.advance(975); return ip(null); }
            f.advance(1); return ip();
        };
        expect(await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }))).toMatchObject({ kind: "completed", boot: { ready: true } });
        expect(allowances).toEqual([1000, 25]);
    });

    it("does not dispatch a second resolver after the first has consumed the deadline", async () => {
        const f = fixture();
        let probes = 0;
        f.ports.observeIp = () => { probes++; f.advance(1000); return ip(null); };
        expect(await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }))).toMatchObject({ kind: "operation-failed", boot: { reason: "timed-out" } });
        expect(probes).toBe(1);
        expect(f.trace.some(step => step.startsWith("sleep:"))).toBe(false);
        expectPending(f.current());
    });
});

describe("broker macOS guest helper admission", () => {
    const installed = (): BrokerMacosHelperPreparation => ({ ok: true, skipped: false,
        helper: { status: "provisioned", provider: "ssh-scp", remoteScriptPath: "/tmp/ccc-unit-guest-helper.sh" } });

    it("installs against the reserved record with the discovered host before publishing running", async () => {
        const original = device(), f = fixture(original), preparation = installed();
        f.ports.provisionGuestHelper = (owner, expected, candidate, options) => {
            f.trace.push("install-helper");
            expect(owner).toBe("owner");
            expect(expected).toEqual(f.publications[0].device);
            expectPending(expected);
            expect(candidate).toMatchObject({ ...original, status: "starting", ssh: { host: "192.0.2.24", user: "guest", keyPath: "/owned/key" } });
            expect(candidate).not.toHaveProperty("helper");
            expect(original.ssh).toEqual({ user: "guest", keyPath: "/owned/key" });
            expect(options.waitForReady).toBe(true);
            expect(options.remainingMs()).toBeGreaterThan(0);
            expect(f.current()?.status).toBe("starting");
            expect(f.publications).toHaveLength(1);
            return preparation;
        };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "completed", success: true, recoveryRequired: false,
            device: { status: "running", helper: preparation.helper, ssh: { host: "192.0.2.24", user: "guest", keyPath: "/owned/key" } } });
        expect(f.trace).toEqual(["publish:reserve-start", "execute:device_start", "probe:owned-unit:default", "install-helper", "publish:start"]);
        expect(f.publications[1].expected).toEqual(f.publications[0].device);
        expect(f.publications[1].change).toMatchObject({ kind: "start", helper: preparation.helper });
        expect(f.current()).not.toHaveProperty("lifecycle");
    });

    it("keeps its pending reservation until the finite installer settles", async () => {
        const f = fixture(), installer = deferred<BrokerMacosHelperPreparation>();
        let settled = false;
        f.ports.provisionGuestHelper = () => { f.trace.push("install-held"); return installer.promise; };
        const pending = createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }))
            .then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(settled).toBe(false);
            expectPending(f.current());
            expect(f.current()).not.toHaveProperty("helper");
            expect(f.publications).toHaveLength(1);
            installer.resolve(installed());
            expect(await pending).toMatchObject({ kind: "completed", device: { status: "running", helper: { status: "provisioned" } } });
        } finally { installer.resolve(installed()); await pending.catch(() => undefined); }
    });

    it("shares decreasing admission time across launch, IP, helper and final publication", async () => {
        const f = fixture(), observed: Array<{ stage: string; allowance: number }> = [];
        const admittedAt = f.ports.now();
        f.ports.remainingMs = () => 1000 - (f.ports.now() - admittedAt);
        f.advance(125); // Time already spent waiting for the outer device-operation lock.
        f.ports.execute = (_effect, options) => {
            observed.push({ stage: "launch", allowance: options.timeoutMs });
            expect(options.remainingMs?.()).toBe(875);
            f.advance(200);
            return native();
        };
        f.ports.observeIp = (_effect, _instance, _resolver, options) => {
            observed.push({ stage: "ip", allowance: options.timeoutMs });
            f.advance(175);
            return ip();
        };
        f.ports.provisionGuestHelper = (_owner, _expected, _candidate, options) => {
            observed.push({ stage: "helper", allowance: options.remainingMs() });
            f.advance(100);
            expect(options.remainingMs()).toBe(400);
            return installed();
        };
        expect(await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true })))
            .toMatchObject({ kind: "completed", device: { status: "running" } });
        expect(observed).toEqual([{ stage: "launch", allowance: 875 }, { stage: "ip", allowance: 675 }, { stage: "helper", allowance: 500 }]);
        expect(f.ports.remainingMs()).toBe(400);
    });

    it.each([0, 0.5])("dispatches no native work when the captured allowance is %sms", async remaining => {
        const f = fixture();
        f.ports.remainingMs = () => remaining;
        f.ports.provisionGuestHelper = () => { throw Error("expired installer must not run"); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result.kind).not.toBe("completed");
        expect(f.trace.filter(step => /^(execute|probe|sleep)/.test(step))).toEqual([]);
        expect(f.current()?.status).not.toBe("running");
    });

    it.each(["nonzero", "throw", "malformed"])("retains recovery after a %s installer result without restart or cleanup", async failure => {
        const f = fixture();
        f.ports.provisionGuestHelper = () => {
            f.trace.push("install-helper");
            if (failure === "throw") throw Error("private-installer-output");
            return (failure === "malformed" ? { ok: true } : { ok: false, skipped: false,
                helper: { status: "failed", provider: "scp" }, error: "macos-helper-scp-failed", execution: { status: 255, signal: null, timedOut: false } }) as BrokerMacosHelperPreparation;
        };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "operation-failed", success: false, invoked: true, mutatesHost: true, recoveryRequired: true });
        expectPending(f.current());
        expect(f.current()).not.toHaveProperty("helper");
        expect(f.publications).toHaveLength(1);
        expect(f.trace.filter(step => step.startsWith("execute:"))).toEqual(["execute:device_start"]);
        expect(f.trace).not.toContain("prepare-delete");
        expect(JSON.stringify(result)).not.toContain("private-installer-output");
    });

    it.each([1000, 1001])("refuses successful helper preparation settled at the %sms boundary", async completion => {
        const f = fixture();
        f.ports.provisionGuestHelper = () => { f.setNow(completion); return installed(); };
        const result = await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        expect(result).toMatchObject({ kind: "operation-failed", success: false, recoveryRequired: true });
        expectPending(f.current());
        expect(f.publications).toHaveLength(1);
        expect(f.trace).not.toContain("prepare-delete");
    });

    it("preserves a same-target successor that appears while helper installation is held", async () => {
        const f = fixture(), held = deferred<BrokerMacosHelperPreparation>();
        const successor = { ...device(), status: "running", helper: { status: "provisioned", remoteScriptPath: "/tmp/successor-helper.sh" }, successor: true };
        f.ports.provisionGuestHelper = () => held.promise;
        const pending = createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: true }));
        void pending.catch(() => undefined);
        try {
            await turn();
            expectPending(f.current());
            f.replace(successor);
            held.resolve(installed());
            expect(await pending).toMatchObject({ kind: "state-conflict", success: true, recoveryRequired: true });
            expect(f.current()).toBe(successor);
            expect(f.trace.filter(step => step.startsWith("execute:"))).toEqual(["execute:device_start"]);
            expect(f.trace).not.toContain("prepare-delete");
        } finally { held.resolve(installed()); await pending.catch(() => undefined); }
    });

    it("requests exactly one preparation and no boot polling when waitForBoot is false", async () => {
        const f = fixture({ ...device(), ssh: { host: "192.0.2.80", user: "guest", keyPath: "/owned/key" } });
        let preparations = 0;
        f.ports.provisionGuestHelper = (_owner, _expected, candidate, options) => {
            preparations++;
            expect(options.waitForReady).toBe(false);
            expect(candidate.ssh).toEqual({ host: "192.0.2.80", user: "guest", keyPath: "/owned/key" });
            return installed();
        };
        expect(await createBrokerMacosVmLifecycle(f.ports).start(f.input("device_start", { waitForBoot: false })))
            .toMatchObject({ kind: "completed", device: { status: "running", helper: { status: "provisioned" } }, boot: { skipped: true } });
        expect(preparations).toBe(1);
        expect(f.trace.filter(step => /^(probe|sleep)/.test(step))).toEqual([]);
    });
});

describe("broker macOS canonical stop and finite create effects", () => {
    it.each([true, false])("clears a pending lifecycle only after confirmed stop (ok=%s)", async ok => {
        const original = { ...device(), status: "starting", lifecycle: { runtimeId: "pending-start", operation: "start", claimedAt: timestamp } }, f = fixture(original), held = deferred<BrokerMacosProviderResult>();
        f.ports.execute = () => held.promise;
        const pending = createBrokerMacosVmLifecycle(f.ports).stop(f.input("device_stop"));
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(f.current()).toBe(original);
            expect(f.publications).toEqual([]);
            held.resolve(native(ok));
            const result = await pending;
            expect(result.kind).toBe(ok ? "completed" : "operation-failed");
            if (ok) { expect(f.current()?.status).toBe("stopped"); expect(f.current()).not.toHaveProperty("lifecycle"); }
            else { expect(f.current()).toBe(original); expect(f.publications).toEqual([]); }
        } finally { held.resolve(native(ok)); await pending.catch(() => undefined); }
    });

    it("awaits create execution before claiming a stopped definition", async () => {
        const f = fixture(null), held = deferred<BrokerMacosProviderResult>();
        let settled = false;
        f.ports.execute = effect => { f.trace.push(`execute:${effect.operation}`); return held.promise; };
        const pending = createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image", providerInstance: "owned-unit" } })).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(settled).toBe(false); expect(f.claims).toEqual([]); expect(f.current()).toBeNull();
            held.resolve(native());
            expect(await pending).toMatchObject({ kind: "completed", success: true, device: { status: "stopped", providerInstance: "owned-unit" } });
            expect(f.trace).toEqual(["execute:create", "claim"]);
        } finally { held.resolve(native()); await pending.catch(() => undefined); }
    });

    it("regression: legacy explicit lifecycle ports keep their command cap when optional create facts are absent", async () => {
        const f = fixture(null), observed: number[] = [];
        f.ports.execute = (_effect, options) => { observed.push(options.timeoutMs); return native(); };
        const result = await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image" } }));
        expect(result.kind).toBe("completed");
        expect(observed).toEqual([15000]);
        expect(f.claims).toHaveLength(1);
    });

    it("regression: clone execution receives the provisioning cap and the same decreasing parent allowance", async () => {
        const f = fixture(null);
        let remaining = 630000;
        f.ports.createTimeoutMs = 600000;
        f.ports.remainingMs = () => remaining;
        f.ports.execute = (_effect, options) => {
            expect(options.timeoutMs).toBe(600000);
            expect(options.remainingMs?.()).toBe(630000);
            remaining -= 2500;
            expect(options.remainingMs?.()).toBe(627500);
            return native();
        };
        expect(await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image" } })))
            .toMatchObject({ kind: "completed", success: true });
        expect(f.claims).toHaveLength(1);
    });

    it.each([0, -1])("regression: exhausted clone admission %sms performs no native execution or claim", async remaining => {
        const f = fixture(null);
        f.ports.createTimeoutMs = 600000;
        f.ports.remainingMs = () => remaining;
        const result = await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image" } }));
        expect(result).toMatchObject({ kind: "refused", error: "macos-tart-create-budget-exhausted" });
        expect(f.trace).toEqual([]);
        expect(f.claims).toEqual([]);
        expect(f.current()).toBeNull();
    });

    it("regression: expiration during clone execution cannot publish or start another native effect", async () => {
        const f = fixture(null);
        let remaining = 10000;
        f.ports.createTimeoutMs = 600000;
        f.ports.remainingMs = () => remaining;
        f.ports.execute = effect => { f.trace.push(`execute:${effect.operation}`); remaining = 0; return native(); };
        const result = await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image" } }));
        expect(result.kind).not.toBe("completed");
        expect(f.trace).toEqual(["execute:create"]);
        expect(f.claims).toEqual([]);
        expect(f.current()).toBeNull();
    });

    it("regression: a failed clone preserves its native cleanup refusal without claim, replay or delete", async () => {
        const f = fixture(null);
        const failure = { ...native(false), receipt: { timedOut: true, status: null, cleanup: { ok: false, reason: "process-identity-mismatch" } } };
        f.ports.createTimeoutMs = 600000;
        f.ports.remainingMs = () => 630000;
        f.ports.execute = effect => { f.trace.push(`execute:${effect.operation}`); return failure; };
        const result = await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image" } }));
        expect(result).toMatchObject({ kind: "provider-failed", execution: failure });
        expect(f.trace).toEqual(["execute:create"]);
        expect(f.claims).toEqual([]);
        expect(f.current()).toBeNull();
    });

    it("regression: create compensation observes the remaining parent allowance and preserves cleanup failure", async () => {
        const f = fixture(null), winner = { ...device(), providerInstance: "winner-unit" };
        let remaining = 630000;
        const cleanupFailure = { ...native(false), receipt: { status: null, cleanup: { ok: false, reason: "process-identity-unconfirmed" } } };
        f.ports.createTimeoutMs = 600000;
        f.ports.remainingMs = () => remaining;
        f.ports.claimDefinition = () => { f.trace.push("claim"); remaining = 4000; f.replace(winner); return { ok: false, error: "owner-device-id-conflict", field: "id", value: "unit", existing: winner }; };
        f.ports.execute = (effect, options) => {
            f.trace.push(`execute:${effect.operation}`);
            if (effect.operation !== "compensate-delete") return native();
            expect(options.remainingMs?.()).toBe(4000);
            expect(options.timeoutMs).toBeLessThanOrEqual(4000);
            return cleanupFailure;
        };
        const result = await createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image", providerInstance: "owned-unit" } }));
        expect(result).toMatchObject({ kind: "claim-conflict", error: "owner-device-conflict-rollback-failed", rollback: { attempted: true, ok: false, result: cleanupFailure } });
        expect(f.trace).toEqual(["execute:create", "claim", "prepare-delete", "execute:compensate-delete"]);
        expect(f.current()).toBe(winner);
    });

    it("awaits compensation after a successful create loses its definition claim", async () => {
        const f = fixture(null), removal = deferred<BrokerMacosProviderResult>();
        const winner = { ...device(), providerInstance: "winner-unit" };
        let settled = false;
        f.ports.claimDefinition = () => { f.trace.push("claim"); f.replace(winner); return { ok: false, error: "owner-device-id-conflict", field: "id", value: "unit", existing: winner }; };
        f.ports.execute = effect => { f.trace.push(`execute:${effect.operation}`); return effect.operation === "compensate-delete" ? removal.promise : native(); };
        const pending = createBrokerMacosVmLifecycle(f.ports).create(f.input("device_create", { create: { provider: "tart", image: "base-image", providerInstance: "owned-unit" } })).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn();
            expect(settled).toBe(false); expect(f.current()).toBe(winner);
            expect(f.trace).toEqual(["execute:create", "claim", "prepare-delete", "execute:compensate-delete"]);
            removal.resolve(native());
            expect(await pending).toMatchObject({ kind: "claim-conflict", rollback: { attempted: true, ok: true } });
            expect(f.current()).toBe(winner);
        } finally { removal.resolve(native()); await pending.catch(() => undefined); }
    });

    it.each(["vz", "tart"])("keeps %s metadata definition creation free of native execution", async provider => {
        const f = fixture(null), app = createBrokerMacosVmLifecycle(f.ports);
        const result = await app.create(f.input("device_create", { create: { provider, name: "Metadata only" } }));
        expect(result).toMatchObject({ kind: "completed", device: { provider, status: "stopped" } });
        expect(f.trace).toEqual(["claim"]);
    });

    it("awaits metadata-only deletion before publishing absence", async () => {
        const original = device(); delete original.providerInstance;
        const f = fixture(original), held = deferred<BrokerMacosProviderResult>();
        let settled = false;
        f.ports.executeMetadata = purpose => { f.trace.push(`metadata:${purpose}`); return held.promise; };
        const pending = createBrokerMacosVmLifecycle(f.ports).delete(f.input("device_delete")).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn(); expect(settled).toBe(false); expect(f.current()).toBe(original); expect(f.publications).toEqual([]);
            held.resolve({ ...native(), mode: "noop", provider: "host-broker-state" });
            expect(await pending).toMatchObject({ kind: "completed", success: true, device: null });
            expect(f.trace).toEqual(["auxiliary", "metadata:stopped-definition-delete", "publish:delete"]);
        } finally { held.resolve(native()); await pending.catch(() => undefined); }
    });

    it("awaits committed auxiliary cleanup and uses its complete record for stop CAS", async () => {
        const original = { ...device(), status: "starting", lifecycle: { runtimeId: "pending", operation: "start", claimedAt: timestamp }, recording: { runtimeId: "recorder" } }, f = fixture(original), held = deferred<undefined>();
        const cleaned = { ...original, recording: null, auxiliaryRevision: 2 };
        let settled = false;
        f.ports.cleanupAuxiliary = async (_owner, _parsed, expected) => {
            expect(expected).toBe(original); f.trace.push("auxiliary-held"); await held.promise;
            f.replace(cleaned); return { committed: true, device: cleaned, result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} } };
        };
        const pending = createBrokerMacosVmLifecycle(f.ports).stop(f.input("device_stop")).then(value => { settled = true; return value; });
        void pending.catch(() => undefined);
        try {
            await turn(); expect(settled).toBe(false); expect(f.trace).toEqual(["auxiliary-held"]); expect(f.current()).toBe(original);
            held.resolve(undefined);
            expect(await pending).toMatchObject({ kind: "completed", device: { status: "stopped", recording: null, auxiliaryRevision: 2 }, auxiliary: { changed: true, recording: { cleared: true } } });
            expect(f.publications[0].expected).toEqual(cleaned);
            expect(f.current()).not.toHaveProperty("lifecycle");
        } finally { held.resolve(undefined); await pending.catch(() => undefined); }
    });

    it("blocks stop after awaited auxiliary failure while retaining launch recovery", async () => {
        const original = { ...device(), status: "starting", lifecycle: { runtimeId: "pending", operation: "start", claimedAt: timestamp } }, f = fixture(original);
        f.ports.cleanupAuxiliary = async () => ({ committed: false, device: original, result: { ok: false, changed: false, appium: {}, recording: { reason: "identity-unconfirmed" }, minimizeWatchdog: {} } });
        expect(await createBrokerMacosVmLifecycle(f.ports).stop(f.input("device_stop"))).toMatchObject({ kind: "auxiliary-failed", device: original });
        expect(f.trace).toEqual([]); expect(f.current()).toBe(original);
    });
});
