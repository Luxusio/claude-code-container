import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { runtimeCli } from "../../container-runtime.js";
import { withCodexConfigLock } from "../../codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../../docker.js";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../../codex-harness.js";
import { createNativeCodexHarnessPorts } from "../../adapters/codex-harness.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Deny native effects before the facade is imported; every allowed call is private observation.
vi.mock("child_process", () => ({spawnSync: vi.fn(() => { throw new Error("unconfigured native transport"); })}));
vi.mock("../../container-runtime.js", () => ({runtimeCli: vi.fn(() => "fixture-runtime")}));
vi.mock("../../docker.js", () => ({prepareCodexConfigForContainer: vi.fn(), restoreCodexConfigHostOwnership: vi.fn()}));
vi.mock("../../codex-config-lock.js", () => ({withCodexConfigLock: vi.fn((operation: () => unknown) => operation())}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({status: 0, stdout: "", stderr: ""} as ReturnType<typeof spawnSync>);
});
afterEach(() => vi.restoreAllMocks());

describe("actual Codex Harness facade and native binding", () => {
    it.each(["stdout-apply", "warn-apply", "stdout-publisher-fault", "warn-publisher-fault"])("matches the actual frozen original host when argument getters mutate Reflect.apply: %s", mode => {
        // Exact frozen original host wrapper; Python policy has its independent full witness.
        const original = String.raw`
import { spawnSync } from "child_process";
import { runtimeCli } from "./container-runtime.js";
import { withCodexConfigLock } from "./codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "./docker.js";
export const CODEX_HARNESS_BOOTSTRAP = "host-control";
export function ensureCodexHarness(containerName: string, profile?: string): void {
    try {
        withCodexConfigLock(() => {
            try {
                prepareCodexConfigForContainer(containerName, profile);
                const result = spawnSync(runtimeCli(), [
                    "exec", "-i", "--workdir", "/home/ccc",
                    "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0",
                    containerName, "python3", "-",
                ], { input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000 });
                if (result.stdout?.trim()) console.error(result.stdout.trim());
                if (result.error || result.status !== 0) {
                    throw new Error(result.error?.message ?? (result.stderr?.trim() || ` + "`bootstrap exited ${result.status}`" + String.raw`));
                }
            } finally {
                restoreCodexConfigHostOwnership(containerName, profile);
            }
        }, profile);
    } catch (error) {
        console.warn(` + "`[ccc] Harness is unavailable: ${error instanceof Error ? error.message : String(error)}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`" + String.raw`);
    }
}
`;
        const capture = (candidate: boolean) => {
            const trace: unknown[] = [];
            const denied: string[] = [];
            const receiver = {};
            const reflected = {apply: Reflect.apply};
            const context = createContext({console: receiver, Reflect: reflected});
            const sentinel = runInContext('new Error("publisher raw fault")', context) as Error;
            const late = () => { throw new Error("late replacement selected"); };
            const mutate = (method: string) => { reflected.apply = late; Object.defineProperty(receiver, method, {value: late, configurable: true}); trace.push(["mutate", method]); };
            for (const method of ["error", "warn"]) Object.defineProperty(receiver, method, {configurable: true, get() {
                trace.push(["select", method]);
                return function(this: unknown, message: string) { trace.push(["publish", method, message, this === receiver]); if (mode === "stdout-publisher-fault" && method === "error" || mode === "warn-publisher-fault" && method === "warn") throw sentinel; };
            }});
            let reads = 0;
            const rawError = runInContext('new Error()', context) as Error;
            Object.defineProperty(rawError, "message", {get() { trace.push("message"); mutate("warn"); return "original raw message"; }});
            const observed = {status: 0, get stdout() { trace.push("stdout"); if (++reads === 2) mutate("error"); return reads === 1 ? " first " : " second "; }};
            const spawn = (command: unknown, args: unknown, options: unknown) => {
                trace.push("spawn");
                const settings = options as {timeout?: number; input?: unknown};
                if (command !== "private-vm" || !Array.isArray(args) || args[8] !== "final-id" || settings.timeout !== 135000 || typeof settings.input !== "string") { denied.push("spawn"); throw new Error("unadmitted transport"); }
                if (mode.startsWith("warn")) throw rawError;
                return observed;
            };
            const native: Record<string, object> = {
                "child_process": {spawnSync: spawn},
                [resolve(fileURLToPath(new URL("../../container-runtime.js", import.meta.url)))]: {runtimeCli: () => { trace.push("runtime"); return "private-vm"; }},
                [resolve(fileURLToPath(new URL("../../codex-config-lock.js", import.meta.url)))]: {withCodexConfigLock: (operation: () => unknown) => { trace.push("lock"); return operation(); }},
                [resolve(fileURLToPath(new URL("../../docker.js", import.meta.url)))]: {prepareCodexConfigForContainer: () => { trace.push("prepare"); }, restoreCodexConfigHostOwnership: () => { trace.push("restore"); }},
            };
            const root = fileURLToPath(new URL("../../", import.meta.url));
            const allowed = new Set(["codex-harness", "domain/codex-harness", "ports/codex-harness", "application/codex-harness", "adapters/codex-harness", "domain/codex-harness-bootstrap", "ports/codex-harness-bootstrap", "application/codex-harness-bootstrap", "adapters/codex-harness-bootstrap"].map(path => resolve(root, path + ".js")));
            const cache = new Map<string, Record<string, unknown>>();
            const load = (path: string): Record<string, unknown> => {
                if (!allowed.has(path)) { denied.push(path); throw new Error("unadmitted source module"); }
                if (cache.has(path)) return cache.get(path)!;
                const exports: Record<string, unknown> = {}; cache.set(path, exports);
                const requireFixture = (specifier: string) => {
                    if (specifier in native) return native[specifier];
                    const dependency = resolve(dirname(path), specifier);
                    if (dependency in native) return native[dependency];
                    if (!specifier.startsWith(".")) { denied.push(specifier); throw new Error("unadmitted native dependency"); }
                    return load(dependency);
                };
                const source = candidate || path !== resolve(root, "codex-harness.js") ? readFileSync(path.replace(/\.js$/, ".ts"), "utf8") : original;
                const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
                const execute = runInContext("(function(require,exports){\n" + compiled + "\n})", context) as (require: (specifier: string) => unknown, exports: Record<string, unknown>) => void;
                execute(requireFixture, exports);
                return exports;
            };
            let escaped: unknown;
            try { const facade = load(resolve(root, "codex-harness.js")); (facade.ensureCodexHarness as (container: string, profile?: string) => void)("final-id", "work"); }
            catch (error) { escaped = error === sentinel ? "raw-publisher-fault" : error instanceof Error ? error.message : String(error); }
            expect(denied).toEqual([]);
            return {trace, escaped};
        };
        expect(capture(true)).toEqual(capture(false));
    });
    it.each([undefined, "work"])("executes the generated entire program under the selected lock: %s", profile => {
        ensureCodexHarness("final-id", profile);
        expect(withCodexConfigLock).toHaveBeenCalledWith(expect.any(Function), profile);
        expect(prepareCodexConfigForContainer).toHaveBeenCalledWith("final-id", profile);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledWith("final-id", profile);
        expect(runtimeCli).toHaveBeenCalledOnce();
        expect(spawnSync).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["exec", "-i", "--workdir", "/home/ccc", "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0", "final-id", "python3", "-"], {input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000});
        expect(CODEX_HARNESS_BOOTSTRAP).toContain("run_bootstrap(NativeBootstrapPorts())");
        expect(vi.mocked(prepareCodexConfigForContainer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]);
        expect(vi.mocked(spawnSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(restoreCodexConfigHostOwnership).mock.invocationCallOrder[0]);
    });
    it("captures the console receiver and callee before the second stdout getter", () => {
        const receiver = console;
        const output = vi.spyOn(receiver, "error").mockImplementation(function(this: unknown, message) { expect(this).toBe(receiver); expect(message).toBe("second"); });
        let count = 0;
        vi.mocked(spawnSync).mockReturnValue({status: 0, get stdout() { if (++count === 2) receiver.error = () => { throw new Error("late replacement selected"); }; return count === 1 ? " first " : " second "; }} as ReturnType<typeof spawnSync>);
        ensureCodexHarness("final-id");
        expect(count).toBe(2);
        expect(output).toHaveBeenCalledOnce();
    });
    it("selects the warning callee before reading a raw thrown Error message", () => {
        const receiver = console;
        const warning = vi.spyOn(receiver, "warn").mockImplementation(function(this: unknown) { expect(this).toBe(receiver); });
        const error = new Error();
        Object.defineProperty(error, "message", {get() { receiver.warn = () => { throw new Error("late warning"); }; return "raw"; }});
        vi.mocked(spawnSync).mockImplementationOnce(() => { throw error; });
        expect(() => ensureCodexHarness("final-id")).not.toThrow();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("unavailable: raw. Codex will continue"));
    });
    it("native publisher construction does not select console methods", () => {
        const ports = createNativeCodexHarnessPorts();
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        ports.publishUnavailable("selected now");
        expect(warning).toHaveBeenCalledExactlyOnceWith("selected now");
    });
    it("does not suppress an exception from warning publication", () => {
        const sentinel = new Error("warning fault");
        vi.mocked(spawnSync).mockImplementationOnce(() => { throw new Error("transport"); });
        vi.spyOn(console, "warn").mockImplementation(() => { throw sentinel; });
        expect(() => ensureCodexHarness("final-id")).toThrow(sentinel);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledOnce();
    });
});
