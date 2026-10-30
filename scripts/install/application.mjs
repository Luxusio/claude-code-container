import {
    runtimePreference, imageLabels, fingerprintFiles, fingerprintDirectories, unixPayloadCopies,
    PATH_LIMIT, selectedRuntimeOverride, normalizePathEntry, splitUserPath, isPackagedInstall,
    errorCode,
} from "./domain.mjs";
/** @typedef {{status:"ready"}|{status:"failed"}|{status:"skipped",reason:string}} ImageOutcome */
/** @param {import('./ports.mjs').InstallerPorts} ports */
export function createInstallerApplication(ports) {
    function build() {
        ports.present({ kind: "building" });
        ports.sourceBuild();
    }
    function detectRuntime() {
        const override = selectedRuntimeOverride(ports.runtimeOverride());
        if (override) return override;
        for (const runtime of runtimePreference) {
            if (ports.runtimeAvailable(runtime)) return runtime;
        }
        return null;
    }
    /** @param {import('./ports.mjs').InstallerRuntime} runtime */
    function getImageHash(runtime) {
        try {
            for (const label of imageLabels) {
                const value = ports.imageLabel(runtime, label);
                if (value) return value;
            }
            return null;
        } catch {
            return null;
        }
    }
    /** @returns {ImageOutcome} */
    function buildImage() {
        const runtime = detectRuntime();
        if (!runtime) {
            ports.present({ kind: "runtime-unavailable" });
            return { status: "skipped", reason: "no runtime detected" };
        }
        ports.present({ kind: "runtime-selected", runtime });

        const currentHash = ports.contentHash(fingerprintFiles, fingerprintDirectories);
        const imageHash = getImageHash(runtime);
        if (currentHash === imageHash) {
            ports.present({ kind: "image-current", hash: currentHash });
            return { status: "ready" };
        }
        ports.present({ kind: "image-rebuilding", runtime, previousHash: imageHash, hash: currentHash });
        try {
            const buildResult = ports.buildContainer(runtime, currentHash, ports.githubTokenConfigured());
            if (buildResult.status === "failed") throw buildResult.cause;
            ports.present({ kind: "image-built" });
            return { status: "ready" };
        } catch (e) {
            ports.present({ kind: "image-build-failed", runtime, cause: e });
            return { status: "failed" };
        }
    }

    /** @param {string} installDir */
    function tryAddInstallDirToUserPath(installDir) {
        if (!ports.exists(installDir)) {
            ports.present({ kind: "path-directory-missing", installDir });
            return;
        }
        let current;
        try {
            current = ports.readUserPath();
        } catch (e) {
            ports.present({ kind: "path-read-failed", installDir, cause: e });
            return;
        }
        const parts = splitUserPath(current);
        const target = normalizePathEntry(installDir);
        if (parts.some(p => normalizePathEntry(p) === target)) {
            ports.present({ kind: "path-present" });
            return;
        }
        const next = [...parts, installDir].join(";");
        if (next.length >= PATH_LIMIT) {
            ports.present({ kind: "path-too-long", installDir, length: next.length, limit: PATH_LIMIT });
            return;
        }
        try {
            ports.writeUserPath(next);
            ports.present({ kind: "path-added" });
        } catch (e) {
            ports.present({ kind: "path-write-failed", installDir, cause: e });
        }
    }

    /** @param {string} installDir */
    function tryRemoveInstallDirFromUserPath(installDir) {
        let current;
        try {
            current = ports.readUserPath();
        } catch {
            return; // best-effort during uninstall
        }
        const parts = splitUserPath(current);
        const target = normalizePathEntry(installDir);
        const kept = parts.filter(p => normalizePathEntry(p) !== target);
        if (kept.length === parts.length) return;
        try {
            ports.writeUserPath(kept.join(";"));
            ports.present({ kind: "path-removed" });
        } catch {
            // best-effort
        }
    }

    /** @param {unknown} cause */
    function failureDetail(cause) {
        return cause instanceof Error ? cause.message : String(cause);
    }

    /** @param {string} path @param {string} ancestor */
    function isWithin(path, ancestor) {
        for (;;) {
            if (path === ancestor) return true;
            const parent = ports.parentPath(path);
            if (parent === path) return false;
            path = parent;
        }
    }

    /** @param {string} sourceRoot @param {string} targetDir @param {boolean} [canonical] */
    function assertSeparatePayloadSource(sourceRoot, targetDir, canonical = false) {
        if (isWithin(sourceRoot, targetDir)
            || [...unixPayloadCopies.map(entry => entry.path), "package.json"].some(path => {
                const input = ports.joinPath(sourceRoot, path);
                const resolvedInput = canonical ? ports.realPath(input) : input;
                return isWithin(targetDir, resolvedInput) || isWithin(resolvedInput, targetDir);
            })) {
            throw new Error(`Refusing unsafe global install payload target: ${targetDir} overlaps source ${sourceRoot}`);
        }
    }

    /** @param {string} targetDir */
    function canonicalMissingTarget(targetDir) {
        const names = [ports.basePath(targetDir)];
        let parent = ports.parentPath(targetDir);
        for (;;) {
            try {
                return ports.joinPath(ports.realPath(parent), ...names);
            } catch (cause) {
                if (errorCode(cause) !== "ENOENT") throw cause;
                const nextParent = ports.parentPath(parent);
                if (nextParent === parent) throw cause;
                names.unshift(ports.basePath(parent));
                parent = nextParent;
            }
        }
    }

    /** @param {string} targetDir */
    function payloadTargetKind(targetDir) {
        const kind = ports.pathKind(targetDir);
        if (targetDir === ports.parentPath(targetDir) || (kind !== "missing" && kind !== "directory")) {
            throw new Error(`Refusing unsafe global install payload target: ${targetDir} (${kind})`);
        }
        return kind;
    }

    /** @param {string} targetBin */
    function launcherTargetKind(targetBin) {
        const kind = ports.pathKind(targetBin);
        if (kind !== "missing" && kind !== "file" && kind !== "symlink") {
            throw new Error(`Refusing unsafe global install launcher target: ${targetBin} (${kind})`);
        }
        return kind;
    }

    /** @param {string} targetDir @param {() => void} operation @param {() => void} [prepareParent] */
    function withUnixDestinationGuard(targetDir, operation, prepareParent) {
        const guard = `${targetDir}.install-lock`;
        function acquire() {
            try {
                ports.createExclusiveDirectory(guard);
            } catch (cause) {
                if (errorCode(cause) === "EEXIST") {
                    throw new Error(`Refusing concurrent Unix installation: guard exists at ${guard}. Inspect it before retrying.`, { cause });
                }
                throw cause;
            }
        }
        try {
            acquire();
        } catch (cause) {
            if (errorCode(cause) !== "ENOENT") throw cause;
            // Missing parents cannot contain an installation or its sibling guard.
            if (prepareParent === undefined) return false;
            prepareParent();
            acquire();
        }
        let failed = false;
        /** @type {unknown} */
        let failure;
        try {
            operation();
        } catch (cause) {
            failed = true;
            failure = cause;
        }
        try {
            ports.removeEmptyDirectory(guard);
        } catch (cause) {
            const detail = `Could not remove owned Unix installation guard ${guard}: ${failureDetail(cause)}`;
            if (failed) throw new AggregateError([failure, cause], `${failureDetail(failure)}; ${detail}`, { cause: failure });
            throw new Error(`Unix destination operation completed; ${detail}`, { cause });
        }
        if (failed) throw failure;
        return true;
    }

    /** @param {string} sourceRoot @param {string} targetDir @param {string} [targetBin] @param {() => void} [afterPublication] */
    function replaceUnixPayload(sourceRoot, targetDir, targetBin, afterPublication) {
        const resolvedSourceRoot = ports.resolvePath(sourceRoot);
        const resolvedTargetDir = ports.resolvePath(targetDir);
        assertSeparatePayloadSource(resolvedSourceRoot, resolvedTargetDir);
        withUnixDestinationGuard(resolvedTargetDir, () => {
            const previousKind = payloadTargetKind(resolvedTargetDir);
            const canonicalSource = ports.realPath(resolvedSourceRoot);
            const canonicalTarget = previousKind === "directory" ? ports.realPath(resolvedTargetDir) : canonicalMissingTarget(resolvedTargetDir);
            assertSeparatePayloadSource(canonicalSource, canonicalTarget, true);
            if (targetBin !== undefined) launcherTargetKind(targetBin);

            const stage = ports.createTemporaryDirectory(`${resolvedTargetDir}.install-stage-`);
            const payload = ports.joinPath(stage, "payload");
            const previousPayload = ports.joinPath(stage, "previous-payload");
            const launcher = ports.joinPath(stage, "launcher");
            let retainStage = false;
            let failed = false;
            /** @type {unknown} */
            let failure;
            try {
                ports.ensureDirectory(payload);
                for (const entry of unixPayloadCopies) {
                    ports.copy(ports.joinPath(resolvedSourceRoot, entry.path), ports.joinPath(payload, entry.path), entry.recursive);
                }
                ports.writeUnixPackage(resolvedSourceRoot, payload);
                if (targetBin !== undefined) ports.writeUnixLauncher(launcher, resolvedTargetDir);

                let previousMoved = false;
                let payloadPublished = false;
                try {
                    if (previousKind === "directory") {
                        ports.renamePath(resolvedTargetDir, previousPayload);
                        previousMoved = true;
                    }
                    ports.renamePath(payload, resolvedTargetDir);
                    payloadPublished = true;
                    // The old regular file or symlink remains intact until this last rename.
                    if (targetBin !== undefined) ports.renamePath(launcher, targetBin);
                } catch (cause) {
                    try {
                        // Move only our new payload away; never recursively remove a live target.
                        if (payloadPublished) ports.renamePath(resolvedTargetDir, payload);
                        if (previousMoved) ports.renamePath(previousPayload, resolvedTargetDir);
                    } catch (restoreCause) {
                        retainStage = true;
                        const recovery = previousMoved ? `Recovery payload: ${previousPayload}` : `New payload remains at ${resolvedTargetDir}; no previous payload existed`;
                        throw new AggregateError([cause, restoreCause],
                            `Unix installation publication failed: ${failureDetail(cause)}; restoration failed: ${failureDetail(restoreCause)}. ${recovery}; retained staging directory: ${stage}.`,
                            { cause });
                    }
                    throw cause;
                }
            } catch (cause) {
                failed = true;
                failure = cause;
            }
            if (!retainStage) {
                try {
                    ports.removeDirectory(stage, false);
                } catch (cause) {
                    const detail = `Could not clean owned Unix installation staging directory ${stage}: ${failureDetail(cause)}`;
                    if (failed) throw new AggregateError([failure, cause], `${failureDetail(failure)}; ${detail}`, { cause: failure });
                    throw new Error(`Unix installation publication completed; ${detail}`, { cause });
                }
            }
            if (failed) throw failure;
            afterPublication?.();
        }, () => {
            // Validate aliases before creating absent parent scaffolding.
            assertSeparatePayloadSource(ports.realPath(resolvedSourceRoot), canonicalMissingTarget(resolvedTargetDir), true);
            ports.ensureDirectory(ports.parentPath(resolvedTargetDir));
        });
    }

    /** @param {string} sourceRoot @param {string} targetDir */
    function materializeUnixInstallPayload(sourceRoot, targetDir) {
        replaceUnixPayload(sourceRoot, targetDir);
    }
    /** @param {string} targetDir */
    function unixWrapperContent(targetDir) {
        return ports.unixWrapperContent(targetDir);
    }

    function linkBinary() {
        const installDir = ports.installDirectory();

        if (ports.platform() === "windows") {
            ports.ensureDirectory(installDir);
            const cmdPath = ports.joinPath(installDir, "ccc.cmd");
            ports.writeWindowsLauncher(cmdPath);
            ports.present({ kind: "installed", path: cmdPath });

            tryAddInstallDirToUserPath(installDir);
            return;
        }

        const targetDir = ports.joinPath(installDir, "ccc-dist");
        const targetBin = ports.joinPath(installDir, "ccc");
        let shadowed = false;
        try {
            replaceUnixPayload(ports.sourceRoot(), targetDir, targetBin, () => {
                try {
                    for (const alias of ports.observeUnixLauncherAliases(targetBin)) {
                        if (alias.kind === "known-npm") {
                            ports.publishUnixLauncherAlias(alias, targetBin);
                            ports.present({ kind: "unix-launcher-alias-updated", path: alias.path, target: targetBin });
                        } else if (alias.preempts) {
                            shadowed = true;
                            ports.present({ kind: "unix-launcher-shadowed", path: alias.path, target: targetBin });
                        }
                    }
                } catch (cause) {
                    throw new Error(`Canonical CCC installation is published at ${targetBin}, but launcher repair is incomplete. Use ${targetBin} explicitly: ${failureDetail(cause)}`, { cause });
                }
            });
            ports.present({ kind: "installed", path: targetBin });
        } catch (e) {
            if (errorCode(e) === "EACCES") {
                ports.present({ kind: "permission-denied", operation: "install" });
                ports.terminate(1);
            }
            throw e;
        }
        return shadowed ? targetBin : undefined;
    }

    /** @param {{skipImage?:boolean}} [options] */
    function install({ skipImage = false } = {}) {
        build();
        /** @type {ImageOutcome} */
        const image = skipImage ? { status: "skipped", reason: "--skip-image" } : buildImage();
        const command = linkBinary();
        ports.present({ kind: "cli-installed", ...(command ? { command } : {}) });
        if (image.status === "ready") {
            ports.present({ kind: "image-ready" });
        } else if (image.status === "failed") {
            ports.present({ kind: "image-partial-success" });
        } else {
            ports.present({ kind: "image-skipped", reason: image.reason });
        }
    }

    function postinstall() {
        const inNodeModules = isPackagedInstall(ports.sourceRoot(), ports.platform());
        if (inNodeModules) {
            // Global/local npm install: dist/ is shipped in the tarball, skip build.
            return;
        }
        // Source repo after plain `npm install`: ensure dist/ is fresh.
        build();
    }

    function uninstall() {
        const installDir = ports.installDirectory();

        if (ports.platform() === "windows") {
            const cmdPath = ports.joinPath(installDir, "ccc.cmd");
            if (ports.exists(cmdPath)) {
                ports.removeFile(cmdPath);
                ports.present({ kind: "removed", path: cmdPath });
            } else {
                ports.present({ kind: "not-installed" });
            }
            tryRemoveInstallDirFromUserPath(installDir);
            return;
        }

        const targetDir = ports.resolvePath(ports.joinPath(installDir, "ccc-dist"));
        const targetBin = ports.joinPath(installDir, "ccc");
        try {
            const guarded = withUnixDestinationGuard(targetDir, () => {
                const payloadKind = payloadTargetKind(targetDir);
                const launcherKind = launcherTargetKind(targetBin);
                let removed = false;
                if (launcherKind !== "missing") {
                    ports.removeFile(targetBin);
                    ports.present({ kind: "removed", path: targetBin });
                    removed = true;
                }
                if (payloadKind === "directory") {
                    ports.removeDirectory(targetDir, false);
                    ports.present({ kind: "removed", path: targetDir });
                    removed = true;
                }
                if (!removed) ports.present({ kind: "not-installed" });
            });
            if (!guarded) ports.present({ kind: "not-installed" });
        } catch (e) {
            if (errorCode(e) === "EACCES") {
                ports.present({ kind: "permission-denied", operation: "uninstall" });
                ports.terminate(1);
            }
            throw e;
        }
    }
    return { install, uninstall, postinstall, buildImage, materializeUnixInstallPayload, unixWrapperContent };
}
