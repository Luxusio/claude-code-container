import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { createOwnerDeviceRepository } from "../../../packages/device-lab/providers/application/owner-device-repository.mjs";

type RecordValue = ReturnType<Ports["read"]>[number];
type Ports = Parameters<typeof createOwnerDeviceRepository>[0];
type Fault = "read" | "exists" | "validate" | "publish" | "acquire" | "release";

function throwsSame(operation: () => unknown, error: Error) {
    let caught: unknown;
    try { operation(); } catch (value) { caught = value; }
    expect(caught).toBe(error);
}

function fixture(initial: RecordValue[] = [], existed = true, fault?: Fault) {
    const events: string[] = [];
    const error = new Error(`injected ${fault}`);
    let current = initial;
    let locked = false;
    const effect = (name: string) => {
        events.push(name);
        if (name === fault) throw error;
    };
    const ports: Ports = {
        read() { effect("read"); return current; },
        exists() { expect(locked).toBe(true); effect("exists"); return existed; },
        validate() { expect(locked).toBe(true); effect("validate"); },
        publish(devices) { expect(locked).toBe(true); effect("publish"); current = devices as RecordValue[]; existed = true; },
        withMutationLock<T>(operation: () => T): T {
            expect(locked).toBe(false);
            effect("acquire");
            locked = true;
            try { return operation(); } finally { locked = false; effect("release"); }
        },
        equals(left, right) { effect("equals"); return isDeepStrictEqual(left, right); },
    };
    return { repo: createOwnerDeviceRepository(ports), ports, events, error, current: () => current };
}

describe("owner-device application repository", () => {
    it.each(["read", "exists", "validate", "publish", "withMutationLock", "equals"] as const)("requires %s without ambient defaults or effects", name => {
        const f = fixture();
        const missing: Partial<Ports> = { ...f.ports };
        delete missing[name];
        expect(() => Reflect.apply(createOwnerDeviceRepository, undefined, [missing])).toThrow(TypeError);
        expect(() => Reflect.apply(createOwnerDeviceRepository, undefined, [{ ...f.ports, [name]: 1 }])).toThrow(TypeError);
        expect(f.events).toEqual([]);
    });
    it("requires an explicit ports object", () => {
        for (const value of [undefined, null, {}, []]) {
            expect(() => Reflect.apply(createOwnerDeviceRepository, undefined, [value])).toThrow(TypeError);
        }
    });
    it("reads and finds original objects synchronously without taking the mutation lock", () => {
        const record = { id: "a", metadata: { nested: true } };
        const devices = [record];
        const f = fixture(devices);
        expect(f.repo.read()).toBe(devices);
        expect(f.repo.find("a")).toBe(record);
        expect(f.repo.find("absent")).toBeUndefined();
        expect(f.events).toEqual(["read", "read", "read"]);
    });
    it("locks, guards old state, validates and publishes the original write array", () => {
        const f = fixture();
        const next = [{ id: "a" }];
        expect(f.repo.write(next)).toBe(next);
        expect(f.current()).toBe(next);
        expect(f.events).toEqual(["acquire", "read", "validate", "publish", "release"]);
    });
    it("checks write array inside the lock before reading", () => {
        const f = fixture();
        expect(() => f.repo.write(null)).toThrow(TypeError);
        expect(f.events).toEqual(["acquire", "release"]);
    });
    it.each(["write", "mutate"] as const)("rejects duplicate IDs before port validation in %s", method => {
        const f = fixture();
        const next = [{ id: "same" }, { id: "same" }];
        const operation = () => method === "write" ? f.repo.write(next) : f.repo.mutate(() => next);
        expect(operation).toThrow(expect.objectContaining({ code: "owner-device-id-conflict", deviceId: "same" }));
        expect(f.events).toEqual(method === "write" ? ["acquire", "read", "release"] : ["acquire", "read", "exists", "release"]);
    });
    it.each([true, false])("validates a no-op and publishes only when initially absent (exists=%s)", existed => {
        const f = fixture([], existed);
        const next: RecordValue[] = [];
        expect(f.repo.mutate(() => next)).toBe(next);
        expect(f.events).toEqual(["acquire", "read", "exists", "validate", ...(existed ? [] : ["publish"]), "release"]);
    });
    it("snapshots before an in-place updater and publishes changed input", () => {
        const f = fixture([{ id: "a", count: 0 }]);
        const result = f.repo.mutate(devices => { f.events.push("updater"); devices[0]!.count = 1; return devices; });
        expect(result).toBe(f.current());
        expect(result[0]).toEqual({ id: "a", count: 1 });
        expect(f.events).toEqual(["acquire", "read", "exists", "updater", "validate", "publish", "release"]);
    });
    it("rejects non-array mutation results and propagates updater failures", () => {
        const f = fixture();
        expect(() => f.repo.mutate(() => null)).toThrow(TypeError);
        expect(f.events).toEqual(["acquire", "read", "exists", "release"]);
        f.events.length = 0;
        const error = new Error("updater failed");
        throwsSame(() => f.repo.mutate(() => { throw error; }), error);
        expect(f.events).toEqual(["acquire", "read", "exists", "release"]);
    });
    it.each(["read", "exists", "validate", "publish", "acquire", "release"] as const)("propagates the exact %s fault and attempts release after acquisition", fault => {
        const f = fixture([], true, fault);
        throwsSame(() => f.repo.mutate(() => [{ id: "a" }]), f.error);
        const sequence = ["acquire", "read", "exists", "validate", "publish", "release"];
        const faultIndex = sequence.indexOf(fault);
        expect(f.events).toEqual([...sequence.slice(0, faultIndex + 1), ...(fault !== "acquire" && fault !== "release" ? ["release"] : [])]);
        if (fault !== "release") expect(f.current()).toEqual([]);
    });
    it("refuses to replace corrupt state on write without validation or publication", () => {
        const f = fixture([], true, "read");
        throwsSame(() => f.repo.write([{ id: "replacement" }]), f.error);
        expect(f.events).toEqual(["acquire", "read", "release"]);
    });
    it.each([null, [], false, "device"])("rejects malformed claim %j before locking", device => {
        const f = fixture();
        expect(() => f.repo.claim(device)).toThrow(TypeError);
        expect(f.events).toEqual([]);
    });
    it.each([null, [], [""], [[]], [["valid", null]], [1]])("rejects malformed selector %j before locking", selectors => {
        const f = fixture();
        expect(() => f.repo.claim({ id: "a" }, selectors)).toThrow(TypeError);
        expect(f.events).toEqual([]);
    });
    it("returns ID and ordered compound conflicts without validation or publication", () => {
        const existing = { id: "a", host: "h", serial: 0 };
        const f = fixture([existing]);
        expect(f.repo.claim({ id: "a" })).toEqual({ ok: false, error: "owner-device-id-conflict", field: "id", value: "a", existing });
        expect(f.repo.claim({ id: "b", host: "h", serial: 0 }, [["host", "serial"], "id"])).toEqual({ ok: false, error: "owner-device-identity-conflict", field: "host+serial", value: { host: "h", serial: 0 }, existing });
        expect(f.events).toEqual(["acquire", "read", "release", "acquire", "read", "release"]);
    });
    it("uses strict identity comparisons and skips compound selectors with missing values", () => {
        for (const serial of [null, undefined, "", "0"]) {
            const f = fixture([{ id: "a", host: "h", serial: 0 }]);
            const device = { id: "b", host: "h", serial };
            expect(f.repo.claim(device, [["host", "serial"], "id"])).toEqual({ ok: true, device });
            expect(f.events).toEqual(["acquire", "read", "validate", "publish", "release"]);
        }
    });
    it("updates the selected record and returns null without callback for an absent ID", () => {
        const f = fixture([{ id: "a" }, { id: "b" }]);
        const updated = { id: "a", status: "ready" };
        expect(f.repo.update("a", device => { expect(device).toEqual({ id: "a" }); return updated; })).toBe(updated);
        expect(f.current()).toEqual([updated, { id: "b" }]);
        f.events.length = 0;
        expect(f.repo.update("missing", () => { throw new Error("must not call"); })).toBeNull();
        expect(f.events).toEqual(["acquire", "read", "exists", "validate", "release"]);
    });
    it("preserves a same-ID successor on stale CAS without invoking replacement", () => {
        const successor = { id: "a", runtime: { generation: 2 } };
        const f = fixture([successor]);
        expect(f.repo.transition("a", { id: "a", runtime: { generation: 1 } }, () => { throw new Error("must not call"); })).toEqual({ found: true, matched: false, currentDevice: successor, device: null });
        expect(f.current()[0]).toBe(successor);
        expect(f.events).toEqual(["acquire", "read", "exists", "equals", "validate", "release"]);
    });
    it("uses exact equality including reordered keys, replaces then deletes only null", () => {
        const original = { id: "a", status: "starting" };
        const successor = { id: "a", status: "ready" };
        const f = fixture([original, { id: "other" }]);
        expect(f.repo.transition("a", { status: "starting", id: "a" }, current => { expect(current).toBe(original); return successor; })).toEqual({ found: true, matched: true, currentDevice: original, device: successor });
        expect(f.current()).toEqual([successor, { id: "other" }]);
        expect(f.repo.transition("a", successor, null)).toEqual({ found: true, matched: true, currentDevice: successor, device: null });
        expect(f.current()).toEqual([{ id: "other" }]);
    });
    it("publishes missing empty state through CAS without calling equality or replacement", () => {
        const f = fixture([], false);
        expect(f.repo.transition("absent", {}, () => { throw new Error("must not call"); })).toEqual({ found: false, matched: false, currentDevice: null, device: null });
        expect(f.events).toEqual(["acquire", "read", "exists", "validate", "publish", "release"]);
    });
    it("releases after a replacement exception without publication", () => {
        const original = { id: "a" };
        const f = fixture([original]);
        const error = new Error("replacement failed");
        throwsSame(() => f.repo.transition("a", original, () => { throw error; }), error);
        expect(f.events).toEqual(["acquire", "read", "exists", "equals", "release"]);
        expect(f.current()).toEqual([original]);
    });
});
