import { closeSync, ftruncateSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLabTestHomeEnvironment } from "./device-lab-test-environment.js";

/** Keep real Git fixtures independent of the developer's Git configuration. */
export function isolateGitFixture(home: string): () => void {
    const homeEnvironment = deviceLabTestHomeEnvironment(home);
    const overrides = Object.fromEntries(Object.entries(homeEnvironment)
        .filter(([key]) => !["TMPDIR", "TMP", "TEMP"].includes(key)));
    Object.assign(overrides, {
        XDG_CONFIG_HOME: join(home, ".config"),
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
    });
    writeFileSync(overrides.GIT_CONFIG_GLOBAL, "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = master\n");
    const keys = new Set([...Object.keys(overrides), ...Object.keys(process.env).filter(key => /^GIT_CONFIG(?:_|$)/i.test(key))]);
    const previous = new Map([...keys].map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, overrides);
    return () => {
        for (const key of Object.keys(process.env)) if (/^GIT_CONFIG(?:_|$)/i.test(key)) delete process.env[key];
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

/** Git for Windows emits slash paths in porcelain and administrative files. */
export function gitFixturePath(path: string): string {
    return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/** Replace owned fixture bytes in place, including a hidden native Windows .git. */
export function overwriteGitFixtureFile(path: string, contents: string | Buffer): void {
    const descriptor = openSync(path, "r+");
    try {
        writeFileSync(descriptor, contents);
        ftruncateSync(descriptor, Buffer.byteLength(contents));
    } finally {
        closeSync(descriptor);
    }
}
