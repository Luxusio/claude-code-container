import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Bounded actual original index binding, frozen before implementation.
// This route-only witness does not represent the full main prelude or shipping.
const originalCleanBinding = "switch (\"clean\") {\n        case \"clean\": {\n            const cleanFlags = filteredArgs.slice(1);\n            const { cleanContainers } = await import(\"./clean.js\");\n            await cleanContainers({\n                volumes: cleanFlags.includes(\"--volumes\"),\n                all: cleanFlags.includes(\"--all\"),\n                dryRun: cleanFlags.includes(\"--dry-run\"),\n                yes: cleanFlags.includes(\"--yes\") || cleanFlags.includes(\"-y\"),\n            });\n            break;\n        }\n}\n";
const originalBindingSha256 = "d736f97458bcbc8a9d8c35e0247e020c0a810d0769bbde7ce556ad47bccd0ec7";
function route(source: string) {
    const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
    let clause: ts.CaseClause | undefined;
    function visit(node: ts.Node) {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === "clean") {
            if (clause) throw new Error("Ambiguous actual clean route"); clause = node;
        }
        ts.forEachChild(node, visit);
    }
    visit(tree); if (!clause) throw new Error("Missing actual index clean binding");
    const actual = clause.getText(tree);
    const imports = [...actual.matchAll(/await import\(["']\.\/clean\.js["']\)/g)];
    expect(imports).toHaveLength(1);
    // Only module loading is substituted. The actual route body, option order,
    // includes/OR tests and both awaits execute; clean itself is never mocked.
    const body = actual.replace(imports[0][0], "await imports.clean()");
    return `async function route(filteredArgs) { switch(filteredArgs[0]) { ${body} default: throw new Error('Unexpected route'); } } route;`;
}
function fixture(index: string, moduleRoot: string, sourceFacade?: string) {
    const trace: unknown[] = []; const exit = { nativeExit: 0 }; const fault = { raw: "prompt failure" }; let denied = 0; let answer: string | Promise<string> = "yes";
    const deny = (name: string): never => { denied++; throw new Error(`Denied ${name}`); };
    const unknown = (name: string) => new Proxy({}, { get: (_target, key) => deny(`${name}.${String(key)}`) });
    const consoleObject = { log: (text: string) => { trace.push(["log", text]); } };
    const processObject = new Proxy({}, { get: (_target, key) => key === "exit" ? (code: number) => { trace.push(["exit", code]); throw exit; } : deny(`process.${String(key)}`) });
    const imports: Record<string, unknown> = {
        "child_process": { spawnSync: (_cli: string, args: string[], options: unknown) => {
            trace.push(["native", args, options]);
            let stdout = "";
            if (args[0] === "ps") stdout = "111111111111\tccc-running\tUp\n222222222222\tccc-stopped\tExited";
            if (args[0] === "images") stdout = "ccc\timage-id\t1MB";
            if (args[0] === "volume" && args[1] === "ls") stdout = "ccc-volume";
            return { status: 0, stdout };
        } },
        "./docker.js": { ensureDockerRunning: () => { trace.push("ready"); } },
        "./container-runtime.js": { runtimeCli: () => { trace.push("runtime"); return "fixture-runtime"; } },
        "./utils.js": { DOCKER_REGISTRY_IMAGE: "registry/ccc", prompt: (question: string, lowercase: boolean) => { trace.push(["prompt", question, lowercase]); return Promise.resolve(answer); } },
        "./session.js": { getSessionLockClaimsForContainer: (prefix: string) => { trace.push(["claims", prefix]); return []; }, withContainerLifecycleLock: (prefix: string, operation: () => unknown) => { trace.push(["guard", prefix]); expect(operation()).toBeUndefined(); } },
    };
    const globals = { console: new Proxy(consoleObject, { get: (target, key) => key === "log" ? Reflect.get(target, key) : deny(`console.${String(key)}`) }), process: processObject, Buffer: unknown("Buffer"), fetch: () => deny("fetch"), setTimeout: () => deny("timer"), setInterval: () => deny("timer"), setImmediate: () => deny("timer") };
    const cache = new Map<string, Record<string, unknown>>();
    const emitted = !moduleRoot.endsWith("/src");
    function load(path: string): Record<string, unknown> {
        if (cache.has(path)) return cache.get(path)!;
        const exports = {}; cache.set(path, exports);
        const text = sourceFacade && path === resolve(moduleRoot, "clean.js") ? sourceFacade : readFileSync(path, "utf8");
        const requireModule = (specifier: string) => {
            if (imports[specifier.replace(/^node:/, "")]) return imports[specifier.replace(/^node:/, "")];
            const target = resolve(dirname(path), emitted ? specifier : specifier.replace(/\.js$/, ".ts"));
            if (!["application/clean", "domain/clean", "ports/clean"].some(name => target === resolve(moduleRoot, `${name}.${emitted ? "js" : "ts"}`))) return deny(`import ${specifier}`);
            return load(target);
        };
        const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        runInNewContext(code, { ...globals, exports, require: requireModule }, { filename: path, timeout: 1000 }); return exports;
    }
    const invoke = runInNewContext(route(index), { ...globals, imports: { clean: async () => { trace.push("import:clean"); return load(resolve(moduleRoot, "clean.js")); } } }, { timeout: 1000 }) as (args: string[]) => Promise<void>;
    async function run(flags: string[], response: string | Promise<string> = "yes") {
        answer = response; let error: unknown;
        try { await invoke(["clean", ...flags]); trace.push("route:returned"); } catch (caught) { error = caught; }
        finally { expect(denied, "zero denied effects after each positive or thrown route case").toBe(0); }
        return { trace, error };
    }
    return { run, trace, exit, fault };
}
const sourceIndex = () => readFileSync(resolve(root, "src/index.ts"), "utf8");
describe("actual index clean binding — route-only evidence, full real facade", () => {
    it("authenticates the embedded original binding", () => { expect(createHash("sha256").update(originalCleanBinding).digest("hex")).toBe(originalBindingSha256); });
    it("retains the exact frozen clean binding", () => { expect(route(sourceIndex())).toBe(route(originalCleanBinding)); });
    it.each(Array.from({ length: 16 }, (_, mask) => mask))("executes all four existing option combinations %i", async mask => {
        const flags = [mask & 1 ? "--volumes" : "", mask & 2 ? "--all" : "", mask & 4 ? "--dry-run" : "", mask & 8 ? "--yes" : ""].filter(Boolean);
        const f = fixture(sourceIndex(), resolve(root, "src"), readFileSync(resolve(root, "src/clean.ts"), "utf8"));
        const result = await f.run(flags);
        const native = result.trace.filter((event): event is unknown[] => Array.isArray(event) && event[0] === "native").map(event => event[1] as string[]);
        expect(native.some(args => args[0] === "volume" && args[1] === "ls")).toBe(!!(mask & 3));
        expect(result.trace.some(event => Array.isArray(event) && event[0] === "prompt")).toBe(!(mask & 4) && !(mask & 8));
        if (mask & 4) { expect(result.error).toBeUndefined(); expect(native.filter(args => ["stop", "rm", "rmi"].includes(args[0]))).toEqual([]); }
        else {
            expect(result.error).toBe(f.exit);
            expect(native).toContainEqual(["rm", "222222222222"]);
            expect(native.some(args => args[0] === "stop" && args[1] === "111111111111")).toBe(!!(mask & 2));
            expect(native.some(args => args[0] === "rm" && args[1] === "111111111111")).toBe(!!(mask & 2));
        }
    });
    it.each([["-y"], ["--yes"], ["--yes", "-y"]].map(flags => ({ flags })))("uses native confirmation alias OR for $flags", async ({ flags }) => {
        const f = fixture(sourceIndex(), resolve(root, "src"), readFileSync(resolve(root, "src/clean.ts"), "utf8"));
        expect((await f.run(flags)).error).toBe(f.exit); expect(f.trace.some(event => Array.isArray(event) && event[0] === "prompt")).toBe(false);
    });
    it("awaits real confirmation and propagates facade rejection identity", async () => {
        const f = fixture(sourceIndex(), resolve(root, "src"), readFileSync(resolve(root, "src/clean.ts"), "utf8"));
        let reject!: (reason: unknown) => void;
        const pending = f.run([], new Promise<string>((_resolve, fail) => { reject = fail; }));
        await Promise.resolve(); await Promise.resolve();
        expect(f.trace.some(event => Array.isArray(event) && event[0] === "native" && (event[1] as string[])[0] === "rm")).toBe(false);
        reject(f.fault); expect((await pending).error).toBe(f.fault);
        expect(f.trace).not.toContain("route:returned");
    });
    it("does not invent force/all-projects semantics", async () => {
        const f = fixture(sourceIndex(), resolve(root, "src"), readFileSync(resolve(root, "src/clean.ts"), "utf8"));
        const result = await f.run(["--force", "--all-projects", "--dry-run"]);
        expect(result.error).toBeUndefined(); expect(result.trace.some(event => Array.isArray(event) && event[0] === "native" && (event[1] as string[])[0] === "volume")).toBe(false);
        expect(result.trace).not.toContainEqual(["log", "\nContainers to stop:"]);
    });
});

describe("actual retained native guard body — bounded closure evidence", () => {
    it("retains synchronous callback and 180000ms guard without invoking native filesystem", () => {
        const file = resolve(root, "src/session.ts"); const text = readFileSync(file, "utf8");
        const tree = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
        const names = ["containerLifecycleLock", "ensureLocksDirectory", "withContainerLifecycleLock"];
        const functions = names.map(name => { const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); if (!node) throw new Error(`Missing actual ${name}`); return node.getText(tree).replace(/^export /, ""); });
        let denied = 0; const trace: unknown[] = [];
        const deny = (): never => { denied++; throw new Error("Denied native effect"); };
        const code = ts.transpileModule(`${functions.join("\n")}\nwithContainerLifecycleLock;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const guard = runInNewContext(code, { process: new Proxy({}, { get: deny }), console: new Proxy({}, { get: deny }), require: deny, fetch: deny, setTimeout: deny,
            ensureNativeSessionClaimsDirectory: () => { trace.push("ensure-directory"); }, locksDir: () => "/private/claims", join: (...parts: string[]) => parts.join("/"),
            withSharedMutationLock: (path: string, callback: () => unknown, options: unknown) => { trace.push(["guard", path, options]); const result = callback(); expect(result).not.toBeInstanceOf(Promise); return result; },
        }, { timeout: 1000 }) as (prefix: string, operation: () => unknown) => unknown;
        try { expect(guard("raw-prefix", () => { trace.push("callback"); return undefined; })).toBeUndefined(); }
        finally { expect(denied).toBe(0); }
        expect(trace).toEqual(["ensure-directory", ["guard", "/private/claims/raw-prefix.container-lifecycle.guard", { waitMs: 180000 }], "callback"]);
    });
});
const emittedRoot = process.env.CCC_CLEAN_COMPLETE_EMITTED_ROOT;
describe.skipIf(!emittedRoot)("actual complete emitted index clean binding — route-only gate", () => {
    it("executes emitted binding through full emitted facade", async () => {
        const f = fixture(readFileSync(resolve(emittedRoot!, "index.js"), "utf8"), emittedRoot!);
        expect((await f.run(["--all", "--volumes", "-y"])).error).toBe(f.exit);
        expect(f.trace).toContainEqual(["native", ["rm", "111111111111"], { stdio: "inherit" }]);
    });
});
