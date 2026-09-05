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

// A single `--version` may cold-read a ~215MB binary off a Docker named volume,
// and one probe can do that up to ten times: once per candidate version, plus
// twice per migration donor. That spawn count — not the migration copy, which
// measures 0.15s for the real 215MB file on one filesystem — is what the raised
// budget is for. Each individual call is capped separately so a binary that
// hangs cannot spend the whole budget in silence: the probe's stdio is captured,
// so a stall here is 150 seconds of no output at all.
const CLAUDE_VERSION_CALL_TIMEOUT_SECONDS = 10;
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
VERSION_CALL_TIMEOUT=${CLAUDE_VERSION_CALL_TIMEOUT_SECONDS}s

is_shim() { head -c 500 "$1" 2>/dev/null | grep -q mise; }
claude_version_line() {
  timeout "$VERSION_CALL_TIMEOUT" "$1" --version 2>/dev/null </dev/null | head -n 1 || true
}
is_claude() {
  first_line="$(claude_version_line "$1")"
  printf '%s\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\\bclaude([[:space:]]+code)?\\b)'
}

# The data dir must resolve into the named volume, or an in-container update is
# lost the moment the container is recreated.
mkdir -p "$VOL" || exit 1
# rm -rf across a mount boundary empties the OTHER side of the mount. ccc never
# puts one here, but a user can, and gutting a host directory to save a symlink
# is not a trade worth making. Compare device numbers with the parent: equal
# means an ordinary directory.
is_mountpoint() {
  [ -d "$1" ] || return 1
  [ "$(stat -c %d "$1" 2>/dev/null)" != "$(stat -c %d "$1/.." 2>/dev/null)" ]
}
# Copy an existing install into the volume before replacing it. Applies to a
# real directory AND to a symlink aimed somewhere other than the volume —
# repointing that one silently used to cost a fresh 215MB download while the
# install it abandoned sat untouched on disk.
adopt_into_volume() {
  [ -d "$DATA" ] || return 0
  # -n, never -f. The volume is shared by every project on the host, so a
  # version file already sitting there may be the binary another container is
  # executing right now — overwriting it fails with ETXTBSY and takes down ccc
  # startup for a project that was working fine. Version files are named by
  # their content, so an existing one needs no replacing.
  cp -an "$DATA/." "$VOL/"
}
if [ -L "$DATA" ] && [ "$(readlink "$DATA")" = "$VOL" ]; then
  :
elif [ -L "$DATA" ]; then
  adopt_into_volume && rm -f "$DATA" && ln -s "$VOL" "$DATA"
elif [ -d "$DATA" ]; then
  # Copy first, so a failed copy cannot lose the original. Note the weaker
  # guarantee once rm -rf starts: it removes entries before it can fail on the
  # directory itself, so a failure here can leave $DATA empty. The contents are
  # already in the volume by then, and the check below fails the probe loudly.
  if is_mountpoint "$DATA"; then
    exit 1
  fi
  adopt_into_volume && rm -rf "$DATA" && ln -s "$VOL" "$DATA"
else
  rm -f "$DATA" 2>/dev/null || true
  mkdir -p "$(dirname "$DATA")" && ln -s "$VOL" "$DATA"
fi
[ -L "$DATA" ] || exit 1

# Newest-first, first valid wins: normally one --version spawn. An earlier
# version stopped after the five newest, which turned a versions/ holding five
# broken entries into a fresh 215MB download for every project on the host even
# though a working version sat just below the cut. The updater prunes old
# versions once it manages the launcher, so the directory stays small; bounding
# each call is the protection that was actually wanted.
BEST=""
pick_best() {
  BEST=""
  for cand in $(ls "$DATA/versions" 2>/dev/null | sort -Vr); do
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
  v="$(claude_version_line "$src" | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -n 1)"
  [ -n "$v" ] || return 1
  mkdir -p "$DATA/versions" || return 1
  # Never publish over a version name that already exists. mv -f onto a
  # directory deposits the file INSIDE it and leaves the name unusable; mv -f
  # onto a file succeeds even while another container executes it, silently
  # swapping that container's binary for a donor copy on its next resolve. The
  # name is the content, so anything already there is already right.
  [ -e "$DATA/versions/$v" ] && return 1
  # Not "$$": the PID is container-local, containers start at low PIDs, and this
  # directory is a volume shared by every project on the host — two of them
  # seeding at once would interleave 215MB writes into one file and publish the
  # result under a real version name.
  seed="$(mktemp "$DATA/versions/.seed.XXXXXX")" || return 1
  if ! cp -L "$src" "$seed"; then rm -f "$seed"; return 1; fi
  if ! chmod +x "$seed"; then rm -f "$seed"; return 1; fi
  if ! mv -f "$seed" "$DATA/versions/$v"; then rm -f "$seed"; return 1; fi
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
# A directory here is pathological but has to go; anything else is replaced in
# one step, so a concurrent probe never sees the launcher missing.
[ -d "$BIN" ] && [ ! -L "$BIN" ] && rm -rf "$BIN"
ln -sfn "$BEST" "$BIN" || exit 1
echo "RESTORED $(basename "$BEST")"`.trim();
}

// The probe writes nothing to stdout when it fails, so without its stderr the
// user gets a bare "probe failed" and no way to tell a full disk from a
// read-only volume from a bind mount in the way. Same failure the e2e helper
// had: the assertion read stdout while the reason was on stderr.
function probeDiagnostic(stderr: string | undefined): string {
    const text = (stderr ?? "").trim();
    if (!text) return "";
    const lastLines = text.split(/\r?\n/).slice(-3).join("; ");
    return `: ${lastLines}`;
}

/**
 * Build the command `ccc doctor` uses to describe the claude launcher.
 *
 * Reports the launcher's SHAPE, not only its version. A regular file at that
 * path is the state in which `claude update` prints success and changes
 * nothing, because the native updater declines to manage a launcher it did not
 * create. Nothing surfaced that, which is why it went unnoticed across every
 * project on the host until two version numbers were compared by hand.
 *
 * Separate and parameterized for the same reason `buildClaudeProbeScript` is:
 * so a test can run it instead of matching substrings in it.
 */
export function buildClaudeLauncherReportCommand(binPath: string): string {
    const bin = shellQuote(binPath);
    return [
        `v="$(test -x ${bin} && ${bin} --version 2>&1 | head -1)"`,
        `[ -n "$v" ] || exit 1`,
        `if [ -L ${bin} ]; then`,
        `  printf '%s (updatable, -> %s)\\n' "$v" "$(readlink ${bin})"`,
        `else`,
        `  printf '%s (NOT updatable: launcher is a plain file, so claude update cannot replace it)\\n' "$v"`,
        `fi`,
    ].join("\n");
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
        throw new Error(`Claude readiness probe failed${probeDiagnostic(result.stderr)}`);
    }
    const status = (result.stdout ?? "").trim();

    if (status === "VALID") return;

    if (status.startsWith("RESTORED")) {
        // Nothing is copied out of a cache any more — the launcher is pointed at
        // a version already in the shared volume. Name it, because "why am I on
        // an old claude" is the question this line exists to answer.
        const version = status.slice("RESTORED".length).trim();
        console.log(version
            ? `Reusing claude ${version} from the shared volume.`
            : "Reusing claude from the shared volume.");
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
    if (confirm.error || confirm.status !== 0
        || (confirmStatus !== "VALID" && !confirmStatus.startsWith("RESTORED"))) {
        throw new Error(`Claude installation left no usable launcher${probeDiagnostic(confirm.stderr)}`);
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
