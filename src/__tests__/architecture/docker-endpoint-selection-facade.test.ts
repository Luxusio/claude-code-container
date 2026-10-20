import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(() => false), access: vi.fn(), stat: vi.fn() }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: native.exists, accessSync: native.access, statSync: native.stat }));
import * as runtime from "../../container-runtime.js";
import { buildDockerRunArgs } from "../../docker.js";

const executable = "/fixture/bin/docker";
const configDirectory = "/fixture/docker-config";
const result = (status: number, stdout = "") => ({ status, stdout, stderr: "", signal: null });
const metadataArgs = (context?: string) => ["--config", configDirectory, "context", "inspect", "--format", "{{json .}}", ...(context ? ["--", context] : [])];
const prefix = (endpoint: string) => ["--config", configDirectory, "--host", endpoint, "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="];
const contextCalls = () => native.spawn.mock.calls.filter(call => call[1].includes("context"));

function fixture(status = 0, endpoint = "unix:///selected.sock", rawMetadata?: string) {
    let resolvedEndpoint = endpoint;
    native.spawn.mockImplementation((command: string, args: string[], options: { env: NodeJS.ProcessEnv; shell: boolean }) => {
        expect(command).toBe(executable);
        expect(options.shell).toBe(false);
        if (args.includes("context")) {
            const context = options.env.DOCKER_CONTEXT;
            expect(args).toEqual(metadataArgs(context));
            resolvedEndpoint = !context && options.env.DOCKER_HOST ? options.env.DOCKER_HOST : endpoint;
            return result(status, rawMetadata ?? JSON.stringify({
                Name: context || "default",
                Endpoints: { docker: { Host: resolvedEndpoint, SkipTLSVerify: false } },
                TLSMaterial: {},
            }));
        }
        const boundPrefix = prefix(resolvedEndpoint);
        expect(args.slice(0, boundPrefix.length)).toEqual(boundPrefix);
        for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) expect(options.env[key]).toBeUndefined();
        const logicalArgs = args.slice(boundPrefix.length);
        if (logicalArgs[0] === "--version") {
            expect(logicalArgs).toEqual(["--version"]);
            return result(0, "Docker version 27.1.1");
        }
        if (logicalArgs.at(-1) === "{{json .SecurityOptions}}") {
            expect(logicalArgs).toEqual(["info", "--format", "{{json .SecurityOptions}}"]);
            return result(0, "[]");
        }
        expect(logicalArgs).toEqual(["info", "--format", "{{.OperatingSystem}}"]);
        return result(0, "Docker Desktop");
    });
}

beforeEach(() => {
    vi.resetAllMocks(); runtime._resetRuntimeCacheForTest(); runtime._resetSelinuxCacheForTest();
    native.exists.mockReturnValue(false);
    native.access.mockImplementation((path: string) => { expect(path).toBe(executable); });
    native.stat.mockImplementation((path: string) => { expect(path).toBe(executable); return { isFile: () => true }; });
    vi.stubEnv("PATH", "/fixture/bin"); vi.stubEnv("HOME", "/fixture/home"); vi.stubEnv("DOCKER_CONFIG", configDirectory);
    for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CCC_RUNTIME_SOCKET", "WSL_DISTRO_NAME", "container", "CCC_SELINUX_RELABEL"]) vi.stubEnv(key, undefined);
    runtime.setRuntimeOverride("docker");
    vi.stubEnv("CCC_RUNTIME", "docker");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "cwd").mockReturnValue("/fixture/work");
});
afterEach(() => { runtime._resetRuntimeCacheForTest(); runtime._resetSelinuxCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native Docker endpoint composition", () => {
    it("keeps daemon namespace sockets unchanged while translating ordinary nested client paths", () => {
        for (const key of Object.keys(process.env)) if (key === "VITEST" || key.startsWith("VITEST_")) vi.stubEnv(key, undefined);
        vi.stubEnv("container", "docker"); vi.stubEnv("HOSTNAME", "ccc-parent");
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        preloadNativeRuntimeFixture(runtime, { runtime: "docker", socketPath: "/daemon/docker.sock", remote: true, dockerDesktop: false });
        native.spawn.mockImplementation((...rawCall) => {
            const [command, args] = normalizeNativeRuntimeCall(rawCall);
            expect(command).toBe("docker");
            expect(args).toEqual(["inspect", "ccc-parent", "--format", "{{json .Mounts}}"]);
            return result(0, JSON.stringify([{ Source: "/srv/daemon", Destination: "/daemon" }]));
        });
        const args = buildDockerRunArgs({
            containerName: "ccc-fixture", fullPath: "/daemon/project", projectMountPath: "/project/fixture",
            credentialMounts: [], gitIdentityMounts: [], claudeJsonFile: "/fixture/claude.json", miseVolumeName: "ccc-fixture-mise",
            pidsLimit: "-1", imageName: "ccc-fixture", hostSshDir: null, sshAgentSocket: null,
        });
        expect(args).toContain("/daemon/docker.sock:/var/run/docker.sock");
        expect(args).not.toContain(`${join("/srv/daemon", "docker.sock")}:/var/run/docker.sock`);
        expect(args).toContain(`${join("/srv/daemon", "project")}:/project/fixture`);
        expect(runtime.bindMountArgs("/daemon/project", "/target")).toEqual(["-v", `${join("/srv/daemon", "project")}:/target`]);
        expect(runtime.bindMountArgs("/daemon/docker.sock", "/target", { sourceNamespace: "daemon" })).toEqual(["-v", "/daemon/docker.sock:/target"]);
        expect(native.spawn.mock.calls.map(call => normalizeNativeRuntimeCall(call))).toEqual([
            ["docker", ["inspect", "ccc-parent", "--format", "{{json .Mounts}}"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" }],
        ]);
        expect(native.access).not.toHaveBeenCalled();
    });

    it.each(["colima", " colima ", " ", "--format=hostile"])("protects raw named context operand %j and retains cache lifetime", context => {
        fixture(); vi.stubEnv("DOCKER_CONTEXT", context); vi.stubEnv("DOCKER_HOST", "tcp://shadowed:2376");
        const first = runtime.getRuntimeInfo(); expect(first.dockerDesktop).toBe(true);
        expect(contextCalls()).toEqual([[executable, metadataArgs(context), {
            env: expect.objectContaining({ PATH: "/fixture/bin", DOCKER_CONTEXT: context, DOCKER_HOST: "tcp://shadowed:2376" }),
            cwd: "/fixture/work", encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
            killSignal: "SIGKILL", maxBuffer: 512 * 1024, shell: false,
        }]]);
        expect(native.spawn.mock.calls.map(call => call[1])).toEqual([
            metadataArgs(context), [...prefix("unix:///selected.sock"), "--version"],
            [...prefix("unix:///selected.sock"), "info", "--format", "{{.OperatingSystem}}"],
        ]);
        const invocation = runtime.getRuntimeInvocation();
        expect(invocation.transport).toMatchObject({ kind: "docker", host: "unix:///selected.sock" });
        const count = native.spawn.mock.calls.length;
        vi.stubEnv("DOCKER_CONTEXT", "changed"); expect(runtime.getRuntimeInfo()).toBe(first);
        expect(runtime.getRuntimeInvocation()).toBe(invocation);
        expect(native.spawn).toHaveBeenCalledTimes(count);
        runtime._resetRuntimeCacheForTest(); runtime.setRuntimeOverride("docker"); runtime.getRuntimeInfo();
        expect(contextCalls().at(-1)?.[1]).toEqual(metadataArgs("changed"));
    });

    it.each([[1, "unix:///selected.sock"], [0, ""], [0, " \n\t"], [0, "not-json"], [0, "{}"]] as const)("refuses failed or malformed authority status=%i stdout=%j before capability publication", (status, stdout) => {
        fixture(status, "unix:///selected.sock", stdout); vi.stubEnv("DOCKER_CONTEXT", "colima"); vi.stubEnv("DOCKER_HOST", "unix:///desktop.sock");
        expect(() => runtime.getRuntimeInfo()).toThrow("Unable to capture native container runtime authority.");
        expect(native.spawn.mock.calls.map(call => call[1])).toEqual([metadataArgs("colima")]);
        native.spawn.mockClear(); fixture();
        expect(runtime.getRuntimeInfo().dockerDesktop).toBe(true);
        expect(contextCalls()).toHaveLength(1);
    });

    it.each(["ssh://remote@example.test", "unix:///host-selected.sock"])("uses native metadata to resolve host override %j without a context override", host => {
        fixture(); vi.stubEnv("DOCKER_HOST", host);
        expect(runtime.getRuntimeInfo().dockerDesktop).toBe(host.startsWith("unix:"));
        expect(contextCalls()[0][1]).toEqual(metadataArgs());
        expect(runtime.getRuntimeInvocation().transport).toMatchObject({ kind: "docker", host });
        expect(native.spawn.mock.calls[1][1]).toEqual([...prefix(host), "--version"]);
    });

    it.each([" \nssh://remote@example.test ", " \t "])("refuses control characters in native host selector %j before effects", host => {
        fixture(); vi.stubEnv("DOCKER_HOST", host);
        expect(() => runtime.getRuntimeInfo()).toThrow("Unable to capture native container runtime authority.");
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("keeps implicit current-context metadata argv free of a named operand", () => {
        fixture(); runtime.getRuntimeInfo();
        expect(contextCalls()[0][1]).toEqual(metadataArgs());
    });

    it.each(["ssh://remote@example.test", "tcp://remote:2376"])("does not grant Desktop from remote selected endpoint %j", endpoint => {
        fixture(0, endpoint); vi.stubEnv("DOCKER_CONTEXT", "selected"); vi.stubEnv("DOCKER_HOST", "unix:///shadowed.sock");
        expect(runtime.getRuntimeInfo().dockerDesktop).toBe(false);
        expect(runtime.getRuntimeInvocation().transport).toMatchObject({ kind: "docker", host: endpoint });
    });

    it("binds Linux version, operating-system and security observations after capture", () => {
        fixture(); vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        expect(runtime.getRuntimeInfo()).toMatchObject({ dockerDesktop: true, rootless: false, version: "27.1.1" });
        expect(native.spawn.mock.calls.map(call => call[1])).toEqual([
            metadataArgs(), [...prefix("unix:///selected.sock"), "--version"],
            [...prefix("unix:///selected.sock"), "info", "--format", "{{.OperatingSystem}}"],
            [...prefix("unix:///selected.sock"), "info", "--format", "{{json .SecurityOptions}}"],
        ]);
    });
});
