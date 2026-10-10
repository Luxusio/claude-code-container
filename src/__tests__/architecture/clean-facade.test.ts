import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Current clean modules execute with controlled native effects.
// Native dependencies are low-level seams; the complete actual workflow executes.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const ids = ["111111111111", "222222222222", "333333333333"];
type Options = { volumes?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean };
type Scenario = {
    options?: Options; containers?: string | null; images?: (string | null)[]; volumes?: string | null;
    answer?: unknown; claims?: string[]; failure?: string; inventoryFailure?: number;
    status?: unknown; returnedError?: unknown; faultAt?: string; registry?: string;
    lateRuntime?: boolean; duplicateClaimsLength?: boolean; mutateOptions?: boolean;
    recordGetters?: boolean; recordFault?: string;
};
type Trace = unknown[];
function fixture(source: string, mode: Scenario = {}, emittedRoot?: string) {
    const trace: Trace = []; const fault = { raw: "fault" }; let denied = 0, probes = 0, runtime = "inventory", currentSpawn = 0;
    const deny = (site: string): never => { denied++; throw new Error(`Denied native effect: ${site}`); };
    const deniedObject = (name: string) => new Proxy({}, { get: (_target, key) => deny(`${name}.${String(key)}`), set: () => deny(name) });
    const consoleObject: Record<string, unknown> = {};
    let logger = 0;
    Object.defineProperty(consoleObject, "log", { get() {
        trace.push("log:get"); if (mode.faultAt === "log:get") throw fault;
        const selected = logger++;
        return function(this: unknown, text: string) { trace.push(["log", text, this === consoleFence, selected]); if (mode.faultAt === "log:call") throw fault; };
    } });
    const consoleFence = new Proxy(consoleObject, { get: (target, key) => key === "log" ? Reflect.get(target, key) : deny(`console.${String(key)}`) });
    // Capture publication through the controlled console.
    Object.defineProperty(consoleObject, "log", { configurable: false });
    const output: Record<string, unknown> = {};
    const children = new Map<string, Record<string, unknown>>();
    const inventoryRaw = (kind: string, stdout: string | null | undefined) => {
        const ordinal = ++probes;
        return {
            get error() { trace.push(["admission", ordinal, "error"]); if (mode.faultAt === `inventory:${ordinal}:error`) throw fault; return ordinal === mode.inventoryFailure ? mode.returnedError : undefined; },
            get status() { trace.push(["admission", ordinal, "status"]); if (mode.faultAt === `inventory:${ordinal}:status`) throw fault; return ordinal === mode.inventoryFailure ? mode.status : 0; },
            get stdout() {
                trace.push(["stdout", ordinal, kind]); if (mode.faultAt === `inventory:${ordinal}:stdout`) throw fault;
                // Raw native carrier adversary, not a copied parser: the actual
                // current flatMap callback constructs each actual record. The
                // allocated returned array only adds observable field access.
                if (kind === "containers" && mode.recordGetters) return { trim: () => ({ split: () => ({ flatMap: (callback: (line: string) => Record<string, unknown>[]) => String(stdout).split("\n").flatMap(callback).map(record => new Proxy(record, { get(target, field) {
                    trace.push(["record:get", field]);
                    if (field === mode.recordFault) throw fault;
                    if (field === "id") currentSpawn += 10;
                    if (field === "name") logger += 10;
                    return Reflect.get(target, field);
                } })) }) }) };
                return stdout;
            },
            get stderr() { return deny("unconsumed stderr"); },
        };
    };
    const native: Record<string, Record<string, unknown>> = {
        "child_process": {},
        "./docker.js": { ensureDockerRunning: () => { trace.push("ready"); if (mode.faultAt === "ready") throw fault; } },
        "./container-runtime.js": { runtimeCli: () => { trace.push(["runtime", runtime]); if (mode.faultAt === "runtime") throw fault; currentSpawn++; return runtime; } },
        "./utils.js": { prompt: async (question: string, lowercase: boolean) => { trace.push(["prompt", question, lowercase]); if (mode.faultAt === "prompt") throw fault; if (mode.lateRuntime) runtime = "confirmed"; return mode.answer ?? "yes"; } },
        "./session.js": {
            withContainerLifecycleLock: (prefix: string, operation: () => unknown) => { trace.push(["lock:enter", prefix]); if (mode.faultAt === "lock") throw fault; const result = operation(); expect(result).toBeUndefined(); trace.push(["lock:leave", prefix]); },
            getSessionLockClaimsForContainer: (prefix: string) => { trace.push(["claims", prefix]); if (mode.faultAt === "claims") throw fault;
                const claims = mode.claims ?? [];
                return mode.duplicateClaimsLength ? new Proxy(claims, { get(target, key) { if (key === "length") trace.push("claims:length"); return Reflect.get(target, key); } }) : claims;
            },
        },
    };
    Object.defineProperty(native["./utils.js"], "DOCKER_REGISTRY_IMAGE", { get() { trace.push("registry:get"); if (mode.faultAt === "registry") throw fault; return mode.registry ?? "registry/ccc"; } });
    Object.defineProperty(native.child_process, "spawnSync", { get() {
        trace.push("spawn:get"); if (mode.faultAt === "spawn:get") throw fault; const selected = currentSpawn;
        return function(this: unknown, cli: string, args: string[], options: unknown) {
            trace.push(["spawn", cli, [...args], options, this === native.child_process, selected]);
            if (mode.faultAt === `spawn:${args[0]}`) throw fault;
            if (args[0] === "ps") return inventoryRaw("containers", mode.containers ?? `${ids[0]}\tccc-running\tUp 2 minutes\n${ids[1]}\tccc-stopped\tExited (0)`);
            if (args[0] === "images") return inventoryRaw("images", (mode.images ?? ["ccc\timage-a\t1MB", "registry/ccc\timage-a\t9MB\nregistry/ccc\timage-b\t2MB"])[probes - 1]);
            if (args[0] === "volume" && args[1] === "ls") return inventoryRaw("volumes", mode.volumes ?? "ccc-cache\nccc-cache");
            return { get error() { trace.push(["mutation:error", args]); if (mode.faultAt === "mutation:error") throw fault; return undefined; }, get status() { trace.push(["mutation:status", args]); if (mode.faultAt === "mutation:status") throw fault; return args.join(" ") === mode.failure ? 7 : 0; } };
        };
    } });
    const allowed = new Set(["application/clean.ts", "domain/clean.ts", "ports/clean.ts", "application/clean.js", "domain/clean.js", "ports/clean.js"]);
    const processFence = new Proxy({}, { get: (_target, key) => key === "exit" ? (code: number) => { if (code !== 0) return deny(`unapproved exit ${code}`); trace.push(["exit", code]); if (mode.faultAt === "exit") throw fault; } : deny(`process.${String(key)}`) });
    const globals = { console: consoleFence, process: processFence, Buffer: deniedObject("Buffer"), fetch: () => deny("fetch"), setTimeout: () => deny("setTimeout"), setInterval: () => deny("setInterval"), setImmediate: () => deny("setImmediate"), require: () => deny("global require") };
    function load(text: string, file: string, exports: Record<string, unknown>) {
        const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const requireModule = (specifier: string): unknown => {
            const key = specifier.replace(/^node:/, "");
            if (native[key]) return native[key];
            const absolute = resolve(dirname(file), specifier);
            const relative = absolute.slice(resolve(emittedRoot ?? resolve(root, "src")).length + 1);
            const sourcePath = emittedRoot ? relative : relative.replace(/\.js$/, ".ts");
            if (!allowed.has(sourcePath)) return deny(`import ${specifier}`);
            if (!children.has(absolute)) {
                const child = {}; children.set(absolute, child);
                load(readFileSync(resolve(emittedRoot ?? resolve(root, "src"), sourcePath), "utf8"), absolute, child);
            }
            return children.get(absolute);
        };
        // Deny defaults are installed before evaluating any actual module body.
        runInNewContext(compiled, { ...globals, exports, require: requireModule }, { filename: file, timeout: 1000 });
    }
    try { load(source, resolve(emittedRoot ?? resolve(root, "src"), "clean.js"), output); }
    finally { expect(denied, "module initialization must have zero forbidden attempts").toBe(0); }
    const clean = output.cleanContainers as (options: Options) => Promise<void>;
    async function run(options = mode.options ?? { all: true, yes: true }) {
        let error: unknown;
        try {
            expect(clean.name).toBe("cleanContainers"); expect(clean.length).toBe(1);
            const pending = clean(options); trace.push("caller:returned");
            void Promise.resolve().then(() => { trace.push("caller:microtask-1"); }).then(() => { trace.push("caller:microtask-2"); });
            await pending; trace.push("caller:settled");
        } catch (caught) { error = caught; trace.push("caller:rejected"); }
        finally { expect(denied, "every successful or thrown subject case must have zero forbidden attempts").toBe(0); }
        return { trace, error, fault };
    }
    return { run, trace, fault, denied: () => denied, negativeControl: (script: string) => runInNewContext(script, globals, { timeout: 1000 }) };
}
function mutationArgs(trace: Trace) {
    return trace.filter((event): event is unknown[] => Array.isArray(event) && event[0] === "spawn")
        .map(event => event[2] as string[]).filter(args => ["stop", "rm", "rmi"].includes(args[0]) || args[0] === "volume" && args[1] === "rm");
}
const candidateSource = () => readFileSync(resolve(root, "src/clean.ts"), "utf8");
describe("current clean facade behavior", () => {

    it("pins all exact inventory argv/options, first-ID dedupe, sequential deletion and duplicate volumes", async () => {
        const result = await fixture(candidateSource()).run();
        const spawn = result.trace.filter((event): event is unknown[] => Array.isArray(event) && event[0] === "spawn");
        expect(spawn.slice(0, 4).map(event => [event[1], event[2], event[3]])).toEqual([
            ["inventory", ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"], { encoding: "utf-8" }],
            ["inventory", ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", "ccc"], { encoding: "utf-8" }],
            ["inventory", ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", "registry/ccc"], { encoding: "utf-8" }],
            ["inventory", ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"], { encoding: "utf-8" }],
        ]);
        expect(mutationArgs(result.trace)).toEqual([["stop", ids[0]], ["rm", ids[0]], ["rm", ids[1]], ["rmi", "image-a"], ["rmi", "image-b"], ["volume", "rm", "ccc-cache"], ["volume", "rm", "ccc-cache"]]);
        expect(spawn.slice(4).every(event => JSON.stringify(event[3]) === JSON.stringify({ stdio: "inherit" }))).toBe(true);
        expect(result.trace).toContainEqual(["log", "\nDone. Removed 6 item(s).", true, expect.any(Number)]);
    });
    it.each(["veto", "default-running", "failed-stop", "first-failure"])("uses exact-ID destructive denial oracle: %s", async mode => {
        const scenario: Scenario = mode === "veto" ? { claims: ["stale-malformed.lock"] } : mode === "default-running" ? { options: { yes: true } } : mode === "failed-stop" ? { failure: `stop ${ids[0]}` } : { failure: `rm ${ids[1]}` };
        const result = await fixture(candidateSource(), scenario).run(); const args = mutationArgs(result.trace);
        if (mode === "veto") expect(args.filter(arg => ["stop", "rm"].includes(arg[0]))).toEqual([]);
        if (mode === "default-running") { expect(args).not.toContainEqual(["stop", ids[0]]); expect(args).not.toContainEqual(["rm", ids[0]]); expect(args).toContainEqual(["rm", ids[1]]); }
        if (mode === "failed-stop") expect(args).toEqual([["stop", ids[0]]]);
        if (mode === "first-failure") expect(args).toEqual([["stop", ids[0]], ["rm", ids[0]], ["rm", ids[1]]]);
    });
;

});

describe("REQ-derived intentional fail-closed inventory admission (not original goldens)", () => {
    it.each(["require('node:fs').writeFileSync('/foreign','x')", "require('node:fs/promises').unlink('/foreign')", "require('child_process').spawn('docker')", "require('node:net').connect(1)", "process.kill(1)", "process.exit(9)", "fetch('https://example.invalid')", "setTimeout(() => {}, 1)"])("counts denied negative control even when caught: %s", script => {
        const f = fixture(candidateSource()); f.negativeControl(`try { ${script}; } catch (_) {}`);
        expect(f.denied()).toBe(1);
    });
    it.each([1, 2, 3, 4].flatMap(ordinal => [undefined, null, 1, -1, false, "0"].map(status => ({ ordinal, status }))))("denies failed inventory $ordinal / $status before stdout or downstream effects", async ({ ordinal, status }) => {
        const result = await fixture(candidateSource(), { inventoryFailure: ordinal, status }).run();
        const kind = ordinal === 1 ? "containers" : ordinal === 4 ? "volumes" : "images";
        expect(result.error).toHaveProperty("message", `Failed to list ${kind}; cleanup aborted.`);
        expect(result.trace.filter(event => Array.isArray(event) && event[0] === "stdout" && Number(event[1]) >= ordinal)).toEqual([]);
        expect(result.trace.filter(event => Array.isArray(event) && ["log", "prompt", "lock:enter", "claims", "exit"].includes(String(event[0])))).toEqual([]);
        expect(mutationArgs(result.trace)).toEqual([]);
        expect(result.trace.filter(event => Array.isArray(event) && event[0] === "spawn")).toHaveLength(ordinal);
    });
    it.each([1, 2, 3, 4])("truthy error short-circuits status and stdout for command %i", async ordinal => {
        const result = await fixture(candidateSource(), { inventoryFailure: ordinal, returnedError: { opaque: true }, status: 0 }).run();
        expect(result.trace).toContainEqual(["admission", ordinal, "error"]);
        expect(result.trace).not.toContainEqual(["admission", ordinal, "status"]);
        expect(mutationArgs(result.trace)).toEqual([]);
    });
    it.each([false, 0, "", null, undefined])("falsy returned inventory error %j admits status zero", async returnedError => {
        const result = await fixture(candidateSource(), { inventoryFailure: 2, returnedError, status: 0 }).run();
        expect(result.error).toBeUndefined(); expect(result.trace).toContainEqual(["admission", 2, "status"]); expect(mutationArgs(result.trace)).toContainEqual(["rm", ids[1]]);
    });
    it.each([{ all: true, dryRun: true }, { all: true, yes: true }, { volumes: true, yes: true }])("failure admission precedes dry-run/yes/all effects %j", async options => {
        const result = await fixture(candidateSource(), { options, inventoryFailure: 3, status: 1 }).run();
        expect(result.error).toHaveProperty("message", "Failed to list images; cleanup aborted.");
        expect(result.trace.filter(event => Array.isArray(event) && ["log", "prompt", "lock:enter", "claims", "exit"].includes(String(event[0])))).toEqual([]);
    });
    it.each([1, 2, 3, 4].flatMap(ordinal => ["error", "status", "stdout"].map(field => `inventory:${ordinal}:${field}`)))("propagates admission/raw getter identity: %s", async faultAt => {
        const result = await fixture(candidateSource(), { faultAt }).run();
        expect(result.error).toBe(result.fault); expect(mutationArgs(result.trace)).toEqual([]);
    });

});
