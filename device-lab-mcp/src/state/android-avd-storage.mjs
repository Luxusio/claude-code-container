import { existsSync, lstatSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";

function stableDirectory(path, label) {
    if (!existsSync(path)) return false;
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${label} is not a stable directory: ${path}`);
    }
    return true;
}

function pathWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function androidAvdHome(options = {}) {
    const env = options.env || process.env;
    const home = options.home || homedir();
    const configured = String(env.ANDROID_AVD_HOME || "").trim();
    if (configured) return resolve(configured);
    const androidUserHome = String(env.ANDROID_USER_HOME || "").trim();
    if (androidUserHome) return resolve(androidUserHome, "avd");
    const legacySdkHome = String(env.ANDROID_SDK_HOME || "").trim();
    if (legacySdkHome) return resolve(legacySdkHome, ".android", "avd");
    return resolve(home, ".android", "avd");
}

export function ownedAndroidAvdName(name, ownerId, suffixPattern = "[A-Za-z0-9._-]+") {
    if (!/^[a-f0-9]{16}$/.test(String(ownerId || ""))) return false;
    if (typeof name !== "string" || name.length > 128) return false;
    return new RegExp(`^ccc-${ownerId}-${suffixPattern}$`).test(name);
}

export function listOwnedAndroidAvdArtifacts(ownerId, options = {}) {
    const root = androidAvdHome(options);
    if (!stableDirectory(root, "Android AVD home")) return [];
    const names = new Map();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const match = /^(.*?)(\.avd|\.ini)$/.exec(entry.name);
        if (!match || !ownedAndroidAvdName(match[1], ownerId, options.suffixPattern)) continue;
        const path = resolve(root, entry.name);
        if (!pathWithin(root, path) || path === root) {
            throw new Error(`Android AVD artifact escaped its storage root: ${entry.name}`);
        }
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) {
            throw new Error(`refusing symbolic Android AVD artifact: ${path}`);
        }
        if (match[2] === ".avd" && !metadata.isDirectory()) {
            throw new Error(`Android AVD data artifact is not a directory: ${path}`);
        }
        if (match[2] === ".ini" && !metadata.isFile()) {
            throw new Error(`Android AVD registration artifact is not a file: ${path}`);
        }
        const record = names.get(match[1]) || { name: match[1], root, dataPath: null, iniPath: null };
        if (match[2] === ".avd") record.dataPath = path;
        else record.iniPath = path;
        names.set(match[1], record);
    }
    return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function removeOwnedAndroidAvdArtifacts(name, ownerId, options = {}) {
    if (!ownedAndroidAvdName(name, ownerId, options.suffixPattern)) {
        throw new Error(`refusing non-owned Android AVD artifact cleanup: ${name}`);
    }
    const matching = listOwnedAndroidAvdArtifacts(ownerId, options).filter((artifact) => artifact.name === name);
    let removed = 0;
    for (const artifact of matching) {
        for (const path of [artifact.iniPath, artifact.dataPath]) {
            if (!path) continue;
            rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (existsSync(path)) throw new Error(`Android AVD artifact remained after cleanup: ${path}`);
            removed += 1;
        }
    }
    return { name, root: androidAvdHome(options), removed };
}
