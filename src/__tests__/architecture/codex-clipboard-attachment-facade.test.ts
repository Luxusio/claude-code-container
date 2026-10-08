import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inert c284ead3 source, blob 5ae2f52bf62f5f346abc28313e820aac243fd504.
// This fixture runs only with the fail-closed synthetic bindings below.
const frozenSource = "import { mkdirSync, writeFileSync } from \"fs\";\nimport { request as httpRequest } from \"http\";\nimport { join, posix } from \"path\";\n\nexport const CODEX_CLIPBOARD_IMAGE_PROMPT = \"Please inspect the attached clipboard image.\";\nconst CODEX_CLIPBOARD_SUBCOMMANDS = new Set([\n    \"exec\",\n    \"review\",\n    \"login\",\n    \"logout\",\n    \"mcp\",\n    \"mcp-server\",\n    \"app-server\",\n    \"completion\",\n    \"sandbox\",\n    \"debug\",\n    \"doctor\",\n    \"migrate-rollouts\",\n    \"apply\",\n    \"resume\",\n    \"fork\",\n    \"cloud\",\n    \"features\",\n    \"help\",\n]);\n\nconst OPTIONS_WITH_VALUES = new Set([\n    \"-c\",\n    \"--config\",\n    \"--enable\",\n    \"--disable\",\n    \"-i\",\n    \"--image\",\n    \"-m\",\n    \"--model\",\n    \"-p\",\n    \"--profile\",\n    \"-s\",\n    \"--sandbox\",\n    \"-a\",\n    \"--ask-for-approval\",\n    \"-C\",\n    \"--cd\",\n    \"--add-dir\",\n]);\n\nexport interface ClipboardImageAttachmentResult {\n    args: string[];\n    relativeImagePath?: string;\n}\n\nfunction hasInlineValueOption(arg: string, option: string): boolean {\n    return arg.startsWith(`${option}=`);\n}\n\nexport function buildCodexClipboardImageRelativePath(timestamp: number): string {\n    return posix.join(\".omx\", \"clipboard-images\", `clipboard-${timestamp}.png`);\n}\n\nexport function injectCodexClipboardImageArgs(args: string[], imagePath: string): string[] {\n    if (args.length === 0) {\n        return args;\n    }\n\n    for (let i = 1; i < args.length; i++) {\n        const arg = args[i];\n        if (arg === \"-i\" || arg === \"--image\" || hasInlineValueOption(arg, \"--image\")) {\n            return [...args];\n        }\n    }\n\n    let positionalIndex: number | null = null;\n    for (let i = 1; i < args.length; i++) {\n        const arg = args[i];\n        if (arg === \"--\") {\n            positionalIndex = i + 1 < args.length ? i + 1 : null;\n            break;\n        }\n        if (OPTIONS_WITH_VALUES.has(arg)) {\n            i += 1;\n            continue;\n        }\n        if (\n            hasInlineValueOption(arg, \"--config\")\n            || hasInlineValueOption(arg, \"--image\")\n            || hasInlineValueOption(arg, \"--model\")\n            || hasInlineValueOption(arg, \"--profile\")\n            || hasInlineValueOption(arg, \"--sandbox\")\n            || hasInlineValueOption(arg, \"--ask-for-approval\")\n            || hasInlineValueOption(arg, \"--cd\")\n            || hasInlineValueOption(arg, \"--add-dir\")\n        ) {\n            continue;\n        }\n        if (arg.startsWith(\"-\")) {\n            continue;\n        }\n        positionalIndex = i;\n        break;\n    }\n\n    if (positionalIndex !== null && CODEX_CLIPBOARD_SUBCOMMANDS.has(args[positionalIndex])) {\n        return [...args];\n    }\n\n    if (positionalIndex === null) {\n        return [...args, \"--image\", imagePath, CODEX_CLIPBOARD_IMAGE_PROMPT];\n    }\n\n    return [\n        ...args.slice(0, positionalIndex),\n        \"--image\",\n        imagePath,\n        ...args.slice(positionalIndex),\n    ];\n}\n\nexport async function readClipboardImagePng(\n    clipboardUrl: string,\n    clipboardToken: string,\n): Promise<Buffer | null> {\n    return new Promise((resolve) => {\n        const req = httpRequest(\n            `${clipboardUrl}/clipboard/image/png`,\n            {\n                headers: { Authorization: `Bearer ${clipboardToken}` },\n            },\n            (res) => {\n                const chunks: Buffer[] = [];\n                res.on(\"data\", (chunk) => chunks.push(Buffer.from(chunk)));\n                res.on(\"end\", () => {\n                    if (res.statusCode !== 200) {\n                        resolve(null);\n                        return;\n                    }\n                    const body = Buffer.concat(chunks);\n                    resolve(body.length > 0 ? body : null);\n                });\n            },\n        );\n        req.on(\"error\", () => resolve(null));\n        req.end();\n    });\n}\n\nexport async function maybeAttachCodexClipboardImage(\n    projectPath: string,\n    args: string[],\n    options: {\n        enabled: boolean;\n        clipboardUrl?: string;\n        clipboardToken?: string;\n        timestamp?: number;\n        readImage?: (clipboardUrl: string, clipboardToken: string) => Promise<Buffer | null>;\n    },\n): Promise<ClipboardImageAttachmentResult> {\n    if (!options.enabled || !options.clipboardUrl || !options.clipboardToken) {\n        return { args: [...args] };\n    }\n\n    const relativeImagePath = buildCodexClipboardImageRelativePath(options.timestamp ?? Date.now());\n    const imageArgs = injectCodexClipboardImageArgs(args, relativeImagePath);\n    if (imageArgs.length === args.length && imageArgs.every((arg, index) => arg === args[index])) {\n        return { args: [...args] };\n    }\n    const readImage = options.readImage ?? readClipboardImagePng;\n    const image = await readImage(options.clipboardUrl, options.clipboardToken);\n    if (!image) {\n        return { args: [...args] };\n    }\n\n    const hostImagePath = join(projectPath, relativeImagePath);\n    mkdirSync(join(projectPath, \".omx\", \"clipboard-images\"), { recursive: true });\n    writeFileSync(hostImagePath, image);\n\n    return {\n        args: imageArgs,\n        relativeImagePath,\n    };\n}\n";
const sourceRoot = resolve("src");
type Api = typeof import("../../codex-clipboard-image.js");
type Options = Parameters<Api["maybeAttachCodexClipboardImage"]>[2];
type Stage = "relative" | "host" | "mkdir" | "write" | "request" | "on" | "end" | "data" | "concat" | "status";

function harness(old: boolean, stage?: Stage) {
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
    const date = method("now", function (this: unknown) { expect(this).toBe(date); events.push("clock"); return 42; });
    const relative = method("join", function (this: unknown, ...parts) {
        expect(this).toBe(relative); events.push(["relative", ...parts]); fail("relative"); return posix.join(...parts as string[]);
    });
    const path = method("join", function (this: unknown, ...parts) {
        expect(this).toBeUndefined(); events.push(["host", ...parts]); fail("host"); return join(...parts as string[]);
    });
    Object.assign(path, { posix: relative });
    const fs = method("mkdirSync", function (this: unknown, ...args) { expect(this).toBeUndefined(); events.push(["mkdir", ...args]); fail("mkdir"); });
    Object.defineProperty(fs, "writeFileSync", { get() {
        events.push("callee:writeFileSync");
        return function (this: unknown, ...args: unknown[]) { expect(this).toBeUndefined(); events.push(["write", ...args]); fail("write"); };
    } });
    const request = {
        on(event: string, callback: (...args: unknown[]) => void) { expect(this).toBe(request); events.push(["request.on", event]); fail("on"); listeners.set(event, callback); },
        end() { expect(this).toBe(request); events.push("request.end"); fail("end"); },
    };
    const http = method("request", function (this: unknown, ...args) {
        expect(this).toBeUndefined(); events.push(["request", args[0], args[1]]); fail("request");
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
        const source = old && file === resolve(sourceRoot, "codex-clipboard-image.ts") ? frozenSource : readFileSync(file, "utf8");
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
            on(event: string, callback: (...args: unknown[]) => void) { expect(this).toBe(response); events.push(["response.on", event]); responseListeners.set(event, callback); },
        };
        responseCallback(response);
    }
    return { api, events, failure, respond,
        emit(event: string, ...args: unknown[]) { responseListeners.get(event)!(...args); },
        requestError() { listeners.get("error")!(); },
    };
}

async function compare(operation: (f: ReturnType<typeof harness>) => Promise<unknown> | unknown, stage?: Stage) {
    const old = harness(true, stage);
    const current = harness(false, stage);
    const expected = await operation(old);
    const actual = await operation(current);
    expect(actual).toEqual(expected);
    expect(current.events).toEqual(old.events);
    return { old, current };
}
const enabled = { enabled: true, clipboardUrl: "http://synthetic.invalid", clipboardToken: "synthetic-token", timestamp: 42 };
function errorFrom(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected fixture exception");
}

describe("frozen native facade and actual candidate replay", () => {
    it("pins the independent baseline and unchanged native HTTP reader", () => {
        expect(createHash("sha256").update(frozenSource).digest("hex")).toBe("8190ea9d60da8827efdaac5599c136b6e156b8ba6d19264631f16994552ba3c5");
        const reader = (source: string) => source.slice(source.indexOf("export async function readClipboardImagePng"), source.indexOf("\n}\n", source.indexOf("export async function readClipboardImagePng")) + 3);
        expect(reader(readFileSync(resolve(sourceRoot, "codex-clipboard-image.ts"), "utf8"))).toBe(reader(frozenSource));
    });
    it.each([
        [], ["codex"], ["codex", "--", "prompt"], ["codex", "--"], ["codex", "--unknown", "prompt"],
        ["codex", "--image=old"], ["codex", "-i", "old"], ["codex", "exec", "prompt"],
        ["codex", "--model", "review", "prompt"], ["codex", "--model"], ["codex", "--config=value", "prompt"],
        ["codex", "--enable", "feature", "describe image"], ["codex", "--disable=feature", "describe image"],
    ])("replays exact argv and result identities for %j", async (...values) => {
        await compare(async f => {
            const args = [...values];
            const direct = f.api.injectCodexClipboardImageArgs(args, "synthetic-image");
            const result = await f.api.maybeAttachCodexClipboardImage("project", args, { ...enabled, readImage: async () => Buffer.from("synthetic-image") });
            return { direct, directIsInput: direct === args, result, resultIsInput: result.args === args,
                name: f.api.maybeAttachCodexClipboardImage.name, arity: f.api.maybeAttachCodexClipboardImage.length,
                constructor: f.api.maybeAttachCodexClipboardImage.constructor.name };
        });
    });
    it.each([false, true])("retains getter order, bare reader receiver and pending mutation (image=%s)", async available => {
        await compare(async f => {
            const args = ["codex", "original prompt"];
            let finish!: (value: Buffer | null) => void;
            let urlReads = 0;
            let tokenReads = 0;
            const options: Options = {
                get enabled() { f.events.push("enabled"); return true; },
                get clipboardUrl() { f.events.push("url"); return `url-${++urlReads}`; },
                get clipboardToken() { f.events.push("token"); return `token-${++tokenReads}`; },
                get timestamp() { f.events.push("timestamp"); return undefined; },
                get readImage() { f.events.push("custom-reader"); return function (this: unknown, url: string, token: string) {
                    expect(this).toBeUndefined(); f.events.push(["read", url, token]);
                    return new Promise<Buffer | null>(resolve => { finish = resolve; });
                }; },
            };
            const pending = f.api.maybeAttachCodexClipboardImage("project", args, options);
            const phases: string[] = ["invoked"];
            pending.then(() => phases.push("completed"));
            args[1] = "changed prompt";
            finish(available ? Buffer.alloc(0) : null);
            await Promise.resolve(); phases.push("first-microtask");
            const result = await pending;
            return { result, phases, identity: result.args === args };
        });
    });
    it.each(["enabled", "clipboardUrl", "clipboardToken", "timestamp", "readImage"] as const)("retains throwing %s getter rejection", async property => {
        await compare(async f => {
            const options: Options = { ...enabled, readImage: async () => null };
            Object.defineProperty(options, property, { get() { f.events.push(property); throw f.failure; } });
            const pending = f.api.maybeAttachCodexClipboardImage("project", ["codex"], options);
            expect(pending.constructor.name).toBe("Promise");
            await expect(pending).rejects.toBe(f.failure);
        });
    });
    it.each(["relative", "host", "mkdir", "write"] as const)("retains path/materialization raw failure and exact callees at %s", async stage => {
        await compare(async f => {
            await expect(f.api.maybeAttachCodexClipboardImage("project", ["codex"], { ...enabled, readImage: async () => Buffer.from("image") })).rejects.toBe(f.failure);
        }, stage);
    });
    it("looks up the native relative join before timestamp coercion", async () => {
        await compare(f => {
            const timestamp = { [Symbol.toPrimitive](hint: string) { f.events.push(["coerce", hint]); return "../strange"; } };
            return f.api.buildCodexClipboardImageRelativePath(timestamp as unknown as number);
        });
    });
    it("preserves Symbol template rejection after native relative join lookup", async () => {
        await compare(f => {
            const error = errorFrom(() => f.api.buildCodexClipboardImageRelativePath(Symbol("timestamp") as unknown as number)) as Error;
            return { name: error.name, message: error.message };
        });
    });
    it.each([false, undefined, "", 0])("retains disabled/missing admission short circuit %s", async enabledValue => {
        await compare(async f => {
            const options = { get enabled() { f.events.push("enabled"); return enabledValue; },
                get clipboardUrl() { throw new Error("unused URL getter"); } } as unknown as Options;
            return f.api.maybeAttachCodexClipboardImage("project", ["codex"], options);
        });
    });
    it("replays actual array property reads without snapshotting mutable argv", async () => {
        await compare(async f => {
            const args = new Proxy(["codex", "--model", "model", "prompt"], { get(target, key, receiver) {
                f.events.push(["argv", String(key)]); return Reflect.get(target, key, receiver);
            } });
            return f.api.maybeAttachCodexClipboardImage("project", args, { ...enabled, readImage: async () => null });
        });
    });
    it.each(["clipboardUrl", "clipboardToken"] as const)("does not read or materialize a missing %s", async property => {
        await compare(async f => {
            const options: Options = { ...enabled, [property]: "" };
            Object.defineProperty(options, "timestamp", { get() { throw new Error("unused clock input"); } });
            return f.api.maybeAttachCodexClipboardImage("project", ["codex"], options);
        });
    });
    it.each(["throw", "reject"])("preserves raw custom-reader %s", async mode => {
        await compare(async f => {
            await expect(f.api.maybeAttachCodexClipboardImage("project", ["codex"], { ...enabled,
                readImage: () => { if (mode === "throw") throw f.failure; return Promise.reject(f.failure); },
            })).rejects.toBe(f.failure);
        });
    });
});

describe("native HTTP executor and later callback boundaries", () => {
    it.each(["request", "on", "end"] as const)("rejects synchronous Promise-executor failure at %s", async stage => {
        await compare(async f => { await expect(f.api.readClipboardImagePng("url", "token")).rejects.toBe(f.failure); }, stage);
    });
    it.each([200, 404])("retains chunk/auth/status semantics at HTTP %s", async status => {
        await compare(async f => {
            const pending = f.api.readClipboardImagePng("url", "token");
            f.respond(status);
            f.emit("data", Buffer.from("a")); f.emit("data", Buffer.from("b")); f.emit("end");
            return pending;
        });
    });
    it.each(["empty", "error"])("retains native null result for %s", async mode => {
        await compare(async f => {
            const pending = f.api.readClipboardImagePng("url", "token");
            if (mode === "error") f.requestError();
            else { f.respond(); f.emit("end"); }
            return pending;
        });
    });
    it.each(["data", "concat", "status"] as const)("lets LATER %s callback failure escape without settling the read", async stage => {
        await compare(async f => {
            let settled = false;
            const pending = f.api.readClipboardImagePng("url", "token");
            pending.then(() => { settled = true; }, () => { settled = true; });
            f.respond();
            if (stage !== "data") f.emit("data", Buffer.from("a"));
            const error = errorFrom(() => stage === "data" ? f.emit("data", Buffer.from("a")) : f.emit("end"));
            expect(error).toBe(f.failure);
            await Promise.resolve();
            return { settled };
        }, stage);
    });
    it("uses the unchanged default reader only after eligibility and writes its actual Buffer", async () => {
        await compare(async f => {
            const pending = f.api.maybeAttachCodexClipboardImage("project", ["codex"], enabled);
            f.respond(); f.emit("data", Buffer.from("synthetic")); f.emit("end");
            return pending;
        });
    });
});
