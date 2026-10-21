import type { ToolDefinition } from "../domain/tool-registry.js";

export interface RequestedToolSetupPorts {
    ensureClaudeLauncher(target: string): undefined;
    ensureNpmTool(target: string, originalTool: ToolDefinition): undefined;
    ensureLauncherReady(target: string, path: string, originalTool: ToolDefinition): undefined;
    ensureCodexSandbox(target: string): undefined;
}
