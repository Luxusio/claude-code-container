// src/container-setup.ts - In-container setup and binary management
//
// Extracted from index.ts for separation of concerns.
// Contains: claude binary caching, npm tools installation, mise shim detection.

import { spawnSync } from "child_process";
import { getNpmTools, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { runtimeCli } from "./container-runtime.js";

// Claude binary persist path inside the mise volume
export const CLAUDE_PERSIST_DIR = "/home/ccc/.local/share/mise/.claude-bin";
export const CLAUDE_EXECUTABLE = "claude";
export const CLAUDE_BIN_PATH = "/home/ccc/.local/bin/claude";
export const CONTAINER_TOOL_PROBE_TIMEOUT_MS = 15_000;
export const CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS = 15_000;
export const CONTAINER_TOOL_MUTATION_TIMEOUT_MS = 5 * 60_000;
const CONTAINER_TOOL_MUTATION_INNER_TIMEOUT_SECONDS = 285;

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function boundedContainerMutation(
    command: string,
    timeoutSeconds = CONTAINER_TOOL_MUTATION_INNER_TIMEOUT_SECONDS,
    killAfterSeconds = 5,
): string {
    return `timeout -k ${killAfterSeconds}s ${timeoutSeconds}s sh -c ${shellQuote(command)}`;
}

function boundedShortContainerMutation(command: string): string {
    return boundedContainerMutation(command, 8, 2);
}

function assertMutationSucceeded(
    result: ReturnType<typeof spawnSync>,
    operation: string,
): void {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
        || result.status === 124
        || result.status === 137;
    if (timedOut) throw new Error(`${operation} timed out`);
    if (result.error || result.status !== 0) throw new Error(`${operation} failed`);
}

export function isClaudeVersionLine(line: string): boolean {
    const trimmed = line.trim();
    return /^(claude(\s+code)?\s+v?\d+\.\d+\.\d+|v?\d+\.\d+\.\d+(\s|$)|v?\d+\.\d+\.\d+.*\bclaude(\s+code)?\b)/i.test(trimmed);
}

/**
 * Check if a file in the container is a mise shim (shell script referencing mise)
 * rather than a real native binary.
 */
export function isMiseShim(containerName: string, path: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", `head -c 500 '${path.replace(/'/g, "'\\''")}' 2>/dev/null | grep -q mise`],
        { encoding: "utf-8", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
    );
    return result.status === 0;
}

/**
 * Verify the binary at the given path is actually claude by checking --version output.
 * Guards against bun or other binaries accidentally cached at the claude path.
 */
export function isValidClaudeBinary(containerName: string, path: string): boolean {
    const escapedPath = path.replace(/'/g, "'\\''");
    const result = spawnSync(
        runtimeCli(),
        [
            "exec", containerName, "sh", "-c",
            `first_line="$('${escapedPath}' --version 2>/dev/null | head -n 1 || true)"; printf '%s\\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\\bclaude([[:space:]]+code)?\\b)'`,
        ],
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
is_claude() {
  first_line="$("$1" --version 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\bclaude([[:space:]]+code)?\b)'
}

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
        runtimeCli(),
        ["exec", containerName, "sh", "-c", boundedShortContainerMutation(probeScript)],
        { encoding: "utf-8", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
        || result.status === 124
        || result.status === 137) {
        throw new Error("Claude readiness probe timed out");
    }
    if (result.error || result.status !== 0) {
        throw new Error("Claude readiness probe failed");
    }
    const status = (result.stdout ?? "").trim();

    if (status === "VALID") return;

    if (status === "RESTORED") {
        console.log("Restored claude from cache.");
        return;
    }

    if (status !== "INSTALL") {
        throw new Error("Claude readiness probe returned an invalid result");
    }

    // Fresh install and save to volume
    console.log("Installing claude (first run)...");
    const installResult = spawnSync(
        runtimeCli(),
        [
            "exec",
            containerName,
            "sh",
            "-c",
            boundedContainerMutation(`${getToolByName("claude")!.installCommand} && ACTUAL="$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)" && [ -n "$ACTUAL" ] && [ -x "$ACTUAL" ] && mkdir -p ${CLAUDE_PERSIST_DIR} "$(dirname ${CLAUDE_BIN_PATH})" && cp -L "$ACTUAL" ${CLAUDE_PERSIST_DIR}/claude && cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`),
        ],
        { stdio: "inherit", timeout: CONTAINER_TOOL_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(installResult, "Claude installation");
}

/**
 * Ensure the requested tool is installed in the container.
 * - Claude: curl install + volume caching (only when activeTool is claude)
 * - npm tools: lazily install only the active tool
 */
export function ensureTools(containerName: string, activeTool: ToolDefinition): void {
    if (activeTool.name === "claude") {
        ensureClaudeInContainer(containerName);
    } else {
        ensureNpmTool(containerName, activeTool);
    }

    // tool-registry and this module intentionally share the fixed Claude path;
    // use it directly to avoid depending on that circular import's init order.
    const configuredBinary = activeTool.binary || activeTool.name;
    const executablePath = activeTool.name === "claude"
        ? CLAUDE_BIN_PATH
        : `/home/ccc/.local/bin/${configuredBinary}`;
    const ready = spawnSync(
        runtimeCli(),
        ["exec", containerName, "test", "-x", executablePath],
        { stdio: "ignore", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
    );
    if ((ready.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new Error(`Requested tool ${activeTool.name} readiness check timed out`);
    }
    if (ready.error || ready.status !== 0) {
        throw new Error(`Requested tool ${activeTool.name} is unavailable after setup`);
    }
}

/**
 * Ensure one npm-based tool from the registry is installed.
 */
function ensureNpmTool(containerName: string, activeTool: ToolDefinition): void {
    const configuredBinary = activeTool.binary || activeTool.name;
    const tool = getNpmTools().find((candidate) =>
        candidate.cmd === activeTool.name || candidate.cmd === configuredBinary,
    );
    if (!tool) {
        throw new Error(`Requested tool ${activeTool.name} has no npm installation definition`);
    }

    const checkResult = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c",
         `[ -x /home/ccc/.local/bin/${tool.cmd} ] || echo ${tool.cmd}`],
        { encoding: "utf-8", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
    );
    if ((checkResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new Error("Container npm tool probe timed out");
    }
    if (checkResult.error || checkResult.status !== 0) {
        throw new Error("Container npm tool probe failed");
    }
    if ((checkResult.stdout ?? "").trim() !== tool.cmd) {
        return;
    }

    console.log(`Installing ${tool.cmd}...`);

    const name = tool.pkg.split("/").pop();
    const scope = tool.pkg.includes("/") ? tool.pkg.split("/")[0] + "/" : "";
    const cleanupPattern = `"$gdir/${scope}.${name}-"*`;

    const cleanupResult = spawnSync(
        runtimeCli(),
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            boundedShortContainerMutation(`gdir=$(~/.local/bin/mise exec node@22 -- npm root -g 2>/dev/null) && rm -rf ${cleanupPattern} 2>/dev/null`),
        ],
        { stdio: "ignore", timeout: CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(cleanupResult, `Container ${tool.cmd} cleanup`);

    // Drop any stale mise shims for the missing tools BEFORE install. If the
    // mise volume persisted a shim from an earlier install whose underlying
    // package no longer matches, the shim throws "not a valid shim" — and PATH
    // would hit it if the wrapper at /home/ccc/.local/bin/<cmd> is gone.
    const shimCleanupResult = spawnSync(
        runtimeCli(),
        ["exec", "-w", "/home/ccc", containerName, "sh", "-c", boundedShortContainerMutation(`rm -f ~/.local/share/mise/shims/${tool.cmd}`)],
        { stdio: "ignore", timeout: CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(shimCleanupResult, `Container ${tool.cmd} shim cleanup`);

    const installResult = spawnSync(
        runtimeCli(),
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            boundedContainerMutation(`~/.local/bin/mise exec node@22 -- npm install -g ${tool.pkg}`),
        ],
        { stdio: "inherit", timeout: CONTAINER_TOOL_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(installResult, `Container ${tool.cmd} installation`);

    // Regenerate mise shims so they reflect the freshly-installed binaries.
    // Without this, an outdated shim from a prior install can shadow the new
    // binary on PATH lookups that bypass the wrapper at /home/ccc/.local/bin.
    const reshimResult = spawnSync(
        runtimeCli(),
        ["exec", "-w", "/home/ccc", containerName, "sh", "-c", boundedShortContainerMutation("~/.local/bin/mise reshim")],
        { stdio: "ignore", timeout: CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(reshimResult, `Container ${tool.cmd} reshim`);

    const wrapperResult = spawnSync(
        runtimeCli(),
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            boundedShortContainerMutation(`cat > /home/ccc/.local/bin/${tool.cmd} << 'WRAPPER'\n#!/bin/sh\nexec ~/.local/bin/mise exec node@22 -- ${tool.cmd} "$@"\nWRAPPER\nchmod +x /home/ccc/.local/bin/${tool.cmd}`),
        ],
        { stdio: "pipe", timeout: CONTAINER_TOOL_SHORT_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(wrapperResult, `Container ${tool.cmd} wrapper creation`);
}

/**
 * Save claude binary back to volume and refresh the fixed install path.
 */
export function saveClaudeBinaryToVolume(containerName: string): void {
    const resolveResult = spawnSync(
        runtimeCli(),
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
        runtimeCli(),
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
        runtimeCli(),
        ["exec", containerName, "sh", "-c",
         "~/.local/bin/mise ls --global 2>/dev/null | grep -q '^uv '"],
        { encoding: "utf-8", timeout: CONTAINER_TOOL_PROBE_TIMEOUT_MS },
    );
    if ((checkResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new Error("Container uv probe timed out");
    }
    if (checkResult.error || (checkResult.status !== 0 && checkResult.status !== 1)) {
        throw new Error("Container uv probe failed");
    }
    if (checkResult.status === 0) return;

    process.stderr.write("\x1b[2m▸ Installing uv (one-time, ~30-60s)...\x1b[0m\n");
    // MISE_VERBOSE=1 forces mise to stream download/build progress so the user
    // sees activity instead of a silent stall during the install.
    const installResult = spawnSync(
        runtimeCli(),
        ["exec", "-e", "MISE_VERBOSE=1", containerName, "sh", "-c",
         boundedContainerMutation("~/.local/bin/mise use -g uv@latest")],
        { stdio: "inherit", timeout: CONTAINER_TOOL_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(installResult, "Container uv installation");
}
