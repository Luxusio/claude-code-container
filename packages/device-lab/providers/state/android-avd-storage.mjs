import { randomBytes } from "crypto";
import { existsSync, lstatSync, mkdirSync, promises as asyncFs, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";

function comparablePath(path, platform = process.platform) {
    const normalized = resolve(path);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fileIdentity(metadata) {
    return { dev: metadata.dev, ino: metadata.ino };
}

function matchesIdentity(metadata, identity) {
    return !metadata.isSymbolicLink()
        && metadata.dev === identity.dev
        && metadata.ino === identity.ino;
}

function assertDirectory(path, label, metadata) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${label} is not a stable directory: ${path}`);
    }
}

function directoryIdentity(path, label, metadata, canonical, options) {
    if (comparablePath(canonical, options.platform) !== comparablePath(path, options.platform)) {
        throw new Error(`${label} traverses a symbolic or reparse path: ${path}`);
    }
    return { path: canonical, ...fileIdentity(metadata) };
}

function stableDirectory(path, label, options = {}) {
    if (!existsSync(path)) return false;
    const metadata = lstatSync(path);
    assertDirectory(path, label, metadata);
    return directoryIdentity(path, label, metadata, realpathSync.native(path), options);
}

function sameIdentity(path, identity) {
    return matchesIdentity(lstatSync(path), identity);
}

function pathWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function decodeMountPoints(contents) {
    const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    return new Set(contents
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[4])
        .filter(Boolean)
        .map((path) => resolve(decode(path))));
}

function linuxMountPoints() {
    return process.platform === "linux"
        ? decodeMountPoints(readFileSync("/proc/self/mountinfo", "utf8")) : new Set();
}

function assertSafeRemovalPath(path, metadata, canonical, rootIdentity, mountPoints, options) {
    if (metadata.isSymbolicLink()) {
        throw new Error(`refusing symbolic Android AVD cleanup path: ${path}`);
    }
    if (comparablePath(canonical, options.platform) !== comparablePath(path, options.platform)) {
        throw new Error(`refusing reparse Android AVD cleanup path: ${path}`);
    }
    if (mountPoints.has(resolve(path))) {
        throw new Error(`refusing mounted Android AVD cleanup path: ${path}`);
    }
    if (metadata.dev !== rootIdentity.dev) {
        throw new Error(`refusing cross-filesystem Android AVD cleanup path: ${path}`);
    }
}

function assertSafeRemovalTree(path, rootIdentity, mountPoints, options = {}) {
    const pending = [path];
    while (pending.length > 0) {
        const current = pending.pop();
        const metadata = lstatSync(current);
        // Avoid resolving a symbolic target, including a broken link.
        const canonical = metadata.isSymbolicLink() ? current : realpathSync.native(current);
        assertSafeRemovalPath(current, metadata, canonical, rootIdentity, mountPoints, options);
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

function artifactCandidate(root, entry, ownerId, options) {
    const match = /^(.*?)(\.avd|\.ini)$/.exec(entry.name);
    const quarantineMatch = /^\.ccc-avd-delete-(.+)-([a-f0-9]{32})$/.exec(entry.name);
    const name = match?.[1] || quarantineMatch?.[1];
    if (!name || !ownedAndroidAvdName(name, ownerId, options.suffixPattern)) return null;
    const path = resolve(root, entry.name);
    if (!pathWithin(root, path) || path === root) {
        throw new Error(`Android AVD artifact escaped its storage root: ${entry.name}`);
    }
    return { name, path, extension: match?.[2], quarantine: Boolean(quarantineMatch) };
}

function admitArtifact(names, candidate, metadata, canonical, root, rootIdentity, mountPoints, options) {
    const { name, path, extension, quarantine } = candidate;
    if (metadata.isSymbolicLink()) {
        throw new Error(`refusing symbolic Android AVD artifact: ${path}`);
    }
    if (comparablePath(canonical, options.platform) !== comparablePath(path, options.platform)) {
        throw new Error(`refusing reparse Android AVD artifact: ${path}`);
    }
    if (mountPoints.has(resolve(path))) {
        throw new Error(`refusing mounted Android AVD artifact: ${path}`);
    }
    if (metadata.dev !== rootIdentity.dev) {
        throw new Error(`refusing cross-filesystem Android AVD artifact: ${path}`);
    }
    if (extension === ".avd" && !metadata.isDirectory()) {
        throw new Error(`Android AVD data artifact is not a directory: ${path}`);
    }
    if (extension === ".ini" && !metadata.isFile()) {
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
    const identity = fileIdentity(metadata);
    if (quarantine) {
        record.quarantines.push({ path, identity });
    } else if (extension === ".avd") {
        record.dataPath = path;
        record.dataIdentity = identity;
    } else {
        record.iniPath = path;
        record.iniIdentity = identity;
    }
    names.set(name, record);
}

export function listOwnedAndroidAvdArtifacts(ownerId, options = {}) {
    const root = androidAvdHome(options);
    const rootIdentity = stableDirectory(root, "Android AVD home", options);
    if (!rootIdentity) return [];
    const mountPoints = options.mountPoints || linuxMountPoints();
    const names = new Map();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const candidate = artifactCandidate(root, entry, ownerId, options);
        if (!candidate) continue;
        const metadata = lstatSync(candidate.path);
        const canonical = metadata.isSymbolicLink() ? candidate.path : realpathSync.native(candidate.path);
        admitArtifact(names, candidate, metadata, canonical, root, rootIdentity, mountPoints, options);
    }
    return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function artifactSources(artifact) {
    return [
        { path: artifact.iniPath, identity: artifact.iniIdentity, stagedName: "registration.ini" },
        { path: artifact.dataPath, identity: artifact.dataIdentity, stagedName: "data.avd" },
    ].filter((entry) => entry.path);
}

function assertInactive(inactive, name, phase) {
    if (inactive !== true) throw new Error(`Android AVD became active ${phase}: ${name}`);
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
            if (options.verifyInactive) assertInactive(options.verifyInactive(name), name, "before quarantine cleanup");
            assertSafeRemovalTree(quarantine.path, artifact.rootIdentity, mountPoints, options);
            rmSync(quarantine.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (existsSync(quarantine.path)) {
                throw new Error(`Android AVD quarantine remained after cleanup: ${quarantine.path}`);
            }
            removed += 1;
        }
        const sources = artifactSources(artifact);
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
                if (!sameIdentity(artifact.root, artifact.rootIdentity)) {
                    throw new Error(`Android AVD became active during cleanup: ${name}`);
                }
                if (options.verifyInactive) assertInactive(options.verifyInactive(name), name, "during cleanup");
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

async function pathMetadata(path) {
    try {
        return await asyncFs.lstat(path);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
    }
}

async function stableDirectoryAsync(path, label, options = {}) {
    const metadata = await pathMetadata(path);
    if (!metadata) return false;
    assertDirectory(path, label, metadata);
    const identity = directoryIdentity(path, label, metadata, await asyncFs.realpath(path), options);
    if (!await sameIdentityAsync(path, identity, options)) {
        throw new Error(`${label} identity changed during observation: ${path}`);
    }
    return identity;
}

async function sameIdentityAsync(path, identity, options = {}) {
    const metadata = await pathMetadata(path);
    if (!metadata || !matchesIdentity(metadata, identity)) return false;
    try {
        if (comparablePath(await asyncFs.realpath(path), options.platform)
            !== comparablePath(path, options.platform)) return false;
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
    }
    const current = await pathMetadata(path);
    return Boolean(current && matchesIdentity(current, identity));
}

async function linuxMountPointsAsync() {
    return process.platform === "linux"
        ? decodeMountPoints(await asyncFs.readFile("/proc/self/mountinfo", "utf8")) : new Set();
}

async function assertSafeRemovalTreeAsync(path, rootIdentity, mountPoints, options) {
    const pending = [path];
    while (pending.length > 0) {
        const current = pending.pop();
        const metadata = await asyncFs.lstat(current);
        const canonical = metadata.isSymbolicLink() ? current : await asyncFs.realpath(current);
        assertSafeRemovalPath(current, metadata, canonical, rootIdentity, mountPoints, options);
        if (metadata.isDirectory()) {
            for (const entry of await asyncFs.readdir(current)) {
                const child = resolve(current, entry);
                if (!pathWithin(current, child) || child === current) {
                    throw new Error(`Android AVD cleanup path escaped its parent: ${entry}`);
                }
                pending.push(child);
            }
        }
        if (!await sameIdentityAsync(current, fileIdentity(metadata), options)) {
            throw new Error(`Android AVD cleanup path identity changed during observation: ${current}`);
        }
    }
}

async function assertArtifactIdentitiesAsync(artifact, entries, options) {
    if (!await sameIdentityAsync(artifact.root, artifact.rootIdentity, options)) {
        throw new Error(`Android AVD storage identity changed before cleanup: ${artifact.root}`);
    }
    for (const entry of entries) {
        if (!await sameIdentityAsync(entry.path, entry.identity, options)) {
            throw new Error(`Android AVD artifact identity changed before cleanup: ${entry.path}`);
        }
    }
    // The individual reads also yield; do not retain an earlier root admission.
    if (!await sameIdentityAsync(artifact.root, artifact.rootIdentity, options)) {
        throw new Error(`Android AVD storage identity changed before cleanup: ${artifact.root}`);
    }
}

export async function listOwnedAndroidAvdArtifactsAsync(ownerId, options = {}) {
    const root = androidAvdHome(options);
    const rootIdentity = await stableDirectoryAsync(root, "Android AVD home", options);
    if (!rootIdentity) return [];
    const mountPoints = options.mountPoints || await linuxMountPointsAsync();
    const names = new Map();
    for (const entry of await asyncFs.readdir(root, { withFileTypes: true })) {
        const candidate = artifactCandidate(root, entry, ownerId, options);
        if (!candidate) continue;
        const metadata = await asyncFs.lstat(candidate.path);
        const canonical = metadata.isSymbolicLink() ? candidate.path : await asyncFs.realpath(candidate.path);
        admitArtifact(names, candidate, metadata, canonical, root, rootIdentity, mountPoints, options);
        await assertArtifactIdentitiesAsync({ root, rootIdentity }, [
            { path: candidate.path, identity: fileIdentity(metadata) },
        ], options);
    }
    const artifacts = [...names.values()];
    await assertArtifactIdentitiesAsync({ root, rootIdentity }, artifacts.flatMap((artifact) => [
        ...artifact.quarantines, ...artifactSources(artifact),
    ]), options);
    return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

// Keep this finite fence next to native mutation dispatch, with no intervening
// JavaScript await. Tree walks stay async; this closes yielded identity/absence
// observations without promising atomic protection against external OS races.
function assertNativeMutationFence(artifact, entries, options, destination) {
    for (const current of [
        { path: artifact.root, identity: artifact.rootIdentity },
        ...entries,
    ]) {
        if (!sameIdentity(current.path, current.identity)
            || comparablePath(realpathSync.native(current.path), options.platform)
                !== comparablePath(current.path, options.platform)) {
            throw new Error(`Android AVD artifact identity changed before mutation: ${current.path}`);
        }
    }
    if (destination) {
        // A broken symbolic successor is still an occupied lexical destination.
        try {
            lstatSync(destination);
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        throw new Error(`Android AVD mutation destination is occupied: ${destination}`);
    }
}

async function rollbackStagedArtifacts(artifact, quarantine, quarantineIdentity, staged, options) {
    for (const entry of [...staged].reverse()) {
        try {
            await assertArtifactIdentitiesAsync(artifact, [
                { path: quarantine, identity: quarantineIdentity },
                { path: entry.stagedPath, identity: entry.identity },
            ], options);
            // A successor at the original path owns that path; never replace it.
            if (!await pathMetadata(entry.originalPath)) {
                assertNativeMutationFence(artifact, [
                    { path: quarantine, identity: quarantineIdentity },
                    { path: entry.stagedPath, identity: entry.identity },
                ], options, entry.originalPath);
                await asyncFs.rename(entry.stagedPath, entry.originalPath);
            }
        } catch {
            // Retain unproven/replaced entries for recovery and the primary error.
        }
    }
    try {
        await assertArtifactIdentitiesAsync(artifact, [{ path: quarantine, identity: quarantineIdentity }], options);
        if ((await asyncFs.readdir(quarantine)).length === 0) {
            await assertArtifactIdentitiesAsync(artifact, [{ path: quarantine, identity: quarantineIdentity }], options);
            // rmdir refuses new contents added after the emptiness observation.
            assertNativeMutationFence(artifact, [{ path: quarantine, identity: quarantineIdentity }], options);
            await asyncFs.rmdir(quarantine);
        }
    } catch {
        // Refusal leaves the owned quarantine available to a later cleanup.
    }
}

export async function removeOwnedAndroidAvdArtifactsAsync(name, ownerId, options = {}) {
    if (!ownedAndroidAvdName(name, ownerId, options.suffixPattern)) {
        throw new Error(`refusing non-owned Android AVD artifact cleanup: ${name}`);
    }
    const mountPoints = options.mountPoints || await linuxMountPointsAsync();
    const matching = (await listOwnedAndroidAvdArtifactsAsync(ownerId, { ...options, mountPoints }))
        .filter((artifact) => artifact.name === name);
    let removed = 0;
    for (const artifact of matching) {
        const sources = artifactSources(artifact);
        const captured = [...artifact.quarantines, ...sources];
        if (options.verifyInactive) assertInactive(await options.verifyInactive(name), name, "before cleanup");
        await assertArtifactIdentitiesAsync(artifact, captured, options);
        for (const quarantine of artifact.quarantines) {
            if (options.verifyInactive) {
                assertInactive(await options.verifyInactive(name), name, "before quarantine cleanup");
            }
            await assertArtifactIdentitiesAsync(artifact, [quarantine], options);
            await assertSafeRemovalTreeAsync(quarantine.path, artifact.rootIdentity, mountPoints, options);
            await assertArtifactIdentitiesAsync(artifact, [quarantine], options);
            assertNativeMutationFence(artifact, [quarantine], options);
            await asyncFs.rm(quarantine.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            await assertArtifactIdentitiesAsync(artifact, [], options);
            if (await pathMetadata(quarantine.path)) {
                throw new Error(`Android AVD quarantine remained after cleanup: ${quarantine.path}`);
            }
            removed += 1;
        }
        if (sources.length === 0) continue;
        const quarantine = resolve(artifact.root, `.ccc-avd-delete-${name}-${randomBytes(16).toString("hex")}`);
        if (!pathWithin(artifact.root, quarantine) || await pathMetadata(quarantine)) {
            throw new Error("Android AVD quarantine path is unavailable");
        }
        await assertArtifactIdentitiesAsync(artifact, sources, options);
        assertNativeMutationFence(artifact, sources, options, quarantine);
        await asyncFs.mkdir(quarantine);
        const quarantineIdentity = await asyncFs.lstat(quarantine);
        // Never remove a path through a root that changed during mkdir/lstat.
        await assertArtifactIdentitiesAsync(artifact, [], options);
        if (!quarantineIdentity.isDirectory() || quarantineIdentity.isSymbolicLink()
            || quarantineIdentity.dev !== artifact.rootIdentity.dev) {
            throw new Error("Android AVD quarantine directory is invalid");
        }
        const staged = [];
        const stagedEntries = () => [
            { path: quarantine, identity: quarantineIdentity },
            ...staged.map((entry) => ({ path: entry.stagedPath, identity: entry.identity })),
        ];
        try {
            for (const source of sources) {
                await assertArtifactIdentitiesAsync(artifact, [...stagedEntries(), source], options);
                await assertSafeRemovalTreeAsync(source.path, artifact.rootIdentity, mountPoints, options);
                const stagedPath = resolve(quarantine, source.stagedName);
                if (!pathWithin(quarantine, stagedPath) || await pathMetadata(stagedPath)) {
                    throw new Error("Android AVD staged artifact path is unavailable");
                }
                await assertArtifactIdentitiesAsync(artifact, [...stagedEntries(), source], options);
                assertNativeMutationFence(artifact, [...stagedEntries(), source], options, stagedPath);
                await asyncFs.rename(source.path, stagedPath);
                staged.push({ originalPath: source.path, stagedPath, identity: source.identity });
                await assertArtifactIdentitiesAsync(artifact, stagedEntries(), options);
                await options.onArtifactQuarantined?.({
                    name, originalPath: source.path, quarantinePath: stagedPath,
                });
                await assertArtifactIdentitiesAsync(artifact, stagedEntries(), options);
            }
            if (options.verifyInactive) assertInactive(await options.verifyInactive(name), name, "during cleanup");
            await assertArtifactIdentitiesAsync(artifact, stagedEntries(), options);
            await assertSafeRemovalTreeAsync(quarantine, artifact.rootIdentity, mountPoints, options);
            await assertArtifactIdentitiesAsync(artifact, stagedEntries(), options);
            assertNativeMutationFence(artifact, stagedEntries(), options);
            await asyncFs.rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
            await rollbackStagedArtifacts(artifact, quarantine, quarantineIdentity, staged, options);
            throw error;
        }
        await assertArtifactIdentitiesAsync(artifact, [], options);
        if (await pathMetadata(quarantine)) {
            throw new Error(`Android AVD quarantine remained after cleanup: ${name}`);
        }
        removed += sources.length;
    }
    const remaining = (await listOwnedAndroidAvdArtifactsAsync(ownerId, options))
        .filter((artifact) => artifact.name === name);
    for (const artifact of matching) await assertArtifactIdentitiesAsync(artifact, [], options);
    if (remaining.length > 0) {
        throw new Error(`Android AVD artifacts reappeared after cleanup: ${name}`);
    }
    return { name, root: androidAvdHome(options), removed };
}
