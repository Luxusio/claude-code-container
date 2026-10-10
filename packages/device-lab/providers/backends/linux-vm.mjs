import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createQemuLifecycleApplication } from "../application/qemu-lifecycle.mjs";
import { safeSshText as qemuLifecycleSafeSshText, guestSshInput as qemuLifecycleGuestSshInput, guestAgentInput as qemuLifecycleGuestAgentInput, validateGuestAgent as qemuLifecycleValidateGuestAgent, sshBaseArgs as qemuLifecycleSshBaseArgs, sshDestination as qemuLifecycleSshDestination, publicRuntime as qemuLifecyclePublicRuntime, publicGuest as qemuLifecyclePublicGuest, publicLab as qemuLifecyclePublicLab, publicMaterializedResult as qemuLifecyclePublicMaterializedResult, publicQemuArgs as qemuLifecyclePublicQemuArgs, publicExecution as qemuLifecyclePublicExecution, redactProviderString as qemuLifecycleRedactProviderString, publicGuestExecResult as qemuLifecyclePublicGuestExecResult, publicReadinessProbeResult as qemuLifecyclePublicReadinessProbeResult, requireRunningLab as qemuLifecycleRequireRunningLab } from "../domain/qemu-lifecycle.mjs";
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
const DEFAULT_FILE_POLICY = {
    maxFiles: 5000,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
};
const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_CONTENT_PATTERNS = [
    { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
    { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
    { label: "secret-assignment", re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{12,}/i },
];
const DEFAULT_GUEST_ROOTS = ["/workspace", "/artifacts", "/tmp/ccc-lab"];
const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 5;
const DEFAULT_GUEST_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS = 120000;
const PROVIDER_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_GUEST_EXEC_COMMAND_LENGTH = 4096;
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

function normalizePolicy(args = {}) {
    const numberOrDefault = (value, fallback, maximum) => {
        if (!Number.isInteger(value) || value <= 0) return fallback;
        return Math.min(value, maximum);
    };
    return {
        maxFiles: numberOrDefault(args.maxFiles, DEFAULT_FILE_POLICY.maxFiles, DEFAULT_FILE_POLICY.maxFiles),
        maxFileBytes: numberOrDefault(args.maxFileBytes, DEFAULT_FILE_POLICY.maxFileBytes, DEFAULT_FILE_POLICY.maxFileBytes),
        maxTotalBytes: numberOrDefault(args.maxTotalBytes, DEFAULT_FILE_POLICY.maxTotalBytes, DEFAULT_FILE_POLICY.maxTotalBytes),
    };
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

function recordFileOperation(ctx, lab, operation) {
    const fileOperations = Array.isArray(lab.fileOperations) ? lab.fileOperations : [];
    const next = {
        ...lab,
        updatedAt: operation.completedAt,
        fileOperations: [...fileOperations, operation].slice(-50),
    };
    writeLab(ctx, next);
    return next;
}

function publicGuestTransportResult(result) {
    if (!result || typeof result !== "object") return result;
    const stripKeys = new Set(["args", "argv", "command", "env", "socketPath", "privateKey", "token"]);
    const sanitize = (value) => {
        if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => !stripKeys.has(key))
                .map(([key, entry]) => [key, sanitize(entry)]));
        }
        if (typeof value === "string") {
            if (/\b(?:ssh|scp|rsync)\b/i.test(value) || /\b(?:token|secret|private|socket)\b/i.test(value) || /\/[^\s"'<>]+/.test(value)) {
                return "<provider-internal>";
            }
        }
        return value;
    };
    return sanitize(result);
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
    return {
        ssh: options.sshPath === null ? null : options.sshPath || commandPath("ssh", env),
        scp: options.scpPath === null ? null : options.scpPath || commandPath("scp", env),
    };
}

function sshBaseArgs(ssh){
    return qemuLifecycleSshBaseArgs(ssh);
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

function sshDestination(ssh){
    return qemuLifecycleSshDestination(ssh);
}

function sshSafeGuestPath(path) {
    return typeof path === "string" && /^\/[A-Za-z0-9._/-]*$/.test(path);
}

function sshRunner(options = {}) {
    return options.sshCommandRunner || defaultSyncCommandRunner;
}

function runSshReadinessProbe(lab, options = {}) {
    const ssh = lab.guest?.ssh;
    if (!ssh) return null;
    const paths = sshCommandPaths(options.env || process.env, options);
    if (!paths.ssh) {
        return {
            ok: false,
            ready: false,
            checks: [{ name: "guest-ssh-readiness", status: "fail", reason: "ssh-command-missing" }],
            diagnostics: { kind: "ssh-guest-readiness", available: false },
        };
    }
    const runner = sshRunner(options);
    const args = [...sshBaseArgs(ssh), sshDestination(ssh), ssh.readinessCommand || "true"];
    const result = runner(paths.ssh, args, { cwd: lab.paths.labDir, env: options.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
    return {
        ok: result?.ok === true,
        ready: result?.ok === true,
        checks: [{ name: "guest-ssh-readiness", status: result?.ok === true ? "pass" : "fail", exitStatus: result?.status ?? null }],
        diagnostics: { kind: "ssh-guest-readiness", available: true, result: publicExecution(result) },
    };
}

function runSshGuestAgentProbe(lab, options = {}) {
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
    const paths = sshCommandPaths(options.env || process.env, options);
    if (!paths.ssh) {
        return {
            ok: false,
            ready: false,
            checks: [{ name: "guest-agent-readiness", status: "fail", reason: "ssh-command-missing" }],
            diagnostics: { kind: "guest-agent-readiness", available: false, agent: agent.name },
        };
    }
    const runner = sshRunner(options);
    const args = [...sshBaseArgs(ssh), sshDestination(ssh), agent.healthCommand];
    const result = runner(paths.ssh, args, { cwd: lab.paths.labDir, env: options.env || process.env, timeoutMs: boundedTimeout(options.guestAgentTimeoutMs || options.sshTimeoutMs || 10000, 10000) });
    return {
        ok: result?.ok === true,
        ready: result?.ok === true,
        checks: [{ name: "guest-agent-readiness", status: result?.ok === true ? "pass" : "fail", agent: agent.name, exitStatus: result?.status ?? null }],
        diagnostics: { kind: "guest-agent-readiness", available: true, agent: agent.name, result: publicGuestExecResult(result, lab, ssh, [paths.ssh, agent.healthCommand]) },
    };
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
        if (mkdirResult?.ok !== true) return { ok: false, action: "push", step: "mkdir", result: mkdirResult };
        const copyResult = runner(paths.scp, [...scpBaseArgs(ssh), "-r", `${transport.stagedPath}/.`, `${destination}:${transport.guestPath}/`], { cwd: lab.paths.labDir, env: contextArg.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
        return { ok: copyResult?.ok === true, action: "push", kind: "ssh-guest-transport", result: copyResult };
    }
    if (transport.action === "pull") {
        const copyResult = runner(paths.scp, [...scpBaseArgs(ssh), "-r", `${destination}:${transport.guestPath}/.`, `${transport.destinationPath}/`], { cwd: lab.paths.labDir, env: contextArg.env || process.env, timeoutMs: options.sshTimeoutMs || 10000 });
        return { ok: copyResult?.ok === true, action: "pull", kind: "ssh-guest-transport", result: copyResult };
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

function validateGuestCommand(value) {
    if (typeof value !== "string" || value.trim().length === 0) return { ok: false, error: "missing-guest-command" };
    if (value.length > MAX_GUEST_EXEC_COMMAND_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        return { ok: false, error: "invalid-guest-command" };
    }
    return { ok: true, command: value };
}

function boundedTimeout(value, fallback = DEFAULT_GUEST_EXEC_TIMEOUT_MS) {
    return qemuCommandTimeout(value, fallback);
}

function redactProviderString(value, lab, ssh, extraProviderPaths = []){
    return qemuLifecycleRedactProviderString(value, lab, ssh, extraProviderPaths);
}

function publicGuestExecResult(result, lab, ssh, extraProviderPaths = []){
    return qemuLifecyclePublicGuestExecResult(result, lab, ssh, extraProviderPaths);
}

function preflightGuestExec(lab, env, options = {}) {
    const ssh = lab?.guest?.ssh;
    if (!ssh) {
        return { ok: false, error: "guest-exec-unavailable", reason: "guest-ssh-not-configured" };
    }
    const paths = sshCommandPaths(env || process.env, options);
    if (!paths.ssh) return { ok: false, error: "guest-ssh-command-unavailable", missing: ["ssh"] };
    return { ok: true, ssh, sshPath: paths.ssh };
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
        ensureDiskParent: (diskPath) => { mkdirSync(dirname(diskPath), { recursive: true }); },
        qemuImageRunner: () => options.commandRunner || ((command, commandArgs, runOptions) => {
            const result = spawnSync(command, commandArgs, {
                cwd: runOptions.cwd,
                env: runOptions.env,
                encoding: "utf8",
                timeout: runOptions.timeoutMs,
                maxBuffer: PROVIDER_COMMAND_MAX_BUFFER_BYTES,
            });
            return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr, command, args: commandArgs };
        }),
        commandEnvironment: () => options.env || process.env,
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
        metadataExists: (ctx, id) => existsSync(metadataPath(ctx, id)),
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
        launchRunner: () => options.commandRunner || defaultCommandRunner,
        clock: () => nowIso(options),
        runtimeId: () => randomUUID(),
        inspectRuntime: (runtime) => inspectQemuRuntime(runtime),
        waitRuntimeExit: (runtime, timeoutMs) => waitQemuRuntimeExit(runtime, timeoutMs),
        legacyKillAvailable: () => typeof options.killProcess === "function",
        legacyKill: (pid) => { options.killProcess(pid); },
        signalRuntime: (runtime, signal) => signalOwnedRuntimeProcess(runtime, signal),
        bindProvisionLeaves: (timeoutMs, env) => {
            const scopedOptions = { ...options, env, guestAgentProvisionTimeoutMs: timeoutMs };
            return {
                commandPaths: () => sshCommandPaths(scopedOptions.env || process.env, scopedOptions),
                commandRunner: () => sshRunner(scopedOptions),
                environment: () => scopedOptions.env || process.env,
                timeoutMs: () => boundedTimeout(scopedOptions.guestAgentProvisionTimeoutMs || scopedOptions.sshTimeoutMs || 30000, 30000),
            };
        },
    });
}

export function createLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).create(args);
}

export function materializeDisk(args = {}, options = {}) {
    return qemuImageDiskTargetApplication(options).materializeDisk(args);
}

export function buildQemuArgs(lab, options = {}) {
    return qemuLifecycleApplication().buildQemuArgs(lab, options);
}

function safeReadinessState(value, fallback = "process-running") {
    return ["ready", "failed", "process-running", "stopped"].includes(value) ? value : fallback;
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

function publicExecution(result){
    return qemuLifecyclePublicExecution(result);
}

function sessionIdFor(args, timestamp) {
    if (args.sessionId !== undefined) return validId(args.sessionId) ? String(args.sessionId) : null;
    return `session-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`;
}

function appendLabSession(ctx, lab, session) {
    const sessions = Array.isArray(lab.sessions) ? lab.sessions : [];
    const next = {
        ...lab,
        updatedAt: session.createdAt,
        sessions: [...sessions.filter((entry) => entry.id !== session.id), session].slice(-50),
    };
    writeLab(ctx, next);
    return next;
}

function guestSshSessionAttach(lab, target, ctx, options = {}) {
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
    const paths = sshCommandPaths(ctx.env, options);
    if (!paths.ssh) {
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

function guestAgentSessionAttach(lab, target, ctx, options = {}) {
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
    const paths = sshCommandPaths(ctx.env, options);
    if (!paths.ssh) {
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

function sessionAttachFor(sessionType, lab, target, ctx, options = {}) {
    if (sessionType === "monitor") {
        return {
            kind: "bounded-monitor-proxy-required",
            available: false,
            requestedTargetReady: target.attachable,
            note: "Raw QEMU monitor sockets are provider-internal; future bounded monitor/session tooling must mediate monitor commands.",
        };
    }
    if (sessionType === "guest-ssh") return guestSshSessionAttach(lab, target, ctx, options);
    if (sessionType === "guest-agent") return guestAgentSessionAttach(lab, target, ctx, options);
    return {
        kind: "metadata",
        available: true,
        note: "Metadata-only session; no guest or host command channel is opened.",
    };
}

function sessionStateFor(sessionType, target, attach) {
    if (sessionType === "guest-ssh" || sessionType === "guest-agent") return target.attachable && attach.available === true ? "open" : "unavailable";
    return target.attachable ? "open" : "unavailable";
}

function publicSessionLab(lab) {
    return {
        id: lab.id,
        name: lab.name,
        ownerId: lab.ownerId,
        provider: lab.provider || PROVIDER_NAME,
        runtimeState: lab.runtimeState,
        readiness: lab.runtimeState === "running" ? safeReadinessState(lab.readiness?.latest?.state, "process-running") : null,
    };
}

function publicSessionTarget(target) {
    const { paths, runtime, readinessProbe, ...rest } = target;
    void paths;
    void readinessProbe;
    return {
        ...rest,
        runtime: runtime ? { pid: runtime.pid || null, startedAt: runtime.startedAt || null } : null,
    };
}

function readinessStateFromProbe(probeResult) {
    if (!probeResult || typeof probeResult !== "object") return "process-running";
    if (typeof probeResult.state === "string") return safeReadinessState(probeResult.state, probeResult.ok === false ? "failed" : "process-running");
    if (probeResult.ok === false) return "failed";
    if (probeResult.ready === true) return "ready";
    return "process-running";
}

function combineReadinessProbes(probes) {
    const active = probes.filter(Boolean);
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

function publicReadinessProbeResult(result){
    return qemuLifecyclePublicReadinessProbeResult(result);
}

function buildReadinessResult(lab, target, options = {}) {
    const timestamp = nowIso(options);
    const pid = lab.runtime?.pid || null;
    const processExists = options.processExists || defaultProcessExists;
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
                { name: "runtime-process", status: "error", pid, message: error.message },
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
    const probeRunner = options.readinessProbeRunner;
    const sshProbe = typeof probeRunner === "function" ? null : runSshReadinessProbe(lab, options);
    const agentProbe = typeof probeRunner === "function" ? null : runSshGuestAgentProbe(lab, options);
    const combinedProbe = combineReadinessProbes([sshProbe, agentProbe]);
    const rawProbe = typeof probeRunner === "function"
        ? publicReadinessProbeResult(probeRunner(lab, { target, checkedAt: timestamp }))
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

function recordReadiness(ctx, lab, readiness) {
    const history = Array.isArray(lab.readiness?.history) ? lab.readiness.history : [];
    const next = {
        ...lab,
        updatedAt: readiness.checkedAt,
        readiness: {
            latest: readiness,
            history: [...history.filter((entry) => entry.id !== readiness.id), readiness].slice(-50),
        },
    };
    writeLab(ctx, next);
    return next;
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
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (loaded.lab.runtimeState !== "running" && args.startIfStopped !== true) {
        return { ok: false, error: "lab-not-running", ownerId: ctx.owner, lab: publicLab(loaded.lab), hint: "pass startIfStopped=true to start a stopped lab through reboot" };
    }
    const status = labProviderStatus(options);
    if (!status.available) return { ok: false, error: "lab-provider-unsupported", ownerId: ctx.owner, lab: publicLab(loaded.lab), providerStatus: status };
    const stop = loaded.lab.runtimeState === "running"
        ? stopLab({ labId: loaded.lab.id, force: args.force === true }, options)
        : { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), stopped: false };
    if (!stop.ok) return { ok: false, error: "lab-reboot-stop-failed", stop };
    const start = startLab({ labId: loaded.lab.id }, options);
    if (!start.ok) return { ok: false, error: "lab-reboot-start-failed", stop, start };
    return { ok: true, ownerId: ctx.owner, lab: publicLab(start.lab), rebooted: true, stop, start };
}

export function listTargets(args = {}, options = {}) {
    return qemuImageDiskTargetApplication(options).listTargets(args);
}

export function probeReadiness(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const target = targetForLab(loaded.lab);
    const targetId = args.targetId ? String(args.targetId) : target.id;
    if (targetId !== target.id) return { ok: false, error: "target-not-found", targetId, labId: loaded.lab.id };
    if (loaded.lab.runtimeState !== "running") {
        return {
            ok: false,
            error: "lab-not-running",
            ownerId: ctx.owner,
            lab: publicLab(loaded.lab),
            target,
            readiness: {
                labId: loaded.lab.id,
                targetId,
                state: "stopped",
                checkedAt: nowIso(options),
                checks: [{ name: "runtime-process", status: "skipped", reason: "lab-not-running" }],
            },
        };
    }
    const readiness = buildReadinessResult(loaded.lab, target, options);
    const lab = recordReadiness(ctx, loaded.lab, readiness);
    return { ok: readiness.state !== "failed", ownerId: ctx.owner, lab: publicLab(lab), target: targetForLab(lab), readiness };
}

export function inspectLab(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (loaded.lab.runtimeState !== "running") {
        return { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), readiness: { state: "stopped" } };
    }
    const result = probeReadiness(args, options);
    return { ...result, ...(!result.ok && !result.error ? { error: "lab-readiness-failed" } : {}) };
}

export function openSession(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const timestamp = nowIso(options);
    const sessionId = sessionIdFor(args, timestamp);
    if (!sessionId) return { ok: false, error: "invalid-session-id" };
    const target = targetForLab(loaded.lab);
    const targetId = args.targetId ? String(args.targetId) : target.id;
    if (targetId !== target.id) return { ok: false, error: "target-not-found", targetId, labId: loaded.lab.id };
    const sessionType = args.sessionType || "monitor";
    if (!["monitor", "metadata", "guest-ssh", "guest-agent"].includes(sessionType)) return { ok: false, error: "invalid-session-type" };
    const attach = sessionAttachFor(sessionType, loaded.lab, target, ctx, options);
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
    const lab = appendLabSession(ctx, loaded.lab, session);
    if (sessionType === "guest-ssh" || sessionType === "guest-agent") {
        return { ok: true, ownerId: ctx.owner, lab: publicSessionLab(lab), target: publicSessionTarget(targetForLab(lab)), session };
    }
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), target, session };
}

export function stopLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).stop(args);
}

export function deleteLab(args = {}, options = {}) {
    return qemuLifecycleApplication(options).delete(args);
}

function qemuImgSnapshot(action, lab, snapshotName, options) {
    const disk = validateLabDiskPath(lab);
    if (!disk.ok) return disk;
    if (!existsSync(disk.diskPath)) return { ok: true, diskSnapshot: false, reason: "disk-image-not-found" };
    const status = labProviderStatus(options);
    if (!status.qemuImg) return { ok: true, diskSnapshot: false, reason: "qemu-img-unavailable" };
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
    const flag = action === "create" ? "-c" : action === "restore" ? "-a" : "-d";
    return runner(status.qemuImg, ["snapshot", flag, snapshotName, disk.diskPath], {
        cwd: lab.paths.labDir,
        env: options.env || process.env,
        timeoutMs: boundedTimeout(options.providerCommandTimeoutMs, DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS),
    });
}

export function snapshotLab(action, args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (action === "list") {
        const snapshots = Array.isArray(loaded.lab.snapshots) ? loaded.lab.snapshots : [];
        return { ok: true, ownerId: ctx.owner, labId: loaded.lab.id, snapshots, activeSnapshot: loaded.lab.activeSnapshot || null };
    }
    if (loaded.lab.runtimeState === "running") return { ok: false, error: "lab-running", labId: loaded.lab.id };
    const snapshotName = slug(args.snapshotName);
    if (!validId(snapshotName)) return { ok: false, error: "invalid-snapshot-name" };
    const snapshots = Array.isArray(loaded.lab.snapshots) ? loaded.lab.snapshots : [];
    const existingIndex = snapshots.findIndex((snapshot) => snapshot.name === snapshotName);
    if (action === "create" && existingIndex >= 0) return { ok: false, error: "snapshot-already-exists", snapshotName };
    if (action !== "create" && existingIndex < 0) return { ok: false, error: "snapshot-not-found", snapshotName };
    const disk = qemuImgSnapshot(action, loaded.lab, snapshotName, options);
    if (disk && disk.ok === false) return { ok: false, error: "qemu-img-snapshot-failed", result: disk };
    const timestamp = nowIso(options);
    const nextSnapshots = action === "create"
        ? [...snapshots, { id: snapshotName, name: snapshotName, createdAt: timestamp, diskSnapshot: disk.diskSnapshot !== false }]
        : snapshots.filter((snapshot) => snapshot.name !== snapshotName || action === "restore");
    const lab = {
        ...loaded.lab,
        updatedAt: timestamp,
        activeSnapshot: action === "restore" ? snapshotName : loaded.lab.activeSnapshot,
        snapshots: nextSnapshots,
    };
    writeLab(ctx, lab);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), snapshotName, action, disk };
}

export function syncWorkspace(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const sourceInput = boundedUserPath(args.sourcePath || options.workspaceRoot || process.cwd(), "source-path");
    if (!sourceInput.ok) return sourceInput;
    const sourcePath = resolve(sourceInput.path);
    const allowedRoots = (options.allowedWorkspaceRoots || [options.workspaceRoot || process.cwd()]).map((root) => resolve(root));
    if (!pathInsideAny(allowedRoots, sourcePath)) {
        return { ok: false, error: "workspace-source-outside-allowed-roots", sourcePath, allowedRoots };
    }
    const policy = normalizePolicy(args);
    const plan = collectCopyPlan(sourcePath, policy);
    if (!plan.ok) return plan;
    const workspaceDir = loaded.lab.paths?.workspaceDir || join(loaded.lab.paths.labDir, "workspace");
    if (!inside(loaded.lab.paths.labDir, workspaceDir)) return { ok: false, error: "workspace-destination-outside-lab" };
    const copied = copyPlanTo(plan, workspaceDir, args.replace !== false);
    if (!copied.ok) return copied;
    const completedAt = nowIso(options);
    const lab = recordFileOperation(ctx, loaded.lab, {
        type: "sync_workspace",
        sourcePath,
        destinationPath: copied.destinationPath,
        files: copied.files,
        bytes: copied.bytes,
        completedAt,
    });
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), result: copied, policy };
}

function resolveArtifactSource(lab, sourcePath) {
    const artifactsDir = resolve(lab.paths.artifactsDir);
    const workspaceDir = resolve(lab.paths.workspaceDir || join(lab.paths.labDir, "workspace"));
    const raw = sourcePath || artifactsDir;
    const parsed = boundedUserPath(raw, "source-path");
    if (!parsed.ok) return parsed;
    const candidate = resolve(isAbsolute(parsed.path) ? parsed.path : join(artifactsDir, parsed.path));
    if (!pathInsideAny([artifactsDir, workspaceDir], candidate)) {
        return { ok: false, error: "artifact-source-outside-lab-roots", sourcePath: candidate, allowedRoots: [artifactsDir, workspaceDir] };
    }
    return { ok: true, sourcePath: candidate };
}

function resolveExportDestination(ctx, lab, destinationPath) {
    const exportsDir = resolve(lab.paths.exportsDir || join(ctx.ownerRoot, "exports", lab.id));
    const defaultName = nowIso().replace(/[^0-9A-Za-z._-]+/g, "-");
    const raw = destinationPath || join(exportsDir, defaultName);
    const parsed = boundedUserPath(raw, "destination-path");
    if (!parsed.ok) return parsed;
    const candidate = resolve(isAbsolute(parsed.path) ? parsed.path : join(exportsDir, parsed.path));
    const allowedRoots = [exportsDir].map((root) => resolve(root));
    if (!pathInsideAny(allowedRoots, candidate)) {
        return { ok: false, error: "artifact-destination-outside-allowed-roots", destinationPath: candidate, allowedRoots };
    }
    return { ok: true, destinationPath: candidate };
}

function normalizeGuestRoots(options = {}) {
    const roots = Array.isArray(options.allowedGuestRoots) && options.allowedGuestRoots.length > 0
        ? options.allowedGuestRoots
        : DEFAULT_GUEST_ROOTS;
    return roots
        .filter((root) => typeof root === "string" && root.startsWith("/") && !root.includes("\u0000"))
        .map((root) => root.replace(/\/+$/g, "") || "/");
}

function validateGuestPath(value, label, options = {}) {
    if (typeof value !== "string" || value.length === 0) return { ok: false, error: `missing-${label}` };
    if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: `invalid-${label}` };
    if (!value.startsWith("/")) return { ok: false, error: `${label}-must-be-absolute` };
    const parts = value.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) return { ok: false, error: `${label}-path-traversal-rejected` };
    const normalized = `/${parts.join("/")}`;
    const allowedRoots = normalizeGuestRoots(options);
    if (!pathInsideAny(allowedRoots, normalized)) {
        return { ok: false, error: `${label}-outside-allowed-roots`, guestPath: normalized, allowedGuestRoots: allowedRoots };
    }
    return { ok: true, guestPath: normalized, allowedGuestRoots: allowedRoots };
}

function resolveGuestPullDestination(lab, destinationPath) {
    const artifactsDir = resolve(lab.paths.artifactsDir);
    const defaultName = nowIso().replace(/[^0-9A-Za-z._-]+/g, "-");
    const raw = destinationPath || join(artifactsDir, `guest-pull-${defaultName}`);
    const parsed = boundedUserPath(raw, "destination-path");
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

function requireRunningLab(lab){
    return qemuLifecycleRequireRunningLab(lab);
}

export function exportArtifacts(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const source = resolveArtifactSource(loaded.lab, args.sourcePath);
    if (!source.ok) return source;
    const destination = resolveExportDestination(ctx, loaded.lab, args.destinationPath);
    if (!destination.ok) return destination;
    const policy = normalizePolicy(args);
    const plan = collectCopyPlan(source.sourcePath, policy);
    if (!plan.ok) return plan;
    const copied = copyPlanTo(plan, destination.destinationPath, args.replace !== false);
    if (!copied.ok) return copied;
    const completedAt = nowIso(options);
    const lab = recordFileOperation(ctx, loaded.lab, {
        type: "export_artifacts",
        sourcePath: source.sourcePath,
        destinationPath: copied.destinationPath,
        files: copied.files,
        bytes: copied.bytes,
        completedAt,
    });
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), result: copied, policy };
}

export function guestPush(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const guest = validateGuestPath(args.guestPath || "/workspace", "guest-path", options);
    if (!guest.ok) return guest;
    const sourceInput = boundedUserPath(args.sourcePath || options.workspaceRoot || process.cwd(), "source-path");
    if (!sourceInput.ok) return sourceInput;
    const sourcePath = resolve(sourceInput.path);
    const allowedRoots = (options.allowedWorkspaceRoots || [options.workspaceRoot || process.cwd()]).map((root) => resolve(root));
    if (!pathInsideAny(allowedRoots, sourcePath)) {
        return { ok: false, error: "workspace-source-outside-allowed-roots", sourcePath, allowedRoots };
    }
    const policy = normalizePolicy(args);
    const plan = collectCopyPlan(sourcePath, policy);
    if (!plan.ok) return plan;
    const workspaceDir = resolve(loaded.lab.paths.workspaceDir || join(loaded.lab.paths.labDir, "workspace"));
    if (!inside(loaded.lab.paths.labDir, workspaceDir)) return { ok: false, error: "workspace-destination-outside-lab" };
    const transport = {
        action: "push",
        labId: loaded.lab.id,
        sourcePath,
        stagedPath: workspaceDir,
        guestPath: guest.guestPath,
        files: plan.files.length,
        bytes: plan.totalBytes,
        replace: args.replace !== false,
        allowedGuestRoots: guest.allowedGuestRoots,
    };
    if (args.dryRun === true) {
        return { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(loaded.lab), transport, policy };
    }
    const runner = guestTransportRunnerForLab(loaded.lab, options);
    if (typeof runner !== "function") {
        return { ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy };
    }
    const preflight = preflightGuestTransport(loaded.lab, transport, ctx.env, options);
    if (!preflight.ok) return { ...preflight, transport, policy };
    const copied = copyPlanTo(plan, workspaceDir, args.replace !== false);
    if (!copied.ok) return copied;
    const result = publicGuestTransportResult(runner({ ...transport, stagedPath: copied.destinationPath }, { lab: loaded.lab, env: ctx.env }));
    if (result === null) {
        rmSync(copied.destinationPath, { recursive: true, force: true });
        return { ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport: { ...transport, stagedPath: copied.destinationPath }, policy, cleanedStagedPath: true };
    }
    if (!result?.ok) {
        rmSync(copied.destinationPath, { recursive: true, force: true });
        const failedAt = nowIso(options);
        const lab = recordFileOperation(ctx, loaded.lab, {
            type: "guest_push_failed",
            sourcePath,
            stagedPath: copied.destinationPath,
            guestPath: guest.guestPath,
            files: copied.files,
            bytes: copied.bytes,
            completedAt: failedAt,
            error: "guest-push-failed",
        });
        return { ok: false, error: "guest-push-failed", lab: publicLab(lab), result, transport: { ...transport, stagedPath: copied.destinationPath }, policy, cleanedStagedPath: true };
    }
    const completedAt = nowIso(options);
    const lab = recordFileOperation(ctx, loaded.lab, {
        type: "guest_push",
        sourcePath,
        stagedPath: copied.destinationPath,
        guestPath: guest.guestPath,
        files: copied.files,
        bytes: copied.bytes,
        completedAt,
    });
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), result, transport: { ...transport, stagedPath: copied.destinationPath }, policy };
}

export function guestPull(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const guest = validateGuestPath(args.guestPath || "/artifacts", "guest-path", options);
    if (!guest.ok) return guest;
    const destination = resolveGuestPullDestination(loaded.lab, args.destinationPath);
    if (!destination.ok) return destination;
    const policy = normalizePolicy(args);
    const transport = {
        action: "pull",
        labId: loaded.lab.id,
        guestPath: guest.guestPath,
        destinationPath: destination.destinationPath,
        replace: args.replace !== false,
        allowedGuestRoots: guest.allowedGuestRoots,
    };
    if (args.dryRun === true) {
        return { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(loaded.lab), transport, policy };
    }
    if (existsSync(destination.destinationPath)) {
        if (args.replace === false) return { ok: false, error: "guest-pull-destination-exists", destinationPath: destination.destinationPath };
    }
    const runner = guestTransportRunnerForLab(loaded.lab, options);
    if (typeof runner !== "function") {
        return { ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy };
    }
    const preflight = preflightGuestTransport(loaded.lab, transport, ctx.env, options);
    if (!preflight.ok) return { ...preflight, transport, policy };
    if (existsSync(destination.destinationPath)) {
        rmSync(destination.destinationPath, { recursive: true, force: true });
    }
    mkdirSync(destination.destinationPath, { recursive: true });
    const result = publicGuestTransportResult(runner(transport, { lab: loaded.lab, env: ctx.env }));
    if (result === null) {
        rmSync(destination.destinationPath, { recursive: true, force: true });
        return { ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy, cleanedDestination: true };
    }
    if (!result?.ok) {
        rmSync(destination.destinationPath, { recursive: true, force: true });
        const failedAt = nowIso(options);
        const lab = recordFileOperation(ctx, loaded.lab, {
            type: "guest_pull_failed",
            guestPath: guest.guestPath,
            destinationPath: destination.destinationPath,
            completedAt: failedAt,
            error: "guest-pull-failed",
        });
        return { ok: false, error: "guest-pull-failed", lab: publicLab(lab), result, transport, policy, cleanedDestination: true };
    }
    const plan = collectCopyPlan(destination.destinationPath, policy);
    if (!plan.ok) {
        rmSync(destination.destinationPath, { recursive: true, force: true });
        const failedAt = nowIso(options);
        const lab = recordFileOperation(ctx, loaded.lab, {
            type: "guest_pull_failed",
            guestPath: guest.guestPath,
            destinationPath: destination.destinationPath,
            completedAt: failedAt,
            error: plan.error || "guest-pull-policy-failed",
        });
        return { ...plan, lab: publicLab(lab), destinationPath: destination.destinationPath, cleanedDestination: true };
    }
    const completedAt = nowIso(options);
    const lab = recordFileOperation(ctx, loaded.lab, {
        type: "guest_pull",
        guestPath: guest.guestPath,
        destinationPath: destination.destinationPath,
        files: plan.files.length,
        bytes: plan.totalBytes,
        completedAt,
    });
    return {
        ok: true,
        ownerId: ctx.owner,
        lab: publicLab(lab),
        result,
        transport: { ...transport, files: plan.files.length, bytes: plan.totalBytes },
        policy,
    };
}

export function guestExec(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const command = validateGuestCommand(args.command);
    if (!command.ok) return command;
    const preflight = preflightGuestExec(loaded.lab, ctx.env, options);
    if (!preflight.ok) return { ...preflight, ownerId: ctx.owner, labId: loaded.lab.id };
    const timeoutMs = boundedTimeout(args.timeoutMs);
    const runner = sshRunner(options);
    const sshArgs = [...sshBaseArgs(preflight.ssh), sshDestination(preflight.ssh), command.command];
    const result = runner(preflight.sshPath, sshArgs, {
        cwd: loaded.lab.paths.labDir,
        env: ctx.env,
        timeoutMs,
    });
    return {
        ok: result?.ok === true,
        ownerId: ctx.owner,
        labId: loaded.lab.id,
        timeoutMs,
        result: publicGuestExecResult(result, loaded.lab, preflight.ssh, [preflight.sshPath, result?.command]),
    };
}

export function guestAgentStatus(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const agent = loaded.lab.guest?.agent;
    if (!agent) return { ok: false, error: "guest-agent-not-configured", ownerId: ctx.owner, labId: loaded.lab.id };
    const timeoutMs = boundedTimeout(args.timeoutMs, 10000);
    const probe = runSshGuestAgentProbe(loaded.lab, { ...options, env: ctx.env, guestAgentTimeoutMs: timeoutMs });
    const checkedAt = nowIso(options);
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
    writeLab(ctx, next);
    return { ok: status.state !== "failed", ownerId: ctx.owner, lab: publicLab(next), status };
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

function handleLinuxVmToolUnlocked(name, args = {}, options = {}) {
    const linuxArgs = linuxVmArgs(args);
    if (name === "device_inventory") {const value=linuxDeviceObservation(options).inventory(args);return value===undefined?undefined:textResult(true,JSON.stringify(value,null,2));}
    if (name === "device_create") {
        if (args.backend !== LINUX_VM_BACKEND) return undefined;
        return linuxVmMcpResult(createLab({ ...linuxArgs, labId: args.deviceId }, options));
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

const LINUX_VM_READ_ONLY_TOOLS = new Set(["device_inventory", "device_target_list"]);

export async function handleLinuxVmTool(name, args = {}, options = {}) {
    if (LINUX_VM_READ_ONLY_TOOLS.has(name)) return handleLinuxVmToolUnlocked(name, args, options);
    const deviceId = typeof args.deviceId === "string"
        ? args.deviceId
        : name === "device_create" && typeof args.name === "string"
            ? slug(args.name)
            : null;
    if (!deviceId || (args.backend !== LINUX_VM_BACKEND && !ownsLinuxVm(args, options))) {
        return handleLinuxVmToolUnlocked(name, args, options);
    }
    return withOwnerDeviceOperation("linux", deviceId, () => handleLinuxVmToolUnlocked(name, args, options));
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
