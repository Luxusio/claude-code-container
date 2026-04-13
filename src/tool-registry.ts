// src/tool-registry.ts - Registry of supported AI coding tools
//
// Defines tool metadata: binary paths, credential mounts, runtime requirements.

import { CLAUDE_BIN_PATH } from "./container-setup.js";

export interface CredentialMount {
    hostDir: string;       // homedir-relative (e.g., ".gemini")
    containerDir: string;  // container absolute (e.g., "/home/ccc/.gemini")
}

export interface ToolDefinition {
    name: string;
    displayName: string;
    binary: string;
    defaultFlags: string[];
    credentialMounts: CredentialMount[];
    needsNodeRuntime: boolean;
    updateCommand: string[];
    installCommand: string;  // shell command to install (e.g. "curl ... | bash" or "npm install -g pkg")
}

const TOOLS: ToolDefinition[] = [
    {
        name: "claude",
        displayName: "Claude Code",
        binary: CLAUDE_BIN_PATH,
        defaultFlags: ["--dangerously-skip-permissions"],
        credentialMounts: [
            { hostDir: ".ccc/claude", containerDir: "/home/ccc/.claude" },
            { hostDir: ".claude/ide", containerDir: "/home/ccc/.claude/ide" },
        ],
        needsNodeRuntime: true,
        updateCommand: ["claude", "update"],
        installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    {
        name: "gemini",
        displayName: "Gemini CLI",
        binary: "gemini",
        defaultFlags: ["--yolo"],
        credentialMounts: [
            { hostDir: ".gemini", containerDir: "/home/ccc/.gemini" },
        ],
        needsNodeRuntime: false,
        updateCommand: ["gemini", "update"],
        installCommand: "npm install -g @google/gemini-cli",
    },
    {
        name: "codex",
        displayName: "Codex",
        binary: "codex",
        defaultFlags: ["--ask-for-approval", "never", "--sandbox", "danger-full-access"],
        credentialMounts: [
            { hostDir: ".codex", containerDir: "/home/ccc/.codex" },
        ],
        needsNodeRuntime: false,
        updateCommand: ["codex", "update"],
        installCommand: "npm install -g @openai/codex",
    },
    {
        name: "opencode",
        displayName: "OpenCode",
        binary: "opencode",
        defaultFlags: ["--policy", "allow"],
        credentialMounts: [
            { hostDir: ".local/share/opencode", containerDir: "/home/ccc/.local/share/opencode" },
            { hostDir: ".config/opencode", containerDir: "/home/ccc/.config/opencode" },
        ],
        needsNodeRuntime: false,
        updateCommand: ["opencode", "update"],
        installCommand: "npm install -g opencode",
    },
];

export function getToolByName(name: string): ToolDefinition | undefined {
    return TOOLS.find((t) => t.name === name);
}

export function getDefaultTool(): ToolDefinition {
    return TOOLS.find((t) => t.name === "claude")!;
}

export function getAllTools(): ToolDefinition[] {
    return TOOLS;
}

export function getAllCredentialMounts(): CredentialMount[] {
    return TOOLS.flatMap((t) => t.credentialMounts);
}

export function getNpmTools(): Array<{ cmd: string; pkg: string }> {
    return TOOLS
        .filter((t) => t.installCommand.startsWith("npm install -g "))
        .map((t) => ({ cmd: t.name, pkg: t.installCommand.replace("npm install -g ", "") }));
}
