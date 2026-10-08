import { readFileSync } from "node:fs";
import { resolve, dirname, posix, join } from "node:path";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const checkpoint = resolve(root, "doc/harness/checkpoints/labs-diagnostics-20261009");
const witness = readFileSync(resolve(checkpoint, "baseline-witness.cjs"), "utf8");
const frozen = JSON.parse(readFileSync(resolve(checkpoint, "baseline-order.json"), "utf8")) as { mode: string }[];

// Execute the frozen runner, including its ACTUAL facade source, without its
// original output-file write. Candidate imports are confined to three inward files.
function replay(candidate: boolean) {
    const result: unknown[] = [];
    const allowed = new Set(["domain/lab-runner-diagnostics.ts", "ports/lab-runner-diagnostics.ts", "application/lab-runner-diagnostics.ts"]);
    const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const loader = `const loadInner=(name,parent)=>{const path=pathResolve(pathDirname(parent),name.replace(/\\.js$/,'.ts'));const rel=path.slice(sourceRoot.length+1);if(!allowed.has(rel)){denied.push(rel);throw fault}const exports={};vm.runInNewContext(transpile(readSource(path)),{exports,require:n=>loadInner(n,path),Reflect,Object});return exports};`;
    let script = witness.slice(0, witness.indexOf("const records=modes.map(run)"));
    script = script.replace(/const ts=require\([^\n]+\);/, "const ts=typescript;");
    script = script.replace("const source=fs.readFileSync(__dirname+'/baseline/src/lab-runner-admin.ts','utf8');", "const source=readSource(facadePath);");
    if (candidate) {
        script = script.replace("const api={};vm.runInNewContext", loader + "const api={};vm.runInNewContext");
        script = script.replace("denied.push(name);throw fault},process", "return loadInner(name,facadePath)},process");
    }
    script += "\ncollect(modes.map(run));";
    runInNewContext(script, {
        require: (name: string) => { if (name === "node:fs") return {}; if (name === "node:vm") return { runInNewContext }; if (name === "node:assert/strict") return { equal: (a: unknown, b: unknown) => expect(a).toBe(b) }; throw new Error(`denied import ${name}`); },
        typescript: ts, readSource: (path: string) => readFileSync(path, "utf8"),
        facadePath: resolve(candidate ? root : resolve(checkpoint, "baseline"), "src/lab-runner-admin.ts"),
        sourceRoot: resolve(root, "src"), allowed, pathResolve: resolve, pathDirname: dirname, transpile,
        collect: (records: unknown[]) => result.push(...records),
    });
    return JSON.parse(JSON.stringify(result)) as unknown[];
}

describe("actual baseline and current lab facade", () => {
    it("retains the originally selected console object during formatting and method getters", () => {
        const captures = new Map<string, string>(); const attempts: string[] = [];
        const baselineFile = resolve(checkpoint, "console-receiver-baseline-order.json");
        const pairedFile = resolve(checkpoint, "console-receiver-paired-order.json");
        const allowed = new Set([
            resolve(checkpoint, "baseline/src/lab-runner-admin.ts"),
            resolve(root, "src/lab-runner-admin.ts"),
            resolve(root, "src/domain/lab-runner-diagnostics.ts"),
            resolve(root, "src/application/lab-runner-diagnostics.ts"),
        ]);
        const deny = (name: string): never => { attempts.push(name); throw new Error(`denied ${name}`); };
        const native = {
            readFileSync(file: string) { if (!allowed.has(resolve(file))) return deny(file); return readFileSync(file, "utf8"); },
            existsSync(file: string) { if (resolve(file) !== baselineFile) return deny(file); return false; },
            writeFileSync(file: string, value: string) { if (resolve(file) !== baselineFile && resolve(file) !== pairedFile) return deny(file); captures.set(resolve(file), value); },
            chmodSync(file: string) { if (resolve(file) !== baselineFile) return deny(file); },
        };
        runInNewContext(readFileSync(resolve(checkpoint, "console-receiver-witness.cjs"), "utf8"), {
            __dirname: checkpoint,
            require(name: string) {
                if (name === "node:fs") return native;
                if (name === "node:path") return {resolve, dirname, posix, join};
                if (name === "node:vm") return {runInNewContext};
                if (name === "node:assert/strict") return assert;
                if (name.endsWith("/typescript/lib/typescript.js")) return ts;
                return deny(name);
            },
            console: {log: () => undefined, error: () => undefined},
        });
        const pairs = JSON.parse(captures.get(pairedFile)!) as {baseline: {mode: string; trace: unknown[][]; denied: unknown[]}[]; current: unknown[]};
        expect(pairs.current).toEqual(pairs.baseline); expect(pairs.baseline).toHaveLength(3);
        for (const record of pairs.baseline) {
            expect(record.denied).toEqual([]);
            expect(record.trace.some(event => Array.isArray(event) && (event[0] === "log:call" || event[0] === "error:call") && event[1] === true)).toBe(true);
        }
        expect(attempts).toEqual([]);
    });
    it("replays immutable actual source against all 33 frozen records", () => { expect(replay(false)).toEqual(frozen); });
    it("preserves actual outputs, partial traces, raw fault identity and receivers", () => { expect(replay(true)).toEqual(frozen); });
    it("retains public defaults and native authority bytes", () => {
        const source = readFileSync(resolve(root, "src/lab-runner-admin.ts"), "utf8");
        for (const name of ["labRunnerSnapshot", "formatLabRunnerStatus", "formatLabRunnerSmoke"]) expect(source).toMatch(new RegExp(`function ${name}\\(cwd = process\\.cwd\\(\\)\\)`));
        expect(source).toMatch(/function labsCli\(args: string\[\], cwd = process\.cwd\(\)\)/);
        for (const path of ["src/docker.ts", "src/container-runtime.ts", "src/utils.ts", "src/index.ts", "src/container-identity.ts"]) expect(readFileSync(resolve(root, path))).toEqual(readFileSync(resolve(checkpoint, "baseline", path)));
    });
});
