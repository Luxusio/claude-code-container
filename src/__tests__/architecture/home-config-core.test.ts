import { afterEach, describe, expect, it, vi } from "vitest";
import { createCccConfig } from "../../application/home/config.js";
import type { CccConfigPorts } from "../../ports/home/config.js";
function fixture(text?: string) {
    const trace: unknown[][] = []; let pid = 11;
    const ports: CccConfigPorts = {
        resolveConfigPath() { trace.push(["path"]); return "/private/config.json"; },
        resolveHomePath() { trace.push(["home"]); return "/fresh/home"; },
        createDirectory(path, options) { trace.push(["mkdir", path, options]); return undefined; },
        fileExists(path) { trace.push(["exists", path]); return text !== undefined; },
        readText(path) { trace.push(["read", path]); return text!; },
        processId() { trace.push(["pid"]); return pid; },
        writeText(path, data, options) { trace.push(["write", path, data, options]); return undefined; },
        replaceFile(temp, path) { trace.push(["rename", temp, path]); return undefined; },
    };
    return { ports, trace, config: createCccConfig(ports), pid(value: number) { pid = value; } };
}
afterEach(() => vi.restoreAllMocks());
describe("complete config read and update policy", () => {
    it("constructs without touching ports and returns fresh empty records for absent files", () => {
        const f = fixture(); expect(f.trace).toEqual([]); expect(f.config.read()).toEqual({}); expect(f.config.read()).not.toBe(f.config.read());
        expect(f.trace).toEqual(Array.from({ length: 3 }, () => [["path"], ["exists", "/private/config.json"]]).flat());
    });
    it.each(["broken", "null", "[]", "true", "2", '"text"'])("read catches parse/schema %s while update refuses overwrite", text => {
        const f = fixture(text); expect(f.config.read()).toEqual({}); f.trace.length = 0; const mutate = vi.fn();
        expect(() => f.config.update(mutate)).toThrow("/private/config.json is not a valid JSON object; fix or remove it"); expect(mutate).not.toHaveBeenCalled();
        expect(f.trace).toEqual([["path"], ["home"], ["mkdir", "/fresh/home", { recursive: true, mode: 0o700 }], ["exists", "/private/config.json"], ["read", "/private/config.json"]]);
    });
    it("read returns the exact parser object and update mutates that same object once", () => {
        const parsed = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { own: 1 });
        vi.spyOn(JSON, "parse").mockReturnValue(parsed); const f = fixture("synthetic"); expect(f.config.read()).toBe(parsed); const mutate = vi.fn(config => { expect(config).toBe(parsed); config.own = 2; });
        expect(f.config.update(mutate)).toBeUndefined(); expect(mutate).toHaveBeenCalledTimes(1); expect(parsed.own).toBe(2);
    });
    it("publishes callback changes through a private temporary file", () => {
        const f = fixture(); expect(f.config.update(config => { f.trace.push(["mutate"]); config.value = 1; f.pid(22); return { ignored: true }; })).toBeUndefined();
        expect(f.trace).toContainEqual(["mkdir", "/fresh/home", { recursive: true, mode: 0o700 }]);
        expect(f.trace).toContainEqual(["write", "/private/config.json.22.tmp", '{\n  "value": 1\n}', { mode: 0o600 }]);
        expect(f.trace).toContainEqual(["rename", "/private/config.json.22.tmp", "/private/config.json"]);
    });
    it("ignores async callback result without waiting", async () => {
        const f = fixture(); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
        expect(f.config.update(async config => { config.before = true; await pending; config.after = true; })).toBeUndefined();
        expect(f.trace.find(([name]) => name === "write")?.[2]).toBe('{\n  "before": true\n}'); release(); await pending;
    });
    it.each(["resolveConfigPath", "fileExists"] as const)("read %s errors escape by identity", key => {
        const f = fixture("{}"); const error = { key }; Object.defineProperty(f.ports, key, { value() { throw error; } });
        let caught: unknown; try { f.config.read(); } catch (value) { caught = value; } expect(caught).toBe(error);
    });
    it("read catches native read faults, while update reports invalid file", () => {
        const f = fixture("{}"); Object.defineProperty(f.ports, "readText", { value() { throw { fault: true }; } }); expect(f.config.read()).toEqual({});
        expect(() => f.config.update(() => {})).toThrow("/private/config.json is not a valid JSON object; fix or remove it");
    });
    it.each(["resolveConfigPath", "resolveHomePath", "createDirectory", "fileExists", "processId", "writeText", "replaceFile"] as const)("update %s propagates identity without rescue", key => {
        const f = fixture(), error = { key }; Object.defineProperty(f.ports, key, { value() { f.trace.push(["failure", key]); throw error; } });
        let caught: unknown; try { f.config.update(() => {}); } catch (value) { caught = value; } expect(caught).toBe(error); expect(f.trace.at(-1)).toEqual(["failure", key]);
    });
    it("callback failure escapes before PID and write", () => { const f = fixture(), error = {}; let caught: unknown; try { f.config.update(() => { throw error; }); } catch (value) { caught = value; } expect(caught).toBe(error); expect(f.trace.some(([name]) => name === "pid")).toBe(false); });

    it.each(["cycle", "bigint", "toJSON"])("serialization %s failure stops writes after PID", kind => {
        const f = fixture(), error = { kind }; let caught: unknown;
        try { f.config.update(config => { if (kind === "cycle") config.self = config; else if (kind === "bigint") config.big = 1n; else config.toJSON = () => { throw error; }; }); } catch (value) { caught = value; }
        if (kind === "toJSON") expect(caught).toBe(error); else expect(caught).toBeInstanceOf(TypeError);
        expect(f.trace.at(-1)).toEqual(["pid"]); expect(f.trace.some(([name]) => name === "write" || name === "rename")).toBe(false);
    });
    it("uses fresh paths and PID on nested and subsequent updates", () => {
        const f = fixture(); let call = 0; Object.defineProperty(f.ports, "resolveConfigPath", { value() { return `/private/${++call}.json`; } });
        f.config.update(config => { config.outer = true; f.pid(42); f.config.update(inner => { inner.inner = true; }); f.pid(43); });
        expect(f.trace.filter(([name]) => name === "rename")).toEqual([["rename", "/private/2.json.42.tmp", "/private/2.json"], ["rename", "/private/1.json.43.tmp", "/private/1.json"]]);
    });


});
