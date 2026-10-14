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

    /** @param {string} sourceRoot @param {string} targetDir */
    function materializeUnixInstallPayload(sourceRoot, targetDir) {
        const resolvedSourceRoot = ports.resolvePath(sourceRoot);
        const resolvedTargetDir = ports.resolvePath(targetDir);
        if (resolvedTargetDir === ports.parentPath(resolvedTargetDir) || resolvedTargetDir === resolvedSourceRoot) {
            throw new Error(`Refusing unsafe global install payload target: ${resolvedTargetDir}`);
        }
        ports.removeDirectory(resolvedTargetDir, true);
        ports.ensureDirectory(resolvedTargetDir);
        for (const entry of unixPayloadCopies) {
            ports.copy(ports.joinPath(resolvedSourceRoot, entry.path), ports.joinPath(resolvedTargetDir, entry.path), entry.recursive);
        }
        ports.writeUnixPackage(resolvedSourceRoot, resolvedTargetDir);
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
        try {
            try {
                if (ports.isSymlink(targetBin)) ports.removeFile(targetBin);
            } catch (e) {
                if (errorCode(e) !== "ENOENT") throw e;
            }

            materializeUnixInstallPayload(ports.sourceRoot(), targetDir);
            ports.writeUnixLauncher(targetBin, targetDir);
            ports.present({ kind: "installed", path: targetBin });
        } catch (e) {
            if (errorCode(e) === "EACCES") {
                ports.present({ kind: "permission-denied", operation: "install" });
                ports.terminate(1);
            }
            throw e;
        }
    }

    /** @param {{skipImage?:boolean}} [options] */
    function install({ skipImage = false } = {}) {
        build();
        /** @type {ImageOutcome} */
        const image = skipImage ? { status: "skipped", reason: "--skip-image" } : buildImage();
        linkBinary();
        ports.present({ kind: "cli-installed" });
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

        const targetDir = ports.joinPath(installDir, "ccc-dist");
        const targetBin = ports.joinPath(installDir, "ccc");
        try {
            let removed = false;
            if (ports.exists(targetBin)) {
                ports.removeFile(targetBin);
                ports.present({ kind: "removed", path: targetBin });
                removed = true;
            }
            if (ports.exists(targetDir)) {
                ports.removeDirectory(targetDir, false);
                ports.present({ kind: "removed", path: targetDir });
                removed = true;
            }
            if (!removed) ports.present({ kind: "not-installed" });
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
