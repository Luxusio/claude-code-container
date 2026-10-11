import { publicLab, publicExecution, publicGuestExecResult, publicReadinessProbeResult, requireRunningLab, sshBaseArgs, sshDestination } from "../domain/qemu-lifecycle.mjs";
import { qemuCommandTimeout as boundedTimeout } from "../domain/qemu-image-disk-target.mjs";
import { guestAccessTarget as targetForLab, sessionIdFor, sessionStateFor, publicSessionLab, publicSessionTarget, readinessStateFromProbe, combineReadinessProbes, validateGuestCommand } from "../domain/qemu-guest-access.mjs";
/** @typedef {import('../domain/qemu-guest-access.mjs').QemuAccessLab} Lab */
/** @typedef {import('../domain/qemu-guest-access.mjs').QemuReadiness} Readiness */
/** @typedef {import('../ports/qemu-guest-access.mjs').QemuAccessArguments} Args */
const PROVIDER_NAME = "container-qemu";
/** @param {import('../ports/qemu-guest-access.mjs').QemuGuestAccessPorts} ports */
export function createQemuGuestAccessApplication(ports) {
    /** @param {Lab} lab */
    function runSshReadinessProbe(lab) {
        const ssh = lab.guest?.ssh;
        if (!ssh) return null;
        const sshPath = ports.sshPath();
        if (!sshPath) {
            return {
                ok: false,
                ready: false,
                checks: [{ name: "guest-ssh-readiness", status: "fail", reason: "ssh-command-missing" }],
                diagnostics: { kind: "ssh-guest-readiness", available: false },
            };
        }
        const args = [...sshBaseArgs(ssh), sshDestination(ssh), ssh.readinessCommand || "true"];
        const result = ports.executeSsh(sshPath, args, lab, ports.sshReadinessTimeoutMs() || 10000);
        return {
            ok: result?.ok === true,
            ready: result?.ok === true,
            checks: [{ name: "guest-ssh-readiness", status: result?.ok === true ? "pass" : "fail", exitStatus: result?.status ?? null }],
            diagnostics: { kind: "ssh-guest-readiness", available: true, result: publicExecution(result) },
        };
    }

    /** @param {Lab} lab @param {number} [timeoutMs] */
    function runSshGuestAgentProbe(lab, timeoutMs) {
        const ssh = lab.guest?.ssh;
        const agent = lab.guest?.agent;
        if (!agent) return null;
        if (!ssh) {
            return {
                ok: false,
                ready: false,
                checks: [{ name: "guest-agent-readiness", status: "fail", reason: "guest-ssh-not-configured" }],
                diagnostics: { kind: "guest-agent-readiness", available: false, agent: agent.name },
            };
        }
        const sshPath = ports.sshPath();
        if (!sshPath) {
            return {
                ok: false,
                ready: false,
                checks: [{ name: "guest-agent-readiness", status: "fail", reason: "ssh-command-missing" }],
                diagnostics: { kind: "guest-agent-readiness", available: false, agent: agent.name },
            };
        }
        const args = [...sshBaseArgs(ssh), sshDestination(ssh), agent.healthCommand];
        const result = ports.executeSsh(sshPath, args, lab, timeoutMs === undefined ? boundedTimeout(ports.guestAgentReadinessTimeoutMs() || ports.sshReadinessTimeoutMs() || 10000, 10000) : timeoutMs);
        return {
            ok: result?.ok === true,
            ready: result?.ok === true,
            checks: [{ name: "guest-agent-readiness", status: result?.ok === true ? "pass" : "fail", agent: agent.name, exitStatus: result?.status ?? null }],
            diagnostics: { kind: "guest-agent-readiness", available: true, agent: agent.name, result: publicGuestExecResult(result, lab, ssh, [sshPath, agent.healthCommand]) },
        };
    }

    /** @param {Lab} lab @param {import('../domain/qemu-image-disk-target.mjs').QemuTarget} target */
    function guestSshSessionAttach(lab, target) {
        const base = {
            kind: "bounded-guest-ssh",
            available: false,
            requestedTargetReady: target.attachable,
            rawShellAvailable: false,
            capabilities: [],
            commandTool: "device_exec",
            transferTools: ["device_upload", "device_download"],
        };
        if (!target.attachable) {
            return { ...base, reason: "lab-not-running" };
        }
        const ssh = lab.guest?.ssh;
        if (!ssh) {
            return { ...base, reason: "guest-ssh-not-configured" };
        }
        const sshPath = ports.sshPath();
        if (!sshPath) {
            return { ...base, reason: "guest-ssh-command-unavailable", missing: ["ssh"] };
        }
        return {
            ...base,
            available: true,
            transport: "ssh",
            host: ssh.host,
            port: ssh.port,
            user: ssh.user,
            keyConfigured: Boolean(ssh.keyPath),
            readinessCommandConfigured: Boolean(ssh.readinessCommand),
            capabilities: ["device_exec", "device_upload", "device_download"],
            note: "Use bounded device execution and transfer tools; raw interactive shell access is not exposed.",
        };
    }

    /** @param {Lab} lab @param {import('../domain/qemu-image-disk-target.mjs').QemuTarget} target */
    function guestAgentSessionAttach(lab, target) {
        const base = {
            kind: "bounded-guest-agent",
            available: false,
            requestedTargetReady: target.attachable,
            rawShellAvailable: false,
            rawSocketAvailable: false,
            capabilities: [],
            statusTool: "device_guest_agent_status",
            provisionTool: "device_guest_agent_provision",
            commandTool: "device_exec",
            transferTools: ["device_upload", "device_download"],
        };
        if (!target.attachable) {
            return { ...base, reason: "lab-not-running" };
        }
        const agent = lab.guest?.agent;
        if (!agent) {
            return { ...base, reason: "guest-agent-not-configured" };
        }
        const ssh = lab.guest?.ssh;
        if (!ssh) {
            return { ...base, reason: "guest-ssh-not-configured" };
        }
        const sshPath = ports.sshPath();
        if (!sshPath) {
            return { ...base, reason: "guest-ssh-command-unavailable", missing: ["ssh"] };
        }
        return {
            ...base,
            available: true,
            transport: "bounded-ssh-health-command",
            agent: {
                name: agent.name,
                protocol: agent.protocol,
                healthCommandConfigured: Boolean(agent.healthCommand),
                provisionCommandConfigured: Boolean(agent.provisionCommand),
                autoProvision: agent.autoProvision === true,
                lastStatus: agent.lastStatus || null,
                lastProvision: agent.lastProvision || null,
            },
            capabilities: ["device_guest_agent_status", "device_guest_agent_provision", "device_exec", "device_upload", "device_download"],
            note: "Use bounded device guest-agent and transfer tools; raw daemon sockets and interactive shells are not exposed.",
        };
    }

    /** @param {unknown} sessionType @param {Lab} lab @param {import('../domain/qemu-image-disk-target.mjs').QemuTarget} target */
    function sessionAttachFor(sessionType, lab, target) {
        if (sessionType === "monitor") {
            return {
                kind: "bounded-monitor-proxy-required",
                available: false,
                requestedTargetReady: target.attachable,
                note: "Raw QEMU monitor sockets are provider-internal; future bounded monitor/session tooling must mediate monitor commands.",
            };
        }
        if (sessionType === "guest-ssh") return guestSshSessionAttach(lab, target);
        if (sessionType === "guest-agent") return guestAgentSessionAttach(lab, target);
        return {
            kind: "metadata",
            available: true,
            note: "Metadata-only session; no guest or host command channel is opened.",
        };
    }

    /** @param {Lab} lab @param {import('../domain/qemu-image-disk-target.mjs').QemuTarget} target */
    function buildReadinessResult(lab, target) {
        const timestamp = ports.clock();
        const pid = lab.runtime?.pid || null;
        const processExists = ports.processExists;
        let runtimeAlive = false;
        try {
            runtimeAlive = processExists(pid, lab) === true;
        } catch (error) {
            return {
                id: `readiness-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
                labId: lab.id,
                targetId: target.id,
                provider: lab.provider || PROVIDER_NAME,
                state: "failed",
                checkedAt: timestamp,
                checks: [
                    { name: "runtime-process", status: "error", pid, message: error && typeof error === "object" && "message" in error ? error.message : undefined },
                ],
                diagnostics: { kind: "process-check-error" },
            };
        }
        if (!runtimeAlive) {
            return {
                id: `readiness-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
                labId: lab.id,
                targetId: target.id,
                provider: lab.provider || PROVIDER_NAME,
                state: "failed",
                checkedAt: timestamp,
                checks: [
                    { name: "runtime-process", status: "fail", pid, reason: "runtime-process-not-found" },
                ],
                diagnostics: { kind: "runtime-process-not-found" },
            };
        }
        const hasObservation = ports.hasReadinessObservation();
        const sshProbe = hasObservation ? null : runSshReadinessProbe(lab);
        const agentProbe = hasObservation ? null : runSshGuestAgentProbe(lab);
        const combinedProbe = combineReadinessProbes([sshProbe, agentProbe]);
        const rawProbe = hasObservation
            ? publicReadinessProbeResult(ports.observeReadiness(lab, { target, checkedAt: timestamp }))
            : combinedProbe ? publicReadinessProbeResult(combinedProbe) : null;
        const state = rawProbe ? readinessStateFromProbe(rawProbe) : "process-running";
        const probeChecks = Array.isArray(rawProbe?.checks) ? rawProbe.checks : [];
        return {
            id: `readiness-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
            labId: lab.id,
            targetId: target.id,
            provider: lab.provider || PROVIDER_NAME,
            state,
            checkedAt: timestamp,
            checks: [
                { name: "runtime-process", status: "pass", pid },
                ...probeChecks,
                ...(rawProbe ? [] : [{ name: "guest-readiness", status: "skipped", reason: "no-bounded-guest-probe-configured" }]),
            ],
            diagnostics: rawProbe?.diagnostics || { kind: "process-only" },
        };
    }

    /** @param {Lab} lab @param {import('../domain/qemu-guest-access.mjs').QemuSession} session */
    function appendLabSession(lab, session) {
        const sessions = Array.isArray(lab.sessions) ? lab.sessions : [];
        const next = {
            ...lab,
            updatedAt: session.createdAt,
            sessions: [...sessions.filter((entry) => entry.id !== session.id), session].slice(-50),
        };
        ports.writeLab(next);
        return next;
    }

    /** @param {Lab} lab @param {Readiness} readiness */
    function recordReadiness(lab, readiness) {
        const history = Array.isArray(lab.readiness?.history) ? lab.readiness.history : [];
        const next = {
            ...lab,
            updatedAt: readiness.checkedAt,
            readiness: {
                latest: readiness,
                history: [...history.filter((entry) => entry.id !== readiness.id), readiness].slice(-50),
            },
        };
        ports.writeLab(next);
        return next;
    }

    /** @param {Args} [args] */
    function probeReadiness(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const target = targetForLab(loaded.lab);
        const targetId = args.targetId ? String(args.targetId) : target.id;
        if (targetId !== target.id) return { ok: false, error: "target-not-found", targetId, labId: loaded.lab.id };
        if (loaded.lab.runtimeState !== "running") {
            return {
                ok: false,
                error: "lab-not-running",
                ownerId: ports.ownerId(),
                lab: publicLab(loaded.lab),
                target,
                readiness: {
                    labId: loaded.lab.id,
                    targetId,
                    state: "stopped",
                    checkedAt: ports.clock(),
                    checks: [{ name: "runtime-process", status: "skipped", reason: "lab-not-running" }],
                },
            };
        }
        const readiness = buildReadinessResult(loaded.lab, target);
        const lab = recordReadiness(loaded.lab, readiness);
        return { ok: readiness.state !== "failed", ownerId: ports.ownerId(), lab: publicLab(lab), target: targetForLab(lab), readiness };
    }

    /** @param {Args} [args] */
    function inspectLab(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        if (loaded.lab.runtimeState !== "running") {
            return { ok: true, ownerId: ports.ownerId(), lab: publicLab(loaded.lab), readiness: { state: "stopped" } };
        }
        const result = probeReadiness(args);
        return { ...result, ...(!result.ok && (!("error" in result) || !result.error) ? { error: "lab-readiness-failed" } : {}) };
    }

    /** @param {Args} [args] */
    function openSession(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const timestamp = ports.clock();
        const sessionId = sessionIdFor(args, timestamp);
        if (!sessionId) return { ok: false, error: "invalid-session-id" };
        const target = targetForLab(loaded.lab);
        const targetId = args.targetId ? String(args.targetId) : target.id;
        if (targetId !== target.id) return { ok: false, error: "target-not-found", targetId, labId: loaded.lab.id };
        const sessionType = args.sessionType || "monitor";
        if (!["monitor", "metadata", "guest-ssh", "guest-agent"].some((type) => type === sessionType)) return { ok: false, error: "invalid-session-type" };
        const attach = sessionAttachFor(sessionType, loaded.lab, target);
        const session = {
            id: sessionId,
            labId: loaded.lab.id,
            targetId,
            targetKind: target.targetKind,
            sessionType,
            provider: loaded.lab.provider || PROVIDER_NAME,
            state: sessionStateFor(sessionType, target, attach),
            createdAt: timestamp,
            authority: sessionType === "guest-ssh"
                ? "device-lab-bounded-guest-ssh"
                : sessionType === "guest-agent" ? "device-lab-bounded-guest-agent" : "device-lab-metadata",
            attach,
        };
        const lab = appendLabSession(loaded.lab, session);
        if (sessionType === "guest-ssh" || sessionType === "guest-agent") {
            return { ok: true, ownerId: ports.ownerId(), lab: publicSessionLab(lab), target: publicSessionTarget(targetForLab(lab)), session };
        }
        return { ok: true, ownerId: ports.ownerId(), lab: publicLab(lab), target, session };
    }

    /** @param {Args} [args] */
    function guestAgentStatus(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const running = requireRunningLab(loaded.lab);
        if (!running.ok) return running;
        const agent = loaded.lab.guest?.agent;
        if (!agent) return { ok: false, error: "guest-agent-not-configured", ownerId: ports.ownerId(), labId: loaded.lab.id };
        const timeoutMs = boundedTimeout(args.timeoutMs, 10000);
        const probe = runSshGuestAgentProbe(loaded.lab, timeoutMs);
        const checkedAt = ports.clock();
        const status = publicReadinessProbeResult({
            id: `guest-agent-status-${checkedAt.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
            labId: loaded.lab.id,
            provider: loaded.lab.provider || PROVIDER_NAME,
            checkedAt,
            timeoutMs,
            state: readinessStateFromProbe(probe),
            ok: probe?.ok === true,
            ready: probe?.ready === true,
            checks: Array.isArray(probe?.checks) ? probe.checks : [],
            diagnostics: probe?.diagnostics || { kind: "guest-agent-readiness", available: false },
        });
        const history = Array.isArray(agent.statusHistory) ? agent.statusHistory : [];
        const next = {
            ...loaded.lab,
            updatedAt: checkedAt,
            guest: {
                ...(loaded.lab.guest || {}),
                agent: {
                    ...agent,
                    lastStatus: status,
                    statusHistory: [...history.filter((entry) => entry.id !== status.id), status].slice(-50),
                },
            },
        };
        ports.writeLab(next);
        return { ok: status.state !== "failed", ownerId: ports.ownerId(), lab: publicLab(next), status };
    }
    /** @param {Args} [args] */
    function guestExec(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const running = requireRunningLab(loaded.lab);
        if (!running.ok) return running;
        const command = validateGuestCommand(args.command);
        if (!command.ok) return command;
        const ssh = loaded.lab.guest?.ssh;
        if (!ssh) return { ok: false, error: "guest-exec-unavailable", reason: "guest-ssh-not-configured", ownerId: ports.ownerId(), labId: loaded.lab.id };
        const sshPath = ports.sshPath();
        if (!sshPath) return { ok: false, error: "guest-ssh-command-unavailable", missing: ["ssh"], ownerId: ports.ownerId(), labId: loaded.lab.id };
        const timeoutMs = boundedTimeout(args.timeoutMs, 30000);
        const sshArgs = [...sshBaseArgs(ssh), sshDestination(ssh), command.command];
        const result = ports.executeSsh(sshPath, sshArgs, loaded.lab, timeoutMs);
        return {
            ok: result?.ok === true,
            ownerId: ports.ownerId(),
            labId: loaded.lab.id,
            timeoutMs,
            result: publicGuestExecResult(result, loaded.lab, ssh, [sshPath, result?.command]),
        };
    }
    return { openSession, probeReadiness, inspectLab, guestAgentStatus, guestExec };
}
