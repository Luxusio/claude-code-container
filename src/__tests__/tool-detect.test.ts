import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";

// Mock fs before importing
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    };
});

// Import AFTER mocks
const { getDefaultToolPreference, setDefaultToolPreference, resolveTool } = await import("../tool-detect.js");

const DATA_DIR = join(homedir(), ".ccc");
const CONFIG_FILE = join(DATA_DIR, "config.json");

describe("tool-detect.ts", () => {
    beforeEach(() => {
        mockExistsSync.mockReset();
        mockReadFileSync.mockReset();
        mockWriteFileSync.mockReset();
        mockMkdirSync.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("getDefaultToolPreference", () => {
        it("returns null when config file does not exist", () => {
            mockExistsSync.mockReturnValue(false);
            expect(getDefaultToolPreference()).toBeNull();
        });

        it("returns null when config file exists but has no defaultTool key", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({}));
            expect(getDefaultToolPreference()).toBeNull();
        });

        it("returns null when config file has invalid JSON", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("not-json{{{");
            expect(getDefaultToolPreference()).toBeNull();
        });

        it("returns defaultTool value when present in config", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "gemini" }));
            expect(getDefaultToolPreference()).toBe("gemini");
        });

        it("reads from the correct config file path", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "claude" }));
            getDefaultToolPreference();
            expect(mockExistsSync).toHaveBeenCalledWith(CONFIG_FILE);
            expect(mockReadFileSync).toHaveBeenCalledWith(CONFIG_FILE, "utf-8");
        });

        it("returns null when defaultTool is explicitly null in config", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: null }));
            expect(getDefaultToolPreference()).toBeNull();
        });
    });

    describe("setDefaultToolPreference", () => {
        it("creates config dir and writes config when dir does not exist", () => {
            mockExistsSync.mockReturnValue(false);
            mockReadFileSync.mockReturnValue(JSON.stringify({}));

            setDefaultToolPreference("gemini");

            expect(mockMkdirSync).toHaveBeenCalledWith(DATA_DIR, { recursive: true });
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                CONFIG_FILE,
                JSON.stringify({ defaultTool: "gemini" }, null, 2),
                "utf-8",
            );
        });

        it("writes config without creating dir when dir exists", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({}));

            setDefaultToolPreference("codex");

            expect(mockMkdirSync).not.toHaveBeenCalled();
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                CONFIG_FILE,
                JSON.stringify({ defaultTool: "codex" }, null, 2),
                "utf-8",
            );
        });

        it("preserves existing config keys when writing", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ someOtherKey: "value", defaultTool: "claude" }));

            setDefaultToolPreference("gemini");

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
            expect(written.someOtherKey).toBe("value");
            expect(written.defaultTool).toBe("gemini");
        });

        it("writes config file when existing config has invalid JSON (starts fresh)", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("bad-json");

            setDefaultToolPreference("opencode");

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                CONFIG_FILE,
                JSON.stringify({ defaultTool: "opencode" }, null, 2),
                "utf-8",
            );
        });
    });

    describe("resolveTool", () => {
        it("returns claude (default) when no env var and no saved preference", () => {
            mockExistsSync.mockReturnValue(false);
            const tool = resolveTool({});
            expect(tool.name).toBe("claude");
        });

        it("returns tool specified by CCC_TOOL env var (Layer 1)", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "codex" }));
            const tool = resolveTool({ CCC_TOOL: "gemini" });
            expect(tool.name).toBe("gemini");
        });

        it("CCC_TOOL env var takes precedence over saved preference", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "codex" }));
            const tool = resolveTool({ CCC_TOOL: "opencode" });
            expect(tool.name).toBe("opencode");
        });

        it("returns saved preference when no CCC_TOOL env (Layer 2)", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "codex" }));
            const tool = resolveTool({});
            expect(tool.name).toBe("codex");
        });

        it("falls back to claude when CCC_TOOL is unknown tool name", () => {
            mockExistsSync.mockReturnValue(false);
            const tool = resolveTool({ CCC_TOOL: "unknown-tool-xyz" });
            expect(tool.name).toBe("claude");
        });

        it("falls back to saved preference when CCC_TOOL is empty string", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "gemini" }));
            const tool = resolveTool({ CCC_TOOL: "" });
            expect(tool.name).toBe("gemini");
        });

        it("falls back to claude when saved preference is unknown tool name", () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTool: "unknown-xyz" }));
            const tool = resolveTool({});
            expect(tool.name).toBe("claude");
        });

        it("returns opencode tool correctly", () => {
            mockExistsSync.mockReturnValue(false);
            const tool = resolveTool({ CCC_TOOL: "opencode" });
            expect(tool.name).toBe("opencode");
        });
    });
});
