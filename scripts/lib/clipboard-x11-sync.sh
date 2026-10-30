# X11 synchronization application. Native leaf functions retain bytes and effects.
clipboard_x11_sync_init() {
    initialized=0
    last_host_sig=""
    last_local_sig=""
}

clipboard_x11_sync_apply_host() {
    bridge_apply_host || return 1
    last_host_sig=$host_sig
    if [ "$host_mode" = UTF8_STRING ]; then
        last_local_sig=$host_sig
    else
        last_local_sig=unavailable
    fi
}

clipboard_x11_sync_cycle() {
    local local_result=0 local_sig restore_missing=0
    if [ "$initialized" = 0 ]; then
        # A restarted container must not publish its stale X11 selection.
        bridge_read_host && clipboard_x11_sync_apply_host || return 1
        initialized=1
        return 0
    fi

    bridge_read_local || local_result=$?
    [ "$local_result" != 2 ] || return 1
    if [ "$local_result" = 0 ]; then
        local_sig="$(bridge_local_signature)"
        if [ "$local_sig" != "$last_local_sig" ]; then
            bridge_upload_local || return 1
            # Advance both baselines; do not echo this upload into X11.
            last_local_sig=$local_sig
            last_host_sig=$local_sig
            return 0
        fi
    fi

    bridge_read_host || return 1
    if [ "$host_sig" = "$last_host_sig" ]; then
        # A dead owner or restarted X server loses its selection even though
        # the host bytes did not change. Nontext or unreadable owners remain.
        bridge_selection_owner_absent || return 0
        restore_missing=1
    fi
    if [ "$host_sig" != "$last_host_sig" ] || [ "$restore_missing" = 1 ]; then
        # Host polling can take seconds. Keep a local copy made during that
        # request for publication on the next cycle instead of overwriting it.
        local_result=0
        bridge_read_local || local_result=$?
        [ "$local_result" != 2 ] || return 1
        if [ "$local_result" = 0 ]; then
            local_sig="$(bridge_local_signature)"
            [ "$local_sig" = "$last_local_sig" ] || return 1
        fi
        if [ "$restore_missing" = 1 ]; then bridge_selection_owner_absent || return 1; fi
        clipboard_x11_sync_apply_host || return 1
    fi
}

