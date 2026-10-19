import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import {
    NATIVE_RUNTIME_SELECTOR_KEYS,
    type NativeRuntimeInvocation,
} from "../../ports/container-runtime-invocation.js";

const native = vi.hoisted(() => ({
    spawnSync: vi.fn(),
    spawn: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    exists: vi.fn(),
    realpath: vi.fn(),
    mkdtemp: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
}));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(),
    spawnSync: native.spawnSync,
    spawn: native.spawn,
}));
vi.mock("fs", async original => ({
    ...await original<typeof import("node:fs")>(),
    accessSync: native.access,
    statSync: native.stat,
    existsSync: native.exists,
    realpathSync: native.realpath,
    mkdtempSync: native.mkdtemp,
    writeFileSync: native.write,
    rmSync: native.remove,
}));
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
import {
    bindNativeRuntimeInvocation,
    captureNativeRuntimeInvocation,
    compileNativeRuntimeInvocation,
    currentNativeRuntimeInvocation,
    runWithNativeRuntimeInvocation,
    validateNativeRuntimeInvocation,
} from "../../adapters/container-runtime-invocation.js";
import {
    _resetRuntimeCacheForTest,
    _setRuntimeInvocationForTest,
    getRuntimeInfo,
    getRuntimeInvocation,
    runtimeSpawn,
    runtimeSpawnSync,
    setRuntimeOverride,
} from "../../container-runtime.js";

function selectors(): NativeRuntimeInvocation["selectors"] {
    return Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeInvocation["selectors"];
}

function dockerRecord(host = "unix:///fixture/engine-a.sock"): NativeRuntimeInvocation {
    return {
        version: 1,
        runtime: "docker",
        executable: "/fixture/bin/docker",
        transport: {
            kind: "docker",
            host,
            configDirectory: "/fixture/home/.docker",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null },
        },
        selectors: { ...selectors(), PATH: "/fixture/bin", HOME: "/fixture/home" },
    };
}

function localPodmanRecord(): NativeRuntimeInvocation {
    return {
        version: 1,
        runtime: "podman",
        executable: "/fixture/bin/podman",
        transport: { kind: "podman-local", graphRoot: "/fixture/store", runRoot: "/fixture/run", storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: { ...selectors(), PATH: "/fixture/bin", HOME: "/fixture/home" },
    };
}

function remotePodmanRecord(): NativeRuntimeInvocation {
    return {
        version: 1,
        runtime: "podman",
        executable: "/fixture/bin/podman",
        transport: { kind: "podman-remote", url: "ssh://builder@example.test:2201/run/user/1000/podman.sock", identityFile: "/fixture/identities/engine-a", machine: true, tls: { caFile: "/fixture/tls/ca.pem", certFile: "/fixture/tls/cert.pem", keyFile: "/fixture/tls/key.pem" } },
        selectors: { ...selectors(), PATH: "/fixture/bin", HOME: "/fixture/home" },
    };
}

function successful(stdout = ""): SpawnSyncReturns<string> {
    return { pid: 19, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

function captureEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { PATH: "/fixture/bin", HOME: "/fixture/home", DOCKER_CONFIG: "/fixture/docker-config", ...overrides };
}

function contextMetadata(host = "unix:///fixture/engine-a.sock", options: { name?: string; skipVerify?: boolean; material?: string[]; tlsPath?: string } = {}): string {
    return JSON.stringify({
        Name: options.name ?? "native-a",
        Endpoints: { docker: { Host: host, SkipTLSVerify: options.skipVerify ?? false } },
        TLSMaterial: options.material === undefined ? {} : { docker: options.material },
        Storage: { TLSPath: options.tlsPath ?? "/fixture/context-tls/native-a" },
    });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
    const inline = args.find(value => value.startsWith(`${flag}=`));
    if (inline !== undefined) return inline.slice(flag.length + 1);
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
}

function podmanInfo(remote: boolean, store: Record<string, unknown> = {}): string {
    return JSON.stringify({ host: { serviceIsRemote: remote }, store: { graphRoot: "/fixture/store", runRoot: "/fixture/run", graphDriverName: "overlay", ...store } });
}

function connectionMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { Name: "native-a", URI: "ssh://builder@engine-a.test:2201/run/podman.sock", Identity: "/fixture/identities/engine-a", Default: true, IsMachine: true, TLSCA: "/fixture/tls/ca.pem", TLSCert: "/fixture/tls/cert.pem", TLSKey: "/fixture/tls/key.pem", ...overrides };
}

function readCapsule(options: { env: NodeJS.ProcessEnv }): { path: string; value: unknown } {
    const path = options.env.PODMAN_CONNECTIONS_CONF;
    expect(path).toBeTypeOf("string");
    if (!path) throw Error("native replay did not receive a private connection file");
    return { path, value: JSON.parse(actualFs.readFileSync(path, "utf8")) as unknown };
}

beforeEach(() => {
    vi.resetAllMocks();
    _resetRuntimeCacheForTest();
    native.access.mockImplementation((path: string) => {
        if (!/^\/fixture\/bin\/(docker|podman)$/.test(path)) throw Object.assign(Error("synthetic missing executable"), { code: "ENOENT" });
    });
    native.stat.mockImplementation((path: string) => {
        if (!/^\/fixture\/bin\/(docker|podman)$/.test(path)) throw Object.assign(Error("synthetic missing file"), { code: "ENOENT" });
        return { isFile: () => true };
    });
    native.exists.mockReturnValue(false);
    native.realpath.mockImplementation((path: string) => path);
    native.mkdtemp.mockImplementation(actualFs.mkdtempSync);
    native.write.mockImplementation(actualFs.writeFileSync);
    native.remove.mockImplementation(actualFs.rmSync);
    native.spawnSync.mockImplementation(() => { throw Error("unconfigured synthetic native command"); });
    native.spawn.mockImplementation(() => { throw Error("unconfigured synthetic async native command"); });
});
afterEach(() => { _resetRuntimeCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native Docker capture", () => {
    it("resolves an explicit context ahead of DOCKER_HOST with complete TLS references", () => {
        const env = captureEnvironment({ DOCKER_CONTEXT: "native-a", DOCKER_HOST: "unix:///fixture/ambient-b.sock", DOCKER_API_VERSION: "1.47", SSH_AUTH_SOCK: "/fixture/agent.sock", AWS_SECRET_ACCESS_KEY: "synthetic-never-copied" });
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { material: ["ca.pem", "cert.pem", "key.pem"] })));
        const invocation = captureNativeRuntimeInvocation("docker", { env, cwd: "/fixture/work", platform: "linux" });
        expect(invocation).toMatchObject({
            version: 1, runtime: "docker", executable: "/fixture/bin/docker",
            transport: { kind: "docker", host: "tcp://engine-a.test:2376", configDirectory: "/fixture/docker-config", tls: { enabled: true, verify: true, caFile: "/fixture/context-tls/native-a/docker/ca.pem", certFile: "/fixture/context-tls/native-a/docker/cert.pem", keyFile: "/fixture/context-tls/native-a/docker/key.pem" } },
        });
        expect(invocation.selectors.DOCKER_CONTEXT).toBe("native-a");
        expect(invocation.selectors.DOCKER_API_VERSION).toBe("1.47");
        expect(invocation.selectors.SSH_AUTH_SOCK).toBe("/fixture/agent.sock");
        expect(invocation.selectors.CONTAINER_HOST).toBeNull();
        expect(Object.keys(invocation.selectors).sort()).toEqual([...NATIVE_RUNTIME_SELECTOR_KEYS].sort());
        expect(JSON.stringify(invocation)).not.toContain("synthetic-never-copied");
        expect(native.spawnSync).toHaveBeenCalledExactlyOnceWith("/fixture/bin/docker", ["--config", "/fixture/docker-config", "context", "inspect", "--format", "{{json .}}", "--", "native-a"], expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 512 * 1024, encoding: "utf-8", env: expect.objectContaining({ DOCKER_CONTEXT: "native-a" }) }));
        const compiled = compileNativeRuntimeInvocation(invocation, ["inspect", "same-id"]);
        expect(compiled.args).toEqual(["--config", "/fixture/docker-config", "--host", "tcp://engine-a.test:2376", "--tls=true", "--tlsverify=true", "--tlscacert=/fixture/context-tls/native-a/docker/ca.pem", "--tlscert=/fixture/context-tls/native-a/docker/cert.pem", "--tlskey=/fixture/context-tls/native-a/docker/key.pem", "inspect", "same-id"]);
        expect(compiled.env).not.toHaveProperty("DOCKER_CONTEXT");
        expect(compiled.env).not.toHaveProperty("DOCKER_HOST");
    });

    it("resolves default context TLS from captured certificate/config paths rather than IN MEMORY metadata", () => {
        const env = captureEnvironment({ DOCKER_HOST: "tcp://engine-a.test:2376", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "../client-certs", DOCKER_CONFIG: "../docker-config" });
        native.stat.mockReturnValue({ isFile: () => true });
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env, cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toEqual({ kind: "docker", host: "tcp://engine-a.test:2376", configDirectory: "/fixture/docker-config", tls: { enabled: true, verify: true, caFile: "/fixture/client-certs/ca.pem", certFile: "/fixture/client-certs/cert.pem", keyFile: "/fixture/client-certs/key.pem" } });
        env.DOCKER_HOST = "tcp://engine-b.test:2375";
        env.DOCKER_CERT_PATH = "/fixture/replacement-certs";
        env.PATH = "/fixture/replacement-bin";
        expect(invocation.executable).toBe("/fixture/bin/docker");
        expect(invocation.selectors.DOCKER_CERT_PATH).toBe("../client-certs");
        const compiled = compileNativeRuntimeInvocation(invocation, ["stop", "same-id"], env);
        expect(flagValue(compiled.args, "--host")).toBe("tcp://engine-a.test:2376");
        expect(flagValue(compiled.args, "--tlscert")).toBe("/fixture/client-certs/cert.pem");
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["TLS only", { DOCKER_TLS: "1" }, false],
        ["verify zero is nonempty", { DOCKER_TLS_VERIFY: "0" }, true],
    ] as const)("preserves default-context %s and its default CA even when credential files are absent", (_label, selection, verify) => {
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment(selection), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ kind: "docker", tls: { enabled: true, verify, caFile: "/fixture/docker-config/ca.pem", certFile: null, keyFile: null } });
        const args = compileNativeRuntimeInvocation(invocation, ["info"]).args;
        expect(args).toContain("--tls=true");
        expect(args).toContain(`--tlsverify=${verify}`);
        expect(args).toContain("--tlscacert=/fixture/docker-config/ca.pem");
        expect(args).toContain("--tlscert=");
        expect(args).toContain("--tlskey=");
    });

    it("retains default certificate references when file observation fails for a reason other than absence", () => {
        native.stat.mockImplementation((path: string) => {
            if (/^\/fixture\/bin\/docker$/.test(path)) return { isFile: () => true };
            throw Object.assign(Error("synthetic permission refusal"), { code: "EACCES" });
        });
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_TLS: "1" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ tls: { enabled: true, verify: false, caFile: "/fixture/docker-config/ca.pem", certFile: "/fixture/docker-config/cert.pem", keyFile: "/fixture/docker-config/key.pem" } });
    });

    it.each(["unix:///fixture/engine-a.sock", "tcp://engine-a.test:2375", "ssh://builder@engine-a.test", "npipe:////./pipe/engine-a"])("retains the normalized selected endpoint %s", host => {
        native.spawnSync.mockReturnValue(successful(contextMetadata(host, { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_HOST: host }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ kind: "docker", host, tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } });
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
    });

    it("retains TLS with skip verification even when context material is absent", () => {
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { skipVerify: true })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_CONTEXT: "native-a" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ kind: "docker", tls: { enabled: true, verify: false, caFile: null, certFile: null, keyFile: null } });
        const compiled = compileNativeRuntimeInvocation(invocation, ["info"]);
        expect(compiled.args).toContain("--tls=true");
        expect(compiled.args).toContain("--tlsverify=false");
        expect(compiled.args).toEqual(expect.arrayContaining(["--tlscacert=", "--tlscert=", "--tlskey="]));
    });

    it("keeps an empty context TLS material list non-TLS without default CA fallback", () => {
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { material: [] })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_CONTEXT: "native-a" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } });
        expect(compileNativeRuntimeInvocation(invocation, ["info"]).args).toEqual(expect.arrayContaining(["--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="]));
    });

    it("preserves partial context TLS material without filling absent credentials from later defaults", () => {
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { material: ["ca.pem"] })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_CONTEXT: "native-a" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ tls: { enabled: true, verify: true, caFile: "/fixture/context-tls/native-a/docker/ca.pem", certFile: null, keyFile: null } });
        const compiled = compileNativeRuntimeInvocation(invocation, ["info"], { DOCKER_CERT_PATH: "/fixture/later-credentials", DOCKER_TLS_VERIFY: "1" });
        expect(compiled.args).toEqual(expect.arrayContaining(["--tlscacert=/fixture/context-tls/native-a/docker/ca.pem", "--tlscert=", "--tlskey="]));
        expect(compiled.env).not.toHaveProperty("DOCKER_CERT_PATH");
        expect(compiled.env).not.toHaveProperty("DOCKER_TLS_VERIFY");
    });

    it("resolves relative PATH and configuration once against capture cwd", () => {
        native.spawnSync.mockReturnValue(successful(contextMetadata()));
        const env = captureEnvironment({ PATH: "../bin", DOCKER_CONFIG: "../docker-config" });
        const before = { ...env };
        const invocation = captureNativeRuntimeInvocation("docker", { env, cwd: "/fixture/work", platform: "linux" });
        expect(invocation.executable).toBe("/fixture/bin/docker");
        expect(invocation.transport).toMatchObject({ configDirectory: "/fixture/docker-config" });
        expect(env).toEqual(before);
        native.spawnSync.mockReturnValue(successful());
        bindNativeRuntimeInvocation(invocation).spawnSync(["stop", "same-id"], { cwd: "/fixture/later-work", env: { PATH: "/fixture/later-bin" } });
        expect(native.spawnSync.mock.calls[1][0]).toBe("/fixture/bin/docker");
        expect(native.spawnSync.mock.calls[1][1]).toContain("/fixture/docker-config");
    });

    it("resolves a Windows executable through case-insensitive PATH while retaining PATHEXT and refusing command scripts", () => {
        native.access.mockImplementation((path: string) => {
            if (!/^C:\\fixture\\bin\\docker\.exe$/i.test(path)) throw Error("synthetic missing executable");
        });
        native.stat.mockImplementation((path: string) => {
            if (!/^C:\\fixture\\bin\\docker\.exe$/i.test(path)) throw Object.assign(Error("synthetic missing executable"), { code: "ENOENT" });
            return { isFile: () => true };
        });
        native.spawnSync.mockReturnValue(successful(contextMetadata("npipe:////./pipe/engine-a", { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: { Path: "C:\\fixture\\bin", PathExt: ".EXE;.CMD", USERPROFILE: "C:\\fixture\\home", DOCKER_CONFIG: "C:\\fixture\\docker-config" }, cwd: "C:\\fixture\\work", platform: "win32" });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\bin\\docker.exe");
        expect(invocation.selectors.PATH).toBe("C:\\fixture\\bin");
        expect(invocation.selectors.PATHEXT).toBe(".EXE;.CMD");
        const dispatches = native.spawnSync.mock.calls.length;
        native.access.mockImplementation((path: string) => { if (!/\.cmd$/i.test(path)) throw Error("synthetic missing executable"); });
        native.stat.mockImplementation((path: string) => {
            if (!/\.cmd$/i.test(path)) throw Object.assign(Error("synthetic missing command script"), { code: "ENOENT" });
            return { isFile: () => true };
        });
        expect(() => captureNativeRuntimeInvocation("docker", { env: { PATH: "C:\\fixture\\bin", PATHEXT: ".CMD;.BAT", USERPROFILE: "C:\\fixture\\home" }, cwd: "C:\\fixture\\work", platform: "win32" })).toThrow();
        expect(native.spawnSync).toHaveBeenCalledTimes(dispatches);
    });

    it.each([
        ["USERPROFILE ahead of HOME", { HOME: "D:\\mingw-home", USERPROFILE: "C:\\Users\\native-user" }, "C:\\Users\\native-user\\.docker"],
        ["explicit DOCKER_CONFIG ahead of both homes", { HOME: "D:\\mingw-home", USERPROFILE: "C:\\Users\\native-user", DOCKER_CONFIG: "D:\\docker-config" }, "D:\\docker-config"],
        ["capture cwd when USERPROFILE is absent despite HOME", { HOME: "D:\\mingw-home" }, "C:\\fixture\\work\\.docker"],
        ["capture cwd when USERPROFILE is empty despite HOME", { HOME: "D:\\mingw-home", USERPROFILE: "" }, "C:\\fixture\\work\\.docker"],
    ] as const)("uses native Windows Docker configuration selection: %s", (_label, homeSelectors, expectedDirectory) => {
        native.access.mockImplementation((path: string) => {
            if (path.toLowerCase() !== "c:\\fixture\\bin\\docker.exe") throw Error("synthetic missing Windows executable");
        });
        native.stat.mockImplementation((path: string) => {
            if (path.toLowerCase() !== "c:\\fixture\\bin\\docker.exe") throw Object.assign(Error("synthetic missing Windows executable"), { code: "ENOENT" });
            return { isFile: () => true };
        });
        native.spawnSync.mockReturnValue(successful(contextMetadata("npipe:////./pipe/engine-a", { name: "default", tlsPath: "<IN MEMORY>" })));
        const env: NodeJS.ProcessEnv = { PATH: "C:\\fixture\\bin", PATHEXT: ".EXE", ...homeSelectors };
        const before = { ...env };
        const invocation = captureNativeRuntimeInvocation("docker", { env, cwd: "C:\\fixture\\work", platform: "win32" });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\bin\\docker.exe");
        expect(invocation.transport).toMatchObject({ kind: "docker", configDirectory: expectedDirectory });
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
        expect(native.spawnSync.mock.calls[0][1]).toEqual(["--config", expectedDirectory, "context", "inspect", "--format", "{{json .}}"]);
        expect(flagValue(compileNativeRuntimeInvocation(invocation, ["stop", "same-id"]).args, "--config")).toBe(expectedDirectory);
        expect(invocation.selectors.HOME).toBe(env.HOME);
        expect(invocation.selectors.USERPROFILE).toBe(env.USERPROFILE ?? null);
        expect(invocation.selectors.DOCKER_CONFIG).toBe(env.DOCKER_CONFIG ?? null);
        expect(env).toEqual(before);
    });

    it("keeps non-TLS native execution non-TLS after ambient TLS/context/PATH/cwd changes", () => {
        native.spawnSync.mockReturnValueOnce(successful(contextMetadata("unix:///fixture/engine-a.sock", { name: "default", tlsPath: "<IN MEMORY>" })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" });
        const bound = bindNativeRuntimeInvocation(invocation);
        vi.stubEnv("DOCKER_TLS", "1"); vi.stubEnv("DOCKER_TLS_VERIFY", "1"); vi.stubEnv("DOCKER_CONTEXT", "native-b"); vi.stubEnv("PATH", "/fixture/replacement-bin");
        native.spawnSync.mockImplementation((_executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
            // Docker treats presence of --tlsverify, including '=false', as enabling TLS.
            const verifyFlagPresent = args.some(arg => arg === "--tlsverify" || arg.startsWith("--tlsverify="));
            const tls = verifyFlagPresent || flagValue(args, "--tls") === "true" || Boolean(options.env.DOCKER_TLS || options.env.DOCKER_TLS_VERIFY);
            return successful(JSON.stringify({ tls, host: flagValue(args, "--host") }));
        });
        const result = bound.spawnSync(["inspect", "same-id"], { encoding: "utf8", cwd: "/fixture/other-work" });
        expect(JSON.parse(String(result.stdout))).toEqual({ tls: false, host: "unix:///fixture/engine-a.sock" });
        expect(native.spawnSync.mock.calls[1][0]).toBe("/fixture/bin/docker");
        expect(native.spawnSync.mock.calls[1][1]).toEqual(["--config", "/fixture/docker-config", "--host", "unix:///fixture/engine-a.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey=", "inspect", "same-id"]);
        expect(native.spawnSync.mock.calls[1][2].env.PATH).toBe("/fixture/bin");
        expect(native.spawnSync.mock.calls[1][2].env).not.toHaveProperty("DOCKER_CONTEXT");
    });

    it.each([["non-JSON", "not JSON"], ["array", "[]"], ["incomplete", "{}"], ["invalid host", contextMetadata("--host=other")], ["oversized", "x".repeat(512 * 1024 + 1)]])("refuses %s metadata and allows a fresh capture", (_label, metadata) => {
        native.spawnSync.mockReturnValueOnce(successful(metadata));
        expect(() => captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" })).toThrow();
        native.spawnSync.mockReturnValueOnce(successful(contextMetadata()));
        expect(captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" }).transport).toMatchObject({ host: "unix:///fixture/engine-a.sock" });
        expect(native.spawnSync).toHaveBeenCalledTimes(2);
    });

    it.each(["cert.pem", "key.pem"])("retains TLS but ignores a named context's lone %s as native client authentication does", file => {
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { material: [file] })));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_CONTEXT: "native-a" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toMatchObject({ tls: { enabled: true, verify: true, caFile: null, certFile: null, keyFile: null } });
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
    });

    it("refuses an asymmetric default-context client pair without dropping a native default flag", () => {
        native.stat.mockImplementation((path: string) => {
            if (path === "/fixture/docker-config/key.pem") throw Object.assign(Error("synthetic missing key"), { code: "ENOENT" });
            return { isFile: () => true };
        });
        native.spawnSync.mockReturnValue(successful(contextMetadata("tcp://engine-a.test:2376", { name: "default", tlsPath: "<IN MEMORY>" })));
        expect(() => captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ DOCKER_TLS: "1" }), cwd: "/fixture/work", platform: "linux" })).toThrow();
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
    });

    it("refuses missing executables and sanitizes failed native metadata without copying stderr", () => {
        native.access.mockImplementation(() => { throw Error("synthetic missing executable"); });
        expect(() => captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" })).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
        native.access.mockImplementation(() => {});
        native.spawnSync.mockReturnValue({ ...successful(), status: 1, stderr: "synthetic-private-material\n".repeat(1000) });
        let failure: unknown;
        try { captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" }); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("synthetic-private-material");
        expect(String(failure).length).toBeLessThan(1000);
    });

    it("refuses oversized selectors before executing metadata and does not retain a failed capture", () => {
        expect(() => captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ HTTP_PROXY: "é".repeat(4097) }), cwd: "/fixture/work", platform: "linux" })).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
        native.spawnSync.mockReturnValue(successful(contextMetadata()));
        const invocation = captureNativeRuntimeInvocation("docker", { env: captureEnvironment({ HTTP_PROXY: "" }), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.selectors.HTTP_PROXY).toBe("");
        expect(invocation.selectors.HTTPS_PROXY).toBeNull();
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
    });

    it("sanitizes thrown metadata errors while allowing the next capture to retry", () => {
        native.spawnSync.mockImplementationOnce(() => { throw Error("synthetic-private-material\n".repeat(1000)); });
        let failure: unknown;
        try { captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" }); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("synthetic-private-material");
        expect(String(failure).length).toBeLessThan(1000);
        native.spawnSync.mockReturnValueOnce(successful(contextMetadata()));
        expect(captureNativeRuntimeInvocation("docker", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" }).runtime).toBe("docker");
        expect(native.spawnSync).toHaveBeenCalledTimes(2);
    });
});

describe("modeled native Windows executable search", () => {
    // libuv search_path tries cwd, then each native PATH directory; these
    // fixtures declare existing files rather than implementing a resolver.
    function files(...available: string[]): void {
        const existing = new Set(available.map(path => path.toLowerCase()));
        const requireFile = (path: string) => {
            if (!existing.has(path.toLowerCase())) throw Object.assign(Error("synthetic missing Windows file"), { code: "ENOENT" });
        };
        native.access.mockImplementation(requireFile);
        native.stat.mockImplementation((path: string) => { requireFile(path); return { isFile: () => true }; });
        native.spawnSync.mockReturnValue(successful(contextMetadata("npipe:////./pipe/engine-a", { name: "default", tlsPath: "<IN MEMORY>" })));
    }

    it.each(["docker", "podman"] as const)("captures %s from cwd when PATH has no matching executable", runtime => {
        files("C:\\fixture\\work\\" + runtime + ".EXE");
        if (runtime === "podman") native.spawnSync.mockReturnValue(successful(podmanInfo(false, {
            graphRoot: "C:\\fixture\\store", runRoot: "C:\\fixture\\run",
        })));
        const invocation = captureNativeRuntimeInvocation(runtime, {
            env: { USERPROFILE: "C:\\fixture\\home" }, cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\work\\" + runtime + ".exe");
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
        expect(native.spawnSync.mock.calls[0][0]).toBe(invocation.executable);
        expect(native.spawnSync.mock.calls[0][2].cwd).toBe("C:\\fixture\\work");
    });

    it("prefers cwd EXE over a COM in a later PATH directory", () => {
        files("C:\\fixture\\work\\docker.EXE", "C:\\fixture\\bin\\docker.COM");
        const invocation = captureNativeRuntimeInvocation("docker", {
            env: { PATH: "C:\\fixture\\bin", USERPROFILE: "C:\\fixture\\home" },
            cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\work\\docker.exe");
    });

    it.each([
        ["NoDefaultCurrentDirectoryInExePath", ""],
        ["nodefaultcurrentdirectoryinexepath", "0"],
        ["nOdEfAuLtCuRrEnTdIrEcToRyInExEpAtH", "ignored"],
    ] as const)("suppresses implicit cwd by presence of %s even with value %j", (key, value) => {
        files("C:\\fixture\\work\\docker.EXE", "C:\\fixture\\bin\\docker.EXE");
        const invocation = captureNativeRuntimeInvocation("docker", {
            env: { PATH: "C:\\fixture\\bin", USERPROFILE: "C:\\fixture\\home", [key]: value },
            cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\bin\\docker.exe");
    });

    it.each([
        [".;C:\\fixture\\bin", "C:\\fixture\\work\\docker.EXE"],
        ['"";C:\\fixture\\bin', "C:\\fixture\\work\\docker.EXE"],
        [".\\native;C:\\fixture\\bin", "C:\\fixture\\work\\native\\docker.EXE"],
    ] as const)("honors explicit relative or quoted-empty PATH entry %s when implicit cwd is suppressed", (path, expected) => {
        files(expected, "C:\\fixture\\bin\\docker.EXE");
        const invocation = captureNativeRuntimeInvocation("docker", {
            env: { PATH: path, USERPROFILE: "C:\\fixture\\home", NoDefaultCurrentDirectoryInExePath: "" },
            cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe(expected.toLowerCase());
    });

    it("skips raw empty Windows PATH entries instead of restoring suppressed cwd", () => {
        files("C:\\fixture\\work\\docker.EXE");
        expect(() => captureNativeRuntimeInvocation("docker", {
            env: { PATH: ";;", USERPROFILE: "C:\\fixture\\home", NoDefaultCurrentDirectoryInExePath: "0" },
            cwd: "C:\\fixture\\work", platform: "win32",
        })).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
    });

    it.each([undefined, "", ".EXE;.COM", ".CMD;.BAT"])("prefers native COM before EXE regardless of PATHEXT %j", extensionSelection => {
        files("C:\\fixture\\bin\\docker.COM", "C:\\fixture\\bin\\docker.EXE", "C:\\fixture\\bin\\docker.CMD");
        const invocation = captureNativeRuntimeInvocation("docker", {
            env: { PATH: "C:\\fixture\\bin", PATHEXT: extensionSelection, USERPROFILE: "C:\\fixture\\home" },
            cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\bin\\docker.com");
        expect(invocation.selectors.PATHEXT).toBe(extensionSelection ?? null);
    });

    it("finds literal lowercase native suffixes in a Windows directory with case-sensitive file names", () => {
        const com = "C:\\fixture\\case-sensitive\\docker.com";
        const exe = "C:\\fixture\\case-sensitive\\docker.exe";
        const available = new Set([com, exe]);
        native.access.mockImplementation((path: string) => {
            if (!available.has(path)) throw Object.assign(Error("synthetic exact-case file absent"), { code: "ENOENT" });
        });
        native.stat.mockImplementation((path: string) => {
            if (!available.has(path)) throw Object.assign(Error("synthetic exact-case file absent"), { code: "ENOENT" });
            return { isFile: () => true };
        });
        native.spawnSync.mockReturnValue(successful(contextMetadata("npipe:////./pipe/engine-a", { name: "default", tlsPath: "<IN MEMORY>" })));
        const options = { env: { PATH: "C:\\fixture\\case-sensitive", PATHEXT: ".EXE;.COM", USERPROFILE: "C:\\fixture\\home" },
            cwd: "C:\\fixture\\work", platform: "win32" as const };
        expect(captureNativeRuntimeInvocation("docker", options).executable).toBe(com);
        available.delete(com);
        expect(captureNativeRuntimeInvocation("docker", options).executable).toBe(exe);
        expect(native.spawnSync.mock.calls.map(call => call[0])).toEqual([com, exe]);
    });

    it.each(['"C:\\fixture\\bin with spaces;semi"', "'C:\\fixture\\bin with spaces;semi'"])("honors quoted Windows PATH directory %s including its semicolon", quotedDirectory => {
        files("C:\\fixture\\bin with spaces;semi\\docker.EXE", "C:\\fixture\\later\\docker.EXE");
        const invocation = captureNativeRuntimeInvocation("docker", {
            env: { PATH: quotedDirectory + ";C:\\fixture\\later", USERPROFILE: "C:\\fixture\\home" },
            cwd: "C:\\fixture\\work", platform: "win32",
        });
        expect(invocation.executable.toLowerCase()).toBe("c:\\fixture\\bin with spaces;semi\\docker.exe");
        expect(native.spawnSync.mock.calls[0][0]).toBe(invocation.executable);
    });
});

describe("native Podman capture", () => {
    it("keeps actual local mode without a socket service after late remote selectors and preserves captured store options", () => {
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(false, { transientStore: true, graphOptions: { "overlay.mountopt": "nodev", "overlay.mount_program": { Executable: "/fixture/bin/fuse-overlayfs", Version: "synthetic" }, "overlay.imagestore": "/fixture/images/a", "overlay.additionalImageStores": ["/fixture/images/a", "/fixture/images/b"] } })));
        const invocation = captureNativeRuntimeInvocation("podman", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toEqual({ kind: "podman-local", graphRoot: "/fixture/store", runRoot: "/fixture/run", storageDriver: "overlay", storageOptions: ["overlay.imagestore=/fixture/images/a", "overlay.imagestore=/fixture/images/b", "overlay.mount_program=/fixture/bin/fuse-overlayfs", "overlay.mountopt=nodev"], transientStore: true });
        expect(native.spawnSync).toHaveBeenCalledExactlyOnceWith("/fixture/bin/podman", ["info", "--format", "json"], expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 }));
        vi.stubEnv("CONTAINER_HOST", "ssh://engine-b.test/run/podman.sock"); vi.stubEnv("CONTAINER_CONNECTION", "native-b"); vi.stubEnv("CONTAINER_SSHKEY", "/fixture/identities/b"); vi.stubEnv("PATH", "/fixture/native-b-bin");
        native.spawnSync.mockReturnValue(successful("local-store-a"));
        const result = bindNativeRuntimeInvocation(invocation).spawnSync(["inspect", "same-id"], { encoding: "utf8", cwd: "/fixture/later-work" });
        expect(result.stdout).toBe("local-store-a");
        expect(native.spawnSync.mock.calls[1][0]).toBe("/fixture/bin/podman");
        expect(native.spawnSync.mock.calls[1][1]).toEqual(["--remote=false", "--root", "/fixture/store", "--runroot", "/fixture/run", "--storage-driver", "overlay", "--storage-opt", "overlay.imagestore=/fixture/images/a", "--storage-opt", "overlay.imagestore=/fixture/images/b", "--storage-opt", "overlay.mount_program=/fixture/bin/fuse-overlayfs", "--storage-opt", "overlay.mountopt=nodev", "--transient-store=true", "inspect", "same-id"]);
        for (const key of ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) expect(native.spawnSync.mock.calls[1][2].env).not.toHaveProperty(key);
        expect(native.exists).not.toHaveBeenCalled();
        expect(native.mkdtemp).not.toHaveBeenCalled();
    });

    it("normalizes legacy scalar image-store/mount-program options and older absent storage fields", () => {
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(false, { graphOptions: { "overlay.mount_program": "/fixture/bin/fuse-overlayfs", "overlay.imagestore": "/fixture/images/legacy" } })));
        const legacy = captureNativeRuntimeInvocation("podman", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" });
        expect(legacy.transport).toMatchObject({ storageOptions: ["overlay.imagestore=/fixture/images/legacy", "overlay.mount_program=/fixture/bin/fuse-overlayfs"], transientStore: false });
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(false)));
        expect(captureNativeRuntimeInvocation("podman", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" }).transport).toMatchObject({ storageOptions: [], transientStore: false });
    });

    it("selects connection metadata ahead of HOST and SSHKEY, retaining machine and TLS references", () => {
        const originalDirectory = actualFs.mkdtempSync(join(tmpdir(), "ccc-original-connection-fixture-"));
        const originalPath = join(originalDirectory, "connections.json");
        const originalBytes = JSON.stringify({ fixture: "owned original connection metadata" });
        actualFs.writeFileSync(originalPath, originalBytes, { mode: 0o600 });
        try {
        const env = captureEnvironment({ CONTAINER_CONNECTION: "native-a", CONTAINER_HOST: "ssh://ambient-b.test/run/podman.sock", CONTAINER_SSHKEY: "/fixture/identities/b", PODMAN_CONNECTIONS_CONF: originalPath, CONTAINER_PROXY: "socks5://proxy.test:1080" });
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(true))).mockReturnValueOnce(successful(JSON.stringify([connectionMetadata(), connectionMetadata({ Name: "native-b", URI: "ssh://engine-b.test/run/podman.sock", Default: false })])));
        const invocation = captureNativeRuntimeInvocation("podman", { env, cwd: "/fixture/work", platform: "linux" });
        expect(invocation.transport).toEqual({ kind: "podman-remote", url: "ssh://builder@engine-a.test:2201/run/podman.sock", identityFile: "/fixture/identities/engine-a", machine: true, tls: { caFile: "/fixture/tls/ca.pem", certFile: "/fixture/tls/cert.pem", keyFile: "/fixture/tls/key.pem" } });
        expect(invocation.selectors.PODMAN_CONNECTIONS_CONF).toBe(originalPath);
        expect(invocation.selectors.CONTAINER_PROXY).toBe("socks5://proxy.test:1080");
        expect(native.spawnSync.mock.calls.map(call => call[1])).toEqual([["info", "--format", "json"], ["system", "connection", "list", "--format", "json"]]);
        for (const [, , options] of native.spawnSync.mock.calls) expect(options).toMatchObject({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 });
        env.CONTAINER_CONNECTION = "native-b"; env.CONTAINER_HOST = "ssh://engine-b.test/run/podman.sock"; env.PATH = "/fixture/native-b-bin";
        let observed: ReturnType<typeof readCapsule> | undefined;
        native.spawnSync.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { observed = readCapsule(options); return successful(); });
        bindNativeRuntimeInvocation(invocation).spawnSync(["stop", "same-id"], { env, cwd: "/fixture/later-work" });
        expect(observed?.value).toEqual({ Connection: { Default: "ccc-captured-native-runtime", Connections: { "ccc-captured-native-runtime": { URI: "ssh://builder@engine-a.test:2201/run/podman.sock", Identity: "/fixture/identities/engine-a", IsMachine: true, TLSCA: "/fixture/tls/ca.pem", TLSCert: "/fixture/tls/cert.pem", TLSKey: "/fixture/tls/key.pem" } } } });
        expect(native.spawnSync.mock.calls[2][0]).toBe("/fixture/bin/podman");
        expect(native.spawnSync.mock.calls[2][1]).toEqual(["--remote=true", "--connection", "ccc-captured-native-runtime", "stop", "same-id"]);
        expect(native.spawnSync.mock.calls[2][2].env.CONTAINER_PROXY).toBe("socks5://proxy.test:1080");
        expect(native.spawnSync.mock.calls[2][2].env).not.toHaveProperty("CONTAINER_HOST");
        expect(observed?.path).not.toBe(originalPath);
        expect(actualFs.existsSync(observed!.path)).toBe(false);
        expect(actualFs.readFileSync(originalPath, "utf8")).toBe(originalBytes);
        expect(native.spawnSync).toHaveBeenCalledTimes(3);
        } finally { actualFs.rmSync(originalDirectory, { recursive: true, force: true }); }
    });

    it("uses HOST with SSHKEY directly and older selected connection defaults with empty-identity fallback", () => {
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(true)));
        const direct = captureNativeRuntimeInvocation("podman", { env: captureEnvironment({ CONTAINER_HOST: "ssh://engine-a.test/run/podman.sock", CONTAINER_SSHKEY: "../identities/a" }), cwd: "/fixture/work", platform: "linux" });
        expect(direct.transport).toEqual({ kind: "podman-remote", url: "ssh://engine-a.test/run/podman.sock", identityFile: "/fixture/identities/a", machine: false, tls: { caFile: null, certFile: null, keyFile: null } });
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(true))).mockReturnValueOnce(successful(JSON.stringify([{ Name: "older-default", URI: "ssh://default-a.test/run/podman.sock", Identity: "", Default: true }])));
        const older = captureNativeRuntimeInvocation("podman", { env: captureEnvironment({ CONTAINER_SSHKEY: "/fixture/identities/fallback" }), cwd: "/fixture/work", platform: "linux" });
        expect(older.transport).toEqual({ kind: "podman-remote", url: "ssh://default-a.test/run/podman.sock", identityFile: "/fixture/identities/fallback", machine: false, tls: { caFile: null, certFile: null, keyFile: null } });
        expect(native.spawnSync).toHaveBeenCalledTimes(3);
    });

    it.each([
        ["missing actual client mode", JSON.stringify({ host: {}, store: { graphRoot: "/fixture/store", runRoot: "/fixture/run", graphDriverName: "overlay" } })],
        ["malformed client mode", JSON.stringify({ host: { serviceIsRemote: "false" }, store: {} })],
        ["unsupported graph-options shape", podmanInfo(false, { graphOptions: ["overlay.mountopt=nodev"] })],
        ["unsupported option structure", podmanInfo(false, { graphOptions: { "overlay.unknown": { Arbitrary: "unsupported" } } })],
        ["malformed transient store", podmanInfo(false, { transientStore: "true" })],
        ["more than 128 storage options", podmanInfo(false, { graphOptions: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`overlay.option${index}`, "value"])) })],
    ])("refuses %s before a native operation", (_label, metadata) => {
        native.spawnSync.mockReturnValue(successful(metadata));
        expect(() => captureNativeRuntimeInvocation("podman", { env: captureEnvironment(), cwd: "/fixture/work", platform: "linux" })).toThrow();
        expect(native.spawnSync).toHaveBeenCalledTimes(1);
        expect(native.mkdtemp).not.toHaveBeenCalled();
    });

    it.each([
        ["missing selected connection", []],
        ["malformed machine mode", [connectionMetadata({ IsMachine: "true" })]],
        ["malformed TLS reference", [connectionMetadata({ TLSCA: 4 })]],
        ["asymmetric TLS credentials", [connectionMetadata({ TLSKey: "" })]],
    ])("refuses remote %s without guessing another connection", (_label, connections) => {
        native.spawnSync.mockReturnValueOnce(successful(podmanInfo(true))).mockReturnValueOnce(successful(JSON.stringify(connections)));
        expect(() => captureNativeRuntimeInvocation("podman", { env: captureEnvironment({ CONTAINER_CONNECTION: "native-a" }), cwd: "/fixture/work", platform: "linux" })).toThrow();
        expect(native.spawnSync).toHaveBeenCalledTimes(2);
        expect(native.mkdtemp).not.toHaveBeenCalled();
    });
});

describe("private Podman connection replay", () => {
    it("uses a private exclusive capsule of references, removes it after sync return and preserves the original result", () => {
        const original = { ...process.env };
        const raw = { ...successful("native output"), status: 17, signal: "SIGTERM" as const };
        let observed: ReturnType<typeof readCapsule> | undefined;
        native.spawnSync.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
            observed = readCapsule(options);
            if (process.platform !== "win32") {
                expect(actualFs.statSync(dirname(observed.path)).mode & 0o777).toBe(0o700);
                expect(actualFs.statSync(observed.path).mode & 0o777).toBe(0o600);
            }
            return raw;
        });
        const bound = bindNativeRuntimeInvocation(remotePodmanRecord());
        expect(bound.spawnSync(["inspect", "same-id"], { encoding: "utf8" })).toBe(raw);
        expect(native.write).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ flag: "wx", mode: 0o600 }));
        expect(observed).toBeDefined();
        expect(actualFs.existsSync(observed!.path)).toBe(false);
        expect(JSON.stringify(bound.invocation)).not.toContain(observed!.path);
        expect(process.env).toEqual(original);
    });

    it("keeps two simultaneous remote children on separate capsules and cleans only the child that closes", () => {
        const first = new EventEmitter() as ChildProcess;
        const second = new EventEmitter() as ChildProcess;
        const seen: Array<ReturnType<typeof readCapsule>> = [];
        native.spawn.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { seen.push(readCapsule(options)); return seen.length === 1 ? first : second; });
        const a = remotePodmanRecord();
        const b = { ...remotePodmanRecord(), transport: { ...remotePodmanRecord().transport, kind: "podman-remote" as const, url: "ssh://engine-b.test/run/podman.sock" } } as NativeRuntimeInvocation;
        expect(bindNativeRuntimeInvocation(a).spawn(["exec", "same-id", "true"])).toBe(first);
        expect(bindNativeRuntimeInvocation(b).spawn(["exec", "same-id", "true"])).toBe(second);
        expect(seen[0].path).not.toBe(seen[1].path);
        expect(JSON.stringify(seen[0].value)).toContain("ssh://builder@example.test:2201/run/user/1000/podman.sock");
        expect(JSON.stringify(seen[1].value)).toContain("ssh://engine-b.test/run/podman.sock");
        first.emit("close", 0, null);
        expect(actualFs.existsSync(seen[0].path)).toBe(false);
        expect(actualFs.existsSync(seen[1].path)).toBe(true);
        second.emit("close", 0, null);
        expect(actualFs.existsSync(seen[1].path)).toBe(false);
    });

    it("preserves native async error delivery and retains the capsule until terminal close", () => {
        const child = new EventEmitter() as ChildProcess;
        const onError = vi.fn(); child.on("error", onError);
        let observed: ReturnType<typeof readCapsule> | undefined;
        native.spawn.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { observed = readCapsule(options); return child; });
        expect(bindNativeRuntimeInvocation(remotePodmanRecord()).spawn(["stop", "same-id"])).toBe(child);
        expect(child.listenerCount("error")).toBe(1);
        const error = Error("original child error"); child.emit("error", error);
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(actualFs.existsSync(observed!.path)).toBe(true);
        child.emit("close", null, "SIGTERM"); child.emit("close", null, "SIGTERM");
        expect(actualFs.existsSync(observed!.path)).toBe(false);
        expect(native.remove).toHaveBeenCalledTimes(1);
    });

    it("dispatches nothing when capsule creation fails and removes a partially created directory", () => {
        const bound = bindNativeRuntimeInvocation(remotePodmanRecord());
        native.mkdtemp.mockImplementationOnce(() => { throw Error("synthetic directory refusal"); });
        expect(() => bound.spawnSync(["stop", "same-id"])).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
        let directory = "";
        native.mkdtemp.mockImplementation((prefix: string) => { directory = actualFs.mkdtempSync(prefix); return directory; });
        native.write.mockImplementationOnce(() => { throw Error("synthetic exclusive-file refusal"); });
        expect(() => bound.spawnSync(["stop", "same-id"])).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
        expect(directory).not.toBe("");
        expect(actualFs.existsSync(directory)).toBe(false);
    });

    it.each(["sync", "async"] as const)("preserves the original %s launch error and removes its capsule", mode => {
        const failure = Error("original native launch failure");
        native.spawnSync.mockImplementation(() => { throw failure; }); native.spawn.mockImplementation(() => { throw failure; });
        const bound = bindNativeRuntimeInvocation(remotePodmanRecord());
        let caught: unknown;
        try { if (mode === "sync") bound.spawnSync(["stop", "same-id"]); else bound.spawn(["stop", "same-id"]); }
        catch (error) { caught = error; }
        expect(caught).toBe(failure);
        const directory = native.mkdtemp.mock.results[0].value as string;
        expect(actualFs.existsSync(directory)).toBe(false);
    });

    it.each([false, true])("cleanup failure preserves original native result/error, throws=%s", throws => {
        const failure = Error("original native failure"); const raw = successful("original result");
        native.spawnSync.mockImplementation(() => { if (throws) throw failure; return raw; });
        native.remove.mockImplementation(() => { throw Error("synthetic cleanup refusal"); });
        let caught: unknown; let returned: unknown;
        try { returned = bindNativeRuntimeInvocation(remotePodmanRecord()).spawnSync(["stop", "same-id"]); }
        catch (error) { caught = error; }
        const directory = native.mkdtemp.mock.results[0].value as string;
        try {
            if (throws) expect(caught).toBe(failure);
            else { expect(caught).toBeUndefined(); expect(returned).toBe(raw); }
            expect(native.remove).toHaveBeenCalledTimes(1);
        } finally { actualFs.rmSync(directory, { recursive: true, force: true }); }
    });
});

describe("captured native invocation validation", () => {
    it("reuses only validator-owned frozen snapshots across binding and repeated validation", () => {
        const wire = dockerRecord();
        const owned = validateNativeRuntimeInvocation(wire);
        expect(validateNativeRuntimeInvocation(owned)).toBe(owned);
        expect(bindNativeRuntimeInvocation(owned).invocation).toBe(owned);

        const frozenForeign = Object.freeze({ ...dockerRecord(),
            selectors: Object.freeze({ ...selectors() }),
            transport: Object.freeze({ kind: "docker" as const, host: "unix:///fixture/engine-a.sock", configDirectory: "/fixture/home/.docker",
                tls: Object.freeze({ enabled: false, verify: false, caFile: null, certFile: null, keyFile: null }) }),
        });
        const copied = validateNativeRuntimeInvocation(frozenForeign);
        expect(copied).not.toBe(frozenForeign);
        expect(copied.transport).not.toBe(frozenForeign.transport);
        expect(copied.selectors).not.toBe(frozenForeign.selectors);
        expect(() => validateNativeRuntimeInvocation(Object.freeze({ ...frozenForeign, unexpected: true }))).toThrow();
    });

    it("retains the validated identity through nested async scopes and repeated native dispatch", async () => {
        const owned = validateNativeRuntimeInvocation(dockerRecord());
        native.spawnSync.mockImplementation((_program, args: string[]) => successful(args.includes("--version")
            ? "Docker version 27.0.0\n" : args.includes("{{.OperatingSystem}}") ? "Fixture Linux\n" : "[]"));
        await runWithNativeRuntimeInvocation(owned, async () => {
            expect(currentNativeRuntimeInvocation()).toBe(owned);
            expect(getRuntimeInvocation()).toBe(owned);
            const observedCapabilities = getRuntimeInfo();
            await Promise.resolve();
            await runWithNativeRuntimeInvocation(getRuntimeInvocation(), async () => {
                expect(currentNativeRuntimeInvocation()).toBe(owned);
                expect(getRuntimeInfo()).toBe(observedCapabilities);
                runtimeSpawnSync(["inspect", "same-id"]);
                await Promise.resolve();
                expect(currentNativeRuntimeInvocation()).toBe(owned);
            });
            expect(currentNativeRuntimeInvocation()).toBe(owned);
            expect(getRuntimeInfo()).toBe(observedCapabilities);
            runtimeSpawnSync(["stop", "same-id"]);
        });
        expect(native.spawnSync.mock.calls.filter(call => call[1].includes("--version"))).toHaveLength(1);
        expect(native.spawnSync.mock.calls.filter(call => call[1].includes("{{.OperatingSystem}}"))).toHaveLength(1);
        expect(native.spawnSync.mock.calls.filter(call => call[1].includes("{{json .SecurityOptions}}"))).toHaveLength(process.platform === "linux" ? 1 : 0);
        expect(native.spawnSync.mock.calls.filter(call => call[1].includes("same-id"))).toHaveLength(2);
        for (const [, args] of native.spawnSync.mock.calls) expect(flagValue(args, "--host")).toBe("unix:///fixture/engine-a.sock");
        expect(currentNativeRuntimeInvocation()).toBeFalsy();
    });

    it.each([dockerRecord(), localPodmanRecord(), remotePodmanRecord()])("snapshots and deeply freezes the $transport.kind authority", record => {
        const wire = JSON.parse(JSON.stringify(record)) as NativeRuntimeInvocation;
        const snapshot = validateNativeRuntimeInvocation(wire);
        expect(snapshot).toEqual(record);
        expect(snapshot).not.toBe(wire);
        expect(snapshot.transport).not.toBe(wire.transport);
        expect(snapshot.selectors).not.toBe(wire.selectors);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.transport)).toBe(true);
        expect(Object.isFrozen(snapshot.selectors)).toBe(true);
        if (snapshot.transport.kind !== "podman-local") expect(Object.isFrozen(snapshot.transport.tls)).toBe(true);
        else expect(Object.isFrozen(snapshot.transport.storageOptions)).toBe(true);
        Reflect.set(wire, "executable", "/fixture/bin/replacement");
        Reflect.set(wire.selectors, "HOME", "/replacement/home");
        Reflect.set(wire.transport, "host", "unix:///replacement.sock");
        expect(snapshot).toEqual(record);
        expect(() => Reflect.set(snapshot.selectors, "HOME", "/replacement/home")).not.toThrow();
        expect(snapshot.selectors.HOME).toBe("/fixture/home");
        expect(JSON.parse(JSON.stringify(snapshot)).selectors.DOCKER_HOST).toBeNull();
    });

    const invalid = [
        ["unsupported version", (value: Record<string, unknown>) => { value.version = 2; }],
        ["unknown root field", (value: Record<string, unknown>) => { value.argv = ["--host", "tcp://other.test"]; }],
        ["relative executable", (value: Record<string, unknown>) => { value.executable = "docker"; }],
        ["runtime/transport mismatch", (value: Record<string, unknown>) => { value.runtime = "podman"; }],
        ["unknown transport field", (value: Record<string, unknown>) => { (value.transport as Record<string, unknown>).args = ["--context", "other"]; }],
        ["missing selector", (value: Record<string, unknown>) => { Reflect.deleteProperty(value.selectors as object, "DOCKER_HOST"); }],
        ["arbitrary environment selector", (value: Record<string, unknown>) => { (value.selectors as Record<string, unknown>).AWS_SECRET_ACCESS_KEY = "synthetic-private-value"; }],
        ["undefined absence", (value: Record<string, unknown>) => { (value.selectors as Record<string, unknown>).DOCKER_CONTEXT = undefined; }],
        ["non-string selector", (value: Record<string, unknown>) => { (value.selectors as Record<string, unknown>).HOME = 7; }],
        ["unknown TLS field", (value: Record<string, unknown>) => { ((value.transport as Record<string, unknown>).tls as Record<string, unknown>).certificateBytes = "synthetic-private-value"; }],
        ["relative TLS path", (value: Record<string, unknown>) => { ((value.transport as Record<string, unknown>).tls as Record<string, unknown>).caFile = "ca.pem"; }],
        ["missing TLS field", (value: Record<string, unknown>) => { Reflect.deleteProperty((value.transport as Record<string, unknown>).tls as object, "keyFile"); }],
        ["non-boolean TLS setting", (value: Record<string, unknown>) => { ((value.transport as Record<string, unknown>).tls as Record<string, unknown>).verify = "true"; }],
        ["NUL selector", (value: Record<string, unknown>) => { (value.selectors as Record<string, unknown>).HOME = "/fixture/\0home"; }],
        ["newline endpoint", (value: Record<string, unknown>) => { (value.transport as Record<string, unknown>).host = "unix:///fixture/a.sock\n--context=other"; }],
        ["oversized UTF-8 value", (value: Record<string, unknown>) => { (value.selectors as Record<string, unknown>).HOME = "é".repeat(4097); }],
        ["oversized record", (value: Record<string, unknown>) => { for (const key of NATIVE_RUNTIME_SELECTOR_KEYS.slice(0, 9)) (value.selectors as Record<string, unknown>)[key] = "a".repeat(8192); }],
    ] as const;
    it.each(invalid)("rejects %s before any native dispatch", (_label, mutate) => {
        const wire = JSON.parse(JSON.stringify(dockerRecord())) as Record<string, unknown>;
        mutate(wire);
        expect(() => validateNativeRuntimeInvocation(wire)).toThrow();
        try { validateNativeRuntimeInvocation(wire); }
        catch (error) {
            expect(String(error)).not.toContain("synthetic-private-value");
            expect(String(error).length).toBeLessThan(1000);
        }
        expect(() => bindNativeRuntimeInvocation(wire as unknown as NativeRuntimeInvocation)).toThrow();
        expect(native.spawnSync).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it.each([null, [], "docker", 1])("rejects a non-record invocation %s", value => {
        expect(() => validateNativeRuntimeInvocation(value)).toThrow();
    });

    it("accepts exactly 8192 UTF-8 bytes and rejects oversized remote identity paths", () => {
        const record = dockerRecord();
        const accepted = { ...record, selectors: { ...record.selectors, NO_PROXY: "é".repeat(4096) } };
        expect(validateNativeRuntimeInvocation(accepted).selectors.NO_PROXY).toBe("é".repeat(4096));
        const remote = remotePodmanRecord();
        expect(() => validateNativeRuntimeInvocation({ ...remote, transport: { ...remote.transport, identityFile: `/${"a".repeat(8192)}` } })).toThrow();
    });

    it("rejects incomplete Podman modes and unsupported endpoint selectors", () => {
        const local = localPodmanRecord();
        const remote = remotePodmanRecord();
        expect(() => validateNativeRuntimeInvocation({ ...local, transport: { ...local.transport, graphRoot: "relative/store" } })).toThrow();
        expect(() => validateNativeRuntimeInvocation({ ...local, transport: { ...local.transport, storageDriver: "" } })).toThrow();
        expect(() => validateNativeRuntimeInvocation({ ...remote, transport: { ...remote.transport, identityFile: "relative/key" } })).toThrow();
        expect(() => validateNativeRuntimeInvocation({ ...remote, transport: { ...remote.transport, url: "--connection=other" } })).toThrow();
        const docker = dockerRecord();
        expect(() => validateNativeRuntimeInvocation({ ...docker, transport: { ...docker.transport, host: "--context=other" } })).toThrow();
    });
});

describe("bound native dispatch", () => {
    it("removes captured absent selectors and overlays finite selectors without mutating any environment", () => {
        const record = dockerRecord();
        vi.stubEnv("DOCKER_HOST", "tcp://ambient-b.test:2375");
        vi.stubEnv("DOCKER_CONTEXT", "ambient-b");
        vi.stubEnv("PATH", "/ambient/b/bin");
        const caller = { DOCKER_HOST: "tcp://caller-b.test:2375", DOCKER_CONTEXT: "caller-b", PATH: "/caller/bin", KEEP: "caller value" };
        const beforeProcess = { ...process.env };
        const compiled = compileNativeRuntimeInvocation(record, ["inspect", "id with spaces;$(literal)"], caller);
        expect(compiled.executable).toBe("/fixture/bin/docker");
        expect(compiled.env.PATH).toBe("/fixture/bin");
        expect(compiled.env.HOME).toBe("/fixture/home");
        expect(compiled.env).not.toHaveProperty("DOCKER_HOST");
        expect(compiled.env).not.toHaveProperty("DOCKER_CONTEXT");
        expect(compiled.env.KEEP).toBe("caller value");
        expect(compiled.env).not.toBe(caller);
        expect(caller).toEqual({ DOCKER_HOST: "tcp://caller-b.test:2375", DOCKER_CONTEXT: "caller-b", PATH: "/caller/bin", KEEP: "caller value" });
        expect(process.env).toEqual(beforeProcess);
        expect(compiled.args.slice(-2)).toEqual(["inspect", "id with spaces;$(literal)"]);
    });

    it("preserves synchronous result identity, options, input and signal/error details", () => {
        const failure = Object.assign(Error("synthetic executable failure"), { code: "ETIMEDOUT" });
        const raw: SpawnSyncReturns<string> = { pid: 29, output: [null, "partial", "failure"], stdout: "partial", stderr: "failure", status: null, signal: "SIGTERM", error: failure };
        native.spawnSync.mockReturnValue(raw);
        const input = Buffer.from("literal stdin\n$(not a command)");
        const environment = { KEEP: "unchanged", DOCKER_CONTEXT: "late-b" };
        const options = { input, encoding: "utf8" as const, timeout: 713, killSignal: "SIGTERM" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], cwd: "/fixture/changed-cwd", maxBuffer: 991, env: environment };
        const args = ["exec", "-i", "same-id", "printf", "%s", "space ; $() ' \\"];
        const before = { ...options, env: { ...environment }, stdio: [...options.stdio] };
        const bound = bindNativeRuntimeInvocation(dockerRecord());
        expect(bound.spawnSync(args, options)).toBe(raw);
        const call = native.spawnSync.mock.calls[0];
        expect(call[0]).toBe("/fixture/bin/docker");
        expect(call[1].slice(-args.length)).toEqual(args);
        expect(call[2]).toMatchObject({ ...options, env: expect.objectContaining({ KEEP: "unchanged", PATH: "/fixture/bin" }) });
        expect(call[2].env).not.toHaveProperty("DOCKER_CONTEXT");
        expect(call[2].input).toBe(input);
        expect(call[2]).not.toBe(options);
        expect(call[2].env).not.toBe(environment);
        expect(call[2].shell).not.toBeTruthy();
        expect(options).toEqual(before);
        expect(args).toEqual(["exec", "-i", "same-id", "printf", "%s", "space ; $() ' \\"]);
    });

    it("removes differently cased competing selectors on Windows", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const source = { Path: "C:\\ambient\\bin", PATH: "C:\\second\\bin", Docker_Host: "tcp://ambient.test:2375", dOcKeR_cOnTeXt: "ambient", Keep: "kept" };
        const compiled = compileNativeRuntimeInvocation(dockerRecord(), ["inspect", "id"], source);
        expect(Object.entries(compiled.env).filter(([key]) => key.toUpperCase() === "PATH")).toEqual([["PATH", "/fixture/bin"]]);
        expect(Object.keys(compiled.env).filter(key => ["DOCKER_HOST", "DOCKER_CONTEXT"].includes(key.toUpperCase()))).toEqual([]);
        expect(compiled.env.Keep).toBe("kept");
        expect(source.Path).toBe("C:\\ambient\\bin");
    });

    it.each([true, "/fixture/shell"])("never enables caller-supplied shell %s", shell => {
        native.spawnSync.mockReturnValue(successful());
        const bound = bindNativeRuntimeInvocation(dockerRecord());
        let rejected = false;
        try { bound.spawnSync(["inspect", "id ; $(literal)"], { shell }); } catch { rejected = true; }
        if (rejected) expect(native.spawnSync).not.toHaveBeenCalled();
        else {
            expect(native.spawnSync).toHaveBeenCalledTimes(1);
            expect(native.spawnSync.mock.calls[0][1].slice(-2)).toEqual(["inspect", "id ; $(literal)"]);
            expect(native.spawnSync.mock.calls[0][2].shell).toBe(false);
        }
    });

    it("returns the original async child and preserves stdio, AbortSignal and synchronous errors", () => {
        const child = new EventEmitter() as ChildProcess;
        native.spawn.mockReturnValue(child);
        const controller = new AbortController();
        const options = { stdio: "inherit" as const, detached: false, signal: controller.signal, cwd: "/fixture/work", windowsHide: true };
        const bound = bindNativeRuntimeInvocation(remotePodmanRecord());
        expect(bound.spawn(["exec", "-it", "same-id", "sh"], options)).toBe(child);
        expect(native.spawn.mock.calls[0][0]).toBe("/fixture/bin/podman");
        expect(native.spawn.mock.calls[0][1].slice(-4)).toEqual(["exec", "-it", "same-id", "sh"]);
        expect(native.spawn.mock.calls[0][2]).toMatchObject(options);
        expect(native.spawn.mock.calls[0][2].signal).toBe(controller.signal);
        expect(native.spawn.mock.calls[0][2].shell).not.toBeTruthy();
        child.emit("close", 0, null);
        const error = Error("original native failure");
        native.spawn.mockImplementation(() => { throw error; });
        expect(() => bound.spawn(["stop", "same-id"])).toThrow(error);
        native.spawnSync.mockImplementation(() => { throw error; });
        expect(() => bound.spawnSync(["stop", "same-id"])).toThrow(error);
    });

    it("snapshots a caller record before later mutations and keeps saved runners independent of scope", () => {
        const original = JSON.parse(JSON.stringify(dockerRecord())) as NativeRuntimeInvocation;
        const bound = bindNativeRuntimeInvocation(original);
        Reflect.set(original, "executable", "/fixture/bin/replacement");
        Reflect.set(original.transport, "host", "unix:///fixture/replacement.sock");
        Reflect.set(original.selectors, "PATH", "/replacement/bin");
        native.spawnSync.mockReturnValue(successful());
        runWithNativeRuntimeInvocation(remotePodmanRecord(), () => bound.spawnSync(["stop", "same-id"]));
        expect(bound.invocation).toEqual(dockerRecord());
        expect(Object.isFrozen(bound.invocation)).toBe(true);
        expect(native.spawnSync.mock.calls[0][0]).toBe("/fixture/bin/docker");
        expect(native.spawnSync.mock.calls[0][2].env.PATH).toBe("/fixture/bin");
    });

    it("keeps scoped public runners on captured authority after override/reset and lets later unowned calls use a new binding", async () => {
        const a = dockerRecord();
        const b = dockerRecord("unix:///fixture/engine-b.sock");
        const child = new EventEmitter() as ChildProcess;
        native.spawnSync.mockReturnValue(successful()); native.spawn.mockReturnValue(child);
        await runWithNativeRuntimeInvocation(a, async () => {
            runtimeSpawnSync(["inspect", "same-id"]);
            setRuntimeOverride("podman");
            await Promise.resolve();
            _resetRuntimeCacheForTest();
            expect(getRuntimeInvocation()).toEqual(a);
            expect(runtimeSpawn(["exec", "same-id", "true"])).toBe(child);
        });
        _setRuntimeInvocationForTest(b);
        runtimeSpawnSync(["stop", "same-id"]);
        expect(flagValue(native.spawnSync.mock.calls[0][1], "--host")).toBe("unix:///fixture/engine-a.sock");
        expect(flagValue(native.spawn.mock.calls[0][1], "--host")).toBe("unix:///fixture/engine-a.sock");
        expect(flagValue(native.spawnSync.mock.calls[1][1], "--host")).toBe("unix:///fixture/engine-b.sock");
        expect(native.spawnSync).toHaveBeenCalledTimes(2);
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("isolates two interleaved async scopes and restores outer scope after nested rejection", async () => {
        const a = validateNativeRuntimeInvocation(dockerRecord());
        const b = validateNativeRuntimeInvocation(remotePodmanRecord());
        let releaseA!: () => void;
        let releaseB!: () => void;
        const aMayContinue = new Promise<void>(resolve => { releaseA = resolve; });
        const bMayContinue = new Promise<void>(resolve => { releaseB = resolve; });
        const seen: Array<NativeRuntimeInvocation | undefined | null> = [];
        native.spawnSync.mockReturnValue(successful());
        const observeAndDispatch = () => {
            const invocation = currentNativeRuntimeInvocation();
            seen.push(invocation);
            if (!invocation) throw Error("scope unexpectedly lost its invocation");
            bindNativeRuntimeInvocation(invocation).spawnSync(["inspect", "same-id"]);
        };
        expect(currentNativeRuntimeInvocation()).toBeFalsy();
        const first = runWithNativeRuntimeInvocation(a, async () => {
            observeAndDispatch();
            releaseB();
            await aMayContinue;
            observeAndDispatch();
            await expect(runWithNativeRuntimeInvocation(b, async () => { throw Error("nested rejection"); })).rejects.toThrow("nested rejection");
            observeAndDispatch();
        });
        const second = runWithNativeRuntimeInvocation(b, async () => {
            await bMayContinue;
            observeAndDispatch();
            releaseA();
            await Promise.resolve();
            observeAndDispatch();
        });
        await Promise.all([first, second]);
        expect(seen.map(invocation => invocation?.transport.kind)).toEqual(["docker", "podman-remote", "docker", "podman-remote", "docker"]);
        expect(native.spawnSync.mock.calls.map(call => call[0])).toEqual(["/fixture/bin/docker", "/fixture/bin/podman", "/fixture/bin/docker", "/fixture/bin/podman", "/fixture/bin/docker"]);
        for (const [, args] of native.spawnSync.mock.calls) expect(args.slice(-2)).toEqual(["inspect", "same-id"]);
        expect(currentNativeRuntimeInvocation()).toBeFalsy();
    });
});
