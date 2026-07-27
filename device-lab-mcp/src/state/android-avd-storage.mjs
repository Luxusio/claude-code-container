import { randomBytes } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "fs";
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

function linuxMountPoints() {
    if (process.platform !== "linux") return new Set();
    const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    return new Set(readFileSync("/proc/self/mountinfo", "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[4])
        .filter(Boolean)
        .map((path) => resolve(decode(path))));
}

function assertSafeRemovalTree(path, rootIdentity, mountPoints, options = {}) {
    const pending = [path];
    while (pending.length > 0) {
        const current = pending.pop();
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink()) {
            throw new Error(`refusing symbolic Android AVD cleanup path: ${current}`);
        }
        if (comparablePath(realpathSync.native(current), options.platform)
            !== comparablePath(current, options.platform)) {
            throw new Error(`refusing reparse Android AVD cleanup path: ${current}`);
        }
        if (mountPoints.has(resolve(current))) {
            throw new Error(`refusing mounted Android AVD cleanup path: ${current}`);
        }
        if (metadata.dev !== rootIdentity.dev) {
            throw new Error(`refusing cross-filesystem Android AVD cleanup path: ${current}`);
        }
        if (metadata.isDirectory()) {
            for (const entry of readdirSync(current)) {
                const child = resolve(current, entry);
                if (!pathWithin(current, child) || child === current) {
                    throw new Error(`Android AVD cleanup path escaped its parent: ${entry}`);
                }
                pending.push(child);
            }
        }
    }
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
    const mountPoints = options.mountPoints || linuxMountPoints();
    const names = new Map();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const match = /^(.*?)(\.avd|\.ini)$/.exec(entry.name);
        const quarantineMatch = /^\.ccc-avd-delete-(.+)-([a-f0-9]{32})$/.exec(entry.name);
        const name = match?.[1] || quarantineMatch?.[1];
        if (!name || !ownedAndroidAvdName(name, ownerId, options.suffixPattern)) continue;
        const path = resolve(root, entry.name);
        if (!pathWithin(root, path) || path === root) {
            throw new Error(`Android AVD artifact escaped its storage root: ${entry.name}`);
        }
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) {
            throw new Error(`refusing symbolic Android AVD artifact: ${path}`);
        }
        if (comparablePath(realpathSync.native(path), options.platform) !== comparablePath(path, options.platform)) {
            throw new Error(`refusing reparse Android AVD artifact: ${path}`);
        }
        if (mountPoints.has(resolve(path))) {
            throw new Error(`refusing mounted Android AVD artifact: ${path}`);
        }
        if (metadata.dev !== rootIdentity.dev) {
            throw new Error(`refusing cross-filesystem Android AVD artifact: ${path}`);
        }
        if (match?.[2] === ".avd" && !metadata.isDirectory()) {
            throw new Error(`Android AVD data artifact is not a directory: ${path}`);
        }
        if (match?.[2] === ".ini" && !metadata.isFile()) {
            throw new Error(`Android AVD registration artifact is not a file: ${path}`);
        }
        const record = names.get(name) || {
            name,
            root,
            rootIdentity,
            dataPath: null,
            dataIdentity: null,
            iniPath: null,
            iniIdentity: null,
            quarantines: [],
        };
        const identity = { dev: metadata.dev, ino: metadata.ino };
        if (quarantineMatch) {
            record.quarantines.push({ path, identity });
        } else if (match[2] === ".avd") {
            record.dataPath = path;
            record.dataIdentity = identity;
        } else {
            record.iniPath = path;
            record.iniIdentity = identity;
        }
        names.set(name, record);
    }
    return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function removeOwnedAndroidAvdArtifacts(name, ownerId, options = {}) {
    if (!ownedAndroidAvdName(name, ownerId, options.suffixPattern)) {
        throw new Error(`refusing non-owned Android AVD artifact cleanup: ${name}`);
    }
    const mountPoints = options.mountPoints || linuxMountPoints();
    const matching = listOwnedAndroidAvdArtifacts(ownerId, options).filter((artifact) => artifact.name === name);
    let removed = 0;
    for (const artifact of matching) {
        if (!sameIdentity(artifact.root, artifact.rootIdentity)) {
            throw new Error(`Android AVD storage identity changed before cleanup: ${artifact.root}`);
        }
        for (const quarantine of artifact.quarantines) {
            if (!sameIdentity(artifact.root, artifact.rootIdentity)
                || !sameIdentity(quarantine.path, quarantine.identity)) {
                throw new Error(`Android AVD quarantine identity changed before cleanup: ${quarantine.path}`);
            }
            if (options.verifyInactive && options.verifyInactive(name) !== true) {
                throw new Error(`Android AVD became active before quarantine cleanup: ${name}`);
            }
            assertSafeRemovalTree(quarantine.path, artifact.rootIdentity, mountPoints, options);
            rmSync(quarantine.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (existsSync(quarantine.path)) {
                throw new Error(`Android AVD quarantine remained after cleanup: ${quarantine.path}`);
            }
            removed += 1;
        }
        const sources = [
            { path: artifact.iniPath, identity: artifact.iniIdentity, stagedName: "registration.ini" },
            { path: artifact.dataPath, identity: artifact.dataIdentity, stagedName: "data.avd" },
        ].filter((entry) => entry.path);
        if (sources.length > 0) {
            const quarantine = resolve(
                artifact.root,
                `.ccc-avd-delete-${name}-${randomBytes(16).toString("hex")}`,
            );
            if (!pathWithin(artifact.root, quarantine) || existsSync(quarantine)) {
                throw new Error("Android AVD quarantine path is unavailable");
            }
            mkdirSync(quarantine);
            const quarantineIdentity = lstatSync(quarantine);
            if (!quarantineIdentity.isDirectory()
                || quarantineIdentity.isSymbolicLink()
                || quarantineIdentity.dev !== artifact.rootIdentity.dev) {
                rmSync(quarantine, { recursive: true, force: true });
                throw new Error("Android AVD quarantine directory is invalid");
            }
            const staged = [];
            try {
                for (const source of sources) {
                    const { path, identity, stagedName } = source;
                    if (!sameIdentity(artifact.root, artifact.rootIdentity)
                        || !sameIdentity(path, identity)) {
                        throw new Error(`Android AVD artifact identity changed before cleanup: ${path}`);
                    }
                    assertSafeRemovalTree(path, artifact.rootIdentity, mountPoints, options);
                    const stagedPath = resolve(quarantine, stagedName);
                    if (!pathWithin(quarantine, stagedPath) || existsSync(stagedPath)) {
                        throw new Error("Android AVD staged artifact path is unavailable");
                    }
                    renameSync(path, stagedPath);
                    if (!sameIdentity(stagedPath, identity)) {
                        throw new Error(`Android AVD artifact identity changed during quarantine: ${path}`);
                    }
                    staged.push({ originalPath: path, stagedPath, identity });
                    options.onArtifactQuarantined?.({
                        name,
                        originalPath: path,
                        quarantinePath: stagedPath,
                    });
                }
                if (!sameIdentity(artifact.root, artifact.rootIdentity)
                    || options.verifyInactive && options.verifyInactive(name) !== true) {
                    throw new Error(`Android AVD became active during cleanup: ${name}`);
                }
                assertSafeRemovalTree(quarantine, artifact.rootIdentity, mountPoints, options);
                rmSync(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            } catch (error) {
                for (const entry of staged.reverse()) {
                    if (sameIdentity(artifact.root, artifact.rootIdentity)
                        && !existsSync(entry.originalPath)
                        && existsSync(entry.stagedPath)
                        && sameIdentity(entry.stagedPath, entry.identity)) {
                        renameSync(entry.stagedPath, entry.originalPath);
                    }
                }
                if (existsSync(quarantine) && readdirSync(quarantine).length === 0) {
                    rmSync(quarantine, { recursive: true, force: true });
                }
                throw error;
            }
            if (existsSync(quarantine)) {
                throw new Error(`Android AVD quarantine remained after cleanup: ${name}`);
            }
            removed += sources.length;
        }
    }
    const remaining = listOwnedAndroidAvdArtifacts(ownerId, options)
        .filter((artifact) => artifact.name === name);
    if (remaining.length > 0) {
        throw new Error(`Android AVD artifacts reappeared after cleanup: ${name}`);
    }
    return { name, root: androidAvdHome(options), removed };
}
