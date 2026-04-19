import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

// We need to mock PROFILES_DIR to use a temp dir
const mockProfilesDir = mkdtempSync(join(tmpdir(), "ccc-test-profiles-"));

vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        PROFILES_DIR: mockProfilesDir,
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

    it("listProfiles returns empty array when no profiles exist", () => {
        expect(listProfiles()).toEqual([]);
    });

    it("profileExists returns false for nonexistent profile", () => {
        expect(profileExists("nonexistent")).toBe(false);
    });

    it("createProfile creates profile directory with claude/ and claude.json", () => {
        createProfile("work");
        expect(existsSync(join(mockProfilesDir, "work"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "claude"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "claude.json"))).toBe(true);
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

    it("local-llm has CLAUDE_CODE_ATTRIBUTION_HEADER=0 in env", () => {
        expect(BUILTIN_PROFILES["local-llm"].settings?.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    });
});

describe("isBuiltinProfile", () => {
    it("returns true for local-llm", () => {
        expect(isBuiltinProfile("local-llm")).toBe(true);
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

    it("returns false when profile already exists", () => {
        createProfile("local-llm");
        const created = ensureProfile("local-llm");
        expect(created).toBe(false);
    });

    it("throws for unknown non-builtin profile", () => {
        expect(() => ensureProfile("nonexistent-profile")).toThrow();
    });
});
