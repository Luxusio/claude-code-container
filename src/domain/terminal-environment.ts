const TERMINAL_KEYS = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORFGBG"] as const;

/** Terminal capabilities apply to a TTY session, independently of generic host env forwarding. */
export function terminalEnvironment(
    host: Readonly<Record<string, string | undefined>>,
    platform: string,
    overrides: readonly (readonly [string, string])[] = [],
): Array<[string, string]> {
    const supplied = new Set(overrides.map(([key]) => key));
    const values = new Map<string, string>();
    for (const key of TERMINAL_KEYS) {
        const value = host[key];
        // Capability identifiers are small argv values, never control sequences.
        if (value !== undefined && value !== "" && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)) values.set(key, value);
    }
    const modernWindows = platform === "win32"
        && (Boolean(host.WT_SESSION) || /^(?:vscode|Windows_Terminal|WezTerm|Hyper)$/i.test(host.TERM_PROGRAM ?? ""));
    // Windows terminals do not consistently publish Unix capability variables.
    // Respect an explicit session TERM override, including TERM=dumb.
    if (modernWindows && !supplied.has("TERM")) {
        if (!values.has("TERM") || values.get("TERM") === "dumb") values.set("TERM", "xterm-256color");
        if (!values.has("COLORTERM")) values.set("COLORTERM", "truecolor");
    }
    return [...values].filter(([key]) => !supplied.has(key));
}
