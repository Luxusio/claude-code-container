import type { ToolDefinition } from "../domain/tool-registry.js";

export interface RequestedToolSetupPorts {
    ensureClaudeLauncher(target: string): undefined;
    ensureNpmTool(target: string, originalTool: ToolDefinition): undefined;
    probeLauncher(target: string, path: string): { status: number | null; error?: unknown };
    ensureCodexSandbox(target: string): undefined;
}
