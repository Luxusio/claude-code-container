import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { withCodexConfigLock } from "../../codex-config-lock.js";
import { prepareCodexConfigForContainer } from "../../docker.js";
import { ensureCodexHarness, CODEX_HARNESS_BOOTSTRAP } from "../../codex-harness.js";

vi.mock("child_process", () => ({spawnSync: vi.fn()}));
vi.mock("../../container-runtime.js", () => ({runtimeCli: () => "private-fixture"}));
vi.mock("../../codex-config-lock.js", () => ({withCodexConfigLock: vi.fn((operation: () => unknown) => operation())}));
vi.mock("../../docker.js", () => ({prepareCodexConfigForContainer: vi.fn(), restoreCodexConfigHostOwnership: vi.fn()}));

// This is the actual source caller branch and actual facade, with denied native transport.
// It deliberately claims route-only coverage: Root owns full emitted main and both packages.
describe("Codex Harness actual source startup route (route-only)", () => {
    it.each([false, true])("uses final readiness identity/profile for Codex, reused=%s", reused => {
        vi.clearAllMocks();
        vi.mocked(spawnSync).mockReturnValue({status: 0, stdout: "", stderr: ""} as ReturnType<typeof spawnSync>);
        const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
        const start = source.indexOf('        if (commandTool?.name === "claude") {', source.indexOf("This is deliberately the final restart-capable readiness step"));
        const end = source.indexOf('        progress("Syncing clipboard shims...");', start);
        expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
        const branch = source.slice(start, end);
        const trace: unknown[] = [];
        const invoke = new Function("commandTool", "readyContainerName", "profile", "ensureClaudeInContainer", "withCodexConfigLock", "prepareCodexConfigForContainer", "assertCodexStateAccessible", "ensureCodexHarness", branch);
        const lock = (operation: () => unknown, profile?: string) => { trace.push(["caller-lock", profile]); return withCodexConfigLock(operation, profile); };
        const prepare = (id: string, profile?: string) => { trace.push(["caller-prepare", id, profile]); prepareCodexConfigForContainer(id, profile); };
        const assert = (id: string, profile?: string) => trace.push(["access", id, profile]);
        const actual = (id: string, profile?: string) => { trace.push(["actual-facade", id, profile]); ensureCodexHarness(id, profile); };
        const finalId = reused ? "reused-final-replacement" : "fresh-final-replacement";
        invoke({name: "codex"}, finalId, "work", () => { throw new Error("Claude path"); }, lock, prepare, assert, actual);
        expect(trace).toEqual([["caller-lock", "work"], ["caller-prepare", finalId, "work"], ["access", finalId, "work"], ["actual-facade", finalId, "work"]]);
        expect(spawnSync).toHaveBeenCalledOnce();
        expect(vi.mocked(spawnSync).mock.calls[0][1]).toContain(finalId);
        expect(vi.mocked(spawnSync).mock.calls[0][2]).toMatchObject({input: CODEX_HARNESS_BOOTSTRAP, timeout: 135000});
        vi.clearAllMocks(); trace.length = 0;
        const claude = vi.fn();
        invoke({name: "claude"}, finalId, "work", claude, lock, prepare, assert, actual);
        expect(claude).toHaveBeenCalledExactlyOnceWith(finalId);
        expect(trace).toEqual([]); expect(spawnSync).not.toHaveBeenCalled();
    });
});

// Mandatory emitted route + complete emitted facade closure + real emitted Python.
// The main program remains Root's separate gate; no source module fallback is allowed.
const DISABLED_PYTHON_FENCE = String.raw`
import sys, os, pathlib, json, atexit
root = pathlib.Path(os.environ['HOME']).resolve()
denied = []
def refuse(event, args):
    denied.append([event, str(args)])
    raise RuntimeError('C6 denied ' + event)
def private(path):
    resolved = pathlib.Path(os.path.realpath(path))
    return resolved == root or root in resolved.parents
def audit(event, args):
    if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.posix_spawn','os.exec','os.fork','os.kill','os.killpg'):
        refuse(event, args)
    if event == 'open' and not isinstance(args[0], int):
        path, mode, flags = args
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC): refuse(event,args)
        if not private(path) and not str(path).startswith(('/usr/lib/','/usr/local/lib/')): refuse(event,args)
    if event in ('os.mkdir','os.remove','os.rmdir','os.rename','os.chmod','os.link','os.symlink','os.truncate'):
        refuse(event,args)
sys.addaudithook(audit)
for method in ('exists','is_file','read_text'):
    selected = getattr(pathlib.Path,method)
    def checked(self,*args,_selected=selected,_method=method,**kwargs):
        if not private(self): refuse('Path.' + _method,str(self))
        return _selected(self,*args,**kwargs)
    setattr(pathlib.Path,method,checked)
atexit.register(lambda: print('__C6__'+json.dumps(denied),file=sys.stderr))
`;

function assembledCallerOracle(source: string, file: string, refuse: (reason: string) => never): string {
    const project = fileURLToPath(new URL("../../../", import.meta.url));
    const scriptPath = join(project, "scripts/workspace-build.mjs");
    const sealed = new Map<string, {real: string; dev: number; ino: number; uid: number; mode: number; digest: string}>();
    const readSealed = (path: string) => {
        const observed = lstatSync(path), real = realpathSync(path);
        if (!observed.isFile() || observed.nlink !== 1) return refuse("nonordinary assembly input: " + path);
        const bytes = readFileSync(path), contents = bytes.toString("utf8");
        const witness = {real, dev: observed.dev, ino: observed.ino, uid: observed.uid, mode: observed.mode, digest: createHash("sha256").update(bytes).digest("hex")};
        if (sealed.has(path)) expect(witness, "assembly input changed between reads: " + path).toEqual(sealed.get(path));
        else sealed.set(path, witness);
        return contents;
    };
    const builderSource = readSealed(scriptPath);
    const parsed = ts.createSourceFile(scriptPath, builderSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const namedFunction = (name: string) => {
        const declarations = parsed.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
        if (declarations.length !== 1 || !declarations[0].body) return refuse("assembly function not authenticated: " + name);
        return declarations[0];
    };
    const exportTarget = namedFunction("exportTarget");
    const importLiteral = namedFunction("importLiteral");
    const assemble = namedFunction("assembleWorkspaceRuntime");
    const constants = parsed.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
    const runtime = constants.find(node => ts.isIdentifier(node.name) && node.name.text === "runtimePackages")?.initializer;
    if (!runtime || !ts.isArrayLiteralExpression(runtime) || !runtime.elements.every(ts.isStringLiteral)) return refuse("actual runtime package manifest set missing");
    const packages = runtime.elements.map(node => (node as ts.StringLiteral).text);
    const manifests = new Map<string, {manifest: unknown; destination: string}>();
    const destinations: string[] = [];
    for (const name of packages) {
        const sourceManifest = readSealed(join(project, "packages", name, "package.json"));
        const destination = join(project, "dist/packages", name);
        expect(readSealed(join(destination, "package.json")), "actual assembled manifest bytes: " + name).toBe(sourceManifest);
        const manifest = JSON.parse(sourceManifest) as {name: string};
        manifests.set(manifest.name, {manifest, destination}); destinations.push(destination);
    }
    const loops = assemble.body!.statements.filter(ts.isForOfStatement).filter(node => ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "filesUnder");
    if (loops.length !== 1 || !ts.isBlock(loops[0].statement)) return refuse("actual import assembly loop missing");
    const statements = (loops[0].statement as ts.Block).statements;
    const variableNamed = (node: ts.Statement, name: string) => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
    const start = statements.findIndex(node => variableNamed(node, "parsed"));
    const write = statements.findIndex(node => ts.isIfStatement(node) && node.getText(parsed).includes("writeFileSync(file, rewritten)"));
    const pure = statements.slice(start, write);
    if (start < 0 || write <= start || pure.length !== 6 || !variableNamed(pure[0], "parsed") || !variableNamed(pure[1], "replacements") || !ts.isFunctionDeclaration(pure[2]) || pure[2].name?.text !== "visit" || !ts.isExpressionStatement(pure[3]) || !variableNamed(pure[4], "rewritten") || !ts.isForOfStatement(pure[5])) return refuse("pure assembly AST/body shape changed");
    // Execute only CURRENT pure function/visitor/replacement bodies. Neither package build,
    // file traversal, runtime copying nor the actual writeFileSync statement is evaluated.
    const rewrite = runInNewContext("(function(){\n" + exportTarget.getText(parsed) + "\n" + importLiteral.getText(parsed) + "\nreturn function(source,file,manifests){\n" + pure.map(node => node.getText(parsed)).join("\n") + "\nreturn rewritten;\n};\n})()", {
        ts, resolve, relative, dirname, sep,
        existsSync: (target: string) => {
            if (!destinations.some(destination => target.startsWith(destination + sep))) return refuse("unallocated assembly export target");
            if (!existsSync(target)) return false;
            if (!destinations.some(destination => realpathSync(target).startsWith(realpathSync(destination) + sep))) return refuse("assembly export canonical escape");
            readSealed(target); return true;
        },
    }, {filename: scriptPath, timeout: 1000}) as (text: string, targetFile: string, entries: Map<string, {manifest: unknown; destination: string}>) => string;
    const expected = rewrite(source, file, manifests);
    for (const [path, witness] of sealed) {
        const observed = lstatSync(path);
        expect([realpathSync(path), observed.dev, observed.ino, observed.uid, observed.mode, createHash("sha256").update(readFileSync(path)).digest("hex")], "readonly assembly input lifetime: " + path).toEqual([witness.real, witness.dev, witness.ino, witness.uid, witness.mode, witness.digest]);
    }
    return expected;
}

describe("mandatory current emitted Codex startup route, actual facade and Python (route-only)", () => {
    it.each([false, true].flatMap(reused => [undefined, "work"].flatMap(profile => ["codex", "claude"].map(tool => ({reused, profile, tool})))))("executes the emitted operation with native fences: $tool reused=$reused profile=$profile", async ({reused, profile, tool}) => {
        const temporary = mkdtempSync(join(tmpdir(), "ccc-harness-emitted-caller-"));
        const home = join(temporary, "home"); mkdirSync(home); mkdirSync(join(home, ".codex")); mkdirSync(join(home, "bin"));
        const configPath = join(home, ".codex/config.toml");
        const originalConfig = 'model = "preserved"\n[features]\nplugin_hooks = false\n';
        writeFileSync(configPath, originalConfig);
        const denied: string[] = [];
        const pythonDenied: unknown[] = [];
        const trace: unknown[] = [];
        const emittedRoot = fileURLToPath(new URL("../../../dist/", import.meta.url));
        const finalId = reused ? "reused-final-replacement" : "fresh-final-replacement";
        let bootstrap = "";
        let executions = 0;
        const refuse = (reason: string): never => { denied.push(reason); throw new Error("C6 denied " + reason); };
        const interpreterPath = realpathSync("/usr/bin/python3");
        const interpreterStat = statSync(interpreterPath);
        const interpreterDigest = createHash("sha256").update(readFileSync(interpreterPath)).digest("hex");
        // Capture only the controller interpreter before loading any target module.
        const realProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const native = {
            lock<T>(operation: () => T, selected?: string): T { if (selected !== profile || typeof operation !== "function") refuse("lock arguments"); trace.push(["lock", selected]); return operation(); },
            prepare(id: string, selected?: string) { if (id !== finalId || selected !== profile) refuse("prepare identity/profile"); trace.push(["prepare", id, selected]); },
            restore(id: string, selected?: string) { if (id !== finalId || selected !== profile) refuse("restore identity/profile"); trace.push(["restore", id, selected]); },
            runtime() { trace.push("runtime"); return "private-emitted-transport"; },
            spawn(command: unknown, args: unknown, options: unknown) {
                const expected = ["exec", "-i", "--workdir", "/home/ccc", "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0", finalId, "python3", "-"];
                const settings = options as {input?: unknown; encoding?: unknown; timeout?: unknown};
                if (command !== "private-emitted-transport" || JSON.stringify(args) !== JSON.stringify(expected) || settings?.input !== bootstrap || settings.encoding !== "utf-8" || settings.timeout !== 135000) refuse("transport/script arguments");
                const currentInterpreter = statSync(interpreterPath);
                if (realpathSync("/usr/bin/python3") !== interpreterPath || currentInterpreter.dev !== interpreterStat.dev || currentInterpreter.ino !== interpreterStat.ino || createHash("sha256").update(readFileSync(interpreterPath)).digest("hex") !== interpreterDigest) refuse("controller interpreter generation/bytes");
                trace.push(["execute-python", finalId]); executions++;
                const result = realProcess.spawnSync("/usr/bin/python3", ["-"], {input: DISABLED_PYTHON_FENCE + "\nexec(" + JSON.stringify(bootstrap) + ")\n", encoding: "utf8", timeout: 10000, env: {HOME: home, PATH: join(home, "bin"), PYTHONDONTWRITEBYTECODE: "1"}});
                if (result.error) throw result.error;
                const lines = result.stderr.trimEnd().split("\n");
                const receipt = lines.pop() ?? "";
                if (!receipt.startsWith("__C6__")) refuse("missing Python fence receipt");
                const observed = JSON.parse(receipt.slice("__C6__".length)) as unknown[];
                pythonDenied.push(...observed);
                if (observed.length) refuse("Python denied effects");
                expect(result.status).toBe(0); expect(result.stdout).toBe(""); expect(lines.join("\n")).toBe("");
                return {...result, stderr: lines.join("\n")};
            },
        };
        const nativeModules = new Map<string, object>([
            [join(emittedRoot, "docker.js"), {prepareCodexConfigForContainer: native.prepare, restoreCodexConfigHostOwnership: native.restore}],
            [join(emittedRoot, "codex-config-lock.js"), {withCodexConfigLock: native.lock}],
            [join(emittedRoot, "container-runtime.js"), {runtimeCli: native.runtime}],
        ]);
        const allowed = new Set([
            "codex-harness.js", "domain/codex-harness.js", "ports/codex-harness.js", "application/codex-harness.js", "adapters/codex-harness.js",
            "domain/codex-harness-bootstrap.js", "ports/codex-harness-bootstrap.js", "application/codex-harness-bootstrap.js", "adapters/codex-harness-bootstrap.js",
        ].map(path => join(emittedRoot, path)));
        // Authenticate every current inward emitted module against CURRENT source.
        // This is build provenance, not a frozen whole-candidate hash golden.
        for (const path of allowed) {
            if (!existsSync(path)) refuse("missing genuine emitted graph member: " + path);
            const relative = path.slice(emittedRoot.length).replace(/^\//, "");
            const sourcePath = fileURLToPath(new URL("../../" + relative.replace(/\.js$/, ".ts"), import.meta.url));
            const expected = ts.transpileModule(readFileSync(sourcePath, "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
            expect(readFileSync(path, "utf8").trim(), "current source/emitted graph provenance: " + relative).toBe(expected.trim());
        }
        const cache = new Map<string, Record<string, unknown>>();
        const load = (path: string): Record<string, unknown> => {
            if (!allowed.has(path)) return refuse("unadmitted emitted module: " + path);
            if (cache.has(path)) return cache.get(path)!;
            if (!existsSync(path)) return refuse("missing genuine emitted module: " + path);
            const exports: Record<string, unknown> = {}; cache.set(path, exports);
            const requireNative = (specifier: string) => {
                if (specifier === "child_process" || specifier === "node:child_process") return {spawnSync: native.spawn};
                if (!specifier.startsWith(".")) return refuse("unadmitted native dependency: " + specifier);
                const dependency = resolve(dirname(path), specifier);
                if (nativeModules.has(dependency)) return nativeModules.get(dependency);
                return load(dependency);
            };
            const compiled = ts.transpileModule(readFileSync(path, "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true}}).outputText;
            // No ambient process, filesystem, network, or native require reaches target code.
            runInNewContext(compiled, {exports, require: requireNative, console: {error: (...args: unknown[]) => refuse("unexpected output " + JSON.stringify(args)), warn: (...args: unknown[]) => refuse("unexpected warning " + JSON.stringify(args))}}, {filename: path, timeout: 1000});
            return exports;
        };
        try {
            const facade = load(join(emittedRoot, "codex-harness.js"));
            expect(typeof facade.ensureCodexHarness).toBe("function");
            expect(typeof facade.CODEX_HARNESS_BOOTSTRAP).toBe("string");
            bootstrap = facade.CODEX_HARNESS_BOOTSTRAP as string;
            expect(bootstrap, "genuine emitted executable must equal the CURRENT source export").toBe(CODEX_HARNESS_BOOTSTRAP);
            // Read the actual current emitted caller branch. No source fallback.
            const indexPath = join(emittedRoot, "index.js");
            if (!existsSync(indexPath)) refuse("missing genuine emitted caller");
            const caller = readFileSync(indexPath, "utf8");
            const callerBeforeAssembly = ts.transpileModule(readFileSync(new URL("../../index.ts", import.meta.url), "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
            const expectedCaller = assembledCallerOracle(callerBeforeAssembly, indexPath, refuse);
            expect(caller.trim(), "genuine current emitted caller provenance").toBe(expectedCaller.trim());
            const start = caller.indexOf('if (commandTool?.name === "claude") {', caller.indexOf("This is deliberately the final restart-capable readiness step"));
            const end = caller.indexOf('progress("Syncing clipboard shims...");', start);
            if (start < 0 || end <= start) refuse("actual emitted caller branch not found");
            const branch = caller.slice(start, end);
            const invoke = runInNewContext("(function(commandTool,readyContainerName,profile,ensureClaudeInContainer,withCodexConfigLock,prepareCodexConfigForContainer,assertCodexStateAccessible,ensureCodexHarness){\n" + branch + "\n})", {}, {filename: indexPath, timeout: 1000}) as (...args: unknown[]) => void;
            const access = (id: string, selected?: string) => { if (id !== finalId || selected !== profile) refuse("access identity/profile"); trace.push(["access", id, selected]); };
            const claude = (id: string) => { if (id !== finalId) refuse("Claude final identity"); trace.push(["claude", id]); };
            invoke({name: tool}, finalId, profile, claude, native.lock, native.prepare, access, facade.ensureCodexHarness);
            expect(denied).toEqual([]); expect(pythonDenied).toEqual([]);
            expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
            if (tool === "codex") {
                expect(executions).toBe(1);
                expect(trace).toEqual([["lock", profile], ["prepare", finalId, profile], ["access", finalId, profile], ["lock", profile], ["prepare", finalId, profile], "runtime", ["execute-python", finalId], ["restore", finalId, profile]]);
            } else { expect(executions).toBe(0); expect(trace).toEqual([["claude", finalId]]); }
        } finally {
            // Check caught refusals before controller-owned teardown.
            expect(denied).toEqual([]); expect(pythonDenied).toEqual([]);
            rmSync(temporary, {recursive: true, force: true});
        }
    }, 20000);
});
