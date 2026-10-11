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
        probeLauncher: vi.fn<RequestedToolSetupPorts["probeLauncher"]>(() => ({ status: 0 })),
        ensureCodexSandbox: vi.fn<RequestedToolSetupPorts["ensureCodexSandbox"]>(() => undefined),
    };
}

describe("requested tool setup", () => {
    it("prepares Claude's launcher and verifies its installed path", () => {
        const bindings = ports();
        expect(createRequestedToolSetup(bindings).ensure("target", tool("claude"))).toBeUndefined();
        expect(bindings.ensureClaudeLauncher).toHaveBeenCalledWith("target");
        expect(bindings.probeLauncher).toHaveBeenCalledWith("target", CLAUDE_BIN_PATH);
        expect(bindings.ensureNpmTool).not.toHaveBeenCalled();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it("prepares Codex, verifies readiness and establishes its sandbox", () => {
        const bindings = ports(), codex = tool("codex");
        bindings.probeLauncher.mockImplementation(() => {
            expect(bindings.ensureNpmTool).toHaveBeenCalledWith("target", codex);
            return { status: 0 };
        });
        bindings.ensureCodexSandbox.mockImplementation(() => {
            expect(bindings.probeLauncher).toHaveBeenCalledWith("target", "/home/ccc/.local/bin/codex");
            return undefined;
        });
        createRequestedToolSetup(bindings).ensure("target", codex);
        expect(bindings.ensureCodexSandbox).toHaveBeenCalledWith("target");
    });

    it.each([
        { observation: { status: 1 }, message: "Requested tool codex is unavailable after setup" },
        { observation: { status: 124 }, message: "Requested tool codex is unavailable after setup" },
        { observation: { status: null, error: { code: "ETIMEDOUT" } }, message: "Requested tool codex readiness check timed out" },
        { observation: { status: null, error: { code: "EIO" } }, message: "Requested tool codex is unavailable after setup" },
    ])("blocks sandbox setup after failed readiness: $message", ({ observation, message }) => {
        const bindings = ports(); bindings.probeLauncher.mockReturnValue(observation);
        expect(() => createRequestedToolSetup(bindings).ensure("target", tool("codex"))).toThrow(message);
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it.each(["claude", "codex"])("propagates %s installer failure without probing or sandbox effects", name => {
        const bindings = ports(), failure = new Error("installation failed");
        const fail = () => { throw failure; };
        if (name === "claude") bindings.ensureClaudeLauncher.mockImplementation(fail);
        else bindings.ensureNpmTool.mockImplementation(fail);
        expect(() => createRequestedToolSetup(bindings).ensure("target", tool(name))).toThrow(failure);
        expect(bindings.probeLauncher).not.toHaveBeenCalled();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });

    it("propagates a native probe exception without establishing the sandbox", () => {
        const bindings = ports(); bindings.probeLauncher.mockImplementation(() => { throw new Error("probe failed"); });
        expect(() => createRequestedToolSetup(bindings).ensure("target", tool("codex"))).toThrow("probe failed");
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });
});
