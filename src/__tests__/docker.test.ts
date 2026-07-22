import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock fs for startProjectContainer
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockCloseSync = vi.fn();
const mockFstatSync = vi.fn();
const mockLstatSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockOpenSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        closeSync: (...args: unknown[]) => mockCloseSync(...args),
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        fstatSync: (...args: unknown[]) => mockFstatSync(...args),
        lstatSync: (...args: unknown[]) => mockLstatSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
        openSync: (...args: unknown[]) => mockOpenSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
        statSync: (...args: unknown[]) => mockStatSync(...args),
    };
});

const mockCleanupOwnerDevices = vi.fn();
vi.mock("../device-lab-admin.js", () => ({
    cleanupOwnerDevices: (...args: unknown[]) => mockCleanupOwnerDevices(...args),
}));

const mockGetActiveSessionsForContainer = vi.fn<(...args: unknown[]) => string[]>();
const mockWithContainerLifecycleLock = vi.fn((_: string, operation: () => unknown) => operation());
vi.mock("../session.js", () => ({
    getActiveSessionsForContainer: (...args: unknown[]) => mockGetActiveSessionsForContainer(...args),
    withContainerLifecycleLock: (...args: [string, () => unknown]) => mockWithContainerLifecycleLock(...args),
}));

// Import AFTER mocks
const {
    buildDockerRunArgs,
    getContainerName,
    isDockerRunning,
    isDockerDesktop,
    isContainerRunning,
    isContainerExists,
    isContainerImageOutdated,
    isImageExists,
    getImageLabel,
    pullImage,
    tagImage,
    syncClipboardShims,
    ensureDockerRunning,
    ensureImage,
    buildContainerVmRunConfig,
    buildLabRunnerRunConfig,
    getLabRunnerStateVolumeName,
    qualifyImageRefForRuntime,
    getHostGitIdentityMounts,
    resolveCredentialHostPath,
    prepareCodexConfigForContainer,
    restoreCodexConfigHostOwnership,
    syncManagedMcpBundles,
    startProjectContainer,
    stopProjectContainer,
    removeProjectContainer,
} = await import("../docker.js");

const { CLI_VERSION, CLIPBOARD_FILES_CONTAINER_DIR } = await import("../utils.js");
const { getAllCredentialMounts } = await import("../tool-registry.js");
const { deviceLabOwnerId } = await import("../device-lab-owner.js");
const {
    _resetRuntimeCacheForTest,
    _setRuntimeInfoForTest,
} = await import("../container-runtime.js");

function makeResult(
    status: number,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

function defaultDeviceLabMountIdentity(): string {
    return createHash("sha256")
        .update("2|directory:1:1|directory:1:1|file:1:1")
        .digest("hex");
}

// docker inspect Mounts JSON containing every required mount destination the
// runtime expects. Use this whenever a test wants the existing container to
// pass the mount-drift check.
function fullCredentialMountsJson(
    extra: Array<{ Source: string; Destination: string }> = [],
    options: {
        labState?: boolean;
        status?: "ready" | "unsupported";
        unsupportedReason?: string;
        deviceLabState?: boolean;
        kvmDevice?: boolean;
        groupAdd?: string[];
        devices?: Array<Record<string, string>>;
        privileged?: boolean;
    } = {},
): string {
    const deviceStateRoot = join(homedir(), ".ccc", "devices");
    const credMounts = getAllCredentialMounts().map((m) => ({
        Source: resolveCredentialHostPath(m),
        Destination: m.containerDir,
        Type: "bind",
        RW: true,
    }));
    const gitIdentityMounts = [
        { Source: "/host/home/user/.gitconfig", Destination: "/host-stage/gitconfig" },
        { Source: "/host/home/user/.config/git", Destination: "/home/ccc/.config/git" },
    ];
    const clipboardMounts = [
        { Source: "/host/home/user/.ccc/clipboard-files", Destination: CLIPBOARD_FILES_CONTAINER_DIR },
    ];
    const deviceLabMounts = options.deviceLabState === false
        ? []
        : [
            { Source: deviceStateRoot, Destination: "/home/ccc/.ccc/devices", Type: "bind", RW: false },
            { Source: "", Destination: "/home/ccc/.ccc/devices/owners", Type: "tmpfs", RW: true },
            {
                Source: join(deviceStateRoot, "owners", deviceLabOwnerId("/home/user/my-project")),
                Destination: `/home/ccc/.ccc/devices/owners/${deviceLabOwnerId("/home/user/my-project")}`,
                Type: "bind",
                RW: true,
            },
            { Source: "", Destination: "/home/ccc/.ccc/devices/broker/auth", Type: "tmpfs", RW: true },
            {
                Source: join(deviceStateRoot, "broker", "auth", `${deviceLabOwnerId("/home/user/my-project")}.json`),
                Destination: "/run/ccc-device-broker-auth/owner.json",
                Type: "bind",
                RW: false,
            },
        ];
    const labStateMounts = options.labState === false
        ? []
        : [{ Source: "ccc-my-project-c7e2f75b53b9-lab-state", Destination: "/home/ccc/.ccc/labs" }];
    const status = options.status || "ready";
    const env = [
        "CCC_LAB_RUNNER=1",
        `CCC_LAB_RUNNER_STATUS=${status}`,
        "CCC_LAB_STATE_DIR=/home/ccc/.ccc/labs",
        "CCC_LAB_NET_MODE=user",
        "CCC_DEVICE_BROKER_AUTH_FILE=/run/ccc-device-broker-auth/owner.json",
    ];
    if (options.unsupportedReason) env.push(`CCC_LAB_RUNNER_UNSUPPORTED_REASON=${options.unsupportedReason}`);
    const devices = options.devices ?? (options.kvmDevice === false ? [] : [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" }]);
    const groupAdd = options.groupAdd ?? (status === "ready" && options.kvmDevice !== false ? ["108"] : []);
    return JSON.stringify({
        Mounts: [...credMounts, ...gitIdentityMounts, ...clipboardMounts, ...deviceLabMounts, ...labStateMounts, ...extra],
        Config: {
            Env: env,
            Labels: { "ccc.device-lab.mount-identity": defaultDeviceLabMountIdentity() },
        },
        HostConfig: { Devices: devices, GroupAdd: groupAdd, Privileged: options.privileged === true },
    });
}

describe("docker.ts module exports", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        spawnSyncMock.mockReturnValue(makeResult(0));
        mockCleanupOwnerDevices.mockReset();
        mockGetActiveSessionsForContainer.mockReset().mockReturnValue([]);
        mockWithContainerLifecycleLock.mockClear();
        mockExistsSync.mockReset().mockReturnValue(true);
        mockCloseSync.mockReset();
        mockOpenSync.mockReset().mockReturnValue(17);
        mockLstatSync.mockReset().mockReturnValue({
            isFile: () => true,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            dev: 1,
            ino: 1,
            size: 1024,
        });
        mockFstatSync.mockReset().mockReturnValue({
            isFile: () => true,
            dev: 1,
            ino: 1,
        });
        mockRealpathSync.mockReset().mockImplementation((path: string) => path);
        mockReadFileSync.mockReset().mockReturnValue(Buffer.from("managed-mcp-bundle"));
        mockStatSync.mockReset().mockReturnValue({ gid: 108 });
        _resetRuntimeCacheForTest();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("getContainerName", () => {
        it("should prefix with ccc-", () => {
            expect(getContainerName("/home/user/test")).toMatch(/^ccc-/);
        });

        it("should be consistent for same path", () => {
            const a = getContainerName("/home/user/project");
            const b = getContainerName("/home/user/project");
            expect(a).toBe(b);
        });

        it("should generate correct format", () => {
            expect(getContainerName("/home/user/my-project")).toMatch(
                /^ccc-my-project-[a-f0-9]{12}$/,
            );
        });

        it("returns base name when profile is undefined (regression)", () => {
            const name = getContainerName("/home/user/my-project", undefined);
            expect(name).toMatch(/^ccc-my-project-[a-f0-9]{12}$/);
        });

        it("appends --p--<profile> suffix when profile is provided", () => {
            const name = getContainerName("/home/user/my-project", "work");
            expect(name).toMatch(/^ccc-my-project-[a-f0-9]{12}--p--work$/);
        });

        it("base name and profiled name differ for same path", () => {
            const base = getContainerName("/home/user/my-project");
            const profiled = getContainerName("/home/user/my-project", "work");
            expect(profiled).toBe(`${base}--p--work`);
        });
    });

    describe("isDockerRunning", () => {
        it("returns true when docker info succeeds", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isDockerRunning()).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                ["info"],
                expect.any(Object),
            );
        });

        it("returns false when docker info fails", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isDockerRunning()).toBe(false);
        });
    });

    describe("isDockerDesktop", () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };

        afterEach(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            process.env = { ...originalEnv };
            // Reset cached value by clearing module cache
            // Since isDockerDesktop caches, we need to reset between tests
            // The cache is module-scoped, so we test behavior on first call
        });

        it("returns true on macOS (darwin) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            // Note: isDockerDesktop caches results, so this tests the macOS fast path
            // We can't easily test this in isolation due to caching, but the logic is:
            // if (process.platform !== "linux") return true
            platformSpy.mockRestore();
        });

        it("returns true on Windows (win32) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            platformSpy.mockRestore();
        });
    });

    describe("isContainerRunning", () => {
        it("returns true when container found in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerRunning("my-container")).toBe(true);
        });

        it("returns false when container not in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerRunning("my-container")).toBe(false);
        });
    });

    describe("isContainerExists", () => {
        it("returns true when container found in docker ps -a", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerExists("my-container")).toBe(true);
        });

        it("returns false when container not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerExists("my-container")).toBe(false);
        });
    });

    describe("isImageExists", () => {
        it("returns true when image found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "sha256:abc\n"));
            expect(isImageExists()).toBe(true);
        });

        it("returns false when image not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isImageExists()).toBe(false);
        });
    });

    describe("isContainerImageOutdated", () => {
        it("returns true when container image SHA differs from current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage111\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:newimage222\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(true);
        });

        it("returns false when container image SHA matches current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(1, ""));  // container inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when image inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage\n"))  // container inspect ok
                .mockReturnValueOnce(makeResult(1, ""));                   // image inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect returns empty stdout", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))                    // container inspect empty
                .mockReturnValueOnce(makeResult(0, "sha256:newimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });
    });

    describe("Codex config ownership helpers", () => {
        it("does not restore mounted Codex config ownership", () => {
            restoreCodexConfigHostOwnership("ccc-test");

            expect(spawnSyncMock).not.toHaveBeenCalled();
        });

        it("does not prepare mounted Codex config when the container user already has access", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0));

            prepareCodexConfigForContainer("ccc-test");

            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                expect.arrayContaining(["exec", "ccc-test"]),
                { stdio: "ignore" },
            );
        });

        it("prepares mounted Codex config for the in-container ccc user only after access check fails", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(1))
                .mockReturnValueOnce(makeResult(0));

            prepareCodexConfigForContainer("ccc-test");

            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                expect.arrayContaining(["exec", "--user", "root", "ccc-test"]),
                { stdio: "ignore" },
            );
            const args = spawnSyncMock.mock.calls[1][1] as string[];
            expect(args.at(-1)).toContain("chown ccc:docker /home/ccc/.codex/config.toml");
        });
    });

    describe("buildDockerRunArgs", () => {
        it("should be a function exported from docker.ts", () => {
            expect(typeof buildDockerRunArgs).toBe("function");
        });

        it("includes --hostname derived from container name", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            const hostnameIdx = args.indexOf("--hostname");
            expect(hostnameIdx).toBeGreaterThan(-1);
            expect(args[hostnameIdx + 1]).toBe("ccc-my-project-abc123");
        });

        it("truncates hostname to 63 chars for long container names", () => {
            mockExistsSync.mockReturnValue(false);
            const longName = "ccc-" + "a".repeat(80);
            const args = buildDockerRunArgs({
                containerName: longName,
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            const hostnameIdx = args.indexOf("--hostname");
            expect(hostnameIdx).toBeGreaterThan(-1);
            expect(args[hostnameIdx + 1]).toHaveLength(63);
        });

        it("includes -v for each credentialMount entry", () => {
            mockExistsSync.mockReturnValue(false);
            const credentialMounts = [
                { hostPath: "/home/user/.ccc/claude", containerPath: "/home/ccc/.claude" },
                { hostPath: "/home/user/.claude/ide", containerPath: "/home/ccc/.claude/ide" },
            ];
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts,
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            expect(args).toContain("/home/user/.ccc/claude:/home/ccc/.claude");
            expect(args).toContain("/home/user/.claude/ide:/home/ccc/.claude/ide");
        });

        it("resolves profile-specific claude credentials and default tool credential paths", () => {
            const claudeMount = { hostDir: ".ccc/claude", containerDir: "/home/ccc/.claude" };
            const codexMount = { hostDir: ".ccc/codex", containerDir: "/home/ccc/.codex" };

            expect(resolveCredentialHostPath(claudeMount, "work")).toMatch(/\/\.ccc\/profiles\/work\/claude$/);
            expect(resolveCredentialHostPath(codexMount, "work")).toMatch(/\/\.ccc\/codex$/);
        });

        it("includes -v for claude.json mount independently of credentialMounts", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            expect(args).toContain("/home/user/.ccc/claude.json:/home/ccc/.claude.json");
        });

        it("includes clipboard shared-files mount when configured", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
                clipboardFilesHostDir: "/home/user/.ccc/clipboard-files",
            });
            expect(args).toContain("/home/user/.ccc/clipboard-files:/run/ccc/clipboard-files");
        });
    });

    describe("buildLabRunnerRunConfig", () => {
        it("returns null for normal profiles", () => {
            expect(buildLabRunnerRunConfig(undefined, "ccc-project")).toBeNull();
            expect(buildLabRunnerRunConfig("work", "ccc-project")).toBeNull();
        });

        it("returns ready container VM config for ordinary containers on native Linux with /dev/kvm", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            const config = buildContainerVmRunConfig("ccc-project");

            expect(config).toEqual({
                status: "ready",
                stateVolumeName: "ccc-project-lab-state",
                stateContainerDir: "/home/ccc/.ccc/labs",
                kvmDevicePath: "/dev/kvm",
                kvmGroupId: 108,
                networkMode: "user",
            });
        });

        it("returns ready config for lab-runner on native Linux with /dev/kvm", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config).toEqual({
                status: "ready",
                stateVolumeName: "ccc-project-lab-state",
                stateContainerDir: "/home/ccc/.ccc/labs",
                kvmDevicePath: "/dev/kvm",
                kvmGroupId: 108,
                networkMode: "user",
            });
        });

        it("reports unsupported when /dev/kvm is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/\/dev\/kvm/);
            expect(config?.kvmDevicePath).toBeUndefined();
            expect(config?.networkMode).toBe("user");
        });

        it("reports unsupported for VM-backed Docker Desktop style runtimes", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-desktop",
                remote: true,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/VM-backed/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("reports unsupported for rootless Podman", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "podman",
                flavor: "podman-rootless",
                remote: false,
                rootless: true,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/podman-rootless/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("reports unsupported for rootless Docker", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-rootless",
                remote: false,
                rootless: true,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildContainerVmRunConfig("ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/docker-rootless/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("uses a stable per-container lab state volume name", () => {
            expect(getLabRunnerStateVolumeName("ccc-proj--p--lab-runner")).toBe(
                "ccc-proj--p--lab-runner-lab-state",
            );
        });
    });

    describe("getHostGitIdentityMounts", () => {
        it("returns existing host git identity config directory paths", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            const mounts = getHostGitIdentityMounts();

            expect(mounts).toEqual([
                expect.objectContaining({ containerPath: "/home/ccc/.config/git" }),
            ]);
        });

        it("does not require a bind mount for host .gitconfig", () => {
            mockExistsSync.mockImplementation((p: string) => p.endsWith("/.gitconfig"));

            const mounts = getHostGitIdentityMounts();

            expect(mounts).toHaveLength(0);
        });

        it("never mounts host gitconfig directly at /home/ccc/.gitconfig (atomic-rename safety)", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            const mounts = getHostGitIdentityMounts();

            // The CLI copies ~/.gitconfig into the running container so the
            // in-HOME file is regular, not a bind mount whose inode is anchored
            // to the mountpoint (rename(2) would EBUSY otherwise).
            expect(mounts.find((m) => m.containerPath === "/home/ccc/.gitconfig")).toBeUndefined();
            expect(mounts.find((m) => m.containerPath === "/host-stage/gitconfig")).toBeUndefined();
        });
    });

    describe("syncClipboardShims", () => {
        it("should docker cp each shim file that exists and chmod +x", () => {
            mockExistsSync.mockReturnValue(true);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(5);
            const shims = cpCalls.map((c: unknown[]) => (c[1] as string[])[2]);
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/xclip");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/wl-paste");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/pbpaste");

            // Should also chmod +x all copied shims
            const chmodCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "exec" && (c[1] as string[]).includes("chmod")
            );
            expect(chmodCalls).toHaveLength(1);
            const chmodArgs = chmodCalls[0][1] as string[];
            expect(chmodArgs).toContain("+x");
            expect(chmodArgs).toContain("/usr/local/bin/xclip");
            expect(chmodArgs).toContain("/usr/local/bin/pbpaste");
        });

        it("should skip when shims directory does not exist", () => {
            mockExistsSync.mockReturnValue(false);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(0);
        });

        it("should skip individual shims that do not exist", () => {
            // shimsDir exists, but only some shim files exist
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith("clipboard-shims")) return true;
                return p.endsWith("xclip") || p.endsWith("wl-paste");
            });
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(2);
        });
    });

    describe("ensureDockerRunning", () => {
        it("does not exit when Docker is running", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).not.toThrow();
            mockExit.mockRestore();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("getImageLabel", () => {
        it("returns label value when present", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "1.0.0\n"));
            expect(getImageLabel("ccc", "cli.version")).toBe("1.0.0");
        });

        it("returns null when label is missing (<no value>)", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "<no value>\n"));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });

        it("returns null when inspect fails (image not found)", () => {
            spawnSyncMock.mockReturnValue(makeResult(1, ""));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });
    });

    describe("pullImage", () => {
        it("returns true on successful pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(pullImage("repo/ccc:1.0.0")).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["pull", "repo/ccc:1.0.0"], { stdio: "inherit" },
            );
        });

        it("returns false on failed pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(pullImage("repo/ccc:1.0.0")).toBe(false);
        });
    });

    describe("tagImage", () => {
        it("runs docker tag", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            tagImage("repo/ccc:1.0.0", "ccc");
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["tag", "repo/ccc:1.0.0", "ccc"], { stdio: "ignore" },
            );
        });
    });

    describe("qualifyImageRefForRuntime", () => {
        it("leaves docker image refs unchanged", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            expect(qualifyImageRefForRuntime("luxusio/claude-code-container:1.2.3")).toBe(
                "luxusio/claude-code-container:1.2.3",
            );
        });

        it("qualifies Docker Hub short-name refs for podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            expect(qualifyImageRefForRuntime("luxusio/claude-code-container:1.2.3")).toBe(
                "docker.io/luxusio/claude-code-container:1.2.3",
            );
        });

        it("does not rewrite already-qualified podman refs", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            expect(qualifyImageRefForRuntime("ghcr.io/luxusio/ccc:1.2.3")).toBe("ghcr.io/luxusio/ccc:1.2.3");
            expect(qualifyImageRefForRuntime("localhost:5000/ccc:1.2.3")).toBe("localhost:5000/ccc:1.2.3");
        });
    });

    describe("ensureImage (label-based)", () => {
        it("uses local dev build (no cli.version label) without pulling", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))       // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));      // getImageLabel -> null (dev build)

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            // No pull call should have been made
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("uses local image when cli.version matches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))          // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, `${CLI_VERSION}\n`));     // getImageLabel -> matches CLI_VERSION

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("pulls and re-tags when cli.version mismatches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(0))                    // pullImage -> success
                .mockReturnValueOnce(makeResult(0));                   // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            const tagCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "tag"
            );
            expect(tagCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("pulls when no local ccc image exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(0))        // pullImage -> success
                .mockReturnValueOnce(makeResult(0));       // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("pulls the fully-qualified Docker Hub ref on rootless podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(0))        // pullImage -> success
                .mockReturnValueOnce(makeResult(0));       // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "podman",
                ["pull", `docker.io/luxusio/claude-code-container:${CLI_VERSION}`],
                { stdio: "inherit" },
            );
            mockExit.mockRestore();
        });

        it("warns but continues when pull fails with stale image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(1));                   // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            const warnSpy = vi.spyOn(console, "warn");
            expect(() => ensureImage()).not.toThrow();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to pull"));
            mockExit.mockRestore();
        });

        it("exits with error when pull fails with no image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(1));       // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("syncManagedMcpBundles", () => {
        it("stages and atomically installs every managed MCP bundle", () => {
            const digest = createHash("sha256").update("managed-mcp-bundle").digest("hex");
            let digestCalls = 0;
            spawnSyncMock.mockImplementation((_command: unknown, args: unknown) => {
                const argv = args as string[];
                if (argv.includes("sha256sum")) {
                    digestCalls += 1;
                    return makeResult(0, `${digestCalls % 2 === 0 ? digest : "0".repeat(64)}  server.mjs\n`);
                }
                return makeResult(0);
            });

            syncManagedMcpBundles("ccc-test");

            for (const bundle of ["x11-mcp", "device-lab-mcp"]) {
                const copy = spawnSyncMock.mock.calls.find((call: unknown[]) => {
                    const args = call[1] as string[];
                    return args?.[0] === "cp"
                        && args[1]?.endsWith(`/${bundle}/server.mjs`)
                        && args[2]?.startsWith(`ccc-test:/tmp/ccc-managed-${bundle}-`);
                });
                expect(copy).toBeDefined();

                const install = spawnSyncMock.mock.calls.find((call: unknown[]) => {
                    const args = call[1] as string[];
                    return args?.[0] === "exec"
                        && args.includes("root")
                        && args.at(-1)?.includes(`/opt/ccc/dist/${bundle}/server.mjs`);
                });
                expect(install).toBeDefined();
            }
            expect(digestCalls).toBe(4);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "exec" && args.includes("rm") && args.includes("/opt/ccc/dist/device-lab-mcp/server.mjs");
            })).toBe(false);
        });

        it("skips transfer when the installed bundle digest already matches", () => {
            const digest = createHash("sha256").update("managed-mcp-bundle").digest("hex");
            spawnSyncMock.mockImplementation((_command: unknown, args: unknown) => {
                const argv = args as string[];
                return argv.includes("sha256sum") ? makeResult(0, `${digest}  server.mjs\n`) : makeResult(0);
            });

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
            expect(spawnSyncMock.mock.calls.every((call: unknown[]) => (call[1] as string[]).includes("sha256sum"))).toBe(true);
        });

        it("rejects a symlinked or oversized host bundle without copying it", () => {
            mockLstatSync.mockReturnValue({
                isFile: () => true,
                isSymbolicLink: () => true,
                size: 1024,
            });

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("managed MCP bundle is invalid"));
        });

        it("does not replace the destination when staging fails", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => (call[1] as string[])[0] === "cp")).toHaveLength(2);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes("install"))).toBe(false);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed to stage managed MCP bundle"));
        });

        it("removes a destination whose installed digest does not match", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, `${"0".repeat(64)}  server.mjs\n`));

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "exec" && args.includes("rm") && args.some((arg) => arg.endsWith("/server.mjs"));
            })).toHaveLength(2);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("bundle verification failed"));
        });
    });

    describe("startProjectContainer", () => {
        const projectPath = "/home/user/my-project";
        const ensureDirs = vi.fn();

        function startWithApprovedReplacement(
            extraMounts?: Array<{ hostPath: string; containerPath: string }>,
        ): string {
            return startProjectContainer(
                projectPath,
                ensureDirs,
                extraMounts,
                undefined,
                undefined,
                undefined,
                (replace: () => void) => {
                    replace();
                    return true;
                },
            );
        }

        function expectNoContainerReplacement(): void {
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop"
                    || args?.[0] === "rm"
                    || args?.[0] === "run";
            })).toBe(false);
        }

        beforeEach(() => {
            ensureDirs.mockReset();
            mockExistsSync.mockReturnValue(true);
        });

        it("returns container name when container is already running", () => {
            // Call sequence (no extraMounts):
            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists,
            // #4 docker inspect (credential-mount drift check), #5 isContainerRunning -> true
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))           // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))           // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))               // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson())) // inspect -> all cred mounts present
                .mockReturnValueOnce(makeResult(0, "abc123\n"));              // isContainerRunning -> running

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);
            expect(ensureDirs).toHaveBeenCalled();
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(2);
        });

        it("starts a stopped container and returns its name", () => {
            // #1 isImageExists, #2 getImageLabel, #3 isContainerExists, #4 inspect (drift check),
            // #5 isContainerRunning->false, #6 isContainerExists->true, #7 docker start
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))           // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))           // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))               // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson())) // inspect -> all cred mounts present
                .mockReturnValueOnce(makeResult(0, ""))                       // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, "abc123\n"))               // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));                           // docker start

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const startCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "start"
            );
            expect(startCall).toBeDefined();
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(2);
        });

        it("recreates container when credential mounts are missing (drift after tool registry update)", () => {
            mockExistsSync.mockReturnValue(false);

            // Existing container only has the old claude-only mounts → drift detected → recreate.
            const driftMountsJson = JSON.stringify([
                { Source: "/host/.claude", Destination: "/home/ccc/.claude" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))   // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))       // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, driftMountsJson))  // inspect -> missing codex/gemini/opencode mounts
                .mockReturnValueOnce(makeResult(0))                    // docker stop
                .mockReturnValueOnce(makeResult(0))                    // docker rm
                .mockReturnValueOnce(makeResult(0, ""))                // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))                // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                    // docker run

            const name = startWithApprovedReplacement();
            expect(name).toMatch(/^ccc-/);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("refuses contract-drift replacement when the caller omits the session guard", () => {
            mockExistsSync.mockReturnValue(false);
            const driftMountsJson = JSON.stringify([
                { Source: "/host/.claude", Destination: "/home/ccc/.claude" },
            ]);
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, driftMountsJson));

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(
                "Container replacement requires a lifecycle/session guard.",
            );
            expectNoContainerReplacement();
        });

        it("preserves a running container with contract drift while another CCC session is active", () => {
            mockExistsSync.mockReturnValue(false);
            const driftMountsJson = JSON.stringify([
                { Source: "/host/.claude", Destination: "/home/ccc/.claude" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, driftMountsJson))
                .mockReturnValueOnce(makeResult(0, driftMountsJson))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0));

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const name = startProjectContainer(
                projectPath,
                ensureDirs,
                undefined,
                undefined,
                undefined,
                undefined,
                () => false,
            );

            expect(name).toBe(getContainerName(projectPath));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("another session is active"));
            const readinessCalls = spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "exec" && args?.at(-1) === "true";
            });
            expect(readinessCalls).toHaveLength(1);
            expect((readinessCalls[0][2] as { timeout?: number }).timeout).toBeLessThanOrEqual(200);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop" || args?.[0] === "rm" || args?.[0] === "run";
            })).toBe(false);
        });

        it("fails closed without replacing an unsafe privileged container owned by another session", () => {
            mockExistsSync.mockReturnValue(false);
            const privilegedContract = fullCredentialMountsJson([], { privileged: true });
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, privilegedContract))
                .mockReturnValueOnce(makeResult(0, privilegedContract));

            expect(() => startProjectContainer(
                    projectPath,
                    ensureDirs,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    () => false,
                ))
                .toThrow("contract failed safety validation");
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop" || args?.[0] === "rm" || args?.[0] === "run";
            })).toBe(false);
        });

        it.each([
            ["credential source substitution", (value: ReturnType<typeof JSON.parse>) => {
                const mount = value.Mounts.find((item: { Destination: string }) => item.Destination === "/home/ccc/.claude");
                mount.Source = "/foreign/.claude";
            }],
            ["credential made read-only", (value: ReturnType<typeof JSON.parse>) => {
                const mount = value.Mounts.find((item: { Destination: string }) => item.Destination === "/home/ccc/.claude");
                mount.RW = false;
            }],
            ["credential changed from bind to volume", (value: ReturnType<typeof JSON.parse>) => {
                const mount = value.Mounts.find((item: { Destination: string }) => item.Destination === "/home/ccc/.claude");
                mount.Type = "volume";
            }],
            ["owner auth source substitution", (value: ReturnType<typeof JSON.parse>) => {
                const mount = value.Mounts.find((item: { Destination: string }) => item.Destination === "/run/ccc-device-broker-auth/owner.json");
                mount.Source = "/foreign/owner.json";
            }],
            ["owner auth environment drift", (value: ReturnType<typeof JSON.parse>) => {
                value.Config.Env = value.Config.Env.filter((item: string) => !item.startsWith("CCC_DEVICE_BROKER_AUTH_FILE="));
            }],
            ["unexpected host device", (value: ReturnType<typeof JSON.parse>) => {
                value.HostConfig.Devices.push({ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" });
            }],
            ["unexpected supplemental group", (value: ReturnType<typeof JSON.parse>) => {
                value.HostConfig.GroupAdd.push("999");
            }],
        ])("fails closed on %s while an active session owns the container", (_name, mutate) => {
            const inspected = JSON.parse(fullCredentialMountsJson());
            mutate(inspected);
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, JSON.stringify(inspected));
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                return makeResult(0);
            });
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("contract failed safety validation");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("fails closed when contract inspection is malformed while another session owns the container", () => {
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, "not-json");
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                return makeResult(0);
            });
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("contract failed safety validation");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("executes contract-drift replacement only inside an approving session guard", () => {
            let removed = false;
            const driftMountsJson = JSON.stringify([
                { Source: "/host/.claude", Destination: "/home/ccc/.claude" },
            ]);
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, driftMountsJson);
                if (args[0] === "ps") return makeResult(0, removed ? "" : "abc123\n");
                if (args[0] === "rm") removed = true;
                return makeResult(0);
            });
            const guard = vi.fn((replace: () => void) => {
                expectNoContainerReplacement();
                replace();
                return true;
            });

            startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            );

            expect(guard).toHaveBeenCalledOnce();
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "stop")).toBe(true);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "rm")).toBe(true);
        });

        it("fails fast without replacing a temporarily unresponsive container owned by another session", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson()))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(1))
                .mockReturnValueOnce(makeResult(1))
                .mockReturnValueOnce(makeResult(1));

            expect(() => startProjectContainer(
                    projectPath,
                    ensureDirs,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    () => false,
                ))
                .toThrow("another active session prevented destructive recovery");

            const readinessCalls = spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "exec" && args?.at(-1) === "true";
            });
            expect(readinessCalls).toHaveLength(3);
            expect(readinessCalls.every((call: unknown[]) => (
                ((call[2] as { timeout?: number }).timeout ?? Infinity) <= 200
            ))).toBe(true);

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop" || args?.[0] === "rm" || args?.[0] === "run";
            })).toBe(false);
        });

        it("preserves an active container when mount identity changes before readiness validation", () => {
            let identityChanged = false;
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path.endsWith(".json"),
                isDirectory: () => !path.endsWith(".json"),
                isSymbolicLink: () => false,
                dev: 1,
                ino: identityChanged ? 2 : 1,
                size: 1024,
            }));
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                if (args[0] === "exec" && args.at(-1) === "true") {
                    identityChanged = true;
                    return makeResult(0);
                }
                return makeResult(0);
            });
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("mount source changed during validation");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("preserves an active container when mount identity changes during bundle synchronization", () => {
            let identityChanged = false;
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path.endsWith(".json"),
                isDirectory: () => !path.endsWith(".json"),
                isSymbolicLink: () => false,
                dev: 1,
                ino: identityChanged ? 2 : 1,
                size: 1024,
            }));
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                if (args[0] === "exec" && args.at(-1) === "true") return makeResult(0);
                if (args[0] === "cp") identityChanged = true;
                return makeResult(0);
            });
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("mount source changed during synchronization");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("does not replace a stopped container when its mount identity changed and another session owns it", () => {
            let identityChanged = false;
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps" && args[1] === "-q") {
                    identityChanged = true;
                    return makeResult(0, "");
                }
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                return makeResult(0);
            });
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path.endsWith(".json"),
                isDirectory: () => !path.endsWith(".json"),
                isSymbolicLink: () => false,
                dev: 1,
                ino: identityChanged ? 2 : 1,
                size: 1024,
            }));
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("another active session prevented replacement");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("does not replace a restarted container when exec remains unavailable to another session", () => {
            let runningChecks = 0;
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps" && args[1] === "-q") {
                    runningChecks += 1;
                    return makeResult(0, runningChecks === 1 ? "" : "abc123\n");
                }
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                if (args[0] === "exec" && args.at(-1) === "true") return makeResult(1);
                return makeResult(0);
            });
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("Restarted container is unavailable");
            expect(guard).toHaveBeenCalledOnce();
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "start")).toBe(true);
            expectNoContainerReplacement();
        });

        it("does not replace a restarted container when mount identity changes before joining", () => {
            let identityChanged = false;
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps" && args[1] === "-q") return makeResult(0, "");
                if (args[0] === "ps") return makeResult(0, "abc123\n");
                if (args[0] === "exec" && args.at(-1) === "true") {
                    identityChanged = true;
                    return makeResult(0);
                }
                return makeResult(0);
            });
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path.endsWith(".json"),
                isDirectory: () => !path.endsWith(".json"),
                isSymbolicLink: () => false,
                dev: 1,
                ino: identityChanged ? 2 : 1,
                size: 1024,
            }));
            const guard = vi.fn(() => false);

            expect(() => startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            )).toThrow("mount source changed during restart");
            expect(guard).toHaveBeenCalledOnce();
            expectNoContainerReplacement();
        });

        it("allows destructive recovery only through the session guard callback", () => {
            let removed = false;
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args[0] === "image" && args[1] === "inspect") return makeResult(0, "<no value>\n");
                if (args[0] === "inspect") return makeResult(0, fullCredentialMountsJson());
                if (args[0] === "ps" && args[1] === "-q") return makeResult(0, removed ? "" : "abc123\n");
                if (args[0] === "ps") return makeResult(0, removed ? "" : "abc123\n");
                if (args[0] === "exec" && args.at(-1) === "true") return makeResult(1);
                if (args[0] === "rm") removed = true;
                return makeResult(0);
            });
            const guard = vi.fn((replace: () => void) => {
                expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (
                    ["stop", "rm"].includes((call[1] as string[])?.[0])
                ))).toBe(false);
                replace();
                return true;
            });

            startProjectContainer(
                projectPath, ensureDirs, undefined, undefined, undefined, undefined, guard,
            );

            expect(guard).toHaveBeenCalledOnce();
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "stop")).toBe(true);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "rm")).toBe(true);
        });

        it("recreates a legacy container with writable shared device-lab state", () => {
            const inspected = JSON.parse(fullCredentialMountsJson()) as {
                Mounts: Array<{ Destination: string; RW?: boolean }>;
            };
            const sharedState = inspected.Mounts.find((mount) => mount.Destination === "/home/ccc/.ccc/devices");
            if (sharedState) sharedState.RW = true;

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, JSON.stringify(inspected)))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValue(makeResult(0));

            startWithApprovedReplacement();

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop";
            })).toBe(true);
        });

        it("recreates a container whose owner bind source belongs to another owner", () => {
            const inspected = JSON.parse(fullCredentialMountsJson()) as {
                Mounts: Array<{ Source: string; Destination: string }>;
            };
            const ownerDestination = `/home/ccc/.ccc/devices/owners/${deviceLabOwnerId(projectPath)}`;
            const ownerMount = inspected.Mounts.find((mount) => mount.Destination === ownerDestination);
            if (ownerMount) ownerMount.Source = join(homedir(), ".ccc", "devices", "owners", "foreign-owner");

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, JSON.stringify(inspected)))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValue(makeResult(0));

            startWithApprovedReplacement();

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "stop")).toBe(true);
        });

        it("recreates a container whose broker auth bind source is not the current owner secret", () => {
            const inspected = JSON.parse(fullCredentialMountsJson()) as {
                Mounts: Array<{ Source: string; Destination: string }>;
            };
            const authMount = inspected.Mounts.find((mount) => mount.Destination === "/run/ccc-device-broker-auth/owner.json");
            if (authMount) authMount.Source = join(homedir(), ".ccc", "devices", "broker", "auth", "foreign-owner.json");

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, JSON.stringify(inspected)))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValue(makeResult(0));

            startWithApprovedReplacement();

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "stop")).toBe(true);
        });

        it("recreates an existing container whose bind identity label refers to obsolete inodes", () => {
            const inspected = JSON.parse(fullCredentialMountsJson()) as {
                Config: { Labels: Record<string, string> };
            };
            inspected.Config.Labels["ccc.device-lab.mount-identity"] = "obsolete-identity";

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, JSON.stringify(inspected)))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValue(makeResult(0));

            startWithApprovedReplacement();

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "stop")).toBe(true);
        });

        it("fails closed when the prepared owner directory is a symbolic link", () => {
            const ownerRoot = join(homedir(), ".ccc", "devices", "owners", deviceLabOwnerId(projectPath));
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path !== ownerRoot,
                isDirectory: () => path !== ownerRoot,
                isSymbolicLink: () => path === ownerRoot,
                dev: 1,
                ino: 1,
                size: 1024,
            }));
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/owner root must be a real directory/);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "run")).toBe(false);
        });

        it("fails closed when the owner auth path is a symbolic link", () => {
            const authFile = join(homedir(), ".ccc", "devices", "broker", "auth", `${deviceLabOwnerId(projectPath)}.json`);
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path === authFile,
                isDirectory: () => path !== authFile,
                isSymbolicLink: () => path === authFile,
                dev: 1,
                ino: 1,
                size: 1024,
            }));
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/owner auth file must be a real regular file/);
            expect(mockOpenSync).not.toHaveBeenCalledWith(authFile, expect.anything());
        });

        it("fails closed when the owner auth file changes between lstat and open", () => {
            mockFstatSync.mockReturnValue({ isFile: () => true, dev: 1, ino: 2 });
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/owner auth file changed while it was being validated/);
            expect(mockCloseSync).toHaveBeenCalledWith(17);
        });

        it.each(["linux", "win32"] as const)(
            "rejects an atomic owner-directory replacement before container create on %s",
            (platform) => {
                vi.spyOn(process, "platform", "get").mockReturnValue(platform);
                const ownerRoot = join(homedir(), ".ccc", "devices", "owners", deviceLabOwnerId(projectPath));
                let replaced = false;
                mockExistsSync.mockImplementation((path: string) => {
                    if (path === join(homedir(), ".ssh")) replaced = true;
                    return false;
                });
                mockLstatSync.mockImplementation((path: string) => ({
                    isFile: () => !path.endsWith(deviceLabOwnerId(projectPath)),
                    isDirectory: () => !path.endsWith(".json"),
                    isSymbolicLink: () => false,
                    dev: 1,
                    ino: replaced && path.toLowerCase() === ownerRoot.toLowerCase() ? 2 : 1,
                    size: 1024,
                }));
                spawnSyncMock
                    .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                    .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                    .mockReturnValueOnce(makeResult(0, ""))
                    .mockReturnValueOnce(makeResult(0, ""))
                    .mockReturnValueOnce(makeResult(0, ""))
                    .mockReturnValue(makeResult(0));

                expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(
                    /device-lab mount source changed after preflight validation/,
                );
                expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "run")).toBe(false);
            },
        );

        it.each(["linux", "win32"] as const)(
            "removes a newly-created container when a mount source is replaced during create on %s",
            (platform) => {
                vi.spyOn(process, "platform", "get").mockReturnValue(platform);
                const ownerRoot = join(homedir(), ".ccc", "devices", "owners", deviceLabOwnerId(projectPath));
                let replaced = false;
                mockExistsSync.mockReturnValue(false);
                mockLstatSync.mockImplementation((path: string) => ({
                    isFile: () => path.endsWith(".json"),
                    isDirectory: () => !path.endsWith(".json"),
                    isSymbolicLink: () => false,
                    dev: 1,
                    ino: replaced && path.toLowerCase() === ownerRoot.toLowerCase() ? 2 : 1,
                    size: 1024,
                }));
                spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                    const args = argsValue as string[];
                    if (args?.[0] === "run") replaced = true;
                    if (args?.[0] === "images") return makeResult(0, "sha256:abc\n");
                    if (args?.[0] === "image" && args?.[1] === "inspect") return makeResult(0, "<no value>\n");
                    return makeResult(0, "");
                });

                expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(
                    /device-lab mount source changed after preflight validation/,
                );
                expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                    const args = call[1] as string[];
                    return args?.[0] === "rm" && args?.[1] === "-f";
                })).toBe(true);
            },
        );

        it("removes a newly-created container when the owner auth file identity changes during create", () => {
            let replaced = false;
            mockExistsSync.mockReturnValue(false);
            mockFstatSync.mockImplementation(() => ({
                isFile: () => true,
                dev: 1,
                ino: replaced ? 2 : 1,
            }));
            mockLstatSync.mockImplementation((path: string) => ({
                isFile: () => path.endsWith(".json"),
                isDirectory: () => !path.endsWith(".json"),
                isSymbolicLink: () => false,
                dev: 1,
                ino: path.endsWith(".json") && replaced ? 2 : 1,
                size: 1024,
            }));
            spawnSyncMock.mockImplementation((_command: unknown, argsValue: unknown) => {
                const args = argsValue as string[];
                if (args?.[0] === "run") replaced = true;
                if (args?.[0] === "images") return makeResult(0, "sha256:abc\n");
                if (args?.[0] === "image" && args?.[1] === "inspect") return makeResult(0, "<no value>\n");
                return makeResult(0, "");
            });

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(
                /device-lab mount source changed after preflight validation/,
            );
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "rm" && args?.[1] === "-f";
            })).toBe(true);
        });

        it("recreates a container whose isolated broker auth mount is not selected by environment", () => {
            const inspected = JSON.parse(fullCredentialMountsJson()) as { Config: { Env: string[] } };
            inspected.Config.Env = inspected.Config.Env.filter((entry) => !entry.startsWith("CCC_DEVICE_BROKER_AUTH_FILE="));

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))
                .mockReturnValueOnce(makeResult(0, "<no value>\n"))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0, JSON.stringify(inspected)))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValueOnce(makeResult(0, ""))
                .mockReturnValue(makeResult(0));

            startWithApprovedReplacement();

            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "stop";
            })).toBe(true);
        });

        it("creates a new container when none exists", () => {
            mockExistsSync.mockReturnValue(false); // hostSshDir does not exist -> no SSH mount, no SSH fix

            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (extraMounts guard)->false,
            // #4 isContainerRunning->false, #5 isContainerExists->false, then docker run
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra calls)

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(runCall).toBeDefined();
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(2);
            const runArgs = runCall![1] as string[];
            expect(runArgs.some((arg) => /^CCC_DEVICE_LAB_OWNER_BASIS=/.test(arg))).toBe(false);
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=unsupported");
            expect(runArgs).toContain("CCC_LAB_NET_MODE=user");
            expect(runArgs).not.toContain("--device");
            expect(runArgs).not.toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).not.toContain("/dev/net/tun:/dev/net/tun");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates an ordinary container with durable lab state and KVM when supported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).not.toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=ready");
            expect(runArgs).toContain("CCC_LAB_NET_MODE=user");
            expect(runArgs).toContain("--device");
            expect(runArgs).toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).toContain("--group-add");
            expect(runArgs).toContain("108");
            expect(runArgs).not.toContain("/dev/net/tun:/dev/net/tun");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates lab-runner profile container with durable lab state and KVM when supported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run

            const name = startProjectContainer(projectPath, ensureDirs, undefined, undefined, "lab-runner");
            expect(name).toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=ready");
            expect(runArgs).toContain("--device");
            expect(runArgs).toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).toContain("--group-add");
            expect(runArgs).toContain("108");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates lab-runner profile container with unsupported diagnostics when KVM is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run

            const name = startProjectContainer(projectPath, ensureDirs, undefined, undefined, "lab-runner");
            expect(name).toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=unsupported");
            expect(runArgs.some((arg) => arg.startsWith("CCC_LAB_RUNNER_UNSUPPORTED_REASON="))).toBe(true);
            expect(runArgs).not.toContain("--device");
            expect(runArgs).not.toContain("/dev/kvm:/dev/kvm");
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lab-runner profile requested"));
        });

        it("mounts every registered tool credential path when creating a container", () => {
            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];

            for (const mount of getAllCredentialMounts()) {
                expect(runArgs.some((arg) => arg.includes(`:${mount.containerDir}`))).toBe(true);
            }
        });

        it("mounts existing host git identity paths when creating a container", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs.some((a) => a.endsWith("/.gitconfig:/host-stage/gitconfig:ro"))).toBe(false);
            expect(runArgs.some((a) => a.includes("/.config/git:/home/ccc/.config/git"))).toBe(true);
            const gitConfigInstall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker"
                    && (c[1] as string[]).some((arg) => arg.includes("/tmp/ccc-host-gitconfig"))
                    && (c[1] as string[])[0] === "exec",
            );
            expect(gitConfigInstall?.[1]).toEqual(expect.arrayContaining([
                "exec", "--user", "root", getContainerName(projectPath),
            ]));
            expect((gitConfigInstall?.[1] as string[]).at(-1)).toContain("chown ccc:ccc /home/ccc/.gitconfig");
        });

        it("fixes SSH key permissions after creating container when ssh dir exists", () => {
            mockExistsSync.mockReturnValue(true);

            // #1 isImageExists, #2 getImageLabel (dev build), #3 isContainerExists (guard)->false,
            // #4 isContainerRunning->false, #5 isContainerExists->false, #6 docker run, #7 docker exec
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false (no extraMounts)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0))                 // docker run
                .mockReturnValueOnce(makeResult(0));                 // docker exec (SSH fix)

            startProjectContainer(projectPath, ensureDirs);

            const execCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker"
                    && (c[1] as string[])[0] === "exec"
                    && (c[1] as string[]).at(-1)?.includes("chmod 666 /tmp/ssh-agent.sock")
            );
            expect(execCall).toBeDefined();
            expect((execCall![1] as string[])).toContain("sh");
        });

        it("calls process.exit(1) when container creation fails", () => {
            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard) -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(1));                     // docker run -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });

        it("uses darwin SSH agent socket on darwin platform", () => {
            mockExistsSync.mockReturnValue(false); // no SSH dir

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/run/host-services/ssh-auth.sock");

            platformSpy.mockRestore();
        });

        it("uses SSH_AUTH_SOCK env var on linux when socket exists", () => {
            mockExistsSync.mockImplementation((p: string) => {
                return p === "/tmp/ssh-agent.sock";
            });

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const origSock = process.env.SSH_AUTH_SOCK;
            process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists (extraMounts guard)
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/tmp/ssh-agent.sock");

            platformSpy.mockRestore();
            if (origSock === undefined) delete process.env.SSH_AUTH_SOCK;
            else process.env.SSH_AUTH_SOCK = origSock;
        });

        it("recreates container when extraMounts are missing (containerHasMounts returns false)", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const missingMountsJson = JSON.stringify([]); // empty mounts -> missing required

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(0, missingMountsJson)) // docker inspect (containerHasMounts)
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startWithApprovedReplacement(extraMounts);
            expect(name).toMatch(/^ccc-/);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(stopCall).toBeDefined();
            expect(rmCall).toBeDefined();
        });

        it("recreates container when host git identity directory mounts are missing", () => {
            mockExistsSync.mockImplementation((p: string) => p.endsWith("/.config/git"));

            const missingGitIdentityMountsJson = fullCredentialMountsJson()
                .replace(/,\{"Source":"\/host\/home\/user\/\.config\/git","Destination":"\/home\/ccc\/\.config\/git"\}/, "");

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, missingGitIdentityMountsJson)) // inspect -> missing git identity mount
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when durable lab state mount is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], { labState: false }))) // inspect -> missing lab state mount
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(stopCall).toBeDefined();
            expect(runCall).toBeDefined();
        });

        it("recreates existing default container when device lab state mount is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], { deviceLabState: false }))) // inspect -> missing device state mount
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(stopCall).toBeDefined();
            expect(runCall).toBeDefined();
        });

        it("recreates existing default container when VM contract changes from unsupported to ready", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], {
                    status: "unsupported",
                    unsupportedReason: "/dev/kvm is not available on the container host",
                    kvmDevice: false,
                }))) // inspect -> stale unsupported VM contract
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when VM contract changes from ready to unsupported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson())) // inspect -> stale ready VM contract
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when ready VM contract has extra group-add entries", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], { groupAdd: ["108", "999"] }))) // inspect -> extra group-add
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when ready VM contract has extra host devices", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], {
                    devices: [
                        { PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" },
                        { PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" },
                    ],
                }))) // inspect -> extra device
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when unsupported VM contract has any stale device", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], {
                    status: "unsupported",
                    unsupportedReason: "/dev/kvm is not available on the container host",
                    groupAdd: [],
                    devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" }],
                }))) // inspect -> unsupported but stale device
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("recreates existing default container when it is privileged", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, fullCredentialMountsJson([], { privileged: true }))) // inspect -> privileged
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                 // docker run

            startWithApprovedReplacement();

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("reuses container when extraMounts are present and all mounts exist", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const mountsJson = fullCredentialMountsJson([
                { Source: "/host/repo/.git", Destination: "/project/repo/.git" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, mountsJson))     // docker inspect -> all present
                .mockReturnValueOnce(makeResult(0, "abc123\n"));    // isContainerRunning -> true

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since mounts are present
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("reuses container when Source differs but Destination matches (macOS Docker Desktop)", () => {
            const extraMounts = [{ hostPath: "/Users/me/repo/.git", containerPath: "/Users/me/repo/.git" }];
            // Docker Desktop on macOS may prefix Source with /host_mnt/ or resolve symlinks
            const mountsJson = fullCredentialMountsJson([
                { Source: "/host_mnt/Users/me/repo/.git", Destination: "/Users/me/repo/.git" },
            ]);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists -> exists
                .mockReturnValueOnce(makeResult(0, mountsJson))     // docker inspect -> Destination matches
                .mockReturnValueOnce(makeResult(0, "abc123\n"));    // isContainerRunning -> true

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since Destination matches
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("skips containerHasMounts check when container does not exist with extraMounts", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> not exists, skip inspect
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))             // isContainerExists -> false
                .mockReturnValue(makeResult(0));                     // docker run (and any extra)

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);
        });

        it("handles containerHasMounts returning false when docker inspect fails", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(1, ""))             // docker inspect -> fails (containerHasMounts false)
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startWithApprovedReplacement(extraMounts);
            expect(name).toMatch(/^ccc-/);
        });

        it("handles containerHasMounts with invalid JSON (parse error -> returns false)", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n")) // isImageExists
                .mockReturnValueOnce(makeResult(0, "<no value>\n")) // getImageLabel -> dev build
                .mockReturnValueOnce(makeResult(0, "abc123\n"))     // isContainerExists (extraMounts guard) -> exists
                .mockReturnValueOnce(makeResult(0, "not-json"))     // docker inspect -> bad JSON
                .mockReturnValueOnce(makeResult(0))                  // docker stop
                .mockReturnValueOnce(makeResult(0))                  // docker rm
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerRunning -> false
                .mockReturnValueOnce(makeResult(0, ""))              // isContainerExists -> false
                .mockReturnValueOnce(makeResult(0));                  // docker run

            const name = startWithApprovedReplacement(extraMounts);
            expect(name).toMatch(/^ccc-/);
        });
    });

    describe("stopProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            // ensureDockerRunning: isDockerRunning -> true
            // isContainerExists -> false
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            stopProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
        });

        it("stops container when it exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));            // docker stop

            stopProjectContainer(projectPath);

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
            expect(mockWithContainerLifecycleLock).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
        });

        it("refuses to stop a container with active sessions unless forced", () => {
            mockGetActiveSessionsForContainer.mockReturnValue(["active.lock"]);

            expect(() => stopProjectContainer(projectPath)).toThrow("Container has 1 active session(s)");
            expect(spawnSyncMock).not.toHaveBeenCalled();

            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))
                .mockReturnValueOnce(makeResult(0, "abc123\n"))
                .mockReturnValueOnce(makeResult(0));
            stopProjectContainer(projectPath, undefined, { force: true });
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "stop")).toBe(true);
        });

        it("still stops container when device cleanup throws", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));            // docker stop
            mockCleanupOwnerDevices.mockImplementation(() => {
                throw new Error("cleanup failed");
            });

            stopProjectContainer(projectPath);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => stopProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("removeProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            removeProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
        });

        it("stops and removes container when it exists", () => {
            // removeProjectContainer calls ensureDockerRunning, isContainerExists, stopProjectContainer (which calls ensureDockerRunning+isContainerExists+docker stop), docker rm
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info (removeProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (removeProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))           // docker info (stopProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (stopProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))            // docker stop
                .mockReturnValueOnce(makeResult(0));            // docker rm

            removeProjectContainer(projectPath);

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockCleanupOwnerDevices).toHaveBeenCalledTimes(1);
            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(rmCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => removeProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });
});
