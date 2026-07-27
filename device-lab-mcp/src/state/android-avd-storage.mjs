import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";

function comparablePath(path, platform = process.platform) {
    const normalized = resolve(path);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stableDirectory(path, label, options = {}) {
    if (!existsSync(path)) return false;
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${label} is not a stable directory: ${path}`);
    }
    const canonical = realpathSync.native(path);
    if (comparablePath(canonical, options.platform) !== comparablePath(path, options.platform)) {
        throw new Error(`${label} traverses a symbolic or reparse path: ${path}`);
    }
    return {
        path: canonical,
        dev: metadata.dev,
        ino: metadata.ino,
    };
}

function sameIdentity(path, identity) {
    const metadata = lstatSync(path);
    return !metadata.isSymbolicLink()
        && metadata.dev === identity.dev
        && metadata.ino === identity.ino;
}

function pathWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function androidAvdHome(options = {}) {
    if (options.root) return resolve(options.root);
    const env = options.env || process.env;
    const home = options.home || homedir();
    const configured = String(env.ANDROID_AVD_HOME || "").trim();
    if (configured) return resolve(configured);
    const androidUserHome = String(env.ANDROID_USER_HOME || "").trim();
    if (androidUserHome) return resolve(androidUserHome, "avd");
    const emulatorHome = String(env.ANDROID_EMULATOR_HOME || "").trim();
    if (emulatorHome) return resolve(emulatorHome, "avd");
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
    const rootIdentity = stableDirectory(root, "Android AVD home", options);
    if (!rootIdentity) return [];
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
        const record = names.get(match[1]) || {
            name: match[1],
            root,
            rootIdentity,
            dataPath: null,
            dataIdentity: null,
            iniPath: null,
            iniIdentity: null,
        };
        const identity = { dev: metadata.dev, ino: metadata.ino };
        if (match[2] === ".avd") {
            record.dataPath = path;
            record.dataIdentity = identity;
        } else {
            record.iniPath = path;
            record.iniIdentity = identity;
        }
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
        if (!sameIdentity(artifact.root, artifact.rootIdentity)) {
            throw new Error(`Android AVD storage identity changed before cleanup: ${artifact.root}`);
        }
        for (const [path, identity] of [
            [artifact.iniPath, artifact.iniIdentity],
            [artifact.dataPath, artifact.dataIdentity],
        ]) {
            if (!path) continue;
            if (!sameIdentity(artifact.root, artifact.rootIdentity)
                || !sameIdentity(path, identity)) {
                throw new Error(`Android AVD artifact identity changed before cleanup: ${path}`);
            }
            rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (existsSync(path)) throw new Error(`Android AVD artifact remained after cleanup: ${path}`);
            removed += 1;
        }
    }
    const remaining = listOwnedAndroidAvdArtifacts(ownerId, options)
        .filter((artifact) => artifact.name === name);
    if (remaining.length > 0) {
        throw new Error(`Android AVD artifacts reappeared after cleanup: ${name}`);
    }
    return { name, root: androidAvdHome(options), removed };
}
