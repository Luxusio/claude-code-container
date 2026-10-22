import { mkdirSync, realpathSync } from "node:fs";
import { join, win32 } from "node:path";

/** Override home and private temp locations, including the MCP SDK's minimal child env. */
export function deviceLabTestHomeEnvironment(homeDir: string): Record<string, string> {
    const temporary = join(homeDir, ".tmp");
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const tempRoot = realpathSync(temporary);
    const drive = win32.parse(homeDir).root.replace(/[\\/]$/, "");
    return {
        HOME: homeDir,
        USERPROFILE: homeDir,
        HOMEDRIVE: /^[A-Za-z]:$/.test(drive) ? drive : "",
        HOMEPATH: /^[A-Za-z]:$/.test(drive) ? homeDir.slice(drive.length) : homeDir,
        APPDATA: join(homeDir, "AppData", "Roaming"),
        LOCALAPPDATA: join(homeDir, "AppData", "Local"),
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
    };
}

// Build controls belong to the test runner, not the device owner/profile.
const inheritedDeviceSetting = (key: string) => /^(CCC_|ANDROID_)/i.test(key) && key.toUpperCase() !== "CCC_E2E_SKIP_BUILD";

/** Isolate in-process provider state and restore the caller's exact environment. */
export function isolateDeviceLabTestEnvironment(homeDir: string): () => void {
    const overrides = deviceLabTestHomeEnvironment(homeDir);
    const keys = new Set([...Object.keys(overrides), ...Object.keys(process.env).filter(inheritedDeviceSetting)]);
    const previous = new Map([...keys].map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, overrides);
    return () => {
        for (const key of Object.keys(process.env)) if (inheritedDeviceSetting(key)) delete process.env[key];
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}
