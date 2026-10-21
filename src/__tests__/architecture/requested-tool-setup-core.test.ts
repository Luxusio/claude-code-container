import { describe, expect, it, vi } from "vitest";
import { createRequestedToolSetup } from "../../application/requested-tool-setup.js";
import { CLAUDE_BIN_PATH } from "../../domain/tool-layout.js";
import type { ToolDefinition } from "../../domain/tool-registry.js";
import type { RequestedToolSetupPorts } from "../../ports/requested-tool-setup.js";

function tool(name: string): ToolDefinition {
    return { name, binary: name, displayName: name, defaultFlags: [], credentialMounts: [],
        needsNodeRuntime: false, updateCommand: [], installCommand: "unused" };
}
function ports() {
    return {
        ensureClaudeLauncher: vi.fn<RequestedToolSetupPorts["ensureClaudeLauncher"]>(() => undefined),
        ensureNpmTool: vi.fn<RequestedToolSetupPorts["ensureNpmTool"]>(() => undefined),
        ensureLauncherReady: vi.fn<RequestedToolSetupPorts["ensureLauncherReady"]>(() => undefined),
        ensureCodexSandbox: vi.fn<RequestedToolSetupPorts["ensureCodexSandbox"]>(() => undefined),
    };
}

describe("requested tool setup", () => {
    it("prepares Claude's launcher and verifies its installed path", () => {
        const bindings = ports(), claude = tool("claude");
        claude.binary = "custom-claude";
        bindings.ensureLauncherReady.mockImplementation(() => {
            expect(bindings.ensureClaudeLauncher).toHaveBeenCalledExactlyOnceWith("target");
            return undefined;
        });
        expect(createRequestedToolSetup(bindings).ensure("target", claude)).toBeUndefined();
        expect(bindings.ensureLauncherReady).toHaveBeenCalledExactlyOnceWith("target", CLAUDE_BIN_PATH, claude);
        expect(bindings.ensureLauncherReady.mock.calls[0][2]).toBe(claude);
        expect(bindings.ensureNpmTool).not.toHaveBeenCalled();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it("prepares Codex, verifies readiness and establishes its sandbox", () => {
        const bindings = ports(), codex = tool("codex");
        bindings.ensureLauncherReady.mockImplementation(() => {
            expect(bindings.ensureNpmTool).toHaveBeenCalledExactlyOnceWith("target", codex);
            expect(bindings.ensureNpmTool.mock.calls[0][1]).toBe(codex);
            expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
            return undefined;
        });
        bindings.ensureCodexSandbox.mockImplementation(() => {
            expect(bindings.ensureLauncherReady).toHaveBeenCalledExactlyOnceWith("target", "/home/ccc/.local/bin/codex", codex);
            expect(bindings.ensureLauncherReady.mock.calls[0][2]).toBe(codex);
            return undefined;
        });
        expect(createRequestedToolSetup(bindings).ensure("target", codex)).toBeUndefined();
        expect(bindings.ensureCodexSandbox).toHaveBeenCalledExactlyOnceWith("target");
    });

    it.each(["custom-codex", ""])("uses configured binary %j with the tool-name fallback", binary => {
        const bindings = ports(), codex = tool("codex"); codex.binary = binary;
        createRequestedToolSetup(bindings).ensure("target", codex);
        expect(bindings.ensureLauncherReady).toHaveBeenCalledExactlyOnceWith("target", `/home/ccc/.local/bin/${binary || "codex"}`, codex);
    });

    it.each([new Error("readiness failed"), { failure: "opaque readiness value" }])("propagates readiness failure unchanged and blocks the sandbox (%j)", failure => {
        const bindings = ports();
        bindings.ensureLauncherReady.mockImplementation(() => { throw failure; });
        let caught: unknown;
        try { createRequestedToolSetup(bindings).ensure("target", tool("codex")); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(bindings.ensureLauncherReady).toHaveBeenCalledOnce();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it.each(["claude", "codex"])("propagates %s installer failure without probing or sandbox effects", name => {
        const bindings = ports(), failure = new Error("installation failed");
        const fail = () => { throw failure; };
        if (name === "claude") bindings.ensureClaudeLauncher.mockImplementation(fail);
        else bindings.ensureNpmTool.mockImplementation(fail);
        let caught: unknown;
        try { createRequestedToolSetup(bindings).ensure("target", tool(name)); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(bindings.ensureLauncherReady).not.toHaveBeenCalled();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it("propagates sandbox failure unchanged after one successful readiness effect", () => {
        const bindings = ports(), failure = new Error("sandbox failed");
        bindings.ensureCodexSandbox.mockImplementation(() => { throw failure; });
        let caught: unknown;
        try { createRequestedToolSetup(bindings).ensure("target", tool("codex")); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(bindings.ensureLauncherReady).toHaveBeenCalledOnce();
        expect(bindings.ensureCodexSandbox).toHaveBeenCalledOnce();
    });
});
