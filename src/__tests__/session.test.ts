import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";

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
// Native file syscalls remain the seam: the real bounded capture, observation
// decoder and cleanup policy run against stable bytes and file identities.
type ClaimFile = { content: string; inode: bigint; external?: boolean };
const claimFiles = new Map<string, ClaimFile>();
const claimDeleted = new Set<string>();
const claimExternalIdentities = new Map<string, { content: string; inode: bigint }>();
const claimHandles = new Map<number, { path: string; file: ClaimFile }>();
let claimInode = 100n;
let claimFd = 200;
const missingFile = () => Object.assign(new Error("missing fixture file"), { code: "ENOENT" });
function claimFile(path: string): ClaimFile {
    if (claimDeleted.has(path)) throw missingFile();
    const existing = claimFiles.get(path);
    if (existing) return existing;
    if (!path.endsWith(".lock")) throw missingFile();
    const content = mockReadFileSync(path, "utf-8");
    if (typeof content !== "string") throw missingFile();
    const previous = claimExternalIdentities.get(path);
    const identity = previous?.content === content ? previous : { content, inode: ++claimInode };
    claimExternalIdentities.set(path, identity);
    const file = { ...identity, external: true };
    claimFiles.set(path, file);
    return file;
}
function claimStat(file: ClaimFile) {
    return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        dev: 1n, ino: file.inode, size: BigInt(Buffer.byteLength(file.content)),
        birthtimeNs: file.inode, mtimeNs: 1n, ctimeNs: 1n, mode: 0o100600n };
}
function fixtureWrite(path: string, content: string): void {
    claimDeleted.delete(path);
    claimFiles.set(path, { content, inode: ++claimInode });
}
function isClaimPath(path: unknown): path is string {
    return typeof path === "string" && (path.endsWith(".lock") || path.includes(".lock."));
}
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        writeFileSync: (...args: unknown[]) => {
            const result = mockWriteFileSync(...args);
            if (typeof args[0] === "string" && isClaimPath(args[0])) fixtureWrite(args[0], String(args[1]));
            return result;
        },
        unlinkSync: (...args: unknown[]) => {
            const result = mockUnlinkSync(...args);
            if (isClaimPath(args[0])) { claimFiles.delete(args[0]); claimDeleted.add(args[0]); }
            return result;
        },
        readdirSync: (...args: unknown[]) => {
            const listed = mockReaddirSync(...args) as string[];
            return [...new Set([...listed, ...[...claimFiles].filter(([path, file]) =>
                !file.external && dirname(path) === args[0] && path.endsWith(".lock")).map(([path]) => basename(path))])]
                .filter(name => !claimDeleted.has(join(String(args[0]), name)));
        },
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        lstatSync: (...args: unknown[]) => {
            const observed = mockLstatSync(...args);
            return isClaimPath(args[0]) ? claimStat(claimFile(args[0])) : observed;
        },
        openSync: (path: string, flags: string) => {
            if (flags !== "r") throw new Error("Unexpected mutable file open in session facade fixture.");
            const fd = ++claimFd;
            claimHandles.set(fd, { path, file: claimFile(path) });
            return fd;
        },
        fstatSync: (fd: number) => claimStat(claimHandles.get(fd)!.file),
        readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
            const content = Buffer.from(claimHandles.get(fd)!.file.content);
            return content.copy(buffer, offset, position, position + length);
        },
        closeSync: (fd: number) => {
            const handle = claimHandles.get(fd);
            claimHandles.delete(fd);
            if (handle?.file.external && ![...claimHandles.values()].some(item => item.path === handle.path)) {
                claimFiles.delete(handle.path);
            }
        },
        chmodSync: (...args: unknown[]) => mockChmodSync(...args),
    };
});

const mockGetProjectId = vi.fn();
vi.mock("../home-layout.js", async original => ({
    ...await original<typeof import("../home-layout.js")>(), locksDir: () => "/locks",
}));
vi.mock("@ccc/device-lab/project-identity.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/project-identity.js")>(),
    getProjectId: (...args: unknown[]) => mockGetProjectId(...args),
}));
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        getProjectId: (...args: unknown[]) => mockGetProjectId(...args),
    };
});

const mockIsContainerRunning = vi.fn();
const mockGetContainerName = vi.fn();
vi.mock("../docker.js", () => ({
    getConfirmedRunningContainerId: (...args: unknown[]) => {
        const result = mockIsContainerRunning(...args);
        if (typeof result === "string") return result;
        return result ? String(args[0]) : null;
    },
    getContainerName: (...args: unknown[]) => mockGetContainerName(...args),
}));

const mockCleanupOwnerDevices = vi.fn();
vi.mock("../device-lab-cleanup.js", () => ({
    cleanupOwnerDevices: (...args: unknown[]) => mockCleanupOwnerDevices(...args),
}));
vi.mock("../device-lab-admin.js", () => ({
    cleanupOwnerDevices: (...args: unknown[]) => mockCleanupOwnerDevices(...args),
}));

vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    canonicalWindowsTasklistPath: () => "C:\\Windows\\System32\\tasklist.exe",
    hiddenWindowsPowerShellArgs: (args: string[]) => args,
}));

const mockWithSharedMutationLock = vi.fn((_file: string, operation: () => unknown) => operation());
const mockWithSharedMutationLockAsync = vi.fn(async (_file: string, operation: () => unknown) => operation());
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({
    withSharedMutationLock: (...args: unknown[]) => mockWithSharedMutationLock(...args as [string, () => unknown]),
    withSharedMutationLockAsync: (...args: unknown[]) => mockWithSharedMutationLockAsync(...args as [string, () => unknown]),
}));

// Ordinary query owners retain their existing semantic fake runner. Cleanup's
// explicit binder still reaches the native child-process mock with captured flags.
vi.mock("../container-runtime.js", async original => ({
    ...await original<typeof import("../container-runtime.js")>(),
    getRuntimeInvocation: () => fixtureInvocation,
    runtimeSpawnSync: (args: readonly string[], options?: unknown) => mockSpawnSync("docker", args, options),
}));
const fixtureInvocation = {
    version: 1 as const, runtime: "docker" as const, executable: join("/", "fixture", "docker-a"),
    transport: { kind: "docker" as const, host: "unix:///fixture/engine-a.sock", configDirectory: join("/", "fixture", "config-a"),
        tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
    selectors: Object.fromEntries((await import("../ports/container-runtime-invocation.js")).NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
};
const stopArgs = (id: string) => ["--config", join("/", "fixture", "config-a"), "--host", "unix:///fixture/engine-a.sock",
    "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey=", "stop", id];

// Import AFTER all mocks are declared
const {
    setSession: setSessionActual,
    setSessionContainerId: setSessionContainerIdActual,
    setSessionCleanupEnabled,
    getCurrentSession,
    clearSession,
    createSessionLock,
    removeSessionLock,
    getActiveSessionsForProject,
    getActiveSessionsForContainer,
    getSessionLockClaimsForContainer,
    getSessionLockClaimsForProjectFamily,
    getActiveSessionsForProjectFamily,
    hasOtherActiveSessions,
    hasOtherSessionClaims,
    recreateContainerWithoutInterruptingSessions,
    cleanupSession,
    setupSignalHandlers,
    withContainerLifecycleLockAsync,
    withContainerSetupLockAsync,
    withProjectFamilyLifecycleLockAsync,
} = await import("../session.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PINNED_ID = "a".repeat(64);
const PROFILE_ID = "b".repeat(64);
const SHARED_ID = "c".repeat(64);
function identity(path: string) {
    const file = claimFiles.get(path)!;
    return { path, device: "1", inode: String(file.inode), birthtime: String(file.inode),
        digest: createHash("sha256").update(file.content).digest("hex") };
}
function seedMonitoredClaim(lockFile: string, projectPath: string, profile?: string): void {
    const prefix = basename(lockFile).split("--")[0];
    if (!mockGetProjectId.getMockImplementation()) mockGetProjectId.mockReturnValue(prefix);
    fixtureWrite(lockFile, JSON.stringify({ version: 3, pid: process.pid, startToken: null, ownershipKind: "monitored" }));
    const runtimePath = `${lockFile}.runtime.json`;
    fixtureWrite(runtimePath, JSON.stringify(fixtureInvocation));
    fixtureWrite(`${lockFile}.guardian.json`, JSON.stringify({ version: 1,
        claim: { ...identity(lockFile), ownerPid: process.pid },
        binding: { lockFile, projectPath, toolName: "claude", ...(profile ? { profile } : {}), prefix: profile ? `${prefix}--p--${profile}` : prefix },
        runtime: identity(runtimePath), guardian: { pid: process.pid, startToken: null },
        generation: "0", registration: "ready", pending: null, lastAcknowledged: null, ownStarted: null,
        recovery: { status: "active", diagnostic: null },
    }));
}
// These cleanup fixtures represent a pre-existing, positively registered session.
// Native guardian READY/ACK transport itself is exercised by integration owners.
function setSession(lockFile: string, projectPath: string, profile?: string): void {
    seedMonitoredClaim(lockFile, projectPath, profile);
    setSessionActual(lockFile, projectPath, profile);
}
function setSessionContainerId(id: string | null, cleanupEnabled = id !== null): void {
    const lockFile = getCurrentSession().lockFile!;
    const observationPath = `${lockFile}.guardian.json`;
    const observation = JSON.parse(claimFiles.get(observationPath)!.content);
    observation.generation = "1";
    observation.lastAcknowledged = { generation: "1", sequence: 1, containerId: id, cleanupEnabled };
    fixtureWrite(observationPath, JSON.stringify(observation));
    setSessionContainerIdActual(id);
    setSessionCleanupEnabled(cleanupEnabled);
}

function makeLocksDir(): string {
    return mkdtempSync(join(tmpdir(), "ccc-test-locks-"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("session.ts", () => {
    beforeEach(() => {
        // The default process observations below model Linux /proc and kill facts.
        // Platform-specific cases override this baseline with their own observations.
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        claimFiles.clear(); claimDeleted.clear(); claimHandles.clear(); claimExternalIdentities.clear();
        mockSpawnSync.mockReset();
        mockExistsSync.mockReset();
        mockWriteFileSync.mockReset();
        mockUnlinkSync.mockReset();
        mockReaddirSync.mockReset().mockReturnValue([]);
        mockMkdirSync.mockReset();
        mockReadFileSync.mockReset();
        mockLstatSync.mockReset().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false,
            dev: 1n, ino: 1n, birthtimeNs: 1n, mode: 0o40700n });
        mockChmodSync.mockReset();
        mockReadFileSync.mockImplementation((path: string) => {
            if (String(path) === `/proc/${process.pid}/stat`) {
                const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? "S" : index === 19 ? "100" : "0");
                return `${process.pid} (node) ${fields.join(" ")}`;
            }
            return undefined;
        });
        mockGetProjectId.mockReset();
        mockIsContainerRunning.mockReset();
        mockGetContainerName.mockReset();
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

    it("uses a distinct bounded async setup lock until readiness settles", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let completed = false;
        const execution = withContainerSetupLockAsync("joining-project", async () => {
            await gate;
            completed = true;
            return "ready";
        });
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(mockWithSharedMutationLockAsync).toHaveBeenCalledWith(
            expect.stringContaining("joining-project.container-setup.guard"),
            expect.any(Function),
            { waitMs: 900_000 },
        );
        expect(mockWithSharedMutationLockAsync.mock.calls[0]?.[0]).not.toContain("container-lifecycle.guard");

        release();
        await expect(execution).resolves.toBe("ready");
    });

    it("holds the async project-family lock across worktree preparation", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let completed = false;
        const execution = withProjectFamilyLifecycleLockAsync("worktree-project", async () => {
            await gate;
            completed = true;
            return "prepared";
        });
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(mockWithSharedMutationLockAsync).toHaveBeenCalledWith(
            expect.stringContaining("worktree-project.project-family-lifecycle.guard"),
            expect.any(Function),
            { waitMs: 180_000 },
        );

        release();
        await expect(execution).resolves.toBe("prepared");
    });

    // ── createSessionLock ────────────────────────────────────────────────────

    describe("production session container ownership inspection", () => {
        const exactId = "a".repeat(64);
        const inspectActual = () => vi.importActual<typeof import("../docker.js")>("../docker.js");

        it("recognizes successful empty enumeration as known absence without inspecting a container", async () => {
            const docker = await inspectActual();
            mockGetProjectId.mockReturnValue("project");
            mockSpawnSync.mockReturnValue({ status: 0, stdout: "\n" });
            expect(docker.inspectSessionContainerOwnership("/fixture/project")).toEqual({ known: true, containerId: null });
            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
            expect(mockSpawnSync.mock.calls[0][1][0]).toBe("ps");
        });

        it.each([
            [{ status: 1, stdout: "", stderr: "private engine diagnostic" }, "container-list-failed"],
            [{ status: null, stdout: "" }, "container-list-failed"],
            [{ status: 0, error: new Error("runtime unavailable"), stdout: "" }, "container-list-failed"],
            [{ status: null, error: Object.assign(new Error("private timeout diagnostic"), { code: "ETIMEDOUT" }), stdout: "" }, "container-list-timeout"],
            [{ status: 0, stdout: "short-id" }, "container-list-ambiguous"],
            [{ status: 0, stdout: `${exactId}\n${"b".repeat(64)}` }, "container-list-ambiguous"],
        ] as const)("keeps failed or ambiguous enumeration unknown: %j", async (result, reason) => {
            const docker = await inspectActual();
            mockGetProjectId.mockReturnValue("project"); mockSpawnSync.mockReturnValue(result);
            expect(docker.inspectSessionContainerOwnership("/fixture/project")).toEqual({ known: false, containerId: null, reason });
            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
        });

        it.each([true, false])("accepts a positively verified managed exact ID when Running=%s", async running => {
            const docker = await inspectActual();
            const projectPath = makeLocksDir();
            mockGetProjectId.mockReturnValue("project");
            mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n });
            const identity = docker.bindMountSourceIdentityDigest(docker.captureBindMountSourceIdentity(projectPath));
            mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: `${exactId}\n` }).mockReturnValue({ status: 0, stdout: JSON.stringify({
                Id: exactId, State: { Running: running }, Config: { Labels: {
                    "ccc.managed": "true", "ccc.project.path": projectPath, "ccc.project.mount-identity": identity,
                } },
            }) });
            expect(docker.inspectSessionContainerOwnership(projectPath, "work")).toEqual({ known: true, containerId: exactId });
            expect(mockSpawnSync).toHaveBeenCalledTimes(2);
            expect(mockSpawnSync.mock.calls[0][1]).toEqual(["ps", "-aq", "--no-trunc", "-f", expect.stringMatching(/^name=\^ccc-.*--p--work\$$/)]);
            expect(mockSpawnSync.mock.calls[1][1]).toEqual(["inspect", "-f", "{{json .}}", exactId]);
        });

        it.each([
            ["foreign", "container-not-managed"], ["wrong project", "project-path-mismatch"],
            ["different ID", "container-id-changed"], ["stale digest", "project-identity-mismatch"],
        ] as const)("does not authorize a listed container with %s ownership", async (mode, reason) => {
            const docker = await inspectActual();
            const projectPath = makeLocksDir();
            mockGetProjectId.mockReturnValue("project");
            mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n });
            const identity = docker.bindMountSourceIdentityDigest(docker.captureBindMountSourceIdentity(projectPath));
            mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: exactId }).mockReturnValue({ status: 0, stdout: JSON.stringify({
                Id: mode === "different ID" ? "b".repeat(64) : exactId,
                State: { Running: true }, Config: { Labels: {
                    "ccc.managed": mode === "foreign" ? "false" : "true",
                    "ccc.project.path": mode === "wrong project" ? "/different/project" : projectPath,
                    "ccc.project.mount-identity": mode === "stale digest" ? "obsolete-directory-identity" : identity,
                } },
            }) });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({ known: false, containerId: null, reason });
            expect(mockSpawnSync.mock.calls.some(call => ["stop", "rm", "exec"].includes(call[1]?.[0]))).toBe(false);
        });

        function legacyFixture() {
            const projectPath = makeLocksDir();
            mockGetProjectId.mockReturnValue("project");
            mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n });
            const inspected = {
                Id: exactId,
                State: { Running: false },
                Config: { Labels: { "ccc.managed": "true", "ccc.project.path": projectPath } as Record<string, string> },
                Mounts: [{ Source: projectPath, Destination: "/project/project", Type: "bind", RW: true }],
            };
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: `${exactId}\n` };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                return { status: 1, stdout: "", stderr: "stopped container cannot execute commands" };
            });
            return { projectPath, inspected };
        }

        function expectReadOnlyAdmission() {
            expect(mockSpawnSync.mock.calls.every(call => ["ps", "inspect"].includes(call[1]?.[0]))).toBe(true);
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        }

        function expectStoppedCopyAttempt() {
            expect(mockSpawnSync.mock.calls.every(call => ["ps", "inspect", "cp"].includes(call[1]?.[0]))).toBe(true);
            expect(mockSpawnSync.mock.calls.some(call => call[1]?.[0] === "cp"
                && call[1]?.[1].startsWith(`${exactId}:/project/project/.ccc-mount-identity-`))).toBe(true);
            expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringContaining(".ccc-mount-identity-"),
                expect.stringMatching(/^[a-f0-9]{64}$/), { flag: "wx", mode: 0o600 });
        }

        it("admits a stopped legacy managed container for live verification after startup without executing it", async () => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            // Other ordinary mounts do not change this project-only admission.
            inspected.Mounts.push({ Source: "/fixture/credentials", Destination: "/home/ccc/.ssh", Type: "bind", RW: false });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({
                known: true, containerId: exactId, requiresLiveVerification: true,
            });
            expectStoppedCopyAttempt();
        });

        it.each(["/host_mnt", "/run/desktop/mnt/host"])("admits a stopped legacy macOS Docker Desktop project alias through %s", async prefix => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            const runtime = await import("../container-runtime.js");
            vi.spyOn(runtime, "getRuntimeInfo").mockReturnValue({
                runtime: "docker", flavor: "docker-desktop", version: "0.0.0", socketPath: "/var/run/docker.sock",
                rootless: false, remote: true, dockerDesktop: true,
            });
            inspected.Mounts[0].Source = `${prefix}${projectPath}`;
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({
                known: true, containerId: exactId, requiresLiveVerification: true,
            });
            expectStoppedCopyAttempt();
        });

        it.each([
            ["missing bind", "project-bind-unverified"], ["duplicate bind", "project-bind-unverified"],
            ["readonly bind", "project-bind-unverified"], ["wrong source", "project-bind-unverified"],
            ["stale digest", "project-identity-mismatch"], ["unavailable host", "project-identity-unavailable"],
            ["foreign", "container-not-managed"], ["changed ID", "container-id-changed"],
            ["invalid ID", "container-id-invalid"], ["unknown state", "container-state-unavailable"],
        ] as const)("refuses stopped legacy admission with %s without effects", async (mode, reason) => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            if (mode === "missing bind") inspected.Mounts = [];
            if (mode === "duplicate bind") inspected.Mounts.push({ ...inspected.Mounts[0] });
            if (mode === "readonly bind") inspected.Mounts[0].RW = false;
            if (mode === "wrong source") inspected.Mounts[0].Source = "/fixture/foreign-project";
            if (mode === "stale digest") inspected.Config.Labels["ccc.project.mount-identity"] = "obsolete-directory-identity";
            if (mode === "unavailable host") mockLstatSync.mockImplementation(() => { throw new Error("private filesystem diagnostic"); });
            if (mode === "foreign") inspected.Config.Labels["ccc.managed"] = "false";
            if (mode === "changed ID") inspected.Id = "b".repeat(64);
            if (mode === "invalid ID") inspected.Id = "";
            if (mode === "unknown state") Reflect.deleteProperty(inspected.State, "Running");
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({ known: false, containerId: null, reason });
            expectReadOnlyAdmission();
        });

        it.each([
            { status: 1, stdout: "", stderr: "private native diagnostic" },
            { status: null, error: Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }), stdout: "" },
            { status: 0, stdout: "not-json: private native diagnostic" },
        ])("keeps failed native inspection unavailable without leaking diagnostics: %j", async result => {
            const docker = await inspectActual();
            const { projectPath } = legacyFixture();
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => args[0] === "ps"
                ? { status: 0, stdout: exactId } : result);
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({
                known: false, containerId: null, reason: "container-inspection-unavailable",
            });
            expectReadOnlyAdmission();
        });

        it("retains live bind proof for a running legacy container", async () => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            inspected.State.Running = true;
            const markers = new Map<string, string>();
            mockWriteFileSync.mockImplementation((path: string, value: string) => { markers.set(basename(path), value); });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: exactId };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                if (args[0] === "exec" && args[1] === exactId && args[2] === "cat") {
                    return { status: 0, stdout: markers.get(basename(args[3])) ?? "" };
                }
                return { status: 1, stdout: "" };
            });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({ known: true, containerId: exactId });
            expect(mockWriteFileSync).toHaveBeenCalled();
            expect(mockSpawnSync.mock.calls.some(call => call[1]?.[0] === "exec" && call[1]?.[1] === exactId)).toBe(true);
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm"].includes(call[1]?.[0]))).toBe(false);
        });

        it.each([true, false])("accepts a valid stale project fingerprint only after current bind verification when running=%s", async running => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            inspected.State.Running = running;
            inspected.Config.Labels["ccc.project.mount-identity"] = "f".repeat(64);
            const markers = new Map<string, string>();
            mockWriteFileSync.mockImplementation((path: string, value: string) => { markers.set(basename(path), value); });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: exactId };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                if (running && args[0] === "exec" && args[1] === exactId && args[2] === "cat") {
                    return { status: 0, stdout: markers.get(basename(args[3])) ?? "" };
                }
                return { status: 1, stdout: "", stderr: "stopped or foreign command" };
            });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({
                known: true, containerId: exactId, ...(running ? {} : { requiresLiveVerification: true }),
            });
            if (running) {
                expect(mockWriteFileSync).toHaveBeenCalled();
                expect(mockSpawnSync.mock.calls.some(call => call[1]?.[0] === "exec" && call[1]?.[1] === exactId)).toBe(true);
            } else expectStoppedCopyAttempt();
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm"].includes(call[1]?.[0]))).toBe(false);
        });

        it.each(["foreign live view", "changed host identity"])("refuses a valid stale project fingerprint with %s despite matching lexical source", async fault => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            inspected.State.Running = true;
            inspected.Config.Labels["ccc.project.mount-identity"] = "f".repeat(64);
            mockWriteFileSync.mockImplementation(() => {
                if (fault === "changed host identity") mockLstatSync.mockReturnValue({
                    isDirectory: () => true, isSymbolicLink: () => false, dev: 2n, ino: 3n,
                });
            });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: exactId };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                return { status: 0, stdout: "a different mounted directory" };
            });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({
                known: false, containerId: null, reason: "project-bind-unverified",
            });
            expect(mockWriteFileSync).toHaveBeenCalled();
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm"].includes(call[1]?.[0]))).toBe(false);
        });

        it.each([true, false])("requires live proof for destructive ownership with a valid stale project fingerprint when running=%s", async running => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            inspected.State.Running = running;
            inspected.Config.Labels["ccc.project.mount-identity"] = "f".repeat(64);
            const markers = new Map<string, string>();
            mockWriteFileSync.mockImplementation((path: string, value: string) => { markers.set(basename(path), value); });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                if (running && args[0] === "exec" && args[1] === exactId && args[2] === "cat") {
                    return { status: 0, stdout: markers.get(basename(args[3])) ?? "" };
                }
                return { status: 1, stdout: "" };
            });
            expect(docker.getManagedProjectContainerIdentity(exactId, projectPath)).toEqual(running
                ? { containerId: exactId, running: true } : null);
            if (running) expect(mockWriteFileSync).toHaveBeenCalled();
            else expectStoppedCopyAttempt();
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm"].includes(call[1]?.[0]))).toBe(false);
        });

        it("does not grant destructive ownership from static stopped legacy admission", async () => {
            const docker = await inspectActual();
            const { projectPath } = legacyFixture();
            expect(docker.getManagedProjectContainerIdentity(exactId, projectPath)).toBeNull();
            expectStoppedCopyAttempt();
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm"].includes(call[1]?.[0]))).toBe(false);
        });

        it.each(["missing", "stale"])("grants stopped ownership without pending authority only after a successful %s-fingerprint native copy", async fingerprint => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            if (fingerprint === "stale") inspected.Config.Labels["ccc.project.mount-identity"] = "f".repeat(64);
            let content = "";
            mockWriteFileSync.mockImplementation((_path: string, value: string) => { content = value; });
            mockLstatSync.mockImplementation((path: string) => String(path).endsWith("/marker")
                ? { isFile: () => true, isSymbolicLink: () => false, size: 64n, dev: 3n, ino: 4n }
                : { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n });
            mockReadFileSync.mockImplementation((path: string) => String(path).endsWith("/marker") ? content : undefined);
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: exactId };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                if (args[0] === "cp") return { status: 0, stdout: "" };
                throw new Error(`unexpected native effect ${args[0]}`);
            });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({ known: true, containerId: exactId });
            expect(mockSpawnSync.mock.calls.filter(call => call[1]?.[0] === "inspect")).toHaveLength(2);
            expectStoppedCopyAttempt();
            expect(docker.getManagedProjectContainerIdentity(exactId, projectPath)).toEqual({containerId: exactId, running: false});
        });

        it.each(["successor", "started"])("refuses a stopped copy proof if the exact target became %s before handoff", async fault => {
            const docker = await inspectActual();
            const { projectPath, inspected } = legacyFixture();
            let content = "";
            mockWriteFileSync.mockImplementation((_path: string, value: string) => { content = value; });
            mockLstatSync.mockImplementation((path: string) => String(path).endsWith("/marker")
                ? { isFile: () => true, isSymbolicLink: () => false, size: 64n, dev: 3n, ino: 4n }
                : { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n });
            mockReadFileSync.mockImplementation((path: string) => String(path).endsWith("/marker") ? content : undefined);
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                if (args[0] === "ps") return { status: 0, stdout: exactId };
                if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspected) };
                if (args[0] === "cp") {
                    if (fault === "successor") inspected.Id = "b".repeat(64);
                    else inspected.State.Running = true;
                    return { status: 0, stdout: "" };
                }
                throw new Error(`unexpected native effect ${args[0]}`);
            });
            expect(docker.inspectSessionContainerOwnership(projectPath)).toEqual({ known: false, containerId: null, reason: "project-bind-unverified" });
            expect(mockSpawnSync.mock.calls.some(call => ["start", "stop", "rm", "exec"].includes(call[1]?.[0]))).toBe(false);
        });
    });

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
            expect(JSON.parse(writtenContent)).toMatchObject({ version: 3, pid: process.pid, ownershipKind: "direct" });
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

        it("marks a direct claim conservatively when process identity cannot be established", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "denied" });

            expect(() => createSessionLock("test-project-deadbeef")).not.toThrow();
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringMatching(/test-project-deadbeef--[a-f0-9]{32}\.lock$/),
                JSON.stringify({ version: 3, pid: process.pid, startToken: null, ownershipKind: "direct" }),
                { mode: 0o600, flag: "wx" },
            );
        });

        it("builds valid Windows try/catch process identity syntax", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "FOUND:638000000000000000\n",
                stderr: "",
            });

            createSessionLock("test-project-deadbeef");

            const script = String(mockSpawnSync.mock.calls[0]?.[1]?.at(-1));
            expect(script).toContain("}\ncatch [System.ArgumentException]");
            expect(script).not.toContain("}; catch");
            expect(mockSpawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
            expect(mockWriteFileSync).toHaveBeenCalledOnce();
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
        it("removes only the direct claim created by this invocation", () => {
            const lockFile = createSessionLock("proj-abc");
            mockUnlinkSync.mockClear();
            removeSessionLock(lockFile);
            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("refuses a missing path for which this invocation has no original receipt", () => {
            const lockFile = "/locks/proj-abc--nonexistent.lock";
            expect(() => removeSessionLock(lockFile)).toThrow("original direct-claim receipt");
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("captures a direct receipt before guard return and preserves a replacement at that boundary", () => {
            let replacedPath = "";
            mockWithSharedMutationLock.mockImplementation((_file: string, operation: () => unknown) => {
                const result = operation();
                if (typeof result === "string" && result.endsWith(".lock")) {
                    replacedPath = result;
                    const original = claimFiles.get(result)!;
                    // Identical bytes with a new inode are still a successor.
                    fixtureWrite(result, original.content);
                }
                return result;
            });
            const lockFile = createSessionLock("proj-abc");
            expect(lockFile).toBe(replacedPath);
            expect(() => removeSessionLock(lockFile)).toThrow("receipt changed");
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(claimFiles.has(lockFile)).toBe(true);
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

        it("fails closed when the established lock directory disappears before enumeration", () => {
            const error = new Error("missing") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            mockReaddirSync.mockImplementation(() => {
                throw error;
            });

            expect(() => getActiveSessionsForContainer("my-project-abc")).toThrow(error);
        });

        it("filters out lock files whose PID is not alive", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--alivesession1122334455667788.lock",
                "proj-abc--deadsession1122334455667788.lock",
            ]);
            mockReadFileSync
                .mockReturnValueOnce(JSON.stringify({ version: 3, pid: 12345, startToken: null, ownershipKind: "direct" }))
                .mockReturnValueOnce(JSON.stringify({ version: 3, pid: 99999, startToken: null, ownershipKind: "direct" }));
            vi.spyOn(process, "kill").mockImplementation((_pid) => {
                if (_pid === 12345) return true;
                const err = new Error("ESRCH") as NodeJS.ErrnoException;
                err.code = "ESRCH";
                throw err;
            });
            mockUnlinkSync.mockImplementation(() => {});

            const result = getActiveSessionsForContainer("proj-abc");

            expect(result).toEqual(["proj-abc--alivesession1122334455667788.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("preserves an unmarked legacy claim even when its PID matches this invocation", () => {
            const currentLock = "/fake/locks/proj-abc--current.lock";
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--current.lock",
                "proj-abc--legacy-stale.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            expect(getActiveSessionsForContainer("proj-abc", currentLock))
                .toEqual(["proj-abc--current.lock", "proj-abc--legacy-stale.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
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
                stdout: "FOUND:638000000000000000\n",
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

        it("omits a stale direct claim after positive Linux start-token mismatch without unlinking", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--reused.lock"]);
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).startsWith("/proc/4242/")) {
                    const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? "R" : index === 19 ? "200" : "0");
                    return `4242 (node) ${fields.join(" ")}`;
                }
                return JSON.stringify({ version: 3, ownershipKind: "direct", pid: 4242, startToken: "linux:100" });
            });
            vi.spyOn(process, "kill").mockImplementation(() => true);

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
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

        it("keeps a live Windows v2 lock when PID signal probing would report ESRCH", () => {
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
                stdout: "FOUND:638000000000000000\n",
                stderr: "",
                pid: 1,
                output: [],
                signal: null,
            });
            const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("not found") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--live.lock"]);
            expect(killSpy).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("omits a stale direct claim after Windows confirms process absence without unlinking", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--dead.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 3, ownershipKind: "direct",
                pid: 4242,
                startToken: "windows:638000000000000000",
            }));
            mockSpawnSync.mockReturnValue({ status: 0, stdout: "MISSING\n", stderr: "" });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
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

        it("omits a stale direct claim after Windows EPERM and positive start-token mismatch without unlinking", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--reused.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 3, ownershipKind: "direct",
                pid: 4242,
                startToken: "windows:old-start",
            }));
            mockSpawnSync.mockReturnValue({ status: 0, stdout: "FOUND:638000000000000001\n", stderr: "" });
            vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
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

        it("omits a stale direct claim after trusted Windows tasklist proves absence without unlinking", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--dead.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 3, ownershipKind: "direct",
                pid: 4242,
                startToken: "windows:known-start",
            }));
            mockSpawnSync
                .mockReturnValueOnce({ status: 1, stdout: "", stderr: "denied" })
                .mockReturnValueOnce({
                    status: 0,
                    stdout: '"System Idle Process","0","Services","0","8 K"\n"System","4","Services","0","1,000 K"\n',
                    stderr: "",
                });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("preserves a Windows v2 lock when tasklist sees the PID but cannot verify its start token", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--uncertain.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:known-start",
            }));
            mockSpawnSync
                .mockReturnValueOnce({ status: 1, stdout: "", stderr: "denied" })
                .mockReturnValueOnce({
                    status: 0,
                    stdout: '"node.exe","4242","Console","1","50,000 K"\n',
                    stderr: "",
                });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--uncertain.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("keeps a Windows legacy lock active when tasklist sees its PID", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--legacy.lock"]);
            mockReadFileSync.mockReturnValue("4242");
            mockSpawnSync
                .mockReturnValueOnce({ status: 1, stdout: "", stderr: "denied" })
                .mockReturnValueOnce({
                    status: 0,
                    stdout: '"node.exe","4242","Console","1","50,000 K"\n',
                    stderr: "",
                });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--legacy.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it.each([
            "unexpected output\n",
            '"System","4"\n',
            '"System","4",garbage\n',
            '"System","4","Services","0","1,000 K","extra"\n',
        ])("preserves a Windows lock when tasklist output is malformed: %s", (tasklistOutput) => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--uncertain.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:known-start",
            }));
            mockSpawnSync
                .mockReturnValueOnce({ status: 1, stdout: "", stderr: "denied" })
                .mockReturnValueOnce({ status: 0, stdout: tasklistOutput, stderr: "" });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--uncertain.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it.each([
            { status: 0, stdout: "", stderr: "" },
            { status: 0, stdout: "UNKNOWN\n", stderr: "" },
            { status: 0, stdout: "unexpected\n", stderr: "" },
            { status: 0, stdout: "FOUND:invalid\n", stderr: "" },
            { status: 0, stdout: "FOUND:123\nextra\n", stderr: "" },
            { status: 0, stdout: "MISSING\n", stderr: "access denied" },
            { status: 1, stdout: "MISSING\n", stderr: "" },
            { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing executable"), { code: "ENOENT" }) },
        ])("preserves a Windows v2 lock for inconclusive observation %#", (result) => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--uncertain.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:known-start",
            }));
            mockSpawnSync.mockReturnValue(result);

            expect(getActiveSessionsForContainer("proj-abc"))
                .toEqual(["proj-abc--uncertain.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("preserves a live Windows legacy lock without process.kill probing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--legacy.lock"]);
            mockReadFileSync.mockReturnValue("4242");
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "FOUND:638000000000000000\n",
                stderr: "",
            });
            const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("not found") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });

            expect(getActiveSessionsForContainer("proj-abc"))
                .toEqual(["proj-abc--legacy.lock"]);
            expect(killSpy).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("preserves a dead Windows legacy claim because process absence does not settle guardian responsibility", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--legacy.lock"]);
            mockReadFileSync.mockReturnValue("4242");
            mockSpawnSync.mockReturnValue({ status: 0, stdout: "MISSING\n", stderr: "" });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual(["proj-abc--legacy.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("omits a stale direct claim after definitive non-Windows ps absence without unlinking", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--dead.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 3, ownershipKind: "direct",
                pid: 4242,
                startToken: "ps:old-start",
            }));
            mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });

            expect(getActiveSessionsForContainer("proj-abc")).toEqual([]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it.each([
            { status: 1, stdout: "", stderr: "permission denied" },
            { status: 2, stdout: "", stderr: "" },
            { status: null, stdout: "", stderr: "terminated" },
            { status: 0, stdout: "", stderr: "" },
        ])("preserves a non-Windows v2 lock for inconclusive ps result %#", (result) => {
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--uncertain.lock"]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "ps:known-start",
            }));
            mockSpawnSync.mockReturnValue(result);

            expect(getActiveSessionsForContainer("proj-abc"))
                .toEqual(["proj-abc--uncertain.lock"]);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it.each(["EACCES", "EINVAL", "UNKNOWN"])(
            "preserves a non-Windows legacy lock for inconclusive %s PID probing",
            (code) => {
                vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
                mockExistsSync.mockReturnValue(true);
                mockReaddirSync.mockReturnValue(["proj-abc--legacy.lock"]);
                mockReadFileSync.mockReturnValue("4242");
                vi.spyOn(process, "kill").mockImplementation(() => {
                    const error = new Error(code) as NodeJS.ErrnoException;
                    error.code = code;
                    throw error;
                });

                expect(getActiveSessionsForContainer("proj-abc"))
                    .toEqual(["proj-abc--legacy.lock"]);
                expect(mockUnlinkSync).not.toHaveBeenCalled();
            },
        );

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

    describe("getActiveSessionsForProjectFamily", () => {
        it("includes base and every profile session but excludes base and sibling lookalikes", () => {
            mockReaddirSync.mockReturnValue([
                "worktree-a1b2c3--base-session.lock",
                "worktree-a1b2c3--p--work--profile-session.lock",
                "worktree-a1b2c3--p--ci--profile-session.lock",
                "worktree-a1b2c30--other-session.lock",
                "base-repo-a1b2c3--base-session.lock",
            ]);
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);

            expect(getActiveSessionsForProjectFamily("worktree-a1b2c3")).toEqual([
                "worktree-a1b2c3--base-session.lock",
                "worktree-a1b2c3--p--work--profile-session.lock",
                "worktree-a1b2c3--p--ci--profile-session.lock",
            ]);
        });

        it("fails closed when project-family lock enumeration fails", () => {
            const error = Object.assign(new Error("sharing violation"), { code: "EACCES" });
            mockReaddirSync.mockImplementation(() => {
                throw error;
            });

            expect(() => getActiveSessionsForProjectFamily("worktree-a1b2c3")).toThrow(error);
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

    describe("hasOtherSessionClaims", () => {
        it("preserves a foreign claim without probing its Windows process identity", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--current.lock",
                "proj-abc--foreign.lock",
            ]);

            expect(hasOtherSessionClaims(
                "proj-abc",
                "/locks/proj-abc--current.lock",
            )).toBe(true);
            expect(getSessionLockClaimsForContainer("proj-abc")).toEqual([
                "proj-abc--current.lock",
                "proj-abc--foreign.lock",
            ]);
            expect(mockReadFileSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it("returns false when only the current ownership claim exists", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock"]);

            expect(hasOtherSessionClaims(
                "proj-abc",
                "/locks/proj-abc--current.lock",
            )).toBe(false);
        });

        it("keeps base and profile ownership namespaces isolated", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--current.lock",
                "proj-abc--p--work--profile.lock",
            ]);

            expect(hasOtherSessionClaims(
                "proj-abc",
                "/locks/proj-abc--current.lock",
            )).toBe(false);
            expect(hasOtherSessionClaims(
                "proj-abc--p--work",
                "/locks/proj-abc--p--work--profile.lock",
            )).toBe(false);
        });

        it("returns every base and profile claim for exact worktree removal fencing", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "worktree-a--base.lock",
                "worktree-a--p--work--profile.lock",
                "worktree-ab--foreign.lock",
                "worktree-a.container-lifecycle.guard",
            ]);

            expect(getSessionLockClaimsForProjectFamily("worktree-a")).toEqual([
                "worktree-a--base.lock",
                "worktree-a--p--work--profile.lock",
            ]);
            expect(mockReadFileSync).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
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

        it("observes session liveness only after the final replacement predicate allows replacement", () => {
            const order: string[] = [];
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockImplementation(() => {
                order.push("sessions");
                return ["proj-abc--current.lock", "proj-abc--other.lock"];
            });
            mockReadFileSync.mockReturnValue(String(process.pid));
            vi.spyOn(process, "kill").mockImplementation(() => true);
            const recreate = vi.fn();
            const replacementAllowed = vi.fn(() => {
                order.push("replacement");
                return true;
            });

            const result = recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
                replacementAllowed,
            );

            expect(result).toBe(false);
            expect(replacementAllowed).toHaveBeenCalledOnce();
            expect(order).toEqual(["replacement", "sessions", "sessions"]);
            expect(recreate).not.toHaveBeenCalled();
        });

        it("does not delete a live Windows session lock when running-container replacement is deferred", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                "proj-abc--current.lock",
                "proj-abc--foreign.lock",
            ]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:old-token",
            }));
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "FOUND:638000000000000001\n",
                stderr: "",
            });
            const recreate = vi.fn();

            expect(recreateContainerWithoutInterruptingSessions(
                "proj-abc",
                "/locks/proj-abc--current.lock",
                recreate,
                () => false,
            )).toBe(false);

            expect(mockReaddirSync).not.toHaveBeenCalled();
            expect(mockReadFileSync).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(recreate).not.toHaveBeenCalled();
        });

        it("preserves the first Windows session through deferred upgrade and second-session cleanup", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            const projectId = "proj-abc";
            const first = `${projectId}--first.lock`;
            const second = `${projectId}--second.lock`;
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([first, second]);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                pid: 4242,
                startToken: "windows:638000000000000001",
            }));
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "FOUND:638000000000000001\n",
                stderr: "",
            });
            const recreate = vi.fn();

            expect(recreateContainerWithoutInterruptingSessions(
                projectId,
                `/locks/${second}`,
                recreate,
                () => false,
            )).toBe(false);

            expect(mockReadFileSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();

            mockGetProjectId.mockReturnValue(projectId);
            setSession(`/locks/${second}`, "/home/user/proj");
            setSessionContainerId(SHARED_ID, false);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${second}`);
            expect(mockUnlinkSync).not.toHaveBeenCalledWith(expect.stringContaining(first));
            expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining(first), "utf-8");
            expect(mockSpawnSync.mock.calls.some(call => call[1]?.includes("stop"))).toBe(false);
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
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

        it("prunes a provably stale foreign claim before replacing a confirmed-stopped container", () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(["proj-abc--current.lock", "proj-abc--stale.lock"]);
            mockReadFileSync.mockImplementation((path: string) => (
                String(path).endsWith("stale.lock") ? JSON.stringify({ version: 3, pid: 99999, startToken: null, ownershipKind: "direct" }) : String(process.pid)
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
            expect(mockReadFileSync).toHaveBeenCalled();
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
            setSession("/locks/some--current.lock", "/home/user/project");
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
            setSessionContainerId(PINNED_ID);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs(PINNED_ID),
                expect.any(Object),
            );
        });

        it("stops the exact running container ID captured under the lifecycle lock", () => {
            const projectId = "my-project-abc123";
            const lockFileName = `${projectId}--aabbccddeeff00112233445566778899.lock`;
            const lockFile = `/locks/${lockFileName}`;
            const projectPath = "/home/user/my-project";

            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([lockFileName]);
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(PINNED_ID);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(lockFile, projectPath);
            setSessionContainerId(PINNED_ID);
            cleanupSession();

            expect(mockSpawnSync).toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs(PINNED_ID),
                expect.any(Object),
            );
            expect(mockSpawnSync).not.toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs("ccc-my-project-abc123"),
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
            setSessionContainerId(PROFILE_ID);
            cleanupSession();

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, "work");
            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs(PROFILE_ID),
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
                return JSON.stringify({ version: 2, pid, startToken: `windows:${pid}000` });
            });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                const match = String(args.at(-1)).match(/GetProcessById\((\d+)\)/);
                return { status: 0, stdout: `${match?.[1] ? `FOUND:${match[1]}000` : "UNKNOWN"}\n`, stderr: "" };
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
            expect(mockSpawnSync.mock.calls.some((call) => call[1]?.includes("stop"))).toBe(false);
        });

        it("does not stop the container when another Windows v2 session is live despite an ESRCH PID probe", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const other = `${projectId}--other.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([current, other]);
            mockReadFileSync.mockImplementation((path: string) => {
                const pid = String(path).endsWith(other) ? 4242 : process.pid;
                return JSON.stringify({ version: 2, pid, startToken: `windows:${pid}000` });
            });
            mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
                const match = String(args.at(-1)).match(/GetProcessById\((\d+)\)/);
                return { status: 0, stdout: `${match?.[1] ? `FOUND:${match[1]}000` : "UNKNOWN"}\n`, stderr: "" };
            });
            const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
                const error = new Error("not found") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            });

            setSession(`/locks/${current}`, "/home/user/my-project");
            setSessionContainerId(PINNED_ID, false);
            cleanupSession();

            expect(killSpy).not.toHaveBeenCalled();
            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${current}`);
            expect(mockUnlinkSync).not.toHaveBeenCalledWith(expect.stringContaining(other));
            expect(mockSpawnSync.mock.calls.some((call) => call[1]?.includes("stop"))).toBe(false);
        });

        it("fails closed without stopping when the lock directory disappears during cleanup", () => {
            const error = new Error("missing") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            mockGetProjectId.mockReturnValue("my-project-abc123");
            mockReaddirSync.mockImplementation(() => {
                throw error;
            });

            setSession("/locks/my-project-abc123--current.lock", "/home/user/my-project");
            setSessionContainerId(PINNED_ID);

            expect(() => cleanupSession()).toThrow(error);
            expect(mockSpawnSync.mock.calls.some((call) => call[1]?.includes("stop"))).toBe(false);
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
        });

        it("reconciles proven PID reuse before stopping the exact last-session container", () => {
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const stale = `${projectId}--stale.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            const claims = [current, stale];
            mockReaddirSync.mockImplementation(() => [...claims]);
            mockUnlinkSync.mockImplementation((path: string) => { claims.splice(claims.indexOf(basename(path)), 1); });
            mockReadFileSync.mockImplementation((path: string) => {
                if (String(path).startsWith("/proc/4242/")) {
                    const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? "R" : index === 19 ? "200" : "0");
                    return `4242 (node) ${fields.join(" ")}`;
                }
                if (String(path).endsWith(stale)) {
                    return JSON.stringify({ version: 3, ownershipKind: "direct", pid: 4242, startToken: "linux:100" });
                }
                return String(process.pid);
            });
            vi.spyOn(process, "kill").mockImplementation(() => true);
            mockGetContainerName.mockReturnValue("ccc-my-project-abc123");
            mockIsContainerRunning.mockReturnValue(true);
            mockSpawnSync.mockReturnValue({ status: 0 });

            setSession(`/locks/${current}`, "/home/user/my-project");
            setSessionContainerId(PINNED_ID);
            const admission = createSessionLock(projectId);
            removeSessionLock(admission);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${current}`);
            expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining(stale));
            expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining(stale), "utf-8");
            expect(mockSpawnSync).toHaveBeenCalledWith(fixtureInvocation.executable, stopArgs(PINNED_ID), { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL", shell: false, env: expect.any(Object) });
            expect(mockCleanupOwnerDevices).toHaveBeenCalledTimes(1);
        });

        it("reconciles Windows token mismatch before the fresh raw veto permits exact-ID stop", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            const projectId = "my-project-abc123";
            const current = `${projectId}--current.lock`;
            const foreign = `${projectId}--foreign.lock`;
            mockGetProjectId.mockReturnValue(projectId);
            mockExistsSync.mockReturnValue(true);
            const claims = [current, foreign];
            mockReaddirSync.mockImplementation(() => [...claims]);
            mockUnlinkSync.mockImplementation((path: string) => { claims.splice(claims.indexOf(basename(path)), 1); });
            mockReadFileSync.mockReturnValue(JSON.stringify({
                version: 3, ownershipKind: "direct",
                pid: 4242,
                startToken: "windows:old-token",
            }));
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: "FOUND:638000000000000001\n",
                stderr: "",
            });

            setSession(`/locks/${current}`, "/home/user/my-project");
            setSessionContainerId(PINNED_ID);
            const admission = createSessionLock(projectId);
            removeSessionLock(admission);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(`/locks/${current}`);
            expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining(foreign));
            expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining(foreign), "utf-8");
            expect(mockSpawnSync).toHaveBeenCalledWith(fixtureInvocation.executable, stopArgs(PINNED_ID), { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL", shell: false, env: expect.any(Object) });
            expect(mockCleanupOwnerDevices).toHaveBeenCalledTimes(1);
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
                fixtureInvocation.executable,
                stopArgs("ccc-my-project-abc123"),
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
            mockUnlinkSync.mockImplementation((path: string) => { if (path.endsWith(".lock")) order.push("unlink"); });
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
            setSessionContainerId(PINNED_ID);
            cleanupSession();

            expect(order).toEqual(["critical-start", "session-check", "stop", "unlink", "critical-end"]);
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
            setSessionContainerId(PINNED_ID);
            mockSpawnSync.mockReturnValue({ status: 0 });
            cleanupSession();

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockSpawnSync).toHaveBeenCalledWith(fixtureInvocation.executable, stopArgs(PINNED_ID), expect.any(Object));
            expect(mockUnlinkSync).not.toHaveBeenCalledWith(`/locks/${profileLockFileName}`);
        });

        it("does not directly stop the global clipboard server during session cleanup", () => {
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

            mockUnlinkSync.mockImplementation(() => {
                // The global clipboard watchdog owns delayed shutdown.
            });

            setSession(lockFile, projectPath);
            cleanupSession();

            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("retires a qualified no-target claim without deriving cleanup authority from ambient container state", () => {
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

            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
            expect(mockUnlinkSync).toHaveBeenCalledWith(lockFile);
        });

        it("cleans up devices before docker stop when container is running", () => {
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
            mockSpawnSync.mockImplementation(() => {
                callOrder.push("dockerStop");
                return { status: 0 };
            });
            mockCleanupOwnerDevices.mockImplementation(() => {
                callOrder.push("cleanupDevices");
            });

            setSession(lockFile, projectPath);
            setSessionContainerId(PINNED_ID);
            cleanupSession();

            expect(callOrder).toEqual(["cleanupDevices", "dockerStop"]);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs(PINNED_ID),
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
            setSessionContainerId(PINNED_ID);
            cleanupSession();

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockSpawnSync).toHaveBeenCalledWith(
                fixtureInvocation.executable,
                stopArgs(PINNED_ID),
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

        it("keeps cleanup incomplete when own claim unlink fails", () => {
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

            expect(() => cleanupSession()).toThrow("EACCES: permission denied");
            expect(getCurrentSession().lockFile).toBe(lockFile);
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

            expect(() => cleanupSession()).not.toThrow();
            expect(mockGetProjectId).not.toHaveBeenCalled();
            expect(mockUnlinkSync).not.toHaveBeenCalled();
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it("does NOT stop the container when other sessions are active", () => {
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

            expect(mockSpawnSync).not.toHaveBeenCalled();
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
