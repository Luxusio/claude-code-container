import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../../domain/container-runtime.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn<(...args: unknown[]) => boolean>(() => false), trace: [] as unknown[][] }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: (...args: unknown[]) => { native.trace.push(["spawn", ...args]); return native.spawn(...args); } }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: (...args: unknown[]) => { native.trace.push(["exists", ...args]); return native.exists(...args); } }));
import * as runtime from "../../container-runtime.js";
import { createNativeRuntimeCapabilitiesObservations } from "../../adapters/runtime-capabilities.js";

const result = (status: number | null, stdout: string) => ({ status, stdout, stderr: "", signal: null });
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
    it("retains original probe result identity and exact CLI argv/options", () => {
        const raw = result(0, "Docker 27.1.1"); native.spawn.mockReturnValue(raw);
        const observations = createNativeRuntimeCapabilitiesObservations(() => null);
        expect(observations.observeVersion("docker")).toBe(raw);
        expect(native.trace).toEqual([["spawn", "docker", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }]]);
        observations.observeDockerOperatingSystem(); observations.observePodmanRemote(); observations.observeDockerSecurityOptions(); observations.observePodmanRootless();
        expect(native.trace.slice(1).map(call => call.slice(1, 3))).toEqual([
            ["docker", ["info", "--format", "{{.OperatingSystem}}"]], ["podman", ["info", "--format", "{{.Host.Remote}}"]],
            ["docker", ["info", "--format", "{{json .SecurityOptions}}"]], ["podman", ["info", "--format", "{{.Host.Security.Rootless}}"]],
        ]);
    });
    it("keeps same cache object, no-op/invalid overrides and current-env invalidation", () => {
        const info = runtime.getRuntimeInfo(); const count = native.spawn.mock.calls.length; info.version = "mutated";
        vi.stubEnv("CCC_RUNTIME", "invalid"); vi.stubEnv("CCC_RUNTIME_SOCKET", "changed"); runtime.setRuntimeOverride(null); runtime.setRuntimeOverride("");
        expect(() => runtime.setRuntimeOverride("invalid")).toThrow("Invalid --runtime");
        expect(runtime.getRuntimeInfo()).toBe(info); expect(runtime.runtimeCli()).toBe("docker"); expect(native.spawn).toHaveBeenCalledTimes(count);
        runtime.setRuntimeOverride("podman"); expect(runtime.getRuntimeInfo()).toMatchObject({ runtime: "podman", socketPath: "changed" }); expect(runtime.getRuntimeInfo()).not.toBe(info);
    });
    it("retains fixed test stub and explicit override defeats it", () => {
        runtime._resetRuntimeCacheForTest(); vi.stubEnv("VITEST", "1"); vi.stubEnv("CCC_RUNTIME", "invalid");
        expect(runtime.getRuntimeInfo()).toEqual({ runtime: "docker", flavor: "docker-native", version: "0.0.0", socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false }); expect(native.spawn).not.toHaveBeenCalled();
        runtime.setRuntimeOverride("podman"); expect(runtime.getRuntimeInfo().runtime).toBe("podman");
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
