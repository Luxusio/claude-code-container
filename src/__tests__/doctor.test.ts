import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock fs
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReaddirSync = vi.fn<() => string[]>().mockReturnValue([]);
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    };
});

// Mock docker.js
const mockIsDockerRunning = vi.fn().mockReturnValue(true);
const mockIsImageExists = vi.fn().mockReturnValue(true);
const mockGetImageLabel = vi.fn<() => string | null>().mockReturnValue(null);
const mockIsContainerRunning = vi.fn().mockReturnValue(true);
const mockIsContainerExists = vi.fn().mockReturnValue(true);
const mockGetContainerName = vi.fn().mockReturnValue("ccc-myproject-abc123");
vi.mock("../docker.js", () => ({
    isDockerRunning: () => mockIsDockerRunning(),
    isImageExists: () => mockIsImageExists(),
    getImageLabel: (...args: unknown[]) => mockGetImageLabel(...args),
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    isContainerExists: (...args: unknown[]) => mockIsContainerExists(...args),
    getContainerName: (...args: unknown[]) => mockGetContainerName(...args),
}));

// Mock session.js
const mockGetActiveSessionsForProject = vi.fn<() => string[]>().mockReturnValue([]);
vi.mock("../session.js", () => ({
    getActiveSessionsForProject: (...args: unknown[]) =>
        mockGetActiveSessionsForProject(...args),
}));

// Mock utils.js
vi.mock("../utils.js", () => ({
    getProjectId: vi.fn().mockReturnValue("myproject-abc123"),
    DATA_DIR: "/home/testuser/.ccc",
    MISE_VOLUME_NAME: "ccc-mise-cache",
    CLI_VERSION: "1.0.0",
}));

// Import AFTER mocks
const { runDoctor } = await import("../doctor.js");

function makeResult(
    status: number,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

describe("runDoctor", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        mockExistsSync.mockReset().mockReturnValue(false);
        mockReaddirSync.mockReset().mockReturnValue([]);
        mockIsDockerRunning.mockReturnValue(true);
        mockIsImageExists.mockReturnValue(true);
        mockGetImageLabel.mockReturnValue(null);
        mockIsContainerRunning.mockReturnValue(true);
        mockIsContainerExists.mockReturnValue(true);
        mockGetContainerName.mockReturnValue("ccc-myproject-abc123");
        mockGetActiveSessionsForProject.mockReturnValue([]);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns true when all checks pass (Docker running, image built, container running, volume exists)", () => {
        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/var/lib/docker/volumes/ccc-mise-cache/_data\n"));
        // Claude binary check (container running)
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n"));

        const result = runDoctor("/project/myproject");

        expect(result).toBe(true);
    });

    it("returns false when Docker is not running", () => {
        mockIsDockerRunning.mockReturnValue(false);

        const result = runDoctor("/project/myproject");

        expect(result).toBe(false);
        // spawnSync should not be called for version check since docker is not running
        const dockerVersionCalls = spawnSyncMock.mock.calls.filter(
            (c) => (c[1] as string[])?.includes("version"),
        );
        expect(dockerVersionCalls).toHaveLength(0);
    });

    it("returns false when image is not built", () => {
        mockIsImageExists.mockReturnValue(false);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));
        // Claude binary check
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n"));

        const result = runDoctor("/project/myproject");

        expect(result).toBe(false);
    });

    it("returns true when container is stopped (warn, not error)", () => {
        mockIsContainerRunning.mockReturnValue(false);
        mockIsContainerExists.mockReturnValue(true);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));
        // No claude check since container is not running

        const result = runDoctor("/project/myproject");

        expect(result).toBe(true);
    });

    it("returns true when container is not created yet (warn, not error)", () => {
        mockIsContainerRunning.mockReturnValue(false);
        mockIsContainerExists.mockReturnValue(false);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));

        const result = runDoctor("/project/myproject");

        expect(result).toBe(true);
    });

    it("shows warning when stale lock files are detected", () => {
        // 2 total lock files on disk, 1 active session → 1 stale
        mockGetActiveSessionsForProject.mockReturnValue(["myproject-abc123-session1.lock"]);
        mockExistsSync.mockReturnValue(true); // locksDir exists
        mockReaddirSync.mockReturnValue([
            "myproject-abc123-session1.lock",
            "myproject-abc123-session2.lock",
        ]);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));
        // Claude binary check
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n"));

        const result = runDoctor("/project/myproject");

        // Stale locks are warn, not error — should still return true
        expect(result).toBe(true);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("Stale locks");
        expect(logCalls).toContain("1 stale lock file(s)");
    });

    it("handles mix of ok/warn/error: image missing (error) and container stopped (warn)", () => {
        mockIsImageExists.mockReturnValue(false);
        mockIsContainerRunning.mockReturnValue(false);
        mockIsContainerExists.mockReturnValue(false);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect — missing
        spawnSyncMock.mockReturnValueOnce(makeResult(1, ""));

        const result = runDoctor("/project/myproject");

        expect(result).toBe(false);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("Image");
        expect(logCalls).toContain("Container");
    });

    it("warns when container is running but claude binary is not installed (non-zero exit)", () => {
        // Container is running so the claude check happens
        mockIsContainerRunning.mockReturnValue(true);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));
        // Claude binary check returns non-zero (not installed)
        spawnSyncMock.mockReturnValueOnce(makeResult(1, ""));

        const result = runDoctor("/project/myproject");

        // warn status, not error — should still return true
        expect(result).toBe(true);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("Not installed in container");
    });

    it("shows 'Built locally (dev)' when image has no cli.version label", () => {
        mockGetImageLabel.mockReturnValue(null); // dev build

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude binary

        runDoctor("/project/myproject");

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string).join("\n");
        expect(logCalls).toContain("Built locally (dev)");
    });

    it("shows 'Registry (v...)' when cli.version matches CLI_VERSION", () => {
        mockGetImageLabel.mockReturnValue("1.0.0"); // matches CLI_VERSION mock

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude binary

        runDoctor("/project/myproject");

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string).join("\n");
        expect(logCalls).toContain("Registry (v1.0.0)");
    });

    it("shows version mismatch warning when cli.version differs from CLI_VERSION", () => {
        mockGetImageLabel.mockReturnValue("0.9.0"); // old version

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude binary

        runDoctor("/project/myproject");

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string).join("\n");
        expect(logCalls).toContain("v0.9.0");
        expect(logCalls).toContain("v1.0.0");
        expect(logCalls).toContain("update");
    });

    it("shows 'Not found' with build instructions when no image exists", () => {
        mockIsImageExists.mockReturnValue(false);
        mockIsContainerRunning.mockReturnValue(false);
        mockIsContainerExists.mockReturnValue(false);

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(1, "")); // Volume missing

        runDoctor("/project/myproject");

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string).join("\n");
        expect(logCalls).toContain("Not found");
        expect(logCalls).toContain("docker build");
    });

    it("shows active session count when sessions exist", () => {
        mockGetActiveSessionsForProject.mockReturnValue([
            "myproject-abc123-aaa.lock",
            "myproject-abc123-bbb.lock",
        ]);
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            "myproject-abc123-aaa.lock",
            "myproject-abc123-bbb.lock",
        ]);

        // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n"));
        // Volume inspect
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n"));
        // Claude binary check
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n"));

        const result = runDoctor("/project/myproject");

        expect(result).toBe(true);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("2 active session(s)");
    });

    it("recognizes new -- separator lock file format", () => {
        // 2 lock files with new format (--), 1 active → 1 stale
        mockGetActiveSessionsForProject.mockReturnValue(["myproject-abc123--session1.lock"]);
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            "myproject-abc123--session1.lock",
            "myproject-abc123--session2.lock",
        ]);

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude

        const result = runDoctor("/project/myproject");
        expect(result).toBe(true);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("1 stale lock file(s)");
    });

    it("recognizes profile lock file format (projectId--p--profile--sessionId.lock)", () => {
        // 1 profile lock file, 0 active → 1 stale
        mockGetActiveSessionsForProject.mockReturnValue([]);
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            "myproject-abc123--p--work--session1.lock",
        ]);

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude

        const result = runDoctor("/project/myproject");
        expect(result).toBe(true);

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        expect(logCalls).toContain("1 stale lock file(s)");
    });

    it("does not count lock files from different projects", () => {
        mockGetActiveSessionsForProject.mockReturnValue([]);
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([
            "otherproject-xyz789--session1.lock",  // different project
            "myproject-abc123--session1.lock",      // this project (stale)
        ]);

        spawnSyncMock.mockReturnValueOnce(makeResult(0, "27.3.1\n")); // Docker version
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "/some/path\n")); // Volume
        spawnSyncMock.mockReturnValueOnce(makeResult(0, "claude 1.2.3\n")); // Claude

        runDoctor("/project/myproject");

        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[0] as string)
            .join("\n");
        // Only 1 stale (this project), not 2
        expect(logCalls).toContain("1 stale lock file(s)");
    });
});
