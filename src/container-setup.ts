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
# is not a trade worth making.
#
# Read the kernel's own mount table rather than comparing device numbers with
# the parent: that comparison misses a bind mount made within one filesystem,
# which is a real mount rm -rf would empty through, and it fails OPEN on exactly
# that case. /proc is mounted in any container that can run at all, so this
# needs no tool probe and has a single code path. (mountinfo octal-escapes
# space, tab, newline and backslash in field 5. That is irrelevant for the data
# dir and the launcher, whose paths are fixed, but a version name is not fixed:
# one holding whitespace would miss the match and the clear would go through the
# mount. A name holding a newline is worse still and never reaches this check:
# find -print and read -r break the record on it, so the loop acts on two
# fragments instead. That is the known edge of this check.)
is_mountpoint() {
  [ -d "$1" ] || return 1
  p="$(readlink -f "$1" 2>/dev/null)" || return 1
  [ -n "$p" ] || return 1
  awk -v want="$p" '$5 == want { found=1 } END { exit !found }' /proc/self/mountinfo
}
# Copy an existing install into the volume before replacing it. Applies to a
# real directory AND to a symlink aimed somewhere other than the volume —
# repointing that one silently used to cost a fresh 215MB download while the
# install it abandoned sat untouched on disk.
adopt_into_volume() {
  [ -d "$DATA" ] || return 0
  # Container-local, not in the volume. This is intra-container signalling, and
  # putting it in the shared volume made the one failure it exists to report —
  # the volume being unwritable — the one it could not record, while leaving an
  # invisible dotfile behind in a volume nobody thinks to inspect.
  #
  # Assigned HERE, in the parent, before the pipe below. The loop body runs in a
  # subshell, so it can only signal failure through a file — and only through a
  # name the parent already knows. With a deterministic name the placement was
  # incidental; with mktemp it is load-bearing, because a name computed inside
  # the subshell would leave the parent checking a path that never existed and
  # reporting success on every failure.
  #
  # The "|| return 1" is what makes an unusable temp directory a refusal, not
  # a silent success. The caller deletes the original on success, so dropping
  # it destroys working installs; a test pins it.
  adopt_failed="$(mktemp)" || return 1
  rm -f "$adopt_failed"
  # -L, so a name our side presents as a symlink to a directory is enumerated as
  # the directory it points at. Without it such a name is a LEAF, and the one
  # that matters is versions/ itself: the volume's shared versions directory
  # then lands under $target, where clearing it wipes every version every
  # project on the host runs, and publishing it puts a symlink to a
  # container-local path into a volume every other container reads.
  ( cd "$DATA" && find -L . -mindepth 1 -print ) | while IFS= read -r rel; do
    relpath="\${rel#./}"
    target="$VOL/$relpath"
    if [ -d "$DATA/$rel" ]; then
      # A directory directly under versions/ is not a version. Mirroring one
      # into the shared volume takes that name out of circulation for every
      # project on the host — pick_best skips it, seed_from refuses it, adopt
      # skips it — while each container keeps deleting its own good copy.
      case "$relpath" in
        versions/*/*)
          # Refusing the version directory and then creating it here is how the
          # announced refusal used to be undone: the volume ended up holding
          # exactly the state the message said was refused.
          echo "refusing to publish $relpath: it is inside a name that cannot be a version" >&2
          : > "$adopt_failed"
          continue
          ;;
        versions/*)
          echo "refusing to publish $relpath: a directory cannot be a version" >&2
          : > "$adopt_failed"
          continue
          ;;
      esac
      mkdir -p "$target" || : > "$adopt_failed"
      continue
    fi
    # Reaching here with relpath "versions" means our side has that name as
    # something other than a directory. Publishing it wedges every container on
    # the host permanently: once the data dir is the symlink, this loop is never
    # entered again, so nothing can ever undo it — and it is the one name whose
    # contents belong to every other project.
    if [ "$relpath" = "versions" ]; then
      echo "refusing to publish versions: it must be a directory" >&2
      : > "$adopt_failed"
      continue
    fi
    # Existence is not adoption. The volume is shared by every project on the
    # host, so a version already there may be the binary another container is
    # executing — forcing over it fails with ETXTBSY and takes down a working
    # project, and version files are named by their content, so a matching
    # regular file needs no replacing. That case is a skip, and stays one.
    if [ -f "$target" ] && [ ! -L "$target" ] && [ -f "$DATA/$rel" ]; then
      continue
    fi
    # Asked before staging so a container with a mount at that name is spared a
    # full 215MB copy on every start before the same refusal. It only reads, so
    # asking early costs nothing — but it is not the guarantee: the copy sits
    # between here and the delete, so the check is repeated there. Named like the data-dir and launcher
    # guards, because without it this refusal is indistinguishable from the
    # ordinary "could not be removed" one — and the difference is whether the
    # user's mounted data still exists.
    case "$relpath" in
      versions/*/*) ;;
      versions/*)
        if is_mountpoint "$target"; then
          echo "cannot adopt $relpath: it is a mount point in the volume, and clearing it would empty the other side" >&2
          : > "$adopt_failed"
          continue
        fi
        ;;
    esac
    # Copy to a staging name, then link it into place. Copying straight to the
    # final name publishes a truncated but still-executable file if the process
    # dies mid-copy, and nothing ever replaces it because copies skip what
    # exists — the migration path would manufacture the poisoned version it is
    # supposed to avoid. 215MB is long enough for that to happen. ln fails
    # EEXIST in the kernel, so two containers cannot both win the same name.
    #
    # -L on the copy as well: the volume must hold regular files and directories
    # and nothing else, since a symlink published there points at a path that
    # exists only in the container that wrote it.
    stage="$(mktemp "$VOL/.seed.XXXXXX")" || { echo "cannot stage $relpath into $VOL" >&2; : > "$adopt_failed"; continue; }
    if cp -aL "$DATA/$rel" "$stage"; then
      # Clear a name held by something unusable, here rather than before the
      # copy: between the two is 215MB of copying, and a name cleared that early
      # is a name absent from a shared volume for the whole of it — measured at
      # 1.05s for a 200MB payload. Doing it in the instant before ln also lets
      # a file that appeared meanwhile win, instead of being deleted by us.
      if [ -e "$target" ] || [ -L "$target" ]; then
        if [ -f "$target" ] && [ ! -L "$target" ]; then
          rm -f "$stage"
          continue
        fi
        clear_why=""
        case "$relpath" in
          versions/*/*) ;;
          versions/*)
            # A directory at versions/<v> is junk by construction: the mirror
            # branch refuses to create one, pick_best skips it and seed_from
            # refuses it, so nothing anyone runs lives inside. Leaving it there
            # wedges this container on every future start with no way back.
            #
            # Asked again here, not only in the arm before staging. That one
            # exists to refuse before copying 215MB; this one is the guarantee,
            # and between them lies the whole copy. A mount that appears in that
            # window would otherwise be deleted through.
            if is_mountpoint "$target"; then
              echo "cannot adopt $relpath: it is a mount point in the volume, and clearing it would empty the other side" >&2
              rm -f "$stage"
              : > "$adopt_failed"
              continue
            fi
            clear_why="$(rm -rf "$target" 2>&1)"
            ;;
        esac
        if [ -e "$target" ] || [ -L "$target" ]; then
          # Every other name gets the cautious treatment: only something that
          # holds nothing can go, because we cannot tell its contents from what
          # other projects are using.
          if [ -d "$target" ] && [ ! -L "$target" ]; then
            clear_why="$(rmdir "$target" 2>&1)"
          else
            clear_why="$(rm -f "$target" 2>&1)"
          fi
        fi
        if [ -e "$target" ] || [ -L "$target" ]; then
          # The reason matters: a permanently refused start otherwise cannot be
          # told apart from a read-only volume.
          if [ -n "$clear_why" ]; then
            echo "cannot adopt $relpath: the volume holds something else at that name and it could not be removed: $clear_why" >&2
          else
            echo "cannot adopt $relpath: the volume holds something else at that name and it could not be removed" >&2
          fi
          rm -f "$stage"
          : > "$adopt_failed"
          continue
        fi
      fi
      # A losing race is fine — the winner published the same content under a
      # content-named path. Any other ln failure means the file was NOT adopted,
      # and the caller deletes the original on success, so it has to be recorded.
      if ! ln "$stage" "$target" 2>/dev/null && [ ! -e "$target" ]; then
        echo "cannot publish $relpath into $VOL" >&2
        : > "$adopt_failed"
      fi
    else
      echo "cannot copy $relpath out of $DATA" >&2
      : > "$adopt_failed"
    fi
    rm -f "$stage"
  done
  if [ -e "$adopt_failed" ]; then
    rm -f "$adopt_failed"
    return 1
  fi
  return 0
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
    echo "refusing to replace $DATA: it is a mount point, and rm -rf would empty the other side" >&2
    exit 1
  fi
  adopt_into_volume && rm -rf "$DATA" && ln -s "$VOL" "$DATA"
else
  rm -f "$DATA" 2>/dev/null || true
  mkdir -p "$(dirname "$DATA")" && ln -s "$VOL" "$DATA"
fi
if [ ! -L "$DATA" ] || [ "$(readlink "$DATA")" != "$VOL" ]; then
  echo "$DATA is not backed by $VOL; an update here would not survive the container" >&2
  exit 1
fi

# Staging files are removed on every path that creates them, but a killed
# process leaves one behind — up to 215MB, dot-prefixed, in a volume shared by
# every project, so the symptom is "the cache is mysteriously full" with nothing
# pointing at the cause. The age guard is what makes this safe: another
# container's live staging file is minutes younger than the probe's own budget.
find "$VOL" "$DATA/versions" -maxdepth 1 -name '.seed.*' -mmin +10 -delete 2>/dev/null || true

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
    # -f follows links, so a symlink here used to be selected and blessed: the
    # probe reported success on a layout ccc doctor calls NOT updatable, which
    # is the exact shape this whole change exists to remove. ccc never publishes
    # one, but a hand-made or foreign entry in a shared volume can be one.
    if [ -L "$f" ]; then
      # Skipping silently leaves the user with a full reinstall, or with
      # "installation left no usable launcher", and nothing naming the entry
      # that caused either.
      echo "ignoring $cand: a version must be a real file, not a link" >&2
      continue
    fi
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
if [ -d "$BIN" ] && [ ! -L "$BIN" ]; then
  if is_mountpoint "$BIN"; then
    echo "refusing to replace $BIN: it is a mount point, and rm -rf would empty the other side" >&2
    exit 1
  fi
  rm -rf "$BIN"
  # The data dir has a post-check and this did not, so a removal that failed
  # — a read-only parent, or a mount the guard above did not recognise — let
  # ln write the launcher INSIDE the surviving directory, where nothing runs
  # it, and the probe still printed RESTORED and exited 0.
  if [ -e "$BIN" ] || [ -L "$BIN" ]; then
    echo "cannot replace $BIN: it could not be removed" >&2
    exit 1
  fi
fi
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
export function buildClaudeLauncherReportCommand(
    binPath: string,
    dataDir: string = CLAUDE_DATA_DIR,
): string {
    const bin = shellQuote(binPath);
    const versionsDir = shellQuote(`${dataDir}/versions`);
    return [
        `v="$(test -x ${bin} && ${bin} --version 2>&1 | head -1)"`,
        `[ -n "$v" ] || exit 1`,
        // Being a symlink is not the requirement — the updater manages the
        // launcher only when it resolves INTO versions/. A symlink pointing
        // anywhere else is just as unmanaged as a plain file, so reporting it
        // as updatable would hide exactly the state this check exists to find.
        `target="$(readlink -f ${bin} 2>/dev/null || true)"`,
        // Both sides get resolved. The data dir is itself a symlink into the
        // volume, so comparing a fully-resolved launcher against the literal
        // path reports every healthy container as broken — measured, not
        // guessed: the first version of this check did exactly that.
        `expected="$(readlink -f ${versionsDir} 2>/dev/null || true)"`,
        // `case` with a quoted pattern, not `${target#$expected/}`: in that
        // expansion the pattern is a glob, so a path holding `*`, `?` or `[`
        // silently matches the wrong thing. Quoting inside a case pattern makes
        // those characters literal.
        // What to print, versus what to match on. The sentinel exists so an
        // absent versions dir matches nothing; printing it would tell the user
        // about a directory that does not exist.
        `shown="$expected"`,
        `[ -n "$expected" ] || { expected="__no_versions_dir__"; shown=${versionsDir}; }`,
        `case "$target" in`,
        `  "$expected"/*) printf '%s (updatable, -> %s)\\n' "$v" "$target" ;;`,
        // Exit 2, not 0. A caller that keys off "the command succeeded" would
        // render this as a passing check — which is what ccc doctor did, showing
        // a green tick and "All checks passed" for the exact state this exists
        // to surface.
        // Report the resolved directory here too. Printing the literal path on
        // one branch and the resolved one on the other told a user about two
        // different directories for the same place.
        `  *) printf '%s (NOT updatable: launcher does not resolve into %s, so claude update cannot replace it. Starting ccc again repairs this)\\n' "$v" "$shown"; exit 2 ;;`,
        `esac`,
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
