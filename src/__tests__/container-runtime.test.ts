import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import { runWithNativeRuntimeInvocation } from "../adapters/container-runtime-invocation.js";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
const metadataMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
let fixtureDockerHost = "unix:///fixture/docker.sock";
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: (...args: unknown[]) => {
        const argv = args[1] as string[];
        if (argv.includes("context") || (argv.includes("info") && (argv.at(-1) === "json" || argv.at(-1) === "{{json .}}"))) return metadataMock(...args);
        return spawnSyncMock(...args);
    } };
});

// Mock fs — some branches read /sys/fs/selinux/enforce
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue("");
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        accessSync: () => {},
        statSync: () => ({ isFile: () => true }),
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    };
});

const {
    runtimeCli,
    getRuntimeInfo,
    peekRuntimeInvocation,
    setRuntimeOverride,
    isContainerHostRemote,
    needsSelinuxRelabel,
    isSelinuxEnforcing,
    bindMountArgs,
    runtimeExtraRunArgs,
    formatRuntimeSummary,
    _resetRuntimeCacheForTest,
    _setRuntimeInfoForTest,
    _setRuntimeInvocationForTest,
    _resetSelinuxCacheForTest,
} = await import("../container-runtime.js");

function result(status: number, stdout = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

function nestedDockerInvocation(host = "unix:///fixture/docker.sock"): NativeRuntimeInvocation {
    return {
        version: 1, runtime: "docker", executable: "/fixture/bin/docker",
        transport: { kind: "docker", host, configDirectory: "/fixture/docker-config", tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, key === "PATH" ? "/fixture/bin" : null])) as NativeRuntimeInvocation["selectors"],
    };
}

function pinNestedDockerInvocation(): void {
    _setRuntimeInvocationForTest(nestedDockerInvocation());
}

function pinWindowsCaptureEnvironment(): void {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "cwd").mockReturnValue("C:\\fixture\\work");
    process.env.PATH = "C:\\fixture\\bin";
    process.env.PATHEXT = ".EXE";
    process.env.HOME = "C:\\fixture\\home";
    process.env.USERPROFILE = "C:\\fixture\\home";
    process.env.DOCKER_CONFIG = "C:\\fixture\\docker-config";
}

describe("container-runtime", () => {
    const origEnv = { ...process.env };

    beforeEach(() => {
        spawnSyncMock.mockReset();
        fixtureDockerHost = "unix:///fixture/docker.sock";
        metadataMock.mockReset().mockImplementation((_command, argv) => {
            const args = argv as string[];
            return result(0, JSON.stringify(args.includes("context")
                ? { Name: process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? "default" : "native-fixture", Endpoints: { docker: { Host: !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST ? process.env.DOCKER_HOST : fixtureDockerHost, SkipTLSVerify: false } }, TLSMaterial: {}, Storage: { TLSPath: process.platform === "win32" ? "C:\\fixture\\docker-config\\contexts\\tls\\native-fixture" : "/fixture/docker-config/contexts/tls/native-fixture" } }
                : { host: { serviceIsRemote: false }, store: { graphRoot: "/fixture/store", runRoot: "/fixture/run", graphDriverName: "overlay" } }));
        });
        mockExistsSync.mockReset().mockReturnValue(false);
        mockReadFileSync.mockReset().mockReturnValue("");
        _resetRuntimeCacheForTest();
        _resetSelinuxCacheForTest();
        // Scrub env of any pollution from other suites or the shell.
        delete process.env.CCC_RUNTIME;
        delete process.env.DOCKER_HOST;
        delete process.env.DOCKER_CONTEXT;
        delete process.env.DOCKER_TLS;
        delete process.env.DOCKER_TLS_VERIFY;
        delete process.env.DOCKER_CERT_PATH;
        delete process.env.CONTAINER_HOST;
        delete process.env.CONTAINER_CONNECTION;
        delete process.env.CONTAINER_SSHKEY;
        process.env.PATH = "/fixture/bin";
        process.env.HOME = "/fixture/home";
        process.env.DOCKER_CONFIG = "/fixture/docker-config";
        delete process.env.WSL_DISTRO_NAME;
        delete process.env.CCC_RUNTIME_SOCKET;
        delete process.env.XDG_RUNTIME_DIR;
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
        for (const key of Object.keys(process.env)) if (!(key in origEnv)) delete process.env[key];
        Object.assign(process.env, origEnv);
        vi.restoreAllMocks();
    });

    describe("read-only captured invocation", () => {
        it("does not discover an uncaptured runtime or execute capability probes", () => {
            process.env.CCC_RUNTIME = "docker";
            expect(peekRuntimeInvocation()).toBeUndefined();
            expect(spawnSyncMock).not.toHaveBeenCalled();
            expect(metadataMock).not.toHaveBeenCalled();
        });

        it("retains the existing validated capture despite later mutable selector changes", () => {
            const retained = nestedDockerInvocation("unix:///fixture/retained.sock");
            _setRuntimeInvocationForTest(retained);
            const captured = peekRuntimeInvocation();
            process.env.DOCKER_HOST = "unix:///fixture/later.sock";
            process.env.DOCKER_CONTEXT = "different-alias";
            expect(peekRuntimeInvocation()).toBe(captured);
            expect(captured).toEqual(retained);
            expect(spawnSyncMock).not.toHaveBeenCalled();
            expect(metadataMock).not.toHaveBeenCalled();
        });

        it("prefers the current native scope and restores the cached capture after it ends", () => {
            const cached = nestedDockerInvocation("unix:///fixture/cached.sock");
            const scoped = nestedDockerInvocation("unix:///fixture/scoped.sock");
            _setRuntimeInvocationForTest(cached);
            runWithNativeRuntimeInvocation(scoped, () => expect(peekRuntimeInvocation()).toEqual(scoped));
            expect(peekRuntimeInvocation()).toEqual(cached);
            expect(spawnSyncMock).not.toHaveBeenCalled();
            expect(metadataMock).not.toHaveBeenCalled();
        });
    });

    describe("resolveRuntime", () => {
        it("prefers podman when both runtimes are on PATH", () => {
            // podman --version succeeds first
            spawnSyncMock
                .mockReturnValueOnce(result(0, "podman version 5.2.3\n")) // podman --version (isRuntimeOnPath)
                .mockReturnValue(result(0, ""));                             // subsequent version/rootless probes
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
            expect(bindMountArgs("/x", "/y", { readonly: true })).toEqual(["-v", "/x:/y:ro,Z"]);
        });

        it("translates nested-container bind mount sources to the outer host source", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            pinNestedDockerInvocation();
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
                `${join("/run/desktop/mnt/host/c/Users/me/.ccc/codex", "config.toml")}:/tmp/config.toml`,
            ]);
        });

        it("uses the longest matching nested-container mount destination", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            pinNestedDockerInvocation();
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                { Source: "/outer/home", Destination: "/home/ccc" },
                { Source: "/outer/codex", Destination: "/home/ccc/.codex" },
            ])));

            expect(bindMountArgs("/home/ccc/.codex/auth.json", "/auth.json")).toEqual([
                "-v",
                `${join("/outer/codex", "auth.json")}:/auth.json`,
            ]);
        });

        it("keeps the first equal-length match and excludes sibling prefixes", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            pinNestedDockerInvocation();
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                { Source: "/first", Destination: "/project" },
                { Source: "/second", Destination: "/project" },
            ])));
            expect(bindMountArgs("/project/file", "/target")).toEqual(["-v", `${join("/first", "file")}:/target`]);
            expect(bindMountArgs("/project-other/file", "/target")).toEqual(["-v", "/project-other/file:/target"]);
        });

        it("preserves daemon namespace sources inside a nested Docker container", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            expect(bindMountArgs("/configured/socket", "/var/run/docker.sock", { sourceNamespace: "daemon" })).toEqual(["-v", "/configured/socket:/var/run/docker.sock"]);
            expect(spawnSyncMock).not.toHaveBeenCalled();
        });

        it("normalizes Docker Desktop Windows mount sources for nested docker", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            pinNestedDockerInvocation();
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([
                {
                    Source: "C:\\Users\\TestUser\\.ccc\\codex",
                    Destination: "/home/ccc/.codex",
                },
            ])));

            expect(bindMountArgs("/home/ccc/.codex/config.toml", "/tmp/config.toml")).toEqual([
                "-v",
                `${join("/run/desktop/mnt/host/c/Users/TestUser/.ccc/codex", "config.toml")}:/tmp/config.toml`,
            ]);
            expect(spawnSyncMock).toHaveBeenCalledWith("/fixture/bin/docker",
                ["--config", "/fixture/docker-config", "--host", "unix:///fixture/docker.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey=", "inspect", "ccc-parent", "--format", "{{json .Mounts}}"],
                expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", shell: false, env: expect.objectContaining({ PATH: "/fixture/bin" }) }));
            expect(metadataMock).not.toHaveBeenCalled();
        });

        it("keeps concurrent native scopes' outer-mount observations separate and reuses each captured observation", async () => {
            process.env.container = "docker";
            process.env.HOSTNAME = "same-parent-id";
            spawnSyncMock.mockImplementation((_command, argv) => {
                const args = argv as string[];
                if (args.at(-1) === "{{json .Mounts}}") return result(0, JSON.stringify([{ Source: args.includes("unix:///fixture/engine-a.sock") ? "/outer/a" : "/outer/b", Destination: "/project" }]));
                if (args.includes("--version")) return result(0, "Docker version 27.1.1");
                if (args.at(-1) === "{{.OperatingSystem}}") return result(0, "Ubuntu");
                if (args.at(-1) === "{{json .SecurityOptions}}") return result(0, "[]");
                throw Error("unconfigured native probe in concurrent mount fixture");
            });
            let releaseA!: () => void;
            const bObserved = new Promise<void>(resolve => { releaseA = resolve; });
            const first = runWithNativeRuntimeInvocation(nestedDockerInvocation("unix:///fixture/engine-a.sock"), async () => {
                expect(bindMountArgs("/project/file", "/target")).toEqual(["-v", `${join("/outer/a", "file")}:/target`]);
                await bObserved;
                expect(bindMountArgs("/project/file", "/target")).toEqual(["-v", `${join("/outer/a", "file")}:/target`]);
            });
            const second = runWithNativeRuntimeInvocation(nestedDockerInvocation("unix:///fixture/engine-b.sock"), async () => {
                await Promise.resolve();
                expect(bindMountArgs("/project/file", "/target")).toEqual(["-v", `${join("/outer/b", "file")}:/target`]);
                releaseA();
            });
            await Promise.all([first, second]);
            const inspections = spawnSyncMock.mock.calls.filter(call => (call[1] as string[]).at(-1) === "{{json .Mounts}}");
            expect(inspections).toHaveLength(2);
            expect(inspections.map(call => {
                const args = call[1] as string[];
                return args[args.indexOf("--host") + 1];
            })).toEqual(["unix:///fixture/engine-a.sock", "unix:///fixture/engine-b.sock"]);
            for (const [command, argv, options] of inspections) {
                expect(command).toBe("/fixture/bin/docker");
                expect((argv as string[]).slice(-4)).toEqual(["inspect", "same-parent-id", "--format", "{{json .Mounts}}"]);
                expect(options).toMatchObject({ shell: false, env: { PATH: "/fixture/bin" } });
            }
            expect(metadataMock).not.toHaveBeenCalled();
        });

        it("keeps current-container paths unchanged for nested local podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman" });
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";

            expect(bindMountArgs("/home/ccc/.codex", "/home/ccc/.codex")).toEqual([
                "-v",
                "/home/ccc/.codex:/home/ccc/.codex",
            ]);
            expect(spawnSyncMock.mock.calls.some(call => (call[1] as string[]).includes("inspect"))).toBe(false);
            expect(metadataMock).not.toHaveBeenCalled();
        });

        it.each([["VITEST", "0"], ["VITEST", "1"], ["VITEST_POOL_ID", "1"]] as const)("observes nested Docker mounts with %s=%s", (marker, value) => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            pinNestedDockerInvocation();
            process.env.container = "docker";
            process.env.HOSTNAME = "ccc-parent";
            process.env[marker] = value;
            spawnSyncMock.mockReturnValue(result(0, JSON.stringify([{Source: "/outer/codex", Destination: "/home/ccc/.codex"}])));

            expect(bindMountArgs("/home/ccc/.codex/config.toml", "/config.toml")).toEqual([
                "-v",
                `${join("/outer/codex", "config.toml")}:/config.toml`,
            ]);
            expect(spawnSyncMock).toHaveBeenCalledWith("/fixture/bin/docker", expect.arrayContaining(["inspect", "ccc-parent", "--format", "{{json .Mounts}}"]),
                expect.objectContaining({timeout: 5000, killSignal: "SIGKILL", shell: false}));
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
        it("lets an explicit remote context override a local Desktop host endpoint", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            vi.spyOn(process, "cwd").mockReturnValue("/fixture/work");
            process.env.CCC_RUNTIME = "docker";
            process.env.DOCKER_CONTEXT = "selected-remote";
            process.env.DOCKER_HOST = "unix:///desktop.sock";
            fixtureDockerHost = "ssh://remote@example.test";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Docker Desktop\n"))
                .mockReturnValue(result(1));
            expect(getRuntimeInfo().dockerDesktop).toBe(false);
            expect(metadataMock).toHaveBeenCalledWith(expect.stringMatching(/docker(?:\.exe)?$/i), ["--config", "/fixture/docker-config", "context", "inspect", "--format", "{{json .}}", "--", "selected-remote"], expect.objectContaining({ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 }));
        });
        it("reflects the cached remote flag", () => {
            _setRuntimeInfoForTest({ runtime: "docker", remote: true });
            expect(isContainerHostRemote()).toBe(true);
            _setRuntimeInfoForTest({ runtime: "podman", remote: false });
            expect(isContainerHostRemote()).toBe(false);
        });

        it("detects Docker Desktop from docker info as VM-backed", () => {
            process.env.CCC_RUNTIME = "docker";
            fixtureDockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Docker Desktop\n"))
                .mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.remote).toBe(true);
            expect(info.flavor).toBe("docker-desktop");
            expect(info.dockerDesktop).toBe(true);
        });

        it("detects native Windows Docker Desktop from its exact local Linux-engine npipe when docker info is unavailable", () => {
            pinWindowsCaptureEnvironment();
            process.env.CCC_RUNTIME = "docker";
            fixtureDockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(1, ""))
                .mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.remote).toBe(true);
            expect(info.flavor).toBe("docker-desktop");
            expect(info.dockerDesktop).toBe(true);
        });

        it("does not infer Docker Desktop from a generic local Windows npipe", () => {
            pinWindowsCaptureEnvironment();
            process.env.CCC_RUNTIME = "docker";
            fixtureDockerHost = "npipe:////./pipe/docker_engine";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(1, ""))
                .mockReturnValue(result(1, ""));

            expect(getRuntimeInfo().dockerDesktop).toBe(false);
        });

        it("does not let the Desktop npipe override a successful non-Desktop daemon identity", () => {
            pinWindowsCaptureEnvironment();
            process.env.CCC_RUNTIME = "docker";
            process.env.DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Windows Server 2025\n"))
                .mockReturnValue(result(1, ""));

            expect(getRuntimeInfo().dockerDesktop).toBe(false);
            expect(metadataMock).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["SSH context", undefined, "ssh://builder@example.test"],
            ["TCP DOCKER_HOST", "tcp://example.test:2376", undefined],
        ])("does not grant Docker Desktop capability through a remote %s", (_name, dockerHost, contextEndpoint) => {
            process.env.CCC_RUNTIME = "docker";
            if (dockerHost) process.env.DOCKER_HOST = dockerHost;
            if (contextEndpoint) fixtureDockerHost = contextEndpoint;
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Docker Desktop\n"));
            spawnSyncMock.mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.dockerDesktop).toBe(false);
        });

        it("WSL2 NAT mode (no loopback0) is treated as remote", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            process.env.CCC_RUNTIME = "docker";
            process.env.WSL_DISTRO_NAME = "Ubuntu";
            // mockExistsSync default returns false → loopback0 absent
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Ubuntu 24.04 LTS\n"))   // not Docker Desktop
                .mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.remote).toBe(true);
            expect(info.dockerDesktop).toBe(false);
            delete process.env.WSL_DISTRO_NAME;
        });

        it("WSL2 mirrored mode (loopback0 present) is treated as local", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            process.env.CCC_RUNTIME = "docker";
            process.env.WSL_DISTRO_NAME = "Ubuntu";
            mockExistsSync.mockImplementation((p: unknown) => p === "/sys/class/net/loopback0");
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1\n"))
                .mockReturnValueOnce(result(0, "Ubuntu 24.04 LTS\n"))
                .mockReturnValue(result(1, ""));

            const info = getRuntimeInfo();
            expect(info.remote).toBe(false);
            expect(info.flavor).toBe("docker-native");
            expect(info.dockerDesktop).toBe(false);
            delete process.env.WSL_DISTRO_NAME;
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
        it("detects linux rootless docker", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            process.env.CCC_RUNTIME = "docker";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "Docker version 27.1.1, build abc\n"))
                .mockReturnValueOnce(result(0, "Docker Engine - Community\n"))
                .mockReturnValueOnce(result(0, "[\"name=rootless\"]\n"));

            const info = getRuntimeInfo();
            expect(info.runtime).toBe("docker");
            expect(info.rootless).toBe(true);
            expect(info.flavor).toBe("docker-rootless");
        });

        it("detects linux rootless podman and derives the user socket path", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            process.env.CCC_RUNTIME = "podman";
            process.env.XDG_RUNTIME_DIR = "/run/user/1001";
            spawnSyncMock
                .mockReturnValueOnce(result(0, "podman version 5.2.3\n"))
                .mockReturnValueOnce(result(0, "true\n"));

            const info = getRuntimeInfo();
            expect(info.runtime).toBe("podman");
            expect(info.rootless).toBe(true);
            expect(info.flavor).toBe("podman-rootless");
            expect(info.socketPath).toBe(join("/run/user/1001", "podman", "podman.sock"));
        });

        it("falls back to effective uid for older podman rootless detection", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            process.env.CCC_RUNTIME = "podman";
            delete process.env.XDG_RUNTIME_DIR;
            const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
            Object.defineProperty(process, "getuid", {configurable: true, value: () => 1002});
            try {
                spawnSyncMock
                    .mockReturnValueOnce(result(0, "podman version 4.9.3\n"))
                    .mockReturnValueOnce(result(1, ""));
                const info = getRuntimeInfo();
                expect(info.rootless).toBe(true);
                expect(info.flavor).toBe("podman-rootless");
                expect(info.socketPath).toBe(join("/run/user/1002", "podman", "podman.sock"));
            } finally {
                if (descriptor) Object.defineProperty(process, "getuid", descriptor); else Reflect.deleteProperty(process, "getuid");
            }
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
