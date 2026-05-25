#!/bin/bash
# scripts/ccc-entrypoint.sh — container entrypoint that sets up iptables NAT
# REDIRECT and the ccc-proxy daemon once, at container start, before any user
# command runs.
#
# Why this runs in the entrypoint instead of via `docker exec` from the host:
#   1. iptables runs exactly once per container lifetime — no xtables-lock
#      race with the host-side `docker exec` callers that the old flow had.
#   2. Failures are loud: an unrecoverable iptables error kills entrypoint,
#      which kills the container — visible via `docker logs` instead of being
#      silently swallowed mid-session.
#   3. sudo's PAM init cost is paid once at container start instead of every
#      `ccc` invocation.
#
# Behavior is gated by CCC_PROXY_ENABLED=1 so native-Linux containers (where
# --network host already gives direct host reach) pay zero cost. The CLI is
# responsible for injecting this env var only on Docker Desktop / WSL2 /
# podman-machine flavors.
#
# The script runs as the Dockerfile's USER (ccc, uid 1000) and elevates via
# the passwordless sudo configured in LAYER 5 of the Dockerfile.

set -euo pipefail

PROXY_PORT="${CCC_PROXY_PORT:-19999}"
PROXY_USER="${CCC_PROXY_USER:-ccc-proxy}"
PROXY_DAEMON="${CCC_PROXY_DAEMON:-/usr/local/bin/ccc-proxy}"
MAX_ATTEMPTS="${CCC_IPTABLES_MAX_ATTEMPTS:-3}"
INITIAL_BACKOFF_MS="${CCC_IPTABLES_INITIAL_BACKOFF_MS:-200}"
LOCK_WAIT_SEC="${CCC_IPTABLES_LOCK_WAIT_SEC:-2}"

# Every line emitted by this entrypoint starts with `[ccc-entrypoint]` so it
# is greppable in `docker logs` and never collides with the user command's
# own output. Phase-timing lines additionally carry a `[timing]` infix.
log() { printf '[ccc-entrypoint] %s\n' "$*" >&2; }
log_timing() { printf '[ccc-entrypoint] [timing] %s\n' "$*" >&2; }

now_ms() {
    # bash 5.x exposes EPOCHREALTIME with microsecond resolution; fall back
    # to `date` for older shells.
    if [ -n "${EPOCHREALTIME:-}" ]; then
        local v="${EPOCHREALTIME//./}"
        printf '%s' "${v%???}"
    else
        date +%s%3N
    fi
}

# Pretty-print a millisecond count. Sub-second stays in ms for precision;
# longer durations switch to seconds so a 30000ms hang reads as "30.0s".
format_duration() {
    local ms="$1"
    if [ "$ms" -lt 1000 ]; then
        printf '%dms' "$ms"
    else
        awk -v ms="$ms" 'BEGIN{printf "%.2fs", ms/1000}'
    fi
}

# Run a labelled phase, capture its duration. Per-phase timing is only
# emitted when CCC_DEBUG_TIMING=1 — the always-on summary at the end of
# main() is enough for normal operation.
timed() {
    local label="$1"; shift
    local t0 t1 rc
    t0=$(now_ms)
    if "$@"; then rc=0; else rc=$?; fi
    t1=$(now_ms)
    if [ "${CCC_DEBUG_TIMING:-0}" = "1" ]; then
        log_timing "${label}=$(format_duration $((t1 - t0)))"
    fi
    return "$rc"
}

setup_iptables() {
    if ! id -u "${PROXY_USER}" >/dev/null 2>&1; then
        log "ERROR: '${PROXY_USER}' user missing — cannot set up proxy"
        return 1
    fi

    # Idempotent: if the rule is already in place (container restart, retry),
    # nothing to do.
    if sudo -n iptables -w "${LOCK_WAIT_SEC}" -t nat -C OUTPUT \
            -p tcp -d 127.0.0.1 \
            -m owner ! --uid-owner "${PROXY_USER}" \
            -j REDIRECT --to-ports "${PROXY_PORT}" 2>/dev/null; then
        log "iptables NAT rule already present"
        return 0
    fi

    local attempt=1
    local backoff_ms="${INITIAL_BACKOFF_MS}"
    while [ "${attempt}" -le "${MAX_ATTEMPTS}" ]; do
        if sudo -n iptables -w "${LOCK_WAIT_SEC}" -t nat -A OUTPUT \
                -p tcp -d 127.0.0.1 \
                -m owner ! --uid-owner "${PROXY_USER}" \
                -j REDIRECT --to-ports "${PROXY_PORT}"; then
            log "iptables NAT rule added (attempt ${attempt})"
            return 0
        fi
        local rc=$?
        log "iptables attempt ${attempt} failed (exit ${rc})"
        if [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; then
            # Convert milliseconds → fractional seconds for sleep.
            sleep "$(awk -v ms="${backoff_ms}" 'BEGIN{printf "%.3f", ms/1000}')"
            backoff_ms=$(( backoff_ms * 2 ))
        fi
        attempt=$(( attempt + 1 ))
    done

    log "ERROR: iptables setup failed after ${MAX_ATTEMPTS} attempts"
    return 1
}

start_proxy_daemon() {
    sudo -n -u "${PROXY_USER}" "${PROXY_DAEMON}" >/dev/null 2>&1 &
    log "ccc-proxy daemon started (pid $!)"
}

main() {
    if [ "${CCC_PROXY_ENABLED:-0}" = "1" ]; then
        log "configuring localhost proxy"
        local t0 t1
        t0=$(now_ms)
        if ! timed iptables_setup setup_iptables; then
            exit 1
        fi
        timed proxy_daemon start_proxy_daemon
        t1=$(now_ms)
        log "proxy setup complete in $(format_duration $((t1 - t0)))"
    else
        log "CCC_PROXY_ENABLED unset — skipping proxy setup"
    fi
    exec "$@"
}

main "$@"
