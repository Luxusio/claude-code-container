import type { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

type PythonFixture = { executable: string; reason?: never } | { executable: null; reason: string };

/** Host fixtures need tomllib; the container's fixed Python path remains a separate contract. */
export function modernPythonFixture(spawn: typeof spawnSync, configured = process.env.CCC_TEST_PYTHON): PythonFixture {
    const candidates = configured !== undefined ? [configured] : ["python3.12", "python3.13", "python3.11", "python3"];
    for (const candidate of candidates) {
        const result = spawn(candidate, ["-c", "import json,sys,tomllib; assert sys.version_info >= (3,11); print(json.dumps(sys.executable))"], {
            encoding: "utf8", timeout: 5000, windowsHide: true, shell: false,
        });
        if (result.error || result.status !== 0 || result.signal) continue;
        try {
            const executable: unknown = JSON.parse(result.stdout as string);
            if (typeof executable === "string" && isAbsolute(executable)) return { executable };
        } catch { /* A command without a valid interpreter identity is not the fixture prerequisite. */ }
    }
    if (configured !== undefined) throw new Error(`CCC_TEST_PYTHON=${JSON.stringify(configured)} must identify a runnable Python 3.11+ interpreter with tomllib.`);
    return { executable: null, reason: "Requires a host Python 3.11+ interpreter with tomllib; set CCC_TEST_PYTHON to its executable." };
}

/** A shell launcher also supports an interpreter path containing spaces. */
export function pythonFixtureProgram(executable: string, source: string): string {
    return `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' - "$@" <<'CCC_FIXTURE_PYTHON'\n${source}\nCCC_FIXTURE_PYTHON\n`;
}
