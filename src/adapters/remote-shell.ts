import { randomBytes } from "crypto";
import { hashPath, getProjectId, IMAGE_NAME, CONTAINER_PID_LIMIT, MISE_VOLUME_NAME } from "../utils.js";
import { IDENTITY_CONTRACT_VERSION } from "../container-identity.js";
import { getContainerName } from "../docker.js";
import { DEFAULT_PROFILE_MARKER, DEFAULT_PROFILE_NAME, normalizeProfile } from "../home-layout.js";

/** Escape a single literal argument for interpolation inside a shell command. */
export function shellEscapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Receiving-host scopes admit an owned stopped job before any protected effect.
// Native birth, command and ancestry fence cancellation; unknown proof retains claims.
// An anonymous inode carries refusal separately from arbitrary command exit statuses.
// Balanced case patterns also support Bash 3's command-substitution scanner.
const remoteScopeShell = `_ccc_admission_failure() {
    printf 'CCC remote descriptor admission failed: %s\\n' "$1" >&2 || true
}
_ccc_fd_stat() {
    stat -c "$1" - 2>/dev/null || stat -f "$2" 2>/dev/null
}
_ccc_refusal_stat() {
    [ -n "\${_ccc_refusal_descriptor:-}" ] && [ -f "$_ccc_refusal_descriptor" ] && [ -O "$_ccc_refusal_descriptor" ] || return 1
    _ccc_refusal_meta=$(_ccc_fd_stat '%d:%i:%a:%h:%s' '%d:%i:%Lp:%l:%z' <&"$_ccc_refusal_fd") || return 1
    IFS=: read -r _ccc_refusal_device _ccc_refusal_inode _ccc_refusal_mode _ccc_refusal_links _ccc_refusal_size <<CCC_REFUSAL_META
$_ccc_refusal_meta
CCC_REFUSAL_META
    case "$_ccc_refusal_meta" in (''|*[!0-9:]*|:*|*::*) return 1 ;; esac
    [ "$_ccc_refusal_device:$_ccc_refusal_inode" = "$_ccc_refusal_identity" ] && [ "$_ccc_refusal_mode" = 600 ] && [ "$_ccc_refusal_links" = 0 ]
}
_ccc_refusal_empty() {
    [ -n "\${_ccc_refusal_descriptor:-}" ] || return 0
    _ccc_refusal_stat && [ "$_ccc_refusal_size" = 0 ]
}
_ccc_refusal_open() {
    _ccc_refusal_path=$1
    _ccc_refusal_fd=$2
    _ccc_refusal_options=$-
    set -C
    exec 5>"$_ccc_refusal_path"
    case "$_ccc_refusal_options" in (*C*) ;; (*) set +C ;; esac
    if [ ! -f /dev/fd/5 ] && [ ! -f /proc/self/fd/5 ]; then _ccc_admission_failure refusal-created-fd; return 74; fi
    _ccc_refusal_identity=$(_ccc_fd_stat %d:%i %d:%i <&5) || { _ccc_admission_failure refusal-created-fd-identity; return 74; }
    [ -f "$_ccc_refusal_path" ] && [ ! -L "$_ccc_refusal_path" ] && [ -O "$_ccc_refusal_path" ] || { _ccc_admission_failure refusal-created-file-private; return 74; }
    case "$_ccc_refusal_fd" in (4) exec 4<>"$_ccc_refusal_path" ;; (9) exec 9<>"$_ccc_refusal_path" ;; (*) return 74 ;; esac
    if [ -f "/dev/fd/$_ccc_refusal_fd" ]; then _ccc_refusal_prefix=/dev/fd; elif [ -f "/proc/self/fd/$_ccc_refusal_fd" ]; then _ccc_refusal_prefix=/proc/self/fd; else _ccc_admission_failure refusal-reopened-fd; return 74; fi
    _ccc_refusal_descriptor=$_ccc_refusal_prefix/$_ccc_refusal_fd
    _ccc_refusal_open_meta=$(_ccc_fd_stat '%d:%i:%a:%h:%s' '%d:%i:%Lp:%l:%z' <&"$_ccc_refusal_fd") || { _ccc_admission_failure refusal-reopened-meta-read; return 74; }
    [ "$_ccc_refusal_open_meta" = "$_ccc_refusal_identity:600:1:0" ] && [ ! -L "$_ccc_refusal_path" ] || { _ccc_admission_failure refusal-reopened-meta-match; return 74; }
    [ "$(stat -L -c %d:%i "$_ccc_refusal_path" 2>/dev/null || stat -L -f %d:%i "$_ccc_refusal_path" 2>/dev/null)" = "$_ccc_refusal_identity" ] || { _ccc_admission_failure refusal-created-path-identity; return 74; }
    rm "$_ccc_refusal_path" || { _ccc_admission_failure refusal-unlink; return 74; }
    _ccc_refusal_empty || { _ccc_admission_failure refusal-postunlink-meta; return 74; }
    exec 5>&-
}
_ccc_refuse() {
    _ccc_cleanup_refused=1
    trap '' HUP INT TERM
    if _ccc_refusal_stat; then
        case "$_ccc_refusal_fd" in (4) printf x >&4 ;; (9) printf x >&9 ;; (*) false ;; esac &&
            _ccc_refusal_stat && [ "$_ccc_refusal_size" -gt 0 ] && return 0
    fi
    printf '%s\\n' 'CCC remote refusal evidence unavailable; retaining claims' >&2
    while :; do sleep 1; done
}
_ccc_scope_observe() {
    _ccc_observed=$(trap '' HUP INT TERM; LC_ALL=C TZ=UTC /bin/ps -ww -p "$1" -o pid= -o ppid= -o state= -o lstart= -o command= 2>/dev/null) || {
        _ccc_scope_absent=$(LC_ALL=C kill -0 "$1" 2>&1) && return 74
        case "$_ccc_scope_absent" in (*'No such process'*) return 1 ;; (*) return 74 ;; esac
    }
    IFS=' ' read -r _ccc_observed_pid _ccc_observed_parent _ccc_observed_state _ccc_observed_day _ccc_observed_month _ccc_observed_date _ccc_observed_time _ccc_observed_year _ccc_observed_command <<CCC_SCOPE_OBSERVE
$_ccc_observed
CCC_SCOPE_OBSERVE
    case "$_ccc_observed_pid:$_ccc_observed_parent" in (*[!0-9:]*|:*|*:) return 74 ;; esac
    [ "$_ccc_observed_pid" = "$1" ] && [ -n "$_ccc_observed_command" ] && [ -n "$_ccc_observed_year" ] || return 74
    case "$_ccc_observed_state" in (Z*) return 1 ;; esac
    _ccc_observed_birth="$_ccc_observed_day $_ccc_observed_month $_ccc_observed_date $_ccc_observed_time $_ccc_observed_year"
    _ccc_observed_record="$_ccc_observed_pid|$_ccc_observed_parent|$_ccc_observed_birth|$_ccc_observed_command"
}
_ccc_scope_decode() {
    IFS='|' read -r _ccc_expected_pid _ccc_expected_parent _ccc_expected_birth _ccc_expected_command <<CCC_SCOPE_RECORD
$1
CCC_SCOPE_RECORD
}
_ccc_scope_match() {
    _ccc_scope_decode "$1"
    _ccc_scope_observe "$_ccc_expected_pid" || return $?
    [ "$_ccc_observed_birth" = "$_ccc_expected_birth" ] && [ "$_ccc_observed_command" = "$_ccc_expected_command" ] || return 74
    [ "$2" = join ] || [ "$_ccc_observed_parent" = "$_ccc_expected_parent" ] || return 2
}
_ccc_scope_capture() {
    _ccc_scope_cancel_root=
    _ccc_scope_records=
    if [ -n "$_ccc_scope_root_record" ]; then
        _ccc_scope_match "$_ccc_scope_root_record" signal || return $?
    else
        _ccc_scope_observe "$_ccc_scope_pid" || return $?
    fi
    [ "$_ccc_observed_parent" = "$_ccc_scope_parent" ] || return 74
    case "$_ccc_observed_command" in (*"$_ccc_scope_token"*) ;; (*) return 74 ;; esac
    _ccc_scope_records=$_ccc_observed_record
    _ccc_scope_cancel_root=$_ccc_observed_record
    _ccc_scope_cancel_command=$_ccc_observed_command
    # Notify the owned worker before nested observations delay cancellation forwarding.
    kill -TERM "$_ccc_scope_pid" 2>/dev/null || true
    _ccc_scope_resume_status=0
    _ccc_scope_match "$_ccc_scope_cancel_root" signal || _ccc_scope_resume_status=$?
    case "$_ccc_scope_resume_status" in
        (0) kill -CONT "$_ccc_expected_pid" 2>/dev/null || true ;;
        (1) ;;
        (*) return 74 ;;
    esac
    _ccc_scope_snapshot=$(trap '' HUP INT TERM; LC_ALL=C TZ=UTC /bin/ps -A -ww -o pid= -o ppid= 2>/dev/null) || return 74
    while IFS=' ' read -r _ccc_candidate_pid _ccc_candidate_parent _ccc_candidate_extra; do
        [ -n "$_ccc_candidate_pid$_ccc_candidate_parent$_ccc_candidate_extra" ] || continue
        case "$_ccc_candidate_pid:$_ccc_candidate_parent" in (*[!0-9:]*|:*|*:) return 74 ;; esac
        [ -z "$_ccc_candidate_extra" ] || return 74
        [ "$_ccc_candidate_parent" = "$_ccc_scope_pid" ] || continue
        _ccc_scope_observe "$_ccc_candidate_pid" || { [ "$?" = 1 ] && continue; return 74; }
        [ "$_ccc_observed_parent" = "$_ccc_scope_pid" ] || return 74
        _ccc_scope_records="$_ccc_scope_records
$_ccc_observed_record"
        _ccc_scope_match "$_ccc_scope_cancel_root" signal || return $?
    done <<CCC_SCOPE_CHILDREN
$_ccc_scope_snapshot
CCC_SCOPE_CHILDREN
}
_ccc_scope_resume() {
    _ccc_scope_resume_status=0
    _ccc_scope_match "$1" signal || _ccc_scope_resume_status=$?
    case "$_ccc_scope_resume_status" in (1) return 0 ;; (0) ;; (*) return 74 ;; esac
    case "$_ccc_observed_state" in (T*) kill -CONT "$_ccc_expected_pid" 2>/dev/null ;; (*) return 74 ;; esac
}
_ccc_scope_native() {
    _ccc_scope_native_record=$1
    _ccc_scope_native_status=0
    _ccc_scope_match "$_ccc_scope_native_record" signal || _ccc_scope_native_status=$?
    case "$_ccc_scope_native_status" in (1|2) return 0 ;; (0) ;; (*) return 74 ;; esac
    # Nested workers have their own supervisor; a second STOP controller races its CONT.
    [ "$_ccc_observed_command" != "$_ccc_scope_cancel_command" ] || return 0
    if ! kill -STOP "$_ccc_expected_pid" 2>/dev/null; then
        _ccc_scope_native_status=0
        _ccc_scope_match "$_ccc_scope_native_record" signal || _ccc_scope_native_status=$?
        [ "$_ccc_scope_native_status" = 1 ] && return 0
        return 74
    fi
    while :; do
        _ccc_scope_native_status=0
        _ccc_scope_match "$_ccc_scope_native_record" signal || _ccc_scope_native_status=$?
        [ "$_ccc_scope_native_status" != 1 ] || return 0
        if [ "$_ccc_scope_native_status" != 0 ]; then _ccc_scope_resume "$_ccc_scope_native_record" || true; return 74; fi
        case "$_ccc_observed_state" in (T*) break ;; esac
        sleep 0.01
    done
    _ccc_scope_frozen_pid=$_ccc_expected_pid
    _ccc_scope_frozen_parent=$_ccc_expected_parent
    _ccc_scope_snapshot=$(trap '' HUP INT TERM; LC_ALL=C TZ=UTC /bin/ps -A -ww -o pid= -o ppid= 2>/dev/null) || {
        _ccc_scope_resume "$_ccc_scope_native_record" || true
        return 74
    }
    _ccc_scope_has_child=0
    _ccc_scope_frozen_seen=0
    _ccc_scope_snapshot_valid=1
    while IFS=' ' read -r _ccc_candidate_pid _ccc_candidate_parent _ccc_candidate_extra; do
        [ -n "$_ccc_candidate_pid$_ccc_candidate_parent$_ccc_candidate_extra" ] || continue
        case "$_ccc_candidate_pid:$_ccc_candidate_parent" in (*[!0-9:]*|:*|*:) _ccc_scope_snapshot_valid=0; break ;; esac
        [ -z "$_ccc_candidate_extra" ] || { _ccc_scope_snapshot_valid=0; break; }
        if [ "$_ccc_candidate_pid" = "$_ccc_scope_frozen_pid" ] && [ "$_ccc_candidate_parent" = "$_ccc_scope_frozen_parent" ]; then _ccc_scope_frozen_seen=1; fi
        [ "$_ccc_candidate_parent" != "$_ccc_scope_frozen_pid" ] || _ccc_scope_has_child=1
    done <<CCC_SCOPE_FROZEN
$_ccc_scope_snapshot
CCC_SCOPE_FROZEN
    if [ "$_ccc_scope_snapshot_valid:$_ccc_scope_frozen_seen" != 1:1 ]; then
        _ccc_scope_resume "$_ccc_scope_native_record" || true
        return 74
    fi
    _ccc_scope_match "$_ccc_scope_native_record" signal || { _ccc_scope_resume "$_ccc_scope_native_record" || true; return 74; }
    case "$_ccc_observed_state" in (T*) ;; (*) return 74 ;; esac
    if [ "$_ccc_scope_has_child" = 0 ]; then
        kill -TERM "$_ccc_expected_pid" 2>/dev/null || { _ccc_scope_resume "$_ccc_scope_native_record" || true; return 74; }
    fi
    _ccc_scope_resume "$_ccc_scope_native_record"
}
_ccc_scope_child_exit() { trap '' HUP INT TERM; [ "\${_ccc_cleanup_refused:-0}" != 1 ] || exit 79; wait 2>/dev/null || true; exit "$1"; }
_ccc_scope_cancel() {
    _ccc_scope_signal_status=$1
    trap '' HUP INT TERM
    _ccc_scope_capture_status=0
    _ccc_scope_capture || _ccc_scope_capture_status=$?
    if [ "$_ccc_scope_capture_status" != 0 ] && [ "$_ccc_scope_capture_status" != 1 ]; then _ccc_refuse; fi
    while IFS= read -r _ccc_scope_record; do
        [ -n "$_ccc_scope_record" ] || continue
        _ccc_scope_decode "$_ccc_scope_record"
        [ "$_ccc_expected_pid" != "$_ccc_scope_pid" ] || continue
        _ccc_scope_native "$_ccc_scope_record" || _ccc_refuse
    done <<CCC_SCOPE_SIGNALS
$_ccc_scope_records
CCC_SCOPE_SIGNALS
    if [ "\${_ccc_cleanup_refused:-0}" = 1 ]; then
        printf '%s\\n' 'CCC remote cancellation ownership unavailable; retaining claims' >&2
        "$_ccc_scope_callback" "$_ccc_scope_signal_status"
    fi
    _ccc_scope_join_status=0
    wait "$_ccc_scope_pid" 2>/dev/null || _ccc_scope_join_status=$?
    _ccc_refusal_empty || _ccc_refuse
    while IFS= read -r _ccc_scope_record; do
        [ -n "$_ccc_scope_record" ] || continue
        while :; do
            _ccc_scope_match_status=0
            _ccc_scope_match "$_ccc_scope_record" join || _ccc_scope_match_status=$?
            [ "$_ccc_scope_match_status" != 0 ] || { sleep 0.01; continue; }
            if [ "$_ccc_scope_match_status" != 1 ]; then _ccc_refuse; fi
            break
        done
    done <<CCC_SCOPE_JOINS
$_ccc_scope_records
CCC_SCOPE_JOINS
    "$_ccc_scope_callback" "$_ccc_scope_signal_status"
}
_ccc_scope_run() {
    _ccc_scope_token=$1
    _ccc_scope_body=$2
    _ccc_scope_callback=$3
    _ccc_scope_parent=$(trap '' HUP INT TERM; exec /bin/sh -c 'printf "%s" "$PPID"') || return 74
    _ccc_scope_root_record=
    _ccc_scope_pending=0
    trap '_ccc_scope_pending=129' HUP
    trap '_ccc_scope_pending=130' INT
    trap '_ccc_scope_pending=143' TERM
    exec 3<&0
    (
        trap '_ccc_scope_child_exit 129' HUP
        trap '_ccc_scope_child_exit 130' INT
        trap '_ccc_scope_child_exit 143' TERM
        exec 3<&-
        if [ "\${_ccc_refusal_fd:-}" = 4 ]; then
            exec 9>&4 4>&-
            _ccc_refusal_fd=9
            _ccc_refusal_descriptor=$_ccc_refusal_prefix/9
        fi
        _ccc_scope_self=$(trap '' HUP INT TERM; exec /bin/sh -c 'printf "%s" "$PPID"') || exit 74
        kill -STOP "$_ccc_scope_self" || exit 74
        eval "$_ccc_scope_body"
        exit $?
    ) <&3 &
    _ccc_scope_pid=$!
    exec 3<&-
    trap '_ccc_scope_cancel 129' HUP
    trap '_ccc_scope_cancel 130' INT
    trap '_ccc_scope_cancel 143' TERM
    [ "$_ccc_scope_pending" = 0 ] || _ccc_scope_cancel "$_ccc_scope_pending"
    _ccc_scope_attempt=0
    while :; do
        _ccc_scope_probe=0
        _ccc_scope_observe "$_ccc_scope_pid" || _ccc_scope_probe=$?
        if [ "$_ccc_scope_probe" != 0 ]; then _ccc_refuse; return 79; fi
        [ "$_ccc_observed_parent" = "$_ccc_scope_parent" ] || { _ccc_refuse; return 79; }
        case "$_ccc_observed_command" in (*"$_ccc_scope_token"*) ;; (*) _ccc_refuse; return 79 ;; esac
        case "$_ccc_observed_state" in (T*) break ;; esac
        _ccc_scope_attempt=$((_ccc_scope_attempt + 1))
        [ "$_ccc_scope_attempt" -lt 100 ] || { _ccc_refuse; return 79; }
        sleep 0.01
    done
    _ccc_scope_root_record=$_ccc_observed_record
    kill -CONT "$_ccc_scope_pid" || { _ccc_refuse; return 79; }
    _ccc_scope_status=0
    wait "$_ccc_scope_pid" || _ccc_scope_status=$?
    trap '"$_ccc_scope_callback" 129' HUP
    trap '"$_ccc_scope_callback" 130' INT
    trap '"$_ccc_scope_callback" 143' TERM
    _ccc_refusal_empty || _ccc_refuse
    return "$_ccc_scope_status"
}
`.trim();

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
        remoteScopeShell,
        "_ccc_assert_private() { [ -d \"$1\" ] && [ ! -L \"$1\" ] && [ -O \"$1\" ] || return 1; _ccc_mode=$(stat -c %a \"$1\" 2>/dev/null || stat -f %Lp \"$1\" 2>/dev/null) || return 1; case \"$_ccc_mode\" in ''|*[!0-7]*) return 1 ;; esac; [ $((0$_ccc_mode & 022)) -eq 0 ]; }",
        "_ccc_identity() { stat -L -c %d:%i \"$1\" 2>/dev/null || stat -L -f %d:%i \"$1\" 2>/dev/null; }",
        "_ccc_assert_private \"$HOME\" || { _ccc_admission_failure lifecycle-home-private; exit 74; }",
        "_ccc_base=$HOME/.ccc",
        "if [ ! -e \"$_ccc_base\" ]; then mkdir \"$_ccc_base\" 2>/dev/null || true; fi",
        "_ccc_assert_private \"$_ccc_base\" || { _ccc_admission_failure lifecycle-base-private; exit 74; }",
        "_ccc_runtime_path=$_ccc_base/remote-runtime",
        "if [ ! -e \"$_ccc_runtime_path\" ]; then mkdir \"$_ccc_runtime_path\" 2>/dev/null || true; fi",
        "_ccc_assert_private \"$_ccc_runtime_path\" || { _ccc_admission_failure lifecycle-runtime-private; exit 74; }",
        "chmod 700 \"$_ccc_runtime_path\"",
        "eval 'exec 8<\"$_ccc_runtime_path\"'",
        "if [ ! -d /dev/fd/8 ] && [ ! -d /proc/self/fd/8 ]; then eval 'exec 8<&-'; _ccc_admission_failure lifecycle-runtime-fd; exit 74; fi",
        "_ccc_runtime_identity=$(_ccc_fd_stat %d:%i %d:%i <&8) || { _ccc_admission_failure lifecycle-runtime-fd-identity; exit 74; }",
        "cd -P \"$_ccc_runtime_path\" || { _ccc_admission_failure lifecycle-runtime-cd; exit 74; }",
        "[ \"$(_ccc_identity .)\" = \"$_ccc_runtime_identity\" ] || { _ccc_admission_failure lifecycle-runtime-cwd-identity; exit 74; }",
        "_ccc_assert_runtime() { _ccc_assert_private \"$_ccc_runtime_path\" && [ \"$(_ccc_identity \"$_ccc_runtime_path\")\" = \"$_ccc_runtime_identity\" ] && [ \"$(_ccc_fd_stat %d:%i %d:%i <&8)\" = \"$_ccc_runtime_identity\" ] && [ \"$(_ccc_identity .)\" = \"$_ccc_runtime_identity\" ]; }",
        "_ccc_runtime=.",
        `_ccc_refusal_open .scope-$$-${token} 4 || exit 74`,
        `_ccc_lock=$_ccc_runtime/lifecycle-${key}.lock`,
        `_ccc_guard=$_ccc_runtime/lifecycle-${key}.guard`,
        `_ccc_candidate=$_ccc_runtime/.lifecycle-${key}.$$.${token}`,
        "printf '%s %s\\n' \"$$\" \"$_ccc_token\" > \"$_ccc_candidate\"",
        "_ccc_guard_backend=none",
        "_ccc_guard_owned=0",
        "_ccc_lock_owned=0",
        "_ccc_release_guard() { [ \"$_ccc_guard_owned\" -eq 1 ] || return 0; case \"$_ccc_guard_backend\" in flock) flock -u 9 2>/dev/null || true; eval 'exec 9>&-' ;; shlock) if read -r _ccc_guard_pid < \"$_ccc_guard\" 2>/dev/null && [ \"$_ccc_guard_pid\" = \"$$\" ]; then rm -f \"$_ccc_guard\"; fi ;; esac; _ccc_guard_owned=0; }",
        "_ccc_unlock() { _ccc_refusal_empty || _ccc_refuse; [ \"${_ccc_cleanup_refused:-0}\" != 1 ] || return 74; if command -v _ccc_bind_release >/dev/null 2>&1; then _ccc_bind_release || true; fi; if [ \"$_ccc_lock_owned\" -eq 1 ] && read -r _ccc_owner_pid _ccc_owner_token < \"$_ccc_lock\" 2>/dev/null && [ \"$_ccc_owner_pid\" = \"$$\" ] && [ \"$_ccc_owner_token\" = \"$_ccc_token\" ]; then rm -f \"$_ccc_lock\"; fi; _ccc_lock_owned=0; _ccc_release_guard; rm -f \"$_ccc_candidate\" 2>/dev/null || true; eval 'exec 8<&-' 2>/dev/null || true; }",
        "_ccc_on_signal() { _ccc_signal_status=$1; trap - EXIT HUP INT TERM; wait 2>/dev/null || true; [ \"${_ccc_cleanup_refused:-0}\" != 1 ] || exit 79; _ccc_unlock; exit \"$_ccc_signal_status\"; }",
        "trap 'if [ \"${_ccc_cleanup_refused:-0}\" != 1 ]; then _ccc_unlock; fi' EXIT",
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
        `_ccc_scope_run ${token} ${shellEscapeArg(body)} _ccc_on_signal`,
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
        [
            "if [ -d \"$_ccc_sessions\" ]; then for _ccc_marker in \"$_ccc_sessions\"/*; do",
            "_ccc_assert_sessions || exit 74;",
            "if [ ! -e \"$_ccc_marker\" ] && [ ! -L \"$_ccc_marker\" ]; then continue; fi;",
            "if [ ! -f \"$_ccc_marker\" ] || [ -L \"$_ccc_marker\" ] || [ ! -O \"$_ccc_marker\" ]; then _ccc_active=1; continue; fi;",
            "if ! read -r _ccc_expiry _ccc_other_container_id < \"$_ccc_marker\" 2>/dev/null; then _ccc_active=1; continue; fi;",
            "case \"$_ccc_expiry\" in ''|*[!0-9]*) _ccc_active=1; continue ;; esac;",
            "if [ \"$_ccc_expiry\" -ge \"$_ccc_now\" ] 2>/dev/null; then _ccc_active=1;",
            "elif [ \"$_ccc_expiry\" -lt \"$_ccc_now\" ] 2>/dev/null; then rm -f \"$_ccc_marker\";",
            "else _ccc_active=1; fi;",
            "done; _ccc_assert_sessions || exit 74; fi",
        ].join(" "),
        "if [ \"$_ccc_active\" -ne 0 ]; then echo ccc-remote-sessions-active; exit 42; fi",
        `docker stop "$_ccc_container_id"`,
    ].join("; "));
}

/** Receiving-host no-reclaim subset of the native codex-state shared claim protocol. */
export function remoteRuntimeBindAuthorityShell(body: string, lifecycleHeld = false): string {
    const token = randomBytes(16).toString("hex");
    const scope = [
        "set -eu",
        "umask 077",
        `_ccc_bind_token=${token}`,
        "_ccc_bind_owned=0",
        "_ccc_bind_candidate_owned=0",
        "_ccc_bind_identity() { stat -L -c %d:%i \"$1\" 2>/dev/null || stat -L -f %d:%i \"$1\" 2>/dev/null; }",
        "_ccc_bind_private_dir() { [ -d \"$1\" ] && [ ! -L \"$1\" ] && [ -O \"$1\" ] || return 1; _ccc_bind_mode=$(stat -c %a \"$1\" 2>/dev/null || stat -f %Lp \"$1\" 2>/dev/null) || return 1; case \"$_ccc_bind_mode\" in ''|*[!0-7]*) return 1 ;; esac; [ $((0$_ccc_bind_mode & $2)) -eq 0 ]; }",
        "_ccc_bind_private_file() { [ -f \"$1\" ] && [ ! -L \"$1\" ] && [ -O \"$1\" ] || return 1; _ccc_bind_meta=$(stat -c '%a:%h:%s' \"$1\" 2>/dev/null || stat -f '%Lp:%l:%z' \"$1\" 2>/dev/null) || return 1; case \"$_ccc_bind_meta\" in ''|*[!0-9:]*|:*|*::*) return 1 ;; esac; _ccc_bind_mode=${_ccc_bind_meta%%:*}; _ccc_bind_rest=${_ccc_bind_meta#*:}; _ccc_bind_links=${_ccc_bind_rest%%:*}; _ccc_bind_size=${_ccc_bind_rest#*:}; [ $((0$_ccc_bind_mode & 077)) -eq 0 ] && [ \"$_ccc_bind_links\" -eq 1 ] && [ \"$_ccc_bind_size\" -le \"$2\" ]; }",
        // BSD fdesc reopening shares the original file offset. An exact-size tail
        // seeks to zero; dd bounds concurrent growth and the trailer preserves errors.
        // Its cap includes the 16 KiB record, token and native exit status.
        "_ccc_bind_read() { LC_ALL=C; export LC_ALL",
        "_ccc_bind_read_size=$(_ccc_fd_stat %s %z <&\"${1##*/}\") || return 1",
        "case \"$_ccc_bind_read_size\" in ''|*[!0-9]*) return 1 ;; esac",
        "[ \"$_ccc_bind_read_size\" -le 16384 ] || return 1",
        "_ccc_bind_read_suffix=$(printf '\\nccc-tail-%s:0' \"$_ccc_bind_token\")",
        "_ccc_bind_read_value=$({ _ccc_bind_read_status=0; tail -c \"$_ccc_bind_read_size\" \"$1\" 2>/dev/null || _ccc_bind_read_status=$?; printf '\\nccc-tail-%s:%s' \"$_ccc_bind_token\" \"$_ccc_bind_read_status\"; } | dd bs=1 count=16440 2>/dev/null) || return 1",
        "case \"$_ccc_bind_read_value\" in *\"$_ccc_bind_read_suffix\") _ccc_bind_read_value=${_ccc_bind_read_value%\"$_ccc_bind_read_suffix\"} ;; *) return 1 ;; esac",
        "[ \"${#_ccc_bind_read_value}\" -eq \"$_ccc_bind_read_size\" ] || return 1",
        "_ccc_bind_read_after=$(_ccc_fd_stat %s %z <&\"${1##*/}\") || return 1",
        "[ \"$_ccc_bind_read_after\" = \"$_ccc_bind_read_size\" ] || return 1",
        "printf '%s' \"$_ccc_bind_read_value\"; }",
        "_ccc_bind_root=$HOME/.ccc",
        "_ccc_bind_assert_root() { _ccc_bind_private_dir \"$HOME\" 022 && _ccc_bind_private_dir \"$_ccc_bind_root\" 022 && [ \"$(_ccc_bind_identity \"$_ccc_bind_root\")\" = \"$_ccc_bind_root_identity\" ] && [ \"$(_ccc_bind_identity \"$_ccc_bind_root_bound\")\" = \"$_ccc_bind_root_identity\" ] && [ \"$(_ccc_fd_stat %d:%i %d:%i <&7)\" = \"$_ccc_bind_root_identity\" ]; }",
        "_ccc_bind_assert_directory() { _ccc_bind_assert_root && _ccc_bind_private_dir \"$_ccc_bind_directory_path\" 077 && [ \"$(_ccc_bind_identity \"$_ccc_bind_directory_path\")\" = \"$_ccc_bind_directory_identity\" ] && [ \"$(_ccc_bind_identity \"$_ccc_bind_directory_bound\")\" = \"$_ccc_bind_directory_identity\" ] && [ \"$(_ccc_fd_stat %d:%i %d:%i <&6)\" = \"$_ccc_bind_directory_identity\" ]; }",
        "_ccc_bind_no_archives() { for _ccc_bind_archive in \"$_ccc_bind_root_bound\"/codex-state.lock.*.stale \"$_ccc_bind_root_bound\"/codex-state.lock.*.release \"$_ccc_bind_root_bound\"/codex-state.lock.*.malformed; do [ ! -e \"$_ccc_bind_archive\" ] && [ ! -L \"$_ccc_bind_archive\" ] || return 1; done; }",
        "_ccc_bind_claim_matches() { _ccc_bind_assert_root && _ccc_bind_private_file \"$1\" 16384 && [ \"$(_ccc_bind_identity \"$1\")\" = \"$_ccc_bind_claim_identity\" ] && [ \"$(_ccc_fd_stat %d:%i %d:%i <&5)\" = \"$_ccc_bind_claim_identity\" ] || return 1; _ccc_bind_claim_read=$(_ccc_bind_read \"$_ccc_bind_claim_bound\") || return 1; [ \"$_ccc_bind_claim_read\" = \"$_ccc_bind_record\" ] && _ccc_bind_private_file \"$1\" 16384 && [ \"$(_ccc_bind_identity \"$1\")\" = \"$_ccc_bind_claim_identity\" ]; }",
        // A losing publisher may remove only its captured, still single-link staging inode.
        // Native admission also protects displaced .release records; never delete a raced successor.
        "_ccc_bind_release() { [ \"$_ccc_bind_owned\" -eq 1 ] || [ \"$_ccc_bind_candidate_owned\" -eq 1 ] || return 0; _ccc_refusal_empty || _ccc_refuse; [ \"${_ccc_cleanup_refused:-0}\" != 1 ] || return 74; _ccc_bind_release_status=0; if [ \"$_ccc_bind_candidate_owned\" -eq 1 ]; then _ccc_bind_candidate_owned=0; if _ccc_bind_claim_matches \"$_ccc_bind_candidate\"; then rm -f \"$_ccc_bind_candidate\" || _ccc_bind_release_status=74; fi; fi; if [ \"$_ccc_bind_owned\" -eq 1 ]; then _ccc_bind_owned=0; _ccc_bind_release_status=74; if _ccc_bind_claim_matches \"$_ccc_bind_lock\"; then _ccc_bind_release_path=$_ccc_bind_root_bound/codex-state.lock.${_ccc_bind_token%????????????????}.release; if [ ! -e \"$_ccc_bind_release_path\" ] && [ ! -L \"$_ccc_bind_release_path\" ] && mv \"$_ccc_bind_lock\" \"$_ccc_bind_release_path\"; then if _ccc_bind_claim_matches \"$_ccc_bind_release_path\" && rm -f \"$_ccc_bind_release_path\"; then _ccc_bind_release_status=0; fi; fi; fi; fi; eval 'exec 4<&- 5<&- 6<&- 7<&-' 2>/dev/null || true; return \"$_ccc_bind_release_status\"; }",
        "_ccc_bind_signal() { _ccc_bind_signal_status=$1; trap - EXIT HUP INT TERM; _ccc_bind_release || true; [ \"${_ccc_cleanup_refused:-0}\" != 1 ] || exit 79; exit \"$_ccc_bind_signal_status\"; }",
        "trap 'if [ \"${_ccc_cleanup_refused:-0}\" != 1 ]; then _ccc_bind_release; fi' EXIT",
        "trap '_ccc_bind_signal 129' HUP",
        "trap '_ccc_bind_signal 130' INT",
        "trap '_ccc_bind_signal 143' TERM",
        "for _ccc_bind_tool in stat mkdir link rm mv hostname dd tail; do command -v \"$_ccc_bind_tool\" >/dev/null 2>&1 || exit 75; done",
        "_ccc_bind_private_dir \"$HOME\" 022 || { _ccc_admission_failure global-home-private; exit 74; }",
        "if [ ! -e \"$_ccc_bind_root\" ] && [ ! -L \"$_ccc_bind_root\" ]; then mkdir \"$_ccc_bind_root\" 2>/dev/null || true; fi",
        "_ccc_bind_private_dir \"$_ccc_bind_root\" 022 || { _ccc_admission_failure global-root-private; exit 74; }",
        "eval 'exec 7<\"$_ccc_bind_root\"'",
        "if [ -d /dev/fd/7 ]; then _ccc_bind_fd_prefix=/dev/fd; elif [ -d /proc/self/fd/7 ]; then _ccc_bind_fd_prefix=/proc/self/fd; else _ccc_admission_failure global-root-fd; exit 75; fi",
        "_ccc_bind_root_identity=$(_ccc_fd_stat %d:%i %d:%i <&7) || { _ccc_admission_failure global-root-fd-identity; exit 74; }",
        "cd -P \"$_ccc_bind_root\" || { _ccc_admission_failure global-root-cd; exit 74; }",
        "[ \"$(_ccc_bind_identity .)\" = \"$_ccc_bind_root_identity\" ] || { _ccc_admission_failure global-root-cwd-identity; exit 74; }",
        "_ccc_bind_root_bound=.",
        "_ccc_bind_assert_root || { _ccc_admission_failure global-root-bound-identity; exit 74; }",
        `if [ -z "\${_ccc_refusal_descriptor:-}" ]; then _ccc_refusal_open .scope-$$-${token} 9 || exit 74; fi`,
        "_ccc_bind_lock=$_ccc_bind_root_bound/codex-state.lock",
        "[ ! -e \"$_ccc_bind_lock\" ] && [ ! -L \"$_ccc_bind_lock\" ] && _ccc_bind_no_archives || exit 73",
        "_ccc_bind_host=$(hostname) || exit 75",
        "case \"$_ccc_bind_host\" in ''|*[!a-zA-Z0-9_.-]*) exit 75 ;; esac",
        "[ \"${#_ccc_bind_host}\" -le 255 ] || exit 75",
        "_ccc_bind_record=$(printf '{\"token\":\"%s\",\"pid\":%s,\"host\":\"%s\",\"processIdentityStatus\":\"unavailable\"}' \"$_ccc_bind_token\" \"$$\" \"$_ccc_bind_host\")",
        "_ccc_bind_candidate=$_ccc_bind_root_bound/.codex-state.$_ccc_bind_token",
        "(set -C; printf '%s\\n' \"$_ccc_bind_record\" > \"$_ccc_bind_candidate\") || exit 74",
        "_ccc_bind_private_file \"$_ccc_bind_candidate\" 16384 || exit 74",
        "eval 'exec 5<\"$_ccc_bind_candidate\"'",
        "_ccc_bind_claim_bound=$_ccc_bind_fd_prefix/5",
        "_ccc_bind_claim_identity=$(_ccc_fd_stat %d:%i %d:%i <&5) || exit 74",
        "_ccc_bind_claim_matches \"$_ccc_bind_candidate\" && _ccc_bind_claim_matches \"$_ccc_bind_candidate\" || exit 75",
        "_ccc_bind_candidate_owned=1",
        "_ccc_bind_assert_root && _ccc_bind_no_archives || exit 74",
        "link \"$_ccc_bind_candidate\" \"$_ccc_bind_lock\" || exit 73",
        "_ccc_bind_owned=1",
        "rm -f \"$_ccc_bind_candidate\"",
        "_ccc_bind_candidate_owned=0",
        "_ccc_bind_claim_matches \"$_ccc_bind_lock\" && _ccc_bind_no_archives || exit 74",
        "_ccc_bind_directory_path=$_ccc_bind_root_bound/runtime-bind-authority",
        "if [ ! -e \"$_ccc_bind_directory_path\" ] && [ ! -L \"$_ccc_bind_directory_path\" ]; then mkdir \"$_ccc_bind_directory_path\" 2>/dev/null || true; fi",
        "_ccc_bind_private_dir \"$_ccc_bind_directory_path\" 077 || exit 74",
        "eval 'exec 6<\"$_ccc_bind_directory_path\"'",
        "_ccc_bind_directory_identity=$(_ccc_fd_stat %d:%i %d:%i <&6) || exit 74",
        "_ccc_bind_directory_bound=$_ccc_bind_directory_path",
        "_ccc_bind_assert_directory && _ccc_bind_claim_matches \"$_ccc_bind_lock\" && _ccc_bind_no_archives || exit 74",
        // The parent keeps claim mutations in its pinned cwd. This child pins the
        // authority directory; the root pathname below is only used for validation.
        `_ccc_scope_run ${token} ${shellEscapeArg([
            'cd -P "$_ccc_bind_directory_path" || exit 74',
            "[ \"$(_ccc_bind_identity .)\" = \"$_ccc_bind_directory_identity\" ] || exit 74",
            "_ccc_bind_root_bound=$_ccc_bind_root",
            "_ccc_bind_lock=$_ccc_bind_root/codex-state.lock",
            "_ccc_bind_directory_path=$_ccc_bind_root/runtime-bind-authority",
            "_ccc_bind_directory_bound=.",
            "_ccc_bind_marker=$_ccc_bind_directory_bound/receiving-host-incomplete",
            "if [ ! -e \"$_ccc_bind_marker\" ] && [ ! -L \"$_ccc_bind_marker\" ]; then _ccc_bind_marker_candidate=$_ccc_bind_directory_bound/.receiving-host-incomplete.$_ccc_bind_token; (set -C; printf '%s\\n' ccc-runtime-bind-authority:remote-incomplete:v1 > \"$_ccc_bind_marker_candidate\") || exit 74; _ccc_bind_private_file \"$_ccc_bind_marker_candidate\" 4096 || exit 74; link \"$_ccc_bind_marker_candidate\" \"$_ccc_bind_marker\" || exit 74; rm -f \"$_ccc_bind_marker_candidate\"; fi",
            "_ccc_bind_private_file \"$_ccc_bind_marker\" 4096 || exit 74",
            "eval 'exec 4<\"$_ccc_bind_marker\"'",
            "_ccc_bind_marker_bound=$_ccc_bind_fd_prefix/4",
            "_ccc_bind_marker_identity=$(_ccc_fd_stat %d:%i %d:%i <&4) || exit 74",
            "_ccc_bind_marker_record=$(_ccc_bind_read \"$_ccc_bind_marker_bound\") || exit 74",
            "_ccc_bind_assert() { _ccc_bind_assert_directory && _ccc_bind_no_archives && _ccc_bind_claim_matches \"$_ccc_bind_lock\" && _ccc_bind_private_file \"$_ccc_bind_marker\" 4096 && [ \"$(_ccc_bind_identity \"$_ccc_bind_marker\")\" = \"$_ccc_bind_marker_identity\" ] && [ \"$(_ccc_fd_stat %d:%i %d:%i <&4)\" = \"$_ccc_bind_marker_identity\" ] || return 1; _ccc_bind_marker_read=$(_ccc_bind_read \"$_ccc_bind_marker_bound\") || return 1; [ \"$_ccc_bind_marker_read\" = \"$_ccc_bind_marker_record\" ] && _ccc_bind_private_file \"$_ccc_bind_marker\" 4096 && [ \"$(_ccc_bind_identity \"$_ccc_bind_marker\")\" = \"$_ccc_bind_marker_identity\" ]; }",
            "_ccc_bind_assert || exit 74",
            `_ccc_scope_run ${token} ${shellEscapeArg(body)} _ccc_scope_child_exit`,
            "_ccc_bind_assert || exit 74",
        ].join("; "))} _ccc_bind_signal`,
        "_ccc_bind_release || exit 74",
    ].join("; ");
    return [
        ...(!lifecycleHeld ? [remoteScopeShell] : []),
        `_ccc_scope_run ${token} ${shellEscapeArg(scope)} _ccc_scope_child_exit`,
    ].join("; ");
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
export function remoteContainerStartScript(projectPath: string, profile?: string, lifecycleHeld = false): string {
    const projectId = getProjectId(projectPath);
    const containerName = getContainerName(projectPath, profile);
    const resolveRemoteClaudeDir = remoteClaudeDirScript(profile);
    const command = `${resolveRemoteClaudeDir}; _ccc_container_id=$(docker inspect --format ${shellEscapeArg("{{.Id}}")} ${shellEscapeArg(containerName)} 2>/dev/null || true); if [ -n "$_ccc_container_id" ]; then _ccc_bind_assert || exit 74; docker start "$_ccc_container_id" >/dev/null; else
        _ccc_remote_image=$(docker image inspect ${shellEscapeArg(IMAGE_NAME)} --format '{{.Id}}') || exit 1
        [ "\${#_ccc_remote_image}" -eq 71 ] && printf '%s\\n' "$_ccc_remote_image" | grep -Eq '^sha256:[a-f0-9]{64}$' || { echo 'Invalid remote image ID' >&2; exit 1; }
        _ccc_bind_assert || exit 74
        _ccc_mise_identity=$(docker run --rm --network none --entrypoint /bin/sh "$_ccc_remote_image" -c 'set -e; printf "%s-%s" "$(id -u)" "$(id -g)"') || exit 1
        case "$_ccc_mise_identity" in ''|*[!0-9-]*) echo 'Invalid remote image identity' >&2; exit 1;; esac
        printf '%s\\n' "$_ccc_mise_identity" | grep -Eq '^[0-9]+-[0-9]+$' || { echo 'Invalid remote image identity' >&2; exit 1; }
        _ccc_bind_assert || exit 74
        _ccc_container_id=$(docker run -d --name ${containerName} \
        --network host \
        -v "$_ccc_claude_dir:/home/ccc/.claude" \
        -v "${MISE_VOLUME_NAME}-v${IDENTITY_CONTRACT_VERSION}-remote-$_ccc_mise_identity:/home/ccc/.local/share/mise" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -w /project/${projectId} \
        --pids-limit ${CONTAINER_PID_LIMIT} \
        "$_ccc_remote_image" sleep infinity); fi`;
    return `_ccc_container_id=$( ${remoteRuntimeBindAuthorityShell(`${command}; printf '%s\\n' "$_ccc_container_id"`, lifecycleHeld)} )`;
}
