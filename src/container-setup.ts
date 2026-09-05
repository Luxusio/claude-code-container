// src/container-setup.ts - In-container setup and binary management
//
// Extracted from index.ts for separation of concerns.
// Contains: claude binary caching, npm tools installation, mise shim detection.

import { spawnSync } from "child_process";
import { getNpmTools, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { runtimeCli } from "./container-runtime.js";

// Claude's native install layout inside the container.
//
// The native updater manages ~/.local/bin/claude ONLY when it is a symlink into
// <data-dir>/versions/. ccc used to `cp` the binary to that path instead, and
// the consequence was silent: `claude update` installed the new version under
// versions/, printed "Successfully updated", declined to touch the launcher it
// had not created, and every later run executed the same stale copy. Measured
// on this project's own container — launcher 2.1.241 while versions/2.1.261 sat
// unreferenced, the volume cache byte-identical to the stale launcher.
//
// So ccc persists the native install DIRECTORY rather than a single binary:
//
//   <volume>/.claude-data                      persistent, shared across projects
//   ~/.local/share/claude -> <volume>/.claude-data      container fs, recreated
//   ~/.local/bin/claude   -> ~/.local/share/claude/versions/<v>
//
// An in-container `claude update` then lands directly in the volume, and the
// updater's own version cleanup resumes — it is disabled precisely because the
// launcher is not a symlink.
export const CLAUDE_DATA_VOLUME_DIR = "/home/ccc/.local/share/mise/.claude-data";
export const CLAUDE_DATA_DIR = "/home/ccc/.local/share/claude";
// Pre-symlink layout: one binary cached as a plain file. Volumes created before
// this change still hold it, so it is a migration donor, never a launcher source.
export const CLAUDE_LEGACY_CACHE_FILE = "/home/ccc/.local/share/mise/.claude-bin/claude";
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

export interface ClaudeLayoutPaths {
    /** PATH entry the launcher symlink lives at. */
    bin: string;
    /** XDG data dir the native installer writes to; becomes a symlink to `volumeDataDir`. */
    dataDir: string;
    /** Directory inside the persistent named volume that backs `dataDir`. */
    volumeDataDir: string;
    /** Pre-symlink single-file cache, used only as a migration donor. */
    legacyCacheFile: string;
}

export const CLAUDE_LAYOUT_PATHS: ClaudeLayoutPaths = {
    bin: CLAUDE_BIN_PATH,
    dataDir: CLAUDE_DATA_DIR,
    volumeDataDir: CLAUDE_DATA_VOLUME_DIR,
    legacyCacheFile: CLAUDE_LEGACY_CACHE_FILE,
};

// Bounded so a corrupt newest version cannot make the probe walk the whole
// directory spawning a 200MB binary per candidate.
const CLAUDE_VERSION_SCAN_LIMIT = 5;

// The probe is milliseconds on the happy path, but its migration branch copies
// the ~215MB binary into the volume. Measured here at 0.19s for a real 215MB
// migration within one filesystem, so the 8s budget the other short mutations
// use would very likely have held — this is headroom, not a fix for an observed
// timeout. It buys the case that branch cannot afford to lose: the first run
// after upgrading ccc, where timing out means re-downloading a cache that was
// already on disk.
const CLAUDE_PROBE_INNER_TIMEOUT_SECONDS = 120;
export const CLAUDE_PROBE_TIMEOUT_MS = 150_000;

/**
 * Build the in-container script that puts the native layout in place and
 * reports what it did: VALID (already correct), RESTORED (launcher re-pointed
 * at a version already in the volume, including a migrated legacy cache), or
 * INSTALL (nothing usable — caller must run the installer).
 *
 * Pure and path-parameterized so tests can execute it under `sh` against a
 * temp directory. That matters here: the predecessor was asserted only by
 * substring match on the generated text, which is exactly why a script that
 * did the wrong thing passed its tests for the life of this bug.
 *
 * POSIX sh only — /bin/sh is dash in this image.
 */
export function buildClaudeProbeScript(paths: ClaudeLayoutPaths): string {
    return `
BIN=${shellQuote(paths.bin)}
DATA=${shellQuote(paths.dataDir)}
VOL=${shellQuote(paths.volumeDataDir)}
LEGACY=${shellQuote(paths.legacyCacheFile)}
SCAN_LIMIT=${CLAUDE_VERSION_SCAN_LIMIT}

is_shim() { head -c 500 "$1" 2>/dev/null | grep -q mise; }
is_claude() {
  first_line="$("$1" --version 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\bclaude([[:space:]]+code)?\b)'
}

# The data dir must resolve into the named volume, or an in-container update is
# lost the moment the container is recreated.
mkdir -p "$VOL" || exit 1
if [ -L "$DATA" ]; then
  [ "$(readlink "$DATA")" = "$VOL" ] || { rm -f "$DATA"; ln -s "$VOL" "$DATA"; }
elif [ -d "$DATA" ]; then
  # A real directory here predates this layout (or a bind mount put it there).
  # Move its contents into the volume rather than discarding an install — so the
  # copy has to succeed before the original is removed. On failure $DATA stays a
  # real directory and the check below fails the probe, which is the honest
  # outcome: better a visible error than a silently deleted install.
  cp -a "$DATA/." "$VOL/" && rm -rf "$DATA" && ln -s "$VOL" "$DATA"
else
  rm -f "$DATA" 2>/dev/null || true
  mkdir -p "$(dirname "$DATA")" && ln -s "$VOL" "$DATA"
fi
[ -L "$DATA" ] || exit 1

# Newest-first, first valid wins: normally one --version spawn.
BEST=""
pick_best() {
  BEST=""
  for cand in $(ls "$DATA/versions" 2>/dev/null | sort -Vr | head -n "$SCAN_LIMIT"); do
    f="$DATA/versions/$cand"
    [ -f "$f" ] && [ -x "$f" ] || continue
    if is_shim "$f"; then continue; fi
    if is_claude "$f"; then BEST="$f"; return 0; fi
  done
  return 1
}

# Seed versions/<v> from a plain binary left by an older ccc, a hand install, or
# whatever is on PATH — so upgrading ccc does not force a re-download.
seed_from() {
  src="$1"
  [ -n "$src" ] && [ -f "$src" ] && [ -x "$src" ] || return 1
  is_shim "$src" && return 1
  is_claude "$src" || return 1
  v="$("$src" --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -n 1)"
  [ -n "$v" ] || return 1
  mkdir -p "$DATA/versions" || return 1
  cp -L "$src" "$DATA/versions/.seed.$$" || return 1
  chmod +x "$DATA/versions/.seed.$$"
  mv -f "$DATA/versions/.seed.$$" "$DATA/versions/$v"
}

if ! pick_best; then
  for donor in "$BIN" "$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)" "$LEGACY"; do
    if seed_from "$donor"; then break; fi
  done
  pick_best || { echo INSTALL; exit 0; }
fi

if [ -L "$BIN" ] && [ "$(readlink "$BIN")" = "$BEST" ]; then
  echo VALID
  exit 0
fi
mkdir -p "$(dirname "$BIN")" || exit 1
rm -rf "$BIN"
ln -s "$BEST" "$BIN" || exit 1
echo RESTORED`.trim();
}

/**
 * Ensure claude is available in the container, in the shape the native updater
 * will keep managing: launcher symlink → versions/<v> inside the shared volume.
 *
 * One docker exec on the happy path; a second only on first install, to prove
 * the installer actually produced a usable launcher instead of trusting it.
 */
export function ensureClaudeInContainer(containerName: string): void {
    const probeScript = buildClaudeProbeScript(CLAUDE_LAYOUT_PATHS);

    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", boundedContainerMutation(probeScript, CLAUDE_PROBE_INNER_TIMEOUT_SECONDS)],
        { encoding: "utf-8", timeout: CLAUDE_PROBE_TIMEOUT_MS },
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

    // The data dir is already a symlink into the volume by the time the probe
    // returns INSTALL, so the installer writes versions/ straight into the
    // volume and creates the launcher symlink itself. Nothing to copy after.
    console.log("Installing claude (first run)...");
    const installResult = spawnSync(
        runtimeCli(),
        [
            "exec",
            containerName,
            "sh",
            "-c",
            boundedContainerMutation(getToolByName("claude")!.installCommand),
        ],
        { stdio: "inherit", timeout: CONTAINER_TOOL_MUTATION_TIMEOUT_MS },
    );
    assertMutationSucceeded(installResult, "Claude installation");

    // Re-probe rather than trust the installer: a `curl | bash` that exits 0
    // without leaving a usable launcher would otherwise surface much later, as
    // an unexplained "tool is unavailable after setup".
    const confirm = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", boundedContainerMutation(probeScript, CLAUDE_PROBE_INNER_TIMEOUT_SECONDS)],
        { encoding: "utf-8", timeout: CLAUDE_PROBE_TIMEOUT_MS },
    );
    const confirmStatus = (confirm.stdout ?? "").trim();
    if (confirm.error || confirm.status !== 0 || (confirmStatus !== "VALID" && confirmStatus !== "RESTORED")) {
        throw new Error("Claude installation left no usable launcher");
    }
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

// saveClaudeBinaryToVolume() used to run on every session exit: it copied
// `command -v claude` into the volume and then copied that back over the
// launcher. Both halves are gone. The launcher is now a symlink and that second
// copy was what flattened it back into a regular file; the first is redundant
// because versions/ already lives in the volume. Removing it also drops a
// ~200MB copy from the shutdown path of every session.

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
