/** Domain-owned mutable facts mirror the existing public structural carriers.
 * @typedef {{[key: string]: unknown, pid?: unknown, command?: unknown, startedAt?: unknown}} QemuRuntime
 * @typedef {{
 *   [key: string]: unknown,
 *   id: string,
 *   name: string,
 *   provider?: string,
 *   runtimeState: string,
 *   image?: {[key: string]: unknown, sourceImage?: string, diskImage?: string, format?: unknown},
 *   paths: {[key: string]: unknown, labDir: string, workspaceDir: string, artifactsDir: string},
 *   runtime?: unknown,
 *   readiness?: {[key: string]: unknown, latest?: {[key: string]: unknown, state?: unknown} | null},
 *   guest?: {[key: string]: unknown, ssh?: unknown, agent?: unknown}
 * }} QemuLab
 * @typedef {{[key: string]: unknown, ok: true, path: string, format: string}} QemuImageSource
 * @typedef {{
 *   id: string, labId: string, name: string, targetKind: string, provider: string, runtimeState: string,
 *   readiness: string, sessionState: string, attachable: boolean, creatable: boolean,
 *   runtime: {pid: unknown, command: unknown, startedAt: unknown} | null,
 *   readinessProbe: {[key: string]: unknown, state?: unknown} | null,
 *   paths: {workspaceDir: string, artifactsDir: string},
 *   sessionHints: {monitor: string, metadata: string, guestSsh: string, guestAgent: string}
 * }} QemuTarget
 */
const SUPPORTED_IMAGE_FORMATS = new Set(["qcow2", "raw"]);
const MAX_GUEST_EXEC_TIMEOUT_MS = 600000;
const PROVIDER_NAME = "container-qemu";

/** @param {{format?: unknown}} [args] @param {unknown} [sourcePath] @returns {"qcow2" | "raw" | null} */
export function inferQemuImageFormat(args = {}, sourcePath = "") {
    const lowerPath = String(sourcePath).toLowerCase();
    const format = args.format
        ? String(args.format).toLowerCase()
        : lowerPath.endsWith(".qcow2") ? "qcow2"
            : lowerPath.endsWith(".raw") ? "raw"
                : null;
    if (!SUPPORTED_IMAGE_FORMATS.has(/** @type {string} */ (format))) return null;
    return /** @type {"qcow2" | "raw"} */ (format);
}
/** @param {unknown} value @param {number} fallback @returns {number} */
export function qemuCommandTimeout(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, MAX_GUEST_EXEC_TIMEOUT_MS);
}

/** @param {unknown} value @param {string} [fallback] @returns {string} */
function safeReadinessState(value, fallback = "process-running") {
    return ["ready", "failed", "process-running", "stopped"].includes(/** @type {string} */ (value)) ? /** @type {string} */ (value) : fallback;
}

/** @param {QemuLab} lab @returns {QemuTarget} */
export function qemuTargetForLab(lab) {
    const running = lab.runtimeState === "running";
    const latestReadiness = running ? lab.readiness?.latest || null : null;
    const readiness = running ? safeReadinessState(latestReadiness?.state, "process-running") : "stopped";
    const hasGuestSsh = Boolean(lab.guest?.ssh);
    const hasGuestAgent = Boolean(lab.guest?.agent);
    return {
        id: `${lab.id}:vm`,
        labId: lab.id,
        name: lab.name,
        targetKind: "lab-vm",
        provider: lab.provider || PROVIDER_NAME,
        runtimeState: lab.runtimeState,
        readiness,
        sessionState: running && readiness !== "failed" ? "attachable" : "unavailable",
        attachable: running && readiness !== "failed",
        creatable: false,
        runtime: publicRuntime(lab.runtime),
        readinessProbe: latestReadiness,
        paths: {
            workspaceDir: lab.paths.workspaceDir,
            artifactsDir: lab.paths.artifactsDir,
        },
        sessionHints: {
            monitor: running ? "bounded-monitor-proxy-required" : "start-lab-before-opening-monitor-session",
            metadata: "available",
            guestSsh: running
                ? hasGuestSsh ? "bounded-guest-ssh-session-available" : "configure-guest-ssh-before-opening-guest-session"
                : "start-lab-before-opening-guest-session",
            guestAgent: running
                ? hasGuestAgent ? "bounded-guest-agent-session-available" : "configure-guest-agent-before-opening-agent-session"
                : "start-lab-before-opening-agent-session",
        },
    };
}

/** @param {unknown} runtime */
function publicRuntime(runtime) {
    if (!runtime || typeof runtime !== "object") return null;
    const record = /** @type {QemuRuntime} */ (runtime);
    return {
        pid: record.pid || null,
        command: record.command || null,
        startedAt: record.startedAt || null,
    };
}
