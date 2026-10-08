import type { DoctorCheck } from "../domain/doctor.js";
import type { DoctorPorts } from "../ports/doctor.js";

/** Complete synchronous diagnosis; native authority is supplied by trusted composition. */
export function createDoctor(ports: DoctorPorts): (projectPath: string) => boolean {
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
            // Sanitize here rather than where each check is built. Several of these
            // messages carry strings produced inside a container — a path out of a
            // volume any container can write, a runtime's own version output — and
            // a rule applied at eighteen call sites is a rule the nineteenth
            // forgets. This is the only place a check reaches a terminal.
            ports.capturePublication()(`  ${icon} ${check.name}: ${ports.sanitizeForTerminal(check.message)}`);
        }

        const errors = checks.filter((c) => c.status === "error").length;
        const warns = checks.filter((c) => c.status === "warn").length;

        ports.capturePublication()("");
        if (errors > 0) {
            ports.capturePublication()(`Summary: ${errors} error(s), ${warns} warning(s)`);
        } else if (warns > 0) {
            ports.capturePublication()(`Summary: OK with ${warns} warning(s)`);
        } else {
            ports.capturePublication()("Summary: All checks passed");
        }
        ports.capturePublication()("");
    }

    function runDoctor(projectPath: string): boolean {
        const checks: DoctorCheck[] = [];
        const fullPath = ports.resolveProjectPath(projectPath);
        const projectId = ports.projectId(fullPath);
        const containerName = ports.containerName(fullPath);

        ports.capturePublication()("\n=== CCC Doctor ===\n");

        // 1. Container runtime daemon
        const runtimeInfo = ports.runtimeInfo();
        const runtimeLabel = runtimeInfo.runtime === "podman" ? "Podman" : "Docker";
        if (ports.daemonRunning()) {
            const vResult = ports.runtimeVersion();
            const version = (vResult.stdout ?? "").trim() || runtimeInfo.version || "unknown";
            checks.push({
                name: "Runtime",
                status: "ok",
                message: `${runtimeLabel} running (v${version}, ${runtimeInfo.flavor})`,
            });
        } else {
            checks.push({
                name: "Runtime",
                status: "error",
                message: `${runtimeLabel} not running`,
            });
            printResults(checks);
            return false;
        }

        // 2. Image
        if (ports.imageExists()) {
            const label = ports.imageLabel();
            if (label === null) {
                checks.push({ name: "Image", status: "ok", message: "Built locally (dev)" });
            } else if (label === ports.cliVersion) {
                checks.push({ name: "Image", status: "ok", message: `Registry (v${label})` });
            } else {
                checks.push({
                    name: "Image",
                    status: "warn",
                    message: `Registry (v${label} -- CLI expects v${ports.cliVersion}, run 'ccc' to update)`,
                });
            }
        } else {
            checks.push({
                name: "Image",
                status: "error",
                message: `Not found -- run 'ccc' to auto-pull, or '${ports.runtimeCli()} build -t ccc .' for local build`,
            });
        }

        // 3. Container
        if (ports.containerRunning(containerName)) {
            checks.push({
                name: "Container",
                status: "ok",
                message: `Running (${containerName})`,
            });
        } else if (ports.containerExists(containerName)) {
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
        const miseVolumeName = ports.identityMiseVolumeName();
        const volResult = ports.inspectMiseVolume(miseVolumeName);
        if (volResult.status === 0) {
            checks.push({
                name: "Mise cache",
                status: "ok",
                message: `Volume '${miseVolumeName}' exists`,
            });
        } else {
            checks.push({
                name: "Mise cache",
                status: "warn",
                message: "Volume not created yet",
            });
        }

        // 5. Sessions
        const activeSessions = ports.observeActiveSessions(projectId);
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
        const locks = ports.captureLocksDirectory();
        let totalProjectLocks = 0;
        if (locks.exists()) {
            totalProjectLocks = locks.readNames().filter((f) =>
                // New format: projectId--sessionId.lock or projectId--p--profile--sessionId.lock
                // Old format (migration): projectId-sessionId.lock
                (f.startsWith(`${projectId}--`) || f.startsWith(`${projectId}-`)) && f.endsWith(".lock"),
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
        if (ports.containerRunning(containerName)) {
            const claudeCheck = ports.claudeLauncherReport(containerName);
            // Exit 2 means the launcher works but is in the shape the native
            // updater refuses to manage — `claude update` will report success and
            // change nothing. Reporting that as ok is how the state stayed
            // invisible; it is a warning, and the message says why.
            if (claudeCheck.status === 2 && claudeCheck.stdout?.trim()) {
                checks.push({
                    name: "Claude",
                    status: "warn",
                    message: claudeCheck.stdout.trim(),
                });
            } else if (claudeCheck.status === 0 && claudeCheck.stdout?.trim()) {
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

    return runDoctor;
}
