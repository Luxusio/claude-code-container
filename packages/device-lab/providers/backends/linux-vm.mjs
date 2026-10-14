import { createQemuGuestTransferApplication } from "../application/qemu-guest-transfer.mjs";
import { createQemuGuestAccessApplication } from "../application/qemu-guest-access.mjs";
import { createQemuOwnedDataApplication } from "../application/qemu-owned-data.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createQemuLifecycleApplication } from "../application/qemu-lifecycle.mjs";
import { safeSshText as qemuLifecycleSafeSshText, guestSshInput as qemuLifecycleGuestSshInput, guestAgentInput as qemuLifecycleGuestAgentInput, validateGuestAgent as qemuLifecycleValidateGuestAgent, publicRuntime as qemuLifecyclePublicRuntime, publicGuest as qemuLifecyclePublicGuest, publicLab as qemuLifecyclePublicLab, publicMaterializedResult as qemuLifecyclePublicMaterializedResult, publicQemuArgs as qemuLifecyclePublicQemuArgs, publicExecution as qemuLifecyclePublicExecution, redactProviderString as qemuLifecycleRedactProviderString, publicReadinessProbeResult as qemuLifecyclePublicReadinessProbeResult, publicGuestExecResult } from "../domain/qemu-lifecycle.mjs";
import { createQemuImageImportApplication } from "../application/qemu-image-import.mjs";
import { createQemuImageDiskTargetApplication } from "../application/qemu-image-disk-target.mjs";
import { inferQemuImageFormat, qemuCommandTimeout, qemuTargetForLab } from "../domain/qemu-image-disk-target.mjs";
import { buildListFilesCommand, listFilesFromExecResult } from "../file-listing.mjs";
import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { ownerId as canonicalOwnerId } from "../context.mjs";
import { textResult } from "../responses.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { readProcessIdentity, inspectProcessIdentity, signalOwnedRuntimeProcess } from "../state/process-identity.mjs";

export const DEFAULT_LAB_STATE_DIR = join(homedir(), ".ccc/labs");
export const PROVIDER_NAME = "container-qemu";
export const LINUX_VM_BACKEND = "linux-vm";
const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_CONTENT_PATTERNS = [
    { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
    { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
    { label: "secret-assignment", re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{12,}/i },
];
const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 5;
const DEFAULT_GUEST_EXEC_TIMEOUT_MS = 30000;
const PROVIDER_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_GUEST_AGENT_HEALTH_COMMAND_LENGTH = 512;
const MAX_GUEST_AGENT_PROVISION_COMMAND_LENGTH = 4096;

function nowIso(options = {}) {
    return options.now || new Date().toISOString();
}

export function ownerId(env = process.env, cwd = process.cwd()) {
    return canonicalOwnerId(env, cwd);
}

export function slug(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "";
}

function validId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value);
}

function commandPath(command, env = process.env) {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf8",
        env,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

function context(options = {}) {
    const env = options.env || process.env;
    const stateRoot = resolve(options.stateRoot || env.CCC_LAB_STATE_DIR || DEFAULT_LAB_STATE_DIR);
    const owner = options.ownerId || ownerId(env);
    const ownerRoot = join(stateRoot, "owners", owner);
    return { env, stateRoot, owner, ownerRoot };
}

function inside(root, candidate) {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ownerLabDir(ctx, labId) {
    return join(ctx.ownerRoot, "labs", labId);
}

function ownerLabPaths(ctx, labId) {
    const labDir = ownerLabDir(ctx, labId);
    return {
        labDir,
        workspaceDir: join(labDir, "workspace"),
        snapshotsDir: join(labDir, "snapshots"),
        artifactsDir: join(labDir, "artifacts"),
        exportsDir: join(ctx.ownerRoot, "exports", labId),
    };
}

function metadataPath(ctx, labId) {
    return join(ownerLabDir(ctx, labId), "lab.json");
}

function ownerImageDir(ctx, imageId) {
    return join(ctx.ownerRoot, "images", imageId);
}

function imageMetadataPath(ctx, imageId) {
    return join(ownerImageDir(ctx, imageId), "image.json");
}

function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"));
}

function writeLab(ctx, lab) {
    mkdirSync(ownerLabDir(ctx, lab.id), { recursive: true });
    writeJsonAtomically(metadataPath(ctx, lab.id), lab);
}

function writeImage(ctx, image) {
    mkdirSync(ownerImageDir(ctx, image.id), { recursive: true });
    writeJsonAtomically(imageMetadataPath(ctx, image.id), image);
}

function writeJsonAtomically(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        renameSync(temporary, file);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function readLab(ctx, labId) {
    if (!validId(labId)) return { ok: false, error: "invalid-lab-id" };
    const file = metadataPath(ctx, labId);
    if (!existsSync(file)) return { ok: false, error: "lab-not-found", labId };
    const lab = readJson(file);
    const paths = ownerLabPaths(ctx, labId);
    const guest = normalizeStoredGuest(ctx, lab.guest, paths);
    const diskImage = join(paths.labDir, "disks", "root.qcow2");
    const disk = lab.image?.disk ? { ...lab.image.disk, path: diskImage } : lab.image?.disk;
    return {
        ok: true,
        lab: {
            ...lab,
            id: labId,
            ownerId: ctx.owner,
            guest,
            paths,
            image: { ...(lab.image || {}), diskImage, disk },
        },
    };
}

function readImage(ctx, imageId) {
    if (!validId(imageId)) return { ok: false, error: "invalid-image-id" };
    const file = imageMetadataPath(ctx, imageId);
    if (!existsSync(file)) return { ok: false, error: "base-image-not-found", imageId };
    return { ok: true, image: readJson(file) };
}

function boundedPath(ctx, value, label) {
    if (value === undefined || value === null || value === "") return { ok: true, path: null };
    if (typeof value !== "string" || /[\u0000-\u001f]/.test(value) || value.includes("..")) {
        return { ok: false, error: `invalid-${label}` };
    }
    const candidate = resolve(isAbsolute(value) ? value : join(ctx.stateRoot, value));
    if (!inside(ctx.stateRoot, candidate)) return { ok: false, error: `${label}-outside-lab-state-root` };
    return { ok: true, path: candidate };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ok:true,path:string|null}|{ok:false,error:string}}
 */
function boundedUserPath(value, label) {
    if (value === undefined || value === null || value === "") return { ok: true, path: null };
    if (typeof value !== "string" || /[\u0000-\u001f]/.test(value) || value.includes("..")) {
        return { ok: false, error: `invalid-${label}` };
    }
    return { ok: true, path: value };
}

function inferImageFormat(args = {}, sourcePath = "") {
    return inferQemuImageFormat(args, sourcePath);
}

function pathInsideAny(roots, candidate) {
    return roots.some((root) => inside(root, candidate));
}

function ownerScopedSourceAllowed(ctx, candidate) {
    const ownersRoot = join(ctx.stateRoot, "owners");
    return !inside(ownersRoot, candidate) || inside(ctx.ownerRoot, candidate);
}

/** @returns {{ok:true}|{ok:false,error:string,sourcePath?:string,ancestorPath?:string}} */
function rejectSymlinkAncestors(root, candidate, label, options = {}) {
    const rootAbs = resolve(root);
    const candidateAbs = resolve(candidate);
    const rel = relative(rootAbs, candidateAbs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: `${label}-outside-lab-state-root` };
    const parts = rel.split(sep).filter(Boolean);
    let current = rootAbs;
    for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        let stat;
        try {
            stat = lstatSync(current);
        } catch (error) {
            if (options.allowMissing === true && error?.code === "ENOENT") return { ok: true };
            if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { ok: false, error: `${label}-not-found`, sourcePath: candidateAbs };
            throw error;
        }
        if (stat.isSymbolicLink()) return { ok: false, error: `${label}-symlink-ancestor-rejected`, sourcePath: candidateAbs, ancestorPath: current };
        if (!stat.isDirectory()) return { ok: false, error: `${label}-ancestor-not-directory`, sourcePath: candidateAbs, ancestorPath: current };
    }
    return { ok: true };
}

function safeSshText(value, label, pattern, maxLength){
    return qemuLifecycleSafeSshText(value, label, pattern, maxLength);
}

function resolveSshKeyPath(ctx, value) {
    if (value === undefined || value === null || value === "") return { ok: true, path: null };
    if (typeof value !== "string" || /[\u0000-\u001f]/.test(value) || value.includes("..")) {
        return { ok: false, error: "invalid-guest-ssh-key-path" };
    }
    const candidate = resolve(isAbsolute(value) ? value : join(ctx.ownerRoot, value));
    if (inside(ctx.stateRoot, candidate) && !inside(ctx.ownerRoot, candidate)) {
        return { ok: false, error: "guest-ssh-key-path-outside-owner-scope" };
    }
    const allowedRoots = [ctx.ownerRoot, homedir()].map((root) => resolve(root));
    if (!pathInsideAny(allowedRoots, candidate)) {
        return { ok: false, error: "guest-ssh-key-path-outside-allowed-roots" };
    }
    const root = allowedRoots.find((allowedRoot) => inside(allowedRoot, candidate));
    const ancestors = rejectSymlinkAncestors(root, candidate, "guest-ssh-key", { allowMissing: true });
    if (!ancestors.ok) return { ok: false, error: ancestors.error };
    try {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink()) return { ok: false, error: "guest-ssh-key-symlink-rejected" };
        if (!stat.isFile()) return { ok: false, error: "guest-ssh-key-not-file" };
    } catch (error) {
        if (error?.code === "ENOENT") return { ok: false, error: "guest-ssh-key-not-found" };
        return { ok: false, error: "guest-ssh-key-stat-failed" };
    }
    return { ok: true, path: candidate };
}

function guestSshInput(args = {}){
    return qemuLifecycleGuestSshInput(args);
}

function validateGuestSsh(ctx, args = {}) {
    return qemuLifecycleApplication().validateGuestSsh(ctx, args);
}

function guestAgentInput(args = {}){
    return qemuLifecycleGuestAgentInput(args);
}

function validateGuestAgent(args = {}){
    return qemuLifecycleValidateGuestAgent(args);
}

function redactSensitiveStrings(value, sensitiveStrings = []) {
    const sensitive = sensitiveStrings.filter((entry) => typeof entry === "string" && entry.length > 0)
        .sort((left, right) => right.length - left.length);
    if (Array.isArray(value)) return value.map((entry) => redactSensitiveStrings(entry, sensitive));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveStrings(entry, sensitive)]));
    }
    if (typeof value !== "string") return value;
    let next = value;
    for (const entry of sensitive) {
        next = next.split(entry).join("<provider-internal>");
    }
    return next;
}

function sanitizeGuestAgentStatus(status, lab, ssh, agent) {
    if (!status || typeof status !== "object") return null;
    return redactSensitiveStrings(publicReadinessProbeResult(status), [
        ssh?.keyPath,
        lab?.paths?.labDir,
        lab?.paths?.workspaceDir,
        lab?.paths?.artifactsDir,
        lab?.paths?.snapshotsDir,
        lab?.paths?.exportsDir,
        agent?.healthCommand,
        agent?.provisionCommand,
    ]);
}

function normalizeStoredGuest(ctx, guest, paths = null) {
    if (!guest || typeof guest !== "object") return guest;
    const next = { ...guest };
    if (guest.ssh) {
        const ssh = validateGuestSsh(ctx, { guestSsh: guest.ssh });
        if (ssh.ok) next.ssh = ssh.ssh;
        else {
            next.ssh = null;
            next.sshInvalid = { error: ssh.error };
        }
    }
    if (guest.agent) {
        const agent = validateGuestAgent({ guestAgent: guest.agent });
        if (agent.ok) {
            const labForRedaction = paths ? { paths } : null;
            const lastStatus = sanitizeGuestAgentStatus(guest.agent.lastStatus, labForRedaction, next.ssh, agent.agent);
            const statusHistory = Array.isArray(guest.agent.statusHistory)
                ? guest.agent.statusHistory.map((entry) => sanitizeGuestAgentStatus(entry, labForRedaction, next.ssh, agent.agent)).filter(Boolean).slice(-50)
                : [];
            const lastProvision = sanitizeGuestAgentStatus(guest.agent.lastProvision, labForRedaction, next.ssh, agent.agent);
            const provisionHistory = Array.isArray(guest.agent.provisionHistory)
                ? guest.agent.provisionHistory.map((entry) => sanitizeGuestAgentStatus(entry, labForRedaction, next.ssh, agent.agent)).filter(Boolean).slice(-50)
                : [];
            next.agent = {
                ...agent.agent,
                lastStatus,
                statusHistory,
                lastProvision,
                provisionHistory,
            };
        }
        else {
            next.agent = null;
            next.agentInvalid = { error: agent.error };
        }
    }
    return next;
}

function validateImageSource(ctx, sourcePath, formatArgs = {}, label = "source-image") {
    const source = boundedPath(ctx, sourcePath, label);
    if (!source.ok) return source;
    if (!source.path) return { ok: false, error: `${label}-not-found`, sourcePath: source.path };
    if (!ownerScopedSourceAllowed(ctx, source.path)) return { ok: false, error: `${label}-outside-owner-scope`, sourcePath: source.path };
    const ancestors = rejectSymlinkAncestors(ctx.stateRoot, source.path, label);
    if (!ancestors.ok) return ancestors;
    let sourceStat;
    try {
        sourceStat = lstatSync(source.path);
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { ok: false, error: `${label}-not-found`, sourcePath: source.path };
        throw error;
    }
    if (sourceStat.isSymbolicLink()) return { ok: false, error: `${label}-symlink-rejected`, sourcePath: source.path };
    if (!sourceStat.isFile()) return { ok: false, error: `${label}-not-file`, sourcePath: source.path };
    const format = inferImageFormat(formatArgs, source.path);
    if (!format) return { ok: false, error: "unsupported-image-format", format: formatArgs.format };
    return { ok: true, path: source.path, stat: sourceStat, format };
}

function emptyCopyPlan(sourceRoot, rootIsFile = false) {
    return { ok: true, sourceRoot, rootIsFile, files: [], totalBytes: 0 };
}

function secretContentMatch(absPath) {
    let text;
    try {
        text = readFileSync(absPath, "utf8");
    } catch (error) {
        return { error: "copy-source-content-scan-failed", reason: error?.code || "read-failed" };
    }
    for (const pattern of SECRET_CONTENT_PATTERNS) {
        if (pattern.re.test(text)) return { pattern: pattern.label };
    }
    return {};
}

function rejectSecretContent(absPath, relPath) {
    const scan = secretContentMatch(absPath);
    if (scan.error) return { ok: false, error: scan.error, path: relPath, reason: scan.reason };
    if (scan.pattern) return { ok: false, error: "copy-source-secret-content", path: relPath, pattern: scan.pattern };
    return { ok: true };
}

function collectCopyPlan(sourceRoot, policy) {
    const root = resolve(sourceRoot);
    if (!existsSync(root)) return { ok: false, error: "copy-source-not-found", sourcePath: root };
    const plan = emptyCopyPlan(root);
    const visit = (absPath, relPath) => {
        const name = basename(absPath);
        if (SECRET_FILE_RE.test(name)) return { ok: false, error: "copy-source-secret-looking-file", path: relPath || name };
        const stat = lstatSync(absPath);
        if (stat.isSymbolicLink()) return { ok: false, error: "copy-source-symlink-rejected", path: relPath || name };
        if (stat.isDirectory()) {
            const entries = readdirSync(absPath, { withFileTypes: true });
            for (const entry of entries) {
                const childAbs = join(absPath, entry.name);
                const childRel = relPath ? join(relPath, entry.name) : entry.name;
                const result = visit(childAbs, childRel);
                if (!result.ok) return result;
            }
            return { ok: true };
        }
        if (!stat.isFile()) return { ok: false, error: "copy-source-unsupported-file-type", path: relPath || name };
        if (stat.size > policy.maxFileBytes) return { ok: false, error: "copy-source-file-too-large", path: relPath || name, size: stat.size, maxFileBytes: policy.maxFileBytes };
        const content = rejectSecretContent(absPath, relPath || name);
        if (!content.ok) return content;
        plan.files.push({ absPath, relPath: relPath || name, size: stat.size });
        plan.totalBytes += stat.size;
        if (plan.files.length > policy.maxFiles) return { ok: false, error: "copy-source-too-many-files", maxFiles: policy.maxFiles };
        if (plan.totalBytes > policy.maxTotalBytes) return { ok: false, error: "copy-source-too-large", totalBytes: plan.totalBytes, maxTotalBytes: policy.maxTotalBytes };
        return { ok: true };
    };
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) return { ok: false, error: "copy-source-symlink-rejected", path: basename(root) };
    if (rootStat.isFile()) {
        const filePlan = emptyCopyPlan(root, true);
        const name = basename(root);
        if (SECRET_FILE_RE.test(name)) return { ok: false, error: "copy-source-secret-looking-file", path: name };
        if (rootStat.size > policy.maxFileBytes) return { ok: false, error: "copy-source-file-too-large", path: name, size: rootStat.size, maxFileBytes: policy.maxFileBytes };
        const content = rejectSecretContent(root, name);
        if (!content.ok) return content;
        filePlan.files.push({ absPath: root, relPath: name, size: rootStat.size });
        filePlan.totalBytes = rootStat.size;
        return filePlan;
    }
    if (!rootStat.isDirectory()) return { ok: false, error: "copy-source-unsupported-file-type", path: root };
    const result = visit(root, "");
    if (!result.ok) return result;
    return plan;
}

function copyPlanTo(plan, destinationRoot, replace = true) {
    const destination = resolve(destinationRoot);
    if (existsSync(destination)) {
        if (!replace) return { ok: false, error: "copy-destination-exists", destinationPath: destination };
        rmSync(destination, { recursive: true, force: true });
    }
    mkdirSync(destination, { recursive: true });
    for (const file of plan.files) {
        const out = join(destination, file.relPath);
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(file.absPath, out);
    }
    return {
        ok: true,
        destinationPath: destination,
        files: plan.files.length,
        bytes: plan.totalBytes,
    };
}

function defaultSyncCommandRunner(command, args, runOptions = {}) {
    const result = spawnSync(command, args, { cwd: runOptions.cwd, env: runOptions.env, encoding: "utf8", timeout: runOptions.timeoutMs });
    return {
        ok: result.status === 0,
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
        command,
        args,
    };
}

function sshCommandPaths(env = process.env, options = {}) {
    const sshPath = options.sshPath;
    return {
        ssh: sshPath === null ? null : sshPath || commandPath("ssh", env),
        scp: options.scpPath === null ? null : options.scpPath || commandPath("scp", env),
    };
}

function sshBaseArgs(ssh) {
    const args = [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SEC}`,
        "-p", String(ssh.port || 22),
    ];
    if (ssh.keyPath) args.push("-i", ssh.keyPath);
    return args;
}

function scpBaseArgs(ssh) {
    const args = [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SEC}`,
        "-P", String(ssh.port || 22),
    ];
    if (ssh.keyPath) args.push("-i", ssh.keyPath);
    return args;
}

function sshDestination(ssh) {
    return `${ssh.user}@${ssh.host}`;
}

function sshSafeGuestPath(path) {
    return typeof path === "string" && /^\/[A-Za-z0-9._/-]*$/.test(path);
}

function sshRunner(options = {}) {
    return options.sshCommandRunner || defaultSyncCommandRunner;
}

function defaultSshGuestTransportRunner(transport, contextArg = {}, options = {}) {
    const lab = contextArg.lab;
    const ssh = lab?.guest?.ssh;
    if (!ssh) return null;
    if (!sshSafeGuestPath(transport.guestPath)) {
        return { ok: false, error: "guest-ssh-path-not-shell-safe" };
    }
    const paths = sshCommandPaths(contextArg.env || process.env, options);
    if (!paths.ssh || !paths.scp) {
        return { ok: false, error: "guest-ssh-transport-unavailable", missing: [!paths.ssh ? "ssh" : null, !paths.scp ? "scp" : null].filter(Boolean) };
    }
    const runner = sshRunner(options);
    const destination = sshDestination(ssh);
    if (transport.action === "push") {
        const mkdirResult = runner(paths.ssh, [...sshBaseArgs(ssh), destination, `mkdir -p ${transport.guestPath}`], { cwd: lab.paths.labDir, env: contextArg.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
        if (mkdirResult?.ok !== true) return { ok: false, action: "push", step: "mkdir", result: publicGuestExecResult(mkdirResult, lab, ssh, [paths.ssh, paths.scp]) };
        const copyResult = runner(paths.scp, [...scpBaseArgs(ssh), "-r", `${transport.stagedPath}/.`, `${destination}:${transport.guestPath}/`], { cwd: lab.paths.labDir, env: contextArg.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
        return { ok: copyResult?.ok === true, action: "push", kind: "ssh-guest-transport", result: publicGuestExecResult(copyResult, lab, ssh, [paths.ssh, paths.scp]) };
    }
    if (transport.action === "pull") {
        const copyResult = runner(paths.scp, [...scpBaseArgs(ssh), "-r", `${destination}:${transport.guestPath}/.`, `${transport.destinationPath}/`], { cwd: lab.paths.labDir, env: contextArg.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
        return { ok: copyResult?.ok === true, action: "pull", kind: "ssh-guest-transport", result: publicGuestExecResult(copyResult, lab, ssh, [paths.ssh, paths.scp]) };
    }
    return { ok: false, error: "unsupported-guest-ssh-transport-action", action: transport.action };
}

function guestTransportRunnerForLab(lab, options = {}) {
    if (typeof options.guestTransportRunner === "function") return options.guestTransportRunner;
    if (lab?.guest?.ssh) return (transportArg, contextArg) => defaultSshGuestTransportRunner(transportArg, contextArg, options);
    return null;
}

function preflightGuestTransport(lab, transport, env, options = {}) {
    if (!lab?.guest?.ssh || typeof options.guestTransportRunner === "function") return { ok: true };
    if (!sshSafeGuestPath(transport.guestPath)) {
        return { ok: false, error: "guest-ssh-path-not-shell-safe" };
    }
    const paths = sshCommandPaths(env || process.env, options);
    const missing = [!paths.ssh ? "ssh" : null, !paths.scp ? "scp" : null].filter(Boolean);
    if (missing.length > 0) return { ok: false, error: "guest-ssh-transport-unavailable", missing };
    return { ok: true };
}

function boundedTimeout(value, fallback = DEFAULT_GUEST_EXEC_TIMEOUT_MS) {
    return qemuCommandTimeout(value, fallback);
}

function redactProviderString(value, lab, ssh, extraProviderPaths = []){
    return qemuLifecycleRedactProviderString(value, lab, ssh, extraProviderPaths);
}

function defaultProcessExists(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
    }
}

export function labProviderStatus(options = {}) { return linuxDeviceObservation(options).discovery(); }

// Inside a ccc container that cannot run nested VMs there is no lab state volume, so
// anything written under stateRoot would land in the container layer and be lost.
function labStateUnavailable(ctx) {
    if (ctx.env.CCC_LAB_RUNNER !== "1" || ctx.env.CCC_LAB_RUNNER_STATUS === "ready") return null;
    return {
        ok: false,
        error: "lab-provider-unsupported",
        unsupportedReason: ctx.env.CCC_LAB_RUNNER_UNSUPPORTED_REASON || `lab-runner status is ${ctx.env.CCC_LAB_RUNNER_STATUS || "unset"}`,
    };
}

export function listLabs(options = {}) { return linuxDeviceObservation(options).labs({strictState:options.strictState}); }

function qemuImageDiskTargetApplication(options) {
    const ctx = context(options);
    const imagesRoot = join(ctx.ownerRoot, "images");
    return createQemuImageDiskTargetApplication({
        ownerId: ctx.owner,
        get providerCommandTimeoutMs() { return options.providerCommandTimeoutMs; },
        imagesRootExists: () => existsSync(imagesRoot),
        imageEntries: () => readdirSync(imagesRoot, { withFileTypes: true }),
        readImageMetadata: (name) => readJson(join(imagesRoot, name, "image.json")),
        readLab: (labId) => readLab(ctx, labId),
        validateImageSource: (sourcePath, format) => validateImageSource(ctx, sourcePath, { format }, "source-image"),
        validateDiskPath: (lab) => validateLabDiskPath(lab),
        diskExists: (diskPath) => existsSync(diskPath),
        providerStatus: () => labProviderStatus(options),
        createOverlay: (input, status) => {
            const args = ["create", "-f", "qcow2", "-F", input.sourceFormat, "-b", input.sourcePath, input.diskPath];
            if (input.dryRun) return { ok: true, dryRun: true, command: status.qemuImg || "qemu-img", args, providerStatus: status };
            mkdirSync(dirname(input.diskPath), { recursive: true });
            const runner = options.commandRunner || ((command, commandArgs, runOptions) => {
                const result = spawnSync(command, commandArgs, {
                    cwd: runOptions.cwd,
                    env: runOptions.env,
                    encoding: "utf8",
                    timeout: runOptions.timeoutMs,
                    maxBuffer: PROVIDER_COMMAND_MAX_BUFFER_BYTES,
                });
                return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr, command, args: commandArgs };
            });
            const result = runner(status.qemuImg, args, { cwd: input.labDirectory, env: options.env || process.env, timeoutMs: input.timeoutMs });
            if (!result?.ok) return { ok: false, error: "qemu-img-create-failed", result: publicExecution(result) };
            return { ok: true, command: status.qemuImg, args, result: publicExecution(result) };
        },
        now: () => nowIso(options),
        writeLab: (lab) => writeLab(ctx, lab),
        presentLab: publicLab,
        presentExecution: publicExecution,
        ownerLabs: () => listLabs(options).labs,
    });
}

export function listImages(options = {}) {
    return qemuImageDiskTargetApplication(options).listImages();
}

export function importImage(args = {}, options = {}) {
    const ctx = context(options);
    return createQemuImageImportApplication({
        ownerId: ctx.owner,
        providerName: PROVIDER_NAME,
        runnerUnavailable: () => labStateUnavailable(ctx),
        metadataExists: (imageId) => existsSync(imageMetadataPath(ctx, imageId)),
        validateSource: (sourcePath, input, label) => validateImageSource(ctx, sourcePath, input, label),
        imageDirectory: (imageId) => ownerImageDir(ctx, imageId),
        copyDestination: (directory, format) => join(directory, `base.${format}`),
        ensureImageDirectory: (directory) => { mkdirSync(directory, { recursive: true }); },
        copyImage: (source, destination) => { copyFileSync(source, destination); },
        timestamp: () => nowIso(options),
        publishImage: (image) => writeImage(ctx, image),
    }).importImage(args);
}

function resolveBaseImage(ctx, imageId) {
    const loaded = readImage(ctx, imageId);
    if (!loaded.ok) return loaded;
    const source = validateImageSource(ctx, loaded.image.path, { format: loaded.image.format }, "base-image");
    if (!source.ok) return source;
    return { ok: true, image: { ...loaded.image, path: source.path, format: source.format, sizeBytes: source.stat.size } };
}



/** @returns {{ok:true,diskPath:string}|{ok:false,error:string,diskImage:string,ancestorPath?:string,message?:unknown}} */
function validateLabDiskPath(lab) {
    const diskPath = resolve(lab.image?.diskImage || "");
    if (!diskPath || !inside(lab.paths.labDir, diskPath)) return { ok: false, error: "disk-image-outside-lab", diskImage: diskPath };
    const ancestors = rejectSymlinkAncestors(lab.paths.labDir, diskPath, "disk-image", { allowMissing: true });
    if (!ancestors.ok) return { ok: false, error: ancestors.error, diskImage: diskPath, ancestorPath: ancestors.ancestorPath };
    try {
        const stat = lstatSync(diskPath);
        if (stat.isSymbolicLink()) return { ok: false, error: "disk-image-symlink-rejected", diskImage: diskPath };
        if (!stat.isFile()) return { ok: false, error: "disk-image-not-file", diskImage: diskPath };
    } catch (error) {
        if (error?.code !== "ENOENT") return { ok: false, error: "disk-image-stat-failed", diskImage: diskPath, message: error.message };
    }
    return { ok: true, diskPath };
}



/** @param {import('../domain/qemu-lifecycle.mjs').QemuRuntime|null|undefined} runtime
 * @returns {{status:"match"|"mismatch"|"exited"|"unavailable"}} */
function inspectQemuRuntime(runtime) {
    if (!runtime?.runtimeId || !runtime.processIdentity || typeof runtime.pid !== "number" || !Number.isInteger(runtime.pid) || runtime.pid <= 0) return { status: "unavailable" };
    const observed = inspectProcessIdentity(runtime.processIdentity, runtime.pid);
    return { status: observed.status === "match" ? "match" : observed.status === "mismatch" ? "mismatch" : observed.status === "exited" ? "exited" : "unavailable" };
}

const qemuExitWaiter = new Int32Array(new SharedArrayBuffer(4));
/** @param {import('../domain/qemu-lifecycle.mjs').QemuRuntime} runtime @param {number} timeoutMs */
function waitQemuRuntimeExit(runtime, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    do {
        const observed = inspectQemuRuntime(runtime);
        if (observed.status === "exited") return { exited: true };
        if (observed.status === "mismatch") return { exited: false, reason: observed.status };
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { exited: false, reason: observed.status === "unavailable" ? "unavailable" : "runtime-process-still-running" };
        Atomics.wait(qemuExitWaiter, 0, 0, Math.min(25, remaining));
    } while (true);
}

function qemuLifecycleApplication(options = {}) {
    return createQemuLifecycleApplication({
        providerName: PROVIDER_NAME,
        scope: () => context(options),
        runnerUnavailable: (ctx) => labStateUnavailable(ctx),
        readLab: (ctx, id) => readLab(ctx, id),
        writeLab: (ctx, lab) => writeLab(ctx, lab),
        metadataExists: (ctx, id) => existsSync(ownerLabDir(ctx, id)) || existsSync(join(ctx.ownerRoot, "exports", id)),
        labId: () => qemuCreationId(options),
        labDirectory: (ctx, id) => ownerLabDir(ctx, id),
        allocatedPath: (...segments) => join(...segments),
        ensureDirectory: (directory) => { mkdirSync(directory, { recursive: true }); },
        removeLabDirectory: (ctx, id) => { rmSync(ownerLabDir(ctx, id), { recursive: true, force: true }); },
        resolveBaseImage: (ctx, id) => resolveBaseImage(ctx, id),
        boundedSource: (ctx, value, label) => boundedPath(ctx, value, label),
        resolveSshKey: (ctx, value) => resolveSshKeyPath(ctx, value),
        validateDisk: (lab) => validateLabDiskPath(lab),
        diskExists: (file) => existsSync(file),
        imageDiskTargetApplication: () => qemuImageDiskTargetApplication(options),
        providerStatus: () => labProviderStatus(options),
        launch: (input, ctx, status) => {
            const args = nativeQemuArgs(input);
            if (input.dryRun) return { ok: true, presentation: {}, preview: { command: status.qemu || "qemu-system-x86_64", args: publicQemuArgs(args) } };
            const runner = options.commandRunner || defaultCommandRunner;
            const result = runner(status.qemu, args, { cwd: input.labDirectory, env: ctx.env });
            const presentation = publicExecution(result);
            if (!result?.ok) return { ok: false, presentation };
            return { ok: true, runtime: { pid: result.pid || null, processIdentity: result.processIdentity || null, command: status.qemu, args }, presentation };
        },
        clock: () => nowIso(options),
        runtimeId: () => randomUUID(),
        inspectRuntime: (runtime) => inspectQemuRuntime(runtime),
        waitRuntimeExit: (runtime, timeoutMs) => waitQemuRuntimeExit(runtime, timeoutMs),
        legacyKillAvailable: () => typeof options.killProcess === "function",
        legacyKill: (pid) => { options.killProcess(pid); },
        signalRuntime: (runtime, signal) => signalOwnedRuntimeProcess(runtime, signal),
        provisionGuestAgent: ({ lab, timeoutMs }, ctx) => {
            const ssh = lab.guest.ssh;
            const agent = lab.guest.agent;
            const paths = sshCommandPaths(ctx.env, options);
            if (!paths.ssh) return {
                ok: false,
                provisioned: false,
                checks: [{ name: "guest-agent-provision", status: "fail", reason: "ssh-command-missing", agent: agent.name }],
                diagnostics: { kind: "guest-agent-provision", available: false, agent: agent.name },
            };
            const result = sshRunner(options)(paths.ssh, [...sshBaseArgs(ssh), sshDestination(ssh), agent.provisionCommand], {
                cwd: lab.paths.labDir,
                env: ctx.env,
                timeoutMs: boundedTimeout(timeoutMs || options.sshTimeoutMs || 30000, 30000),
            });
            return {
                ok: result?.ok === true,
                provisioned: result?.ok === true,
                checks: [{ name: "guest-agent-provision", status: result?.ok === true ? "pass" : "fail", agent: agent.name, exitStatus: result?.status ?? null }],
                diagnostics: { kind: "guest-agent-provision", available: true, agent: agent.name, result: publicGuestExecResult(result, lab, ssh, [paths.ssh, agent.healthCommand, agent.provisionCommand]) },
            };
        },
    });
}

function qemuCreationId(options = {}) {
    return options.labId?.() ?? `linux-vm-${randomUUID()}`;
}

export function createLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).create(args);
}

export function materializeDisk(args = {}, options = {}) {
    return qemuImageDiskTargetApplication(options).materializeDisk(args);
}

export function buildQemuArgs(lab, options = {}) {
    const materializedDisk = lab.image?.disk?.path || null;
    const disk = options.preferDiskImage && materializedDisk
        ? materializedDisk
        : materializedDisk && existsSync(materializedDisk)
            ? materializedDisk
            : existsSync(lab.image.diskImage)
                ? lab.image.diskImage
                : lab.image.sourceImage;
    return nativeQemuArgs({ ownerId: lab.ownerId, labId: lab.id, memoryMb: lab.resources.memoryMb, cpus: lab.resources.cpus, labDirectory: lab.paths.labDir, diskImage: disk || null });
}

/** @param {Omit<import('../ports/qemu-lifecycle.mjs').QemuLaunchInput, 'dryRun'>} input */
function nativeQemuArgs(input) {
    const args = [
        "-machine", "q35,accel=kvm:tcg",
        "-m", String(input.memoryMb),
        "-smp", String(input.cpus),
        "-name", `ccc-${input.ownerId}-${input.labId}`,
        "-display", "none",
        "-monitor", `unix:${join(input.labDirectory, "qemu-monitor.sock")},server,nowait`,
        "-pidfile", join(input.labDirectory, "qemu.pid"),
    ];
    if (input.diskImage) args.push("-drive", `file=${input.diskImage},if=virtio,format=qcow2`);
    return args;
}

function targetForLab(lab) {
    return qemuTargetForLab(lab);
}

function publicRuntime(runtime){
    return qemuLifecyclePublicRuntime(runtime);
}

function publicGuest(guest){
    return qemuLifecyclePublicGuest(guest);
}

function publicLab(lab){
    return qemuLifecyclePublicLab(lab);
}

function publicMaterializedResult(result){
    return qemuLifecyclePublicMaterializedResult(result);
}

function publicQemuArgs(args){
    return qemuLifecyclePublicQemuArgs(args);
}

function publicExecution(result) {
    return qemuLifecyclePublicExecution(result);
}

function publicReadinessProbeResult(result){
    return qemuLifecyclePublicReadinessProbeResult(result);
}

function defaultCommandRunner(command, args, runOptions) {
    const child = spawn(command, args, { cwd: runOptions.cwd, env: runOptions.env, detached: true, stdio: "ignore" });
    const processIdentity = readProcessIdentity(child.pid);
    if (!processIdentity) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* process already exited */ }
        return { ok: false, error: "runtime-process-identity-unavailable", command, args };
    }
    child.unref();
    return { ok: true, pid: child.pid, processIdentity, command, args };
}



export function startLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).start(args);
}

export function rebootLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).reboot(args);
}

export function listTargets(args = {}, options = {}) {
    return qemuImageDiskTargetApplication(options).listTargets(args);
}

export function probeReadiness(args = {}, options = {}) {
    return qemuGuestAccessApplication(options).probeReadiness(args);
}

export function inspectLab(args = {}, options = {}) {
    return qemuGuestAccessApplication(options).inspectLab(args);
}

export function openSession(args = {}, options = {}) {
    return qemuGuestAccessApplication(options).openSession(args);
}

export function stopLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).stop(args);
}

export function deleteLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).delete(args);
}

export function snapshotLab(action, args = {}, options = {}) {
    return qemuOwnedDataApplication(options).snapshotLab(action, args);
}

export function syncWorkspace(args = {}, options = {}) {
    return qemuOwnedDataApplication(options).syncWorkspace(args);
}

function resolveGuestPullDestination(lab, destinationPath) {
    const artifactsDir = resolve(lab.paths.artifactsDir);
    const parsed = boundedUserPath(destinationPath, "destination-path");
    if (!parsed.ok) return parsed;
    const candidate = resolve(isAbsolute(parsed.path) ? parsed.path : join(artifactsDir, parsed.path));
    if (!inside(artifactsDir, candidate)) {
        return { ok: false, error: "guest-pull-destination-outside-artifacts", destinationPath: candidate, allowedRoots: [artifactsDir] };
    }
    const ancestors = rejectSymlinkAncestors(artifactsDir, candidate, "guest-pull-destination", { allowMissing: true });
    if (!ancestors.ok) return { ok: false, error: ancestors.error, destinationPath: candidate, ancestorPath: ancestors.ancestorPath };
    try {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink()) return { ok: false, error: "guest-pull-destination-symlink-rejected", destinationPath: candidate };
    } catch (error) {
        if (error?.code !== "ENOENT") return { ok: false, error: "guest-pull-destination-stat-failed", destinationPath: candidate, message: error.message };
    }
    return { ok: true, destinationPath: candidate };
}

export function exportArtifacts(args = {}, options = {}) {
    return qemuOwnedDataApplication(options).exportArtifacts(args);
}

export function guestPush(args = {}, options = {}) {
    return qemuGuestTransferApplication(options).push(args);
}

export function guestPull(args = {}, options = {}) {
    return qemuGuestTransferApplication(options).pull(args);
}

export function guestExec(args = {}, options = {}) {
    return qemuGuestAccessApplication(options).guestExec(args);
}

export function guestAgentStatus(args = {}, options = {}) {
    return qemuGuestAccessApplication(options).guestAgentStatus(args);
}

export function guestAgentProvision(args = {}, options = {}) {
    return qemuLifecycleApplication(options).provisionGuestAgent(args);
}

export const LINUX_VM_CAPABILITIES = [
    "device_list_files",
    "device_inventory",
    "device_create",
    "device_delete",
    "device_start",
    "device_stop",
    "device_status",
    "device_exec",
    "device_upload",
    "device_download",
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
    "device_image_list",
    "device_image_import",
    "device_disk_materialize",
    "device_reboot",
    "device_target_list",
    "device_readiness_probe",
    "device_session_open",
    "device_workspace_sync",
    "device_artifacts_export",
    "device_guest_agent_status",
    "device_guest_agent_provision",
];

function deviceFromLab(lab) {
    return {
        ...lab,
        deviceId: lab.id,
        backend: LINUX_VM_BACKEND,
        provider: lab.provider || PROVIDER_NAME,
        capabilities: LINUX_VM_CAPABILITIES,
    };
}

function deviceResult(result) {
    if (!result || typeof result !== "object") return result;
    const next = { ...result, backend: LINUX_VM_BACKEND };
    if (result.lab) next.device = deviceFromLab(result.lab);
    if (Array.isArray(result.labs)) next.devices = result.labs.map(deviceFromLab);
    return next;
}

function linuxVmMcpResult(result) {
    const value = deviceResult(result);
    return textResult(value?.ok !== false, JSON.stringify(value, null, 2));
}

function linuxVmArgs(args = {}) {
    const { deviceId, localPath, remotePath, ...rest } = args;
    return {
        ...rest,
        ...(deviceId ? { labId: deviceId } : {}),
        ...(localPath ? { sourcePath: localPath } : {}),
        ...(remotePath ? { guestPath: remotePath } : {}),
    };
}

function ownsLinuxVm(args = {}, options = {}) {
    if (args.backend === LINUX_VM_BACKEND) return true;
    if (typeof args.deviceId !== "string") return false;
    return listLabs(options).labs.some((lab) => lab.id === args.deviceId);
}

export function linuxVmBackend(options = {}) { return linuxDeviceObservation(options).backend(); }

export function listLinuxVmDevices(options = {}) { return linuxDeviceObservation(options).owned({strictState:options.strictState}); }

function handleLinuxVmToolUnlocked(name, args = {}, options = {}, admittedLabId) {
    const linuxArgs = linuxVmArgs(args);
    if (name === "device_inventory") {const value=linuxDeviceObservation(options).inventory(args);return value===undefined?undefined:textResult(true,JSON.stringify(value,null,2));}
    if (name === "device_create") {
        if (args.backend !== LINUX_VM_BACKEND) return undefined;
        return linuxVmMcpResult(qemuLifecycleApplication(options).create(linuxArgs, admittedLabId));
    }
    if (!ownsLinuxVm(args, options)) return undefined;

    let result;
    if (name === "device_status") {
        result = inspectLab(linuxArgs, options);
    } else if (name === "device_start") result = startLab(linuxArgs, options);
    else if (name === "device_stop") result = stopLab(linuxArgs, options);
    else if (name === "device_delete") result = deleteLab(linuxArgs, options);
    else if (name === "device_reboot") result = rebootLab(linuxArgs, options);
    else if (name === "device_disk_materialize") result = materializeDisk(linuxArgs, options);
    else if (name === "device_snapshot_list") result = snapshotLab("list", linuxArgs, options);
    else if (name === "device_snapshot_create") result = snapshotLab("create", linuxArgs, options);
    else if (name === "device_snapshot_restore") result = snapshotLab("restore", linuxArgs, options);
    else if (name === "device_snapshot_delete") result = snapshotLab("delete", linuxArgs, options);
    else if (name === "device_target_list") result = listTargets(linuxArgs, options);
    else if (name === "device_readiness_probe") result = probeReadiness(linuxArgs, options);
    else if (name === "device_session_open") result = openSession(linuxArgs, options);
    else if (name === "device_workspace_sync") result = syncWorkspace(linuxArgs, options);
    else if (name === "device_artifacts_export") result = exportArtifacts(linuxArgs, options);
    else if (name === "device_list_files") return listFilesFromExecResult(linuxVmMcpResult(guestExec({ ...linuxArgs, command: buildListFilesCommand("linux-vm", args), timeoutMs: 30000 }, options)), args);
    else if (name === "device_exec") result = guestExec({ ...linuxArgs, timeoutMs: args.helperTimeoutMs ?? args.timeoutMs }, options);
    else if (name === "device_upload") result = guestPush(linuxArgs, options);
    else if (name === "device_download") {
        result = guestPull({ ...linuxArgs, guestPath: args.remotePath, destinationPath: args.localPath }, options);
    } else if (name === "device_guest_agent_status") result = guestAgentStatus(linuxArgs, options);
    else if (name === "device_guest_agent_provision") result = guestAgentProvision(linuxArgs, options);
    else return undefined;
    return linuxVmMcpResult(result);
}

const LINUX_VM_READ_ONLY_TOOLS = new Set(["device_inventory"]);

export async function handleLinuxVmTool(name, args = {}, options = {}) {
    if (LINUX_VM_READ_ONLY_TOOLS.has(name)) return handleLinuxVmToolUnlocked(name, args, options);
    const createsDevice = name === "device_create" && args.backend === LINUX_VM_BACKEND;
    if (createsDevice && (Object.hasOwn(args, "deviceId") || Object.hasOwn(args, "labId"))) {
        return linuxVmMcpResult({ ok: false, error: "vm-creation-id-not-supported" });
    }
    const admittedLabId = createsDevice ? qemuCreationId(options) : undefined;
    const deviceId = admittedLabId ?? (typeof args.deviceId === "string" ? args.deviceId : null);
    if (!deviceId) return handleLinuxVmToolUnlocked(name, args, options);
    return withOwnerDeviceOperation("linux", deviceId, () => handleLinuxVmToolUnlocked(name, args, options, admittedLabId));
}

export async function handleLinuxVmManagementTool(name, args = {}, options = {}) {
    if (args.backend !== LINUX_VM_BACKEND) return undefined;
    if (name === "device_image_list") return linuxVmMcpResult(listImages(options));
    if (name !== "device_image_import") return undefined;
    return withOwnerDeviceOperation("linux", "__images__", () => linuxVmMcpResult(importImage(args, options)));
}

/** @param {{env?: Record<string, string | undefined>, stateRoot?: string, ownerId?: string, qemuPath?: string, qemuImgPath?: string, kvmPath?: string, kvmAvailable?: boolean}} [options] */
function linuxDeviceObservation(options = {}) {
    const ctx = context(options);
    const labsRoot = join(ctx.ownerRoot, "labs");
    return createDeviceObservation({
        kind: "linux-vm",
        capabilities: LINUX_VM_CAPABILITIES,
        ownerId: () => ctx.owner,
        now: () => Date.now(),
        readPhysicalLeases: backend => observationPhysicalLeases(backend),
        runnerFacts: () => {
            const qemu = options.qemuPath ?? commandPath("qemu-system-x86_64", ctx.env);
            const qemuImg = options.qemuImgPath ?? commandPath("qemu-img", ctx.env);
            const kvmPath = options.kvmPath || "/dev/kvm";
            return {
                ownerId: ctx.owner,
                stateRoot: ctx.stateRoot,
                runner: ctx.env.CCC_LAB_RUNNER,
                runnerStatus: ctx.env.CCC_LAB_RUNNER_STATUS,
                unsupportedReason: ctx.env.CCC_LAB_RUNNER_UNSUPPORTED_REASON,
                kvmPath,
                kvmAvailable: options.kvmAvailable ?? existsSync(kvmPath),
                qemu,
                qemuImg,
            };
        },
        labsRootExists: () => existsSync(labsRoot),
        labEntries: () => readdirSync(labsRoot, { withFileTypes: true }),
        readLab: name => readLab(ctx, name),
    });
}

/**
 * Bind trusted owner storage and guarded native copy/transport leaves for one
 * current invocation. The application receives facts and effects, not context.
 * @param {{env?:Record<string,string|undefined>,stateRoot?:string,ownerId?:string,now?:unknown,workspaceRoot?:string,allowedWorkspaceRoots?:string[],allowedGuestRoots?:unknown,guestTransportRunner?:(transport:import("../ports/qemu-guest-transfer.mjs").QemuGuestTransport,context:{lab:import("../domain/qemu-lifecycle.mjs").QemuLab,env:Record<string,string|undefined>})=>import("../ports/qemu-guest-transfer.mjs").QemuGuestTransportOutcome,sshTimeoutMs?:number,sshPath?:string|null,scpPath?:string|null,sshCommandRunner?:(command:string,args:string[],options:{cwd:string,env:Record<string,string|undefined>,timeoutMs:number})=>import("../ports/qemu-lifecycle.mjs").QemuExecution|null|undefined}} [options]
 */
function qemuGuestTransferApplication(options = {}) {
    const ctx = context(options);
    return createQemuGuestTransferApplication({
        ownerId: () => ctx.owner,
        readLab: labId => {
            const loaded = readLab(ctx, labId);
            if (typeof loaded.error === "string") return { ...loaded, ok: false, error: loaded.error };
            return { ok: true, lab: loaded.lab };
        },
        allowedGuestRoots: () => options.allowedGuestRoots,
        pathWithinRoots: (roots, path) => pathInsideAny(roots, path),
        workspaceRoot: () => options.workspaceRoot || process.cwd(),
        sourcePathFacts: path => {
            const sourcePath = resolve(path);
            const allowedRoots = (options.allowedWorkspaceRoots || [options.workspaceRoot || process.cwd()]).map(root => resolve(root));
            return { sourcePath, allowedRoots, withinRoots: pathInsideAny(allowedRoots, sourcePath) };
        },
        workspacePathFacts: lab => {
            const workspaceDir = resolve(lab.paths.workspaceDir || join(lab.paths.labDir, "workspace"));
            return { workspaceDir, insideLab: inside(lab.paths.labDir, workspaceDir) };
        },
        defaultPullDestination: (lab, name) => join(resolve(lab.paths.artifactsDir), name),
        destinationTimestamp: () => nowIso(),
        resolvePullDestination: (lab, path) => {
            const result = resolveGuestPullDestination(lab, path);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ok: true, destinationPath: result.destinationPath };
        },
        scanCopySource: (path, policy) => {
            const result = collectCopyPlan(path, policy);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ...result, ok: true };
        },
        copyPlan: (plan, destination, replace) => {
            const result = copyPlanTo(plan, destination, replace);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ...result, ok: true };
        },
        transportRunner: lab => {
            const runner = guestTransportRunnerForLab(lab, options);
            return typeof runner === "function" ? transport => runner(transport, { lab, env: ctx.env }) : null;
        },
        preflightTransport: (lab, transport) => {
            const result = preflightGuestTransport(lab, transport, ctx.env, options);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ok: true };
        },
        exists: path => existsSync(path),
        removeDirectory: path => { rmSync(path, { recursive: true, force: true }); },
        ensureDirectory: path => { mkdirSync(path, { recursive: true }); },
        writeLab: lab => { writeLab(ctx, lab); },
        clock: () => nowIso(options),
    });
}

/** Bind native owner state, current process existence and bounded SSH effects.
 * @param {{
 *   env?:Record<string,string|undefined>, stateRoot?:string, ownerId?:string, now?:string,
 *   sshPath?:string|null, scpPath?:string|null, sshTimeoutMs?:number, guestAgentTimeoutMs?:number,
 *   processExists?:import('../ports/qemu-guest-access.mjs').QemuGuestAccessPorts['processExists'],
 *   readinessProbeRunner?:import('../ports/qemu-guest-access.mjs').QemuGuestAccessPorts['observeReadiness'],
 *   sshCommandRunner?:(command:string,args:(string|undefined)[],options:{cwd:string,env:Record<string,string|undefined>,timeoutMs:number})=>(import('../ports/qemu-lifecycle.mjs').QemuExecution & {then?:never}) | null | undefined
 * }} [options]
 */
function qemuGuestAccessApplication(options = {}) {
    const ctx = context(options);
    return createQemuGuestAccessApplication({
        ownerId: () => ctx.owner,
        readLab: labId => {
            const loaded = readLab(ctx, labId);
            if (typeof loaded.error === "string") return { ...loaded, ok: false, error: loaded.error };
            return { ok: true, lab: loaded.lab };
        },
        writeLab: lab => { writeLab(ctx, lab); return undefined; },
        clock: () => nowIso(options),
        processExists: (pid, lab) => (options.processExists || defaultProcessExists)(pid, lab),
        sshAvailable: () => Boolean(sshCommandPaths(ctx.env, options).ssh),
        executeGuestCommand: (lab, commandText, timeoutMs) => {
            const command = sshCommandPaths(ctx.env, options).ssh;
            const ssh = lab.guest?.ssh;
            if (!command || !ssh) return { result: null, redactionPaths: [] };
            const args = [...sshBaseArgs(ssh), sshDestination(ssh), commandText];
            return {
                result: sshRunner(options)(command, args, { cwd: lab.paths.labDir, env: ctx.env, timeoutMs }),
                redactionPaths: [command],
            };
        },
        sshReadinessTimeoutMs: () => options.sshTimeoutMs,
        guestAgentReadinessTimeoutMs: () => options.guestAgentTimeoutMs,
        hasReadinessObservation: () => typeof options.readinessProbeRunner === "function",
        observeReadiness: (lab, facts) => typeof options.readinessProbeRunner === "function"
            ? options.readinessProbeRunner(lab, facts)
            : undefined,
    });
}

/** Bind canonical file facts and guarded copy, disk and command effects.
 * @param {{
 *   env?:Record<string,string|undefined>, stateRoot?:string, ownerId?:string, now?:string,
 *   workspaceRoot?:string, allowedWorkspaceRoots?:string[], providerCommandTimeoutMs?:unknown,
 *   qemuPath?:string, qemuImgPath?:string, kvmPath?:string, kvmAvailable?:boolean,
 *   commandRunner?:(command:string,args:string[],options:{cwd:string,env:Record<string,string|undefined>,timeoutMs:number})=>ReturnType<import('../ports/qemu-owned-data.mjs').QemuOwnedDataPorts['executeSnapshot']>
 * }} [options]
 */
function qemuOwnedDataApplication(options = {}) {
    const ctx = context(options);
    return createQemuOwnedDataApplication({
        ownerId: () => ctx.owner,
        readLab: labId => {
            const loaded = readLab(ctx, labId);
            if (typeof loaded.error === "string") return { ...loaded, ok: false, error: loaded.error };
            return { ok: true, lab: loaded.lab };
        },
        writeLab: lab => { writeLab(ctx, lab); },
        clock: () => nowIso(options),
        workspaceRoot: () => options.workspaceRoot || process.cwd(),
        sourcePathFacts: path => {
            const sourcePath = resolve(path);
            const allowedRoots = (options.allowedWorkspaceRoots || [options.workspaceRoot || process.cwd()]).map(root => resolve(root));
            return { sourcePath, allowedRoots, withinRoots: pathInsideAny(allowedRoots, sourcePath) };
        },
        workspacePathFacts: lab => {
            const destinationPath = lab.paths?.workspaceDir || join(lab.paths.labDir, "workspace");
            return { destinationPath, withinLab: inside(lab.paths.labDir, destinationPath) };
        },
        artifactRoots: lab => ({
            artifactsDir: resolve(lab.paths.artifactsDir),
            workspaceDir: resolve(lab.paths.workspaceDir || join(lab.paths.labDir, "workspace")),
        }),
        exportRoot: lab => resolve(lab.paths.exportsDir || join(ctx.ownerRoot, "exports", lab.id)),
        defaultExportName: () => nowIso().replace(/[^0-9A-Za-z._-]+/g, "-"),
        resolvePath: (base, path) => resolve(isAbsolute(path) ? path : join(base, path)),
        pathWithinRoots: (roots, path) => pathInsideAny(roots, path),
        scanCopySource: (path, policy) => {
            const result = collectCopyPlan(path, policy);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ...result, ok: true };
        },
        copyFiles: (plan, destination, replace) => {
            const result = copyPlanTo(plan, destination, replace);
            if (typeof result.error === "string") return { ...result, ok: false, error: result.error };
            return { ...result, ok: true };
        },
        diskPath: lab => {
            const result = validateLabDiskPath(lab);
            if (!result.ok) return { ...result, ok: false, error: result.error };
            return { ...result, ok: true };
        },
        fileExists: path => existsSync(path),
        qemuImgAvailable: () => Boolean(labProviderStatus(options).qemuImg),
        commandTimeoutMs: () => options.providerCommandTimeoutMs,
        executeSnapshot: (action, name, diskPath, lab, timeoutMs) => {
            const command = labProviderStatus(options).qemuImg;
            if (!command) return { ok: false, status: null, stdout: "", stderr: "qemu-img-unavailable" };
            const flag = action === "create" ? "-c" : action === "restore" ? "-a" : "-d";
            const args = ["snapshot", flag, name, diskPath];
            /** @type {NonNullable<typeof options.commandRunner>} */
            const runner = options.commandRunner || ((command, args, runOptions) => {
                const result = spawnSync(command, args, {
                    cwd: runOptions.cwd,
                    env: runOptions.env,
                    encoding: "utf8",
                    timeout: runOptions.timeoutMs,
                    maxBuffer: PROVIDER_COMMAND_MAX_BUFFER_BYTES,
                });
                return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr, command, args };
            });
            return runner(command, args, { cwd: lab.paths.labDir, env: options.env || process.env, timeoutMs });
        },
    });
}
