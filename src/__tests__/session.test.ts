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
const mockReadFileSync = vi.fn();
const mockLstatSync = vi.fn();
const mockChmodSync = vi.fn();
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
        unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
        readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        lstatSync: (...args: unknown[]) => mockLstatSync(...args),
        chmodSync: (...args: unknown[]) => mockChmodSync(...args),
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

const mockCleanupOwnerDevices = vi.fn();
vi.mock("../device-lab-admin.js", () => ({
    cleanupOwnerDevices: (...args: unknown[]) => mockCleanupOwnerDevices(...args),
}));

vi.mock("../windows-system-powershell.js", () => ({
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

const mockWithSharedMutationLock = vi.fn((_file: string, operation: () => unknown) => operation());
const mockWithSharedMutationLockAsync = vi.fn(async (_file: string, operation: () => unknown) => operation());
vi.mock("../device-lab-shared-state.js", () => ({
    withSharedMutationLock: (...args: unknown[]) => mockWithSharedMutationLock(...args as [string, () => unknown]),
    withSharedMutationLockAsync: (...args: unknown[]) => mockWithSharedMutationLockAsync(...args as [string, () => unknown]),
}));

// Import AFTER all mocks are declared
const {
    setSession,
    getCurrentSession,
    clearSession,
    createSessionLock,
    removeSessionLock,
    getActiveSessionsForProject,
    getActiveSessionsForContainer,
    hasOtherActiveSessions,
    recreateContainerWithoutInterruptingSessions,
    cleanupSession,
    setupSignalHandlers,
    withContainerLifecycleLockAsync,
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
        mockReaddirSync.mockReset().mockReturnValue([]);
        mockMkdirSync.mockReset();
        mockReadFileSync.mockReset();
        mockLstatSync.mockReset().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
        mockChmodSync.mockReset();
        mockReadFileSync.mockImplementation((path: string) => {
            if (String(path) === `/proc/${process.pid}/stat`) {
                const fields = Array.from({ length: 20 }, (_, index) => index === 19 ? "self-start" : "0");
                return `${process.pid} (node) ${fields.join(" ")}`;
            }
            return undefined;
        });
        mockGetProjectId.mockReset();
        mockStopClipboardServerIfLast.mockReset();
        mockIsContainerRunning.mockReset();
        mockGetContainerName.mockReset();
        mockSaveClaudeBinaryToVolume.mockReset();
        mockCleanupOwnerDevices.mockReset();
        mockWithSharedMutationLock.mockReset()
            .mockImplementation((_file: string, operation: () => unknown) => operation());
        mockWithSharedMutationLockAsync.mockReset()
            .mockImplementation(async (_file: string, operation: () => unknown) => operation());
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        clearSession();
        vi.restoreAllMocks();
    });

    it("holds the async lifecycle lock until the operation promise settles", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let completed = false;
        const execution = withContainerLifecycleLockAsync("remote-project", async () => {
            await gate;
            completed = true;
            return "done";
        });
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(mockWithSharedMutationLockAsync).toHaveBeenCalledWith(
            expect.stringContaining("remote-project.container-lifecycle.guard"),
            expect.any(Function),
            { waitMs: 180_000 },
        );
        release();
        await expect(execution).resolves.toBe("done");
    });

    // ── createSessionLock ────────────────────────────────────────────────────

    describe("createSessionLock", () => {
        it("creates lock file with double-dash separator and projectId prefix (no profile)", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            const projectId = "my-project-abc123";
            const result = createSessionLock(projectId);

            expect(mockWriteFileSync).toHaveBeenCalledOnce();
            const [writtenPath] = mockWriteFileSync.mock.calls[0] as [string, ...unknown[]];
            expect(basename(writtenPath)).toMatch(
                new RegExp(`^${projectId}--[a-f0-9]{32}\\.lock$`),
            );
            expect(result).toBe(writtenPath);
        });

        it("creates lock file with profile segment when profile provided", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            const projectId = "my-project-abc123";
            const result = createSessionLock(projectId, "work");

            expect(mockWriteFileSync).toHaveBeenCalledOnce();
            const [writtenPath] = mockWriteFileSync.mock.calls[0] as [string, ...unknown[]];
            expect(basename(writtenPath)).toMatch(
                new RegExp(`^${projectId}--p--work--[a-f0-9]{32}\\.lock$`),
            );
            expect(result).toBe(writtenPath);
        });

        it("writes process identity metadata as lock file contents", () => {
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => {});

            createSessionLock("test-project-deadbeef");

            expect(mockWriteFileSync).toHaveBeenCalledOnce();
            const [, writtenContent] = mockWriteFileSync.mock.calls[0] as [unknown, string];
            expect(JSON.parse(writtenContent)).toMatchObject({ version: 2, pid: process.pid });
        });

        it("creates the session record atomically while holding the container lifecycle lock", () => {
            createSessionLock("test-project-deadbeef", "work");

            expect(mockWithSharedMutationLock).toHaveBeenCalledWith(
                expect.stringContaining("test-project-deadbeef--p--work.container-lifecycle.guard"),
                expect.any(Function),
                { waitMs: 180_000 },
            );
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringMatching(/test-project-deadbeef--p--work--[a-f0-9]{32}\.lock$/),
                expect.any(String),
                { mode: 0o600, flag: "wx" },
            );
        });

        it("fails closed without writing a lock when process identity cannot be established", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "denied" });

            expect(() => createSessionLock("test-project-deadbeef"))
                .toThrow("Unable to establish process identity");
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });

        it("does not write a session record when the lifecycle lock cannot be acquired", () => {
            mockWithSharedMutationLock.mockImplementation(() => {
                throw new Error("container lifecycle lock timeout");
            });

            expect(() => createSessionLock("test-project-deadbeef"))
                .toThrow("container lifecycle lock timeout");
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });

        it("rejects a symlinked session lock directory before writing", () => {
            mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });

            expect(() => createSessionLock("test-project-deadbeef"))
                .toThrow("CCC session lock path must be a real directory");
            expect(mockWriteFileSync).not.toHaveBeenCalled();
            expect(mockWithSharedMutationLock).not.toHaveBeenCalled();
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
            const lockFile = "/fake/locks/proj-abc--sessionid.lock";
            mockExistsSync.mockReturnValue(true);
            mockUnlinkSync.mockImplementation(() => {});

            removeSessionLock(lockFile);

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("does not throw when lock file does not exist", () => {
            const lockFile = "/fake/locks/proj-abc--nonexistent.lock";
            mockExistsSync.mockReturnValue(false);

            expect(() => removeSessionLock(lockFile)).not.toThrow();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });
    });

    // ── getActiveSessionsForContainer ────────────────────────────────────────

    describe("getActiveSessionsForContainer", () => {
        it("returns only matching lock files for the given containerPrefix", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "my-project-abc--session1aabbccdd11223344.lock",
                "my-project-abc--session2aabbccdd11223344.lock",
                "other-project-xyz--session3aabbccdd112233.lock",
                "my-project-abc--session3aabbccdd11223344.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            const result = getActiveSessionsForContainer("my-project-abc");

            expect(result).toHaveLength(3);
            expect(result).toContain("my-project-abc--session1aabbccdd11223344.lock");
            expect(result).toContain("my-project-abc--session2aabbccdd11223344.lock");
            expect(result).toContain("my-project-abc--session3aabbccdd11223344.lock");
            expect(result).not.toContain("other-project-xyz--session3aabbccdd112233.lock");
        });

        it("returns empty array when no lock files match the containerPrefix", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "other-project-xyz--session1aabbccdd11.lock",
                "another-proj--session2aabbccdd112233.lock",
            ]);

            const result = getActiveSessionsForContainer("my-project-abc");

            expect(result).toEqual([]);
        });

        it("creates and reads an empty locks directory when it does not exist", () => {
            mockExistsSync.mockReturnValue(false);

            const result = getActiveSessionsForContainer("my-project-abc");

            expect(result).toEqual([]);
            expect(mockReaddirSync).toHaveBeenCalledOnce();
        });

        it("filters out lock files whose PID is not alive", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--alivesession1122334455667788.lock",
                "proj-abc--deadsession1122334455667788.lock",
            ]);
            mockReadFileSync
                .mockReturnValueOnce("12345")  // alive.lock PID
                .mockReturnValueOnce("99999"); // dead.lock PID
            vi.spyOn(process, "kill").mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
                if (_pid === 12345) return true;
                const err = new Error("ESRCH") as NodeJS.ErrnoException;
                err.code = "ESRCH";
                throw err;
            });
            mockUnlinkSync.mockImplementation(() => {});

            const result = getActiveSessionsForContainer("proj-abc");

            expect(result).toEqual(["proj-abc--alivesession1122334455667788.lock"]);
        });

        it("keeps a live lock when Windows process observation returns EPERM", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--live.lock"]);
            mockReadFileSync.mockReturnValue("4242");
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--live.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("validates a Windows session start token even when kill probing returns EPERM", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--live.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:638000000000000000",
            }));
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "638000000000000000\n",
                stderr: "",
                pid: 1,
                output: [],
                signal: null,
            });
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--live.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("removes a stale lock when its PID was reused by another process", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--reused.lock"]);
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).startsWith("/proc/4242/")) {
                    const fields = Array.from({ length: 20 }, (_, index) => index === 19 ? "new-start" : "0");
                    return `4242 (node) ${fields.join(" ")}`;
                }
                return JSON.stringify({ version: 2, pid: 4242, startToken: "linux:old-start" });
            });
            vi.spyOn(process, "kill").mockImplementation(() => true);

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).toHaveBeenCalled();
        });

        it("preserves a malformed lock and treats it as an active session", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--corrupt.lock"]);
            mockReadFileSync.mockReturnValue("not-a-session-record");

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--corrupt.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("does not accept a numeric-prefix malformed legacy PID lock", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--corrupt.lock"]);
            mockReadFileSync.mockReturnValue("4242-corrupt");
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("missing") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--corrupt.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it.each([
            JSON.stringify({ pid: 4242 }),
            JSON.stringify({ version: 2, pid: "4242", startToken: "linux:start" }),
            JSON.stringify({ version: 2, pid: 4242 }),
            JSON.stringify({ version: 2, pid: 4242, startToken: "" }),
        ])("preserves malformed JSON ownership records (%s)", (content) => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--corrupt.lock"]);
            mockReadFileSync.mockReturnValue(content);
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("missing") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--corrupt.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("removes a Windows lock when EPERM liveness belongs to a reused PID", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--reused.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:old-start",
            }));
            mockSpawnSync.mockReturnValue({ status: 0, stdout: "new-start\n", stderr: "" });
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("proj-abc--reused.lock"));
        });

        it("keeps a live v2 lock when its start token cannot be observed", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--unobservable.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:known-start",
            }));
            mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "denied" });
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--unobservable.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("fails closed and preserves a candidate lock when its record cannot be read", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--temporarily-locked.lock"]);
            mockReadFileSync.mockImplementation(() => {
                const error = new Error("sharing violation") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc"))
                .toEqual(["proj-abc--temporarily-locked.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("non-profile prefix excludes files that have --p-- after the prefix", () => {
            mockExistsSync.mockReturnValue(true);
            // This file belongs to a profile session, not the base project
            mockReaddirSync.mockReturnValue([
                "my-project-abc--session1aabbccdd11223344.lock",
                "my-project-abc--p--work--sessaabbccdd112233.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            const result = getActiveSessionsForContainer("my-project-abc");

            expect(result).toEqual(["my-project-abc--session1aabbccdd11223344.lock"]);
            expect(result).not.toContain("my-project-abc--p--work--sessaabbccdd112233.lock");
        });

        it("profile prefix returns only matching profile sessions", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "my-project-abc--session1aabbccdd11223344.lock",
                "my-project-abc--p--work--sessaabbccdd112233.lock",
                "my-project-abc--p--dev--sessaabbccdd112233.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            const result = getActiveSessionsForContainer("my-project-abc--p--work");

            expect(result).toEqual(["my-project-abc--p--work--sessaabbccdd112233.lock"]);
        });

        it("does not count a double-dash profile extension as the same profile", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "my-project-abc--p--work--sessaabbccdd112233.lock",
                "my-project-abc--p--work--ci--sessaabbccdd445566.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            expect(getActiveSessionsForContainer("my-project-abc--p--work"))
                .toEqual(["my-project-abc--p--work--sessaabbccdd112233.lock"]);
        });
    });

    // ── getActiveSessionsForProject (backward compat) ────────────────────────

    describe("getActiveSessionsForProject", () => {
        it("delegates to getActiveSessionsForContainer", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "my-project-abc--session1aabbccdd11223344.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            const result = getActiveSessionsForProject("my-project-abc");

            expect(result).toContain("my-project-abc--session1aabbccdd11223344.lock");
        });

        it("creates and reads an empty locks directory when it does not exist", () => {
            mockExistsSync.mockReturnValue(false);

            const result = getActiveSessionsForProject("my-project-abc");

            expect(result).toEqual([]);
            expect(mockReaddirSync).toHaveBeenCalledOnce();
        });
    });

    // ── hasOtherActiveSessions ───────────────────────────────────────────────

    describe("hasOtherActiveSessions", () => {
        it("returns true when other session lock files exist for the container", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--session1aabbccdd11223344.lock",
                "proj-abc--session2aabbccdd11223344.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            const currentLockFile = "/locks/proj-abc--session1aabbccdd11223344.lock";
            const result = hasOtherActiveSessions("proj-abc", currentLockFile);

            expect(result).toBe(true);
        });

        it("returns false when the current session is the only one for the container", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--session1aabbccdd11223344.lock"]);

            const currentLockFile = "/locks/proj-abc--session1aabbccdd11223344.lock";
            const result = hasOtherActiveSessions("proj-abc", currentLockFile);

            expect(result).toBe(false);
        });
    });

    describe("recreateContainerWithoutInterruptingSessions", () => {
        it("runs replacement under the lifecycle lock when the current session is alone", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            const recreate = vi.fn();

            const result = recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
            );

            expect(result).toBe(true);
            expect(recreate).toHaveBeenCalledOnce();
            expect(mockWithSharedMutationLock).toHaveBeenCalledWith(
                expect.stringContaining("proj-abc.container-lifecycle.guard"),
                expect.any(Function),
                { waitMs: 180_000 },
            );
        });

        it("refuses replacement when the locked final state says the container is still running", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            const recreate = vi.fn();
            const replacementAllowed = vi.fn(() => false);

            const result = recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
                replacementAllowed,
            );

            expect(result).toBe(false);
            expect(replacementAllowed).toHaveBeenCalledOnce();
            expect(recreate).not.toHaveBeenCalled();
            expect(mockWithSharedMutationLock).toHaveBeenCalledOnce();
        });

        it("checks other sessions before evaluating the final replacement predicate", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock", "proj-abc--other.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            const recreate = vi.fn();
            const replacementAllowed = vi.fn(() => true);

            const result = recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
                replacementAllowed,
            );

            expect(result).toBe(false);
            expect(replacementAllowed).not.toHaveBeenCalled();
            expect(recreate).not.toHaveBeenCalled();
        });

        it("refuses replacement when another session exists even if the current lock disappeared", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--other.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            const recreate = vi.fn();

            const result = recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--missing-current.lock",
                recreate,
            );

            expect(result).toBe(false);
            expect(recreate).not.toHaveBeenCalled();
        });

        it("ignores stale foreign locks and permits replacement for the only live session", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock", "proj-abc--stale.lock"]);
            mockReadFileSync.mockImplementation((path: string) => (
                String(path).endsWith("stale.lock") ? "99999" : String(process.pid)
            ));
            vi.spyOn(process, "kill").mockImplementation((pid: number) => {
                if (pid === process.pid) return true;
                const error = new Error("missing") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });
            const recreate = vi.fn();

            expect(recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
            )).toBe(true);
            expect(recreate).toHaveBeenCalledOnce();
            expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("proj-abc--stale.lock"));
        });

        it("does not let a base-project lock block replacement of an isolated profile container", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--base.lock",
                "proj-abc--p--work--current.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            const recreate = vi.fn();

            expect(recreateContainerWithoutInterruptingSessions(
                "proj-abc--p--work",
                "/locks/proj-abc--p--work--current.lock",
                recreate,
            )).toBe(true);
            expect(recreate).toHaveBeenCalledOnce();
        });

        it("propagates replacement failures without releasing the lifecycle operation early", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            const recreate = vi.fn(() => { throw new Error("replacement failed"); });

            expect(() => recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
            )).toThrow("replacement failed");
            expect(mockWithSharedMutationLock).toHaveBeenCalledOnce();
        });

        it("refuses replacement when a foreign lock cannot be read", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock", "proj-abc--unreadable.lock"]);
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).endsWith("unreadable.lock")) throw new Error("EACCES");
                return String(process.pid);
            });
            const recreate = vi.fn();

            expect(recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
            )).toBe(false);
            expect(recreate).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalledWith(expect.stringContaining("unreadable.lock"));
        });

        it("does not invoke replacement when the lifecycle lock cannot be acquired", () => {
            mockWithSharedMutationLock.mockImplementation(() => {
                throw new Error("container lifecycle lock timeout");
            });
            const recreate = vi.fn();

            expect(() => recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
            )).toThrow("container lifecycle lock timeout");
            expect(recreate).not.toHaveBeenCalled();
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
            const lockFile = "/locks/proj-abc--deadbeefdeadbeef.lock";
            const projectPath = "/home/user/my-project";

            setSession(lockFile, projectPath);
            const session = getCurrentSession();

            expect(session.lockFile).toBe(lockFile);
            expect(session.projectPath).toBe(projectPath);
        });

        it("setSession stores profile when provided", () => {
            const lockFile = "/locks/proj-abc--p--work--deadbeef.lock";
            const projectPath = "/home/user/my-project";

            setSession(lockFile, projectPath, "work");
            const session = getCurrentSession();

            expect(session.lockFile).toBe(lockFile);
            expect(session.projectPath).toBe(projectPath);
            expect(session.profile).toBe("work");
        });

        it("clearSession resets lockFile and projectPath to null", () => {
            setSession("/locks/some.lock", "/home/user/project");
            clearSession();
            const session = getCurrentSession();

            expect(session.lockFile).toBeNull();
            expect(session.projectPath).toBeNull();
        });

        it("clearSession also clears profile", () => {
            setSession("/locks/some--p--work--lock.lock", "/home/user/project", "work");
            clearSession();
            const session = getCurrentSession();

            expect(session.profile).toBeUndefined();
        });
    });

    // ── cleanupSession ───────────────────────────────────────────────────────

    describe("cleanupSession", () => {
        it("is a no-op when no session has been set", () => {
            cleanupSession();

            expect(mockGetProjectId).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it("removes lock file and stops container when it is the last session", () => {
            const projectId = "my-project-abc123";
            const sessionId = "aabbccddeeff00112233445566778899";
            const lockFileName = `${projectId}--${sessionId}.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)   // locksDir exists (getActiveSessionsForContainer)
                .mockReturnValueOnce(true);   // lockFile exists (removeSessionLock)
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("uses profile-aware container name when profile is set", () => {
            const projectId = "my-project-abc123";
            const sessionId = "aabbccddeeff00112233445566778899";
            const lockFileName = `${projectId}--p--work--${sessionId}.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123--p--work";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath, "work");
            cleanupSession();

            // getContainerName called with profile
            expect(mockGetContainerName).toHaveBeenCalledWith(projectPath, "work");
            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, "work");
            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("removes lock file but does NOT stop container when other sessions are active", () => {
            const projectId = "my-project-abc123";
            const lockFileName1 = `${projectId}--session1aabbccdd11223344.lock`;
            const lockFileName2 = `${projectId}--session2eeff001122334455.lock`;
            const lockFile = `/locks/${lockFileName1}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([lockFileName1, lockFileName2]);
            mockUnlinkSync.mockImplementation(() => {});
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockIsContainerRunning).not.toHaveBeenCalled();
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
        });

        it("does not stop the container when another Windows session is live but PID probing returns EPERM", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const other = `${projectId}--other.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([current, other]);
            mockReadFileSync.mockImplementation((path: string) => {
                const pid = String(path).endsWith(other) ? 4242 : process.pid;
                return JSON.stringify({ version: 2, pid, startToken: `windows:start-${pid}` });
            });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                const match = String(args.at(-1)).match(/Get-Process -Id (\d+)/);
                return { status: 0, stdout: `${match?.[1] ? `start-${match[1]}` : ""}\n`, stderr: "" };
            });
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            setSession(`/locks/${current}`, "/home/user/my-project");
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${current}`);
            expect(mockIsContainerRunning).not.toHaveBeenCalled();
            expect(mockSpawnSync.mock.calls.some((call) => call[1]?.[0] === "stop")).toBe(false);
        });

        it("stops the container when the only foreign lock belongs to a reused PID", () => {
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const stale = `${projectId}--stale.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([current, stale]);
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).startsWith("/proc/4242/")) {
                    const fields = Array.from({ length: 20 }, (_, index) => index === 19 ? "new-start" : "0");
                    return `4242 (node) ${fields.join(" ")}`;
                }
                if (String(path).endsWith(stale)) {
                    return JSON.stringify({ version: 2, pid: 4242, startToken: "linux:old-start" });
                }
                return String(process.pid);
            });
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(`/locks/${current}`, "/home/user/my-project");
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining(stale));
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", "ccc-my-project-abc123"],
                expect.any(Object),
            );
        });

        it("preserves a corrupt foreign lock and refuses last-session cleanup", () => {
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const corrupt = `${projectId}--corrupt.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([current, corrupt]);
            mockReadFileSync.mockImplementation((path: string) => (
                String(path).endsWith(corrupt) ? "broken" : String(process.pid)
            ));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(`/locks/${current}`, "/home/user/my-project");
            cleanupSession();

            expect(mockUnlinkSync).not.toHaveBeenCalledWith(expect.stringContaining(corrupt));
            expect(mockSpawnSync).not.toHaveBeenCalledWith(
                "docker",
                ["stop", "ccc-my-project-abc123"],
                expect.any(Object),
            );
        });

        it("checks sessions, removes its lock, and stops the container inside one lifecycle critical section", () => {
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const order: string[] = [];
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockImplementation(() => {
                order.push("session-check");
                return [current];
            });
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockUnlinkSync.mockImplementation(() => { order.push("unlink"); });
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockImplementation(() => {
                order.push("stop");
                return { status: 0 };
            });
            mockWithSharedMutationLock.mockImplementation((_file: string, operation: () => unknown) => {
                order.push("critical-start");
                const result = operation();
                order.push("critical-end");
                return result;
            });

            setSession(`/locks/${current}`, "/home/user/my-project");
            cleanupSession();

            expect(order).toEqual(["critical-start", "session-check", "unlink", "stop", "critical-end"]);
        });

        it("does not stop during cleanup when a foreign lock is temporarily unreadable", () => {
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const unreadable = `${projectId}--unreadable.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([current, unreadable]);
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).endsWith(unreadable)) throw new Error("EACCES");
                return String(process.pid);
            });

            setSession(`/locks/${current}`, "/home/user/my-project");
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${current}`);
            expect(mockIsContainerRunning).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
        });

        it("does not remove its lock or stop the container when cleanup cannot acquire the lifecycle lock", () => {
            mockGetProjectId.mockReturnValue("my-project-abc123");
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockExistsSync.mockReturnValue(true);
            mockWithSharedMutationLock.mockImplementation(() => {
                throw new Error("container lifecycle lock timeout");
            });

            setSession("/locks/my-project-abc123--current.lock", "/home/user/my-project");

            expect(() => cleanupSession()).toThrow("container lifecycle lock timeout");
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockIsContainerRunning).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it("retries cleanup after a lifecycle lock acquisition failure", () => {
            const lockFile = "/locks/my-project-abc123--current.lock";
            mockGetProjectId.mockReturnValue("my-project-abc123");
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["my-project-abc123--current.lock"]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockWithSharedMutationLock
                .mockImplementationOnce(() => { throw new Error("container lifecycle lock timeout"); })
                .mockImplementation((_file: string, operation: () => unknown) => operation());

            setSession(lockFile, "/home/user/my-project");
            expect(() => cleanupSession()).toThrow("container lifecycle lock timeout");
            expect(() => cleanupSession()).not.toThrow();
            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("profile sessions do not interfere with base project session counting", () => {
            const projectId = "my-project-abc123";
            // Only one base session (current), but there is also a profile session
            const baseLockFileName = `${projectId}--session1aabbccdd11223344.lock`;
            const profileLockFileName = `${projectId}--p--work--sessaabbccdd112233.lock`;
            const lockFile = `/locks/${baseLockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            // Both files in directory, but profile file should be excluded from base count
            mockReaddirSync.mockReturnValue([baseLockFileName, profileLockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            cleanupSession();

            // Container stop check should happen (no other BASE sessions)
            expect(mockIsContainerRunning).toHaveBeenCalledWith(containerName);
            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
        });

        it("calls stopClipboardServerIfLast before removing the lock file", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
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
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockIsContainerRunning).toHaveBeenCalledWith(containerName);
            expect(mockSaveClaudeBinaryToVolume).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
        });

        it("calls saveClaudeBinaryToVolume before docker stop when container is running", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
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
            mockCleanupOwnerDevices.mockImplementation(() => {
                callOrder.push("cleanupDevices");
            });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(callOrder).toEqual(["cleanupDevices", "saveClaudeBinary", "dockerStop"]);
            expect(mockSaveClaudeBinaryToVolume).toHaveBeenCalledWith(containerName);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("still stops the container when device cleanup throws", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockCleanupOwnerDevices.mockImplementation(() => {
                throw new Error("cleanup failed");
            });
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                "docker",
                ["stop", containerName],
                expect.any(Object),
            );
        });

        it("clears session state after cleanup so getCurrentSession returns nulls", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            expect(getCurrentSession().lockFile).toBe(lockFile);
            expect(getCurrentSession().projectPath).toBe(projectPath);

            cleanupSession();

            const session = getCurrentSession();
            expect(session.lockFile).toBeNull();
            expect(session.projectPath).toBeNull();
        });

        it("continues without crashing when removeSessionLock (unlinkSync) throws an error", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";
            const containerName = "ccc-my-project-abc123";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {
                throw new Error("EACCES: permission denied");
            });
            mockGetContainerName.mockReturnValue(containerName);
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);

            expect(() => cleanupSession()).not.toThrow();
        });

        it("cleanupSession should be idempotent (second call is no-op)", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(false);

            setSession(lockFile, projectPath);
            cleanupSession();

            mockGetProjectId.mockReset();
            mockUnlinkSync.mockReset();
            mockSpawnSync.mockReset();
            mockStopClipboardServerIfLast.mockReset();

            expect(() => cleanupSession()).not.toThrow();
            expect(mockGetProjectId).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockStopClipboardServerIfLast).not.toHaveBeenCalled();
        });

        it("does NOT call saveClaudeBinaryToVolume when other sessions are active", () => {
            const projectId = "my-project-abc123";
            const lockFileName1 = `${projectId}--session1aabbccdd11223344.lock`;
            const lockFileName2 = `${projectId}--session2eeff001122334455.lock`;
            const lockFile = `/locks/${lockFileName1}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
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

            process.removeAllListeners("SIGINT");
            process.removeAllListeners("SIGTERM");
            process.removeAllListeners("SIGHUP");
        });

        it("cleanup callback calls cleanupSession and process.exit(0) when signal fires", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockUnlinkSync.mockImplementation(() => {});
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(false);

            const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);

            setSession(lockFile, projectPath);
            setupSignalHandlers();

            process.emit("SIGINT");

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockExit).toHaveBeenCalledWith(0);

            mockExit.mockRestore();
            process.removeAllListeners("SIGTERM");
            process.removeAllListeners("SIGHUP");
        });
    });
});
