import { describe, it, expect } from "vitest";
import {
    getToolByName,
    getDefaultTool,
    getAllTools,
    getAllCredentialMounts,
    type ToolDefinition,
    type CredentialMount,
} from "../tool-registry.js";

// ===========================================================================
// 1. getToolByName
// ===========================================================================
describe("getToolByName", () => {
    it("returns correct tool for 'claude'", () => {
        const tool = getToolByName("claude");
        expect(tool).toBeDefined();
        expect(tool!.name).toBe("claude");
    });

    it("returns correct tool for 'gemini'", () => {
        const tool = getToolByName("gemini");
        expect(tool).toBeDefined();
        expect(tool!.name).toBe("gemini");
    });

    it("returns correct tool for 'codex'", () => {
        const tool = getToolByName("codex");
        expect(tool).toBeDefined();
        expect(tool!.name).toBe("codex");
    });

    it("returns correct tool for 'opencode'", () => {
        const tool = getToolByName("opencode");
        expect(tool).toBeDefined();
        expect(tool!.name).toBe("opencode");
    });

    it("returns undefined for unknown tool", () => {
        expect(getToolByName("unknown-tool")).toBeUndefined();
        expect(getToolByName("")).toBeUndefined();
        expect(getToolByName("CLAUDE")).toBeUndefined();
    });
});

// ===========================================================================
// 2. getDefaultTool
// ===========================================================================
describe("getDefaultTool", () => {
    it("always returns claude", () => {
        const tool = getDefaultTool();
        expect(tool.name).toBe("claude");
    });

    it("returns a ToolDefinition with required fields", () => {
        const tool = getDefaultTool();
        expect(tool.binary).toBeDefined();
        expect(tool.defaultFlags).toBeDefined();
        expect(tool.credentialMounts).toBeDefined();
    });
});

// ===========================================================================
// 3. getAllTools
// ===========================================================================
describe("getAllTools", () => {
    it("returns exactly 4 tools", () => {
        expect(getAllTools()).toHaveLength(4);
    });

    it("includes claude, gemini, codex, opencode", () => {
        const names = getAllTools().map((t) => t.name);
        expect(names).toContain("claude");
        expect(names).toContain("gemini");
        expect(names).toContain("codex");
        expect(names).toContain("opencode");
    });
});

// ===========================================================================
// 4. getAllCredentialMounts
// ===========================================================================
describe("getAllCredentialMounts", () => {
    it("returns all credential mounts from all tools", () => {
        const mounts = getAllCredentialMounts();
        // Each tool has at least 1 mount; total should be sum across all tools
        const expectedTotal = getAllTools().reduce(
            (sum, t) => sum + t.credentialMounts.length,
            0,
        );
        expect(mounts).toHaveLength(expectedTotal);
    });

    it("includes claude credential mounts", () => {
        const mounts = getAllCredentialMounts();
        const containerDirs = mounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.claude");
    });

    it("includes gemini credential mount", () => {
        const mounts = getAllCredentialMounts();
        const containerDirs = mounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.gemini");
    });

    it("includes codex credential mount", () => {
        const mounts = getAllCredentialMounts();
        const containerDirs = mounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.codex");
        expect(containerDirs).toContain("/home/ccc/.omx");
        expect(containerDirs).toContain("/home/ccc/.agents");
    });

    it("includes opencode credential mounts", () => {
        const mounts = getAllCredentialMounts();
        const containerDirs = mounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.local/share/opencode");
        expect(containerDirs).toContain("/home/ccc/.config/opencode");
    });
});

// ===========================================================================
// 6. Tool definition correctness
// ===========================================================================
describe("claude tool definition", () => {
    let tool: ToolDefinition;
    beforeAll(() => { tool = getToolByName("claude")!; });

    it("has a non-empty binary path", () => {
        expect(tool.binary.length).toBeGreaterThan(0);
    });

    it("has defaultFlags including --dangerously-skip-permissions", () => {
        expect(tool.defaultFlags).toContain("--dangerously-skip-permissions");
    });

    it("has needsNodeRuntime true", () => {
        expect(tool.needsNodeRuntime).toBe(true);
    });

    it("has updateCommand", () => {
        expect(tool.updateCommand).toBeDefined();
        expect(tool.updateCommand.length).toBeGreaterThan(0);
    });

    it("has 2 credentialMounts (claude dir + ide dir)", () => {
        expect(tool.credentialMounts).toHaveLength(2);
    });

    it("has displayName 'Claude Code'", () => {
        expect(tool.displayName).toBe("Claude Code");
    });
});

describe("gemini tool definition", () => {
    let tool: ToolDefinition;
    beforeAll(() => { tool = getToolByName("gemini")!; });

    it("has binary 'gemini'", () => {
        expect(tool.binary).toBe("gemini");
    });

    it("has needsNodeRuntime false", () => {
        expect(tool.needsNodeRuntime).toBe(false);
    });

    it("has 1 credentialMount", () => {
        expect(tool.credentialMounts).toHaveLength(1);
    });

    it("has containerDir /home/ccc/.gemini", () => {
        expect(tool.credentialMounts[0].containerDir).toBe("/home/ccc/.gemini");
    });

    it("has hostDir '.gemini'", () => {
        expect(tool.credentialMounts[0].hostDir).toBe(".gemini");
    });
});

describe("codex tool definition", () => {
    let tool: ToolDefinition;
    beforeAll(() => { tool = getToolByName("codex")!; });

    it("has binary 'codex'", () => {
        expect(tool.binary).toBe("codex");
    });

    it("has needsNodeRuntime false", () => {
        expect(tool.needsNodeRuntime).toBe(false);
    });

    it("has 3 credentialMounts", () => {
        expect(tool.credentialMounts).toHaveLength(3);
    });

    it("has containerDirs for codex config, omx agents, and user skills", () => {
        const containerDirs = tool.credentialMounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.codex");
        expect(containerDirs).toContain("/home/ccc/.omx");
        expect(containerDirs).toContain("/home/ccc/.agents");
    });
});

describe("opencode tool definition", () => {
    let tool: ToolDefinition;
    beforeAll(() => { tool = getToolByName("opencode")!; });

    it("has binary 'opencode'", () => {
        expect(tool.binary).toBe("opencode");
    });

    it("has needsNodeRuntime false", () => {
        expect(tool.needsNodeRuntime).toBe(false);
    });

    it("has 2 credentialMounts", () => {
        expect(tool.credentialMounts).toHaveLength(2);
    });

    it("has containerDirs for .local/share/opencode and .config/opencode", () => {
        const containerDirs = tool.credentialMounts.map((m) => m.containerDir);
        expect(containerDirs).toContain("/home/ccc/.local/share/opencode");
        expect(containerDirs).toContain("/home/ccc/.config/opencode");
    });
});
