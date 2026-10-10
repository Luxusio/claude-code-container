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
    const parent = { get uid() { events.push("uid"); return 42; }, isDirectory() { events.push("isDirectory"); return true; } };
    const metadata = { get nlink() { events.push("nlink"); return 1; }, isFile() { events.push("isFile"); return true; } };
    const ports: CodexPreparationPorts = {
        resolveConfig: () => config, hasHostIdentity: () => true, inspectParent: () => parent,
        inspectConfig: () => metadata, currentHostUid: () => 42, mappedContainerUid: () => "2001",
        probeDirectory: () => ({ status: directory }), repairDirectory: () => ({ status: 0 }), verifyDirectory: () => ({ status: 0 }),
        probeConfig: () => ({ status: file }), repairConfig: () => ({ status: 0 }), verifyConfig: () => ({ status: 0 }),
    };
    for (const name of names) {
        const implementation = ports[name] as (...args: unknown[]) => unknown;
        Object.defineProperty(ports, name, { configurable: true, value: function(this: unknown, ...args: unknown[]) {
            events.push(name); argumentsSeen.push([name, ...args]); return implementation(...args);
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

});
