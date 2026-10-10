import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Mode = { root?: "missing" | "linked" | "file" | "replaced" | "child-link" | "read-error"; records?: "empty" | "malformed" | "read-error" | "getter" | "foreign-enumeration";
    executableError?: boolean; noTools?: boolean; logGetError?: boolean; logCallError?: boolean; changeConsole?: boolean; wiringMissing?: boolean };
function realm(emitted: boolean, mode: Mode = {}) {
    const trace: unknown[][] = [], output: string[] = [], errors: string[] = [];
    let denied = 0, rootReads = 0;
    const deny = (site: string): never => { denied++; trace.push(["DENIED", site]); throw new Error("DENIED " + site); };
    // Same capability membrane as the admitted complete-main consumer: native
    // callbacks/arguments/results/errors cross both directions with identity,
    // and host constructor/prototype authority is denied before it is exposed.
    const incoming = new WeakMap<object, any>(), outgoing = new WeakMap<object, any>(), incomingOriginal = new WeakMap<object, any>(), outgoingOriginal = new WeakMap<object, any>();
    const translate = (value: any, into: boolean): any => {
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
        const reverse = into ? outgoingOriginal : incomingOriginal; if (reverse.has(value)) return reverse.get(value);
        const cache = into ? incoming : outgoing; if (cache.has(value)) return cache.get(value);
        const convert = (v: any) => translate(v, into), opposite = (v: any) => translate(v, !into);
        const protectedName = (key: PropertyKey) => ["constructor", "prototype", "__proto__", "caller", "callee", "arguments"].includes(String(key));
        const reject = (site: string): never => { try { return deny(site); } catch (error) { throw convert(error); } };
        const check = (key: PropertyKey) => { if (into && protectedName(key)) reject("host prototype " + String(key)); };
        const target = typeof value === "function" ? (function() {}).bind(null) : Array.isArray(value) ? [] : Object.create(null);
        const perform = (operation: () => any) => { try { return convert(operation()); } catch (error) { throw convert(error); } };
        const view = new Proxy(target, {
            get(_target, key) { check(key); return perform(() => Reflect.get(value, key, value)); },
            set(_target, key, next) { check(key); return perform(() => Reflect.set(value, key, opposite(next), value)); },
            has(_target, key) { check(key); return perform(() => Reflect.has(value, key)); },
            ownKeys() { return Reflect.ownKeys(value).filter(key => !into || !protectedName(key)); },
            getOwnPropertyDescriptor(_target, key) { check(key); const d = Reflect.getOwnPropertyDescriptor(value, key); if (!d) return undefined;
                const own = Reflect.getOwnPropertyDescriptor(target, key); const base = { enumerable: d.enumerable, configurable: own?.configurable === false ? false : true };
                return "value" in d ? { ...base, writable: d.writable, value: convert(d.value) } : { ...base, get: convert(d.get), set: convert(d.set) }; },
            defineProperty(_target, key, descriptor) { check(key); const d = { ...descriptor }; if ("value" in d) d.value = opposite(d.value);
                if ("get" in d) d.get = opposite(d.get); if ("set" in d) d.set = opposite(d.set); return Reflect.defineProperty(value, key, d); },
            deleteProperty(_target, key) { check(key); return perform(() => Reflect.deleteProperty(value, key)); },
            getPrototypeOf() { if (into) return reject("host prototype traversal"); return perform(() => Reflect.getPrototypeOf(value)); },
            setPrototypeOf() { return reject("prototype mutation"); }, preventExtensions() { return reject("capability sealing"); },
            apply(_target, receiver, args) { return perform(() => Reflect.apply(value, opposite(receiver), args.map(opposite))); },
            construct(_target, args) { return perform(() => Reflect.construct(value, args.map(opposite))); },
        });
        cache.set(value, view); (into ? incomingOriginal : outgoingOriginal).set(view, value); return view;
    };
    const into = (v: any) => translate(v, true), out = (v: any) => translate(v, false);
    const home = "/allocated-admin-home", ownersRoot = home + "/.ccc/devices/owners";
    const envValues = { container: undefined, ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined, LOCALAPPDATA: undefined, APPDATA: undefined };
    const env = new Proxy(envValues, { get: (t, k) => Object.hasOwn(t, k) ? Reflect.get(t, k) : deny("env " + String(k)), set: () => deny("env mutation") });
    const processData = { env, platform: "linux", cwd() { trace.push(["cwd"]); return "/allocated-project"; } };
    const proc = new Proxy(processData, { get: (t, k) => Object.hasOwn(t, k) ? Reflect.get(t, k) : deny("process " + String(k)), set: () => deny("process mutation") });
    let context: vm.Context;
    const consoleCarrier = {
        get log() { trace.push(["select-log"]); if (mode.logGetError) throw raw;
            if (mode.changeConsole) { const replacement = { log: () => deny("replacement publisher"), error: () => deny("replacement error") }; Reflect.set(globals, "console", replacement); context.console = into(replacement); }
            return function(this: unknown, text: string) { expect(this).toBe(consoleCarrier); trace.push(["log"]); if (mode.logCallError) throw raw; output.push(text); }; },
        get error() { trace.push(["select-error"]); return function(this: unknown, text: string) { expect(this).toBe(consoleCarrier); trace.push(["error"]); errors.push(text); }; },
        warn: () => deny("console warning"),
    };
    const globals = { process: proc, console: consoleCarrier, fetch: () => deny("network"), setTimeout: () => deny("timer"), setInterval: () => deny("interval") };
    context = vm.createContext(Object.fromEntries(Object.entries(globals).map(([key, value]) => [key, into(value)])), { codeGeneration: { strings: false, wasm: false } });
    context.globalThis = into(new Proxy(globals, { get: (t, k) => Object.hasOwn(t, k) ? Reflect.get(t, k) : deny("global " + String(k)), set: () => deny("global mutation") }));
    const raw = out(vm.runInContext('new Error("raw-admin-observation")', context));
    if (mode.records === "foreign-enumeration") { raw.name = "DeviceLabProjectEnumerationError"; raw.code = "project-namespace-read-failed"; }
    const missing = out(vm.runInContext('Object.assign(new Error("missing"),{code:"ENOENT"})', context));
    const tools = ["adb", "emulator", "avdmanager", "xcrun", "wsb", "powershell.exe", "tart", "vz", "utmctl", "ssh", "scp"];
    const sdk = [path.join(home, "AppData/Local/Android/Sdk"), path.join(home, "Android/Sdk"), path.join(home, "Library/Android/sdk"), "/opt/android-sdk", "/usr/local/android-sdk"];
    const sdkFiles = new Set(sdk.flatMap(base => [path.join(base, "platform-tools/adb"), path.join(base, "emulator/emulator"),
        ...["cmdline-tools/latest/bin", "cmdline-tools/bin", "tools/bin"].map(dir => path.join(base, dir, "avdmanager"))]));
    const nativeFs = {
        existsSync(file: string) { if (file === home + "/.ccc/devices") { trace.push(["state-exists"]); return !mode.wiringMissing; }
            if (sdkFiles.has(file)) { trace.push(["sdk-exists", file]); return false; } return deny("exists " + file); },
        lstatSync(file: string) { if (file !== ownersRoot) return deny("lstat " + file); trace.push(["root-stat"]); rootReads++;
            if (mode.root === "missing") throw missing; if (mode.root === "read-error") throw raw;
            return { dev: 1, ino: mode.root === "replaced" && rootReads > 1 ? 2 : 1, mode: 0o40700,
                isDirectory: () => mode.root !== "file", isSymbolicLink: () => mode.root === "linked" }; },
        readdirSync(file: string, options: unknown) {
            if (sdk.some(base => file === path.join(base, "cmdline-tools"))) { trace.push(["sdk-list", file]); return []; }
            if (file !== ownersRoot) return deny("readdir " + file); expect(JSON.parse(JSON.stringify(options))).toEqual({ withFileTypes: true }); trace.push(["root-list"]);
            return ["z-owner", "a-owner"].map(name => ({ name, isDirectory: () => true, isSymbolicLink: () => mode.root === "child-link" && name === "z-owner" }));
        },
        unlinkSync: () => deny("filesystem mutation"), mkdirSync: () => deny("filesystem mutation"), realpathSync: () => deny("unselected realpath"),
    };
    const record = { id: "z", name: "raw name", status: "running", platform: "linux" };
    if (mode.records === "getter") Object.defineProperty(record, "name", { get() { trace.push(["record-name"]); throw raw; } });
    const nativeRecordRead = function(this: unknown, file: string) {
        expect(this).toBeUndefined(); if (!file.startsWith(ownersRoot + "/")) return deny("record " + file);
        const [owner, state, name] = file.slice(ownersRoot.length + 1).split("/");
        if (!["current", "current-work", "a-owner", "z-owner"].includes(owner) || name !== "devices.json") return deny("record namespace");
        trace.push(["read", owner, state]); if (mode.records === "read-error" || mode.records === "malformed" || mode.records === "foreign-enumeration") throw raw;
        return mode.records === "empty" || state !== "android" ? [] : [record, { id: "a" }];
    };
    const modules = new Map<string, any>();
    const closed = new Proxy({}, { get: (_t, key) => (..._args: unknown[]) => deny("unselected native " + String(key)) });
    const builtins: Record<string, unknown> = {
        fs: new Proxy(nativeFs, { get: (t, k) => Object.hasOwn(t, k) ? Reflect.get(t, k) : deny("fs " + String(k)) }),
        path, url: { fileURLToPath }, util: { isDeepStrictEqual: () => deny("unselected deep compare") },
        crypto: { createHash },
        os: new Proxy({ homedir() { trace.push(["homedir"]); return home; } }, { get: (t, k) => Object.hasOwn(t, k) ? Reflect.get(t, k) : deny("os " + String(k)) }),
        child_process: { spawnSync(command: string, args: string[], options: any) {
            if (command !== "/bin/sh" || args.length !== 2 || args[0] !== "-c" || !args[1].startsWith("command -v ")) return deny("process command");
            const tool = args[1].slice("command -v ".length); if (!tools.includes(tool)) return deny("process executable"); trace.push(["probe", tool]);
            expect(options.encoding).toBe("utf-8"); expect(options.windowsHide).toBe(true); expect(options.env).toBe(env);
            if (mode.executableError) throw raw;
            return { status: 0, stdout: !mode.noTools && ["adb", "vz", "ssh", "scp"].includes(tool) ? "/allocated-bin/" + tool + "\n" : "" };
        } },
    };
    const cleanupFile = emitted ? "dist/device-lab-cleanup.js" : "src/device-lab-cleanup.ts";
    const projectFile = emitted ? "dist/packages/device-lab/dist/device-lab-project-state.js" : "packages/device-lab/src/device-lab-project-state.ts";
    const adminFile = emitted ? "dist/device-lab-admin.js" : "src/device-lab-admin.ts";
    const source = (file: string): string => {
        const actual = path.join(root, file); expect(fs.existsSync(actual), "mandatory real source/genuine emission " + file).toBe(true);
        const metadata = fs.lstatSync(actual);
        expect(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, "ordinary unaliased current module").toBe(true);
        expect(fs.realpathSync(actual), "no checkout/dependency alias fallback").toBe(actual);
        const value = fs.readFileSync(actual, "utf8");
        return value;
    };
    const load = (file: string): any => {
        if (modules.has(file)) return modules.get(file);
        const exports = {}; modules.set(file, exports);
        const text = source(file).replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(path.join(root, file)).href));
        const compiled = ts.transpileModule(text, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        const requireModule = (specifier: string): unknown => {
            const native = specifier.replace(/^node:/, "");
            if (Object.hasOwn(builtins, native)) return builtins[native];
            if (specifier.endsWith("device-lab-project-state.js")) return load(projectFile);
            if (specifier === "./device-lab-cleanup.js") return load(cleanupFile);
            if (specifier.endsWith("device-lab-owner.js")) return {
                deviceLabOwnerId: function(this: unknown, cwd: string, profile?: string) { expect(this).toBeUndefined(); trace.push(["owner", cwd, profile]); return profile === "work" ? "current-work" : "current"; },
                deviceLabOwnerBasis: function(this: unknown, cwd: string, profile?: string) { expect(this).toBeUndefined(); trace.push(["basis", cwd, profile]); return "raw-basis"; },
            };
            if (specifier.endsWith("device-lab-owner-state.js")) return { readOwnerDeviceStateFile: nativeRecordRead };
            if (specifier.startsWith(".") && /device-admin-inventory\.js$/.test(specifier)) {
                const selected = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, emitted ? ".js" : ".ts");
                if (!/^(src|dist)\/(application|domain|ports)\/device-admin-inventory\.(ts|js)$/.test(selected)) return deny("inward import escape");
                return load(selected);
            }
            return closed;
        };
        vm.runInContext("(function(require,module,exports){" + compiled.replace(/^#![^\r\n]*/, "") + "\n})", context, { filename: file })(into(requireModule), into({ exports }), into(exports));
        return exports;
    };
    const native = load(adminFile), cleanup = load(cleanupFile), project = load(projectFile);
    {
        const base = emitted ? "dist" : "src";
        for (const layer of ["application", "domain"]) expect(modules.has(base + "/" + layer + "/device-admin-inventory." + (emitted ? "js" : "ts")), "actual current inward runtime module").toBe(true);
        expect(fs.existsSync(path.join(root, base, "ports/device-admin-inventory." + (emitted ? "d.ts" : "ts"))), "mandatory real current ports").toBe(true);
    }
    expect(denied, "caught initialization attempts").toBe(0); expect(trace, "unexpected native initialization").toEqual([]);
    const assertZero = () => expect(denied, "including caught native attempts").toBe(0);
    return { native, cleanup, project, trace, output, errors, raw, context, nativeFs,
        denied: () => denied, assertZero,
        negative() {
            for (const probe of [
                () => { try { nativeFs.lstatSync("/unallocated-root"); } catch {} },
                () => vm.runInContext('try{process.env.UNALLOCATED_SECRET}catch{}', context),
                () => vm.runInContext('try{process.kill(123)}catch{}', context),
                () => vm.runInContext('try{fetch("https://unallocated.invalid")}catch{}', context),
                () => vm.runInContext('try{console.log.constructor("return process")()}catch{}', context),
            ]) { const before = denied; probe(); expect(denied).toBe(before + 1); }
        },
    };
}
describe("Admin current public inventory and native namespace guards", () => {
    it.each([false, true])("keeps whole source/genuine emitted=%s public namespace, defaults and canonical reexport identity", emitted => {
        const actor = realm(emitted); {
            for (const name of ["DEVICE_BACKENDS", "deviceLabOwnerIdentity", "deviceLabOwnerId", "cleanupOwnerDevices"]) expect(actor.native[name]).toBe(actor.cleanup[name]);
            expect(actor.native.DeviceLabProjectEnumerationError).toBe(actor.project.DeviceLabProjectEnumerationError);
            const snapshot = actor.native.deviceLabSnapshot(); expect(snapshot.ownerId).toBe("current"); actor.assertZero();
            expect(actor.trace[0]).toEqual(["cwd"]);
        }
    });
    it.each([false, true])("executes current source/emitted=%s CLI inventory", async emitted => {
        for (const args of [[], ["status"], ["list"], ["list", "--all-projects"], ["list", "--all"], ["list", "--all-projects", "extra"]]) {
            const b = realm(emitted);
            expect(await b.native.devicesCliAsync(args, "/allocated-project", "work")).toBe(args[0] === "list" && (args[1] === "--all" || args.length > 2) ? 1 : 0);
            b.assertZero();
            if (args[0] !== "list" || args.length <= 2 && args[1] !== "--all") expect(b.trace[0]).toEqual(["select-log"]);
        }
    });
    it.each(["missing", "linked", "file", "replaced", "child-link", "read-error"] as const)("retains genuine native root refusal/classification for %s", rootMode => {
        for (const emitted of [false, true]) {
            const b = realm(emitted, { root: rootMode });
            const actor = b; {
                const result = actor.native.devicesCli(["list", "--all-projects"]);
                actor.assertZero();
                expect(result).toBe(rootMode === "missing" ? 0 : 1);
                if (rootMode !== "missing") expect(actor.errors).toEqual(["CCC device project enumeration failed: project-namespace-read-failed"]);
                expect(actor.trace.some(row => row[0] === "read" || row[0] === "probe")).toBe(false);
            }
        }
    });
    it.each(["malformed", "read-error", "getter", "foreign-enumeration"] as const)("preserves raw record %s faults instead of reclassifying them as enumeration", records => {
        for (const emitted of [false, true]) {
            const actor = realm(emitted, { records });
            let error: unknown; try { actor.native.devicesCli(["list"]); } catch (cause) { error = cause; }
            actor.assertZero(); expect(error).toBe(actor.raw); expect(actor.errors).toEqual([]);
        }
    });
    it("counts caught filesystem/process/network/global and host-prototype attempts before denial", () => {
        const actor = realm(false); actor.assertZero(); actor.negative(); expect(actor.denied()).toBe(5);
    });
});

