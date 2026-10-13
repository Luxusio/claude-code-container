import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../../domain/container-runtime.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn<(...args: unknown[]) => boolean>(() => false), trace: [] as unknown[][] }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: (...args: unknown[]) => { native.trace.push(["spawn", ...args]); return native.spawn(...args); } }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: (...args: unknown[]) => { native.trace.push(["exists", ...args]); return native.exists(...args); } }));
import * as runtime from "../../container-runtime.js";
import { createNativeRuntimeCapabilitiesObservations } from "../../adapters/runtime-capabilities.js";

const result = (status: number | null, stdout: string | null | undefined) => ({ status, stdout, stderr: "", signal: null });
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
function mockProbes() {
    native.spawn.mockImplementation((command: string, args: string[]) => {
        if (args[0] === "--version") return result(0, command === "docker" ? "Docker 27.1.1" : "podman 5.2.3");
        if (args[0] === "context") return result(0, "unix:///selected.sock");
        if (args.at(-1) === "{{.OperatingSystem}}") return result(0, "Ubuntu");
        if (args.at(-1) === "{{json .SecurityOptions}}") return result(0, "[]");
        if (args.at(-1) === "{{.Host.Remote}}" || args.at(-1) === "{{.Host.Security.Rootless}}") return result(0, "false");
        throw Error(`Unexpected native command ${command}`);
    });
}
beforeEach(() => {
    vi.resetAllMocks(); native.trace = []; native.exists.mockReturnValue(false); runtime._resetRuntimeCacheForTest(); runtime._resetSelinuxCacheForTest();
    for (const name of ["CCC_RUNTIME", "DOCKER_CONTEXT", "DOCKER_HOST", "WSL_DISTRO_NAME", "CCC_RUNTIME_SOCKET", "XDG_RUNTIME_DIR", "VITEST", "CCC_SELINUX_RELABEL", "CCC_PODMAN_CGROUPS", "container"]) vi.stubEnv(name, undefined);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux"); runtime.setRuntimeOverride("docker"); mockProbes();
});
afterEach(() => { runtime._resetRuntimeCacheForTest(); runtime._resetSelinuxCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor); else Reflect.deleteProperty(process, "getuid"); });

describe("runtime capability native facade", () => {
    it("normalizes version and retains exact CLI argv/options", () => {
        const raw = result(0, "Docker 27.1.1"); native.spawn.mockReturnValue(raw);
        const observations = createNativeRuntimeCapabilitiesObservations(() => null);
        expect(observations.observeVersion("docker")).toBe("27.1.1");
        expect(native.trace).toEqual([["spawn", "docker", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" }]]);
        observations.observeDockerOperatingSystem(); observations.observePodmanRemote(); observations.observeDockerSecurityOptions(); observations.observePodmanRootless();
        expect(native.trace.slice(1).map(call => call.slice(1, 3))).toEqual([
            ["docker", ["info", "--format", "{{.OperatingSystem}}"]], ["podman", ["info", "--format", "{{.Host.Remote}}"]],
            ["docker", ["info", "--format", "{{json .SecurityOptions}}"]], ["podman", ["info", "--format", "{{.Host.Security.Rootless}}"]],
        ]);
        for (const call of native.trace) {
            expect(call[3]).toEqual({ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" });
        }
    });
    it.each([
        [0, "Docker version 27.1.1", "27.1.1"], [0, "podman version 5.2", "5.2"],
        [0, "unavailable", null], [1, "Docker 27.1.1", null], [null, "Docker 27.1.1", null], [0, null, null],
    ] as const)("decodes native version status=%s output=%s", (status, stdout, expected) => {
        native.spawn.mockReturnValue(result(status, stdout));
        expect(createNativeRuntimeCapabilitiesObservations(() => null).observeVersion("docker")).toBe(expected);
    });
    it.each([
        [0, " Docker Desktop ", "desktop"], [0, "Ubuntu", "other"], [0, " ", "unavailable"],
        [1, "Docker Desktop", "unavailable"], [null, "Docker Desktop", "unavailable"], [0, undefined, "unavailable"],
    ] as const)("decodes native Docker OS status=%s output=%s", (status, stdout, expected) => {
        native.spawn.mockReturnValue(result(status, stdout));
        expect(createNativeRuntimeCapabilitiesObservations(() => null).observeDockerOperatingSystem()).toBe(expected);
    });
    it.each([
        [0, " TRUE ", true, true], [0, "false", false, false], [0, "unknown", false, null],
        [1, "true", false, null], [null, "true", false, null], [0, null, false, null],
    ] as const)("decodes native Podman booleans status=%s output=%s", (status, stdout, remote, rootless) => {
        native.spawn.mockReturnValue(result(status, stdout));
        const observations = createNativeRuntimeCapabilitiesObservations(() => null);
        expect(observations.observePodmanRemote()).toBe(remote); expect(observations.observePodmanRootless()).toBe(rootless);
    });
    it.each([
        [0, '["name=rootless"]', true], [0, '"rootless"', false], [0, '{"rootless":true}', false],
        [0, "ROOTLESS", true], [0, "[]", false], [1, '["rootless"]', false], [0, null, false],
    ] as const)("decodes Docker security JSON and malformed fallback status=%s output=%s", (status, stdout, expected) => {
        native.spawn.mockReturnValue(result(status, stdout));
        expect(createNativeRuntimeCapabilitiesObservations(() => null).observeDockerSecurityOptions()).toBe(expected);
    });
    it.each(["--version", "{{.OperatingSystem}}", "{{json .SecurityOptions}}"])("retries complete native collection after %s failure", failedProbe => {
        const implementation = native.spawn.getMockImplementation()!; const fault = Error("probe failure"); let fail = true;
        native.spawn.mockImplementation((command: string, args: string[]) => {
            if (fail && (args[0] === failedProbe || args.at(-1) === failedProbe)) throw fault;
            return implementation(command, args);
        });
        expect(() => runtime.getRuntimeInfo()).toThrow(fault); expect(() => runtime.getRuntimeInfo()).toThrow(fault);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "--version")).toHaveLength(2);
        fail = false; expect(runtime.getRuntimeInfo()).toMatchObject({ version: "27.1.1", socketPath: "/var/run/docker.sock" });
        const complete = runtime.getRuntimeInfo(); const calls = native.spawn.mock.calls.length;
        expect(runtime.getRuntimeInfo()).toBe(complete); expect(native.spawn).toHaveBeenCalledTimes(calls);
    });
    it("keeps same cache object, no-op/invalid overrides and current-env invalidation", () => {
        const info = runtime.getRuntimeInfo(); const count = native.spawn.mock.calls.length; info.version = "mutated";
        vi.stubEnv("CCC_RUNTIME", "invalid"); vi.stubEnv("CCC_RUNTIME_SOCKET", "changed"); runtime.setRuntimeOverride(null); runtime.setRuntimeOverride("");
        expect(() => runtime.setRuntimeOverride("invalid")).toThrow("Invalid --runtime");
        expect(runtime.getRuntimeInfo()).toBe(info); expect(runtime.getRuntimeInfo().version).toBe("mutated"); expect(runtime.runtimeCli()).toBe("docker"); expect(native.spawn).toHaveBeenCalledTimes(count);
        runtime.setRuntimeOverride("podman"); expect(runtime.getRuntimeInfo()).toMatchObject({ runtime: "podman", socketPath: "changed" }); expect(runtime.getRuntimeInfo()).not.toBe(info);
    });
    it.each(["1", "0"])("retains truthy Vitest=%s stub and explicit override defeats it", flag => {
        runtime._resetRuntimeCacheForTest(); vi.stubEnv("VITEST", flag); vi.stubEnv("CCC_RUNTIME", "invalid");
        expect(runtime.getRuntimeInfo()).toEqual({ runtime: "docker", flavor: "docker-native", version: "0.0.0", socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false }); expect(native.spawn).not.toHaveBeenCalled();
        runtime.setRuntimeOverride("podman"); expect(runtime.getRuntimeInfo().runtime).toBe("podman");
    });
    it("empty Vitest flag permits native detection", () => {
        vi.stubEnv("VITEST", ""); expect(runtime.getRuntimeInfo().version).toBe("27.1.1"); expect(native.spawn).toHaveBeenCalled();
    });
    it("retains native socket existence authority and Docker fallback", () => {
        runtime._setRuntimeInfoForTest({ runtime: "podman", socketPath: "/run/custom/podman.sock" });
        native.exists.mockReturnValue(false); expect(runtime.containerManagerSocketPath()).toBe("/var/run/docker.sock");
        native.exists.mockReturnValue(true); expect(runtime.containerManagerSocketPath()).toBe("/run/custom/podman.sock");
        expect(native.exists).toHaveBeenCalledWith("/run/custom/podman.sock");
    });
    it("publishes only after native socket UID succeeds, then caches the complete result", () => {
        runtime.setRuntimeOverride("podman");
        const implementation = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((command: string, args: string[]) => args.at(-1) === "{{.Host.Security.Rootless}}" ? result(0, "true") : implementation(command, args));
        const fault = Error("socket UID failed"); const uid = vi.spyOn(process, "getuid").mockImplementation(() => { throw fault; });
        expect(() => runtime.getRuntimeInfo()).toThrow(fault); expect(() => runtime.getRuntimeInfo()).toThrow(fault);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "--version")).toHaveLength(2);
        uid.mockReturnValue(1001); expect(runtime.getRuntimeInfo()).toMatchObject({ rootless: true, socketPath: "/run/user/1001/podman/podman.sock" });
        const complete = runtime.getRuntimeInfo(); uid.mockImplementation(() => { throw fault; }); expect(runtime.getRuntimeInfo()).toBe(complete);
    });
    it.each(["Docker Desktop", "Ubuntu", ""])("Windows native OS '%s' retains selected pipe qualification", operatingSystem => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32"); vi.stubEnv("DOCKER_HOST", "npipe:////./pipe/dockerDesktopLinuxEngine");
        const implementation = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((command: string, args: string[]) => args.at(-1) === "{{.OperatingSystem}}" ? result(0, operatingSystem) : implementation(command, args));
        expect(runtime.getRuntimeInfo()).toMatchObject({ dockerDesktop: operatingSystem !== "Ubuntu", remote: true, flavor: "docker-desktop" });
    });
    it("retains raw selected context operand, precedence and fail-closed endpoint", () => {
        vi.stubEnv("DOCKER_CONTEXT", " --format=hostile "); vi.stubEnv("DOCKER_HOST", "unix:///shadowed");
        native.spawn.mockImplementation((_command: string, args: string[]) => args[0] === "--version" ? result(0, "Docker 27.1.1") : args[0] === "context" ? result(1, "unix:///local") : args.at(-1) === "{{.OperatingSystem}}" ? result(0, "Docker Desktop") : result(0, "[]"));
        expect(runtime.getRuntimeInfo()).toMatchObject({ dockerDesktop: false });
        expect(native.spawn.mock.calls.find(call => call[1][0] === "context")?.[1]).toEqual(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "--", " --format=hostile "]);
    });
    it.each([false, true])("preserves WSL kernel observation, mirrored=%s", mirrored => {
        vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu"); native.exists.mockReturnValue(mirrored);
        expect(runtime.getRuntimeInfo().remote).toBe(!mirrored); expect(native.exists).toHaveBeenCalledExactlyOnceWith("/sys/class/net/loopback0");
    });

    it("keeps capability false while macOS legacy flavor remains docker-desktop", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        expect(runtime.getRuntimeInfo()).toMatchObject({ runtime: "docker", remote: true, flavor: "docker-desktop", dockerDesktop: false });
    });

    it("retains all public accessors and preload defaults", () => {
        for (const name of ["docker", "podman"] as RuntimeName[]) { runtime._setRuntimeInfoForTest({ runtime: name }); const info = runtime.getRuntimeInfo(); expect(runtime.runtimeCli()).toBe(name); expect(runtime.isContainerHostRemote()).toBe(false); expect(runtime.formatRuntimeSummary()).toContain(`runtime=${name}`); expect(runtime.getRuntimeInfo()).toBe(info); }
        expect(runtime.getHostInternalAlias()).toBe("host.docker.internal");
        expect(runtime.bindMountArgs("/host", "/guest", { readonly: true })).toEqual(["-v", "/host:/guest:ro"]);
    });
});
