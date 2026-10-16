import { describe, expect, it } from "vitest";
import { createOrderedCodexConfigPreparation } from "../../application/credentials/codex-config-preparation.js";
import type { CodexPreparationPorts } from "../../ports/credentials/codex-config-preparation.js";

const config = "/private/named/config.toml";
const names = ["resolveConfig", "hasHostIdentity", "inspectParent", "inspectConfig", "currentHostUid", "mappedContainerUid", "probeDirectory", "repairDirectory", "verifyDirectory", "probeConfig", "repairConfig", "verifyConfig"] as const;
const complete = ["resolveConfig", "probeDirectory", "hasHostIdentity", "inspectParent", "isDirectory", "uid", "currentHostUid", "inspectConfig", "isFile", "nlink", "mappedContainerUid", "repairDirectory", "verifyDirectory", "probeConfig", "hasHostIdentity", "inspectParent", "isDirectory", "uid", "currentHostUid", "inspectConfig", "isFile", "nlink", "repairConfig", "verifyConfig"];
function caught(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected failure");
}
function fixture(directory: "ready" | "repair-required" = "repair-required", file: "ready" | "repair-required" = "repair-required") {
    const events: string[] = [];
    const argumentsSeen: unknown[][] = [];
    const parent = { get uid() { events.push("uid"); return 42; }, isDirectory() { events.push("isDirectory"); return true; } };
    const metadata = { get nlink() { events.push("nlink"); return 1; }, isFile() { events.push("isFile"); return true; } };
    const ports: CodexPreparationPorts = {
        resolveConfig: () => config, hasHostIdentity: () => true, inspectParent: () => parent,
        inspectConfig: () => ({ kind: "present", metadata }), currentHostUid: () => 42, mappedContainerUid: () => "2001",
        probeDirectory: () => ({ kind: directory }), repairDirectory: () => ({ kind: "ready" }), verifyDirectory: () => ({ kind: "ready" }),
        probeConfig: () => ({ kind: file }), repairConfig: () => ({ kind: "ready" }), verifyConfig: () => ({ kind: "ready" }),
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

    it("probes directory before config and skips metadata and UID discovery when both are ready", () => {
        const f = fixture("ready", "ready");
        expect(f.app.prepare("target", "named")).toBeUndefined();
        expect(f.events).toEqual(["resolveConfig", "probeDirectory", "probeConfig"]);
        expect(f.argumentsSeen).toEqual([["resolveConfig", "named"], ["probeDirectory", "target", config], ["probeConfig", "target", config]]);
    });

    it("uses fresh caches for subsequent and nested invocations", () => {
        const f = fixture(); let index = 0; const grants: string[] = []; let nested = false;
        replace(f.ports, "mappedContainerUid", () => String(++index));
        replace(f.ports, "repairDirectory", (_target: string, _config: string, uid: string) => {
            grants.push(uid); if (!nested) { nested = true; f.app.prepare("inner"); } return { kind: "ready" };
        });
        replace(f.ports, "repairConfig", (_target: string, _config: string, uid: string) => { grants.push(uid); return { kind: "ready" }; });
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
    it.each(["probeDirectory", "repairDirectory", "verifyDirectory", "probeConfig", "repairConfig", "verifyConfig"] as const)("retains semantic failures and stops after %s", name => {
        for (const kind of ["timed-out", "failed"] as const) {
            const failure = new Error(`specific ${name} failure`);
            const observation = { kind, failure };
            const f = fixture(); replace(f.ports, name, () => { f.events.push(name); return observation; });
            expect(caught(() => f.app.prepare("target"))).toBe(failure);
            expect(f.events).toEqual(complete.slice(0, complete.indexOf(name) + 1));
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

    it("refuses unsafe present metadata even when generated errors inherit ENOENT", () => {
        const previous = Object.getOwnPropertyDescriptor(Error.prototype, "code");
        Object.defineProperty(Error.prototype, "code", { configurable: true, value: "ENOENT" });
        try {
            for (const f of [fixture("repair-required", "ready"), fixture("ready", "repair-required")]) {
                Object.defineProperty(f.metadata, "isFile", { value: () => false });
                expect(() => f.app.prepare("target")).toThrow("single-link config file");
                expect(f.events).not.toContain("mappedContainerUid");
                expect(f.events).not.toContain("repairDirectory");
                expect(f.events).not.toContain("repairConfig");
            }
        } finally {
            if (previous) Object.defineProperty(Error.prototype, "code", previous); else Reflect.deleteProperty(Error.prototype, "code");
        }
    });
    it.each(["inspect", "isFile", "nlink"])("propagates present metadata %s faults without UID discovery or repair", region => {
        for (const directory of ["ready", "repair-required"] as const) {
            const f = fixture(directory); const failure = { code: "ENOENT" };
            if (region === "inspect") replace(f.ports, "inspectConfig", () => { throw failure; });
            if (region === "isFile") Object.defineProperty(f.metadata, "isFile", { value: () => { throw failure; } });
            if (region === "nlink") Object.defineProperty(f.metadata, "nlink", { get: () => { throw failure; } });
            expect(caught(() => f.app.prepare("target"))).toBe(failure);
            expect(f.events).not.toContain("mappedContainerUid");
            expect(f.events).not.toContain("repairDirectory");
            expect(f.events).not.toContain("repairConfig");
        }
    });

    it("allows semantic missing config only for directory repair and preserves the original file failure", () => {
        for (const failure of [new Error("missing config"), { absent: true }, null, undefined]) {
            const directory = fixture("repair-required", "ready");
            replace(directory.ports, "inspectConfig", () => ({ kind: "missing", failure }));
            expect(directory.app.prepare("target")).toBeUndefined();
            expect(directory.events).toContain("repairDirectory");
            expect(directory.events).not.toContain("repairConfig");
            const file = fixture("ready", "repair-required");
            replace(file.ports, "inspectConfig", () => ({ kind: "missing", failure }));
            expect(caught(() => file.app.prepare("target"))).toBe(failure);
            expect(file.events).not.toContain("mappedContainerUid");
            expect(file.events).not.toContain("repairConfig");
        }
    });

});
