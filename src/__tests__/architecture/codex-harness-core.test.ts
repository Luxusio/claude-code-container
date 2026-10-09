import { describe, expect, it } from "vitest";
import { createCodexHarness } from "../../application/codex-harness.js";
import type { CodexHarnessPorts } from "../../ports/codex-harness.js";
import type { CodexHarnessObservation } from "../../domain/codex-harness.js";

// Frozen original host control. Keep independent of candidate domain helpers.
function original(ports: CodexHarnessPorts, container: string, profile?: string): void {
    try {
        ports.withConfigLock(() => {
            try {
                ports.prepareConfig(container, profile);
                const result = ports.executeBootstrap(container);
                if (result.stdout?.trim()) ports.publishBootstrapOutput(result.stdout.trim());
                if (result.error || result.status !== 0) {
                    throw new Error(result.error?.message ?? (result.stderr?.trim() || `bootstrap exited ${result.status}`));
                }
            } finally { ports.restoreAccess(container, profile); }
        }, profile);
    } catch (error) {
        ports.publishUnavailable(`[ccc] Harness is unavailable: ${error instanceof Error ? error.message : String(error)}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`);
    }
}

function capture(candidate: boolean, fault: string, profile?: string) {
    const trace: unknown[] = [];
    const sentinel = new Error(fault);
    const fail = (name: string) => { if (fault === name) throw sentinel; };
    let stdoutReads = 0;
    const result = {
        get stdout() { trace.push("stdout"); fail("stdout"); return ++stdoutReads === 1 ? " first " : " second "; },
        get error() { trace.push("error"); fail("error"); return fault === "spawn-error" ? new Error("") : undefined; },
        get status() { trace.push("status"); fail("status"); return fault === "nonzero" || fault === "stderr" ? null : 0; },
        get stderr() { trace.push("stderr"); fail("stderr"); return " detail "; },
    } satisfies CodexHarnessObservation;
    const ports: CodexHarnessPorts = {
        withConfigLock(operation, selected) { trace.push(["lock", selected]); fail("lock"); return operation(); },
        prepareConfig(container, selected) { trace.push(["prepare", container, selected]); if (["select-warning", "warning"].includes(fault)) throw new Error("upstream"); fail("prepare"); },
        executeBootstrap(container) { trace.push(["execute", container]); fail("execute"); return result; },
        restoreAccess(container, selected) { trace.push(["restore", container, selected]); if (fault === "restore-masks") throw new Error("restore"); fail("restore"); },
        get publishBootstrapOutput() {
            trace.push("select-output"); fail("select-output");
            return (message: string): undefined => { trace.push(["output", message]); fail("output"); return undefined; };
        },
        get publishUnavailable() {
            trace.push("select-warning"); fail("select-warning");
            return (message: string): undefined => { trace.push(["warning", message]); fail("warning"); return undefined; };
        },
    };
    if (fault === "restore-masks") Object.defineProperty(ports, "prepareConfig", {value: () => { trace.push("prepare-failed"); throw new Error("prepare"); }});
    let thrown: unknown;
    try { if (candidate) createCodexHarness(ports).ensure("final-id", profile); else original(ports, "final-id", profile); }
    catch (error) { thrown = error; }
    return {trace, thrown: thrown instanceof Error ? thrown.message : thrown};
}

describe("Codex Harness complete synchronous host policy", () => {
    it.each(["ready", "lock", "prepare", "execute", "stdout", "error", "status", "stderr", "nonzero", "spawn-error", "select-output", "output", "restore", "restore-masks", "select-warning", "warning"])("matches original raw order and fault precedence: %s", (fault) => {
        for (const profile of [undefined, "work"]) expect(capture(true, fault, profile)).toEqual(capture(false, fault, profile));
    });
    it("selects the output publisher between the two stdout reads", () => {
        expect(capture(true, "ready").trace).toEqual([["lock", undefined], ["prepare", "final-id", undefined], ["execute", "final-id"], "stdout", "select-output", "stdout", ["output", "second"], "error", "status", ["restore", "final-id", undefined]]);
    });
    it.each(["empty-message", "nullish-message", "second-error-getter", "message-fault", "string-fault", "warning-getter-fault"])("preserves error rereads and raw warning formatting: %s", mode => {
        const run = (candidate: boolean) => {
            const trace: unknown[] = [];
            const fault = new Error("raw getter fault");
            const error = new Error();
            Object.defineProperty(error, "message", {get() { trace.push("message"); if (mode === "message-fault") throw fault; return mode === "empty-message" ? "" : undefined; }});
            let reads = 0;
            const result = {stdout: "", status: 1, get error() { trace.push("error"); if (++reads === 2 && mode === "second-error-getter") throw fault; return error; }, get stderr() { trace.push("stderr"); return " diagnostic "; }} as unknown as CodexHarnessObservation;
            const nonError = {toString() { trace.push("string"); throw fault; }};
            const ports: CodexHarnessPorts = {
                withConfigLock: operation => operation(), prepareConfig() {},
                executeBootstrap() { if (mode === "string-fault") throw nonError; return result; },
                restoreAccess() { trace.push("restore"); },
                publishBootstrapOutput: () => undefined,
                get publishUnavailable() {
                    trace.push("warning-selected");
                    if (mode === "warning-getter-fault") throw fault;
                    return (message: string) => { trace.push(["warning", message]); return undefined; };
                },
            };
            let escaped: unknown;
            try { if (candidate) createCodexHarness(ports).ensure("id"); else original(ports, "id"); }
            catch (caught) { escaped = caught instanceof Error ? caught.message : caught; }
            return {trace, escaped};
        };
        expect(run(true)).toEqual(run(false));
    });
    it("accepts inherited descriptors without evaluating getters at construction", () => {
        const reads: string[] = [];
        const prototype = Object.fromEntries(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"].map(name => [name, () => undefined]));
        Object.defineProperty(prototype, "publishUnavailable", {get() { reads.push("warning"); throw new Error("getter"); }});
        expect(() => createCodexHarness(Object.create(prototype) as CodexHarnessPorts)).not.toThrow();
        expect(reads).toEqual([]);
    });
    it.each(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"])("rejects an absent or noncallable required binding: %s", name => {
        const all = Object.fromEntries(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"].map(key => [key, () => undefined]));
        delete all[name];
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
        all[name] = 1 as unknown as () => undefined;
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
    });
});
