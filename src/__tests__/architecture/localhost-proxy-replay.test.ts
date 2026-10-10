import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Evaluate the actual complete facade and its inward dependencies; replace only
// native effects. No copied routing or setup business body is used as the oracle.
function load(tree: string, entry: string, effects: Record<string, unknown>, globals: Record<string, unknown>) {
    const cache = new Map<string, Record<string, any>>();
    function evaluate(file: string): Record<string, any> {
        if (cache.has(file)) return cache.get(file)!;
        const exports: Record<string, any> = {}; cache.set(file, exports);
        const source = readFileSync(file, "utf8");
        const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        runInNewContext(compiled, { exports, ...globals, require: (name: string) => {
            if (Object.hasOwn(effects, name)) return effects[name];
            if (!name.startsWith(".")) throw new Error(`Unfenced effect: ${name}`);
            return evaluate(resolve(dirname(file), name.replace(/\.js$/, ".ts")));
        } }, { filename: file });
        return exports;
    }
    return evaluate(resolve(tree, entry));
}

it("native connect schedules exactly 3000ms, rejects raw errors, and retains late-event behavior", async () => {
    for (const tree of [root]) {
        const events: unknown[] = []; const callbacks = new Map<string, (...args: any[]) => void>();
        let now = 0; let due = 0; let timeout!: () => void; const raw = {};
        const socket = { on(event: string, fn: (...args: any[]) => void) { events.push(["on", event]); callbacks.set(event, fn); return this; }, destroy() { events.push("destroy"); return this; } };
        const api = load(tree, "src/localhost-proxy.ts", { net: { createConnection(options: unknown) { events.push(["create", options]); return socket; } } }, {
            Promise, Error, setTimeout(fn: () => void, ms: number) { due = now + ms; timeout = fn; events.push(["timer", ms]); return 1; },
            clearTimeout(id: number) { events.push(["clear", id]); due = Infinity; },
        });
        const pending = api.tryConnect("owned", 41);
        const rejected = expect(pending).rejects.toThrow("Connection timeout to owned:41");
        expect(events).toEqual([["create", {host:"owned",port:41}], ["timer",3000], ["on","connect"], ["on","error"]]);
        now = 2999; expect(now < due).toBe(true); expect(events).not.toContain("destroy");
        now = 3000; if (now >= due) timeout(); await rejected;
        callbacks.get("connect")!(); callbacks.get("error")!(raw);
        expect(events.slice(-4)).toEqual(["destroy",["clear",1],["clear",1],"destroy"]);
        events.length = 0; const second = api.tryConnect("owned",42); const rawRejected = expect(second).rejects.toBe(raw);
        callbacks.get("error")!(raw); await rawRejected; expect(events.slice(-2)).toEqual([["clear",1],"destroy"]);
    }
});
