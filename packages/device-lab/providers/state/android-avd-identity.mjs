const identityCommands = [["avd", "name"], ["avd name\navd name"]];

function decodeIdentity(serial, result) {
    if (result.status !== 0 || result.error || String(result.stderr || "").trim()) {
        return {
            ok: false,
            detail: String(result.stderr || result.stdout || result.error || `adb-exit-${result.status ?? "unknown"}`),
        };
    }
    const names = String(result.stdout || "").split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && line !== "OK");
    if (names.length === 0) return null;
    if (names.some(name => !/^[A-Za-z0-9._-]+$/.test(name)
        || /^(?:KO|ERROR|FAIL|FAILED|FAILURE)$/i.test(name)
        || name !== names[0])) {
        return { ok: false, detail: `invalid-avd-name-response-for-${serial}` };
    }
    return { ok: true, name: names[0] };
}

// Read console identity without mistaking ADB's no-auth response stripping for
// an inactive emulator. The caller supplies its existing bounded ADB runner.
export function readAndroidAvdIdentity(serial, runAdb) {
    for (const command of identityCommands) {
        const identity = decodeIdentity(serial, runAdb(["-s", serial, "emu", ...command]));
        if (identity) return identity;
    }
    return { ok: false, detail: `missing-avd-name-for-${serial}` };
}

export async function readAndroidAvdIdentityAsync(serial, runAdb) {
    for (const command of identityCommands) {
        const identity = decodeIdentity(serial, await runAdb(["-s", serial, "emu", ...command]));
        if (identity) return identity;
    }
    return { ok: false, detail: `missing-avd-name-for-${serial}` };
}
