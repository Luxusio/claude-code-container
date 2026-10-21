import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", homeReads: 0 }));
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(),
    homedir: () => {
        fixture.homeReads += 1;
        return fixture.home;
    },
}));

const detect = await import("../../tool-detect.js");
const registry = await import("../../tool-registry.js");
const originalTool = process.env.CCC_TOOL;
let root = "";

function cccDir(): string {
    return join(fixture.home, ".ccc");
}

function configPath(): string {
    return join(cccDir(), "config.json");
}

describe("tool preference compatibility facade", () => {
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-tool-preferences-"));
    });

    beforeEach(() => {
        fixture.home = mkdtempSync(join(root, "home-"));
        delete process.env.CCC_TOOL;
    });

    afterEach(() => {
        if (originalTool === undefined) delete process.env.CCC_TOOL;
        else process.env.CCC_TOOL = originalTool;
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("defaults to claude without creating any home state", () => {
        expect(detect.getDefaultToolPreference()).toBeNull();
        expect(detect.resolveTool({})).toBe(registry.getDefaultTool());
        expect(existsSync(cccDir())).toBe(false);
    });

    it("saves through the real config file and preserves other keys", () => {
        mkdirSync(cccDir(), { recursive: true });
        writeFileSync(configPath(), JSON.stringify({ remote: { abc: { host: "h", path: "/p" } }, other: [1, 2], defaultTool: "claude" }));

        detect.setDefaultToolPreference("codex");

        expect(JSON.parse(readFileSync(configPath(), "utf-8"))).toEqual({
            remote: { abc: { host: "h", path: "/p" } }, other: [1, 2], defaultTool: "codex",
        });
        if (process.platform !== "win32") expect(statSync(configPath()).mode & 0o777).toBe(0o600);
        expect(readdirSync(cccDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
        expect(detect.getDefaultToolPreference()).toBe("codex");
        expect(detect.resolveTool({})).toBe(registry.getToolByName("codex"));
    });

    it("creates the config on first save", () => {
        detect.setDefaultToolPreference("gemini");
        expect(JSON.parse(readFileSync(configPath(), "utf-8"))).toEqual({ defaultTool: "gemini" });
        if (process.platform !== "win32") expect(statSync(cccDir()).mode & 0o777).toBe(0o700);
    });

    it("refuses to overwrite an unparseable config and leaves its bytes", () => {
        mkdirSync(cccDir(), { recursive: true });
        writeFileSync(configPath(), "{ not json");

        expect(() => detect.setDefaultToolPreference("codex")).toThrow(/is not a valid JSON object; fix or remove it/);
        expect(readFileSync(configPath(), "utf-8")).toBe("{ not json");
        expect(readdirSync(cccDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
        expect(detect.getDefaultToolPreference()).toBeNull();
        expect(detect.resolveTool({})).toBe(registry.getDefaultTool());
    });

    it("CCC_TOOL wins over a saved preference, unknown values fall through", () => {
        detect.setDefaultToolPreference("codex");
        expect(detect.resolveTool({ CCC_TOOL: "opencode" })).toBe(registry.getToolByName("opencode"));
        expect(detect.resolveTool({ CCC_TOOL: "unknown-xyz" })).toBe(registry.getToolByName("codex"));
        process.env.CCC_TOOL = "gemini";
        expect(detect.resolveTool(process.env)).toBe(registry.getToolByName("gemini"));
    });

    it("a valid CCC_TOOL does not locate or read the config", () => {
        detect.setDefaultToolPreference("codex");
        fixture.homeReads = 0;
        expect(detect.resolveTool({ CCC_TOOL: "gemini" })).toBe(registry.getToolByName("gemini"));
        expect(fixture.homeReads).toBe(0);
        expect(detect.resolveTool({ CCC_TOOL: "unknown-xyz" })).toBe(registry.getToolByName("codex"));
        expect(fixture.homeReads).toBeGreaterThan(0);
    });

    it("reads CCC_TOOL from the supplied environment exactly once", () => {
        let reads = 0;
        const env = Object.defineProperty({} as Record<string, string | undefined>, "CCC_TOOL", {
            enumerable: true,
            get: () => { reads += 1; return "opencode"; },
        });
        expect(detect.resolveTool(env)).toBe(registry.getToolByName("opencode"));
        expect(reads).toBe(1);
    });

    it("an untyped missing environment still fails before any config read", () => {
        fixture.homeReads = 0;
        expect(() => detect.resolveTool(undefined as unknown as Record<string, string | undefined>)).toThrow(TypeError);
        expect(fixture.homeReads).toBe(0);
    });

    it("an unknown saved value or non-string falls back to the default tool", () => {
        detect.setDefaultToolPreference("unknown-xyz");
        expect(detect.getDefaultToolPreference()).toBe("unknown-xyz");
        expect(detect.resolveTool({})).toBe(registry.getDefaultTool());
        writeFileSync(configPath(), JSON.stringify({ defaultTool: 42 }));
        expect(detect.getDefaultToolPreference()).toBeNull();
    });

    it("importing the facade touches no adapter binding or home", async () => {
        vi.resetModules();
        const accessed: string[] = [];
        const poisoned = (module: string, names: string[]) => Object.defineProperties({}, Object.fromEntries(names.map(name => [name, {
            enumerable: true,
            get() {
                accessed.push(`${module}.${name}`);
                return () => { throw new Error(`adapter ${module}.${name} called`); };
            },
        }])));
        vi.doMock("../../home-layout.js", () => poisoned("home-layout", ["readCccConfig", "updateCccConfig"]));
        vi.doMock("../../tool-registry.js", () => poisoned("tool-registry", ["getToolByName", "getDefaultTool"]));
        fixture.homeReads = 0;
        try {
            const isolated = await import("../../tool-detect.js");
            expect(accessed).toEqual([]);
            expect(fixture.homeReads).toBe(0);
            expect(() => isolated.getDefaultToolPreference()).toThrow("adapter home-layout.readCccConfig called");
            expect(accessed).toEqual(["home-layout.readCccConfig"]);
        } finally {
            vi.doUnmock("../../home-layout.js");
            vi.doUnmock("../../tool-registry.js");
            vi.resetModules();
        }
    });
});
