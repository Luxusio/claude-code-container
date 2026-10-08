import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { containerMemoryLimit, validateContainerMemory, ContainerEngineUnavailableError } from "../domain/container-runtime.js";
import { _resetRuntimeCacheForTest, _setRuntimeInfoForTest } from "../container-runtime.js";
const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));
import { buildDockerRunArgs, resolveNewContainerMemoryLimit, type DockerRunArgsOptions } from "../docker.js";
const gib = 1024 ** 3;
const options: DockerRunArgsOptions = {
    containerName: "ccc-memory-fixture", fullPath: "/project/fixture", projectMountPath: "/project/fixture",
    credentialMounts: [], claudeJsonFile: "/fixture/.claude.json", miseVolumeName: "ccc-mise-fixture",
    pidsLimit: "-1", imageName: "ccc-fixture", hostSshDir: null, sshAgentSocket: null,
};
beforeEach(() => { native.spawnSync.mockReset(); vi.stubEnv("CCC_CONTAINER_MEMORY", undefined); _setRuntimeInfoForTest({ runtime: "docker", remote: true, dockerDesktop: true }); });
afterEach(() => { vi.unstubAllEnvs(); _resetRuntimeCacheForTest(); });
it.each([[32, "8192m"], [30, "7680m"], [8, "2048m"], [1, "256m"]])("caps a %s GiB VM and disables container swap with exact creation arguments", (memory, expected) => {
    native.spawnSync.mockReturnValue({ status: 0, stdout: String(memory * gib), stderr: "" });
    const memoryLimit = resolveNewContainerMemoryLimit();
    expect(memoryLimit).toBe(expected);
    expect(native.spawnSync.mock.calls[0]).toEqual(["docker", ["info", "--format", "{{.MemTotal}}"], { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }]);
    const args = buildDockerRunArgs({ ...options, memoryLimit });
    expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 4)).toEqual(["--memory", expected, "--memory-swap", expected]);
    expect(args).not.toContain("--oom-kill-disable");
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
it.each([undefined, NaN, Infinity, 0, -1, 1])("refuses invalid engine memory %s", memory => {
    expect(() => containerMemoryLimit("docker-desktop", memory)).toThrow("refused to create an unlimited");
});
it.each(["", "0", "-2g", "NaN", "Infinity", "2gb", "2g --privileged", "1e309g", "1m"])("rejects invalid override %s", value => {
    vi.stubEnv("CCC_CONTAINER_MEMORY", value);
    expect(() => resolveNewContainerMemoryLimit()).toThrow("CCC_CONTAINER_MEMORY");
    expect(native.spawnSync).not.toHaveBeenCalled();
});
it.each(["2g", "8192m", "6M", "0.5g", "8388608"])("preserves valid explicit override %s", value => {
    vi.stubEnv("CCC_CONTAINER_MEMORY", value);
    expect(resolveNewContainerMemoryLimit()).toBe(value);
    expect(validateContainerMemory(value)).toBe(value);
    expect(native.spawnSync).not.toHaveBeenCalled();
});
it.each([
    { runtime: "docker" as const, remote: false, dockerDesktop: false },
    { runtime: "docker" as const, remote: true, dockerDesktop: false },
    { runtime: "podman" as const, remote: true, dockerDesktop: false },
])("preserves engine compatibility without default probes: %s", info => {
    _setRuntimeInfoForTest(info);
    expect(resolveNewContainerMemoryLimit()).toBeUndefined();
    expect(native.spawnSync).not.toHaveBeenCalled();
    expect(buildDockerRunArgs(options)).not.toContain("--memory");
    expect(native.spawnSync.mock.calls.some(call => call[1]?.[0] === "info")).toBe(false);
    vi.stubEnv("CCC_CONTAINER_MEMORY", "3g");
    expect(resolveNewContainerMemoryLimit()).toBe("3g");
});
it.each([
    { status: 0, stdout: "unknown", stderr: "" },
    { status: 0, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "unknown error" },
    { status: null, stdout: "", stderr: "", error: new Error("timed out") },
])("refuses failed/unknown Desktop facts without retry", result => {
    native.spawnSync.mockReturnValue(result);
    expect(() => resolveNewContainerMemoryLimit()).toThrow("Cannot determine Docker Desktop VM memory safely");
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
it("classifies transport failure rather than creating an unlimited container", () => {
    native.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
    expect(() => resolveNewContainerMemoryLimit()).toThrow(ContainerEngineUnavailableError);
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
// Execute the actual launch environment construction slice without importing the CLI entrypoint.
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const cargoStart = indexSource.indexOf("    // Limit default Rust compiler concurrency");
const cargoEnd = indexSource.indexOf("    // Locale:", cargoStart);
const cargoSlice = indexSource.slice(cargoStart, cargoEnd);
const applyCargoDefault = new Function("envEntries", "options", cargoSlice) as (entries: Array<[string, string]>, options: { env?: Record<string, string> }) => void;
it.each([
    { forwarded: [] as Array<[string, string]>, explicit: undefined, expected: "2" },
    { forwarded: [["CARGO_BUILD_JOBS", "7"]] as Array<[string, string]>, explicit: undefined, expected: "7" },
    { forwarded: [] as Array<[string, string]>, explicit: "4", expected: "4" },
    { forwarded: [["CARGO_BUILD_JOBS", "7"]] as Array<[string, string]>, explicit: "1", expected: "1" },
])("uses default Cargo jobs and preserves launch overrides: %s", ({ forwarded, explicit, expected }) => {
    expect(cargoStart).toBeGreaterThan(0);
    expect(cargoEnd).toBeGreaterThan(cargoStart);
    const entries = [...forwarded];
    const env = explicit === undefined ? undefined : { CARGO_BUILD_JOBS: explicit };
    applyCargoDefault(entries, { env });
    entries.push(...Object.entries(env ?? {}));
    expect(Object.fromEntries(entries).CARGO_BUILD_JOBS).toBe(expected);
    if (explicit !== undefined) expect(entries.filter(([key, value]) => key === "CARGO_BUILD_JOBS" && value === "2")).toEqual([]);
});
