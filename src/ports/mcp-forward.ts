import type { McpServerConfig } from "../domain/mcp-forward.js";

export interface McpConfigRegenerationPorts<ClaudeBinding, CodexBinding> {
    readonly resolveClaudeProfile: (profile?: string) => ClaudeBinding;
    readonly readClaudeProfileDocument: (binding: ClaudeBinding) => (() => string) | undefined;
    readonly readHostMcpDocument: () => (() => string) | undefined;
    readonly createManagedMcpServers: () => {chromeDevtools: McpServerConfig; deviceLab: McpServerConfig};
    readonly withCodexProfileLock: <T>(profile: string | undefined, operation: () => T) => T;
    readonly prepareCodexProfile: (profile?: string) => {binding: CodexBinding; existingText: string};
    readonly publishCodexProfile: (binding: CodexBinding, text: string) => undefined;
    readonly publishClaudeProfile: (binding: ClaudeBinding, text: string) => undefined;
}
