// eslint-disable-next-line n/no-unsupported-features/node-builtins -- The existing fixture copy API is available, experimentally, on supported Node 20.19.
import { chmodSync, cpSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Copy source into a fresh private fixture that may replace its own files. */
export function copyWritableTestTree(source: string, destination: string, options?: Parameters<typeof cpSync>[2]): void {
    if (existsSync(destination)) throw new Error("Fixture copy destination must be fresh");
    cpSync(source, destination, options);
    function makeOwnedCopyWritable(origin: string, path: string): void {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) return;
        chmodSync(path, (lstatSync(origin).mode & 0o777) | (info.isDirectory() ? 0o700 : 0o600));
        if (info.isDirectory()) for (const name of readdirSync(path)) makeOwnedCopyWritable(join(origin, name), join(path, name));
    }
    makeOwnedCopyWritable(source, destination);
}
