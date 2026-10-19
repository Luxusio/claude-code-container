import { AsyncLocalStorage } from "async_hooks";
import {
    spawn, spawnSync,
    type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns,
    type SpawnSyncOptionsWithStringEncoding, type SpawnSyncOptionsWithBufferEncoding,
} from "child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, isAbsolute, join, resolve, win32 } from "path";
import type { RuntimeName } from "../domain/container-runtime.js";
import {
    NATIVE_RUNTIME_SELECTOR_KEYS,
    type NativeRuntimeInvocation, type NativeRuntimeSelectors, type NativeRuntimeTransport,
} from "../ports/container-runtime-invocation.js";

const VALUE_LIMIT = 8192;
const RECORD_LIMIT = 65536;
const METADATA_LIMIT = 512 * 1024;
const CONNECTION_ALIAS = "ccc-captured-native-runtime";
const validatedInvocations = new WeakSet<object>();
const invalid = (): never => { throw new TypeError("Invalid native runtime invocation."); };
const captureFailed = (): never => { throw new Error("Unable to capture native container runtime authority."); };

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return invalid();
    for (const key of keys) {
        if (!Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value")) return invalid();
    }
    return value as Record<string, unknown>;
}

function string(value: unknown): string {
    if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value, "utf8") > VALUE_LIMIT) return invalid();
    return value;
}

function absolute(value: unknown): string {
    const path = string(value);
    if (!isAbsolute(path) && !/^[a-z]:[\\/]/i.test(path) && !/^\\\\[^\\]+\\[^\\]+/.test(path)) return invalid();
    return path;
}

function nullablePath(value: unknown): string | null { return value === null ? null : absolute(value); }
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }

function validatedStorageOptions(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > 128 || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
    const result: string[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return invalid();
        result.push(string(descriptor.value));
    }
    return Object.freeze(result);
}

function endpoint(value: unknown, podman = false): string {
    const uri = string(value);
    if (!(podman ? /^(?:ssh|tcp|unix):\/\/.+/i : /^(?:ssh|tcp|unix|npipe):\/\/.+/i).test(uri)) return invalid();
    try {
        const parsed = new URL(uri);
        if (parsed.protocol === "unix:" || parsed.protocol === "npipe:") {
            if (parsed.hostname || !parsed.pathname.startsWith("/")) return invalid();
        } else if (!parsed.hostname) return invalid();
    } catch { return invalid(); }
    return uri;
}

/** Decode before IPC acknowledgement; copy every field so later sender mutation cannot change authority. */
export function validateNativeRuntimeInvocation(value: unknown): NativeRuntimeInvocation {
    if (typeof value === "object" && value !== null && validatedInvocations.has(value)) return value as NativeRuntimeInvocation;
    const input = record(value, ["version", "runtime", "executable", "transport", "selectors"]);
    if (input.version !== 1 || (input.runtime !== "docker" && input.runtime !== "podman")) return invalid();
    const selectorsInput = record(input.selectors, NATIVE_RUNTIME_SELECTOR_KEYS);
    const selectors = Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => {
        const value = selectorsInput[key];
        if (value !== null && (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value, "utf8") > VALUE_LIMIT)) return invalid();
        return [key, value];
    })) as Record<typeof NATIVE_RUNTIME_SELECTOR_KEYS[number], string | null>;
    let transport: NativeRuntimeTransport;
    const kind = typeof input.transport === "object" && input.transport !== null
        ? Object.getOwnPropertyDescriptor(input.transport, "kind")?.value : undefined;
    if (input.runtime === "docker" && kind === "docker") {
        const source = record(input.transport, ["kind", "host", "configDirectory", "tls"]);
        const tls = record(source.tls, ["enabled", "verify", "caFile", "certFile", "keyFile"]);
        const enabled = boolean(tls.enabled);
        const verify = boolean(tls.verify);
        if (verify && !enabled) return invalid();
        transport = Object.freeze({ kind, host: endpoint(source.host), configDirectory: absolute(source.configDirectory), tls: Object.freeze({
            enabled, verify, caFile: nullablePath(tls.caFile), certFile: nullablePath(tls.certFile), keyFile: nullablePath(tls.keyFile),
        }) });
        if (!enabled && (transport.tls.caFile !== null || transport.tls.certFile !== null || transport.tls.keyFile !== null)) return invalid();
        if ((transport.tls.certFile === null) !== (transport.tls.keyFile === null)) return invalid();
    } else if (input.runtime === "podman" && kind === "podman-local") {
        const source = record(input.transport, ["kind", "graphRoot", "runRoot", "storageDriver", "storageOptions", "transientStore"]);
        transport = Object.freeze({ kind, graphRoot: absolute(source.graphRoot), runRoot: absolute(source.runRoot),
            storageDriver: string(source.storageDriver), storageOptions: validatedStorageOptions(source.storageOptions), transientStore: boolean(source.transientStore) });
    } else if (input.runtime === "podman" && kind === "podman-remote") {
        const source = record(input.transport, ["kind", "url", "identityFile", "machine", "tls"]);
        const tls = record(source.tls, ["caFile", "certFile", "keyFile"]);
        transport = Object.freeze({ kind, url: endpoint(source.url, true), identityFile: nullablePath(source.identityFile), machine: boolean(source.machine),
            tls: Object.freeze({ caFile: nullablePath(tls.caFile), certFile: nullablePath(tls.certFile), keyFile: nullablePath(tls.keyFile) }) });
        if ((transport.tls.certFile === null) !== (transport.tls.keyFile === null)) return invalid();
    } else return invalid();
    const result: NativeRuntimeInvocation = Object.freeze({
        version: 1, runtime: input.runtime, executable: absolute(input.executable), transport, selectors: Object.freeze(selectors),
    });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > RECORD_LIMIT) return invalid();
    validatedInvocations.add(result);
    return result;
}

function environmentValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
    if (platform !== "win32") return env[key];
    const actual = Object.keys(env).sort().find(candidate => candidate.toLowerCase() === key.toLowerCase());
    return actual === undefined ? undefined : env[actual];
}

function capturedSelectors(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NativeRuntimeSelectors {
    const selectors = Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => {
        const value = environmentValue(env, key, platform) ?? null;
        if (value !== null && (/[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value, "utf8") > VALUE_LIMIT)) return invalid();
        return [key, value];
    })) as Record<typeof NATIVE_RUNTIME_SELECTOR_KEYS[number], string | null>;
    if (Buffer.byteLength(JSON.stringify(selectors), "utf8") > RECORD_LIMIT) return invalid();
    return Object.freeze(selectors);
}

function overlayEnvironment(invocation: NativeRuntimeInvocation, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of NATIVE_RUNTIME_SELECTOR_KEYS) {
        if (process.platform === "win32") {
            for (const actual of Object.keys(env)) if (actual.toLowerCase() === key.toLowerCase()) delete env[actual];
        } else delete env[key];
    }
    const emitted = new Set<string>();
    for (const key of NATIVE_RUNTIME_SELECTOR_KEYS) {
        if (process.platform === "win32" && emitted.has(key.toLowerCase())) continue;
        emitted.add(key.toLowerCase());
        const value = invocation.selectors[key];
        if (value !== null) env[key] = value;
    }
    // Resolved flags supply native authority; selectors naming mutable aliases must not compete with them.
    for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) delete env[key];
    return env;
}

/** Flags are compiled from the closed transport, never accepted as an IPC argv prefix. */
export interface NativePodmanConnection {
    readonly URI: string;
    readonly Identity: string;
    readonly IsMachine: boolean;
    readonly TLSCA: string;
    readonly TLSCert: string;
    readonly TLSKey: string;
}

export function compileNativeRuntimeInvocation(
    value: NativeRuntimeInvocation, args: readonly string[], env: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv; connection?: NativePodmanConnection } {
    const invocation = validateNativeRuntimeInvocation(value);
    const transport = invocation.transport;
    let prefix: string[];
    let connection: NativePodmanConnection | undefined;
    if (transport.kind === "docker") {
        prefix = ["--config", transport.configDirectory, "--host", transport.host,
            `--tls=${transport.tls.enabled}`, ...(transport.tls.enabled ? [`--tlsverify=${transport.tls.verify}`] : []),
            `--tlscacert=${transport.tls.caFile ?? ""}`, `--tlscert=${transport.tls.certFile ?? ""}`, `--tlskey=${transport.tls.keyFile ?? ""}`];
    } else if (transport.kind === "podman-local") {
        prefix = ["--remote=false", "--root", transport.graphRoot, "--runroot", transport.runRoot, "--storage-driver", transport.storageDriver,
            ...transport.storageOptions.flatMap(option => ["--storage-opt", option]), `--transient-store=${transport.transientStore}`];
    } else {
        prefix = ["--remote=true", "--connection", CONNECTION_ALIAS];
        connection = Object.freeze({ URI: transport.url, Identity: transport.identityFile ?? "", IsMachine: transport.machine,
            TLSCA: transport.tls.caFile ?? "", TLSCert: transport.tls.certFile ?? "", TLSKey: transport.tls.keyFile ?? "" });
    }
    return { executable: invocation.executable, args: [...prefix, ...args], env: overlayEnvironment(invocation, env), ...(connection ? { connection } : {}) };
}

export interface BoundNativeSpawnSync {
    (args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
    (args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
    (args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
}

export interface BoundNativeRuntimeRunner {
    readonly invocation: NativeRuntimeInvocation;
    readonly spawnSync: BoundNativeSpawnSync;
    readonly spawn: (args: readonly string[], options?: SpawnOptions) => ChildProcess;
}

function materializeConnection(compiled: ReturnType<typeof compileNativeRuntimeInvocation>): () => void {
    if (!compiled.connection) return () => {};
    let directory: string | undefined;
    const cleanup = (): void => {
        if (!directory) return;
        const owned = directory;
        directory = undefined;
        try { rmSync(owned, { recursive: true, force: true }); } catch { /* preserve the native result/error */ }
    };
    try {
        directory = mkdtempSync(join(resolve(tmpdir()), "ccc-runtime-"));
        chmodSync(directory, 0o700);
        const path = join(directory, "connections.json");
        writeFileSync(path, JSON.stringify({ Connection: { Default: CONNECTION_ALIAS, Connections: { [CONNECTION_ALIAS]: compiled.connection } } }),
            { encoding: "utf8", mode: 0o600, flag: "wx" });
        compiled.env.PODMAN_CONNECTIONS_CONF = path;
        return cleanup;
    } catch {
        cleanup();
        throw new Error("Unable to prepare captured Podman connection.");
    }
}

export function bindNativeRuntimeInvocation(value: NativeRuntimeInvocation): BoundNativeRuntimeRunner {
    const invocation = validateNativeRuntimeInvocation(value);
    return Object.freeze({
        invocation,
        spawnSync: ((args: readonly string[], options: SpawnSyncOptions = {}) => {
            const compiled = compileNativeRuntimeInvocation(invocation, args, options.env ?? process.env);
            const cleanup = materializeConnection(compiled);
            try { return spawnSync(compiled.executable, compiled.args, { ...options, env: compiled.env, shell: false }); }
            finally { cleanup(); }
        }) as BoundNativeSpawnSync,
        spawn: (args: readonly string[], options: SpawnOptions = {}) => {
            const compiled = compileNativeRuntimeInvocation(invocation, args, options.env ?? process.env);
            const cleanup = materializeConnection(compiled);
            try {
                const child = spawn(compiled.executable, compiled.args, { ...options, env: compiled.env, shell: false });
                if (compiled.connection) child.once("close", cleanup);
                return child;
            } catch (error) { cleanup(); throw error; }
        },
    });
}

const nativeScope = new AsyncLocalStorage<NativeRuntimeInvocation>();

/** Native composition owns this scope; returned callbacks must explicitly re-enter their captured value. */
export function runWithNativeRuntimeInvocation<T>(value: NativeRuntimeInvocation, callback: () => T): T {
    return nativeScope.run(validateNativeRuntimeInvocation(value), callback);
}

export function currentNativeRuntimeInvocation(): NativeRuntimeInvocation | undefined { return nativeScope.getStore(); }

export interface NativeRuntimeCaptureOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly platform?: NodeJS.Platform;
}

function executableOnPath(runtime: RuntimeName, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): string {
    const path = environmentValue(env, "PATH", platform) ?? (platform === "win32" ? "" : "/usr/bin:/bin");
    let directories: string[];
    if (platform === "win32") {
        // Match Node/libuv's native basename lookup: permitted cwd, then PATH.
        // Quoted PATH entries may contain semicolons; empty raw entries are skipped.
        directories = environmentValue(env, "NoDefaultCurrentDirectoryInExePath", platform) === undefined ? [cwd] : [];
        for (let start = 0; start < path.length;) {
            const quote = path[start] === '"' || path[start] === "'" ? path[start] : undefined;
            const close = quote ? path.indexOf(quote, start + 1) : start;
            let end = close === -1 ? path.length : path.indexOf(";", close);
            if (end === -1) end = path.length;
            let directory = path.slice(start, end);
            if (directory.length) {
                if (directory.startsWith('"') || directory.startsWith("'")) directory = directory.slice(1);
                if (directory.endsWith('"') || directory.endsWith("'")) directory = directory.slice(0, -1);
                directories.push(directory);
            }
            start = end + 1;
        }
    } else directories = path.split(delimiter);
    // Native Windows dispatch ignores PATHEXT and tries only .com, then .exe.
    const extensions = platform === "win32" ? [".com", ".exe"] : [""];
    for (const directory of directories) {
        for (const extension of extensions) {
            const candidate = platform === "win32" ? win32.resolve(cwd, directory, `${runtime}${extension}`) : resolve(cwd, directory, `${runtime}${extension}`);
            try {
                accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
                if (statSync(candidate).isFile()) return candidate;
            } catch { /* try the next captured PATH entry */ }
        }
    }
    return captureFailed();
}

function metadata(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): unknown {
    const result = spawnSync(executable, args, { env: { ...env }, cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000, killSignal: "SIGKILL", maxBuffer: METADATA_LIMIT, shell: false });
    if (result.status !== 0 || result.error || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > METADATA_LIMIT) return captureFailed();
    try { return JSON.parse(result.stdout); } catch { return captureFailed(); }
}

function metadataObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return captureFailed();
    return value as Record<string, unknown>;
}

function atCapturePath(value: string, cwd: string, platform: NodeJS.Platform): string {
    return platform === "win32" ? win32.resolve(cwd, value) : resolve(cwd, value);
}

function storageOptions(value: unknown): readonly string[] {
    if (value === undefined || value === null) return [];
    const options = metadataObject(value);
    const result: string[] = [];
    for (const key of Object.keys(options).sort()) {
        string(key);
        const value = options[key];
        if (key.endsWith(".imagestore") && Array.isArray(options[key.replace(/\.imagestore$/, ".additionalImageStores")])) continue;
        if (key.endsWith(".additionalImageStores")) {
            if (!Array.isArray(value)) return captureFailed();
            for (const directory of value) result.push(string(`${key.replace(/\.additionalImageStores$/, ".imagestore")}=${string(directory)}`));
        } else if (key.endsWith(".mount_program") && typeof value === "object" && value !== null && !Array.isArray(value)) {
            result.push(string(`${key}=${string(metadataObject(value).Executable)}`));
        } else if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            result.push(string(`${key}=${value}`));
        } else return captureFailed();
        if (result.length > 128) return captureFailed();
    }
    return result;
}

/** Capture uses a private environment copy and bounded metadata; no credential file contents are read. */
export function captureNativeRuntimeInvocation(runtime: RuntimeName, options: NativeRuntimeCaptureOptions = {}): NativeRuntimeInvocation {
    try {
        if (runtime !== "docker" && runtime !== "podman") return captureFailed();
        const env = { ...(options.env ?? process.env) };
        const platform = options.platform ?? process.platform;
        const cwd = atCapturePath(string(options.cwd ?? process.cwd()), process.cwd(), platform);
        const selectors = capturedSelectors(env, platform);
        const executable = executableOnPath(runtime, env, cwd, platform);
        const read = (key: string): string | undefined => environmentValue(env, key, platform);
        const path = (value: string): string => atCapturePath(value, cwd, platform);
        let transport: NativeRuntimeTransport;
        if (runtime === "docker") {
            const home = platform === "win32" ? read("USERPROFILE") ?? "" : read("HOME") || homedir();
            const configDirectory = path(read("DOCKER_CONFIG") || join(home, ".docker"));
            const context = read("DOCKER_CONTEXT");
            const inspection = metadataObject(metadata(executable,
                ["--config", configDirectory, "context", "inspect", "--format", "{{json .}}", ...(context ? ["--", context] : [])], env, cwd));
            const docker = metadataObject(metadataObject(inspection.Endpoints).docker);
            const usesDefault = string(inspection.Name) === "default";
            if (usesDefault) {
                const verify = !!read("DOCKER_TLS_VERIFY");
                const enabled = verify || !!read("DOCKER_TLS");
                const certDirectory = path(read("DOCKER_CERT_PATH") || configDirectory);
                const cert = (name: string): string | null => {
                    const file = path(join(certDirectory, name));
                    if (!enabled) return null;
                    // The CLI retains its CA default and clears only missing client cert/key defaults.
                    if (name !== "ca.pem") {
                        try { statSync(file); }
                        catch (error) {
                            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
                        }
                    }
                    return file;
                };
                transport = { kind: "docker", host: endpoint(docker.Host), configDirectory,
                    tls: { enabled, verify, caFile: cert("ca.pem"), certFile: cert("cert.pem"), keyFile: cert("key.pem") } };
            } else {
                const materials = metadataObject(inspection.TLSMaterial).docker ?? [];
                if (!Array.isArray(materials) || materials.some(name => !["ca.pem", "cert.pem", "key.pem"].includes(name))) return captureFailed();
                if (typeof docker.SkipTLSVerify !== "boolean") return captureFailed();
                const enabled = materials.length > 0 || docker.SkipTLSVerify;
                const tlsPath = materials.length > 0 ? absolute(metadataObject(inspection.Storage).TLSPath) : "";
                const file = (name: string): string | null => materials.includes(name) ? path(join(tlsPath, "docker", name)) : null;
                const hasClientPair = materials.includes("cert.pem") && materials.includes("key.pem");
                transport = { kind: "docker", host: endpoint(docker.Host), configDirectory, tls: {
                    enabled, verify: enabled && !docker.SkipTLSVerify, caFile: file("ca.pem"),
                    certFile: hasClientPair ? file("cert.pem") : null, keyFile: hasClientPair ? file("key.pem") : null,
                } };
            }
        } else {
            const info = metadataObject(metadata(executable, ["info", "--format", "json"], env, cwd));
            const host = metadataObject(info.host);
            if (typeof host.serviceIsRemote !== "boolean") return captureFailed();
            if (!host.serviceIsRemote) {
                const store = metadataObject(info.store);
                transport = { kind: "podman-local", graphRoot: absolute(store.graphRoot), runRoot: absolute(store.runRoot), storageDriver: string(store.graphDriverName),
                    storageOptions: storageOptions(store.graphOptions), transientStore: Object.hasOwn(store, "transientStore") ? boolean(store.transientStore) : false };
            } else {
                const alias = read("CONTAINER_CONNECTION");
                let url = alias ? undefined : read("CONTAINER_HOST");
                let selected: Record<string, unknown> = {};
                if (alias || !url) {
                    const connections = metadata(executable, ["system", "connection", "list", "--format", "json"], env, cwd);
                    if (!Array.isArray(connections)) return captureFailed();
                    const matches = connections.map(metadataObject).filter(connection => alias ? connection.Name === alias : connection.Default === true);
                    if (matches.length !== 1) return captureFailed();
                    selected = matches[0];
                    url = string(selected.URI);
                }
                const reference = (key: string): string | null => {
                    if (!Object.hasOwn(selected, key)) return null;
                    const value = selected[key];
                    if (typeof value !== "string") return captureFailed();
                    return value ? path(string(value)) : null;
                };
                const identityFile = reference("Identity") ?? (read("CONTAINER_SSHKEY") ? path(read("CONTAINER_SSHKEY")!) : null);
                transport = { kind: "podman-remote", url: endpoint(url, true), identityFile,
                    machine: Object.hasOwn(selected, "IsMachine") ? boolean(selected.IsMachine) : false,
                    tls: { caFile: reference("TLSCA"), certFile: reference("TLSCert"), keyFile: reference("TLSKey") } };
            }
        }
        return validateNativeRuntimeInvocation({ version: 1, runtime, executable, transport, selectors });
    } catch { return captureFailed(); }
}
