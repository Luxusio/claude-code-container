// src/container-setup.ts - In-container setup and binary management
//
// Extracted from index.ts for separation of concerns.
// Contains: claude binary caching, npm tools installation, mise shim detection.

import { spawnSync } from "child_process";
import { getNpmTools, getToolByName, type ToolDefinition } from "./tool-registry.js";

// Claude binary persist path inside the mise volume
export const CLAUDE_PERSIST_DIR = "/home/ccc/.local/share/mise/.claude-bin";
export const CLAUDE_BIN_PATH = "/home/ccc/.local/bin/claude";

/**
 * Check if a file in the container is a mise shim (shell script referencing mise)
 * rather than a real native binary.
 */
export function isMiseShim(containerName: string, path: string): boolean {
    const result = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `head -c 500 '${path.replace(/'/g, "'\\''")}' 2>/dev/null | grep -q mise`],
        { encoding: "utf-8" },
    );
    return result.status === 0;
}

/**
 * Verify the binary at the given path is actually claude by checking --version output.
 * Guards against bun or other binaries accidentally cached at the claude path.
 */
export function isValidClaudeBinary(containerName: string, path: string): boolean {
    const result = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `'${path.replace(/'/g, "'\\''")}' --version 2>&1 | grep -qi claude`],
        { encoding: "utf-8", timeout: 10000 },
    );
    return result.status === 0;
}

/**
 * Ensure claude binary is available in the container.
 * 1. If real claude binary exists at known path → do nothing
 * 2. If volume has a valid cached copy → symlink it
 * 3. Otherwise → fresh install and cache to volume
 *
 * Detects and purges stale mise shims that can masquerade as the binary.
 */
export function ensureClaudeInContainer(containerName: string): void {
    const check = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `test -x ${CLAUDE_BIN_PATH}`],
        { encoding: "utf-8" },
    );
    if (check.status === 0) {
        if (!isMiseShim(containerName, CLAUDE_BIN_PATH)) {
            if (isValidClaudeBinary(containerName, CLAUDE_BIN_PATH)) {
                return;
            }
            console.log("Binary at claude path is not valid claude, removing...");
        } else {
            console.log("Detected stale mise shim at claude path, removing...");
        }
        spawnSync(
            "docker",
            ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_BIN_PATH}`],
            { stdio: "ignore" },
        );
    }

    // Check if volume has cached claude binary
    const volumeCheck = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `test -x ${CLAUDE_PERSIST_DIR}/claude`],
        { encoding: "utf-8" },
    );

    if (volumeCheck.status === 0) {
        if (isMiseShim(containerName, `${CLAUDE_PERSIST_DIR}/claude`)) {
            console.log("Cached claude is a mise shim, purging cache...");
            spawnSync(
                "docker",
                ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_PERSIST_DIR}/claude`],
                { stdio: "ignore" },
            );
        } else if (!isValidClaudeBinary(containerName, `${CLAUDE_PERSIST_DIR}/claude`)) {
            console.log("Cached binary is not valid claude, purging cache...");
            spawnSync(
                "docker",
                ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_PERSIST_DIR}/claude`],
                { stdio: "ignore" },
            );
        } else {
            console.log("Restoring claude from cache...");
            spawnSync(
                "docker",
                [
                    "exec",
                    containerName,
                    "sh",
                    "-c",
                    `mkdir -p $(dirname ${CLAUDE_BIN_PATH}) && ln -sf ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`,
                ],
                { stdio: "inherit" },
            );
            return;
        }
    }

    // Fresh install and save to volume
    console.log("Installing claude (first run)...");
    const installResult = spawnSync(
        "docker",
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `${getToolByName("claude")!.installCommand} && mkdir -p ${CLAUDE_PERSIST_DIR} && cp ${CLAUDE_BIN_PATH} ${CLAUDE_PERSIST_DIR}/claude`,
        ],
        { stdio: "inherit" },
    );
    if (installResult.status !== 0) {
        throw new Error("Failed to install claude in container");
    }
}

/**
 * Ensure all required tools are installed in the container.
 * - Claude: curl install + volume caching (only when activeTool is claude)
 * - npm tools (gemini, codex, opencode): npm install -g from registry
 */
export function ensureTools(containerName: string, activeTool: ToolDefinition): void {
    if (activeTool.name === "claude") {
        ensureClaudeInContainer(containerName);
    }
    ensureNpmTools(containerName);
}

/**
 * Ensure npm-based tools from registry are installed.
 */
function ensureNpmTools(containerName: string): void {
    const tools = getNpmTools();

    const missing = tools.filter((t) => {
        const check = spawnSync(
            "docker",
            ["exec", containerName, "sh", "-c", `test -x /home/ccc/.local/bin/${t.cmd}`],
            { encoding: "utf-8" },
        );
        return check.status !== 0;
    });

    if (missing.length === 0) {
        return;
    }

    const pkgs = missing.map((t) => t.pkg).join(" ");
    console.log(`Installing ${missing.map((t) => t.cmd).join(", ")}...`);

    const cleanupPatterns = missing.map((t) => {
        const name = t.pkg.split("/").pop();
        const scope = t.pkg.includes("/") ? t.pkg.split("/")[0] + "/" : "";
        return `"$gdir/${scope}.${name}-"*`;
    }).join(" ");

    spawnSync(
        "docker",
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            `gdir=$(~/.local/bin/mise exec node@22 -- npm root -g 2>/dev/null) && rm -rf ${cleanupPatterns} 2>/dev/null; true`,
        ],
        { stdio: "ignore" },
    );

    const installResult = spawnSync(
        "docker",
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            `~/.local/bin/mise exec node@22 -- npm install -g ${pkgs}`,
        ],
        { stdio: "inherit" },
    );
    if (installResult.status !== 0) {
        console.warn("Warning: Failed to install some global npm tools (non-fatal)");
        return;
    }

    for (const t of missing) {
        spawnSync(
            "docker",
            [
                "exec", "-w", "/home/ccc", containerName, "sh", "-c",
                `cat > /home/ccc/.local/bin/${t.cmd} << 'WRAPPER'\n#!/bin/sh\nexec ~/.local/bin/mise exec node@22 -- ${t.cmd} "$@"\nWRAPPER\nchmod +x /home/ccc/.local/bin/${t.cmd}`,
            ],
            { stdio: "pipe" },
        );
    }
}

/**
 * Save claude binary back to volume (in case `claude update` replaced the symlink).
 */
export function saveClaudeBinaryToVolume(containerName: string): void {
    if (isMiseShim(containerName, CLAUDE_BIN_PATH)) {
        return;
    }
    if (!isValidClaudeBinary(containerName, CLAUDE_BIN_PATH)) {
        return;
    }
    spawnSync(
        "docker",
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `mkdir -p ${CLAUDE_PERSIST_DIR} && [ -x ${CLAUDE_BIN_PATH} ] && cp -L ${CLAUDE_BIN_PATH} ${CLAUDE_PERSIST_DIR}/claude || true`,
        ],
        { stdio: "ignore" },
    );
}
