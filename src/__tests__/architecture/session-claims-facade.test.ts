import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFacade from "../../container-runtime.js";
import { preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";
import { sessionLockOwner } from "../../domain/session-lock.js";
import { captureNativeSessionOwnership } from "../../adapters/session-ownership.js";
import { createNativeSessionClaimObservationStore } from "../../adapters/session-claim-observation.js";

const effects = vi.hoisted(() => ({
    directory: "", stat: vi.fn(), random: vi.fn(), token: vi.fn(), observe: vi.fn(), classify: vi.fn(),
    lock: vi.fn(), cleanup: vi.fn(), spawn: vi.fn(),
}));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(),
    lstatSync: (...args: unknown[]) => effects.stat(...args),
}));
vi.mock("crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomBytes: effects.random }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: effects.spawn }));
vi.mock("../../home-layout.js", () => ({ locksDir: () => effects.directory }));
vi.mock("../../utils.js", () => ({ getProjectId: () => "project" }));
vi.mock("@ccc/device-lab/project-identity.js", () => ({ getProjectId: () => "project" }));
vi.mock("../../device-lab-cleanup.js", () => ({ cleanupOwnerDevices: effects.cleanup }));
vi.mock("../../session-lock-liveness.js", async original => ({
    ...await original<typeof import("../../session-lock-liveness.js")>(),
    processStartToken: effects.token, observeProcessStarts: effects.observe, sessionLockLiveness: effects.classify,
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({
    withSharedMutationLock: effects.lock, withSharedMutationLockAsync: effects.lock,
}));
const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { lstatSync } = nativeFs;
const session = await import("../../session.js");
const { createSessionClaimsStore } = await import("../../adapters/session-claims-store.js");
const id = "a".repeat(32), containerId = "b".repeat(64);
let root: string;
let held = false;

function writeClaim(name: string, owner: object | string): string {
    const path = join(effects.directory, name);
    writeFileSync(path, typeof owner === "string" ? owner : JSON.stringify(owner), { mode: 0o600 });
    return path;
}

beforeEach(() => {
    vi.resetAllMocks(); session.clearSession(); held = false;
    root = mkdtempSync(join(tmpdir(), "ccc-claim-facade-"));
    effects.directory = join(root, "locks"); mkdirSync(effects.directory, { mode: 0o700 });
    effects.stat.mockImplementation(lstatSync);
    effects.random.mockReturnValue(Buffer.from(id, "hex")); effects.token.mockReturnValue("opaque-start");
    effects.observe.mockReturnValue(new Map()); effects.classify.mockReturnValue("active");
    effects.lock.mockImplementation((_path, operation) => {
        expect(held).toBe(false); held = true;
        try { return operation(); } finally { held = false; }
    });
    preloadNativeRuntimeFixture(runtimeFacade);
});
afterEach(() => { session.clearSession(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("session claims compatibility facade", () => {
    it("exports callable public operations and keeps the deprecated query alias behavior", () => {
        for (const name of ["createSessionLock", "removeSessionLock", "removeSessionLockInHeldLifecycleLock",
            "acquireHostSessionOwnership", "getActiveSessionsForContainer", "getActiveSessionsForProject",
            "getSessionLockClaimsForContainer", "getSessionLockClaimsForProjectFamily", "hasOtherSessionClaims",
            "recreateContainerWithoutInterruptingSessions"] as const) expect(session[name]).toBeTypeOf("function");
        writeClaim("project--current.lock", { version: 3, pid: process.pid, startToken: null, ownershipKind: "direct" });
        writeClaim("project--p--work--other.lock", "123");
        expect(session.getActiveSessionsForProject("project")).toEqual(session.getActiveSessionsForContainer("project"));
        expect(session.getActiveSessionsForContainer("project")).toEqual(["project--current.lock"]);
    });

    it.each(["opaque-start", null])("creates an exclusively owned direct claim under its guard for token %s", token => {
        effects.token.mockReturnValue(token);
        effects.random.mockImplementation(() => { expect(held).toBe(true); return Buffer.from(id, "hex"); });
        const own = session.createSessionLock("project", "work");
        expect(own).toBe(join(effects.directory, `project--p--work--${id}.lock`));
        const content = readFileSync(own, "utf8"), owner = sessionLockOwner(content);
        expect(owner).toEqual({ pid: process.pid, ownershipKind: "direct", ...(token ? { startToken: token } : {}) });
        expect(JSON.parse(content)).toMatchObject({ version: 3, startToken: token });
        if (process.platform !== "win32") expect(lstatSync(own).mode & 0o777).toBe(0o600);
        expect(effects.lock).toHaveBeenCalledExactlyOnceWith(join(effects.directory, "project--p--work.container-lifecycle.guard"), expect.any(Function), { waitMs: 180000 });
        session.removeSessionLock(own);
        expect(existsSync(own)).toBe(false);
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("captures the new reservation and its receipt inside the same held guard", () => {
        const second = join(root, "second-locks"); mkdirSync(second, { mode: 0o700 });
        effects.lock.mockImplementation((_path, operation) => {
            effects.directory = second; held = true;
            try { return operation(); } finally { held = false; }
        });
        const own = session.createSessionLock("project");
        expect(own).toBe(join(second, `project--${id}.lock`));
        expect(sessionLockOwner(readFileSync(own, "utf8"))?.ownershipKind).toBe("direct");
        session.removeSessionLock(own);
        expect(existsSync(own)).toBe(false);
    });

    it("preserves a true owned responsibility when an unknown foreign claim vetoes cleanup", () => {
        const own = writeClaim("project--current.lock", { version: 3, pid: process.pid, startToken: "opaque-start", ownershipKind: "monitored" });
        const foreign = writeClaim("project--foreign.lock", "malformed foreign claim");
        const observations = createNativeSessionClaimObservationStore();
        const binding = { lockFile: own, projectPath: root, prefix: "project", toolName: "claude" };
        const initial = observations.begin({ receipt: captureNativeSessionOwnership(own), binding,
            runtimeInvocation: runtimeFacade.getRuntimeInvocation(), guardian: { pid: process.pid, startToken: "opaque-start" }, generation: "1" });
        observations.update(initial, { ...initial.observation, registration: "ready",
            lastAcknowledged: { generation: "1", sequence: 1, containerId, cleanupEnabled: true } });
        session.setSession(own, root); session.setSessionContainerId(containerId);
        effects.classify.mockReturnValue("unknown");
        expect(() => session.cleanupSession()).toThrow("session-cleanup-responsibility-incomplete");
        expect(readFileSync(foreign, "utf8")).toBe("malformed foreign claim");
        expect(existsSync(own)).toBe(true); expect(existsSync(`${own}.guardian.json`)).toBe(true);
        expect(session.getCurrentSession().lockFile).toBe(own);
        expect(effects.cleanup).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("keeps raw claims and raw veto queries free of liveness inference", () => {
        const own = writeClaim("project--current.lock", "123"); writeClaim("project--foreign.lock", "456");
        expect(session.hasOtherSessionClaims("project", own)).toBe(true);
        expect(session.getSessionLockClaimsForContainer("project").sort()).toEqual(["project--current.lock", "project--foreign.lock"]);
        expect(session.getSessionLockClaimsForProjectFamily("project").sort()).toEqual(["project--current.lock", "project--foreign.lock"]);
        expect(effects.classify).not.toHaveBeenCalled(); expect(effects.observe).not.toHaveBeenCalled();
        expect(readdirSync(effects.directory).sort()).toEqual(["project--current.lock", "project--foreign.lock"]);
    });

    it.each(["live", "unknown", "unreadable"])("preserves %s prestart claims while reserving a distinct direct claim", mode => {
        const foreign = writeClaim("project--foreign.lock", "123");
        const other = writeClaim("project--p--other--stale.lock", "456");
        effects.classify.mockReturnValue(mode === "live" ? "active" : "unknown");
        if (mode === "unreadable") effects.stat.mockImplementation((path, options) => {
            if (String(path) === foreign) throw Object.assign(new Error("denied"), { code: "EACCES" });
            return lstatSync(path, options);
        });
        const own = session.createSessionLock("project");
        expect(readFileSync(foreign, "utf8")).toBe("123"); expect(readFileSync(other, "utf8")).toBe("456");
        expect(existsSync(own)).toBe(true); expect(effects.spawn).not.toHaveBeenCalled();
        session.removeSessionLock(own);
    });

    it("classifies only explicitly direct stale claims as inactive without deleting any query result", () => {
        const direct = writeClaim("project--direct.lock", { version: 3, pid: 4242, startToken: null, ownershipKind: "direct" });
        const legacy = writeClaim("project--legacy.lock", "4243"); effects.classify.mockReturnValue("stale");
        expect(session.getActiveSessionsForContainer("project")).toEqual(["project--legacy.lock"]);
        expect(existsSync(direct)).toBe(true); expect(readFileSync(legacy, "utf8")).toBe("4243");
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("refuses exclusive-write collisions and failed enumeration without replacing existing content", () => {
        const existing = writeClaim(`project--${id}.lock`, { version: 3, pid: process.pid, startToken: null, ownershipKind: "direct" });
        const bytes = readFileSync(existing, "utf8");
        expect(() => session.createSessionLock("project")).toThrow(); expect(readFileSync(existing, "utf8")).toBe(bytes);
        effects.directory = join(root, "absent-parent", "locks");
        writeFileSync(join(root, "absent-parent"), "not a directory");
        const recreate = vi.fn();
        expect(() => session.recreateContainerWithoutInterruptingSessions("project", "current.lock", recreate)).toThrow();
        expect(recreate).not.toHaveBeenCalled(); expect(readFileSync(existing, "utf8")).toBe(bytes);
    });

    it("refuses a same-path same-content successor after capturing a direct claim", () => {
        const own = session.createSessionLock("project"), saved = join(root, "original-claim");
        const bytes = readFileSync(own, "utf8"); renameSync(own, saved); writeFileSync(own, bytes, { mode: 0o600 });
        expect(() => session.removeSessionLock(own)).toThrow("receipt changed");
        expect(readFileSync(own, "utf8")).toBe(bytes); expect(readFileSync(saved, "utf8")).toBe(bytes);
        expect(effects.cleanup).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });
});

describe("session claim filesystem adapter boundaries", () => {
    it.each(["file", "linked-directory"])("refuses a %s claim root before listing or writing", kind => {
        const store = createSessionClaimsStore({ directory: () => effects.directory, platform: () => "linux" });
        effects.stat.mockReturnValue({ isDirectory: () => kind !== "file", isSymbolicLink: () => kind === "linked-directory" });
        expect(() => store.ensureDirectory()).toThrow("CCC session lock path must be a real directory");
        expect(readdirSync(effects.directory)).toEqual([]);
    });

    it("resolves directory and platform lazily and reads only the bounded captured file", () => {
        let directory = effects.directory, platform = "linux";
        const store = createSessionClaimsStore({ directory: () => directory, platform: () => platform });
        chmodSync(directory, 0o755); store.ensureDirectory();
        if (process.platform !== "win32") expect(lstatSync(directory).mode & 0o777).toBe(0o700);
        directory = join(root, "second"); mkdirSync(directory, { mode: 0o755 }); platform = "win32"; store.ensureDirectory();
        writeFileSync(join(directory, "claim.lock"), " 123\n", { mode: 0o600 });
        expect(store.readClaim("claim.lock")).toBe(" 123\n");
        const oversized = "x".repeat(4097); writeFileSync(join(directory, "claim.lock"), oversized);
        expect(() => store.readClaim("claim.lock")).toThrow();
        expect(readFileSync(join(directory, "claim.lock"), "utf8")).toBe(oversized);
    });
});
