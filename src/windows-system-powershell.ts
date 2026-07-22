import { lstatSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

const WINDOWS_SYSTEM_POWERSHELL_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export function spawnableWindowsExecutablePath(path: string): string | null {
    if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
    if (/^[A-Za-z]:\\/.test(path)) return path;
    return null;
}

function assertPlainDirectoryPath(path: string): void {
    let current = resolve(path);
    while (true) {
        const metadata = lstatSync(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("windows-system-directory-invalid");
        const parent = dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

export function canonicalWindowsPowerShellPath(testSystemRoot?: string): string | null {
    const candidate = testSystemRoot
        ? join(resolve(testSystemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : WINDOWS_SYSTEM_POWERSHELL_PATH;
    try {
        assertPlainDirectoryPath(dirname(candidate));
        const source = lstatSync(candidate);
        if (!source.isFile() || source.isSymbolicLink()) return null;
        const resolved = realpathSync.native(candidate);
        const executable = testSystemRoot ? resolved : spawnableWindowsExecutablePath(resolved);
        if (!executable) return null;
        assertPlainDirectoryPath(dirname(executable));
        const target = lstatSync(executable);
        return target.isFile() && !target.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}
