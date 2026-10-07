import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    clipboardFilesDir,
    clipboardPortFile,
    clipboardStartingLock,
    helperBinDir,
    locksDir,
    ensureDefaultProfileDir,
    migrateHomeLayout,
    normalizeProfile,
    profileClaudeDir,
    profileClaudeJsonFile,
    profileCodexDir,
    readCccConfig,
    updateCccConfig,
} from "../home-layout.js";

let home: string;
const originalHome = process.env.HOME;

function ccc(...parts: string[]): string {
    return join(home, ".ccc", ...parts);
}

function seedLegacyHome(): void {
    mkdirSync(ccc("claude"), { recursive: true, mode: 0o700 });
    writeFileSync(ccc("claude", ".credentials.json"), "claude-secret", { mode: 0o600 });
    writeFileSync(ccc("claude.json"), "{\"onboarded\":true}", { mode: 0o600 });
    mkdirSync(ccc("codex"), { recursive: true, mode: 0o700 });
    writeFileSync(ccc("codex", "auth.json"), "codex-secret", { mode: 0o600 });
    mkdirSync(ccc("locks"), { recursive: true, mode: 0o700 });
    mkdirSync(ccc("clipboard-files"), { recursive: true });
    writeFileSync(ccc("clipboard-files", "shot.png"), "png");
    mkdirSync(ccc("bin"), { recursive: true });
    writeFileSync(ccc("clipboard.port"), "1234:token");
    mkdirSync(ccc("remote"), { recursive: true });
    writeFileSync(ccc("remote", "abc123.json"), JSON.stringify({ host: "desk", user: "me", remotePath: "" }));
    writeFileSync(ccc("config.json"), JSON.stringify({ defaultTool: "codex" }));
}

const noSessions = { hasLiveSessions: () => false, warn: () => {} };

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccc-home-layout-"));
    process.env.HOME = home;
});

afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
});

describe("home layout resolution", () => {
    it("uses the profile and run layout on a fresh home", () => {
        expect(profileClaudeDir()).toBe(ccc("profiles", "default", "claude"));
        expect(profileClaudeJsonFile()).toBe(ccc("profiles", "default", "claude.json"));
        expect(profileCodexDir()).toBe(ccc("profiles", "default", "codex"));
        expect(locksDir()).toBe(ccc("run", "locks"));
        expect(clipboardFilesDir()).toBe(ccc("run", "clipboard-files"));
        expect(helperBinDir()).toBe(ccc("run", "bin"));
        expect(clipboardPortFile()).toBe(ccc("run", "clipboard.port"));
    });

    it("keeps using pre-layout entries until they move", () => {
        seedLegacyHome();
        expect(profileClaudeDir()).toBe(ccc("claude"));
        expect(profileClaudeJsonFile()).toBe(ccc("claude.json"));
        expect(profileCodexDir()).toBe(ccc("codex"));
        expect(locksDir()).toBe(ccc("locks"));
        expect(clipboardPortFile()).toBe(ccc("clipboard.port"));
    });

    it("keeps a missing or removed port in the retained legacy lock layout", () => {
        mkdirSync(ccc("locks"), { recursive: true });
        expect(clipboardPortFile()).toBe(ccc("clipboard.port"));
        expect(clipboardStartingLock()).toBe(ccc("clipboard.starting.v2"));
        writeFileSync(ccc("clipboard.port"), "1234:token");
        rmSync(ccc("clipboard.port"));
        expect(clipboardPortFile()).toBe(ccc("clipboard.port"));
        expect(existsSync(ccc("run"))).toBe(false);
    });

    it("retains a moved port inode when other runtime entries have not moved", () => {
        mkdirSync(ccc("locks"), { recursive: true });
        mkdirSync(ccc("run"), { recursive: true });
        writeFileSync(ccc("run", "clipboard.port"), "1234:token");
        expect(clipboardPortFile()).toBe(ccc("run", "clipboard.port"));
    });

    it("resolves each entry on its own in a partly migrated home", () => {
        seedLegacyHome();
        ensureDefaultProfileDir();
        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        expect(profileClaudeDir()).toBe(ccc("profiles", "default", "claude"));
        expect(profileCodexDir()).toBe(ccc("codex"));
    });

    it("never lets a pre-layout profile named default replace the no-profile login", () => {
        seedLegacyHome();
        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        writeFileSync(ccc("profiles", "default", "claude.json"), "{}");
        expect(profileClaudeDir()).toBe(ccc("claude"));
        expect(profileClaudeJsonFile()).toBe(ccc("claude.json"));
    });

    it("keeps a missing default entry on its old path while the home is pre-layout", () => {
        mkdirSync(ccc("claude"), { recursive: true });
        writeFileSync(ccc("claude.json"), "{}");
        expect(profileCodexDir()).toBe(ccc("codex"));

        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        expect(profileCodexDir()).toBe(ccc("codex"));
        expect(profileClaudeDir()).toBe(ccc("claude"));
    });

    it("maps named profiles under profiles/ and treats 'default' as no profile", () => {
        expect(normalizeProfile("default")).toBeUndefined();
        expect(normalizeProfile("work")).toBe("work");
        expect(profileCodexDir("work")).toBe(ccc("profiles", "work", "codex"));
        seedLegacyHome();
        expect(profileClaudeDir("default")).toBe(ccc("claude"));
        expect(profileClaudeDir("work")).toBe(ccc("profiles", "work", "claude"));
    });
});

describe("migrateHomeLayout", () => {
    it("does nothing on a fresh or already migrated home", () => {
        expect(migrateHomeLayout(noSessions)).toEqual({ status: "not-needed" });
        ensureDefaultProfileDir();
        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        expect(migrateHomeLayout(noSessions)).toEqual({ status: "not-needed" });
    });

    it("moves credentials, runtime files and remote configs without losing content", () => {
        seedLegacyHome();
        const originalPort = statSync(ccc("clipboard.port"));
        const retired: string[] = [];
        const result = migrateHomeLayout({ ...noSessions, retireLegacyClipboard: (file) => retired.push(file) });

        expect(result).toEqual({
            status: "migrated",
            moved: ["clipboard.port", "claude", "claude.json", "codex", "locks", "clipboard-files", "bin", join("remote", "abc123.json")],
            failed: [],
        });
        expect(readFileSync(ccc("profiles", "default", "claude", ".credentials.json"), "utf-8")).toBe("claude-secret");
        expect(readFileSync(ccc("profiles", "default", "claude.json"), "utf-8")).toBe("{\"onboarded\":true}");
        expect(readFileSync(ccc("profiles", "default", "codex", "auth.json"), "utf-8")).toBe("codex-secret");
        expect(readFileSync(ccc("run", "clipboard-files", "shot.png"), "utf-8")).toBe("png");
        expect(existsSync(ccc("run", "locks"))).toBe(true);
        expect(existsSync(ccc("run", "bin"))).toBe(true);
        expect(retired).toEqual([]);
        expect(statSync(ccc("run", "clipboard.port")).ino).toBe(originalPort.ino);
        expect(readFileSync(ccc("run", "clipboard.port"), "utf-8")).toBe("1234:token");
        expect(readCccConfig()).toEqual({ defaultTool: "codex", remote: { abc123: { host: "desk", user: "me", remotePath: "" } } });
        if (process.platform !== "win32") {
            expect(statSync(ccc("profiles", "default", "codex")).mode & 0o777).toBe(0o700);
            expect(statSync(ccc("profiles")).mode & 0o777).toBe(0o700);
        }
        for (const legacy of ["claude", "claude.json", "codex", "locks", "clipboard-files", "bin", "remote", "clipboard.port", ".layout-migration.lock"]) {
            expect(existsSync(ccc(legacy))).toBe(false);
        }

        expect(migrateHomeLayout(noSessions)).toEqual({ status: "not-needed" });
    });

    it("skips while a session may still use the old paths", () => {
        seedLegacyHome();
        expect(migrateHomeLayout({ hasLiveSessions: () => true })).toEqual({ status: "sessions-active" });
        expect(existsSync(ccc("claude"))).toBe(true);
        expect(existsSync(ccc(".layout-migration.lock"))).toBe(false);
    });

    it("retains legacy credentials and clipboard inode while any container holds their mounts", () => {
        seedLegacyHome();
        const before = statSync(ccc("clipboard.port"));
        const hasContainerMounts = vi.fn(() => true);
        expect(migrateHomeLayout({ ...noSessions, hasContainerMounts })).toEqual({ status: "mounts-active" });
        expect(readFileSync(ccc("codex", "auth.json"), "utf-8")).toBe("codex-secret");
        expect(statSync(ccc("clipboard.port")).ino).toBe(before.ino);
        expect(existsSync(ccc("profiles"))).toBe(false);
        expect(clipboardStartingLock()).toBe(ccc("clipboard.starting.v2"));
        expect(hasContainerMounts).toHaveBeenCalledOnce();
    });

    it("does not move state when container mount inspection fails", () => {
        seedLegacyHome();
        expect(() => migrateHomeLayout({ ...noSessions, hasContainerMounts: () => { throw new Error("inspect failed"); } })).toThrow("inspect failed");
        expect(existsSync(ccc("codex", "auth.json"))).toBe(true);
        expect(existsSync(ccc(".layout-migration.lock"))).toBe(false);
    });

    it.each(["clipboard.starting", "clipboard.starting.v2", join("run", "clipboard.starting"), join("run", "clipboard.starting.v2")])("preserves startup lock ownership at %s", path => {
        seedLegacyHome();
        mkdirSync(ccc("run"), { recursive: true });
        writeFileSync(ccc(path), "owner");
        const before = statSync(ccc(path));
        expect(migrateHomeLayout(noSessions)).toEqual({ status: "busy" });
        expect(statSync(ccc(path)).ino).toBe(before.ino);
        expect(readFileSync(ccc(path), "utf-8")).toBe("owner");
        expect(existsSync(ccc("codex", "auth.json"))).toBe(true);
        expect(clipboardPortFile()).toBe(ccc("clipboard.port"));
    });

    it("does not overwrite either clipboard inode or move credentials on a port conflict", () => {
        seedLegacyHome();
        mkdirSync(ccc("run"), { recursive: true });
        writeFileSync(ccc("run", "clipboard.port"), "9876:other-token");
        const old = statSync(ccc("clipboard.port"));
        const next = statSync(ccc("run", "clipboard.port"));
        expect(migrateHomeLayout(noSessions)).toEqual({ status: "busy" });
        expect(statSync(ccc("clipboard.port")).ino).toBe(old.ino);
        expect(statSync(ccc("run", "clipboard.port")).ino).toBe(next.ino);
        expect(readFileSync(ccc("run", "clipboard.port"), "utf-8")).toBe("9876:other-token");
        expect(existsSync(ccc("codex", "auth.json"))).toBe(true);
        expect(clipboardPortFile()).toBe(ccc("clipboard.port"));
    });

    it("skips while another start holds a fresh migration lock, and takes over a stale one", () => {
        seedLegacyHome();
        writeFileSync(ccc(".layout-migration.lock"), "");
        expect(migrateHomeLayout(noSessions)).toEqual({ status: "busy" });
        expect(existsSync(ccc("claude"))).toBe(true);

        const old = new Date(Date.now() - 11 * 60 * 1000);
        utimesSync(ccc(".layout-migration.lock"), old, old);
        expect(migrateHomeLayout(noSessions).status).toBe("migrated");
        expect(existsSync(ccc("claude"))).toBe(false);
    });

    it("leaves both copies when the new entry already exists, and says so once", () => {
        seedLegacyHome();
        ensureDefaultProfileDir();
        mkdirSync(ccc("profiles", "default", "codex"), { recursive: true });
        const warn = vi.fn();
        const result = migrateHomeLayout({ hasLiveSessions: () => false, warn });

        expect(result.status).toBe("migrated");
        expect(existsSync(ccc("codex", "auth.json"))).toBe(true);
        expect(profileCodexDir()).toBe(ccc("profiles", "default", "codex"));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("both"));

        const hasLiveSessions = vi.fn(() => false);
        expect(migrateHomeLayout({ hasLiveSessions, warn })).toEqual({ status: "not-needed" });
        expect(migrateHomeLayout({ hasLiveSessions, warn })).toEqual({ status: "not-needed" });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(hasLiveSessions).not.toHaveBeenCalled();
    });

    it("does not mistake a codex login made before migration for a user profile named default", () => {
        mkdirSync(ccc("claude"), { recursive: true });
        writeFileSync(ccc("claude.json"), "{}");
        mkdirSync(ccc("locks"), { recursive: true });
        expect(migrateHomeLayout({ hasLiveSessions: () => true })).toEqual({ status: "sessions-active" });
        mkdirSync(profileCodexDir(), { recursive: true });
        writeFileSync(join(profileCodexDir(), "auth.json"), "codex-login");

        const warn = vi.fn();
        expect(migrateHomeLayout({ hasLiveSessions: () => false, warn }).status).toBe("migrated");
        expect(readFileSync(ccc("profiles", "default", "codex", "auth.json"), "utf-8")).toBe("codex-login");
        expect(existsSync(ccc("profiles", "default-pre-layout"))).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });

    it("sets a pre-layout profile named default aside before moving the no-profile login in", () => {
        seedLegacyHome();
        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        writeFileSync(ccc("profiles", "default", "claude", ".credentials.json"), "other-account");
        const warn = vi.fn();
        const result = migrateHomeLayout({ hasLiveSessions: () => false, warn });

        expect(result).toMatchObject({ status: "migrated", failed: [] });
        expect(readFileSync(ccc("profiles", "default-pre-layout", "claude", ".credentials.json"), "utf-8")).toBe("other-account");
        expect(readFileSync(ccc("profiles", "default", "claude", ".credentials.json"), "utf-8")).toBe("claude-secret");
        expect(profileClaudeDir()).toBe(ccc("profiles", "default", "claude"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("CCC_PROFILE=default-pre-layout"));
    });

    it("keeps going when one entry cannot move, and that entry stays on its old path", async () => {
        seedLegacyHome();
        const fs = await import("fs");
        const realRename = fs.renameSync;
        vi.resetModules();
        vi.doMock("fs", async () => {
            const actual = await vi.importActual<typeof import("fs")>("fs");
            return {
                ...actual,
                renameSync: (from: string, to: string) => {
                    if (String(from).endsWith(join(".ccc", "codex"))) {
                        throw Object.assign(new Error("busy"), { code: "EBUSY" });
                    }
                    return realRename(from, to);
                },
            };
        });
        const layout = await import("../home-layout.js");
        const warn = vi.fn();
        const result = layout.migrateHomeLayout({ hasLiveSessions: () => false, warn });
        vi.doUnmock("fs");
        vi.resetModules();

        expect(result).toMatchObject({ status: "migrated", failed: ["codex"] });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
        expect(layout.profileClaudeDir()).toBe(ccc("profiles", "default", "claude"));
        expect(layout.profileCodexDir()).toBe(ccc("codex"));
    });

    it("keeps a remote config that is not valid JSON", () => {
        mkdirSync(ccc("remote"), { recursive: true });
        writeFileSync(ccc("remote", "bad.json"), "{nope");
        const warn = vi.fn();
        migrateHomeLayout({ hasLiveSessions: () => false, warn });
        expect(existsSync(ccc("remote", "bad.json"))).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
        expect(migrateHomeLayout({ hasLiveSessions: () => false, warn })).toEqual({ status: "not-needed" });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("keeps legacy remote configs when config.json cannot be parsed", () => {
        seedLegacyHome();
        writeFileSync(ccc("config.json"), "{broken");
        const warn = vi.fn();
        const result = migrateHomeLayout({ hasLiveSessions: () => false, warn });

        expect(result).toMatchObject({ status: "migrated", failed: ["remote"] });
        expect(readFileSync(ccc("config.json"), "utf-8")).toBe("{broken");
        expect(existsSync(ccc("remote", "abc123.json"))).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a valid JSON object"));
    });
});

describe("config.json updates", () => {
    it("preserves unrelated keys", () => {
        updateCccConfig((config) => {
            config.defaultTool = "claude";
        });
        updateCccConfig((config) => {
            config.remote = { h: { host: "x" } };
        });
        expect(readCccConfig()).toEqual({ defaultTool: "claude", remote: { h: { host: "x" } } });
        if (process.platform !== "win32") expect(statSync(ccc("config.json")).mode & 0o777).toBe(0o600);
    });

    it("refuses to overwrite an unparseable file", () => {
        mkdirSync(ccc(), { recursive: true });
        writeFileSync(ccc("config.json"), "{broken");
        expect(() => updateCccConfig((config) => {
            config.defaultTool = "claude";
        })).toThrow(/not a valid JSON object/);
        expect(readFileSync(ccc("config.json"), "utf-8")).toBe("{broken");
    });
});

describe("remote claude folder script", () => {
    async function resolveOnRemote(profile?: string): Promise<string> {
        const { remoteClaudeDirScript } = await import("../remote.js");
        const { spawnSync } = await vi.importActual<typeof import("child_process")>("child_process");
        const result = spawnSync("sh", ["-c", `umask 077; ${remoteClaudeDirScript(profile)}; printf %s "$_ccc_claude_dir"`], {
            env: { ...process.env, HOME: home },
            encoding: "utf-8",
        });
        expect(result.status).toBe(0);
        return result.stdout;
    }

    it("follows the same rule as the local resolver", async () => {
        // Fresh remote home: new layout, marked.
        expect(await resolveOnRemote()).toBe(ccc("profiles", "default", "claude"));
        expect(existsSync(ccc("profiles", "default", ".ccc-default-profile"))).toBe(true);
        rmSync(ccc(), { recursive: true, force: true });

        // Pre-layout remote home with a user profile named default: the old no-profile folder.
        mkdirSync(ccc("claude"), { recursive: true });
        mkdirSync(ccc("profiles", "default", "claude"), { recursive: true });
        expect(await resolveOnRemote()).toBe(ccc("claude"));
        expect(existsSync(ccc("profiles", "default", ".ccc-default-profile"))).toBe(false);

        // Migrated remote home, with a stale old folder left behind: the marked profile.
        ensureDefaultProfileDir();
        expect(await resolveOnRemote()).toBe(ccc("profiles", "default", "claude"));

        // Named profiles never fall back.
        expect(await resolveOnRemote("work")).toBe(ccc("profiles", "work", "claude"));
        expect(await resolveOnRemote("default")).toBe(ccc("profiles", "default", "claude"));
    });
});

describe("live-session check for the migration", () => {
    it("sees a session lock in the pre-layout locks folder even when run/locks exists", async () => {
        const { hasAnyActiveSessionsExcept } = await import("../clipboard-server.js");
        mkdirSync(ccc("run", "locks"), { recursive: true });
        mkdirSync(ccc("locks"), { recursive: true });
        expect(hasAnyActiveSessionsExcept(null, ccc("locks"))).toBe(false);
        writeFileSync(ccc("locks", "proj--session.lock"), "older-ccc-session");
        expect(locksDir()).toBe(ccc("run", "locks"));
        expect(hasAnyActiveSessionsExcept(null, ccc("run", "locks"))).toBe(false);
        expect(hasAnyActiveSessionsExcept(null, ccc("locks"))).toBe(true);
    });
});
