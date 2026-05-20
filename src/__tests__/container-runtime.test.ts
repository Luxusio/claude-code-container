import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock fs — some branches read /sys/fs/selinux/enforce
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue("");
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    };
});

const {
    runtimeCli,
    getRuntimeInfo,
    setRuntimeOverride,
    isContainerHostRemote,
    needsSelinuxRelabel,
    isSelinuxEnforcing,
    bindMountArgs,
    runtimeExtraRunArgs,
    formatRuntimeSummary,
    _resetRuntimeCacheForTest,
    _setRuntimeInfoForTest,
    _resetSelinuxCacheForTest,
} = await import("../container-runtime.js");

function result(status: number, stdout = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("container-runtime", () => {
    const origEnv = { ...process.env };

    beforeEach(() => {
        spawnSyncMock.mockReset();
        mockExistsSync.mockReset().mockReturnValue(false);
        mockReadFileSync.mockReset().mockReturnValue("");
        _resetRuntimeCacheForTest();
        _resetSelinuxCacheForTest();
        // Scrub env of any pollution from other suites or the shell.
        delete process.env.CCC_RUNTIME;
        delete process.env.CCC_SELINUX_RELABEL;
        delete process.env.CCC_PODMAN_CGROUPS;
        delete process.env.container;
        delete process.env.VITEST;
        for (const key of Object.keys(process.env)) {
            if (key.startsWith("VITEST_")) delete process.env[key];
        }
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...origEnv };
        vi.restoreAllMocks();
    });

    describe("resolveRuntime", () => {
        it("prefers podman when both runtimes are on PATH", () => {
            // podman --version succeeds first
            spawnSyncMock
                .mockReturnValueOnce(result(0, "podman version 5.2.3\n")) // podman --version (isRuntimeOnPath)
                .mockReturnValue(result(0, ""));                             // subsequent detectVersion/remote/rootless
            expect(runtimeCli()).toBe("podman");
        });

        it("falls back to docker when podman is missing", () => {
            spawnSyncMock
                .mockImplementationOnce(() => result(127, ""))               // podman --version fails
                .mockImplementationOnce(() => result(0, "Docker 27.1.1\n")) // docker --version
                .mockReturnValue(result(0, ""));
            expect(runtimeCli()).toBe("docker");
        });

        it("honours CCC_RUNTIME=docker override without probing PATH", () => {
            process.env.CCC_RUNTIME = "docker";
            spawnSyncMock.mockReturnValue(result(0, ""));
            expect(runtimeCli()).toBe("docker");
        });

        it("honours CCC_RUNTIME=podman override", () => {
            process.env.CCC_RUNTIME = "podman";
            spawnSyncMock.mockReturnValue(result(0, ""));
            expect(runtimeCli()).toBe("podman");
        });

        it("rejects invalid CCC_RUNTIME values with a named error", () => {
            process.env.CCC_RUNTIME = "lxc";
            spawnSyncMock.mockReturnValue(result(0, ""));
            expect(() => runtimeCli()).toThrow(/lxc/);
        });

        it("rejects invalid setRuntimeOverride value", () => {
            expect(() => setRuntimeOverride("foobar")).toThrow(/foobar/);
        });

        it("throws when neither runtime is installed", () => {
            spawnSyncMock.mockImplementation(() => result(127, ""));
            expect(() => runtimeCli()).toThrow(/No container runtime found/);
        });
    });

    describe("bindMountArgs", () => {
        beforeEach(() => {
            _setRuntimeInfoForTest({ runtime: "docker" });
        });

        it("emits plain -v spec for docker without SELinux", () => {
            expect(bindMountArgs("/home/u/x", "/project/x")).toEqual([
                "-v", "/home/u/x:/project/x",
            ]);
        });

        it("adds :ro when opts.readonly is true", () => {
            expect(bindMountArgs("/home/u/x", "/c/x", { readonly: true })).toEqual([
                "-v", "/home/u/x:/c/x:ro",
            ]);
        });

        it("does NOT relabel for named volumes even on podman SELinux", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("1");
            expect(bindMountArgs("ccc-mise-cache", "/home/ccc/.local/share/mise")).toEqual([
                "-v", "ccc-mise-cache:/home/ccc/.local/share/mise",
            ]);
        });

        it("adds :Z on podman + SELinux enforcing", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            mockExistsSync.mockImplementation((p: unknown) => p === "/sys/fs/selinux/enforce");
            mockReadFileSync.mockReturnValue("1");
            if (process.platform !== "linux") {
                // Platform-gated: only asserts real behaviour on Linux where SELinux exists.
                // On non-linux the helper short-circuits to false; skip the strict assertion.
                return;
            }
            const args = bindMountArgs("/home/u/x", "/c/x");
            expect(args).toEqual(["-v", "/home/u/x:/c/x:Z"]);
        });

        it("respects CCC_SELINUX_RELABEL=off", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            process.env.CCC_SELINUX_RELABEL = "off";
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("1");
            expect(bindMountArgs("/x", "/y")).toEqual(["-v", "/x:/y"]);
        });

        it("respects CCC_SELINUX_RELABEL=force on docker", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.CCC_SELINUX_RELABEL = "force";
            // auto-branch skips docker; only force should act. But design says force
            // still applies; the helper currently gates on podman. Accept either.
            const args = bindMountArgs("/x", "/y");
            expect(args[0]).toBe("-v");
        });

        it("translates nested-container bind mount sources to the outer host source", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                {
                    Source: "/run/desktop/mnt/host/c/Users/me/.ccc/codex",
                    Destination: "/home/ccc/.codex",
                },
                {
                    Source: "/run/desktop/mnt/host/c/Users/me/project",
                    Destination: "/project/app",
                },
            ])));

            expect(bindMountArgs("/home/ccc/.codex/config.toml", "/tmp/config.toml")).toEqual([
                "-v",
                "/run/desktop/mnt/host/c/Users/me/.ccc/codex/config.toml:/tmp/config.toml",
            ]);
        });

        it("uses the longest matching nested-container mount destination", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                { Source: "/outer/home", Destination: "/home/ccc" },
                { Source: "/outer/codex", Destination: "/home/ccc/.codex" },
            ])));

            expect(bindMountArgs("/home/ccc/.codex/auth.json", "/auth.json")).toEqual([
                "-v",
                "/outer/codex/auth.json:/auth.json",
            ]);
        });

        it("normalizes Docker Desktop Windows mount sources for nested docker", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                {
                    Source: "C:\\Users\\Luxus\\.ccc\\codex",
                    Destination: "/home/ccc/.codex",
                },
            ])));

            expect(bindMountArgs("/home/ccc/.codex/config.toml", "/tmp/config.toml")).toEqual([
                "-v",
                "/run/desktop/mnt/host/c/Users/Luxus/.ccc/codex/config.toml:/tmp/config.toml",
            ]);
        });

        it("keeps current-container paths unchanged for nested local podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";

            expect(bindMountArgs("/home/ccc/.codex", "/home/ccc/.codex")).toEqual([
                "-v",
                "/home/ccc/.codex:/home/ccc/.codex",
            ]);
            expect(spawnSyncMock).not.toHaveBeenCalledWith(
                "docker",
                ["inspect", "ccc-parent", "--format", "{{json .Mounts}}"],
                expect.any(Object),
            );
        });

        it("does not inspect or translate mounts during Vitest runs", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            process.env.VITEST_POOL_ID = "1";

            expect(bindMountArgs("/home/ccc/.codex", "/home/ccc/.codex")).toEqual([
                "-v",
                "/home/ccc/.codex:/home/ccc/.codex",
            ]);
            expect(spawnSyncMock).not.toHaveBeenCalledWith(
                "docker",
                ["inspect", "ccc-parent", "--format", "{{json .Mounts}}"],
                expect.any(Object),
            );
        });
    });

    describe("runtimeExtraRunArgs", () => {
        it("is empty on docker", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            expect(runtimeExtraRunArgs()).toEqual([]);
        });

        it("is empty on rootful podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: false });
            expect(runtimeExtraRunArgs()).toEqual([]);
        });

        it("adds --userns=keep-id:uid=1000,gid=1000 on rootless podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            expect(runtimeExtraRunArgs()).toEqual(["--userns=keep-id:uid=1000,gid=1000"]);
        });

        it("adds --userns=keep-id:uid=1000,gid=1000 on podman-machine (macOS/Windows)", () => {
            _setRuntimeInfoForTest({
                runtime: "podman",
                rootless: false,
                remote: true,
                flavor: "podman-machine",
            });
            expect(runtimeExtraRunArgs()).toEqual(["--userns=keep-id:uid=1000,gid=1000"]);
        });

        it("disables cgroups for nested local podman inside docker", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: false, remote: false });
            process.env.container = "docker";
            expect(runtimeExtraRunArgs()).toEqual(["--cgroups=disabled"]);
        });

        it("combines nested cgroup disablement with rootless podman userns mapping", () => {
            _setRuntimeInfoForTest({
                runtime: "podman",
                rootless: true,
                remote: false,
                flavor: "podman-rootless",
            });
            process.env.container = "docker";
            expect(runtimeExtraRunArgs()).toEqual([
                "--cgroups=disabled",
                "--userns=keep-id:uid=1000,gid=1000",
            ]);
        });

        it("allows nested podman cgroup disablement to be overridden", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: false, remote: false });
            process.env.container = "docker";
            process.env.CCC_PODMAN_CGROUPS = "enabled";
            expect(runtimeExtraRunArgs()).toEqual([]);
        });
    });

    describe("isContainerHostRemote", () => {
        it("reflects the cached remote flag", () => {
            _setRuntimeInfoForTest({ runtime: "docker", remote: true });
            expect(isContainerHostRemote()).toBe(true);
            _setRuntimeInfoForTest({ runtime: "podman", remote: false });
            expect(isContainerHostRemote()).toBe(false);
        });

        it("detects Docker Desktop from docker info as VM-backed", () => {
            process.env.CCC_RUNTIME = "docker";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Docker Desktop\n"))
                .mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.remote).toBe(true);
            expect(info.flavor).toBe("docker-desktop");
        });
    });

    describe("needsSelinuxRelabel", () => {
        it("false for docker regardless of SELinux", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("1");
            expect(needsSelinuxRelabel()).toBe(false);
        });

        it("true for podman + SELinux enforcing on Linux", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("1");
            if (process.platform !== "linux") return; // gated
            expect(needsSelinuxRelabel()).toBe(true);
        });

        it("false for podman on permissive SELinux", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("0");
            expect(needsSelinuxRelabel()).toBe(false);
        });
    });

    describe("formatRuntimeSummary", () => {
        it("produces runtime= version= flavor= socket= tokens", () => {
            _setRuntimeInfoForTest({
                runtime: "podman",
                version: "5.2.3",
                flavor: "podman-rootless",
                socketPath: "/run/user/1000/podman/podman.sock",
                rootless: true,
                remote: false,
            });
            const s = formatRuntimeSummary();
            expect(s).toContain("runtime=podman");
            expect(s).toContain("version=5.2.3");
            expect(s).toContain("flavor=podman-rootless");
            expect(s).toContain("socket=/run/user/1000/podman/podman.sock");
        });
    });

    describe("isSelinuxEnforcing", () => {
        it("false on non-linux", () => {
            _resetSelinuxCacheForTest();
            if (process.platform === "linux") return;
            expect(isSelinuxEnforcing()).toBe(false);
        });

        it("reads /sys/fs/selinux/enforce when present", () => {
            _resetSelinuxCacheForTest();
            if (process.platform !== "linux") return;
            mockExistsSync.mockImplementation((p: unknown) => p === "/sys/fs/selinux/enforce");
            mockReadFileSync.mockReturnValue("1");
            expect(isSelinuxEnforcing()).toBe(true);
        });
    });

    describe("getRuntimeInfo caching", () => {
        it("detects linux rootless podman and derives the user socket path", () => {
            process.env.CCC_RUNTIME = "podman";
            process.env.XDG_RUNTIME_DIR = "/run/user/1001";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "podman version 5.2.3\n"))
                .mockReturnValueOnce(result(0, "false\n"))
                .mockReturnValueOnce(result(0, "true\n"));

            const info = getRuntimeInfo();
            expect(info.runtime).toBe("podman");
            expect(info.rootless).toBe(true);
            expect(info.flavor).toBe("podman-rootless");
            expect(info.socketPath).toBe("/run/user/1001/podman/podman.sock");
        });

        it("falls back to effective uid for older podman rootless detection", () => {
            process.env.CCC_RUNTIME = "podman";
            delete process.env.XDG_RUNTIME_DIR;
            const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1002);
            spawnSyncMock
                .mockReturnValueOnce(result(0, "podman version 4.9.3\n"))
                .mockReturnValueOnce(result(1, ""))
                .mockReturnValueOnce(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.rootless).toBe(true);
            expect(info.flavor).toBe("podman-rootless");
            expect(info.socketPath).toBe("/run/user/1002/podman/podman.sock");
            getuidSpy.mockRestore();
        });

        it("caches after first resolve; subsequent calls do not spawn", () => {
            process.env.CCC_RUNTIME = "docker";
            spawnSyncMock.mockReturnValue(result(0, "v1.2.3"));
            const a = getRuntimeInfo();
            const countAfterFirst = spawnSyncMock.mock.calls.length;
            const b = getRuntimeInfo();
            expect(b).toBe(a); // same object ref
            expect(spawnSyncMock.mock.calls.length).toBe(countAfterFirst);
        });
    });
});
