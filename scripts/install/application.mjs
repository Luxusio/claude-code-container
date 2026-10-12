import {
    runtimePreference, imageLabels, fingerprintFiles, fingerprintDirectories, unixPayloadCopies,
    PATH_LIMIT, selectedRuntimeOverride, normalizePathEntry, splitUserPath, isPackagedInstall,
    unixPackageContent, errorField,
} from "./domain.mjs";
/** @typedef {{status:"ready"}|{status:"failed"}|{status:"skipped",reason:string}} ImageOutcome */
/** @param {import('./ports.mjs').InstallerPorts} ports */
export function createInstallerApplication(ports) {
    function build() {
        ports.log("Building...");
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
            ports.log("No container runtime (podman or docker) detected. Skipping image build.");
            ports.log("Install podman or docker, then run 'ccc' to auto-pull/build.");
            return { status: "skipped", reason: "no runtime detected" };
        }
        ports.log(`Using container runtime: ${runtime}`);

        const currentHash = ports.contentHash(fingerprintFiles, fingerprintDirectories);
        const imageHash = getImageHash(runtime);
        if (currentHash === imageHash) {
            ports.log(`Container image up to date (hash: ${currentHash})`);
            return { status: "ready" };
        }
        ports.log(`Content changed (${imageHash || "none"} -> ${currentHash})`);
        ports.log(`Rebuilding container image with ${runtime}...`);
        try {
            const buildResult = ports.buildContainer(runtime, currentHash, ports.githubTokenConfigured());
            if (buildResult.error) throw buildResult.error;
            if (buildResult.signal) throw new Error(`${runtime} build terminated by ${buildResult.signal}`);
            if (buildResult.status !== 0) {
                throw new Error(`${runtime} build ${buildResult.status === null ? "ended without an exit code" : `exited with code ${buildResult.status}`}`);
            }
            ports.log("Container image built.");
            return { status: "ready" };
        } catch (e) {
            ports.error(`Failed to build image with ${runtime}:`, errorField(e, "message"));
            return { status: "failed" };
        }
    }

    /** @param {string} installDir */
    function manualPathHint(installDir) {
        ports.log("Add it manually in PowerShell:");
        ports.log(`  [Environment]::SetEnvironmentVariable("Path", ([Environment]::GetEnvironmentVariable("Path","User") + ";${installDir}"), "User")`);
    }

    /** @param {string} installDir */
    function tryAddInstallDirToUserPath(installDir) {
        if (!ports.exists(installDir)) {
            ports.log(`PATH update skipped (DIR_NOT_FOUND): ${installDir}`);
            return;
        }
        let current;
        try {
            current = ports.readUserPath();
        } catch (e) {
            ports.log(`PATH update skipped (READ_ERROR): ${errorField(e, "message")}`);
            manualPathHint(installDir);
            return;
        }
        const parts = splitUserPath(current);
        const target = normalizePathEntry(installDir);
        if (parts.some(p => normalizePathEntry(p) === target)) {
            ports.log("Already on User PATH.");
            return;
        }
        const next = [...parts, installDir].join(";");
        if (next.length >= PATH_LIMIT) {
            ports.log(`PATH update skipped (PATH_TOO_LONG): ${next.length} >= ${PATH_LIMIT}`);
            manualPathHint(installDir);
            return;
        }
        try {
            ports.writeUserPath(next);
            ports.log("Added to User PATH. Open a new terminal to pick it up.");
        } catch (e) {
            ports.log(`PATH update skipped (WRITE_ERROR): ${errorField(e, "message")}`);
            manualPathHint(installDir);
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
            ports.log("Removed from User PATH.");
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
        const sourcePackage = ports.readPackage(ports.joinPath(resolvedSourceRoot, "package.json"));
        ports.writeText(ports.joinPath(resolvedTargetDir, "package.json"), unixPackageContent(sourcePackage));
    }
    /** @param {string} targetDir */
    function unixWrapperContent(targetDir) {
        const entryPoint = ports.joinPath(ports.resolvePath(targetDir), "dist", "index.js");
        return `#!/usr/bin/env node\nimport(${JSON.stringify(ports.fileUrl(entryPoint))});\n`;
    }

    function linkBinary() {
        const installDir = ports.installDirectory();

        if (ports.platform() === "windows") {
            ports.ensureDirectory(installDir);
            const cmdPath = ports.joinPath(installDir, "ccc.cmd");
            const cmdContent = `@echo off\r\nnode "${ports.sourceEntry()}" %*\r\n`;
            ports.writeText(cmdPath, cmdContent);
            ports.log(`Installed: ${cmdPath}`);

            tryAddInstallDirToUserPath(installDir);
            return;
        }

        const targetDir = ports.joinPath(installDir, "ccc-dist");
        const targetBin = ports.joinPath(installDir, "ccc");
        try {
            try {
                if (ports.isSymlink(targetBin)) ports.removeFile(targetBin);
            } catch (e) {
                if (errorField(e, "code") !== "ENOENT") throw e;
            }

            materializeUnixInstallPayload(ports.sourceRoot(), targetDir);
            ports.writeText(targetBin, unixWrapperContent(targetDir));
            ports.setMode(targetBin, 0o755);
            ports.log(`Installed: ${targetBin}`);
        } catch (e) {
            if (errorField(e, "code") === "EACCES") {
                ports.error("Permission denied. Run with sudo:");
                ports.error("  sudo npm run install:global");
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
        ports.log("\nCLI installed. Run 'ccc --help' to verify.");
        if (image.status === "ready") {
            ports.log("Container image ready.");
        } else if (image.status === "failed") {
            ports.log("Container image build failed; CLI installation succeeded. Retry the image build when the container runtime is available.");
        } else {
            ports.log(`Container image build skipped (${image.reason}).`);
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
                ports.log(`Removed: ${cmdPath}`);
            } else {
                ports.log("Not installed.");
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
                ports.log(`Removed: ${targetBin}`);
                removed = true;
            }
            if (ports.exists(targetDir)) {
                ports.removeDirectory(targetDir, false);
                ports.log(`Removed: ${targetDir}`);
                removed = true;
            }
            if (!removed) ports.log("Not installed.");
        } catch (e) {
            if (errorField(e, "code") === "EACCES") {
                ports.error("Permission denied. Run with sudo:");
                ports.error("  sudo npm run uninstall:global");
                ports.terminate(1);
            }
            throw e;
        }
    }
    return { install, uninstall, postinstall, buildImage, materializeUnixInstallPayload, unixWrapperContent };
}
