import { getIdentityMiseVolumeName, resolveContainerIdentity } from "./container-identity.js";
// src/doctor.ts - Health check and diagnostics for ccc

import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import {
    isDockerRunning,
    getContainerName,
    isContainerRunning,
    isContainerExists,
    isImageExists,
    getImageLabel,
} from "./docker.js";
import { getProjectId, CLI_VERSION } from "./utils.js";
import { locksDir as sessionLocksDir } from "./home-layout.js";
import { observeActiveSessionsForContainer } from "./session.js";
import { getRuntimeInfo, runtimeCli } from "./container-runtime.js";
import { buildClaudeLauncherReportCommand, sanitizeForTerminal, CLAUDE_BIN_PATH } from "./container-setup.js";

import { createDoctor } from "./application/doctor.js";

/** Trusted native composition retains the public synchronous boolean contract. */
export function runDoctor(projectPath: string): boolean {
    return createDoctor({
        resolveProjectPath: value => resolve(value),
        projectId: value => getProjectId(value),
        containerName: value => getContainerName(value),
        runtimeInfo: () => getRuntimeInfo(),
        daemonRunning: () => isDockerRunning(),
        runtimeVersion: () => spawnSync(runtimeCli(),
            ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" }),
        imageExists: () => isImageExists(),
        imageLabel: () => getImageLabel("ccc", "cli.version"),
        get cliVersion() { return CLI_VERSION; },
        containerRunning: name => isContainerRunning(name),
        containerExists: name => isContainerExists(name),
        identityMiseVolumeName: () => getIdentityMiseVolumeName(resolveContainerIdentity()),
        inspectMiseVolume: name => spawnSync(runtimeCli(),
            ["volume", "inspect", name, "--format", "{{.Mountpoint}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
        observeActiveSessions: id => observeActiveSessionsForContainer(id),
        captureLocksDirectory: () => {
            const directory = sessionLocksDir();
            return {
                exists: () => existsSync(directory),
                readNames: () => readdirSync(directory),
            };
        },
        runtimeCli: () => runtimeCli(),
        claudeLauncherReport: name => spawnSync(runtimeCli(),
            ["exec", name, "sh", "-c", buildClaudeLauncherReportCommand(CLAUDE_BIN_PATH)],
            { encoding: "utf-8", timeout: 10000 }),
        capturePublication: () => {
            const receiver = console;
            const publication = receiver.log;
            return text => {
                Reflect.apply(publication, receiver, [text]);
                return undefined;
            };
        },
        get sanitizeForTerminal() {
            const sanitize = sanitizeForTerminal;
            return (message: string) => sanitize(message);
        },
    })(projectPath);
}
