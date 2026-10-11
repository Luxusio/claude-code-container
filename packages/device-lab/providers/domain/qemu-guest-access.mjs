import { validQemuLabId as validId } from "./qemu-lifecycle.mjs";
import { qemuTargetForLab } from "./qemu-image-disk-target.mjs";
/** @typedef {import('./qemu-lifecycle.mjs').QemuLab & {sessions?:QemuSession[],readiness?:{latest?:QemuReadiness|null,history?:QemuReadiness[]},guest?:import('./qemu-lifecycle.mjs').QemuGuest & {agent?:import('./qemu-lifecycle.mjs').QemuAgent & {statusHistory?:QemuReadiness[]}}}} QemuAccessLab */
/** @typedef {{[key:string]:unknown,id?:string,state?:string,ok?:boolean,ready?:boolean,checkedAt?:string,checks?:unknown[],diagnostics?:unknown}} QemuReadiness */
/** @typedef {{[key:string]:unknown,id:string,createdAt:string}} QemuSession */
const PROVIDER_NAME = "container-qemu";
/** @param {unknown} value @param {string} [fallback] */
export function safeReadinessState(value, fallback = "process-running") {
    return typeof value === "string" && ["ready", "failed", "process-running", "stopped"].includes(value) ? value : fallback;
}

/** @param {{sessionId?:unknown}} args @param {string} timestamp */
export function sessionIdFor(args, timestamp) {
    if (args.sessionId !== undefined) return validId(args.sessionId) ? String(args.sessionId) : null;
    return `session-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`;
}

/** @param {unknown} sessionType @param {import('./qemu-image-disk-target.mjs').QemuTarget} target @param {{available:boolean}} attach */
export function sessionStateFor(sessionType, target, attach) {
    if (sessionType === "guest-ssh" || sessionType === "guest-agent") return target.attachable && attach.available === true ? "open" : "unavailable";
    return target.attachable ? "open" : "unavailable";
}

/** @param {QemuAccessLab} lab */
export function publicSessionLab(lab) {
    return {
        id: lab.id,
        name: lab.name,
        ownerId: lab.ownerId,
        provider: lab.provider || PROVIDER_NAME,
        runtimeState: lab.runtimeState,
        readiness: lab.runtimeState === "running" ? safeReadinessState(lab.readiness?.latest?.state, "process-running") : null,
    };
}

/** @param {import('./qemu-image-disk-target.mjs').QemuTarget} target */
export function publicSessionTarget(target) {
    const { paths, runtime, readinessProbe, ...rest } = target;
    void paths;
    void readinessProbe;
    return {
        ...rest,
        runtime: runtime ? { pid: runtime.pid || null, startedAt: runtime.startedAt || null } : null,
    };
}

/** @param {QemuReadiness|null|undefined} probeResult */
export function readinessStateFromProbe(probeResult) {
    if (!probeResult || typeof probeResult !== "object") return "process-running";
    if (typeof probeResult.state === "string") return safeReadinessState(probeResult.state, probeResult.ok === false ? "failed" : "process-running");
    if (probeResult.ok === false) return "failed";
    if (probeResult.ready === true) return "ready";
    return "process-running";
}

/** @param {(QemuReadiness|null|undefined)[]} probes */
export function combineReadinessProbes(probes) {
    const active = probes.filter((probe) => probe !== null && probe !== undefined);
    if (active.length === 0) return null;
    const checks = active.flatMap((probe) => Array.isArray(probe.checks) ? probe.checks : []);
    const diagnostics = active.map((probe) => probe.diagnostics).filter(Boolean);
    const failed = active.some((probe) => probe.ok === false || probe.ready === false || readinessStateFromProbe(probe) === "failed");
    const ready = !failed && active.every((probe) => probe.ready === true || readinessStateFromProbe(probe) === "ready");
    return {
        ok: !failed,
        ready,
        state: failed ? "failed" : ready ? "ready" : "process-running",
        checks,
        diagnostics: {
            kind: "combined-guest-readiness",
            probes: diagnostics,
        },
    };
}

/** The image carrier is not a target fact; retain the actual runtime, guest and readiness observations.
 * @param {QemuAccessLab} lab
 */
export function guestAccessTarget(lab) {
    return qemuTargetForLab({
        id: lab.id,
        name: lab.name,
        provider: lab.provider,
        runtimeState: lab.runtimeState,
        paths: lab.paths,
        runtime: lab.runtime,
        guest: lab.guest,
        readiness: lab.readiness,
    });
}

/** @param {unknown} value
 * @returns {{ok:true,command:string}|{ok:false,error:string}} */
export function validateGuestCommand(value) {
    if (typeof value !== "string" || value.trim().length === 0) return { ok: false, error: "missing-guest-command" };
    if (value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        return { ok: false, error: "invalid-guest-command" };
    }
    return { ok: true, command: value };
}
