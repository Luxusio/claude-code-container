// src/container-setup.ts - In-container setup and binary management
//
// Extracted from index.ts for separation of concerns.
// Contains: claude binary caching, npm tools installation, mise shim detection.

import { spawnSync } from "child_process";
import { getNpmTools, getToolByName, type ToolDefinition } from "./tool-registry.js";

// Claude binary persist path inside the mise volume
export const CLAUDE_PERSIST_DIR = "/home/ccc/.local/share/mise/.claude-bin";
export const CLAUDE_EXECUTABLE = "claude";
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
 * 2. If claude exists elsewhere on PATH → copy it into the fixed path + cache
 * 3. If volume has a valid cached copy → restore it to the fixed path
 * 4. Otherwise → fresh install, then copy into fixed path + cache
 *
 * Uses a single docker exec to probe both paths, reducing round-trips
 * from 3-5 to 1 for the common happy path.
 */
export function ensureClaudeInContainer(containerName: string): void {
    // Single docker exec: check main path, fall through to cache, handle cleanup
    const probeScript = `
BIN="${CLAUDE_BIN_PATH}"
CACHE="${CLAUDE_PERSIST_DIR}/claude"
FOUND="$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)"
is_shim() { head -c 500 "$1" 2>/dev/null | grep -q mise; }
is_claude() { "$1" --version 2>&1 | grep -qi claude; }

if [ -x "$BIN" ]; then
  if is_shim "$BIN"; then
    rm -f "$BIN"
  elif is_claude "$BIN"; then
    echo VALID; exit 0
  else
    rm -f "$BIN"
  fi
fi
if [ -n "$FOUND" ] && [ -x "$FOUND" ]; then
  if is_shim "$FOUND"; then
    :
  elif is_claude "$FOUND"; then
    mkdir -p "$(dirname "$BIN")" "$(dirname "$CACHE")" && cp -L "$FOUND" "$CACHE" && cp -L "$CACHE" "$BIN"
    echo VALID; exit 0
  fi
fi
if [ -x "$CACHE" ]; then
  if is_shim "$CACHE"; then
    rm -f "$CACHE"
  elif is_claude "$CACHE"; then
    mkdir -p "$(dirname "$BIN")" && cp -L "$CACHE" "$BIN"
    echo RESTORED; exit 0
  else
    rm -f "$CACHE"
  fi
fi
echo INSTALL`.trim();

    const result = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", probeScript],
        { encoding: "utf-8", timeout: 15000 },
    );
    const status = (result.stdout ?? "").trim();

    if (status === "VALID") return;

    if (status === "RESTORED") {
        console.log("Restored claude from cache.");
        return;
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
            `${getToolByName("claude")!.installCommand} && ACTUAL="$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)" && [ -n "$ACTUAL" ] && [ -x "$ACTUAL" ] && mkdir -p ${CLAUDE_PERSIST_DIR} "$(dirname ${CLAUDE_BIN_PATH})" && cp -L "$ACTUAL" ${CLAUDE_PERSIST_DIR}/claude && cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`,
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

    // Single docker exec to check all tools at once (instead of one per tool)
    const checkResult = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c",
         tools.map((t) => `[ -x /home/ccc/.local/bin/${t.cmd} ] || echo ${t.cmd}`).join("; ")],
        { encoding: "utf-8" },
    );
    const missingCmds = new Set((checkResult.stdout ?? "").trim().split("\n").filter(Boolean));
    const missing = tools.filter((t) => missingCmds.has(t.cmd));

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
 * Save claude binary back to volume and refresh the fixed install path.
 */
export function saveClaudeBinaryToVolume(containerName: string): void {
    const resolveResult = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true`],
        { encoding: "utf-8", timeout: 10000 },
    );
    const actualPath = (resolveResult.stdout ?? "").trim() || CLAUDE_BIN_PATH;

    if (isMiseShim(containerName, actualPath)) {
        return;
    }
    if (!isValidClaudeBinary(containerName, actualPath)) {
        return;
    }
    spawnSync(
        "docker",
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `mkdir -p ${CLAUDE_PERSIST_DIR} "$(dirname ${CLAUDE_BIN_PATH})" && [ -x '${actualPath.replace(/'/g, "'\\''")}' ] && cp -L '${actualPath.replace(/'/g, "'\\''")}' ${CLAUDE_PERSIST_DIR}/claude && cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH} || true`,
        ],
        { stdio: "ignore" },
    );
}

/**
 * Ensure uv is available globally in the container via mise.
 * uv is used by hooks (e.g. ~/.claude/hooks/langfuse-claudecode) which run
 * without bash profile activation — they rely on the global mise shim.
 */
export function ensureUvAvailable(containerName: string): void {
    const checkResult = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c",
         "~/.local/bin/mise ls --global 2>/dev/null | grep -q '^uv '"],
        { encoding: "utf-8" },
    );
    if (checkResult.status === 0) return;

    spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c",
         "~/.local/bin/mise use -g uv@latest"],
        { stdio: "inherit" },
    );
}
