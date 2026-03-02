import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// All vi.mock() calls must be hoisted before any imports of the module under test.

const mockSpawnSync = vi.fn();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: (...args: unknown[]) => mockSpawnSync(...args) };
});

const mockExistsSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
        unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
        readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    };
});

const mockGetProjectId = vi.fn();
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        getProjectId: (...args: unknown[]) => mockGetProjectId(...args),
    };
});

const mockStopClipboardServerIfLast = vi.fn();
vi.mock("../clipboard-server.js", () => ({
    stopClipboardServerIfLast: (...args: unknown[]) =>
        mockStopClipboardServerIfLast(...args),
}));

const mockIsContainerRunning = vi.fn();
const mockGetContainerName = vi.fn();
vi.mock("../docker.js", () => ({
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    getContainerName: (...args: unknown[]) => mockGetContainerName(...args),
}));

const mockSaveClaudeBinaryToVolume = vi.fn();
vi.mock("../container-setup.js", () => ({
    saveClaudeBinaryToVolume: (...args: unknown[]) =>
        mockSaveClaudeBinaryToVolume(...args),
}));

// Import AFTER all mocks are declared
const {
    setSession,
    getCurrentSession,
    clearSession,
    createSessionLock,
    removeSessionLock,
    getActiveSessionsForProject,
    hasOtherActiveSessions,
    cleanupSession,
    setupSignalHandlers,
} = await import("../session.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLocksDir(): string {
    return mkdtempSync(join(tmpdir(), "ccc-test-locks-"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("session.ts", () => {
    beforeEach(() => {
        mockSpawnSync.mockReset();
        mockExistsSync.mockReset();
        mockWriteFileSync.mockReset();
        mockUnlinkSync.mockReset();
        mockReaddirSync.mockReset();
        mockMkdirSync.mockReset();
        mockGetProjectId.mockReset();
        mockStopClipboardServerIfLast.mockReset();
        mockIsContainerRunning.mockReset();
        mockGetContainerName.mockReset();
        mockSaveClaudeBinaryToVolume.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        clearSession();
        vi.restoreAllMocks();
    });

    // ── createSessionLock ────────────────────────────────────────────────────

    describe("createSessionLock", () => {
        it("creates lock file in correct directory with projectId prefix", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            const projectId = "my-project-abc123";
            const result = createSessionLock(projectId);

            expect(mockWriteFileSync).toHaveBeenCalledOnce();
            const [writtenPath] = mockWriteFileSync.mock.calls[0] as [string, ...unknown[]];
            expect(basename(writtenPath)).toMatch(
                new RegExp(`^${projectId}-[a-f0-9]{32}\\.lock$`),
            );
            expect(result).toBe(writtenPath);
        });

        it("writes process PID as lock file contents", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            createSessionLock("test-project-deadbeef");

            expect(mockWriteFileSync).toHaveBeenCalledOnce();
            const [, writtenContent] = mockWriteFileSync.mock.calls[0] as [unknown, string];
            expect(writtenContent).toBe(String(process.pid));
        });

        it("returns the full path to the created lock file", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            const result = createSessionLock("proj-aabbccddee");

            expect(typeof result).toBe("string");
            expect(result).toMatch(/\.lock$/);
            expect(result).toContain("proj-aabbccddee");
        });
    });

    // ── removeSessionLock ────────────────────────────────────────────────────

    describe("removeSessionLock", () => {
        it("removes an existing lock file", () => {
            const lockFile = "/fake/locks/proj-abc-sessionid.lock";
            mockExistsSync.mockReturnValue(true);
            mockUnlinkSync.mockImplementation(() => {});

            removeSessionLock(lockFile);

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("does not throw when lock file does not exist", () => {
            const lockFile = "/fake/locks/proj-abc-nonexistent.lock";
            mockExistsSync.mockReturnValue(false);

            expect(() => removeSessionLock(lockFile)).not.toThrow();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });
    });

    // ── getActiveSessionsForProject ──────────────────────────────────────────

    describe("getActiveSessionsForProject", () => {
        it("returns only matching lock files for the given projectId", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "my-project-abc-session1.lock",
                "my-project-abc-session2.lock",
                "other-project-xyz-session3.lock",
                "my-project-abc-session3.lock",
            ]);

            const result = getActiveSessionsForProject("my-project-abc");

            expect(result).toHaveLength(3);
            expect(result).toContain("my-project-abc-session1.lock");
            expect(result).toContain("my-project-abc-session2.lock");
            expect(result).toContain("my-project-abc-session3.lock");
            expect(result).not.toContain("other-project-xyz-session3.lock");
        });

        it("returns empty array when no lock files match the projectId", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "other-project-xyz-session1.lock",
                "another-proj-session2.lock",
            ]);

            const result = getActiveSessionsForProject("my-project-abc");

            expect(result).toEqual([]);
        });

        it("returns empty array when the locks directory does not exist", () => {
            mockExistsSync.mockReturnValue(false);

            const result = getActiveSessionsForProject("my-project-abc");

            expect(result).toEqual([]);
            expect(mockReaddirSync).not.toHaveBeenCalled();
        });
    });

    // ── hasOtherActiveSessions ───────────────────────────────────────────────

    describe("hasOtherActiveSessions", () => {
        it("returns true when other session lock files exist for the project", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc-session1.lock",
                "proj-abc-session2.lock",
            ]);

            const currentLockFile = "/locks/proj-abc-session1.lock";
            const result = hasOtherActiveSessions("proj-abc", currentLockFile);

            expect(result).toBe(true);
        });

        it("returns false when the current session is the only one for the project", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc-session1.lock"]);

            const currentLockFile = "/locks/proj-abc-session1.lock";
            const result = hasOtherActiveSessions("proj-abc", currentLockFile);

            expect(result).toBe(false);
        });
    });

    // ── setSession / getCurrentSession / clearSession ────────────────────────

    describe("setSession / getCurrentSession / clearSession", () => {
        it("getCurrentSession returns null values before any session is set", () => {
            const session = getCurrentSession();

            expect(session.lockFile).toBeNull();
            expect(session.projectPath).toBeNull();
        });

        it("setSession stores lockFile and projectPath, getCurrentSession retrieves them", () => {
            const lockFile = "/locks/proj-abc-deadbeef.lock";
            const projectPath = "/home/user/my-project";

            setSession(lockFile, projectPath);
            const session = getCurrentSession();

            expect(session.lockFile).toBe(lockFile);
            expect(session.projectPath).toBe(projectPath);
        });

        it("clearSession resets lockFile and projectPath to null", () => {
            setSession("/locks/some.lock", "/home/user/project");
            clearSession();
            const session = getCurrentSession();

            expect(session.lockFile).toBeNull();
            expect(session.projectPath).toBeNull();
        });
    });

    // ── cleanupSession ───────────────────────────────────────────────────────

    describe("cleanupSession", () => {
        it("is a no-op when no session has been set", () => {
            // Ensure session state is empty (afterEach calls clearSession, but we start fresh)
            cleanupSession();

            expect(mockGetProjectId).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it("removes lock file and stops container when it is the last session", () => {
            // Lock filename MUST start with projectId + "-" to pass the filter in
            // getActiveSessionsForProject: f.startsWith(`${projectId}-`) && f.endsWith(".lock")
            const projectId = "my-project-abc123";
            const sessionId = "aabbccddeeff00112233445566778899";
            const lockFileName = `${projectId}-${sessionId}.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            // Only current session exists → no other sessions
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists (getActiveSessionsForProject)
                .mockReturnValueOnce(true);   // lockFile exists (removeSessionLock)
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("removes lock file but does NOT stop container when other sessions are active", () => {
            // Lock filenames MUST start with projectId + "-" to pass the filter
            const projectId = "my-project-abc123";
            const lockFileName1 = `${projectId}-session1aabbccdd.lock`;
            const lockFileName2 = `${projectId}-session2eeff0011.lock`;
            const lockFile = `/locks/${lockFileName1}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true); // locksDir and lockFile both exist
            // Two sessions exist → hasOtherActiveSessions returns true
            mockReaddirSync.mockReturnValue([lockFileName1, lockFileName2]);
            mockUnlinkSync.mockImplementation(() => {});

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            // docker stop must NOT be called when other sessions are still active
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockIsContainerRunning).not.toHaveBeenCalled();
        });

        it("calls stopClipboardServerIfLast before removing the lock file", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}-aabbccddeeff0011.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists
                .mockReturnValueOnce(true);   // lockFile exists
            // Only one session → no others → container path taken (isContainerRunning → false)
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(false);

            const callOrder: string[] = [];
            mockStopClipboardServerIfLast.mockImplementation(() => {
                callOrder.push("stopClipboard");
            });
            mockUnlinkSync.mockImplementation(() => {
                callOrder.push("unlinkSync");
            });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockStopClipboardServerIfLast).toHaveBeenCalledWith(lockFile);
            expect(callOrder[0]).toBe("stopClipboard");
            expect(callOrder[1]).toBe("unlinkSync");
        });

        it("does NOT call docker stop or saveClaudeBinaryToVolume when container is not running", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}-aabbccddeeff0011.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists (getActiveSessionsForProject)
                .mockReturnValueOnce(true);   // lockFile exists (removeSessionLock)
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockIsContainerRunning).toHaveBeenCalledWith(containerName);
            expect(mockSaveClaudeBinaryToVolume).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it("calls saveClaudeBinaryToVolume before docker stop when container is running", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}-aabbccddeeff0011.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists
                .mockReturnValueOnce(true);   // lockFile exists
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);

            const callOrder: string[] = [];
            mockSaveClaudeBinaryToVolume.mockImplementation(() => {
                callOrder.push("saveClaudeBinary");
            });
            mockSpawnSync.mockImplementation(() => {
                callOrder.push("dockerStop");
                return { status: 0 };
            });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(callOrder).toEqual(["saveClaudeBinary", "dockerStop"]);
            expect(mockSaveClaudeBinaryToVolume).toHaveBeenCalledWith(containerName);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("clears session state after cleanup so getCurrentSession returns nulls", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}-aabbccddeeff0011.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists
                .mockReturnValueOnce(true);   // lockFile exists
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            // Confirm state is set before cleanup
            expect(getCurrentSession().lockFile).toBe(lockFile);
            expect(getCurrentSession().projectPath).toBe(projectPath);

            cleanupSession();

            const session = getCurrentSession();
            expect(session.lockFile).toBeNull();
            expect(session.projectPath).toBeNull();
        });

        it("continues without crashing when removeSessionLock (unlinkSync) throws an error", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}-aabbccddeeff0011.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists
                .mockReturnValueOnce(true);   // lockFile exists (so unlinkSync is called)
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {
                throw new Error("EACCES: permission denied");
            });
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);

            // Should not throw even though unlinkSync throws
            expect(() => cleanupSession()).not.toThrow();
        });

        it("does NOT call saveClaudeBinaryToVolume when other sessions are active", () => {
            const projectId = "my-project-abc123";
            const lockFileName1 = `${projectId}-session1aabbccdd.lock`;
            const lockFileName2 = `${projectId}-session2eeff0011.lock`;
            const lockFile = `/locks/${lockFileName1}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true); // locksDir and lockFile both exist
            // Two sessions exist → hasOtherActiveSessions returns true
            mockReaddirSync.mockReturnValue([lockFileName1, lockFileName2]);
            mockUnlinkSync.mockImplementation(() => {});

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockSaveClaudeBinaryToVolume).not.toHaveBeenCalled();
        });
    });

    // ── setupSignalHandlers ──────────────────────────────────────────────────

    describe("setupSignalHandlers", () => {
        it("registers handlers for SIGINT, SIGTERM, and SIGHUP", () => {
            const listenersBefore = {
                SIGINT: process.listenerCount("SIGINT"),
                SIGTERM: process.listenerCount("SIGTERM"),
                SIGHUP: process.listenerCount("SIGHUP"),
            };

            setupSignalHandlers();

            expect(process.listenerCount("SIGINT")).toBeGreaterThan(listenersBefore.SIGINT);
            expect(process.listenerCount("SIGTERM")).toBeGreaterThan(listenersBefore.SIGTERM);
            expect(process.listenerCount("SIGHUP")).toBeGreaterThan(listenersBefore.SIGHUP);

            // Clean up handlers to avoid polluting other tests
            process.removeAllListeners("SIGINT");
            process.removeAllListeners("SIGTERM");
            process.removeAllListeners("SIGHUP");
        });
    });
});
