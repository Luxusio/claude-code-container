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

import type { DoctorReport } from "./domain/doctor.js";
import type { DoctorPorts } from "./ports/doctor.js";

function renderDoctorReport(report: DoctorReport): void {
    for (const check of report.checks) {
        let name: string;
        let message: string;
        switch (check.kind) {
            case "runtime": {
                name = "Runtime";
                const label = check.info.runtime === "podman" ? "Podman" : "Docker";
                message = check.status === "error" ? `${label} not running`
                    : `${label} running (v${check.version || "unknown"}, ${check.info.flavor})`;
                break;
            }
            case "image":
                name = "Image";
                message = check.image.kind === "missing"
                    ? `Not found -- run 'ccc' to auto-pull, or '${runtimeCli()} build -t ccc .' for local build`
                    : check.image.kind === "local" ? "Built locally (dev)"
                    : check.status === "warn"
                        ? `Registry (v${check.image.version} -- CLI expects v${check.expectedVersion}, run 'ccc' to update)`
                        : `Registry (v${check.image.version})`;
                break;
            case "container":
                name = "Container";
                message = check.state === "running" ? `Running (${check.name})`
                    : check.state === "stopped" ? `Stopped (${check.name})` : "Not created yet";
                break;
            case "mise-cache":
                name = "Mise cache";
                message = check.exists ? `Volume '${check.volumeName}' exists` : "Volume not created yet";
                break;
            case "sessions":
                name = "Sessions";
                message = check.count > 0 ? `${check.count} active session(s)` : "No active sessions";
                break;
            case "stale-locks":
                name = "Stale locks";
                message = `${check.count} stale lock file(s) found`;
                break;
            case "claude":
                name = "Claude";
                message = check.launcher.kind === "missing" ? "Not installed in container" : check.launcher.description;
                break;
        }
        const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
        console.log(sanitizeForTerminal(`  ${icon} ${name}: ${message}`));
    }

    const errors = report.checks.filter(check => check.status === "error").length;
    const warns = report.checks.filter(check => check.status === "warn").length;
    console.log(sanitizeForTerminal(""));
    console.log(sanitizeForTerminal(errors > 0 ? `Summary: ${errors} error(s), ${warns} warning(s)`
        : warns > 0 ? `Summary: OK with ${warns} warning(s)` : "Summary: All checks passed"));
    console.log(sanitizeForTerminal(""));
}

/** Trusted native composition retains the public synchronous boolean contract. */
export function runDoctor(projectPath: string): boolean {
    const fullPath = resolve(projectPath);
    const projectId = getProjectId(fullPath);
    const containerName = getContainerName(fullPath);
    console.log(`\n${sanitizeForTerminal("=== CCC Doctor ===")}\n`);

    const ports: DoctorPorts = {
        runtimeInfo: () => getRuntimeInfo(),
        daemonRunning: () => isDockerRunning(),
        runtimeVersion: () => {
            const result = spawnSync(runtimeCli(),
                ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" });
            return (result.stdout ?? "").trim() || null;
        },
        image: () => {
            if (!isImageExists()) return { kind: "missing" };
            const version = getImageLabel("ccc", "cli.version");
            return version === null ? { kind: "local" } : { kind: "registry", version };
        },
        cliVersion: CLI_VERSION,
        containerRunning: name => isContainerRunning(name),
        containerExists: name => isContainerExists(name),
        miseCache: () => {
            const volumeName = getIdentityMiseVolumeName(resolveContainerIdentity());
            const result = spawnSync(runtimeCli(),
                ["volume", "inspect", volumeName, "--format", "{{.Mountpoint}}"],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
            return { volumeName, exists: result.status === 0 };
        },
        activeSessionCount: id => observeActiveSessionsForContainer(id).length,
        lockNames: () => {
            const directory = sessionLocksDir();
            return existsSync(directory) ? readdirSync(directory) : [];
        },
        claudeLauncherReport: name => {
            const result = spawnSync(runtimeCli(),
                ["exec", name, "sh", "-c", buildClaudeLauncherReportCommand(CLAUDE_BIN_PATH)],
                { encoding: "utf-8", timeout: 10000 });
            const description = (result.stdout ?? "").trim();
            if (result.status === 0 && description) return { kind: "ready", description };
            if (result.status === 2 && description) return { kind: "update-unmanaged", description };
            return { kind: "missing" };
        },
    };
    const report = createDoctor(ports)({ projectId, containerName });
    renderDoctorReport(report);
    return report.ok;
}
