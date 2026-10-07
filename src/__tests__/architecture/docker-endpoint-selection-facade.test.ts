import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(() => false) }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn }));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: native.exists }));
import { _resetRuntimeCacheForTest, _resetSelinuxCacheForTest, _setRuntimeInfoForTest, bindMountArgs, getRuntimeInfo, setRuntimeOverride } from "../../container-runtime.js";
import { buildDockerRunArgs } from "../../docker.js";
const result = (status: number, stdout = "") => ({ status, stdout, stderr: "", signal: null });
function fixture(status = 0, endpoint = " unix:///selected.sock\n") {
    native.spawn.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("docker");
        if (args[0] === "--version") return result(0, "Docker version 27.1.1");
        if (args[0] === "context") return result(status, endpoint);
        expect(args).toEqual(["info", "--format", "{{.OperatingSystem}}"]);
        return result(0, "Docker Desktop");
    });
}
beforeEach(() => {
    vi.resetAllMocks(); _resetRuntimeCacheForTest(); _resetSelinuxCacheForTest();
    setRuntimeOverride("docker");
    vi.stubEnv("CCC_RUNTIME", "docker"); vi.stubEnv("DOCKER_CONTEXT", ""); vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("CCC_RUNTIME_SOCKET", ""); vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
});
afterEach(() => { _resetRuntimeCacheForTest(); _resetSelinuxCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("native Docker endpoint composition", () => {
    it("keeps daemon namespace sockets unchanged while translating ordinary nested client paths", () => {
        for (const key of Object.keys(process.env)) if (key === "VITEST" || key.startsWith("VITEST_")) vi.stubEnv(key, undefined);
        vi.stubEnv("container", "docker"); vi.stubEnv("HOSTNAME", "ccc-parent");
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        _setRuntimeInfoForTest({ runtime: "docker", socketPath: "/daemon/docker.sock", remote: true, dockerDesktop: false });
        native.spawn.mockImplementation((command: string, args: string[]) => {
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
        expect(args).not.toContain("/srv/daemon/docker.sock:/var/run/docker.sock");
        expect(args).toContain("/srv/daemon/project:/project/fixture");
        expect(bindMountArgs("/daemon/project", "/target")).toEqual(["-v", "/srv/daemon/project:/target"]);
        expect(bindMountArgs("/daemon/docker.sock", "/target", { sourceNamespace: "daemon" })).toEqual(["-v", "/daemon/docker.sock:/target"]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["inspect", "ccc-parent", "--format", "{{json .Mounts}}"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    });
    it.each(["colima", " colima ", " ", "--format=hostile"])("protects raw named context operand %j and retains cache lifetime", context => {
        fixture(); vi.stubEnv("DOCKER_CONTEXT", context); vi.stubEnv("DOCKER_HOST", "tcp://shadowed:2376");
        const first = getRuntimeInfo(); expect(first.dockerDesktop).toBe(true);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "context")).toEqual([["docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "--", context], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }]]);
        const count = native.spawn.mock.calls.length;
        vi.stubEnv("DOCKER_CONTEXT", "changed"); expect(getRuntimeInfo()).toBe(first);
        expect(native.spawn).toHaveBeenCalledTimes(count);
        _resetRuntimeCacheForTest(); setRuntimeOverride("docker"); getRuntimeInfo();
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "context").at(-1)?.[1].at(-1)).toBe("changed");
    });
    it.each([[1, "unix:///selected.sock"], [0, ""], [0, " \n\t"]])("fails closed on selected-context status=%i stdout=%j without host fallback", (status, endpoint) => {
        fixture(status, endpoint); vi.stubEnv("DOCKER_CONTEXT", "colima"); vi.stubEnv("DOCKER_HOST", "unix:///desktop.sock");
        expect(getRuntimeInfo().dockerDesktop).toBe(false);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "context")).toHaveLength(1);
    });
    it("short circuits trimmed host when no context override exists", () => {
        fixture(); vi.stubEnv("DOCKER_HOST", " \nssh://remote@example.test ");
        expect(getRuntimeInfo().dockerDesktop).toBe(false);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "context")).toBe(false);
    });
    it("keeps implicit current-context argv unchanged", () => {
        fixture(); vi.stubEnv("DOCKER_HOST", " \t "); getRuntimeInfo();
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "context")[0][1]).toEqual(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    });
    it.each(["ssh://remote@example.test", "tcp://remote:2376"])("does not grant Desktop from remote selected endpoint %j", endpoint => {
        fixture(0, endpoint); vi.stubEnv("DOCKER_CONTEXT", "selected"); vi.stubEnv("DOCKER_HOST", "unix:///shadowed.sock");
        expect(getRuntimeInfo().dockerDesktop).toBe(false);
    });
});
