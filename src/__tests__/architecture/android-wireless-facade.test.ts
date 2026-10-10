import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as vm from "node:vm";
import ts from "typescript";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");

type Mode = { missing?: boolean; status?: number; listStatus?: number; commandError?: Error; publisherError?: Error;
    result?: Record<string, unknown>; timeout?: unknown; publisherThenable?: unknown; publisherChange?: () => void };
function realm(mode: Mode = {}) {
    const trace: unknown[][] = [];
    let denied = 0;
    const deny = (name: string): never => { denied++; trace.push(["DENIED", name]); throw new Error("DENIED " + name); };
    const none = new Proxy({}, { get(_target, name) { return (..._args: unknown[]) => deny(String(name)); } });
    const responses = {
        jsonResult(value: unknown) { trace.push(["json"]); if (mode.publisherError) throw mode.publisherError; return mode.publisherThenable ?? {kind: "json", value}; },
        textResult(ok: unknown, value: unknown) { trace.push(["text"]); if (mode.publisherError) throw mode.publisherError; return {kind: "text", ok, text: value}; },
        fail: (..._args: unknown[]) => deny("fail"),
    };
    const commands = {
        run(adb: string, args: unknown[]) {
            trace.push(["run", adb, args]); return {status: mode.listStatus ?? 0, stdout: "List of devices attached\nUSB device model:X\n192.0.2.1:5555 device\n", stderr: "list stderr"};
        },
        runWithTimeout(adb: string, args: unknown[], timeout: unknown) {
            trace.push(["runWithTimeout", adb, args, timeout]);
            if (mode.commandError) throw mode.commandError;
            return mode.result ?? {status: mode.status ?? 0, stdout: "654321 raw stdout", stderr: "654321 raw stderr"};
        },
    };
    const discovery = () => { trace.push(["discovery"]); return {adb: mode.missing ? null : "private-fake-adb"}; };
    const context = vm.createContext({
        process: new Proxy({}, {get: (_t, n) => deny("process." + String(n))}),
        console: none, fetch: () => deny("fetch"), setTimeout: () => deny("timer"), setInterval: () => deny("timer"),
    });
    const modules = new Map<string, {exports: Record<string, any>}>();
    const load = (file: string, body?: string): Record<string, any> => {
        const cached = modules.get(file); if (cached) return cached.exports;
        const module = {exports: {}}; modules.set(file, module);
        const source = body ?? fs.readFileSync(file, "utf8");
        const compiled = ts.transpileModule(source, {fileName: file + ".cts",
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
        const requireModule = (name: string) => {
            if (name === "../commands.mjs") return commands;
            if (name === "./android.mjs") return {androidDiscovery: discovery, appiumDiscovery: (..._args: unknown[]) => deny("appium")};
            if (name === "../responses.mjs") return responses;
            if (name === "../state/device-operation-policy.mjs") return load(path.resolve(path.dirname(file),name));
            if (name.startsWith("../application/") || name.startsWith("../domain/") || name.startsWith("../ports/") || name.startsWith("./") && /android-wireless/.test(name)) {
                const resolved = path.resolve(path.dirname(file), name);
                if (!resolved.startsWith(path.join(root, "packages/device-lab/providers") + path.sep)) return deny("core escape");
                return load(resolved);
            }
            return none;
        };
        vm.runInContext("(function(require,module,exports){" + compiled + "\n})", context, {filename:file})(requireModule, module, module.exports);
        return module.exports;
    };
    const native = load(path.join(root, "packages/device-lab/providers/backends/android-device.mjs"), undefined);
    expect(denied).toBe(0);
    return {native, trace, context, get denied() {return denied;}, assertZero: () => expect(denied).toBe(0), deny};
}

describe("Android wireless current public facade behavior", () => {
    it("preserves exported async settlement to undefined for another backend without native effects", async () => {
        {
            const actor = realm();
            const promise = actor.native.handleAndroidRealTool("device_wireless", { backend: "other" });
            expect(Object.prototype.toString.call(promise)).toBe("[object Promise]");
            expect(await promise).toBeUndefined();
            actor.assertZero(); expect(actor.trace).toEqual([]);
        }
    });
    it("executes pairing and redacts the pairing code", async () => {
        const actor = realm();
        const response = await actor.native.handleAndroidRealTool("device_wireless", {action:"pair",pairHost:"host",pairPort:4321,pairingCode:"654321"});
        actor.assertZero(); expect(response.value.ok).toBe(true);
        expect(response.value.pair.args).toEqual(["pair","host:4321","[redacted]"]);
        expect(actor.trace.filter(row=>row[0]==="runWithTimeout")).toHaveLength(1);
    });
    it("publishes status top-level success despite unavailable inventory", async () => {
        {
            const actor=realm({listStatus:17});
            const response=await actor.native.handleAndroidRealTool("device_wireless",{});
            actor.assertZero(); expect(response.value.ok).toBe(true);
            expect(response.value.hostDevices).toEqual({available:false,missing:[],devices:[],error:"list stderr"});
        }
    });
    it("counts fenced failures before throw and keeps negatives separate from positive assertions", () => {
        const actor=realm();
        expect(()=>actor.deny("unknown native")).toThrow("DENIED unknown native"); expect(actor.denied).toBe(1);
    });
});
