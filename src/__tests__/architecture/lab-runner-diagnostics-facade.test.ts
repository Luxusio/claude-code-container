import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
    it("replays immutable actual source against all 33 frozen records", () => { expect(replay(false)).toEqual(frozen); });
    it("preserves actual outputs, partial traces, raw fault identity and receivers", () => { expect(replay(true)).toEqual(frozen); });
    it("retains public defaults and native authority bytes", () => {
        const source = readFileSync(resolve(root, "src/lab-runner-admin.ts"), "utf8");
        for (const name of ["labRunnerSnapshot", "formatLabRunnerStatus", "formatLabRunnerSmoke"]) expect(source).toMatch(new RegExp(`function ${name}\\(cwd = process\\.cwd\\(\\)\\)`));
        expect(source).toMatch(/function labsCli\(args: string\[\], cwd = process\.cwd\(\)\)/);
        for (const path of ["src/docker.ts", "src/container-runtime.ts", "src/utils.ts", "src/index.ts", "src/container-identity.ts"]) expect(readFileSync(resolve(root, path))).toEqual(readFileSync(resolve(checkpoint, "baseline", path)));
    });
});
