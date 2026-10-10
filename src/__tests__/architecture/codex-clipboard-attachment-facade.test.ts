
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const sourceRoot = resolve("src");
type Api = typeof import("../../codex-clipboard-image.js");
type Options = Parameters<Api["maybeAttachCodexClipboardImage"]>[2];
type Stage = "relative" | "host" | "mkdir" | "write" | "request" | "on" | "end" | "data" | "concat" | "status";

function harness(stage?: Stage) {
    const events: unknown[] = [];
    const failure = { syntheticFailure: stage };
    const modules = new Map<string, unknown>();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const responseListeners = new Map<string, (...args: unknown[]) => void>();
    let responseCallback!: (response: object) => void;
    const fail = (selected: Stage) => { if (selected === stage) throw failure; };
    const method = (label: string, implementation: (...args: unknown[]) => unknown) => {
        const target = {};
        Object.defineProperty(target, label, { get() { events.push(`callee:${label}`); return implementation; } });
        return target;
    };
    const date = method("now", function (this: unknown) { events.push("clock"); return 42; });
    const relative = method("join", function (this: unknown, ...parts) {
        events.push(["relative", ...parts]); fail("relative"); return posix.join(...parts as string[]);
    });
    const path = method("join", function (this: unknown, ...parts) {
        events.push(["host", ...parts]); fail("host"); return join(...parts as string[]);
    });
    Object.assign(path, { posix: relative });
    const fs = method("mkdirSync", function (this: unknown, ...args) { events.push(["mkdir", ...args]); fail("mkdir"); });
    Object.defineProperty(fs, "writeFileSync", { get() {
        events.push("callee:writeFileSync");
        return function (this: unknown, ...args: unknown[]) { events.push(["write", ...args]); fail("write"); };
    } });
    const request = {
        on(event: string, callback: (...args: unknown[]) => void) { events.push(["request.on", event]); fail("on"); listeners.set(event, callback); },
        end() { events.push("request.end"); fail("end"); },
    };
    const http = method("request", function (this: unknown, ...args) {
        events.push(["request", args[0], args[1]]); fail("request");
        responseCallback = args[2] as (response: object) => void;
        return request;
    });
    const bytes = {
        from(chunk: Uint8Array) { events.push("bytes.from"); fail("data"); return Buffer.from(chunk); },
        concat(chunks: readonly Uint8Array[]) { events.push("bytes.concat"); fail("concat"); return Buffer.concat(chunks); },
    };
    const bindings: Record<string, unknown> = { fs, http, path };
    function load(file: string): unknown {
        if (modules.has(file)) return modules.get(file);
        const allowed = file === resolve(sourceRoot, "codex-clipboard-image.ts")
            || file === resolve(sourceRoot, "application/tool-session/codex-clipboard-image.ts")
            || file === resolve(sourceRoot, "domain/tool-session/codex-clipboard-image.ts");
        if (!allowed) throw new Error(`Unplanned fixture module ${file}`);
        const source = readFileSync(file, "utf8");
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exports = {};
        modules.set(file, exports);
        runInNewContext(compiled, {
            exports, Buffer: bytes, Date: date,
            require(specifier: string) {
                if (Object.hasOwn(bindings, specifier)) return bindings[specifier];
                if (specifier.startsWith(".")) return load(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
                throw new Error(`Unplanned fixture dependency ${specifier}`);
            },
            console: { error() { throw new Error("Unplanned fixture output"); } },
        }, { filename: file });
        return exports;
    }
    const api = load(resolve(sourceRoot, "codex-clipboard-image.ts")) as Api;
    function respond(status = 200) {
        const response = {
            get statusCode() { events.push("status"); fail("status"); return status; },
            on(event: string, callback: (...args: unknown[]) => void) { events.push(["response.on", event]); responseListeners.set(event, callback); },
        };
        responseCallback(response);
    }
    return { api, events, failure, respond,
        emit(event: string, ...args: unknown[]) { responseListeners.get(event)!(...args); },
        requestError() { listeners.get("error")!(); },
    };
}

async function exerciseCurrent(operation: (f: ReturnType<typeof harness>) => Promise<unknown> | unknown, stage?: Stage) {
    const current = harness(stage);
    return operation(current);
}

const enabled = { enabled: true, clipboardUrl: "http://synthetic.invalid", clipboardToken: "synthetic-token", timestamp: 42 };
function errorFrom(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected fixture exception");
}

describe("clipboard attachment admission", () => {

    it.each([false, undefined, "", 0])("retains disabled/missing admission short circuit %s", async enabledValue => {
        await exerciseCurrent(async f => {
            const options = { get enabled() { f.events.push("enabled"); return enabledValue; },
                get clipboardUrl() { throw new Error("unused URL getter"); } } as unknown as Options;
            return f.api.maybeAttachCodexClipboardImage("project", ["codex"], options);
        });
    });

    it.each(["clipboardUrl", "clipboardToken"] as const)("does not read or materialize a missing %s", async property => {
        await exerciseCurrent(async f => {
            const options: Options = { ...enabled, [property]: "" };
            Object.defineProperty(options, "timestamp", { get() { throw new Error("unused clock input"); } });
            return f.api.maybeAttachCodexClipboardImage("project", ["codex"], options);
        });
    });
    it.each(["throw", "reject"])("preserves raw custom-reader %s", async mode => {
        await exerciseCurrent(async f => {
            await expect(f.api.maybeAttachCodexClipboardImage("project", ["codex"], { ...enabled,
                readImage: () => { if (mode === "throw") throw f.failure; return Promise.reject(f.failure); },
            })).rejects.toBe(f.failure);
        });
    });
});

describe("native HTTP executor and later callback boundaries", () => {
    it.each(["request", "on", "end"] as const)("rejects synchronous Promise-executor failure at %s", async stage => {
        await exerciseCurrent(async f => { await expect(f.api.readClipboardImagePng("url", "token")).rejects.toBe(f.failure); }, stage);
    });
    it.each([200, 404])("retains chunk/auth/status semantics at HTTP %s", async status => {
        await exerciseCurrent(async f => {
            const pending = f.api.readClipboardImagePng("url", "token");
            f.respond(status);
            f.emit("data", Buffer.from("a")); f.emit("data", Buffer.from("b")); f.emit("end");
            expect(await pending).toEqual(status === 200 ? Buffer.from("ab") : null);
        });
    });
    it.each(["empty", "error"])("retains native null result for %s", async mode => {
        await exerciseCurrent(async f => {
            const pending = f.api.readClipboardImagePng("url", "token");
            if (mode === "error") f.requestError();
            else { f.respond(); f.emit("end"); }
            expect(await pending).toBeNull();
        });
    });
    it.each(["data", "concat", "status"] as const)("lets LATER %s callback failure escape without settling the read", async stage => {
        await exerciseCurrent(async f => {
            let settled = false;
            const pending = f.api.readClipboardImagePng("url", "token");
            pending.then(() => { settled = true; }, () => { settled = true; });
            f.respond();
            if (stage !== "data") f.emit("data", Buffer.from("a"));
            const error = errorFrom(() => stage === "data" ? f.emit("data", Buffer.from("a")) : f.emit("end"));
            expect(error).toBe(f.failure);
            await Promise.resolve();
            expect(settled).toBe(false);
        }, stage);
    });
    it("uses the unchanged default reader only after eligibility and writes its actual Buffer", async () => {
        await exerciseCurrent(async f => {
            const pending = f.api.maybeAttachCodexClipboardImage("project", ["codex"], enabled);
            f.respond(); f.emit("data", Buffer.from("synthetic")); f.emit("end");
            expect(await pending).toEqual({args:["codex", "--image", ".omx/clipboard-images/clipboard-42.png", "Please inspect the attached clipboard image."],relativeImagePath:".omx/clipboard-images/clipboard-42.png"});
            expect(f.events).toContainEqual(["write", join("project", ".omx/clipboard-images/clipboard-42.png"), Buffer.from("synthetic")]);
        });
    });
});
