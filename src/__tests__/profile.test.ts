import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
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
    loadProfileEnv,
    listProfiles,
    profileExists,
    createProfile,
    removeProfile,
    getProfileInfo,
    isSensitiveKey,
    maskValue,
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
        // first char + 63 more = 64 total
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

describe("loadProfileEnv", () => {
    let profileDir: string;

    beforeEach(() => {
        profileDir = mkdtempSync(join(tmpdir(), "ccc-test-env-"));
    });

    afterEach(() => {
        rmSync(profileDir, { recursive: true, force: true });
    });

    function writeEnvFile(content: string) {
        writeFileSync(join(profileDir, "env"), content, "utf-8");
    }

    it("parses KEY=VALUE pairs", () => {
        writeEnvFile("FOO=bar\nBAZ=qux\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("ignores comment lines starting with #", () => {
        writeEnvFile("# this is a comment\nFOO=bar\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar" });
    });

    it("ignores blank lines", () => {
        writeEnvFile("\n\nFOO=bar\n\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar" });
    });

    it("splits on first = only (value can contain =)", () => {
        writeEnvFile("URL=http://example.com?a=1&b=2\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ URL: "http://example.com?a=1&b=2" });
    });

    it("strips double quotes from value", () => {
        writeEnvFile('FOO="bar baz"\n');
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar baz" });
    });

    it("strips single quotes from value", () => {
        writeEnvFile("FOO='bar baz'\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar baz" });
    });

    it("strips export prefix", () => {
        writeEnvFile("export FOO=bar\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar" });
    });

    it("last duplicate key wins", () => {
        writeEnvFile("FOO=first\nFOO=second\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "second" });
    });

    it("handles KEY= (empty value)", () => {
        writeEnvFile("FOO=\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "" });
    });

    it("skips lines with no = sign", () => {
        writeEnvFile("NOVALUE\nFOO=bar\n");
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({ FOO: "bar" });
    });

    it("returns empty object when env file does not exist", () => {
        const env = loadProfileEnv(profileDir);
        expect(env).toEqual({});
    });
});

describe("listProfiles / profileExists / createProfile / removeProfile", () => {
    beforeEach(() => {
        // Clean mockProfilesDir before each test
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

    it("createProfile creates profile directory structure", () => {
        createProfile("work", "anthropic");
        expect(existsSync(join(mockProfilesDir, "work"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "claude"))).toBe(true);
        expect(existsSync(join(mockProfilesDir, "work", "env"))).toBe(true);
    });

    it("profileExists returns true after createProfile", () => {
        createProfile("myprofile", "anthropic");
        expect(profileExists("myprofile")).toBe(true);
    });

    it("listProfiles returns created profiles", () => {
        createProfile("alpha", "anthropic");
        createProfile("beta", "bedrock");
        const profiles = listProfiles();
        expect(profiles).toContain("alpha");
        expect(profiles).toContain("beta");
    });

    it("removeProfile deletes profile directory", () => {
        createProfile("todelete", "anthropic");
        expect(profileExists("todelete")).toBe(true);
        removeProfile("todelete");
        expect(profileExists("todelete")).toBe(false);
    });

    it("listProfiles does not include removed profiles", () => {
        createProfile("keep", "anthropic");
        createProfile("remove", "anthropic");
        removeProfile("remove");
        const profiles = listProfiles();
        expect(profiles).toContain("keep");
        expect(profiles).not.toContain("remove");
    });

    it("anthropic env template contains ANTHROPIC_API_KEY", () => {
        createProfile("anthropic-test", "anthropic");
        const info = getProfileInfo("anthropic-test");
        expect(info.type).toBe("anthropic");
        const envContent = require("fs").readFileSync(
            join(mockProfilesDir, "anthropic-test", "env"),
            "utf-8"
        );
        expect(envContent).toContain("ANTHROPIC_API_KEY");
    });

    it("bedrock env template contains CLAUDE_CODE_USE_BEDROCK and AWS keys", () => {
        createProfile("bedrock-test", "bedrock");
        const envContent = require("fs").readFileSync(
            join(mockProfilesDir, "bedrock-test", "env"),
            "utf-8"
        );
        expect(envContent).toContain("CLAUDE_CODE_USE_BEDROCK=1");
        expect(envContent).toContain("AWS_ACCESS_KEY_ID");
        expect(envContent).toContain("AWS_SECRET_ACCESS_KEY");
        expect(envContent).toContain("AWS_REGION=us-east-1");
    });

    it("vertex env template contains CLAUDE_CODE_USE_VERTEX and vertex config", () => {
        createProfile("vertex-test", "vertex");
        const envContent = require("fs").readFileSync(
            join(mockProfilesDir, "vertex-test", "env"),
            "utf-8"
        );
        expect(envContent).toContain("CLAUDE_CODE_USE_VERTEX=1");
        expect(envContent).toContain("CLOUD_ML_REGION=us-east5");
        expect(envContent).toContain("ANTHROPIC_VERTEX_PROJECT_ID=my-project");
    });

    it("custom env template contains ANTHROPIC_BASE_URL and dummy key", () => {
        createProfile("custom-test", "custom");
        const envContent = require("fs").readFileSync(
            join(mockProfilesDir, "custom-test", "env"),
            "utf-8"
        );
        expect(envContent).toContain("ANTHROPIC_BASE_URL=");
        expect(envContent).toContain("ANTHROPIC_API_KEY=dummy-key-for-local");
    });
});

describe("getProfileInfo", () => {
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

    it("returns type from profile info", () => {
        createProfile("info-test", "bedrock");
        const info = getProfileInfo("info-test");
        expect(info.type).toBe("bedrock");
    });

    it("returns parsed env from profile info", () => {
        createProfile("env-test", "anthropic");
        // Overwrite env with known content
        writeFileSync(join(mockProfilesDir, "env-test", "env"), "MY_KEY=my_value\n");
        const info = getProfileInfo("env-test");
        expect(info.env).toHaveProperty("MY_KEY", "my_value");
    });

    it("throws for nonexistent profile", () => {
        expect(() => getProfileInfo("ghost")).toThrow();
    });
});

describe("isSensitiveKey", () => {
    it("detects KEY in key name", () => {
        expect(isSensitiveKey("ANTHROPIC_API_KEY")).toBe(true);
    });

    it("detects SECRET in key name", () => {
        expect(isSensitiveKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    });

    it("detects TOKEN in key name", () => {
        expect(isSensitiveKey("SOME_TOKEN")).toBe(true);
    });

    it("detects PASSWORD in key name", () => {
        expect(isSensitiveKey("DB_PASSWORD")).toBe(true);
    });

    it("detects CREDENTIAL in key name", () => {
        expect(isSensitiveKey("GOOGLE_CREDENTIAL")).toBe(true);
    });

    it("returns false for non-sensitive key", () => {
        expect(isSensitiveKey("FOO")).toBe(false);
    });

    it("returns false for REGION", () => {
        expect(isSensitiveKey("REGION")).toBe(false);
    });

    it("is case-insensitive (lowercase key)", () => {
        expect(isSensitiveKey("anthropic_api_key")).toBe(true);
    });
});

describe("maskValue", () => {
    it("masks long API key with first 3 + *** + last 3", () => {
        expect(maskValue("sk-ant-abcdef123456")).toBe("sk-***456");
    });

    it("masks short value (≤8 chars) as *****", () => {
        expect(maskValue("short")).toBe("*****");
    });

    it("masks empty string as *****", () => {
        expect(maskValue("")).toBe("*****");
    });

    it("masks exactly 8 chars as *****", () => {
        expect(maskValue("12345678")).toBe("*****");
    });

    it("masks 9 chars with first 3 + *** + last 3", () => {
        expect(maskValue("123456789")).toBe("123***789");
    });
});

describe("showProfile masking via getProfileInfo", () => {
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

    it("sensitive keys get masked, non-sensitive shown as-is", () => {
        createProfile("mask-test", "anthropic");
        writeFileSync(
            join(mockProfilesDir, "mask-test", "env"),
            "ANTHROPIC_API_KEY=sk-ant-abcdef123456\nAWS_REGION=us-east-1\n"
        );
        const info = getProfileInfo("mask-test");
        const masked = Object.fromEntries(
            Object.entries(info.env).map(([k, v]) => [k, isSensitiveKey(k) ? maskValue(v) : v])
        );
        expect(masked["ANTHROPIC_API_KEY"]).toBe("sk-***456");
        expect(masked["AWS_REGION"]).toBe("us-east-1");
    });
});
