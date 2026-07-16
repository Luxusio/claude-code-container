import { createHash } from "crypto";
import { spawn, spawnSync } from "child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export const DEFAULT_LAB_STATE_DIR = "/home/ccc/.ccc/labs";
export const PROVIDER_NAME = "container-qemu";
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
const SUPPORTED_IMAGE_FORMATS = new Set(["qcow2", "raw"]);
const DEFAULT_GUEST_ROOTS = ["/workspace", "/artifacts", "/tmp/ccc-lab"];
const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 5;
const DEFAULT_GUEST_EXEC_TIMEOUT_MS = 30000;
const MAX_GUEST_EXEC_TIMEOUT_MS = 600000;
const DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS = 120000;
const PROVIDER_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_GUEST_EXEC_COMMAND_LENGTH = 4096;
const MAX_GUEST_AGENT_HEALTH_COMMAND_LENGTH = 512;
const MAX_GUEST_AGENT_PROVISION_COMMAND_LENGTH = 4096;

function nowIso(options = {}) {
    return options.now || new Date().toISOString();
}

function projectId(projectPath) {
    const resolved = resolve(projectPath || "/project");
    const name = basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    return `${name}-${hash}`;
}

export function ownerId(env = process.env, cwd = process.cwd()) {
    const id = projectId(cwd || "/project");
    const profile = env.CCC_PROFILE ? `--p--${env.CCC_PROFILE}` : "";
    const basis = `ccc-${id}${profile}:/project/${id}`;
    return createHash("sha256").update(String(basis)).digest("hex").slice(0, 16);
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
    writeFileSync(metadataPath(ctx, lab.id), `${JSON.stringify(lab, null, 2)}\n`, { mode: 0o600 });
}

function writeImage(ctx, image) {
    mkdirSync(ownerImageDir(ctx, image.id), { recursive: true });
    writeFileSync(imageMetadataPath(ctx, image.id), `${JSON.stringify(image, null, 2)}\n`, { mode: 0o600 });
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
    const lowerPath = String(sourcePath).toLowerCase();
    const format = args.format
        ? String(args.format).toLowerCase()
        : lowerPath.endsWith(".qcow2") ? "qcow2"
            : lowerPath.endsWith(".raw") ? "raw"
                : null;
    if (!SUPPORTED_IMAGE_FORMATS.has(format)) return null;
    return format;
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

function safeSshText(value, label, pattern, maxLength) {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value) || !pattern.test(value)) {
        return { ok: false, error: `invalid-${label}` };
    }
    return { ok: true, value };
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

function guestSshInput(args = {}) {
    const nested = args.guestSsh && typeof args.guestSsh === "object" ? args.guestSsh : {};
    return {
        host: args.guestSshHost ?? nested.host,
        port: args.guestSshPort ?? nested.port,
        user: args.guestSshUser ?? nested.user,
        keyPath: args.guestSshKeyPath ?? nested.keyPath,
        readinessCommand: args.guestReadinessCommand ?? nested.readinessCommand,
    };
}

function validateGuestSsh(ctx, args = {}) {
    const input = guestSshInput(args);
    const values = Object.values(input).filter((value) => value !== undefined && value !== null && value !== "");
    if (values.length === 0) return { ok: true, ssh: null };
    if (!input.host || !input.user) return { ok: false, error: "guest-ssh-requires-host-and-user" };
    const host = safeSshText(String(input.host), "guest-ssh-host", /^[A-Za-z0-9._:-]+$/, 255);
    if (!host.ok) return host;
    const user = safeSshText(String(input.user), "guest-ssh-user", /^[A-Za-z0-9._-]+$/, 64);
    if (!user.ok) return user;
    const port = input.port === undefined || input.port === null || input.port === "" ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "invalid-guest-ssh-port" };
    const key = resolveSshKeyPath(ctx, input.keyPath);
    if (!key.ok) return key;
    const readinessCommand = input.readinessCommand === undefined || input.readinessCommand === null || input.readinessCommand === ""
        ? "true"
        : String(input.readinessCommand);
    if (readinessCommand.length > 512 || /[\u0000-\u001f]/.test(readinessCommand)) {
        return { ok: false, error: "invalid-guest-readiness-command" };
    }
    return {
        ok: true,
        ssh: {
            host: host.value,
            port,
            user: user.value,
            keyPath: key.path,
            readinessCommand,
        },
    };
}

function guestAgentInput(args = {}) {
    const nested = args.guestAgent && typeof args.guestAgent === "object" ? args.guestAgent : {};
    return {
        name: args.guestAgentName ?? nested.name,
        healthCommand: args.guestAgentHealthCommand ?? nested.healthCommand,
        provisionCommand: args.guestAgentProvisionCommand ?? nested.provisionCommand,
        autoProvision: args.guestAgentAutoProvision ?? nested.autoProvision,
    };
}

function validateGuestAgent(args = {}) {
    const input = guestAgentInput(args);
    const values = Object.values(input).filter((value) => value !== undefined && value !== null && value !== "");
    if (values.length === 0) return { ok: true, agent: null };
    const name = input.name === undefined || input.name === null || input.name === "" ? "ccc-guest-agent" : String(input.name);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, error: "invalid-guest-agent-name" };
    if (input.healthCommand === undefined || input.healthCommand === null || input.healthCommand === "") {
        return { ok: false, error: "guest-agent-requires-health-command" };
    }
    const healthCommand = String(input.healthCommand);
    if (healthCommand.length > MAX_GUEST_AGENT_HEALTH_COMMAND_LENGTH || /[\u0000-\u001f]/.test(healthCommand)) {
        return { ok: false, error: "invalid-guest-agent-health-command" };
    }
    let provisionCommand = null;
    if (input.provisionCommand !== undefined && input.provisionCommand !== null && input.provisionCommand !== "") {
        provisionCommand = String(input.provisionCommand);
        if (provisionCommand.length > MAX_GUEST_AGENT_PROVISION_COMMAND_LENGTH || /[\u0000-\u001f]/.test(provisionCommand)) {
            return { ok: false, error: "invalid-guest-agent-provision-command" };
        }
    }
    return {
        ok: true,
        agent: {
            name,
            protocol: "bounded-ssh-health-command",
            healthCommand,
            provisionCommand,
            autoProvision: input.autoProvision === true,
        },
    };
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

function runSshGuestAgentProvision(lab, options = {}) {
    const ssh = lab.guest?.ssh;
    const agent = lab.guest?.agent;
    if (!agent) {
        return {
            ok: false,
            provisioned: false,
            checks: [{ name: "guest-agent-provision", status: "fail", reason: "guest-agent-not-configured" }],
            diagnostics: { kind: "guest-agent-provision", available: false },
        };
    }
    if (!agent.provisionCommand) {
        return {
            ok: false,
            provisioned: false,
            checks: [{ name: "guest-agent-provision", status: "fail", reason: "guest-agent-provision-not-configured", agent: agent.name }],
            diagnostics: { kind: "guest-agent-provision", available: false, agent: agent.name },
        };
    }
    if (!ssh) {
        return {
            ok: false,
            provisioned: false,
            checks: [{ name: "guest-agent-provision", status: "fail", reason: "guest-ssh-not-configured", agent: agent.name }],
            diagnostics: { kind: "guest-agent-provision", available: false, agent: agent.name },
        };
    }
    const paths = sshCommandPaths(options.env || process.env, options);
    if (!paths.ssh) {
        return {
            ok: false,
            provisioned: false,
            checks: [{ name: "guest-agent-provision", status: "fail", reason: "ssh-command-missing", agent: agent.name }],
            diagnostics: { kind: "guest-agent-provision", available: false, agent: agent.name },
        };
    }
    const runner = sshRunner(options);
    const args = [...sshBaseArgs(ssh), sshDestination(ssh), agent.provisionCommand];
    const result = runner(paths.ssh, args, { cwd: lab.paths.labDir, env: options.env || process.env, timeoutMs: boundedTimeout(options.guestAgentProvisionTimeoutMs || options.sshTimeoutMs || 30000, 30000) });
    return {
        ok: result?.ok === true,
        provisioned: result?.ok === true,
        checks: [{ name: "guest-agent-provision", status: result?.ok === true ? "pass" : "fail", agent: agent.name, exitStatus: result?.status ?? null }],
        diagnostics: { kind: "guest-agent-provision", available: true, agent: agent.name, result: publicGuestExecResult(result, lab, ssh, [paths.ssh, agent.healthCommand, agent.provisionCommand]) },
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
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, MAX_GUEST_EXEC_TIMEOUT_MS);
}

function redactProviderString(value, lab, ssh, extraProviderPaths = []) {
    if (typeof value !== "string") return value;
    let next = value;
    const providerPaths = [
        ssh?.keyPath,
        lab?.paths?.labDir,
        lab?.paths?.workspaceDir,
        lab?.paths?.artifactsDir,
        lab?.paths?.snapshotsDir,
        lab?.paths?.exportsDir,
        ...extraProviderPaths,
    ].filter(Boolean).sort((left, right) => right.length - left.length);
    for (const providerPath of providerPaths) {
        next = next.split(providerPath).join("<provider-internal>");
    }
    return next;
}

function publicGuestExecResult(result, lab, ssh, extraProviderPaths = []) {
    if (!result || typeof result !== "object") return result;
    return {
        ok: result.ok === true,
        status: result.status ?? null,
        stdout: redactProviderString(result.stdout || "", lab, ssh, extraProviderPaths),
        stderr: redactProviderString(result.stderr || "", lab, ssh, extraProviderPaths),
    };
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

export function labProviderStatus(options = {}) {
    const ctx = context(options);
    const qemu = options.qemuPath ?? commandPath("qemu-system-x86_64", ctx.env);
    const qemuImg = options.qemuImgPath ?? commandPath("qemu-img", ctx.env);
    const kvmPath = options.kvmPath || "/dev/kvm";
    const networkMode = "user";
    const kvmAvailable = options.kvmAvailable ?? existsSync(kvmPath);
    let status = "unsupported";
    let reason = "";
    if (ctx.env.CCC_LAB_RUNNER !== "1") reason = "CCC_LAB_RUNNER is not enabled for this container";
    else if (ctx.env.CCC_LAB_RUNNER_STATUS !== "ready") reason = ctx.env.CCC_LAB_RUNNER_UNSUPPORTED_REASON || `lab-runner status is ${ctx.env.CCC_LAB_RUNNER_STATUS || "unset"}`;
    else if (!kvmAvailable) reason = `${kvmPath} is not available`;
    else if (!qemu) reason = "qemu-system-x86_64 is not available";
    else status = "ready";
    return {
        ok: true,
        provider: PROVIDER_NAME,
        available: status === "ready",
        status,
        unsupportedReason: reason || null,
        ownerId: ctx.owner,
        stateRoot: ctx.stateRoot,
        qemu,
        qemuImg,
        kvmPath,
        networkMode,
    };
}

export function listLabs(options = {}) {
    const ctx = context(options);
    const labsRoot = join(ctx.ownerRoot, "labs");
    if (!existsSync(labsRoot)) return { ok: true, ownerId: ctx.owner, labs: [] };
    const labs = readdirSync(labsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            try {
                const loaded = readLab(ctx, entry.name);
                return loaded.ok ? loaded.lab : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .map((lab) => publicLab(lab));
    return { ok: true, ownerId: ctx.owner, labs };
}

export function listImages(options = {}) {
    const ctx = context(options);
    const imagesRoot = join(ctx.ownerRoot, "images");
    if (!existsSync(imagesRoot)) return { ok: true, ownerId: ctx.owner, images: [] };
    const images = readdirSync(imagesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            try {
                return readJson(join(imagesRoot, entry.name, "image.json"));
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    return { ok: true, ownerId: ctx.owner, images };
}

export function importImage(args = {}, options = {}) {
    const ctx = context(options);
    const name = String(args.name || "").trim();
    const imageId = args.imageId ? String(args.imageId) : slug(name);
    if (!name) return { ok: false, error: "missing-image-name" };
    if (!validId(imageId)) return { ok: false, error: "invalid-image-id" };
    if (existsSync(imageMetadataPath(ctx, imageId)) && args.force !== true) return { ok: false, error: "base-image-already-exists", imageId };
    const source = validateImageSource(ctx, args.sourcePath, args, "source-image");
    if (!source.ok) return source;
    const sourceStat = source.stat;
    const format = source.format;
    const copy = args.copy !== false;
    const imageDir = ownerImageDir(ctx, imageId);
    const imagePath = copy ? join(imageDir, `base.${format}`) : source.path;
    if (copy) {
        mkdirSync(imageDir, { recursive: true });
        copyFileSync(source.path, imagePath);
    }
    const timestamp = nowIso(options);
    const image = {
        id: imageId,
        name,
        ownerId: ctx.owner,
        provider: PROVIDER_NAME,
        format,
        path: imagePath,
        sourcePath: source.path,
        copied: copy,
        sizeBytes: sourceStat.size,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    writeImage(ctx, image);
    return { ok: true, ownerId: ctx.owner, image };
}

function resolveBaseImage(ctx, imageId) {
    const loaded = readImage(ctx, imageId);
    if (!loaded.ok) return loaded;
    const source = validateImageSource(ctx, loaded.image.path, { format: loaded.image.format }, "base-image");
    if (!source.ok) return source;
    return { ok: true, image: { ...loaded.image, path: source.path, format: source.format, sizeBytes: source.stat.size } };
}

function validateLabSourceImage(ctx, lab) {
    const sourcePath = lab.image?.sourceImage;
    const format = lab.image?.format || inferImageFormat({}, sourcePath || "");
    return validateImageSource(ctx, sourcePath, { format }, "source-image");
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

function qemuImgCreateOverlay(lab, source, options = {}, dryRun = false) {
    const disk = validateLabDiskPath(lab);
    if (!disk.ok) return disk;
    const status = labProviderStatus(options);
    const args = [
        "create",
        "-f", "qcow2",
        "-F", source.format,
        "-b", source.path,
        disk.diskPath,
    ];
    if (dryRun) return { ok: true, dryRun: true, command: status.qemuImg || "qemu-img", args, providerStatus: status };
    if (!status.available) return { ok: false, error: "lab-provider-unsupported", providerStatus: status };
    if (!status.qemuImg) return { ok: false, error: "qemu-img-unavailable", providerStatus: status };
    mkdirSync(dirname(disk.diskPath), { recursive: true });
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
    const result = runner(status.qemuImg, args, {
        cwd: lab.paths.labDir,
        env: options.env || process.env,
        timeoutMs: boundedTimeout(options.providerCommandTimeoutMs, DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS),
    });
    if (!result?.ok) return { ok: false, error: "qemu-img-create-failed", result: publicExecution(result) };
    return { ok: true, command: status.qemuImg, args, result: publicExecution(result) };
}

export function createLab(args = {}, options = {}) {
    const ctx = context(options);
    const name = String(args.name || "").trim();
    const labId = args.labId ? String(args.labId) : slug(name);
    if (!name) return { ok: false, error: "missing-lab-name" };
    if (!validId(labId)) return { ok: false, error: "invalid-lab-id" };
    const labDir = ownerLabDir(ctx, labId);
    if (existsSync(metadataPath(ctx, labId)) && args.force !== true) return { ok: false, error: "lab-already-exists", labId };
    if (args.baseImageId && args.sourceImage) return { ok: false, error: "ambiguous-source-image" };
    const baseImage = args.baseImageId ? resolveBaseImage(ctx, String(args.baseImageId)) : null;
    if (baseImage && !baseImage.ok) return baseImage;
    const source = baseImage ? { ok: true, path: baseImage.image.path } : boundedPath(ctx, args.sourceImage, "source-image");
    if (!source.ok) return source;
    const guestSsh = validateGuestSsh(ctx, args);
    if (!guestSsh.ok) return guestSsh;
    const guestAgent = validateGuestAgent(args);
    if (!guestAgent.ok) return guestAgent;
    if (guestAgent.agent && !guestSsh.ssh) return { ok: false, error: "guest-agent-requires-guest-ssh" };
    mkdirSync(join(labDir, "disks"), { recursive: true });
    mkdirSync(join(labDir, "snapshots"), { recursive: true });
    mkdirSync(join(labDir, "artifacts"), { recursive: true });
    const timestamp = nowIso(options);
    const lab = {
        id: labId,
        name,
        ownerId: ctx.owner,
        provider: PROVIDER_NAME,
        runtimeState: "stopped",
        createdAt: timestamp,
        updatedAt: timestamp,
        resources: {
            memoryMb: Number.isInteger(args.memoryMb) ? args.memoryMb : 2048,
            cpus: Number.isInteger(args.cpus) ? args.cpus : 2,
        },
        image: {
            baseImageId: baseImage?.image?.id || null,
            sourceImage: source.path,
            diskImage: join(labDir, "disks", "root.qcow2"),
            format: baseImage?.image?.format || inferImageFormat({}, source.path || "") || "qcow2",
        },
        paths: {
            labDir,
            workspaceDir: join(labDir, "workspace"),
            snapshotsDir: join(labDir, "snapshots"),
            artifactsDir: join(labDir, "artifacts"),
            exportsDir: join(ctx.ownerRoot, "exports", labId),
        },
        runtime: null,
        guest: {
            ssh: guestSsh.ssh,
            agent: guestAgent.agent,
        },
        snapshots: [],
        fileOperations: [],
    };
    writeLab(ctx, lab);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab) };
}

export function materializeDisk(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const lab = loaded.lab;
    if (lab.runtimeState === "running") return { ok: false, error: "lab-running", labId: lab.id };
    const source = validateLabSourceImage(ctx, lab);
    if (!source.ok) return source;
    const diskPathResult = validateLabDiskPath(lab);
    if (!diskPathResult.ok) return diskPathResult;
    const diskPath = diskPathResult.diskPath;
    const exists = existsSync(diskPath);
    if (exists && args.force !== true) {
        return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), materialized: false, reused: true, diskImage: diskPath };
    }
    if (args.dryRun === true) {
        const planned = qemuImgCreateOverlay(lab, source, options, true);
        return planned.ok
            ? { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(lab), materialized: false, diskImage: diskPath, plan: publicExecution(planned) }
            : planned;
    }
    const created = qemuImgCreateOverlay(lab, source, options, false);
    if (!created.ok) return created;
    const timestamp = nowIso(options);
    const diskMetadata = {
        kind: "qcow2-overlay",
        path: diskPath,
        backingPath: source.path,
        backingFormat: source.format,
        materializedAt: timestamp,
        forced: args.force === true,
    };
    const next = {
        ...lab,
        updatedAt: timestamp,
        image: { ...lab.image, diskImage: diskPath, disk: diskMetadata },
    };
    writeLab(ctx, next);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(next), materialized: true, diskImage: diskPath, disk: diskMetadata, result: created.result };
}

export function buildQemuArgs(lab, options = {}) {
    const args = [
        "-machine", "q35,accel=kvm:tcg",
        "-m", String(lab.resources.memoryMb),
        "-smp", String(lab.resources.cpus),
        "-name", `ccc-${lab.ownerId}-${lab.id}`,
        "-display", "none",
        "-monitor", `unix:${join(lab.paths.labDir, "qemu-monitor.sock")},server,nowait`,
        "-pidfile", join(lab.paths.labDir, "qemu.pid"),
    ];
    const materializedDisk = lab.image?.disk?.path || null;
    const disk = options.preferDiskImage && materializedDisk
        ? materializedDisk
        : materializedDisk && existsSync(materializedDisk)
            ? materializedDisk
            : existsSync(lab.image.diskImage)
                ? lab.image.diskImage
                : lab.image.sourceImage;
    if (disk) args.push("-drive", `file=${disk},if=virtio,format=qcow2`);
    return args;
}

function safeReadinessState(value, fallback = "process-running") {
    return ["ready", "failed", "process-running", "stopped"].includes(value) ? value : fallback;
}

function targetForLab(lab) {
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

function publicRuntime(runtime) {
    if (!runtime || typeof runtime !== "object") return null;
    return {
        pid: runtime.pid || null,
        command: runtime.command || null,
        startedAt: runtime.startedAt || null,
    };
}

function publicGuest(guest) {
    if (!guest || typeof guest !== "object" || (!guest.ssh && !guest.agent)) return undefined;
    const ssh = guest.ssh && typeof guest.ssh === "object"
        ? {
            host: guest.ssh.host,
            port: guest.ssh.port,
            user: guest.ssh.user,
            keyConfigured: Boolean(guest.ssh.keyPath),
            readinessCommandConfigured: Boolean(guest.ssh.readinessCommand),
        }
        : null;
    const agent = guest.agent && typeof guest.agent === "object"
        ? {
            name: guest.agent.name,
            protocol: guest.agent.protocol,
            healthCommandConfigured: Boolean(guest.agent.healthCommand),
            provisionCommandConfigured: Boolean(guest.agent.provisionCommand),
            autoProvision: guest.agent.autoProvision === true,
            lastStatus: guest.agent.lastStatus || null,
            lastProvision: guest.agent.lastProvision || null,
        }
        : null;
    const result = { ...guest };
    if (ssh) result.ssh = ssh;
    else delete result.ssh;
    if (agent) result.agent = agent;
    else delete result.agent;
    return result;
}

function publicLab(lab) {
    const readiness = lab.runtimeState === "running"
        ? lab.readiness
        : lab.readiness ? { ...lab.readiness, latest: null } : lab.readiness;
    const result = {
        ...lab,
        readiness,
        runtime: publicRuntime(lab.runtime),
    };
    const guest = publicGuest(lab.guest);
    if (guest !== undefined) result.guest = guest;
    else delete result.guest;
    return result;
}

function publicMaterializedResult(result) {
    if (!result || typeof result !== "object") return result;
    return result.lab ? { ...result, lab: publicLab(result.lab) } : result;
}

function publicQemuArgs(args) {
    if (!Array.isArray(args)) return args;
    return args.map((arg, index) => {
        if (args[index - 1] === "-monitor") return "unix:<provider-internal-monitor>,server,nowait";
        if (typeof arg === "string" && arg.includes("qemu-monitor.sock")) return arg.replace(/unix:[^,]+qemu-monitor\.sock/, "unix:<provider-internal-monitor>");
        return arg;
    });
}

function publicExecution(result) {
    if (!result || typeof result !== "object") return result;
    return {
        ...result,
        args: publicQemuArgs(result.args),
    };
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
        commandTool: "lab_guest_exec",
        transferTools: ["lab_guest_push", "lab_guest_pull"],
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
        capabilities: ["lab_guest_exec", "lab_guest_push", "lab_guest_pull"],
        note: "Use bounded lab_guest_exec and guest transfer tools; raw interactive shell access is not exposed.",
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
        statusTool: "lab_guest_agent_status",
        provisionTool: "lab_guest_agent_provision",
        commandTool: "lab_guest_exec",
        transferTools: ["lab_guest_push", "lab_guest_pull"],
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
        capabilities: ["lab_guest_agent_status", "lab_guest_agent_provision", "lab_guest_exec", "lab_guest_push", "lab_guest_pull"],
        note: "Use bounded lab_guest_agent_status and lab guest tools; raw daemon sockets and interactive shells are not exposed.",
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

function publicReadinessProbeResult(result) {
    if (!result || typeof result !== "object") return {};
    const stripKeys = new Set(["args", "argv", "command", "providerArgs", "socketPath"]);
    const sanitize = (value) => {
        if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => !stripKeys.has(key))
                .map(([key, entry]) => [key, sanitize(entry)]));
        }
        if (typeof value === "string") {
            let next = value;
            if (next.includes("qemu-monitor.sock")) {
                next = next.replace(/unix:[^,\s]+qemu-monitor\.sock/g, "unix:<provider-internal-monitor>");
            }
            if (/\/[^\s"'<>]+/.test(next)) {
                next = next.replace(/\/[^\s"'<>]+/g, "<provider-internal>");
            }
            if (/^-/.test(next) || next.startsWith("file=/") || next.startsWith("/")) {
                return "<provider-internal>";
            }
            return next;
        }
        return value;
    };
    return sanitize(result);
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
    child.unref();
    return { ok: true, pid: child.pid, command, args };
}

export function startLab(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const status = labProviderStatus(options);
    const disk = validateLabDiskPath(loaded.lab);
    if (!disk.ok) return disk;
    if (args.dryRun === true) {
        const needsMaterialize = Boolean(loaded.lab.image?.sourceImage) && !existsSync(disk.diskPath);
        const materialized = needsMaterialize
            ? materializeDisk({ labId: loaded.lab.id, dryRun: true }, options)
            : { ok: true, materialized: false, reused: existsSync(disk.diskPath), lab: loaded.lab };
        if (!materialized.ok) return { ok: false, error: "lab-disk-materialize-failed", materialized };
        const planLab = needsMaterialize
            ? {
                ...loaded.lab,
                image: {
                    ...loaded.lab.image,
                    diskImage: disk.diskPath,
                    disk: { kind: "qcow2-overlay", path: disk.diskPath, backingPath: loaded.lab.image.sourceImage, backingFormat: loaded.lab.image.format || "qcow2", planned: true },
                },
            }
            : loaded.lab;
        const qemuArgs = buildQemuArgs(planLab, { preferDiskImage: needsMaterialize });
        return { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(planLab), command: status.qemu || "qemu-system-x86_64", args: publicQemuArgs(qemuArgs), providerStatus: status, materialized };
    }
    if (!status.available) return { ok: false, error: "lab-provider-unsupported", providerStatus: status };
    if (loaded.lab.runtimeState === "running") return { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), reused: true };
    const shouldMaterialize = Boolean(loaded.lab.image?.sourceImage);
    const materialized = !shouldMaterialize
        ? { ok: true, materialized: false, skipped: true, reason: "source-image-not-configured", lab: loaded.lab }
        : existsSync(disk.diskPath)
        ? { ok: true, materialized: false, reused: true, lab: loaded.lab }
        : materializeDisk({ labId: loaded.lab.id }, options);
    if (!materialized.ok) return { ok: false, error: "lab-disk-materialize-failed", materialized };
    const startLabState = materialized.lab || loaded.lab;
    const startArgs = buildQemuArgs(startLabState, { preferDiskImage: materialized.materialized === true });
    const runner = options.commandRunner || defaultCommandRunner;
    const started = runner(status.qemu, startArgs, { cwd: startLabState.paths.labDir, env: ctx.env });
    if (!started?.ok) return { ok: false, error: "lab-start-failed", result: publicExecution(started) };
    const timestamp = nowIso(options);
    const lab = {
        ...startLabState,
        runtimeState: "running",
        updatedAt: timestamp,
        runtime: { pid: started.pid || null, command: status.qemu, args: startArgs, startedAt: timestamp },
    };
    writeLab(ctx, lab);
    const shouldAutoProvision = lab.guest?.agent?.autoProvision === true && Boolean(lab.guest?.agent?.provisionCommand);
    const provision = shouldAutoProvision ? guestAgentProvision({ labId: lab.id }, options) : null;
    return { ok: true, ownerId: ctx.owner, lab: provision?.lab || publicLab(lab), materialized: publicMaterializedResult(materialized), started: publicExecution(started), guestAgentProvision: provision ? { ok: provision.ok, status: provision.status } : undefined };
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
    const ctx = context(options);
    if (args.labId !== undefined) {
        const loaded = readLab(ctx, String(args.labId || ""));
        if (!loaded.ok) return loaded;
        return { ok: true, ownerId: ctx.owner, targets: [targetForLab(loaded.lab)] };
    }
    return {
        ok: true,
        ownerId: ctx.owner,
        targets: listLabs(options).labs.map((lab) => targetForLab(lab)),
    };
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
            ? "lab-mcp-bounded-guest-ssh"
            : sessionType === "guest-agent" ? "lab-mcp-bounded-guest-agent" : "lab-mcp-metadata",
        attach,
    };
    const lab = appendLabSession(ctx, loaded.lab, session);
    if (sessionType === "guest-ssh" || sessionType === "guest-agent") {
        return { ok: true, ownerId: ctx.owner, lab: publicSessionLab(lab), target: publicSessionTarget(targetForLab(lab)), session };
    }
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), target, session };
}

export function stopLab(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const pid = loaded.lab.runtime?.pid;
    if (loaded.lab.runtimeState !== "running" || !pid) {
        return { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), stopped: false };
    }
    const kill = options.killProcess || ((targetPid) => process.kill(targetPid, args.force ? "SIGKILL" : "SIGTERM"));
    try {
        kill(pid);
    } catch (error) {
        if (error?.code !== "ESRCH") return { ok: false, error: "lab-stop-failed", message: error.message };
    }
    const lab = { ...loaded.lab, runtimeState: "stopped", updatedAt: nowIso(options), runtime: null };
    writeLab(ctx, lab);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), stopped: true };
}

export function deleteLab(args = {}, options = {}) {
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (loaded.lab.runtimeState === "running" && args.force !== true) return { ok: false, error: "lab-running", labId: loaded.lab.id };
    rmSync(ownerLabDir(ctx, loaded.lab.id), { recursive: true, force: true });
    return { ok: true, ownerId: ctx.owner, labId: loaded.lab.id, deleted: true };
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

function requireRunningLab(lab) {
    if (lab.runtimeState !== "running") return { ok: false, error: "lab-not-running", labId: lab.id };
    return { ok: true };
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
    const ctx = context(options);
    const loaded = readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const agent = loaded.lab.guest?.agent;
    if (!agent) return { ok: false, error: "guest-agent-not-configured", ownerId: ctx.owner, labId: loaded.lab.id };
    if (!agent.provisionCommand) return { ok: false, error: "guest-agent-provision-not-configured", ownerId: ctx.owner, labId: loaded.lab.id };
    const timeoutMs = boundedTimeout(args.timeoutMs, 30000);
    const probe = runSshGuestAgentProvision(loaded.lab, { ...options, env: ctx.env, guestAgentProvisionTimeoutMs: timeoutMs });
    const checkedAt = nowIso(options);
    const status = publicReadinessProbeResult({
        id: `guest-agent-provision-${checkedAt.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
        labId: loaded.lab.id,
        provider: loaded.lab.provider || PROVIDER_NAME,
        checkedAt,
        timeoutMs,
        state: probe?.ok === true ? "ready" : "failed",
        ok: probe?.ok === true,
        provisioned: probe?.provisioned === true,
        checks: Array.isArray(probe?.checks) ? probe.checks : [],
        diagnostics: probe?.diagnostics || { kind: "guest-agent-provision", available: false },
    });
    const history = Array.isArray(agent.provisionHistory) ? agent.provisionHistory : [];
    const next = {
        ...loaded.lab,
        updatedAt: checkedAt,
        guest: {
            ...(loaded.lab.guest || {}),
            agent: {
                ...agent,
                lastProvision: status,
                provisionHistory: [...history.filter((entry) => entry.id !== status.id), status].slice(-50),
            },
        },
    };
    writeLab(ctx, next);
    return { ok: status.state !== "failed", ownerId: ctx.owner, lab: publicLab(next), status };
}

export function handleLabTool(name, args = {}, options = {}) {
    if (name === "lab_status") return { ...labProviderStatus(options), labs: listLabs(options).labs };
    if (name === "lab_list") return listLabs(options);
    if (name === "lab_image_list") return listImages(options);
    if (name === "lab_image_import") return importImage(args, options);
    if (name === "lab_create") return createLab(args, options);
    if (name === "lab_disk_materialize") return materializeDisk(args, options);
    if (name === "lab_start") return startLab(args, options);
    if (name === "lab_reboot") return rebootLab(args, options);
    if (name === "lab_stop") return stopLab(args, options);
    if (name === "lab_delete") return deleteLab(args, options);
    if (name === "lab_list_targets") return listTargets(args, options);
    if (name === "lab_probe_readiness") return probeReadiness(args, options);
    if (name === "lab_open_session") return openSession(args, options);
    if (name === "lab_snapshot_create") return snapshotLab("create", args, options);
    if (name === "lab_snapshot_restore") return snapshotLab("restore", args, options);
    if (name === "lab_snapshot_delete") return snapshotLab("delete", args, options);
    if (name === "lab_sync_workspace") return syncWorkspace(args, options);
    if (name === "lab_export_artifacts") return exportArtifacts(args, options);
    if (name === "lab_guest_push") return guestPush(args, options);
    if (name === "lab_guest_pull") return guestPull(args, options);
    if (name === "lab_guest_exec") return guestExec(args, options);
    if (name === "lab_guest_agent_status") return guestAgentStatus(args, options);
    if (name === "lab_guest_agent_provision") return guestAgentProvision(args, options);
    return { ok: false, error: "unknown-lab-tool", tool: name };
}
