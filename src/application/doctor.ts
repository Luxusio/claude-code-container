import type { DoctorCheck, DoctorReport, DoctorRequest } from "../domain/doctor.js";
import type { DoctorPorts } from "../ports/doctor.js";

/** Complete synchronous diagnosis; native authority is supplied by trusted composition. */
export function createDoctor(ports: DoctorPorts): (request: DoctorRequest) => DoctorReport {
    return ({ projectId, containerName }) => {
        const checks: DoctorCheck[] = [];
        const info = ports.runtimeInfo();
        if (!ports.daemonRunning()) {
            checks.push({ kind: "runtime", status: "error", info, version: null });
            return { ok: false, checks };
        }

        const version = ports.runtimeVersion() || info.version || null;
        checks.push({ kind: "runtime", status: "ok", info, version });

        const image = ports.image();
        const expectedVersion = ports.cliVersion;
        checks.push({
            kind: "image",
            status: image.kind === "missing" ? "error"
                : image.kind === "registry" && image.version !== expectedVersion ? "warn" : "ok",
            image,
            expectedVersion,
        });

        const state = ports.containerRunning(containerName) ? "running"
            : ports.containerExists(containerName) ? "stopped" : "missing";
        checks.push({
            kind: "container",
            status: state === "running" ? "ok" : "warn",
            state,
            name: containerName,
        });

        const cache = ports.miseCache();
        checks.push({ kind: "mise-cache", status: cache.exists ? "ok" : "warn", ...cache });

        const count = ports.activeSessionCount(projectId);
        checks.push({ kind: "sessions", status: "ok", count });

        const projectLocks = ports.lockNames().filter(name =>
            (name.startsWith(`${projectId}--`) || name.startsWith(`${projectId}-`))
            && name.endsWith(".lock"),
        ).length;
        const staleLocks = projectLocks - count;
        if (staleLocks > 0) {
            checks.push({ kind: "stale-locks", status: "warn", count: staleLocks });
        }

        // Re-observe running state: the container may have changed since its check.
        if (ports.containerRunning(containerName)) {
            const launcher = ports.claudeLauncherReport(containerName);
            checks.push({ kind: "claude", status: launcher.kind === "ready" ? "ok" : "warn", launcher });
        }

        return { ok: !checks.some(check => check.status === "error"), checks };
    };
}
