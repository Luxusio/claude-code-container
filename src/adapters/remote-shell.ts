import { randomBytes } from "crypto";
import { hashPath, getProjectId, IMAGE_NAME, CONTAINER_PID_LIMIT, MISE_VOLUME_NAME } from "../utils.js";
import { IDENTITY_CONTRACT_VERSION } from "../container-identity.js";
import { getContainerName } from "../docker.js";
import { DEFAULT_PROFILE_MARKER, DEFAULT_PROFILE_NAME, normalizeProfile } from "../home-layout.js";

/** Escape a single literal argument for interpolation inside a shell command. */
export function shellEscapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function remoteLifecycleShell(containerName: string, body: string, lockWaitSeconds = 30): string {
    if (!Number.isFinite(lockWaitSeconds) || lockWaitSeconds <= 0 || lockWaitSeconds > 300) {
        throw new RangeError("lockWaitSeconds must be between 0 and 300");
    }
    const lockAttempts = Math.ceil(lockWaitSeconds * 10);
    const key = hashPath(containerName);
    const token = randomBytes(16).toString("hex");
    return [
        "set -eu",
        "umask 077",
        `_ccc_token=${token}`,
        "_ccc_assert_private() { [ -d \"$1\" ] && [ ! -L \"$1\" ] && [ -O \"$1\" ] || return 1; _ccc_mode=$(stat -c %a \"$1\" 2>/dev/null || stat -f %Lp \"$1\" 2>/dev/null) || return 1; case \"$_ccc_mode\" in ''|*[!0-7]*) return 1 ;; esac; [ $((0$_ccc_mode & 022)) -eq 0 ]; }",
        "_ccc_identity() { stat -L -c %d:%i \"$1\" 2>/dev/null || stat -L -f %d:%i \"$1\" 2>/dev/null; }",
        "_ccc_assert_private \"$HOME\" || exit 74",
        "_ccc_base=$HOME/.ccc",
        "if [ ! -e \"$_ccc_base\" ]; then mkdir \"$_ccc_base\" 2>/dev/null || true; fi",
        "_ccc_assert_private \"$_ccc_base\" || exit 74",
        "_ccc_runtime_path=$_ccc_base/remote-runtime",
        "if [ ! -e \"$_ccc_runtime_path\" ]; then mkdir \"$_ccc_runtime_path\" 2>/dev/null || true; fi",
        "_ccc_assert_private \"$_ccc_runtime_path\" || exit 74",
        "chmod 700 \"$_ccc_runtime_path\"",
        "eval 'exec 8<\"$_ccc_runtime_path\"'",
        "if [ -d /proc/$$/fd/8 ]; then _ccc_runtime_bound=/proc/$$/fd/8; elif [ -d /dev/fd/8 ]; then _ccc_runtime_bound=/dev/fd/8; else eval 'exec 8<&-'; exit 74; fi",
        "_ccc_runtime_identity=$(_ccc_identity \"$_ccc_runtime_bound\") || exit 74",
        "_ccc_assert_runtime() { _ccc_assert_private \"$_ccc_runtime_path\" && [ \"$(_ccc_identity \"$_ccc_runtime_path\")\" = \"$_ccc_runtime_identity\" ] && [ \"$(_ccc_identity \"$_ccc_runtime_bound\")\" = \"$_ccc_runtime_identity\" ]; }",
        "_ccc_runtime=$_ccc_runtime_bound",
        `_ccc_lock=$_ccc_runtime/lifecycle-${key}.lock`,
        `_ccc_guard=$_ccc_runtime/lifecycle-${key}.guard`,
        `_ccc_candidate=$_ccc_runtime/.lifecycle-${key}.$$.${token}`,
        "printf '%s %s\\n' \"$$\" \"$_ccc_token\" > \"$_ccc_candidate\"",
        "_ccc_guard_backend=none",
        "_ccc_guard_owned=0",
        "_ccc_lock_owned=0",
        "_ccc_release_guard() { [ \"$_ccc_guard_owned\" -eq 1 ] || return 0; case \"$_ccc_guard_backend\" in flock) flock -u 9 2>/dev/null || true; eval 'exec 9>&-' ;; shlock) if read -r _ccc_guard_pid < \"$_ccc_guard\" 2>/dev/null && [ \"$_ccc_guard_pid\" = \"$$\" ]; then rm -f \"$_ccc_guard\"; fi ;; esac; _ccc_guard_owned=0; }",
        "_ccc_unlock() { if [ \"$_ccc_lock_owned\" -eq 1 ] && read -r _ccc_owner_pid _ccc_owner_token < \"$_ccc_lock\" 2>/dev/null && [ \"$_ccc_owner_pid\" = \"$$\" ] && [ \"$_ccc_owner_token\" = \"$_ccc_token\" ]; then rm -f \"$_ccc_lock\"; fi; _ccc_lock_owned=0; _ccc_release_guard; rm -f \"$_ccc_candidate\" 2>/dev/null || true; eval 'exec 8<&-' 2>/dev/null || true; }",
        "_ccc_on_signal() { _ccc_signal_status=$1; trap - EXIT HUP INT TERM; _ccc_unlock; exit \"$_ccc_signal_status\"; }",
        "trap _ccc_unlock EXIT",
        "trap '_ccc_on_signal 129' HUP",
        "trap '_ccc_on_signal 130' INT",
        "trap '_ccc_on_signal 143' TERM",
        `if command -v flock >/dev/null 2>&1; then _ccc_guard_backend=flock; eval 'exec 9>\"$_ccc_guard\"'; flock -x -w ${lockWaitSeconds} 9 || exit 73; _ccc_guard_owned=1; elif command -v shlock >/dev/null 2>&1; then _ccc_guard_backend=shlock; _ccc_attempt=0; until shlock -p \"$$\" -f \"$_ccc_guard\" 2>/dev/null; do _ccc_attempt=$((_ccc_attempt + 1)); [ \"$_ccc_attempt\" -lt ${lockAttempts} ] || exit 73; sleep 0.1; done; _ccc_guard_owned=1; else exit 75; fi`,
        "_ccc_assert_runtime || { _ccc_release_guard; rm -f \"$_ccc_candidate\"; exit 74; }",
        "_ccc_attempt=0",
        `while [ -e "$_ccc_lock" ]; do _ccc_attempt=$((_ccc_attempt + 1)); [ "$_ccc_attempt" -lt ${lockAttempts} ] || { _ccc_release_guard; rm -f "$_ccc_candidate"; exit 73; }; _ccc_owner_live=0; if read -r _ccc_owner_pid _ccc_owner_token < "$_ccc_lock" 2>/dev/null; then _ccc_owner_command=$(ps -p "$_ccc_owner_pid" -o command= 2>/dev/null || true); case "$_ccc_owner_command" in *"$_ccc_owner_token"*) _ccc_owner_live=1 ;; esac; fi; if [ "$_ccc_owner_live" -eq 1 ]; then sleep 0.1; else rm -f "$_ccc_lock"; fi; done`,
        "ln \"$_ccc_candidate\" \"$_ccc_lock\" || { _ccc_release_guard; rm -f \"$_ccc_candidate\"; exit 73; }",
        "_ccc_lock_owned=1",
        "rm -f \"$_ccc_candidate\"",
        "_ccc_assert_runtime || exit 74",
        body,
    ].join("; ");
}

export function remoteSessionReservationShell(
    containerName: string,
    token: string,
    leaseSeconds: number,
    command: string,
    pinContainerIdentity = false,
): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_sessions=$_ccc_runtime/sessions-${key}`,
        "if [ ! -e \"$_ccc_sessions\" ]; then mkdir \"$_ccc_sessions\" 2>/dev/null || true; fi",
        "_ccc_assert_private \"$_ccc_sessions\" || exit 74",
        "chmod 700 \"$_ccc_sessions\"",
        "_ccc_sessions_identity=$(_ccc_identity \"$_ccc_sessions\") || exit 74",
        "_ccc_assert_sessions() { _ccc_assert_runtime && _ccc_assert_private \"$_ccc_sessions\" && [ \"$(_ccc_identity \"$_ccc_sessions\")\" = \"$_ccc_sessions_identity\" ]; }",
        `_ccc_marker=$_ccc_sessions/${token}`,
        `_ccc_marker_candidate=$_ccc_sessions/.${token}.$$.${"${_ccc_token}"}`,
        `[ ! -e "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] || exit 74`,
        "_ccc_now=$(date +%s)",
        `_ccc_assert_sessions || exit 74`,
        `printf '%s\\n' "$((_ccc_now + ${leaseSeconds}))" > "$_ccc_marker_candidate"`,
        `ln "$_ccc_marker_candidate" "$_ccc_marker" || { rm -f "$_ccc_marker_candidate"; exit 74; }`,
        `rm -f "$_ccc_marker_candidate"`,
        `[ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] || exit 74`,
        `_ccc_marker_identity=$(_ccc_identity "$_ccc_marker") || exit 74`,
        `_ccc_assert_marker() { [ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] && [ "$(_ccc_identity "$_ccc_marker")" = "$_ccc_marker_identity" ]; }`,
        `_ccc_assert_marker || exit 74`,
        `_ccc_assert_sessions || exit 74`,
        command,
        `_ccc_assert_sessions || exit 74`,
        `_ccc_assert_marker || exit 74`,
        ...(pinContainerIdentity ? [
            `_ccc_container_id=\${_ccc_container_id:-}`,
            `[ -n "$_ccc_container_id" ] || _ccc_container_id=$(docker inspect --format ${shellEscapeArg("{{.Id}}")} ${shellEscapeArg(containerName)}) || exit 44`,
            `case "$_ccc_container_id" in ''|*[!a-fA-F0-9]*) exit 74 ;; esac`,
            '[ "${#_ccc_container_id}" -ge 12 ] && [ "${#_ccc_container_id}" -le 64 ] || exit 74',
            `_ccc_marker_next=$_ccc_sessions/.${token}.next.$$.${"${_ccc_token}"}`,
            `printf '%s %s\\n' "$((_ccc_now + ${leaseSeconds}))" "$_ccc_container_id" > "$_ccc_marker_next"`,
            `_ccc_assert_marker || exit 74`,
            `_ccc_assert_sessions || exit 74`,
            `mv -f "$_ccc_marker_next" "$_ccc_marker"`,
            `_ccc_marker_identity=$(_ccc_identity "$_ccc_marker") || exit 74`,
            `_ccc_assert_marker || exit 74`,
            `printf 'ccc-container-id=%s\\n' "$_ccc_container_id"`,
        ] : []),
    ].join("; "));
}

export function remoteRefreshSessionShell(containerName: string, token: string, leaseSeconds: number, requireContainerIdentity = false, expectedContainerId?: string): string {
    if (requireContainerIdentity && !expectedContainerId?.match(/^[a-fA-F0-9]{12,64}$/)) {
        throw new RangeError("expectedContainerId is required when refreshing a pinned remote session");
    }
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_sessions=$_ccc_runtime/sessions-${key}`,
        `[ -e "$_ccc_sessions" ] || exit 44`,
        `_ccc_assert_private "$_ccc_sessions" || exit 74`,
        `_ccc_sessions_identity=$(_ccc_identity "$_ccc_sessions") || exit 74`,
        `_ccc_assert_sessions() { _ccc_assert_runtime && _ccc_assert_private "$_ccc_sessions" && [ "$(_ccc_identity "$_ccc_sessions")" = "$_ccc_sessions_identity" ]; }`,
        `_ccc_marker=$_ccc_sessions/${token}`,
        `[ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] || exit 44`,
        `_ccc_marker_identity=$(_ccc_identity "$_ccc_marker") || exit 74`,
        `_ccc_assert_marker() { [ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] && [ "$(_ccc_identity "$_ccc_marker")" = "$_ccc_marker_identity" ]; }`,
        `_ccc_assert_marker || exit 74`,
        ...(requireContainerIdentity ? [
            `read -r _ccc_expiry _ccc_container_id < "$_ccc_marker" || exit 74`,
            `_ccc_assert_marker || exit 74`,
            `case "$_ccc_expiry" in ''|*[!0-9]*) exit 74 ;; esac`,
            `case "$_ccc_container_id" in ''|*[!a-fA-F0-9]*) exit 74 ;; esac`,
            '[ "${#_ccc_container_id}" -ge 12 ] && [ "${#_ccc_container_id}" -le 64 ] || exit 74',
            `[ "$_ccc_container_id" = ${shellEscapeArg(expectedContainerId!)} ] || exit 74`,
        ] : []),
        "_ccc_now=$(date +%s)",
        `_ccc_assert_sessions || exit 74`,
        requireContainerIdentity
            ? `_ccc_marker_next=$_ccc_sessions/.${token}.next.$$.${"${_ccc_token}"}; printf '%s %s\\n' "$((_ccc_now + ${leaseSeconds}))" "$_ccc_container_id" > "$_ccc_marker_next"`
            : `_ccc_marker_next=$_ccc_sessions/.${token}.next.$$.${"${_ccc_token}"}; printf '%s\\n' "$((_ccc_now + ${leaseSeconds}))" > "$_ccc_marker_next"`,
        `_ccc_assert_marker || exit 74`,
        `_ccc_assert_sessions || exit 74`,
        `mv -f "$_ccc_marker_next" "$_ccc_marker"`,
        `_ccc_marker_identity=$(_ccc_identity "$_ccc_marker") || exit 74`,
        `_ccc_assert_marker || exit 74`,
    ].join("; "));
}

export function remoteReleaseSessionShell(containerName: string, token: string): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, `_ccc_sessions=$_ccc_runtime/sessions-${key}; if [ -e \"$_ccc_sessions\" ]; then _ccc_assert_private \"$_ccc_sessions\" || exit 74; _ccc_sessions_identity=$(_ccc_identity \"$_ccc_sessions\") || exit 74; _ccc_assert_sessions() { _ccc_assert_runtime && _ccc_assert_private \"$_ccc_sessions\" && [ \"$(_ccc_identity \"$_ccc_sessions\")\" = \"$_ccc_sessions_identity\" ]; }; _ccc_assert_sessions || exit 74; rm -f \"$_ccc_sessions/${token}\"; _ccc_assert_sessions || exit 74; fi; _ccc_assert_runtime || exit 74`);
}

export function remoteStopShell(containerName: string, ownToken: string, expectedContainerId: string): string {
    if (!expectedContainerId.match(/^[a-fA-F0-9]{12,64}$/)) {
        throw new RangeError("expectedContainerId must be a 12-64 character hexadecimal container ID");
    }
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_sessions=$_ccc_runtime/sessions-${key}`,
        `if [ -e "$_ccc_sessions" ]; then _ccc_assert_private "$_ccc_sessions" || exit 74; fi`,
        `if [ -e "$_ccc_sessions" ]; then _ccc_sessions_identity=$(_ccc_identity "$_ccc_sessions") || exit 74; _ccc_assert_sessions() { _ccc_assert_runtime && _ccc_assert_private "$_ccc_sessions" && [ "$(_ccc_identity "$_ccc_sessions")" = "$_ccc_sessions_identity" ]; }; _ccc_assert_sessions || exit 74; fi`,
        `_ccc_marker=$_ccc_sessions/${ownToken}`,
        `[ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] || exit 44`,
        `_ccc_marker_identity=$(_ccc_identity "$_ccc_marker") || exit 74`,
        `_ccc_assert_marker() { [ -f "$_ccc_marker" ] && [ ! -L "$_ccc_marker" ] && [ -O "$_ccc_marker" ] && [ "$(_ccc_identity "$_ccc_marker")" = "$_ccc_marker_identity" ]; }`,
        `_ccc_assert_marker || exit 74`,
        `read -r _ccc_own_expiry _ccc_container_id < "$_ccc_marker" || exit 74`,
        `_ccc_assert_marker || exit 74`,
        `case "$_ccc_own_expiry" in ''|*[!0-9]*) exit 74 ;; esac`,
        `case "$_ccc_container_id" in ''|*[!a-fA-F0-9]*) exit 74 ;; esac`,
        '[ "${#_ccc_container_id}" -ge 12 ] && [ "${#_ccc_container_id}" -le 64 ] || exit 74',
        `[ "$_ccc_container_id" = ${shellEscapeArg(expectedContainerId)} ] || exit 74`,
        `_ccc_expected_name=${shellEscapeArg(`/${containerName}`)}`,
        `_ccc_actual_name=$(docker inspect --format ${shellEscapeArg("{{.Name}}")} "$_ccc_container_id") || exit 44`,
        `[ "$_ccc_actual_name" = "$_ccc_expected_name" ] || exit 74`,
        `_ccc_assert_marker || exit 74`,
        `rm -f "$_ccc_marker"`,
        `if [ -e "$_ccc_sessions" ]; then _ccc_assert_sessions || exit 74; fi`,
        "_ccc_now=$(date +%s)",
        "_ccc_active=0",
        "if [ -d \"$_ccc_sessions\" ]; then for _ccc_marker in \"$_ccc_sessions\"/*; do _ccc_assert_sessions || exit 74; [ -f \"$_ccc_marker\" ] || continue; read -r _ccc_expiry _ccc_other_container_id < \"$_ccc_marker\" 2>/dev/null || _ccc_expiry=; case \"$_ccc_expiry\" in ''|*[!0-9]*) rm -f \"$_ccc_marker\" ;; *) if [ \"$_ccc_expiry\" -ge \"$_ccc_now\" ]; then _ccc_active=1; else rm -f \"$_ccc_marker\"; fi ;; esac; done; _ccc_assert_sessions || exit 74; fi",
        "if [ \"$_ccc_active\" -ne 0 ]; then echo ccc-remote-sessions-active; exit 42; fi",
        `docker stop "$_ccc_container_id"`,
    ].join("; "));
}

/**
 * Shell that sets `_ccc_claude_dir` on the remote host with the same rule as
 * home-layout.ts profileEntry: profiles/default is the no-profile account only
 * when marked, or when no pre-layout entry exists (doc/common/REQ__ccc-home-layout.md).
 */
export function remoteClaudeDirScript(profile?: string): string {
    const namedProfile = normalizeProfile(profile);
    if (namedProfile) {
        return `_ccc_claude_dir="$HOME/.ccc/profiles/"${shellEscapeArg(namedProfile)}"/claude"; mkdir -p "$_ccc_claude_dir"`;
    }
    return `_ccc_default="$HOME/.ccc/profiles/${DEFAULT_PROFILE_NAME}"; _ccc_legacy="$HOME/.ccc/claude"; `
        + `if [ ! -e "$_ccc_default/${DEFAULT_PROFILE_MARKER}" ]; then `
        + `if [ -e "$_ccc_legacy" ] || [ -e "$HOME/.ccc/claude.json" ] || [ -e "$HOME/.ccc/codex" ]; then _ccc_claude_dir="$_ccc_legacy"; `
        + `else mkdir -p "$_ccc_default" && : > "$_ccc_default/${DEFAULT_PROFILE_MARKER}"; _ccc_claude_dir="$_ccc_default/claude"; fi; `
        + `elif [ -e "$_ccc_legacy" ] && [ ! -e "$_ccc_default/claude" ]; then _ccc_claude_dir="$_ccc_legacy"; `
        + `else _ccc_claude_dir="$_ccc_default/claude"; fi; mkdir -p "$_ccc_claude_dir"`;
}

/** Resolve image identity remotely only when creating a container; retained mounts stay intact. */
export function remoteContainerStartScript(projectPath: string, profile?: string): string {
    const projectId = getProjectId(projectPath);
    const containerName = getContainerName(projectPath, profile);
    const resolveRemoteClaudeDir = remoteClaudeDirScript(profile);
    return `${resolveRemoteClaudeDir}; _ccc_container_id=$(docker inspect --format ${shellEscapeArg("{{.Id}}")} ${shellEscapeArg(containerName)} 2>/dev/null || true); if [ -n "$_ccc_container_id" ]; then docker start "$_ccc_container_id" >/dev/null; else
        _ccc_remote_image=$(docker image inspect ${shellEscapeArg(IMAGE_NAME)} --format '{{.Id}}') || exit 1
        [ "\${#_ccc_remote_image}" -eq 71 ] && printf '%s\\n' "$_ccc_remote_image" | grep -Eq '^sha256:[a-f0-9]{64}$' || { echo 'Invalid remote image ID' >&2; exit 1; }
        _ccc_mise_identity=$(docker run --rm --network none --entrypoint /bin/sh "$_ccc_remote_image" -c 'set -e; printf "%s-%s" "$(id -u)" "$(id -g)"') || exit 1
        case "$_ccc_mise_identity" in ''|*[!0-9-]*) echo 'Invalid remote image identity' >&2; exit 1;; esac
        printf '%s\\n' "$_ccc_mise_identity" | grep -Eq '^[0-9]+-[0-9]+$' || { echo 'Invalid remote image identity' >&2; exit 1; }
        _ccc_container_id=$(docker run -d --name ${containerName} \
        --network host \
        -v "$_ccc_claude_dir:/home/ccc/.claude" \
        -v "${MISE_VOLUME_NAME}-v${IDENTITY_CONTRACT_VERSION}-remote-$_ccc_mise_identity:/home/ccc/.local/share/mise" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -w /project/${projectId} \
        --pids-limit ${CONTAINER_PID_LIMIT} \
        "$_ccc_remote_image" sleep infinity); fi`;
}
