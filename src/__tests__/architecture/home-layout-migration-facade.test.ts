import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { HomeLayoutMigrationOptions } from "../../home-layout.js";

const interception = vi.hoisted(() => ({
    hooks: new Map<string, (args: unknown[], native: (...args: unknown[]) => unknown) => unknown>(),
    factory: vi.fn(),
}));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const names = ["lstatSync", "statSync", "openSync", "closeSync", "unlinkSync", "mkdirSync", "renameSync", "readFileSync", "writeFileSync", "readdirSync", "rmdirSync"];
    return { ...actual, ...Object.fromEntries(names.map(name => {
        const native = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
        return [name, (...args: unknown[]) => {
            const hook = interception.hooks.get(name);
            return hook ? hook(args, native) : native(...args);
        }];
    })) };
});
vi.mock("../../application/home-layout-migration.js", async original => {
    const actual = await original<typeof import("../../application/home-layout-migration.js")>();
    return { ...actual, createHomeLayoutMigration: (...args: Parameters<typeof actual.createHomeLayoutMigration>) => {
        interception.factory(...args); return actual.createHomeLayoutMigration(...args);
    } };
});
const fs = await vi.importActual<typeof import("node:fs")>("fs");
const layout = await import("../../home-layout.js");
let home: string;
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const options = { hasLiveSessions: () => false, warn: () => {} };
const path = (...parts: string[]) => join(home, ".ccc", ...parts);
function seed() { fs.mkdirSync(path("codex"), { recursive: true, mode: 0o700 }); fs.writeFileSync(path("codex", "auth.json"), "fixture-token", { mode: 0o600 }); }
function caught(run: () => unknown): unknown { try { run(); } catch (error) { return error; } throw new Error("Expected exception"); }
function hook(name: string, effect: (args: unknown[], native: (...args: unknown[]) => unknown) => unknown) { interception.hooks.set(name, effect); }
beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), "ccc-home-migration-facade-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    interception.hooks.clear(); interception.factory.mockClear();
});
afterEach(() => {
    interception.hooks.clear(); vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
});

describe("home layout migration actual native facade", () => {
    it("executes the real application and preserves clipboard inode, bytes and native creation modes", () => {
        seed(); fs.writeFileSync(path("clipboard.port"), "4312:fixture-token", { mode: 0o600 });
        const original = fs.statSync(path("clipboard.port"));
        const retired = vi.fn(); const created: Array<[string, unknown]> = [];
        hook("openSync", (args, native) => { created.push([String(args[0]), args[2]]); return native(...args); });
        expect(layout.migrateHomeLayout({ ...options, retireLegacyClipboard: retired })).toEqual({ status: "migrated", moved: ["clipboard.port", "codex"], failed: [] });
        expect(interception.factory).toHaveBeenCalledOnce();
        expect(fs.statSync(path("run", "clipboard.port")).ino).toBe(original.ino);
        expect(fs.readFileSync(path("run", "clipboard.port"), "utf8")).toBe("4312:fixture-token");
        expect(retired).not.toHaveBeenCalled();
        expect(created.map(([, mode]) => mode)).toEqual([0o600, 0o600, 0o600, 0o600, 0o600]);
        if (process.platform !== "win32") {
            for (const name of ["run", "profiles", join("profiles", "default")]) expect(fs.statSync(path(name)).mode & 0o777).toBe(0o700);
            expect(fs.statSync(path("profiles", "default", ".ccc-default-profile")).mode & 0o777).toBe(0o600);
        }
        expect(layout.migrateHomeLayout(options)).toEqual({ status: "not-needed" });
    });
    it("captures warn detached after resolving home and leaves now detached and deferred", () => {
        seed(); const seen: string[] = []; const receivers: unknown[] = [];
        const alternate = join(home, "alternate"); fs.mkdirSync(alternate);
        const supplied: HomeLayoutMigrationOptions = {
            hasLiveSessions() { seen.push("sessions"); receivers.push(this); return true; },
            get warn() { seen.push("warn:get"); process.env.HOME = alternate; process.env.USERPROFILE = alternate; return function(this: unknown) { receivers.push(this); }; },
            get now() { seen.push("now:get"); return function(this: unknown) { seen.push("now:call"); receivers.push(this); return 2000; }; },
        };
        expect(layout.migrateHomeLayout(supplied)).toEqual({ status: "sessions-active" });
        expect(seen).toEqual(["warn:get", "now:get", "now:call", "sessions"]);
        expect(receivers).toEqual([undefined, supplied]);
        expect(fs.existsSync(path(".layout-migration.lock"))).toBe(false);
        expect(fs.existsSync(join(alternate, ".ccc"))).toBe(false);
        const idle = { hasLiveSessions: vi.fn(() => false), get now(): () => number { throw new Error("early now"); } };
        expect(layout.migrateHomeLayout(idle)).toEqual({ status: "not-needed" }); expect(idle.hasLiveSessions).not.toHaveBeenCalled();
    });
    it("reads live session/mount members at original positions and keeps the original warn capture", () => {
        seed(); const receivers: unknown[] = []; const later = vi.fn(() => false); const captured = vi.fn(function(this: unknown) { receivers.push(this); });
        const supplied: HomeLayoutMigrationOptions = { warn: captured, hasLiveSessions() {
            receivers.push(this); this.hasContainerMounts = function() { receivers.push(this); return true; }; this.warn = later; return false;
        } };
        expect(layout.migrateHomeLayout(supplied)).toEqual({ status: "mounts-active" }); expect(receivers).toEqual([supplied, supplied]); expect(later).not.toHaveBeenCalled();
        supplied.hasLiveSessions = () => false; supplied.hasContainerMounts = () => false;
        fs.mkdirSync(path("run")); fs.writeFileSync(path("clipboard.port"), "first"); fs.writeFileSync(path("run", "clipboard.port"), "second");
        supplied.warn = captured;
        expect(layout.migrateHomeLayout(supplied)).toEqual({ status: "busy" }); expect(receivers.at(-1)).toBeUndefined();
        expect(captured).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("without replacing either clipboard file"));
    });
    it("retains repeated native home resolution by default-profile preparation", () => {
        seed(); const alternate = join(home, "other-home"); fs.mkdirSync(alternate);
        expect(layout.migrateHomeLayout({ ...options, hasLiveSessions() { process.env.HOME = alternate; process.env.USERPROFILE = alternate; return false; } })).toEqual({ status: "migrated", moved: ["codex"], failed: [] });
        expect(fs.existsSync(join(alternate, ".ccc", "profiles", "default", ".ccc-default-profile"))).toBe(true);
        expect(fs.existsSync(path("profiles", "default", ".ccc-default-profile"))).toBe(false);
        expect(fs.readFileSync(path("profiles", "default", "codex", "auth.json"), "utf8")).toBe("fixture-token");
    });
    it("uses Date.now only when pending work actually reaches acquisition", () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(2345);
        expect(layout.migrateHomeLayout(options)).toEqual({ status: "not-needed" }); expect(now).not.toHaveBeenCalled();
        seed(); expect(layout.migrateHomeLayout({ ...options, hasLiveSessions: () => true })).toEqual({ status: "sessions-active" }); expect(now).toHaveBeenCalledOnce();
    });
    it("uses mtime alone, exactly ten minutes, with at most two exclusive-open attempts", () => {
        seed(); const lock = path(".layout-migration.lock"); fs.writeFileSync(lock, "not-a-pid");
        fs.utimesSync(lock, new Date(0), new Date(1000)); const opens: string[] = [];
        hook("openSync", (args, native) => { if (args[0] === lock) opens.push(String(args[1])); return native(...args); });
        expect(layout.migrateHomeLayout({ ...options, now: () => 600_999 })).toEqual({ status: "busy" }); expect(opens).toEqual(["wx"]);
        opens.length = 0;
        expect(layout.migrateHomeLayout({ ...options, now: () => 601_000, hasLiveSessions: () => true })).toEqual({ status: "sessions-active" }); expect(opens).toEqual(["wx", "wx"]);
        expect(fs.existsSync(lock)).toBe(false); expect(fs.existsSync(path("codex"))).toBe(true);
    });
    it("returns busy after a second contender wins the stale-lock retry and leaves its lock intact", () => {
        seed(); const lock = path(".layout-migration.lock"); fs.writeFileSync(lock, "stale"); fs.utimesSync(lock, new Date(0), new Date(0)); let attempts = 0;
        hook("openSync", (args, native) => { if (args[0] === lock && ++attempts === 2) fs.writeFileSync(lock, "replacement-contender"); return native(...args); });
        expect(layout.migrateHomeLayout({ ...options, now: () => 700_000 })).toEqual({ status: "busy" }); expect(attempts).toBe(2); expect(fs.readFileSync(lock, "utf8")).toBe("replacement-contender");
    });
    it("defers to a real second process holding the native migration claim", async () => {
        seed(); const lock = path(".layout-migration.lock");
        const child = spawn(process.execPath, ["--input-type=module", "-e",
            'import {openSync,closeSync,unlinkSync} from "node:fs"; const lock=process.argv[1]; closeSync(openSync(lock,"wx",0o600)); process.send("held"); process.once("message",()=>{unlinkSync(lock);process.exit(0)});', lock],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, HOME: home, USERPROFILE: home } });
        try {
            const ready = await once(child, "message"); expect(ready[0]).toBe("held");
            expect(layout.migrateHomeLayout(options)).toEqual({ status: "busy" });
            expect(fs.existsSync(path("codex", "auth.json"))).toBe(true);
            const exited = once(child, "exit"); child.send("release"); expect((await exited)[0]).toBe(0);
            expect(layout.migrateHomeLayout(options).status).toBe("migrated");
        } finally { if (child.exitCode === null) child.kill(); }
    });
    it.each(["migration-open", "migration-stat", "migration-unlink"])("keeps broad acquisition fallback for %s faults", phase => {
        seed(); const lock = path(".layout-migration.lock"); fs.writeFileSync(lock, "stale"); fs.utimesSync(lock, new Date(0), new Date(0));
        const name = phase === "migration-open" ? "openSync" : phase === "migration-stat" ? "statSync" : "unlinkSync";
        hook(name, (args, native) => { if (args[0] === lock) throw { code: phase === "migration-open" ? "EACCES" : "fault" }; return native(...args); });
        expect(layout.migrateHomeLayout({ ...options, now: () => 700_000 })).toEqual({ status: "busy" }); expect(fs.existsSync(path("codex"))).toBe(true);
    });
    it("releases earlier startup claims while retaining an orphan whose identity read failed", () => {
        seed(); const orphan = path("clipboard.starting.v2");
        hook("lstatSync", (args, native) => { if (args[0] === orphan && fs.existsSync(orphan)) throw { identity: true }; return native(...args); });
        expect(layout.migrateHomeLayout(options)).toEqual({ status: "busy" });
        expect(fs.existsSync(path("clipboard.starting"))).toBe(false); expect(fs.existsSync(orphan)).toBe(true);
        expect(fs.existsSync(path("run", "clipboard.starting"))).toBe(false); expect(fs.existsSync(path(".layout-migration.lock"))).toBe(false);
    });
    it("preserves a replacement startup claim while releasing the other held claims in acquisition order", () => {
        seed(); const replacement = path("clipboard.starting"); const deleted: string[] = [];
        hook("renameSync", (args, native) => {
            if (args[0] === path("codex")) {
                fs.renameSync(replacement, path("held-original")); fs.writeFileSync(replacement, "replacement");
            }
            return native(...args);
        });
        hook("unlinkSync", (args, native) => { deleted.push(String(args[0])); return native(...args); });
        expect(layout.migrateHomeLayout(options).status).toBe("migrated");
        expect(fs.readFileSync(replacement, "utf8")).toBe("replacement");
        expect(deleted).toEqual([path("clipboard.starting.v2"), path("run", "clipboard.starting"), path("run", "clipboard.starting.v2"), path(".layout-migration.lock")]);
    });
    it.each(["session", "mount-getter", "mkdir"])("propagates original %s thrown values after lock cleanup", phase => {
        seed(); const failure = { phase }; const supplied: HomeLayoutMigrationOptions = { ...options };
        if (phase === "session") supplied.hasLiveSessions = () => { throw failure; };
        if (phase === "mount-getter") Object.defineProperty(supplied, "hasContainerMounts", { get() { throw failure; } });
        if (phase === "mkdir") hook("mkdirSync", (args, native) => { if (args[0] === path("run")) throw failure; return native(...args); });
        expect(caught(() => layout.migrateHomeLayout(supplied))).toBe(failure); expect(fs.existsSync(path(".layout-migration.lock"))).toBe(false); expect(fs.existsSync(path("codex"))).toBe(true);
    });
    it.each(["entry-code", "remote-message", "profile-code"])("keeps raw %s getter failure identity at its original catch boundary", phase => {
        seed(); const failure = { diagnostic: phase }; const original = {};
        if (phase === "remote-message") {
            fs.mkdirSync(path("remote")); fs.writeFileSync(path("remote", "a.json"), "1");
            Object.defineProperty(original, "message", { get() { throw failure; } });
            hook("unlinkSync", (args, native) => { if (args[0] === path("remote", "a.json")) throw original; return native(...args); });
        } else {
            Object.defineProperty(original, "code", { get() { throw failure; } });
            if (phase === "profile-code") fs.mkdirSync(path("profiles", "default"), { recursive: true });
            hook("renameSync", (args, native) => { if (args[0] === (phase === "entry-code" ? path("codex") : path("profiles", "default"))) throw original; return native(...args); });
        }
        expect(caught(() => layout.migrateHomeLayout(options))).toBe(failure);
        expect(fs.existsSync(path(".layout-migration.lock"))).toBe(false);
        for (const namespace of [[], ["run"]]) for (const name of ["clipboard.starting", "clipboard.starting.v2"]) expect(fs.existsSync(path(...namespace, name))).toBe(false);
    });
    it("keeps raw code interpolation, including Symbol conversion failure", () => {
        seed(); hook("renameSync", (args, native) => { if (args[0] === path("codex")) throw { code: Symbol("code") }; return native(...args); });
        const warn = vi.fn(); expect(() => layout.migrateHomeLayout({ ...options, warn })).toThrow(TypeError); expect(warn).not.toHaveBeenCalled(); expect(fs.existsSync(path(".layout-migration.lock"))).toBe(false);
    });
    it("retains the invalid-warning outer remote catch and second-warning exception identity", () => {
        fs.mkdirSync(path("remote"), { recursive: true }); fs.writeFileSync(path("remote", "bad.json"), "{");
        const first = { message: "first warning" }; const second = { second: true }; const warn = vi.fn((message: string) => { if (message.includes("not valid JSON")) throw first; throw second; });
        expect(caught(() => layout.migrateHomeLayout({ ...options, warn }))).toBe(second);
        expect(warn.mock.calls.map(([message]) => message)).toEqual([expect.stringContaining("not valid JSON"), expect.stringContaining("(first warning)")]);
        expect(fs.existsSync(path("run", "layout-conflicts"))).toBe(false); expect(fs.readFileSync(path("remote", "bad.json"), "utf8")).toBe("{");
    });
    it("retains native broad listing and presence fallbacks and best-effort releases", () => {
        seed(); hook("readdirSync", (args, native) => { if (args[0] === path("remote")) throw { unavailable: true }; return native(...args); });
        hook("lstatSync", (args, native) => { if (args[0] === path("profiles", "default")) throw { unavailable: true }; return native(...args); });
        hook("unlinkSync", () => { throw { release: true }; });
        expect(layout.migrateHomeLayout(options)).toEqual({ status: "migrated", moved: ["codex"], failed: [] });
        expect(fs.existsSync(path(".layout-migration.lock"))).toBe(true);
    });
});
