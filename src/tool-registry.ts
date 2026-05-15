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
    // Known subcommands of this tool. When the user's first arg matches one,
    // ccc treats the invocation as a subcommand call: defaultFlags are positioned
    // AFTER the subcommand (per-subcommand options, not global), or skipped
    // entirely if the subcommand is listed in `subcommands` but not in
    // `subcommandsAcceptingDefaultFlags`.
    subcommands?: string[];
    // Subset of `subcommands` that accept defaultFlags. Subcommands in
    // `subcommands` but not here will be invoked WITHOUT defaultFlags — needed
    // because e.g. `codex login` rejects `--dangerously-bypass-approvals-and-sandbox`.
    subcommandsAcceptingDefaultFlags?: string[];
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
        defaultFlags: ["--dangerously-bypass-approvals-and-sandbox"],
        // Source: `codex --help` (subcommands list, incl. aliases `e` and `a`).
        subcommands: [
            "exec", "e",
            "review",
            "login", "logout",
            "mcp", "plugin", "mcp-server", "app-server", "remote-control",
            "completion", "update",
            "sandbox", "debug",
            "apply", "a",
            "resume", "fork",
            "cloud",
            "exec-server", "features",
            "help",
        ],
        // Only `exec`, `resume`, and `fork` accept --dangerously-bypass-approvals-and-sandbox.
        // Verified via `codex <sub> --help`. Other subcommands reject the flag.
        subcommandsAcceptingDefaultFlags: ["exec", "e", "resume", "fork"],
        credentialMounts: [
            { hostDir: ".ccc/codex", containerDir: "/home/ccc/.codex" },
            { hostDir: ".omx", containerDir: "/home/ccc/.omx" },
            { hostDir: ".agents", containerDir: "/home/ccc/.agents" },
        ],
        needsNodeRuntime: false,
        updateCommand: ["codex", "update"],
        installCommand: "npm install -g @openai/codex",
    },
    {
        name: "opencode",
        displayName: "OpenCode",
        binary: "opencode",
        defaultFlags: ["--dangerously-skip-permissions"],
        credentialMounts: [
            { hostDir: ".local/share/opencode", containerDir: "/home/ccc/.local/share/opencode" },
            { hostDir: ".config/opencode", containerDir: "/home/ccc/.config/opencode" },
        ],
        needsNodeRuntime: false,
        updateCommand: ["opencode", "update"],
        installCommand: "npm install -g opencode-ai",
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
