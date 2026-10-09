import { expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as url from "node:url";
import * as vm from "node:vm";
import ts from "typescript";

export const nativeCleanupRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
export const nativeCleanupAdmission = path.join(nativeCleanupRoot, "doc/harness/tasks/TASK__session-startup-native-cleanup/admission");
export const originalPayload = path.join(nativeCleanupAdmission, "baseline/original-payload");
export const project = "/project/native-cleanup-0123456789ab";
export type NativeDevice = Record<string, unknown> & { id?: string; status?: string };
type CleanupApi = {
    DEVICE_BACKENDS: ReadonlyArray<{ stateKey: string; name: string }>;
    deviceLabOwnerId(cwd?: string, profile?: string): string;
    deviceLabOwnerIdentity(cwd?: string, profile?: string): { ownerId: string; basis: string };
    cleanupOwnerDevices(cwd?: string, timeoutMs?: number, profile?: string): {
        ownerId: string; results: Array<{ id: string; status: string; reason?: string; commands: unknown[] }>;
    };
};

/** Test-controller reads are separate from the fenced native realm. Every native
 * dependency body is real; only builtins/native authority are controlled. */
export function createNativeCleanupRealm(original: boolean) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-cleanup-pair-"));
    const trace: unknown[][] = [];
    const modules = new Map<string, { exports: Record<string, any> }>();
    const loaded: string[] = [];
    const descriptors = new Set<number>();
    const knownPids = new Set([999001, 999002, 999003]);
    let denied = 0, clock = 0, stopped = false;
    const state = {
        commandStatus: 0, stopStatus: 0, stopSignal: null as string | null,
        stopError: undefined as Error | undefined, afterCommand: undefined as (() => void) | undefined,
        beforeOperationOpen: undefined as (() => void) | undefined,
        unlinkError: undefined as Error | undefined, identityUnavailable: false,
        identityMismatch: false, signalFailure: false,
    };
    const normalize = (value: unknown): unknown => {
        if (typeof value === "string") return value.split(home).join("$HOME");
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === "object") {
            if (value instanceof Error || ("name" in value && "message" in value)) return { name: (value as Error).name, message: normalize((value as Error).message), code: (value as NodeJS.ErrnoException).code };
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
        }
        return value;
    };
    const record = (name: string, ...args: unknown[]) => trace.push([name, ...args.map(normalize)]);
    const deny = (name: string): never => { denied++; record("DENIED", name); throw new Error(`DENIED ${name}`); };
    const owned = (value: unknown) => typeof value === "string" && (path.resolve(value) === home || path.resolve(value).startsWith(home + path.sep));
    const check = (value: unknown) => {
        if (typeof value === "number") { if (!descriptors.has(value)) deny(`fd:${value}`); }
        else {
            if (typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value)) {
                // Authorize the exact spelling forwarded to the OS. Resolving
                // link/../x first would hide traversal through the link itself.
                deny(`noncanonical path:${String(value)}`);
            }
            if (!owned(value)) deny(`path:${String(value)}`);
        }
    };
    const guardOrdinaryPath = (value: unknown, leafMayBeAbsent = false, inspectLeafLink = false) => {
        check(value);
        if (typeof value !== "string") return;
        const root = fs.lstatSync(home);
        if (!root.isDirectory() || root.isSymbolicLink()) return deny("invalid fixture root");
        const relative = path.relative(home, path.resolve(value));
        const segments = relative.split(path.sep).filter(Boolean);
        let current = home;
        for (const [index, segment] of segments.entries()) {
            if (!segment) continue;
            current = path.join(current, segment);
            try {
                const stat = fs.lstatSync(current);
                const leaf = index === segments.length - 1;
                if (stat.isSymbolicLink()) {
                    if (leaf && inspectLeafLink) return;
                    return deny("symlink traversal");
                }
                if (!leaf && !stat.isDirectory()) return deny("non-directory ancestor");
                if (leaf && stat.isFile() && stat.nlink !== 1) return deny("non-exclusive leaf");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT" && leafMayBeAbsent) return;
                throw error;
            }
        }
    };
    const processText = (file: unknown): string | Buffer | undefined => {
        if (typeof file !== "string") return undefined;
        if (file === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
        const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(file);
        if (!match || !knownPids.has(Number(match[1]))) return undefined;
        if (state.identityUnavailable) throw Object.assign(new Error("fixture unreadable"), { code: "EACCES" });
        if (stopped && Number(match[1]) !== 999001) throw Object.assign(new Error("fixture exited"), { code: "ENOENT" });
        if (match[2] === "cmdline") return Buffer.from("fixture-runtime\0");
        const fields = Array.from({ length: 24 }, () => "0");
        fields[19] = state.identityMismatch ? "987" : "123";
        return `${match[1]} (fixture-runtime) ${fields.join(" ")}`;
    };
    const fencedFs: Record<string, any> = Object.fromEntries(Object.keys(fs).map(name => [name, function (..._args: unknown[]) { return deny(`fs.${name}`); }]));
    fencedFs.constants = fs.constants;
    fencedFs.promises = new Proxy({}, { get: (_target, name) => (..._args: unknown[]) => deny(`fs.promises.${String(name)}`) });
    for (const name of ["existsSync", "lstatSync", "statSync", "realpathSync", "readdirSync", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync", "readlinkSync", "chmodSync", "writeFileSync", "appendFileSync"] as const) {
        fencedFs[name] = (...args: any[]) => {
            // Every pathname checks each ordinary ancestor. Only metadata/link
            // inspection may observe a symlink leaf without following it.
            guardOrdinaryPath(args[0], true, name === "lstatSync" || name === "readlinkSync");
            record(`fs.${name}`, typeof args[0] === "number" ? "$FD" : args[0], ...(name === "writeFileSync" ? [args[1]] : []));
            if (name === "unlinkSync" && state.unlinkError && String(args[0]).includes("physical-leases") && String(args[0]).endsWith(".json")) throw state.unlinkError;
            return (fs[name] as (...args: any[]) => unknown)(...args);
        };
    }
    fencedFs.realpathSync.native = fencedFs.realpathSync;
    fencedFs.readFileSync = (file: unknown, ...args: any[]) => {
        const text = processText(file);
        if (text !== undefined) { record("proc.read", file); return args[0] ? String(text) : Buffer.from(text); }
        guardOrdinaryPath(file); record("fs.readFileSync", file);
        return (fs.readFileSync as (...args: any[]) => unknown)(file, ...args);
    };
    fencedFs.openSync = (...args: any[]) => {
        guardOrdinaryPath(args[0], true); record("fs.openSync", args[0], args[1]);
        if (state.beforeOperationOpen && String(args[0]).includes("/operations/")) {
            const mutation = state.beforeOperationOpen; state.beforeOperationOpen = undefined; mutation();
        }
        const fd = (fs.openSync as (...args: any[]) => number)(...args); descriptors.add(fd); return fd;
    };
    for (const name of ["readSync", "writeSync", "fstatSync", "ftruncateSync", "fsyncSync", "fchmodSync", "closeSync"] as const) {
        fencedFs[name] = (...args: any[]) => {
            check(args[0]);
            const result = (fs[name] as (...args: any[]) => unknown)(...args);
            if (name === "closeSync") descriptors.delete(args[0]);
            return result;
        };
    }
    for (const name of ["renameSync", "linkSync", "symlinkSync", "copyFileSync"] as const) {
        fencedFs[name] = (...args: any[]) => {
            check(args[0]); check(args[1]);
            if (name === "symlinkSync" || name === "copyFileSync") return deny(`unallocated fs.${name}`);
            guardOrdinaryPath(args[0]); guardOrdinaryPath(args[1], true);
            record(`fs.${name}`, args[0], args[1]); return (fs[name] as (...args: any[]) => unknown)(...args);
        };
    }
    const rawStop = {
        get error() { record("stop.error"); return state.stopError; },
        get signal() { record("stop.signal"); return state.stopSignal; },
        get status() { record("stop.status"); return state.stopStatus; },
    };
    // Admit literals from the controller and this owned VM realm, not arbitrary
    // objects with an Object-looking constructor or a foreign/custom prototype.
    const objectPrototypes = new Set<object>();
    const arrayPrototypes = new Set<object>();
    const prototypeSnapshots = new Map<object, {
        parent: object | null; keys: PropertyKey[]; descriptors: Map<PropertyKey, PropertyDescriptor>;
    }>();
    const registerPrototype = (prototype: object, admitted: Set<object>) => {
        admitted.add(prototype);
        let current: object | null = prototype;
        while (current !== null && !prototypeSnapshots.has(current)) {
            const parent: object | null = Object.getPrototypeOf(current);
            const keys = Reflect.ownKeys(current);
            const descriptors = new Map<PropertyKey, PropertyDescriptor>();
            for (const key of keys) {
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor) return deny("prototype registration changed");
                descriptors.set(key, descriptor);
            }
            prototypeSnapshots.set(current, { parent, keys, descriptors });
            current = parent;
        }
    };
    const prototypeChainUnchanged = (prototype: object): boolean => {
        let current: object | null = prototype;
        while (current !== null) {
            const snapshot = prototypeSnapshots.get(current);
            if (!snapshot || util.types.isProxy(current) || Object.getPrototypeOf(current) !== snapshot.parent) return false;
            const keys = Reflect.ownKeys(current);
            if (keys.length !== snapshot.keys.length || keys.some((key, index) => key !== snapshot.keys[index])) return false;
            for (const key of keys) {
                const before = snapshot.descriptors.get(key);
                const after = Object.getOwnPropertyDescriptor(current, key);
                if (!before || !after) return false;
                for (const field of ["value", "get", "set", "writable", "enumerable", "configurable"] as const) {
                    if (Object.hasOwn(before, field) !== Object.hasOwn(after, field) || !Object.is(before[field], after[field])) return false;
                }
            }
            current = snapshot.parent;
        }
        return true;
    };
    registerPrototype(Object.prototype, objectPrototypes);
    registerPrototype(Array.prototype, arrayPrototypes);
    const literalData = (descriptor: PropertyDescriptor | undefined) => descriptor !== undefined
        && Object.hasOwn(descriptor, "value") && descriptor.enumerable === true
        && descriptor.writable === true && descriptor.configurable === true;
    const dockerLiteralOptions = (options: unknown): boolean => {
        if (!options || typeof options !== "object" || util.types.isProxy(options)) return false;
        const prototype = Object.getPrototypeOf(options);
        if (!objectPrototypes.has(prototype) || !prototypeChainUnchanged(prototype)) return false;
        const descriptors = Object.getOwnPropertyDescriptors(options);
        const keys = Reflect.ownKeys(descriptors);
        if (keys.length !== 2 || !keys.includes("encoding") || !keys.includes("stdio")
            || !literalData(descriptors.encoding) || !literalData(descriptors.stdio)
            || descriptors.encoding.value !== "utf-8") return false;
        const stdio: unknown = descriptors.stdio.value;
        if (!Array.isArray(stdio) || util.types.isProxy(stdio)) return false;
        const arrayPrototype = Object.getPrototypeOf(stdio);
        if (!arrayPrototypes.has(arrayPrototype) || !prototypeChainUnchanged(arrayPrototype)) return false;
        const arrayDescriptors = Object.getOwnPropertyDescriptors(stdio as object);
        const arrayKeys = Reflect.ownKeys(arrayDescriptors);
        const length = arrayDescriptors.length;
        return arrayKeys.length === 4 && ["0", "1", "2", "length"].every(key => arrayKeys.includes(key))
            && length.value === 3 && length.writable === true && length.enumerable === false && length.configurable === false
            && ["0", "1", "2"].every(key => literalData(arrayDescriptors[key]) && arrayDescriptors[key].value === "pipe");
    };
    const childProcess: Record<string, any> = Object.fromEntries(["spawn", "exec", "execSync", "execFile", "execFileSync", "fork"].map(name => [name, () => deny(`child_process.${name}`)]));
    childProcess.spawnSync = (command: string, args: string[], options: Record<string, unknown>) => {
        const deniedBefore = denied;
        try {
            // Authenticate registered chains before even argv serialization:
            // a mutated inherited toJSON accessor must not be evaluated first.
            if (command === "docker" && [...prototypeSnapshots.keys()].some(prototype => !prototypeChainUnchanged(prototype))) {
                return deny("runtime probe options");
            }
            const dockerProbe = JSON.stringify(args);
            const runtimeProbe = command === "docker" && [
                '["--version"]', '["info","--format","{{.OperatingSystem}}"]',
                '["info","--format","{{json .SecurityOptions}}"]',
            ].includes(dockerProbe);
            // Authenticate descriptors BEFORE reading or spreading options;
            // rejecting a successful/throwing accessor must never invoke it.
            if (runtimeProbe && !dockerLiteralOptions(options)) return deny("runtime probe options");
            let recordedOptions: Record<string, unknown>;
            try { recordedOptions = { ...options, env: options.env ? "same realm env" : undefined }; }
            catch { return deny("subprocess options access"); }
            record("spawnSync", command, args, recordedOptions);
            if (command === "/bin/sh" && args[0] === "-c" && /^command -v (adb|wsb|xcrun|tart|vz|utmctl)$/.test(args[1])) {
                if (options.encoding !== "utf-8" || options.env !== nativeProcess.env || options.windowsHide !== true) return deny("lookup options");
                return { status: 0, stdout: `/controlled/${args[1].slice("command -v ".length)}\n`, stderr: "" };
            }
            const approvedProvider = command === "/controlled/adb" && args[0] === "-s" && ["emulator-5554", "physical-serial"].includes(args[1])
                && (JSON.stringify(args.slice(2)) === '["emu","kill"]' || JSON.stringify(args.slice(2)) === '["shell","pkill","-2","screenrecord"]')
                || command === "/controlled/wsb" && JSON.stringify(args) === '["stop","--id","12345678-1234-1234-1234-123456789abc"]';
            if (approvedProvider) {
                if (options.encoding !== "utf-8" || options.env !== nativeProcess.env || options.timeout !== 5000 || options.windowsHide !== true || options.input !== undefined) return deny("provider options");
                state.afterCommand?.(); state.afterCommand = undefined;
                return { status: state.commandStatus, stdout: "", stderr: state.commandStatus ? "fixture provider failure" : "" };
            }
            if (command === "docker" && JSON.stringify(args) === '["stop","fixture-container"]') {
                if (options.stdio !== "ignore" || options.timeout !== 30000 || options.killSignal !== "SIGKILL") return deny("stop options");
                return rawStop;
            }
            // Exact retained src/adapters/runtime-capabilities.ts tuples above.
            if (runtimeProbe) {
                return { status: 0, stdout: dockerProbe === '["--version"]' ? "Docker version 27"
                    : args[2] === "{{.OperatingSystem}}" ? "Linux" : "[]", stderr: "" };
            }
            return deny("unexpected subprocess");
        } catch (error) {
            if (denied === deniedBefore) return deny("subprocess observation access");
            throw error;
        }
    };
    const env = { HOME: home, PATH: "/controlled", CCC_RUNTIME: "docker", VITEST: "true" };
    const nativeProcess = {
        env, platform: "linux", pid: 999001, ppid: 999000, argv: [], execPath: "/controlled/node",
        cwd: () => project, getuid: () => process.getuid?.() ?? 1000, geteuid: () => process.geteuid?.() ?? 1000,
        getgid: () => process.getgid?.() ?? 1000, getegid: () => process.getegid?.() ?? 1000,
        kill: (pid: number, signal: string | number) => {
            if (!knownPids.has(pid)) return deny("unknown process kill");
            record("process.kill", pid, signal);
            if (signal === 0) {
                if (stopped && pid !== 999001) throw Object.assign(new Error("exited"), { code: "ESRCH" });
                return true;
            }
            if (pid === 999001 || !["SIGINT", "SIGTERM"].includes(String(signal))) return deny("unallocated process signal");
            if (state.signalFailure) throw Object.assign(new Error("signal failed"), { code: "EPERM" });
            stopped = true; return true;
        },
        once: () => deny("process.once"), on: () => deny("process.on"), exit: () => deny("process.exit"),
        stdout: { write: () => deny("process.stdout") }, stderr: { write: () => deny("process.stderr") },
    };
    const fixedTime = Date.parse("2026-10-09T00:00:00Z");
    class FixtureDate extends Date {
        constructor(value?: string | number) { super(value === undefined ? fixedTime : value); }
        static now() { return fixedTime + clock++; }
    }
    const nativeCrypto = { createHash: crypto.createHash, randomBytes: (size: number) => Buffer.alloc(size, 0x11), randomUUID: () => "11111111-1111-4111-8111-111111111111" };
    const inert = new Proxy({}, { get: (_target, name) => function (..._args: unknown[]) { return deny(`unrelated native:${String(name)}`); } });
    const context = vm.createContext({ Buffer, URL, Date: FixtureDate, process: new Proxy(nativeProcess, { get: (target, name) => name in target ? Reflect.get(target, name) : deny(`process.${String(name)}`) }),
        console: { log: (text: unknown) => record("log", text), error: (text: unknown) => record("error", text) },
        SharedArrayBuffer, Int32Array, Atomics: { wait: (_a: unknown, _i: number, _v: number, ms: number) => { clock += ms; return "timed-out"; } },
        setTimeout: () => deny("setTimeout"), setInterval: () => deny("setInterval"), setImmediate: () => deny("setImmediate"), clearTimeout: () => deny("clearTimeout"), clearInterval: () => deny("clearInterval"), clearImmediate: () => deny("clearImmediate"),
        fetch: () => deny("fetch"), performance: { now: () => fixedTime + clock++ },
    });
    registerPrototype(vm.runInContext("Object.prototype", context), objectPrototypes);
    registerPrototype(vm.runInContext("Array.prototype", context), arrayPrototypes);
    const builtins: Record<string, unknown> = {
        fs: fencedFs, "fs/promises": fencedFs.promises, path, crypto: nativeCrypto, util, url,
        os: { homedir: () => home, hostname: () => "fixture-host", uptime: () => 1 },
        child_process: childProcess, readline: inert, events: { EventEmitter: class { on() { return deny("EventEmitter.on"); } } }, net: inert, http: inert, https: inert, dgram: inert, dns: inert, tls: inert,
    };
    const sourceRoot = original ? originalPayload : nativeCleanupRoot;
    const source = !original;
    const sourceFile = (file: string) => source && file.endsWith(".js") && fs.existsSync(file.slice(0, -3) + ".ts") ? file.slice(0, -3) + ".ts" : file;
    const resolveModule = (specifier: string, from: string): string => {
        if (specifier.startsWith(".")) return sourceFile(path.resolve(path.dirname(from), specifier));
        if (specifier.startsWith("@ccc/device-lab/")) {
            const suffix = specifier.slice("@ccc/device-lab/".length);
            return sourceFile(path.join(sourceRoot, source ? "packages/device-lab/src" : "dist/packages/device-lab/dist", suffix));
        }
        return deny(`module:${specifier}`);
    };
    const load = (requested: string): Record<string, any> => {
        const file = sourceFile(path.resolve(sourceRoot, requested));
        if (!file.startsWith(sourceRoot + path.sep)) return deny("source outside payload");
        const cached = modules.get(file); if (cached) return cached.exports;
        // Unrelated legacy admin imports are import-only denied capabilities.
        // None of the reachable native cleanup dependencies are replaced here.
        if (/device-lab-broker\.(js|ts)$|hyper-v-images\.(js|ts)$|hyper-v-linux-image-readiness\.(js|ts)$|hyper-v\/image-store\.(js|ts)$|host-control\/hyper-v\/index\.(js|ts)$/.test(file)) {
            loaded.push(path.relative(sourceRoot, file));
            return inert as Record<string, any>;
        }
        const mod = { exports: {} }; modules.set(file, mod); loaded.push(path.relative(sourceRoot, file));
        const body = fs.readFileSync(file, "utf8");
        const common = ts.transpileModule(body.replace(/import\.meta\.url/g, JSON.stringify(url.pathToFileURL(file).href)), {
            // Compiler-only CTS identity prevents a genuine .mjs asset from
            // retaining ESM syntax inside this CommonJS sandbox. Read paths,
            // hash authority, resolution/cache keys and VM stack filename stay
            // bound to the actual captured/candidate file above and below.
            fileName: `${file}.cts`, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText;
        const requireNative = (specifier: string) => {
            const builtin = specifier.replace(/^node:/, "");
            if (builtin in builtins) {
                const authority = builtins[builtin];
                return authority && typeof authority === "object" ? new Proxy(authority as object, {
                    get: (target, name) => {
                        if (name === "__esModule") return false;
                        if (Reflect.has(target, name)) return Reflect.get(target, name);
                        return deny(`unknown builtin:${builtin}.${String(name)}`);
                    },
                }) : authority;
            }
            return load(resolveModule(specifier, file));
        };
        vm.runInContext(`(function(require,module,exports){${common}\n})`, context, { filename: file })(requireNative, mod, mod.exports);
        return mod.exports;
    };
    const native = load(original ? "dist/device-lab-admin.js" : "src/device-lab-cleanup.ts") as CleanupApi;
    const ownerId = native.deviceLabOwnerId(project);
    const ownerFile = (key: string) => path.join(home, ".ccc/devices/owners", ownerId, key, "devices.json");
    const writeJson = (file: string, value: unknown) => { check(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
    const readJson = (file: string) => { check(file); return JSON.parse(fs.readFileSync(file, "utf8")); };
    const assertZero = () => { expect(denied).toBe(0); };
    assertZero();
    return {
        home, trace, loaded, state, native, ownerId, ownerFile, writeJson, readJson,
        load: (file: string) => load(original ? file.replace(/^src\//, "dist/").replace(/\.ts$/, ".js") : file),
        normalize, assertZero, context, get denied() { return denied; }, fencedFs, childProcess, nativeProcess,
        cleanup: () => { expect(descriptors.size).toBe(0); fs.rmSync(home, { recursive: true, force: true }); },
        identity: (pid = 999002) => ({ pid, startToken: "linux:123", commandHash: crypto.createHash("sha256").update("fixture-runtime").digest("hex") }),
    };
}
