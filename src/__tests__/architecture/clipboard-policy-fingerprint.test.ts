import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { createServer, request, type Server } from "http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { EventEmitter } from "events";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const native = vi.hoisted(() => ({
    sourceRoot: "", home: "", contents: new Map<string, string>(), reads: [] as string[],
    failingRead: "", bindUsers: false, spawn: vi.fn(),
}));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return { ...actual, readFileSync: (file: unknown, ...args: unknown[]) => {
        const logical = typeof file === "string" ? relative(native.sourceRoot, file).replaceAll("\\", "/") : "";
        if (native.contents.has(logical)) {
            native.reads.push(logical);
            if (native.failingRead === logical) throw new Error("Fixture hash read unavailable");
            return native.contents.get(logical)!;
        }
        return (actual.readFileSync as unknown as (...args: unknown[]) => unknown)(file, ...args);
    } };
});
vi.mock("os", async () => ({ ...await vi.importActual<typeof import("os")>("os"), homedir: () => native.home }));
vi.mock("child_process", async () => ({ ...await vi.importActual<typeof import("child_process")>("child_process"), spawn: native.spawn }));
vi.mock("../../container-runtime.js", async original => {
    const actual = await original<typeof import("../../container-runtime.js")>();
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../../ports/container-runtime-invocation.js");
    const invocation = actual.validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    return { ...actual, getRuntimeInvocation: () => invocation, peekRuntimeInvocation: () => invocation };
});
vi.mock("../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: () => native.bindUsers }));
vi.mock("../../clipboard-startup-lock.js", () => ({
    tryAcquireClipboardStartupLock: () => ({ path: "private-startup-lock", fd: 1 }),
    recoverDeadClipboardStartupLock: () => false,
    releaseClipboardStartupLock: () => undefined,
}));

const files = [
    "clipboard-server.js",
    "domain/clipboard/snapshot.js",
    "domain/clipboard/text-write.js",
    "domain/clipboard/server-lifecycle.js",
    "application/clipboard/snapshot.js",
    "application/clipboard/text-write.js",
    "application/clipboard/server-lifecycle.js",
    "clipboard-bind-users.js",
    "adapters/runtime-bind-authority.js",
    "adapters/runtime-bind-users.js",
    "application/runtime-bind-admission.js",
] as const;
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureEnvKeys = ["HOME", "USERPROFILE", "TMPDIR"] as const;
let priorEnvironment: Record<typeof fixtureEnvKeys[number], string | undefined>;
let servers: Server[];
let roots: string[];
type ClipboardModule = typeof import("../../clipboard-server.js");

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    native.sourceRoot = sourceRoot;
    native.home = mkdtempSync(join(tmpdir(), "ccc-policy-fingerprint-"));
    roots = [native.home];
    servers = [];
    priorEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TMPDIR: process.env.TMPDIR };
    for (const key of fixtureEnvKeys) process.env[key] = native.home;
    native.contents = new Map(files.map(file => [file, `// fixture body ${file}\n한글\n`]));
    native.reads = [];
    native.failingRead = "";
    native.bindUsers = false;
    native.spawn.mockImplementation(() => { throw new Error("Unexpected native daemon launch"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
    }
    for (const key of fixtureEnvKeys) {
        const value = priorEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function expectedVersion() {
    const digest = createHash("sha256").update("ccc-clipboard-policy-v2\0");
    for (const file of files) {
        const body = native.contents.get(file)!;
        digest.update(file).update("\0").update(String(Buffer.byteLength(body, "utf8")))
            .update("\0").update(body).update("\0");
    }
    return digest.digest("hex").slice(0, 12);
}
function health(port: number, token?: string): Promise<{ service: string; valid?: boolean; version?: string }> {
    return new Promise((resolveResult, reject) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/health",
            headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } }, response => {
            let body = "";
            response.on("data", chunk => { body += chunk; });
            response.on("end", () => resolveResult(JSON.parse(body)));
            response.on("error", reject);
        });
        req.on("error", reject);
        req.end();
    });
}
async function load() {
    const mod: ClipboardModule = await import("../../clipboard-server.js");
    const token = "private-policy-token";
    const instance = mod.createClipboardServer(token, "unsupported");
    servers.push(instance.server);
    const port = await instance.start("127.0.0.1");
    return { mod, token, port, version: (await health(port, token)).version! };
}
async function reload() {
    vi.resetModules();
    return load();
}
function publish(port: number, token: string) {
    const directory = join(native.home, ".ccc", "run");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const portFile = join(directory, "clipboard.port");
    writeFileSync(portFile, `${port}:${token}`, { mode: 0o600 });
    return portFile;
}
async function oldPeer(version: string, settlement = false) {
    const token = settlement ? "a".repeat(32) : "private-old-peer-token";
    const calls: { path: string; authorization?: string }[] = [];
    const server = createServer((req, response) => {
        calls.push({ path: req.url!, authorization: req.headers.authorization });
        if (req.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
        if (req.url === "/shutdown") {
            if (settlement) {
                server.close();
                expect(server.listening).toBe(false);
                response.writeHead(200).end(JSON.stringify({ service: "ccc-clipboard", retirement: "writer-settlement-v1", settled: true }));
            } else response.writeHead(200).end("acknowledged");
            return;
        }
        response.end(JSON.stringify({ service: "ccc-clipboard", valid: true, version, ...(settlement ? { retirement: "writer-settlement-v1" } : {}) }));
    });
    servers.push(server);
    const port = await new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));
    const portFile = publish(port, token);
    return { port, token, portFile, calls };
}

describe("fixed compiled Clipboard policy fingerprint", () => {
    it("reports the framed SHA-256/12 digest only to authenticated health", async () => {
        const instance = await load();
        expect(instance.version).toMatch(/^[a-f0-9]{12}$/);
        expect(instance.version).toBe(expectedVersion());
        expect(native.reads).toEqual(files);
        expect(await health(instance.port)).toEqual({ service: "ccc-clipboard" });
        expect(await health(instance.port, "wrong-token")).toEqual({ service: "ccc-clipboard" });
        expect(native.reads).toEqual(files);
    });

    it.each(files)("changes the native facade version when %s changes", async file => {
        const previous = await load();
        native.contents.set(file, native.contents.get(file)! + "// independently mutated\n");
        const next = await reload();
        expect(next.version).toBe(expectedVersion());
        expect(next.version).not.toBe(previous.version);
    });

    it("separates equal concatenated bodies by fixed path/byte-length framing", async () => {
        native.contents.set(files[0], "ab");
        native.contents.set(files[1], "c");
        const before = await load();
        native.contents.set(files[0], "a");
        native.contents.set(files[1], "bc");
        const after = await reload();
        expect(after.version).not.toBe(before.version);
        expect(after.version).toBe(expectedVersion());
    });

    it.each(files)("captures unknown on a hash read failure for %s after static resolution", async file => {
        native.failingRead = file;
        const instance = await load();
        expect(instance.version).toBe("unknown");
        native.failingRead = "";
        expect((await health(instance.port, instance.token)).version).toBe("unknown");
        expect((await reload()).version).toBe(expectedVersion());
    });

    it("captures the version at import and excludes external helper contents", async () => {
        const imported = await load();
        native.contents.set(files[2], "new policy after import");
        native.contents.set("clipboard-helper-darwin.m", "new external helper");
        expect((await health(imported.port, imported.token)).version).toBe(imported.version);
        const next = await reload();
        expect(next.version).not.toBe(imported.version);
        expect(native.reads.every(file => files.includes(file as typeof files[number]))).toBe(true);
    });

    it("reuses authenticated current-version metadata without launching a daemon", async () => {
        const instance = await load();
        publish(instance.port, instance.token);
        expect(await instance.mod.ensureClipboardServer()).toBe(instance.port);
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("defers a mutated policy upgrade when native bind-user observations are uncertain", async () => {
        const previousVersion = expectedVersion();
        native.contents.set(files[4], "changed snapshot policy");
        const peer = await oldPeer(previousVersion);
        const before = statSync(peer.portFile);
        const bytes = readFileSync(peer.portFile, "utf8");
        native.bindUsers = true;
        const instance = await load();
        expect(await instance.mod.ensureClipboardServer()).toBe(peer.port);
        expect(peer.calls.filter(call => call.path === "/shutdown")).toEqual([]);
        expect(peer.calls.every(call => call.authorization === `Bearer ${peer.token}`)).toBe(true);
        expect(readFileSync(peer.portFile, "utf8")).toBe(bytes);
        expect(statSync(peer.portFile).ino).toBe(before.ino);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Clipboard update deferred"));
    });

    it("authenticates retirement and publishes a new token for an upgraded policy", async () => {
        const previousVersion = expectedVersion();
        native.contents.set(files[5], "changed text write policy");
        const peer = await oldPeer(previousVersion, true);
        const inode = statSync(peer.portFile).ino;
        const instance = await load();
        const unref = vi.fn();
        let successorPort = 0;
        const successorToken = "b".repeat(32);
        const protocol: string[] = [];
        native.spawn.mockImplementation(() => {
            const successor = instance.mod.createClipboardServer(successorToken, "unsupported");
            servers.push(successor.server);
            const child = Object.assign(new EventEmitter(), {
                unref,
                disconnect: vi.fn(),
                send: (message: { type: string; runtimeInvocation?: unknown; receipt?: { path: string; bytes: string } }, callback: (error: Error | null) => void) => {
                    protocol.push(message.type);
                    if (message.type === "initialize") {
                        expect(message.runtimeInvocation).toMatchObject({ executable: "/fixture/runtime/docker" });
                        expect(readFileSync(peer.portFile, "utf8")).toBe(`retired-v1:${peer.port}:${peer.token}`);
                        void successor.start("127.0.0.1").then(port => {
                            successorPort = port;
                            child.emit("message", { type: "ready", port, token: successorToken });
                        });
                    } else if (message.type === "published") {
                        expect(message.receipt?.path).toBe(peer.portFile);
                        expect(readFileSync(peer.portFile, "utf8")).toBe(`${successorPort}:${successorToken}`);
                        queueMicrotask(() => child.emit("message", { type: "committed" }));
                    } else throw new Error("Unexpected parent publisher message");
                    callback(null);
                    return true;
                },
            });
            return child;
        });
        expect(await instance.mod.ensureClipboardServer()).toBe(successorPort);
        expect(successorPort).not.toBe(peer.port);
        expect(peer.calls.filter(call => call.path === "/shutdown")).toEqual([{ path: "/shutdown", authorization: `Bearer ${peer.token}` }]);
        expect((await health(successorPort, successorToken)).version).toBe(instance.version);
        expect(statSync(peer.portFile).ino).toBe(inode);
        expect(unref).toHaveBeenCalledOnce();
        expect(protocol).toEqual(["initialize", "published"]);
        expect(native.spawn.mock.calls[0][1]).toEqual([join(sourceRoot, "clipboard-server.js"), "--serve", "--parent-publisher"]);
        expect(native.spawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    }, 10000);

    it("fails a private emitted ESM startup before publication when a statically imported policy file is missing", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-policy-static-missing-"));
        roots.push(root);
        // The coordinator emits the combined product before these owners run.
        // Copy its actual tree so only the selected policy dependency is absent.
        const copyTree = (source: string, destination: string): void => {
            for (const entry of readdirSync(source, { withFileTypes: true })) {
                const input = join(source, entry.name), output = join(destination, entry.name);
                if (entry.isDirectory()) {
                    mkdirSync(output, { mode: 0o700 });
                    copyTree(input, output);
                } else if (entry.isFile()) copyFileSync(input, output);
                else throw new Error(`Unexpected emitted fixture entry: ${entry.name}`);
            }
        };
        copyTree(resolve(sourceRoot, "../dist"), root);
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
        const missing = join(root, "application/clipboard/text-write.js");
        expect(existsSync(missing)).toBe(true);
        unlinkSync(missing);
        const result = spawnSync(process.execPath, [join(root, "clipboard-server.js"), "--serve"], {
            cwd: root, timeout: 5000, encoding: "utf8", env: {
                ...process.env, HOME: native.home, USERPROFILE: native.home, NODE_OPTIONS: "",
            },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
        expect(result.stderr).toContain(`Cannot find module '${missing}'`);
        expect(existsSync(join(native.home, ".ccc", "run", "clipboard.port"))).toBe(false);
        expect(existsSync(join(native.home, ".ccc", "clipboard.port"))).toBe(false);
    });
});
