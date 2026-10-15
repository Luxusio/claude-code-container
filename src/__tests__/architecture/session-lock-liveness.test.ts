import { describe, expect, it, vi } from "vitest";
import {
    sessionLockOwner,
    type ProcessStartObservation, type SessionLockLiveness,
} from "../../domain/session-lock.js";
import { createSessionLockLiveness } from "../../application/session-lock-liveness.js";
import type { SessionLockLivenessPorts } from "../../ports/session-lock-liveness.js";

const pid = 42;
const token = "opaque:start";
const versioned = (ownerPid = pid, startToken = token) => JSON.stringify({ version: 2, pid: ownerPid, startToken });
const invalidContents = [
    "", " ", "0", "-1", "01", "+1", "1e2", "1.5", "1x", "9007199254740992",
    "{", "null", "[]", "[42]", '"42"', "true", "{}",
    JSON.stringify({ version: 1, pid, startToken: token }),
    JSON.stringify({ pid, startToken: token }),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null].map(value =>
        JSON.stringify({ version: 2, pid: value, startToken: token })),
    ...[undefined, null, 1, "", "x".repeat(257)].map(value =>
        JSON.stringify({ version: 2, pid, startToken: value })),
];

describe("session lock record domain contract", () => {
    it.each([1, Number.MAX_SAFE_INTEGER])("accepts safe positive v2 PID %s", value => {
        expect(sessionLockOwner(versioned(value))).toEqual({ pid: value, startToken: token });
    });
    it.each(["x", "x".repeat(256), " ", "  untrimmed\t", "\n"])("preserves opaque token %j", value => {
        expect(sessionLockOwner(JSON.stringify({ version: 2, pid, startToken: value, extra: "ignored" })))
            .toEqual({ pid, startToken: value });
    });
    it.each(["1", "42", " 42\r\n", String(Number.MAX_SAFE_INTEGER)])("accepts exact trimmed legacy decimal %j", value => {
        expect(sessionLockOwner(value)).toEqual({ pid: Number(value) });
    });
    it.each(invalidContents)("rejects invalid record %j", value => {
        expect(sessionLockOwner(value)).toBeNull();
    });
});

function ports(): SessionLockLivenessPorts {
    return {
        getPlatform: vi.fn(() => "linux"),
        observeProcessStart: vi.fn(() => ({ status: "unknown" } as const)),
        observeLegacyProcess: vi.fn(() => "active" as const),
    };
}

const observations: readonly [ProcessStartObservation, SessionLockLiveness, SessionLockLiveness][] = [
    [{ status: "found", token }, "active", "active"],
    [{ status: "found", token: "different" }, "stale", "active"],
    [{ status: "present" }, "unknown", "active"],
    [{ status: "missing" }, "stale", "stale"],
    [{ status: "unknown" }, "unknown", "unknown"],
];

describe("explicit synchronous session lock liveness", () => {
    it.each([undefined, null])("rejects absent ports %s", value => {
        expect(() => createSessionLockLiveness(value as unknown as SessionLockLivenessPorts)).toThrow(TypeError);
    });
    for (const member of ["getPlatform", "observeProcessStart", "observeLegacyProcess"] as const) {
        it.each([undefined, null, false, 1, "callback", {}])(`rejects noncallable ${member} %j before effects`, value => {
            const callbacks = ports();
            expect(() => createSessionLockLiveness({ ...callbacks, [member]: value } as unknown as SessionLockLivenessPorts)).toThrow(TypeError);
            for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
        });
        it(`rejects missing ${member} before effects`, () => {
            const callbacks = ports();
            const incomplete: Record<string, unknown> = { ...callbacks };
            delete incomplete[member];
            expect(() => createSessionLockLiveness(incomplete as unknown as SessionLockLivenessPorts)).toThrow(TypeError);
            for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
        });
    }
    it("validates construction without invoking callbacks", () => {
        const callbacks = ports();
        expect(createSessionLockLiveness(callbacks)).toBeTypeOf("function");
        for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    });
    it.each(invalidContents)("invalid content %j returns unknown with zero effects", content => {
        const callbacks = ports();
        const observed = new Map<number, ProcessStartObservation>();
        const get = vi.spyOn(observed, "get").mockImplementation(() => { throw new Error("map must remain unread"); });
        expect(createSessionLockLiveness(callbacks)(content, observed)).toBe("unknown");
        expect(get).not.toHaveBeenCalled();
        for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    });

    for (const [observation, v2Result, legacyResult] of observations) {
        for (const cache of ["omitted", "absent", "unknown"] as const) {
            it(`v2 fresh ${observation.status}/${"token" in observation ? observation.token : ""} with ${cache} cache`, () => {
                const callbacks = ports();
                const trace: string[] = [];
                callbacks.getPlatform = () => { throw new Error("v2 must not read platform"); };
                callbacks.observeLegacyProcess = () => { throw new Error("v2 must not observe legacy"); };
                callbacks.observeProcessStart = ownerPid => { trace.push(`observe:${ownerPid}`); return observation; };
                const observed = new Map<number, ProcessStartObservation>(cache === "unknown" ? [[pid, { status: "unknown" }]] : []);
                vi.spyOn(observed, "get").mockImplementation(ownerPid => { trace.push(`map:${ownerPid}`); return cache === "unknown" ? { status: "unknown" } : undefined; });
                expect(createSessionLockLiveness(callbacks)(` \n${versioned()}\t`, cache === "omitted" ? undefined : observed)).toBe(v2Result);
                expect(trace).toEqual(cache === "omitted" ? ["observe:42"] : ["map:42", "observe:42"]);
            });
            it(`Windows legacy fresh ${observation.status}/${"token" in observation ? observation.token : ""} with ${cache} cache`, () => {
                const trace: string[] = [];
                const observed = new Map<number, ProcessStartObservation>();
                vi.spyOn(observed, "get").mockImplementation(ownerPid => { trace.push(`map:${ownerPid}`); return cache === "unknown" ? { status: "unknown" } : undefined; });
                const classify = createSessionLockLiveness({
                    getPlatform: () => { trace.push("platform"); return "win32"; },
                    observeProcessStart: ownerPid => { trace.push(`observe:${ownerPid}`); return observation; },
                    observeLegacyProcess: () => { throw new Error("Windows must not observe POSIX legacy"); },
                });
                expect(classify(" 42\n", cache === "omitted" ? undefined : observed)).toBe(legacyResult);
                expect(trace).toEqual(cache === "omitted" ? ["platform", "observe:42"] : ["platform", "map:42", "observe:42"]);
            });
        }
        if (observation.status !== "unknown") {
            it(`authoritative cached ${observation.status}/${"token" in observation ? observation.token : ""} never observes fresh`, () => {
                for (const legacy of [false, true]) {
                    const trace: string[] = [];
                    const observed = new Map<number, ProcessStartObservation>([[pid, observation]]);
                    vi.spyOn(observed, "get").mockImplementation(ownerPid => { trace.push(`map:${ownerPid}`); return observation; });
                    const classify = createSessionLockLiveness({
                        getPlatform: () => { trace.push("platform"); return "win32"; },
                        observeProcessStart: () => { throw new Error("cached result is authoritative"); },
                        observeLegacyProcess: () => { throw new Error("must not observe POSIX legacy"); },
                    });
                    expect(classify(legacy ? "42" : versioned(), observed)).toBe(legacy ? legacyResult : v2Result);
                    expect(trace).toEqual(legacy ? ["platform", "map:42"] : ["map:42"]);
                }
            });
        }
    }

    for (const platform of ["linux", "darwin", "freebsd", "other"]) {
        it.each(["active", "stale", "unknown"] as const)(`${platform} legacy observation %s ignores conflicting process facts`, expected => {
            const trace: string[] = [];
            const observed = new Map<number, ProcessStartObservation>([[pid, { status: "missing" }]]);
            const get = vi.spyOn(observed, "get").mockImplementation(() => { throw new Error("POSIX map unread"); });
            const classify = createSessionLockLiveness({
                getPlatform: () => { trace.push("platform"); return platform; },
                observeProcessStart: () => { throw new Error("POSIX observation unread"); },
                observeLegacyProcess: ownerPid => { trace.push(`legacy:${ownerPid}`); return expected; },
            });
            expect(classify("42", observed)).toBe(expected);
            expect(trace).toEqual(["platform", "legacy:42"]);
            expect(get).not.toHaveBeenCalled();
        });
    }

    it.each(["map-v2", "map-win32", "observe-v2", "observe-win32", "platform"])("propagates %s exception identity and stops", failing => {
        const exception = { failing };
        const trace: string[] = [];
        const observed = new Map<number, ProcessStartObservation>();
        vi.spyOn(observed, "get").mockImplementation(() => { trace.push("map"); if (failing.startsWith("map")) throw exception; return undefined; });
        const classify = createSessionLockLiveness({
            getPlatform: () => { trace.push("platform"); if (failing === "platform") throw exception; return "win32"; },
            observeProcessStart: () => { trace.push("observe"); throw exception; },
            observeLegacyProcess: () => { throw new Error("legacy observation must remain unread"); },
        });
        let caught: unknown;
        try { classify(failing.endsWith("v2") ? versioned() : "42", observed); } catch (error) { caught = error; }
        expect(caught).toBe(exception);
        expect(trace).toEqual(failing === "platform" ? ["platform"] : [
            ...(failing.endsWith("v2") ? [] : ["platform"]), "map", ...(failing.startsWith("observe") ? ["observe"] : []),
        ]);
    });

    it.each([null, undefined, { code: "ESRCH" }, { code: "EPERM" }, "ESRCH", new Error("semantic observation failed")])("propagates semantic legacy exception identity %j", exception => {
        const callbacks = ports();
        callbacks.observeLegacyProcess = () => { throw exception; };
        const classify = createSessionLockLiveness(callbacks);
        let caught: unknown = Symbol("not thrown");
        try { classify("42", new Map([[pid, { status: "missing" }]])); } catch (error) { caught = error; }
        expect(caught).toBe(exception);
        expect(callbacks.observeProcessStart).not.toHaveBeenCalled();
    });

    it("uses semantic process facts despite conflicting opaque native fields", () => {
        const receipt = Object.freeze({ status: 1, stdout: "MISSING", stderr: "native failure", error: { code: "ESRCH" } });
        const found = { status: "found" as const, token, receipt };
        const missing = { status: "missing" as const, token, receipt: Object.freeze({ status: 0, stdout: `FOUND:${token}`, error: { code: "EPERM" } }) };
        const callbacks = ports();
        callbacks.observeProcessStart = () => found;
        expect(createSessionLockLiveness(callbacks)(versioned())).toBe("active");
        expect(createSessionLockLiveness(callbacks)(versioned(pid, `${token}-successor`))).toBe("stale");
        callbacks.observeProcessStart = () => missing;
        expect(createSessionLockLiveness(callbacks)(versioned())).toBe("stale");
        expect(receipt).toEqual({ status: 1, stdout: "MISSING", stderr: "native failure", error: { code: "ESRCH" } });
    });

});
