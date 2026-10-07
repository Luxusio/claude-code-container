import { describe, expect, it } from "vitest";
import { createOrderedCodexConfigPreparation } from "../../application/credentials/codex-config-preparation.js";
import type { CodexPreparationPorts, CodexPreparationObservation } from "../../ports/credentials/codex-config-preparation.js";

const config = "/private/named/config.toml";
const names = ["resolveConfig", "hasHostIdentity", "inspectParent", "inspectConfig", "currentHostUid", "mappedContainerUid", "probeDirectory", "repairDirectory", "verifyDirectory", "probeConfig", "repairConfig", "verifyConfig"] as const;
const complete = ["resolveConfig", "probeDirectory", "hasHostIdentity", "inspectParent", "isDirectory", "uid", "currentHostUid", "inspectConfig", "isFile", "nlink", "mappedContainerUid", "repairDirectory", "verifyDirectory", "probeConfig", "hasHostIdentity", "inspectParent", "isDirectory", "uid", "currentHostUid", "inspectConfig", "isFile", "nlink", "repairConfig", "verifyConfig"];
function caught(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected failure");
}
function fixture(directory = 1, file = 1) {
    const events: string[] = [];
    const argumentsSeen: unknown[][] = [];
    const parent = { get uid() { events.push("uid"); return 42; }, isDirectory() { expect(this).toBe(parent); events.push("isDirectory"); return true; } };
    const metadata = { get nlink() { events.push("nlink"); return 1; }, isFile() { expect(this).toBe(metadata); events.push("isFile"); return true; } };
    const ports: CodexPreparationPorts = {
        resolveConfig: () => config, hasHostIdentity: () => true, inspectParent: () => parent,
        inspectConfig: () => metadata, currentHostUid: () => 42, mappedContainerUid: () => "2001",
        probeDirectory: () => ({ status: directory }), repairDirectory: () => ({ status: 0 }), verifyDirectory: () => ({ status: 0 }),
        probeConfig: () => ({ status: file }), repairConfig: () => ({ status: 0 }), verifyConfig: () => ({ status: 0 }),
    };
    for (const name of names) {
        const implementation = ports[name] as (...args: unknown[]) => unknown;
        Object.defineProperty(ports, name, { configurable: true, value: function(this: unknown, ...args: unknown[]) {
            expect(this).toBe(ports); events.push(name); argumentsSeen.push([name, ...args]); return implementation(...args);
        } });
    }
    return { ports, events, argumentsSeen, parent, metadata, app: createOrderedCodexConfigPreparation(ports) };
}
function replace(ports: CodexPreparationPorts, name: keyof CodexPreparationPorts, value: unknown) {
    Object.defineProperty(ports, name, { configurable: true, value });
}

describe("complete ordered Codex preparation policy", () => {
    it("constructs without observing any capability, including missing and throwing getters", () => {
        const ports = new Proxy({} as CodexPreparationPorts, { get() { throw new Error("eager read"); } });
        expect(createOrderedCodexConfigPreparation(ports).prepare).toBeTypeOf("function");
    });
    it.each([[0, 0], [1, 0], [0, 1], [1, 1]])("orders directory %s then config %s with lazy shared UID and receiver preservation", (directory, file) => {
        const f = fixture(directory, file);
        expect(f.app.prepare("target", "named")).toBeUndefined();
        const expected = directory === 1 && file === 1 ? complete : ["resolveConfig", "probeDirectory",
            ...(directory ? complete.slice(2, 13) : []), "probeConfig",
            ...(file ? [...complete.slice(14, 22), ...(directory ? [] : ["mappedContainerUid"]), "repairConfig", "verifyConfig"] : [])];
        expect(f.events).toEqual(expected);
        expect(f.argumentsSeen[0]).toEqual(["resolveConfig", "named"]);
        for (const args of f.argumentsSeen.filter(([name]) => /^(probe|repair|verify)/.test(String(name)))) {
            expect(args).toEqual([args[0], "target", config, ...(/^repair/.test(String(args[0])) ? ["2001"] : [])]);
        }
    });
    it("defers file-stage capability getters until directory completion and preserves resolution failures outside catches", () => {
        const f = fixture(); const failure = {};
        Object.defineProperty(f.ports, "probeConfig", { configurable: true, get() { throw new Error("early file capability"); } });
        replace(f.ports, "verifyDirectory", () => { throw failure; });
        expect(caught(() => f.app.prepare("target"))).toBe(failure);
        expect(f.events).not.toContain("probeConfig");
        const resolved = fixture(); const raw = { get code() { throw new Error("misclassified resolution"); } };
        replace(resolved.ports, "resolveConfig", () => { throw raw; });
        expect(caught(() => resolved.app.prepare("target"))).toBe(raw);
        expect(resolved.events).toEqual([]);
    });
    it("uses fresh caches for subsequent and nested invocations", () => {
        const f = fixture(); let index = 0; const grants: string[] = []; let nested = false;
        replace(f.ports, "mappedContainerUid", () => String(++index));
        replace(f.ports, "repairDirectory", (_target: string, _config: string, uid: string) => {
            grants.push(uid); if (!nested) { nested = true; f.app.prepare("inner"); } return { status: 0 };
        });
        replace(f.ports, "repairConfig", (_target: string, _config: string, uid: string) => { grants.push(uid); return { status: 0 }; });
        f.app.prepare("outer"); f.app.prepare("later");
        expect(grants).toEqual(["1", "2", "2", "1", "3", "3"]);
    });
    it.each(names)("propagates %s dispatch faults and stops later work", name => {
        const f = fixture(); const failure = { name };
        replace(f.ports, name, () => { f.events.push(name); throw failure; });
        expect(caught(() => f.app.prepare("target"))).toBe(failure);
        expect(f.events.at(-1)).toBe(name);
        expect(f.events).toEqual(complete.slice(0, complete.indexOf(name) + 1));
    });
    it.each(["probeDirectory", "repairDirectory", "verifyDirectory", "probeConfig", "repairConfig", "verifyConfig"] as const)("retains leaf failure classification and stops after %s", name => {
        const observations = [{ status: null }, { status: 124 }, { status: 137 }, { status: 42 }, { status: 1, error: {} }];
        // The retained leaf returns immediately for a zero-status probe before
        // observing error; repair and verification still classify that error.
        if (!name.startsWith("probe")) observations.push({ status: 0, error: { code: "ETIMEDOUT" } });
        for (const observation of observations) {
            const f = fixture(); replace(f.ports, name, () => { f.events.push(name); return observation; });
            expect(() => f.app.prepare("target")).toThrow(/Codex config/);
            expect(f.events.at(-1)).toBe(name);
        }
    });
    it("retains changing raw observation getters and short circuits successful probes", () => {
        const f = fixture(0, 0); const reads: string[] = [];
        const observation: CodexPreparationObservation = { get status() { reads.push("status"); return 0; }, get error() { throw new Error("unobserved"); } };
        replace(f.ports, "probeDirectory", () => observation); replace(f.ports, "probeConfig", () => observation);
        f.app.prepare("target"); expect(reads).toEqual(["status", "status"]);
        let readsCount = 0;
        replace(f.ports, "probeDirectory", () => ({ get status() { return ++readsCount === 1 ? 1 : 124; } }));
        expect(() => f.app.prepare("target")).toThrow("access probe timed out"); expect(readsCount).toBe(2);
    });
    it.each(["identity", "directory", "owner", "file", "links"])("rejects unsafe %s metadata before UID discovery", field => {
        const f = fixture();
        if (field === "identity") replace(f.ports, "hasHostIdentity", () => false);
        if (field === "directory") Object.defineProperty(f.parent, "isDirectory", { value: () => false });
        if (field === "owner") Object.defineProperty(f.parent, "uid", { get: () => 1 });
        if (field === "file") Object.defineProperty(f.metadata, "isFile", { value: () => false });
        if (field === "links") Object.defineProperty(f.metadata, "nlink", { get: () => 2 });
        expect(() => f.app.prepare("target")).toThrow("Unable to prepare Codex credentials");
        expect(f.events).not.toContain("mappedContainerUid"); expect(f.events).not.toContain("probeConfig");
        if (field === "directory") { expect(f.events).not.toContain("uid"); expect(f.events).not.toContain("currentHostUid"); }
        if (field === "file") expect(f.events).not.toContain("nlink");
    });
    it.each(["isDirectory", "uid", "isFile", "nlink"])("preserves metadata %s getter and method faults without later effects", field => {
        const f = fixture(); const failure = { field };
        const object = field === "isDirectory" || field === "uid" ? f.parent : f.metadata;
        Object.defineProperty(object, field, { get() { f.events.push(field); throw failure; } });
        expect(caught(() => f.app.prepare("target"))).toBe(failure);
        expect(f.events.at(-1)).toBe(field);
        expect(f.events).not.toContain("mappedContainerUid");
    });
    it("swallows generated unsafe metadata errors whose inherited direct code equals ENOENT only in directory repair", () => {
        const previous = Object.getOwnPropertyDescriptor(Error.prototype, "code");
        Object.defineProperty(Error.prototype, "code", { configurable: true, value: "ENOENT" });
        try {
            const f = fixture(1, 0); Object.defineProperty(f.metadata, "isFile", { value: () => false });
            f.app.prepare("target"); expect(f.events).toContain("repairDirectory");
            const file = fixture(0, 1); Object.defineProperty(file.metadata, "isFile", { value: () => false });
            expect(() => file.app.prepare("target")).toThrow("single-link config file");
            expect(file.events).not.toContain("repairConfig");
        } finally {
            if (previous) Object.defineProperty(Error.prototype, "code", previous); else Reflect.deleteProperty(Error.prototype, "code");
        }
    });
    it.each(["inspect", "isFile", "nlink"])("directory absence catch covers %s while file catch preserves the original", region => {
        for (const directory of [0, 1]) {
            const f = fixture(directory, 1); const failure = { code: "ENOENT" };
            if (region === "inspect") replace(f.ports, "inspectConfig", () => { throw failure; });
            if (region === "isFile") Object.defineProperty(f.metadata, "isFile", { value: () => { throw failure; } });
            if (region === "nlink") Object.defineProperty(f.metadata, "nlink", { get: () => { throw failure; } });
            expect(caught(() => f.app.prepare("target"))).toBe(failure);
            expect(f.events.includes("repairDirectory")).toBe(directory === 1);
            expect(f.events).not.toContain("repairConfig");
        }
    });
    it.each([null, undefined, false, "raw", 7, Symbol("raw")])("preserves file thrown %s but directly reads directory catch code", failure => {
        for (const directory of [0, 1]) {
            const f = fixture(directory, 1); replace(f.ports, "inspectConfig", () => { throw failure; });
            const result = caught(() => f.app.prepare("target"));
            if (directory && failure == null) expect(result).toBeInstanceOf(TypeError); else expect(result).toBe(failure);
            expect(f.events).not.toContain("mappedContainerUid");
        }
    });
    it("replaces directory thrown values with throwing code getters but never reads file code", () => {
        for (const directory of [0, 1]) {
            let reads = 0; const replacement = {}; const failure = { get code() { reads++; throw replacement; } };
            const f = fixture(directory, 1); replace(f.ports, "inspectConfig", () => { throw failure; });
            expect(caught(() => f.app.prepare("target"))).toBe(directory ? replacement : failure); expect(reads).toBe(directory);
        }
    });
});
