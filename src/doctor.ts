// src/doctor.ts - Health check and diagnostics for ccc

import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import {
    isDockerRunning,
    getContainerName,
    isContainerRunning,
    isContainerExists,
    isImageExists,
    getImageLabel,
} from "./docker.js";
import { getProjectId, DATA_DIR, MISE_VOLUME_NAME, CLI_VERSION } from "./utils.js";
import { getActiveSessionsForProject } from "./session.js";

interface DoctorCheck {
    name: string;
    status: "ok" | "warn" | "error";
    message: string;
}

function printResults(checks: DoctorCheck[]): void {
    for (const check of checks) {
        let icon: string;
        if (check.status === "ok") {
            icon = "✓";
        } else if (check.status === "warn") {
            icon = "!";
        } else {
            icon = "✗";
        }
        console.log(`  ${icon} ${check.name}: ${check.message}`);
    }

    const errors = checks.filter((c) => c.status === "error").length;
    const warns = checks.filter((c) => c.status === "warn").length;

    console.log("");
    if (errors > 0) {
        console.log(`Summary: ${errors} error(s), ${warns} warning(s)`);
    } else if (warns > 0) {
        console.log(`Summary: OK with ${warns} warning(s)`);
    } else {
        console.log("Summary: All checks passed");
    }
    console.log("");
}

export function runDoctor(projectPath: string): boolean {
    const checks: DoctorCheck[] = [];
    const fullPath = resolve(projectPath);
    const projectId = getProjectId(fullPath);
    const containerName = getContainerName(fullPath);

    console.log("\n=== CCC Doctor ===\n");

    // 1. Docker daemon
    if (isDockerRunning()) {
        const vResult = spawnSync(
            "docker",
            ["version", "--format", "{{.Server.Version}}"],
            { encoding: "utf-8" },
        );
        const version = (vResult.stdout ?? "").trim();
        checks.push({
            name: "Docker",
            status: "ok",
            message: `Running (v${version})`,
        });
    } else {
        checks.push({
            name: "Docker",
            status: "error",
            message: "Not running",
        });
        printResults(checks);
        return false;
    }

    // 2. Image
    if (isImageExists()) {
        const label = getImageLabel("ccc", "cli.version");
        if (label === null) {
            checks.push({ name: "Image", status: "ok", message: "Built locally (dev)" });
        } else if (label === CLI_VERSION) {
            checks.push({ name: "Image", status: "ok", message: `Registry (v${label})` });
        } else {
            checks.push({
                name: "Image",
                status: "warn",
                message: `Registry (v${label} -- CLI expects v${CLI_VERSION}, run 'ccc' to update)`,
            });
        }
    } else {
        checks.push({
            name: "Image",
            status: "error",
            message: "Not found -- run 'ccc' to auto-pull, or 'docker build -t ccc .' for local build",
        });
    }

    // 3. Container
    if (isContainerRunning(containerName)) {
        checks.push({
            name: "Container",
            status: "ok",
            message: `Running (${containerName})`,
        });
    } else if (isContainerExists(containerName)) {
        checks.push({
            name: "Container",
            status: "warn",
            message: `Stopped (${containerName})`,
        });
    } else {
        checks.push({
            name: "Container",
            status: "warn",
            message: "Not created yet",
        });
    }

    // 4. Volume (mise cache)
    const volResult = spawnSync(
        "docker",
        ["volume", "inspect", MISE_VOLUME_NAME, "--format", "{{.Mountpoint}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (volResult.status === 0) {
        checks.push({
            name: "Mise cache",
            status: "ok",
            message: `Volume '${MISE_VOLUME_NAME}' exists`,
        });
    } else {
        checks.push({
            name: "Mise cache",
            status: "warn",
            message: "Volume not created yet",
        });
    }

    // 5. Sessions
    const activeSessions = getActiveSessionsForProject(projectId);
    if (activeSessions.length > 0) {
        checks.push({
            name: "Sessions",
            status: "ok",
            message: `${activeSessions.length} active session(s)`,
        });
    } else {
        checks.push({
            name: "Sessions",
            status: "ok",
            message: "No active sessions",
        });
    }

    // 6. Stale locks check (scoped to current project)
    const locksDir = join(DATA_DIR, "locks");
    let totalProjectLocks = 0;
    if (existsSync(locksDir)) {
        totalProjectLocks = readdirSync(locksDir).filter((f) =>
            f.startsWith(`${projectId}-`) && f.endsWith(".lock"),
        ).length;
    }
    const staleLocks = totalProjectLocks - activeSessions.length;
    if (staleLocks > 0) {
        checks.push({
            name: "Stale locks",
            status: "warn",
            message: `${staleLocks} stale lock file(s) found`,
        });
    }

    // 7. Claude binary (only if container is running)
    if (isContainerRunning(containerName)) {
        const claudeCheck = spawnSync(
            "docker",
            [
                "exec",
                containerName,
                "sh",
                "-c",
                "test -x /home/ccc/.local/bin/claude && /home/ccc/.local/bin/claude --version 2>&1 | head -1",
            ],
            { encoding: "utf-8", timeout: 10000 },
        );
        if (claudeCheck.status === 0 && claudeCheck.stdout?.trim()) {
            checks.push({
                name: "Claude",
                status: "ok",
                message: claudeCheck.stdout.trim(),
            });
        } else {
            checks.push({
                name: "Claude",
                status: "warn",
                message: "Not installed in container",
            });
        }
    }

    printResults(checks);

    const hasErrors = checks.some((c) => c.status === "error");
    return !hasErrors;
}
