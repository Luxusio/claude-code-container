import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

describe("actual main labs binding under pre-import deny fences", () => {
    it.each([{args: [] as string[]}, {args: ["status"]}, {args: ["doctor"]}, {args: ["smoke"]}, {args: ["invalid"]}])("routes $args into compiled current facade and exits its result", async ({args}) => {
        const attempts: string[] = [], output: string[] = [], errors: string[] = [], admitted: string[] = [];
        const exitSignal = {};
        let exit: number | undefined;
        const deny = (name: string) => { attempts.push(name); throw new Error(`denied ${name}`); };
        const processFixture = { argv: ["node", "private-cli", "labs", ...args], env: { HOME: "/private/lab-diagnostics-home", VITEST: "true" }, cwd: () => "/private/project", exit: (code: number) => { exit = code; throw exitSignal; } };
        const consoleFixture = { log: (text: string) => output.push(text), error: (text: string) => errors.push(text) };
        const cfg = { status: "unsupported", stateVolumeName: "state", stateContainerDir: "/private/state", networkMode: "user", unsupportedReason: "fenced unavailable" };
        const native: Record<string, object> = {
            path: { resolve: (cwd: string) => cwd },
            "./docker.js": { getContainerName: (_cwd: string, profile?: string) => profile ? "lab" : "default", buildContainerVmRunConfig: () => cfg, buildLabRunnerRunConfig: () => cfg, getLabRunnerStateVolumeName: () => "state" },
            "./utils.js": { LAB_RUNNER_PROFILE_NAME: "lab-runner", LAB_RUNNER_STATE_CONTAINER_DIR: "/private/state" },
            "./container-runtime.js": { formatRuntimeSummary: () => "private fixture runtime" },
        };
        const allowed = new Set(["src/lab-runner-admin.ts", "src/domain/lab-runner-diagnostics.ts", "src/ports/lab-runner-diagnostics.ts", "src/application/lab-runner-diagnostics.ts"]);
        const load = (path: string): Record<string, (...values: unknown[]) => unknown> => {
            const relative = path.slice(root.length + 1); if (!allowed.has(relative)) return deny(relative);
            const exports = {};
            runInNewContext(compile(readFileSync(path, "utf8")), { exports, process: processFixture, console: consoleFixture, require: (name: string) => {
                if (path.endsWith("/lab-runner-admin.ts") && name in native) return new Proxy(native[name], { get: (target, key) => key in target ? Reflect.get(target, key) : deny(`${name}:${String(key)}`) });
                return load(resolve(dirname(path), name.replace(/\.js$/, ".ts")));
            } });
            return exports;
        };
        // All fences exist before evaluating either public facade or CLI body.
        const facade = load(resolve(root, "src/lab-runner-admin.ts"));
        const source = readFileSync(resolve(root, "src/index.ts"), "utf8");
        const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);
        const main = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "main");
        expect(main).toBeDefined();
        const exports: { main?: () => Promise<void> } = {};
        runInNewContext(compile(main!.getText(ast)), {
            exports, process: processFixture, console: consoleFixture,
            parseArgs: (values: string[]) => ({ filteredArgs: values, worktreeArg: undefined }),
            informationalCommand: () => undefined,
            migrateHostHomeLayout: () => { admitted.push("private layout seam"); },
            normalizeProfile: () => undefined,
            detectWorktreeWorkspaceBranch: () => { admitted.push("private worktree observation"); return undefined; },
            labsCli: facade.labsCli,
            ensureProfile: () => deny("ensureProfile"), exec: () => deny("exec"),
            require: (name: string) => deny(`import:${name}`),
        });
        try { await exports.main!(); throw new Error("main did not exit"); } catch (error) { expect(error).toBe(exitSignal); }
        expect(exit).toBe(args[0] === "invalid" ? 1 : 0);
        expect(attempts).toEqual([]); expect(admitted).toEqual(["private layout seam", "private worktree observation"]);
        if (args[0] === "invalid") { expect(output).toEqual([]); expect(errors).toEqual(["Usage: ccc labs <status|doctor|smoke|shell|run>"]); }
        else { expect(errors).toEqual([]); expect(output).toHaveLength(1); expect(output[0]).toContain(args[0] === "smoke" ? "vm-startup: not-run" : "this status check does not start labs or VMs"); }
    });
    it("keeps canonical shell and run routes ahead of diagnostic dispatch", () => {
        const source = readFileSync(resolve(root, "src/index.ts"), "utf8");
        const route = source.slice(source.indexOf('case "labs":'), source.indexOf('case "clean":'));
        expect(route.indexOf('subcommand === "shell"')).toBeLessThan(route.indexOf("const status = labsCli"));
        expect(route.indexOf('subcommand === "run"')).toBeLessThan(route.indexOf("const status = labsCli"));
        expect(route).toContain("await exec(cwd, [\"bash\"]"); expect(route).toContain("await exec(cwd, labCommand");
    });
});
