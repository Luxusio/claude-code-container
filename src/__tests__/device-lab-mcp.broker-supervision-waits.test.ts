import { performance } from "node:perf_hooks";
import * as childProcess from "child_process";
import { EventEmitter } from "node:events";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerSupervisionPorts } from "../../device-lab-mcp/src/ports/broker-supervision.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";

const captured = vi.hoisted(() => ({ ports: undefined as BrokerSupervisionPorts | undefined }));
vi.mock("child_process", async importOriginal => ({
    ...await importOriginal<typeof import("child_process")>(),
}));
vi.mock("fs", async importOriginal => ({
    ...await importOriginal<typeof import("fs")>(),
}));
vi.mock("os", async importOriginal => ({
    ...await importOriginal<typeof import("os")>(),
}));
vi.mock("../../device-lab-mcp/src/application/broker-supervision.mjs", async importOriginal => {
    const actual = await importOriginal<typeof import("../../device-lab-mcp/src/application/broker-supervision.mjs")>();
    return {
        ...actual,
        createBrokerSupervision(ports: BrokerSupervisionPorts) {
            captured.ports = ports;
            return actual.createBrokerSupervision(ports);
        },
    };
});
import { brokerRpc, verifyAuthenticatedBrokerGenerationForTest, withBrokerOperation } from "../../device-lab-mcp/src/broker.mjs";

const host = "127.0.0.1";
const port = 17373;
const ownerId = "1111111111111111";
const syntheticPid = 2_147_483_001;
const healthy = { ok: true, name: "ccc-device-broker" };
const resolved = { ok: true, result: { ownerId } };

function native() {
    if (!captured.ports) throw new Error("native broker supervision ports were not composed");
    return captured.ports;
}

function clockFixture() {
    const clock = {
        elapsed: 0,
        wall: 1_800_000_000_000,
        scheduled: [] as number[],
        fired: [] as number[],
        advance(milliseconds: number) {
            this.elapsed += milliseconds;
            this.wall += milliseconds;
        },
    };
    vi.spyOn(performance, "now").mockImplementation(() => clock.elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
    const fakeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
        clock.scheduled.push(delay);
        return fakeSetTimeout(() => {
            clock.fired.push(delay);
            clock.advance(delay);
            callback(...args);
        }, delay);
    }) as typeof setTimeout);
    return clock;
}

function response(body: object, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function finish<T>(pending: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return pending;
}

function pidProbe(observe: () => boolean) {
    return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect([pid, signal]).toEqual([syntheticPid, 0]);
        if (!observe()) throw Object.assign(new Error("synthetic process absent"), { code: "ESRCH" });
        return true;
    });
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
    if (vi.isMockFunction(process.kill)) {
        for (const call of vi.mocked(process.kill).mock.calls) expect(call).toEqual([syntheticPid, 0]);
    }
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("native broker health phase", () => {
    it("keeps the 250 ms probe cap, 50 ms interval and timely readiness envelope", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(response({ ok: false }, 503))
            .mockResolvedValueOnce(response(healthy));
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 700 }));
        expect(result).toEqual({
            requested: true,
            available: true,
            selected: expect.objectContaining({ host, port, status: 200, ok: true, body: healthy }),
            attempts: [expect.objectContaining({ status: 503 }), expect.objectContaining({ status: 200 })],
        });
        expect(clock.scheduled).toEqual([250, 50, 250]);
        expect(clock.fired).toEqual([50]);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([`http://${host}:${port}/health`, `http://${host}:${port}/health`]);
    });

    it.each([-100_000, 100_000])("ignores a wall clock jump of %d ms", async jump => {
        const clock = clockFixture();
        let calls = 0;
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(10);
            clock.wall += jump;
            return response(++calls === 1 ? { ok: false } : healthy);
        });
        vi.stubGlobal("fetch", fetch);
        expect((await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 100 }))).available).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(clock.elapsed).toBe(70);
        expect(clock.scheduled).toEqual([100, 50, 40]);
    });

    it("charges observation time before clipping the last sleep and makes no expired probe", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(35);
            return response({ ok: false }, 503);
        });
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 60 }));
        expect(result).toEqual({ requested: true, available: false, selected: null, attempts: [expect.objectContaining({ status: 503 })] });
        expect(clock.scheduled).toEqual([60, 25]);
        expect(clock.fired).toEqual([25]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(clock.elapsed).toBe(60);
    });

    it.each([40, 41])("retains a positive health fact completed after %d ms without publishing readiness", async cost => {
        const clock = clockFixture();
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(cost);
            return response(healthy);
        }));
        const result = await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 40 }));
        expect(result).toEqual({ requested: true, available: false, selected: null, attempts: [expect.objectContaining({ ok: true, body: healthy })] });
        expect(clock.fired).toEqual([]);
    });

    it("includes response-body consumption in readiness acceptance", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(new ReadableStream({
            pull(controller) {
                clock.advance(30);
                controller.enqueue(new TextEncoder().encode(JSON.stringify(healthy)));
                controller.close();
            },
        }, { highWaterMark: 0 })));
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 30 }));
        expect(result.available).toBe(false);
        expect(result.attempts).toEqual([expect.objectContaining({ ok: true, body: healthy })]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(clock.fired).toEqual([]);
    });

    it("does not start a health request when its allowance is already exhausted", async () => {
        clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>();
        vi.stubGlobal("fetch", fetch);
        expect(await finish(native().waitForBrokerHealth({ host, port, timeoutMs: 0 })))
            .toEqual({ requested: true, available: false, selected: null, attempts: [] });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("native broker owner-resolution phase", () => {
    it("retains the 1000 ms request cap, 100 ms interval and successful owner envelope", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockRejectedValueOnce(new Error("connection refused"))
            .mockResolvedValueOnce(response(resolved));
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerOwnerResolve(host, port, 1600));
        expect(result).toEqual({
            ok: true, ownerId,
            selected: expect.objectContaining({ host, port, status: 200, body: resolved }),
            attempts: [expect.objectContaining({ status: null, error: "connection refused" }), expect.objectContaining({ status: 200 })],
        });
        expect(clock.scheduled).toEqual([1000, 100, 1000]);
        expect(clock.fired).toEqual([100]);
        expect(fetch.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
            [`http://${host}:${port}/v1/owner/resolve`, "POST"],
            [`http://${host}:${port}/v1/owner/resolve`, "POST"],
        ]);
    });

    it.each([0, -20])("preserves the existing one millisecond normalization of %d", async allowance => {
        const clock = clockFixture();
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(resolved)));
        expect((await finish(native().waitForBrokerOwnerResolve(host, port, allowance))).ok).toBe(true);
        expect(clock.scheduled).toEqual([1]);
        expect(clock.fired).toEqual([]);
    });

    it.each([-100_000, 100_000])("ignores a wall clock jump of %d ms", async jump => {
        const clock = clockFixture();
        let calls = 0;
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(10);
            clock.wall += jump;
            return ++calls === 1 ? response({ error: "warming" }, 503) : response(resolved);
        });
        vi.stubGlobal("fetch", fetch);
        expect((await finish(native().waitForBrokerOwnerResolve(host, port, 150))).ok).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(clock.elapsed).toBe(120);
        expect(clock.scheduled).toEqual([150, 100, 40]);
    });

    it("charges an unsuccessful observation before clipping its final sleep", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(110);
            return response({ error: "owner-not-ready" }, 503);
        });
        vi.stubGlobal("fetch", fetch);
        expect(await finish(native().waitForBrokerOwnerResolve(host, port, 150))).toEqual({
            ok: false, error: "owner-not-ready",
            selected: expect.objectContaining({ status: 503 }),
            attempts: [expect.objectContaining({ status: 503 })],
        });
        expect(clock.scheduled).toEqual([150, 40]);
        expect(clock.fired).toEqual([40]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([40, 41])("retains a resolved owner observed after %d ms without publishing owner success", async cost => {
        const clock = clockFixture();
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            clock.advance(cost);
            return response(resolved);
        }));
        const result = await finish(native().waitForBrokerOwnerResolve(host, port, 40));
        expect(result).toEqual({
            ok: false, error: "broker-owner-resolve-readiness-timeout",
            selected: expect.objectContaining({ status: 200, body: resolved }),
            attempts: [expect.objectContaining({ status: 200, body: resolved })],
        });
        expect(result).not.toHaveProperty("ownerId");
        expect(clock.fired).toEqual([]);
    });

    it("keeps eight recent attempts and an earlier genuine HTTP diagnosis after transport failures", async () => {
        clockFixture();
        let calls = 0;
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
            calls += 1;
            if (calls === 1) return response({ error: "owner-denied" }, 409);
            throw new Error(`transport-${calls}`);
        });
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerOwnerResolve(host, port, 1050));
        expect(result.ok).toBe(false);
        expect(result.error).toBe("owner-denied");
        expect(result.selected).toEqual(expect.objectContaining({ status: 409, body: { error: "owner-denied" } }));
        expect(result.attempts).toEqual(Array.from({ length: 8 }, (_, index) => expect.objectContaining({ status: null, error: `transport-${index + 4}` })));
        expect(fetch).toHaveBeenCalledTimes(11);
    });

    it("preserves a genuine HTTP error while selecting the latest completed response", async () => {
        const clock = clockFixture();
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(response({ error: "owner-denied" }, 403))
            .mockImplementationOnce(async () => {
                clock.advance(80);
                return response({ error: "owner-still-unresolved" });
            });
        vi.stubGlobal("fetch", fetch);
        const result = await finish(native().waitForBrokerOwnerResolve(host, port, 170));
        expect(result.error).toBe("owner-denied");
        expect(result.selected).toEqual(expect.objectContaining({ status: 200, body: { error: "owner-still-unresolved" } }));
        expect(result.attempts).toHaveLength(2);
        expect(clock.fired).toEqual([100]);
    });
});

describe("native broker process-exit phase", () => {
    it("keeps the 1500 ms default and 50 ms interval without a final expired PID probe", async () => {
        const clock = clockFixture();
        const kill = pidProbe(() => true);
        const wait = native().waitForProcessExit as (pid: number, timeoutMs?: number) => Promise<boolean>;
        expect(await finish(wait(syntheticPid))).toBe(false);
        expect(kill).toHaveBeenCalledTimes(30);
        expect(clock.fired).toEqual(Array(30).fill(50));
        expect(clock.elapsed).toBe(1500);
    });

    it.each([-100_000, 100_000])("confirms timely exit despite a wall clock jump of %d ms", async jump => {
        const clock = clockFixture();
        let calls = 0;
        const kill = pidProbe(() => {
            clock.advance(5);
            clock.wall += jump;
            return ++calls === 1;
        });
        expect(await finish(native().waitForProcessExit(syntheticPid, 80))).toBe(true);
        expect(kill).toHaveBeenCalledTimes(2);
        expect(clock.elapsed).toBe(60);
        expect(clock.fired).toEqual([50]);
    });

    it("charges PID observation cost before clipping the last sleep", async () => {
        const clock = clockFixture();
        const kill = pidProbe(() => { clock.advance(20); return true; });
        expect(await finish(native().waitForProcessExit(syntheticPid, 125))).toBe(false);
        expect(kill).toHaveBeenCalledTimes(2);
        expect(clock.fired).toEqual([50, 35]);
        expect(clock.elapsed).toBe(125);
    });

    it.each([20, 21])("does not confirm absence observed after %d ms", async cost => {
        const clock = clockFixture();
        const kill = pidProbe(() => { clock.advance(cost); return false; });
        expect(await finish(native().waitForProcessExit(syntheticPid, 20))).toBe(false);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(clock.fired).toEqual([]);
    });

    it("confirms an absence observed before expiry", async () => {
        const clock = clockFixture();
        const kill = pidProbe(() => { clock.advance(19); return false; });
        expect(await finish(native().waitForProcessExit(syntheticPid, 20))).toBe(true);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(clock.fired).toEqual([]);
    });

    it("does not perform a PID observation with no allowance", async () => {
        clockFixture();
        const kill = pidProbe(() => false);
        expect(await finish(native().waitForProcessExit(syntheticPid, 0))).toBe(false);
        expect(kill).not.toHaveBeenCalled();
    });
});

describe("Darwin broker resolver allowance", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const runtime = {
        ownerId, managedBy: "device-lab-mcp", pid: syntheticPid, host, port,
        command: "/owned/node", args: ["/private/owned/dist/packages/device-lab/dist/broker-entry.js"],
        startedAt: "2026-10-27T00:00:00.000Z", processStartToken: "ps:Tue Oct 27 00:00:00 2026",
    };
    const status = {
        name: "ccc-device-broker", mode: "host-broker-daemon", port,
        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
        startedAt: runtime.startedAt, process: { pid: syntheticPid, startToken: runtime.processStartToken },
    };
    type Stage = "listener" | "command" | "start-token";

    beforeEach(() => {
        Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER", "0");
    });
    afterEach(() => {
        Object.defineProperty(process, "platform", platform);
        vi.unstubAllEnvs();
    });

    function resolverFixture(costs: number[], completion?: (stage: Stage) => Partial<childProcess.SpawnSyncReturns<string>>) {
        const clock = clockFixture();
        const observations: Array<{ stage: Stage; timeout: number | undefined }> = [];
        const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation(((executable: string, args: readonly string[], options: { timeout?: number }) => {
            const stage: Stage = executable === "/usr/sbin/lsof" ? "listener" : args.includes("command=") ? "command" : "start-token";
            const index = observations.length;
            observations.push({ stage, timeout: options.timeout });
            clock.advance(costs[index] ?? 0);
            const stdout = stage === "listener" ? `p${syntheticPid}\nf12\n`
                : stage === "command" ? `${runtime.command} ${runtime.args[0]} devices broker serve --port ${port}\n`
                : "Tue Oct 27 00:00:00 2026\n";
            return { pid: syntheticPid, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null, ...completion?.(stage) };
        }) as typeof childProcess.spawnSync);
        const verify = () => native().reusableBrokerProcessVerification(runtime, port, host, { statusBroker: status });
        return { clock, observations, spawn, verify };
    }

    it.each([-100_000, 100_000])("accepts a listener taking more than one second despite a %d ms wall-clock jump", jump => {
        const f = resolverFixture([1200, 100, 100], () => { f.clock.wall += jump; return {}; });
        expect(f.verify()).toEqual(expect.objectContaining({ ok: true, verified: expect.objectContaining({
            pid: syntheticPid, processStartToken: runtime.processStartToken,
        }) }));
        expect(f.observations).toEqual([
            { stage: "listener", timeout: 5000 }, { stage: "command", timeout: 1000 }, { stage: "start-token", timeout: 1000 },
        ]);
        expect(f.clock.elapsed).toBe(1400);
    });

    it("charges the listener and first ps against one captured resolver allowance", () => {
        const f = resolverFixture([4200, 500, 200]);
        expect(f.verify().ok).toBe(true);
        expect(f.observations).toEqual([
            { stage: "listener", timeout: 5000 }, { stage: "command", timeout: 800 }, { stage: "start-token", timeout: 300 },
        ]);
        expect(f.clock.elapsed).toBe(4900);
    });

    it.each([4999.5, 5000, 5001])("does not dispatch ps after listener observation consumes %d ms", cost => {
        const f = resolverFixture([cost]);
        expect(f.verify()).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
            stage: "command", reason: "budget-exhausted",
        } });
        expect(f.observations).toEqual([{ stage: "listener", timeout: 5000 }]);
    });

    it.each([1000, 1001])("refuses a final positive start-token observation completing in %d ms at the allowance boundary", finalCost => {
        const f = resolverFixture([3500, 500, finalCost]);
        expect(f.verify()).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
            stage: "start-token", reason: "budget-exhausted",
        } });
        expect(f.observations).toEqual([
            { stage: "listener", timeout: 5000 }, { stage: "command", timeout: 1000 }, { stage: "start-token", timeout: 1000 },
        ]);
    });

    it("retains a genuine timed-out native failure when it also exhausts the allowance", () => {
        const secret = "private-native-output-and-command";
        const f = resolverFixture([5001], () => ({
            status: null, signal: "SIGTERM", stdout: secret, stderr: secret,
            error: Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
        }));
        const verification = f.verify();
        expect(verification).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
            stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", code: "ETIMEDOUT",
        } });
        expect(f.spawn).toHaveBeenCalledOnce();
        expect(JSON.stringify(verification)).not.toContain(secret);
    });

    it.each([0, 0.75])("does not dispatch a listener with an active Tart remainder of %d ms", async remaining => {
        const f = resolverFixture([]);
        const verification = await withBrokerOperation(async () => {
            const operation = native().currentOperation() as { macosCreateRemainingMs?: () => number };
            operation.macosCreateRemainingMs = () => remaining;
            return f.verify();
        });
        expect(verification).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
            stage: "listener", reason: "budget-exhausted",
        } });
        expect(f.spawn).not.toHaveBeenCalled();
    });

    it("clips every native cap to the active Tart caller's decreasing remainder", async () => {
        const f = resolverFixture([1000, 300, 100]);
        const verification = await withBrokerOperation(async () => {
            const operation = native().currentOperation() as { macosCreateRemainingMs?: () => number };
            operation.macosCreateRemainingMs = () => 1500 - f.clock.elapsed;
            return f.verify();
        });
        expect(verification.ok).toBe(true);
        expect(f.observations).toEqual([
            { stage: "listener", timeout: 1500 }, { stage: "command", timeout: 500 }, { stage: "start-token", timeout: 200 },
        ]);
    });

    it("keeps the parent allowance captured at admission when a later callback reports more time", async () => {
        let remaining = 1500;
        const f = resolverFixture([1000, 500], () => { remaining = 100_000; return {}; });
        const verification = await withBrokerOperation(async () => {
            const operation = native().currentOperation() as { macosCreateRemainingMs?: () => number };
            operation.macosCreateRemainingMs = () => remaining;
            return f.verify();
        });
        expect(verification).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
            stage: "start-token", reason: "budget-exhausted",
        } });
        expect(f.observations).toEqual([{ stage: "listener", timeout: 1500 }, { stage: "command", timeout: 500 }]);
    });

    it("keeps authenticated generation's injected verifier at exactly three arguments", async () => {
        clockFixture();
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ok: true, broker: status })));
        const verifier = vi.fn(() => ({ pid: syntheticPid }));
        const observation = vi.fn();
        expect(await verifyAuthenticatedBrokerGenerationForTest(host, port, { runtime }, {}, {
            containerBoundary: false, processVerifier: verifier,
        }, observation)).toEqual(runtime);
        expect(verifier.mock.calls).toEqual([[runtime, port, status]]);
        expect(observation).not.toHaveBeenCalled();
    });

    it.each([
        { label: "missing status identity", broker: { ...status, process: {} }, admittedRuntime: runtime, reason: "status-identity-unverified" },
        { label: "runtime generation changed", broker: status, admittedRuntime: { ...runtime, processStartToken: "ps:successor-private-token" }, reason: "runtime-continuity-unverified" },
        { label: "missing runtime", broker: status, admittedRuntime: null, reason: "invalid-runtime" },
    ])("retains selected per-call refusal facts for $label without dispatching a native probe", async ({ broker, admittedRuntime, reason }) => {
        const root = fs.mkdtempSync(join(os.tmpdir(), "ccc-broker-generation-refusal-"));
        const f = resolverFixture([]);
        vi.spyOn(os, "homedir").mockReturnValue(root);
        vi.stubEnv("CCC_DEVICE_BROKER_PORT", "");
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ok: true, broker })));
        const observation = vi.fn();
        try {
            expect(await verifyAuthenticatedBrokerGenerationForTest(host, port, { runtime: admittedRuntime }, {}, {
                containerBoundary: false,
            }, observation)).toBeNull();
            expect(observation.mock.calls).toEqual([[{ stage: "identity", reason }]]);
            expect(f.spawn).not.toHaveBeenCalled();
            const saved = JSON.stringify(observation.mock.calls);
            expect(saved).not.toContain(runtime.args[0]);
            expect(saved).not.toContain(runtime.processStartToken);
            expect(saved).not.toContain("successor-private-token");
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it("carries a fresh authenticated native refusal into RPC attempts instead of losing it after setup", async () => {
        const root = fs.mkdtempSync(join(os.tmpdir(), "ccc-broker-auth-observation-"));
        const authFile = join(root, "owner.json");
        const nativeSecret = "private-native-stderr";
        const secret = "b".repeat(64);
        const f = resolverFixture([1500], () => ({
            status: null, signal: "SIGTERM", stdout: "", stderr: nativeSecret,
            error: Object.assign(new Error(nativeSecret), { code: "ETIMEDOUT" }),
        }));
        vi.spyOn(os, "homedir").mockReturnValue(root);
        vi.stubEnv("CCC_DEVICE_BROKER_AUTH_FILE", authFile);
        vi.stubEnv("CCC_DEVICE_BROKER_PORT", "");
        fs.writeFileSync(authFile, JSON.stringify({ ownerId, secret, version: 1 }), { mode: 0o600 });
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
            if (String(url).endsWith("/v1/owner/resolve")) return response(resolved);
            if (String(url).endsWith("/status")) return response({ ok: true, broker: status });
            throw new Error("RPC dispatch is forbidden after native identity refusal");
        });
        vi.stubGlobal("fetch", fetch);
        try {
            expect(native().writeBrokerRuntime(runtime, null)).toBe(true);
            // Publishing the private fixture observes the mutation-lock owner first.
            // Measure the subsequent authenticated generation probe independently.
            f.spawn.mockClear();
            f.observations.length = 0;
            f.clock.elapsed = 0;
            f.clock.wall = 1_800_000_000_000;
            const result = await brokerRpc({ method: "broker.echo", params: { value: 1 }, hostCandidates: [host], port, autolaunch: false });
            expect(result).toMatchObject({ ok: false, error: "broker-runtime-process-unverified", attempts: [
                expect.objectContaining({ processVerification: {
                    ok: false, source: "unverified-broker-port-process", observation: {
                        stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", code: "ETIMEDOUT",
                    },
                } }),
            ] });
            expect(f.spawn).toHaveBeenCalledOnce();
            expect(f.spawn).toHaveBeenCalledWith("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
                expect.objectContaining({ timeout: 5000 }));
            expect(f.observations).toEqual([{ stage: "listener", timeout: 5000 }]);
            expect(f.clock.elapsed).toBe(1500);
            expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
                `http://${host}:${port}/v1/owner/resolve`, `http://${host}:${port}/status`,
            ]);
            const attempts = JSON.stringify(result.attempts);
            for (const sensitive of [secret, nativeSecret, runtime.args[0], runtime.processStartToken, root]) {
                expect(attempts).not.toContain(sensitive);
            }
            expect(JSON.parse(fs.readFileSync(join(root, ".ccc", "devices", "broker", "runtime.json"), "utf8"))).toEqual(runtime);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});

describe("native owned broker launch", () => {
    function child(pid: number | undefined = syntheticPid) {
        const identity: { pid: number | undefined } = { pid };
        return Object.assign(new EventEmitter(), identity, { kill: vi.fn(() => true) });
    }

    async function fixture(options: { token?: boolean; realChild?: boolean } = {}) {
        vi.resetModules();
        const root = fs.mkdtempSync(join(os.tmpdir(), "ccc-broker-native-launch-"));
        const listeners = {
            exit: new Set(process.listeners("exit")),
            SIGINT: new Set(process.listeners("SIGINT")),
            SIGTERM: new Set(process.listeners("SIGTERM")),
        };
        vi.spyOn(os, "homedir").mockReturnValue(root);
        await import("../../device-lab-mcp/src/broker.mjs");
        const ports = native();
        const first = child();
        const actualSpawn = childProcess.spawn;
        const spawn = vi.spyOn(childProcess, "spawn");
        if (!options.realChild) {
            spawn.mockReturnValue(first as unknown as childProcess.ChildProcess);
            const read = fs.readFileSync;
            vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
                if (String(args[0]) === `/proc/${syntheticPid}/stat`) {
                    if (options.token === false) throw Object.assign(new Error("process identity unavailable"), { code: "ENOENT" });
                    return `${syntheticPid} (owned fake) ${Array.from({ length: 20 }, (_, index) => index === 19 ? "424242" : "0").join(" ")}`;
                }
                return read(...args);
            }) as typeof fs.readFileSync);
            vi.spyOn(childProcess, "spawnSync").mockImplementation((() => ({
                pid: syntheticPid, output: [], stdout: options.token === false ? "" : "native-start",
                stderr: "", status: options.token === false ? 1 : 0, signal: null,
            })) as unknown as typeof childProcess.spawnSync);
        }
        const actualClose = fs.closeSync;
        const releasedDescriptors = new Set<number>();
        const close = vi.spyOn(fs, "closeSync").mockImplementation(fd => {
            actualClose(fd);
            releasedDescriptors.add(fd);
        });
        const launch = ports.normalizeLaunchOptions({ host, port, launchTimeoutMs: 1000 });
        function descriptor() {
            const spawnOptions = spawn.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
            const value = spawnOptions?.stdio?.[1];
            if (typeof value !== "number") throw new Error("owned launch did not acquire an output descriptor");
            return value;
        }
        function dispose() {
            ports.deleteOwnedChild(syntheticPid);
            for (const listener of process.listeners("exit")) {
                if (!listeners.exit.has(listener)) process.removeListener("exit", listener);
            }
            for (const signal of ["SIGINT", "SIGTERM"] as const) {
                for (const listener of process.listeners(signal)) {
                    if (!listeners[signal].has(listener)) process.removeListener(signal, listener);
                }
            }
            for (const call of spawn.mock.calls) {
                const fd = (call[2] as { stdio?: unknown[] } | undefined)?.stdio?.[1];
                if (typeof fd === "number" && !releasedDescriptors.has(fd)) {
                    try { actualClose(fd); } catch { /* already closed by the launch */ }
                }
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
        return { root, ports, first, spawn, actualSpawn, close, launch, descriptor, dispose };
    }

    it("refuses an absent executable before log creation or process dispatch", async () => {
        const f = await fixture();
        try {
            const launch = { ...f.launch, command: join(f.root, "missing-node") };
            const result = await f.ports.launchOwnedBroker(ownerId, launch);
            expect(result).toEqual(expect.objectContaining({
                kind: "failed", runtime: null, detail: "executable-not-found",
                diagnostics: expect.objectContaining({ command: launch.command, args: launch.args }),
            }));
            expect(f.spawn).not.toHaveBeenCalled();
            expect(fs.existsSync(join(f.root, ".ccc", "devices", "broker", "logs"))).toBe(false);
        } finally { f.dispose(); }
    });

    it("does not dispatch a child when the private log directory cannot be created", async () => {
        const f = await fixture();
        try {
            fs.mkdirSync(join(f.root, ".ccc"));
            fs.writeFileSync(join(f.root, ".ccc", "devices"), "ordinary file");
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({ kind: "failed", runtime: null, detail: expect.stringMatching(/^broker-log-/) }));
            expect(f.spawn).not.toHaveBeenCalled();
            expect([...f.ports.ownedChildrenEntries()]).toEqual([]);
        } finally { f.dispose(); }
    });

    it("closes its acquired log when spawn throws without inventing a process identity", async () => {
        const f = await fixture();
        try {
            f.spawn.mockImplementation(() => { throw new Error("dispatch refused"); });
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({
                kind: "failed", runtime: null, detail: "dispatch refused",
                diagnostics: expect.objectContaining({ command: f.launch.command, args: f.launch.args }),
            }));
            expect(f.close).toHaveBeenCalledWith(f.descriptor());
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
            expect([...f.ports.ownedChildrenEntries()]).toEqual([]);
        } finally { f.dispose(); }
    });

    it("retains the provisional runtime and owned child before listener setup can fail", async () => {
        const f = await fixture();
        try {
            vi.spyOn(f.first, "once").mockImplementation(() => {
                expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first })]]);
                throw new Error("listener installation failed");
            });
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({
                kind: "failed", detail: "listener installation failed",
                runtime: expect.objectContaining({ ownerId, pid: syntheticPid, processStartToken: null,
                    command: f.launch.command, args: f.launch.args, host, port, managedBy: "device-lab-mcp" }),
            }));
            if (result.kind !== "failed" || !result.runtime) throw new Error("partial dispatch identity was lost");
            expect(result.runtime.logPath).toBe(result.diagnostics.logPath);
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first, processStartToken: null })]]);
            expect(f.first.kill).not.toHaveBeenCalled();
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
        } finally { f.dispose(); }
    });

    it("retains the dispatched generation when token-poll scheduling fails and refuses to signal it without a token", async () => {
        const f = await fixture({ token: false });
        try {
            vi.spyOn(globalThis, "setTimeout").mockImplementation(() => { throw new Error("token timer failed"); });
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({
                kind: "failed", detail: "token timer failed", runtime: expect.objectContaining({ pid: syntheticPid, processStartToken: null }),
            }));
            if (result.kind !== "failed" || !result.runtime) throw new Error("token failure lost its child");
            const kill = vi.spyOn(process, "kill").mockReturnValue(true);
            expect(await f.ports.cleanupLaunchedBrokerRuntime(result.runtime, 1500)).toEqual({
                ok: false, pid: syntheticPid, reason: "process-start-token-unavailable",
            });
            expect(kill).toHaveBeenCalledExactlyOnceWith(syntheticPid, 0);
            expect(f.first.kill).not.toHaveBeenCalled();
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first })]]);
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
        } finally { f.dispose(); }
    });

    it("preserves the observed generation if registering process cleanup fails after spawn", async () => {
        const f = await fixture();
        try {
            const token = f.ports.readBrokerProcessStartToken(syntheticPid);
            expect(token).toBeTruthy();
            vi.spyOn(process, "once").mockImplementation(() => { throw new Error("cleanup registration failed"); });
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({
                kind: "failed", detail: "cleanup registration failed", runtime: expect.objectContaining({ pid: syntheticPid, processStartToken: token }),
            }));
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first, processStartToken: token })]]);
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
        } finally { f.dispose(); }
    });

    it("keeps a missing token bounded without treating a nonthrowing spawn as readiness", async () => {
        const f = await fixture({ token: false });
        try {
            const timer = vi.spyOn(globalThis, "setTimeout");
            const result = await finish(f.ports.launchOwnedBroker(ownerId, f.launch));
            expect(result).toEqual(expect.objectContaining({ kind: "started", runtime: expect.objectContaining({ pid: syntheticPid, processStartToken: null }) }));
            expect(timer.mock.calls.map(call => call[1])).toEqual(Array(20).fill(25));
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first, processStartToken: null })]]);
        } finally { f.dispose(); }
    });

    it("keeps the existing no-PID/asynchronous-error path as a started attempt and closes the parent descriptor", async () => {
        const f = await fixture();
        try {
            f.first.pid = undefined;
            const result = await f.ports.launchOwnedBroker(ownerId, f.launch);
            expect(result).toEqual(expect.objectContaining({ kind: "started", runtime: expect.objectContaining({ pid: null, processStartToken: null }) }));
            expect(() => f.first.emit("error", new Error("asynchronous spawn rejection"))).not.toThrow();
            expect([...f.ports.ownedChildrenEntries()]).toEqual([]);
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
        } finally { f.dispose(); }
    });

    it("does not restore an exited child's ownership after its pending token poll settles", async () => {
        const f = await fixture({ token: false });
        try {
            const pending = f.ports.launchOwnedBroker(ownerId, f.launch);
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: f.first })]]);
            f.first.emit("exit", 1);
            expect((await finish(pending)).kind).toBe("started");
            expect([...f.ports.ownedChildrenEntries()]).toEqual([]);
        } finally { f.dispose(); }
    });

    it.each(["exit", "error"] as const)("does not erase a successor when a former child later emits %s", async event => {
        const f = await fixture();
        try {
            const second = child();
            f.spawn.mockReturnValueOnce(f.first as unknown as childProcess.ChildProcess).mockReturnValueOnce(second as unknown as childProcess.ChildProcess);
            expect((await f.ports.launchOwnedBroker(ownerId, f.launch)).kind).toBe("started");
            expect((await f.ports.launchOwnedBroker(ownerId, f.launch)).kind).toBe("started");
            f.first.emit(event, event === "error" ? new Error("old child failed") : 0);
            expect([...f.ports.ownedChildrenEntries()]).toEqual([[syntheticPid, expect.objectContaining({ child: second })]]);
            second.emit(event, event === "error" ? new Error("current child failed") : 0);
            expect([...f.ports.ownedChildrenEntries()]).toEqual([]);
        } finally { f.dispose(); }
    });

    it("does not turn a successful dispatch into failure when closing the parent descriptor fails", async () => {
        const f = await fixture();
        try {
            f.close.mockImplementationOnce(() => { throw new Error("parent close failed"); });
            expect(await f.ports.launchOwnedBroker(ownerId, f.launch)).toEqual(expect.objectContaining({ kind: "started", runtime: expect.objectContaining({ pid: syntheticPid }) }));
            expect(f.first.kill).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it("allows the actual owned child to write after the parent has released its output descriptor", { timeout: 20000 }, async () => {
        vi.useRealTimers();
        const f = await fixture({ realChild: true });
        let owned: childProcess.ChildProcess | undefined;
        let closed: Promise<void> | undefined;
        try {
            f.spawn.mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
                owned = f.actualSpawn(...args);
                closed = new Promise<void>((resolve, reject) => {
                    owned!.once("close", () => resolve());
                    owned!.once("error", reject);
                });
                return owned;
            });
            const marker = join(f.root, "parent-descriptor-closed");
            const program = `const fs = require('node:fs'); const marker = process.argv[1]; const poll = setInterval(() => { if (!fs.existsSync(marker)) return; clearInterval(poll); process.stdout.write('child-output-after-parent-close\\n'); }, 10);`;
            const launch = { ...f.launch, args: ["-e", program, marker] };
            const result = await f.ports.launchOwnedBroker(ownerId, launch);
            expect(result.kind).toBe("started");
            expect(f.spawn).toHaveBeenCalledWith(launch.command, launch.args, expect.objectContaining({
                detached: false, windowsHide: true, stdio: ["ignore", f.descriptor(), f.descriptor()],
            }));
            expect(() => fs.fstatSync(f.descriptor())).toThrow(expect.objectContaining({ code: "EBADF" }));
            fs.writeFileSync(marker, "the parent has closed its descriptor");
            await closed;
            expect(fs.readFileSync(result.diagnostics.logPath, "utf8")).toContain("child-output-after-parent-close");
        } finally {
            if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
            if (closed) await closed.catch(() => undefined);
            if (owned?.pid) f.ports.deleteOwnedChild(owned.pid);
            f.dispose();
        }
    });
});
