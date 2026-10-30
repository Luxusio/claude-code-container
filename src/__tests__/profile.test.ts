import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

// We need to mock PROFILES_DIR to use a temp dir
const mockRoot = mkdtempSync(join(tmpdir(), "ccc-test-profiles-"));
const mockProfilesDir = join(mockRoot, "profiles");
mkdirSync(mockProfilesDir, {mode: 0o700});
afterAll(() => rmSync(mockRoot, {recursive: true, force: true}));

vi.mock("../home-layout.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        profilesDir: () => mockProfilesDir,
        locksDir: () => join(mockRoot, "locks"),
    };
});

const {
    validateProfileName,
    listProfiles,
    profileExists,
    createProfile,
    removeProfile,
    BUILTIN_PROFILES,
    isBuiltinProfile,
    ensureProfile,
    ensureClaudePermissionDefaults,
} = await import("../profile.js");

describe("validateProfileName", () => {
    it("accepts valid simple name", () => {
        expect(validateProfileName("work")).toBe(true);
    });

    it("accepts name with hyphen", () => {
        expect(validateProfileName("local-llm")).toBe(true);
    });

    it("accepts alphanumeric name", () => {
        expect(validateProfileName("a1")).toBe(true);
    });

    it("accepts name with dot", () => {
        expect(validateProfileName("my.profile")).toBe(true);
    });

    it("accepts name with underscore", () => {
        expect(validateProfileName("my_profile")).toBe(true);
    });

    it("rejects empty string", () => {
        expect(validateProfileName("")).toBe(false);
    });

    it("rejects uppercase names", () => {
        expect(validateProfileName("UPPER")).toBe(false);
    });

    it("rejects names with spaces", () => {
        expect(validateProfileName("with space")).toBe(false);
    });

    it("rejects names longer than 64 chars", () => {
        expect(validateProfileName("a".repeat(65))).toBe(false);
    });

    it("accepts names exactly 64 chars", () => {
        expect(validateProfileName("a" + "b".repeat(63))).toBe(true);
    });

    it("rejects names starting with hyphen", () => {
        expect(validateProfileName("-start")).toBe(false);
    });

    it("rejects names starting with dot", () => {
        expect(validateProfileName(".start")).toBe(false);
    });

    it("rejects names with special chars", () => {
        expect(validateProfileName("my@profile")).toBe(false);
    });
});

describe("listProfiles / profileExists / createProfile / removeProfile", () => {
    beforeEach(() => {
        for (const entry of (() => {
            try {
                return require("fs").readdirSync(mockProfilesDir) as string[];
            } catch {
                return [];
            }
        })()) {
            rmSync(join(mockProfilesDir, entry), { recursive: true, force: true });
        }
    });

    it("listProfiles returns only the default profile when no named profiles exist", () => {
        expect(listProfiles()).toEqual(["default"]);
    });

    it("treats default as an existing, reserved profile", () => {
        expect(profileExists("default")).toBe(true);
        expect(() => createProfile("default")).toThrow(/reserved/);
        expect(() => removeProfile("default")).toThrow(/cannot be removed/);
    });

    it("profileExists returns false for nonexistent profile", () => {
        expect(profileExists("nonexistent")).toBe(false);
    });

    it("createProfile creates profile directory with claude/ and claude.json", () => {
        createProfile("work");
        expect(existsSync(join(mockProfilesDir, "work"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "claude"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "claude.json"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "codex"))).toBe(true);
    });

    it("profileExists returns true after createProfile", () => {
        createProfile("myprofile");
        expect(profileExists("myprofile")).toBe(true);
    });

    it("listProfiles returns created profiles", () => {
        createProfile("alpha");
        createProfile("beta");
        const profiles = listProfiles();
        expect(profiles).toContain("alpha");
        expect(profiles).toContain("beta");
    });

    it("removeProfile deletes profile directory", () => {
        createProfile("todelete");
        expect(profileExists("todelete")).toBe(true);
        removeProfile("todelete");
        expect(profileExists("todelete")).toBe(false);
    });

    it("listProfiles does not include removed profiles", () => {
        createProfile("keep");
        createProfile("remove");
        removeProfile("remove");
        const profiles = listProfiles();
        expect(profiles).toContain("keep");
        expect(profiles).not.toContain("remove");
    });
});

describe("BUILTIN_PROFILES", () => {
    it("contains local-llm entry", () => {
        expect(BUILTIN_PROFILES["local-llm"]).toBeDefined();
    });

    it("contains lab-runner entry", () => {
        expect(BUILTIN_PROFILES["lab-runner"]).toBeDefined();
    });

    it("local-llm has CLAUDE_CODE_ATTRIBUTION_HEADER=0 in env", () => {
        expect(BUILTIN_PROFILES["local-llm"].settings?.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    });
});

describe("isBuiltinProfile", () => {
    it("returns true for local-llm", () => {
        expect(isBuiltinProfile("local-llm")).toBe(true);
    });

    it("returns true for lab-runner", () => {
        expect(isBuiltinProfile("lab-runner")).toBe(true);
    });

    it("returns false for custom profile name", () => {
        expect(isBuiltinProfile("my-custom-profile")).toBe(false);
    });
});

describe("createProfile with settings", () => {
    beforeEach(() => {
        try {
            const entries = require("fs").readdirSync(mockProfilesDir) as string[];
            for (const e of entries) rmSync(join(mockProfilesDir, e), { recursive: true, force: true });
        } catch { /* empty */ }
    });

    it("writes settings.json when settings provided", () => {
        createProfile("withsettings", { env: { FOO: "bar" } });
        const settingsPath = join(mockProfilesDir, "withsettings", "claude", "settings.json");
        expect(existsSync(settingsPath)).toBe(true);
        const content = JSON.parse(require("fs").readFileSync(settingsPath, "utf-8"));
        expect(content.env?.FOO).toBe("bar");
    });

    it("does NOT write settings.json when no settings provided", () => {
        createProfile("nosettings");
        const settingsPath = join(mockProfilesDir, "nosettings", "claude", "settings.json");
        expect(existsSync(settingsPath)).toBe(false);
    });
});

describe("ensureProfile", () => {
    beforeEach(() => {
        try {
            const entries = require("fs").readdirSync(mockProfilesDir) as string[];
            for (const e of entries) rmSync(join(mockProfilesDir, e), { recursive: true, force: true });
        } catch { /* empty */ }
    });

    it("creates built-in profile and returns true when not existing", () => {
        const created = ensureProfile("local-llm");
        expect(created).toBe(true);
        expect(profileExists("local-llm")).toBe(true);
        const settingsPath = join(mockProfilesDir, "local-llm", "claude", "settings.json");
        expect(existsSync(settingsPath)).toBe(true);
    });

    it("creates lab-runner built-in profile without requiring user settings", () => {
        const created = ensureProfile("lab-runner");
        expect(created).toBe(true);
        expect(profileExists("lab-runner")).toBe(true);
        expect(existsSync(join(mockProfilesDir, "lab-runner", "claude"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "lab-runner", "claude", "settings.json"))).toBe(false);
    });

    it("returns false when profile already exists", () => {
        createProfile("local-llm");
        const created = ensureProfile("local-llm");
        expect(created).toBe(false);
    });

    it("throws for unknown non-builtin profile", () => {
        expect(() => ensureProfile("nonexistent-profile")).toThrow();
    });
});

describe("selected CCC Claude permission defaults", () => {
    beforeEach(() => {
        for (const name of readdirSync(mockProfilesDir)) rmSync(join(mockProfilesDir, name), {recursive: true, force: true});
    });

    it.each(["default", "work"])("creates settings for a new selected %s profile only", name => {
        const directory = join(mockProfilesDir, name, "claude");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        ensureClaudePermissionDefaults(directory);
        expect(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"))).toEqual({permissions: {defaultMode: "bypassPermissions"}});
        expect(existsSync(join(mockProfilesDir, name === "default" ? "work" : "default"))).toBe(false);
        if (process.platform !== "win32") expect(statSync(join(directory, "settings.json")).mode & 0o777).toBe(0o600);
    });

    it("merges existing settings while preserving other permissions, hooks, environment and keys", () => {
        createProfile("work");
        const directory = join(mockProfilesDir, "work", "claude"), file = join(directory, "settings.json");
        const original = {permissions: {defaultMode: "default", allow: ["Read"], deny: ["Bash(secrets)"], additionalDirectories: ["/fixture"]},
            env: {FIXTURE: "preserve"}, hooks: {SessionStart: [{hooks: [{type: "command", command: "fixture-only"}]}]}, model: "preserve-model", unknown: {nested: true}};
        writeFileSync(file, JSON.stringify(original), {mode: 0o600});
        ensureClaudePermissionDefaults(directory);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({...original, permissions: {...original.permissions, defaultMode: "bypassPermissions"}});
        expect(readdirSync(directory)).toEqual(["settings.json"]);
        expect(readdirSync(join(mockRoot, "locks"))).toEqual([]);
    });

    it("does not rewrite an existing bypass default", () => {
        const directory = join(mockProfilesDir, "work", "claude"), file = join(directory, "settings.json");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        const bytes = '{ "permissions": { "defaultMode": "bypassPermissions" }, "env": { "KEEP": "value" } }\n';
        writeFileSync(file, bytes, {mode: 0o600});
        const before = statSync(file);
        ensureClaudePermissionDefaults(directory);
        expect(readFileSync(file, "utf8")).toBe(bytes);
        expect(statSync(file).ino).toBe(before.ino);
        expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    });

    it.each(['{"privateFixture":"preserve",', "null", "[]", '{"permissions":null}', '{"permissions":[]}'])("preserves invalid settings without a partial publication: %s", bytes => {
        const directory = join(mockProfilesDir, "work", "claude"), file = join(directory, "settings.json");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        writeFileSync(file, bytes, {mode: 0o600});
        expect(() => ensureClaudePermissionDefaults(directory)).toThrow(/preserved/);
        expect(readFileSync(file, "utf8")).toBe(bytes);
        expect(readdirSync(directory)).toEqual(["settings.json"]);
    });

    it.skipIf(process.platform === "win32")("preserves a settings symlink and its target", () => {
        const directory = join(mockProfilesDir, "work", "claude"), target = join(mockRoot, "unselected-settings.json");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        writeFileSync(target, '{"keep":true}', {mode: 0o600});
        symlinkSync(target, join(directory, "settings.json"));
        expect(() => ensureClaudePermissionDefaults(directory)).toThrow(/Unsafe CCC Claude settings file/);
        expect(readFileSync(target, "utf8")).toBe('{"keep":true}');
    });

    it("preserves hard-linked settings and their other name", () => {
        const directory = join(mockProfilesDir, "work", "claude"), target = join(mockRoot, "linked-settings.json");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        writeFileSync(target, '{"keep":"linked"}', {mode: 0o600});
        linkSync(target, join(directory, "settings.json"));
        expect(() => ensureClaudePermissionDefaults(directory)).toThrow(/Unsafe CCC Claude settings file/);
        expect(readFileSync(target, "utf8")).toBe('{"keep":"linked"}');
    });

    it.skipIf(process.platform === "win32")("refuses a linked selected directory before writing outside it", () => {
        const directory = join(mockProfilesDir, "work", "claude"), outside = join(mockRoot, "outside-claude");
        mkdirSync(join(mockProfilesDir, "work"), {recursive: true, mode: 0o700});
        mkdirSync(outside, {mode: 0o700});
        symlinkSync(outside, directory);
        expect(() => ensureClaudePermissionDefaults(directory)).toThrow(/Unsafe CCC Claude settings directory/);
        expect(readdirSync(outside)).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("refuses writable-by-other settings without changing its bytes", () => {
        const directory = join(mockProfilesDir, "work", "claude"), file = join(directory, "settings.json");
        mkdirSync(directory, {recursive: true, mode: 0o700});
        writeFileSync(file, '{"keep":"unsafe-mode"}'); chmodSync(file, 0o666);
        expect(() => ensureClaudePermissionDefaults(directory)).toThrow(/Unsafe CCC Claude settings file/);
        expect(readFileSync(file, "utf8")).toBe('{"keep":"unsafe-mode"}');
    });
});
