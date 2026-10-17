import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerSupervisionPorts } from "../../device-lab-mcp/src/ports/broker-supervision.mjs";

const captured = vi.hoisted(() => ({ ports: undefined as BrokerSupervisionPorts | undefined }));
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
import "../../device-lab-mcp/src/broker.mjs";

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
