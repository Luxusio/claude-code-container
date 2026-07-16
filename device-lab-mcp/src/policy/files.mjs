import { lstatSync, readFileSync } from "fs";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "path";

const DEFAULT_LOCAL_FILE_POLICY = {
    maxFileBytes: 16 * 1024 * 1024,
};

const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_CONTENT_PATTERNS = [
    { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
    { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
    { label: "secret-assignment", re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{12,}/i },
];

function fail(error, path, extra = {}) {
    return { ok: false, error, path, message: `${error}: ${path}`, ...extra };
}

function boundedPath(value, label) {
    if (typeof value !== "string" || value.length === 0) return fail(`missing-${label}`, "");
    if (/[\u0000-\u001f]/.test(value)) return fail(`invalid-${label}`, value);
    return { ok: true, path: resolve(value) };
}

function rejectSecretName(path, label) {
    const name = basename(path);
    if (SECRET_FILE_RE.test(name)) return fail(`${label}-secret-looking-file`, path);
    return { ok: true };
}

function rejectSecretContent(path, label) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        return fail(`${label}-content-scan-failed`, path, { detail: error.message });
    }
    for (const pattern of SECRET_CONTENT_PATTERNS) {
        if (pattern.re.test(text)) {
            return fail(`${label}-secret-content`, path, { pattern: pattern.label });
        }
    }
    return { ok: true };
}

function rejectSymlinkAncestors(path, label) {
    const resolved = resolve(path);
    const parent = dirname(resolved);
    const { root } = parse(parent);
    const rel = relative(root, parent);
    if (!rel) return { ok: true };
    let current = root;
    for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
        current = join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                return fail(`${label}-symlink-ancestor-rejected`, path, { ancestorPath: current });
            }
        } catch (error) {
            if (error?.code === "ENOENT") return { ok: true };
            return fail(`${label}-ancestor-stat-failed`, path, { ancestorPath: current, detail: error.message });
        }
    }
    return { ok: true };
}

function rejectRawSymlinkPrefixes(value, label) {
    const absoluteRaw = isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`;
    const { root } = parse(absoluteRaw);
    const parts = absoluteRaw.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let current = root || sep;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === ".") continue;
        if (part === "..") {
            current = join(current, part);
            continue;
        }
        current = join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                const suffix = index === parts.length - 1 ? "symlink-rejected" : "symlink-ancestor-rejected";
                return fail(`${label}-${suffix}`, value, { symlinkPath: current, ancestorPath: current });
            }
        } catch (error) {
            if (error?.code === "ENOENT") return { ok: true };
            return fail(`${label}-raw-prefix-stat-failed`, value, { prefixPath: current, detail: error.message });
        }
    }
    return { ok: true };
}

export function validateLocalInputPath(value, options = {}) {
    const label = options.label || "local-input-path";
    const parsed = boundedPath(value, label);
    if (!parsed.ok) return parsed;
    const secret = options.rejectSecretName === false ? { ok: true } : rejectSecretName(parsed.path, label);
    if (!secret.ok) return secret;
    const rawPrefixes = rejectRawSymlinkPrefixes(value, label);
    if (!rawPrefixes.ok) return rawPrefixes;
    const ancestors = rejectSymlinkAncestors(parsed.path, label);
    if (!ancestors.ok) return ancestors;
    let stat;
    try {
        stat = lstatSync(parsed.path);
    } catch (error) {
        if (error?.code === "ENOENT") return fail(`${label}-does-not-exist`, parsed.path);
        return fail(`${label}-stat-failed`, parsed.path, { detail: error.message });
    }
    if (stat.isSymbolicLink()) return fail(`${label}-symlink-rejected`, parsed.path);
    if (!stat.isFile()) return fail(`${label}-not-a-file`, parsed.path);
    const maxFileBytes = Number(options.maxFileBytes ?? DEFAULT_LOCAL_FILE_POLICY.maxFileBytes);
    if (Number.isFinite(maxFileBytes) && stat.size > maxFileBytes) {
        return fail(`${label}-file-too-large`, parsed.path, { size: stat.size, maxFileBytes });
    }
    if (options.rejectSecretContent !== false) {
        const content = rejectSecretContent(parsed.path, label);
        if (!content.ok) return content;
    }
    return { ok: true, path: parsed.path, size: stat.size };
}

export function validateLocalOutputPath(value, options = {}) {
    const label = options.label || "local-output-path";
    const parsed = boundedPath(value, label);
    if (!parsed.ok) return parsed;
    const secret = options.rejectSecretName === false ? { ok: true } : rejectSecretName(parsed.path, label);
    if (!secret.ok) return secret;
    const rawPrefixes = rejectRawSymlinkPrefixes(value, label);
    if (!rawPrefixes.ok) return rawPrefixes;
    const ancestors = rejectSymlinkAncestors(parsed.path, label);
    if (!ancestors.ok) return ancestors;
    try {
        const stat = lstatSync(parsed.path);
        if (stat.isSymbolicLink()) return fail(`${label}-symlink-rejected`, parsed.path);
        if (!stat.isFile()) return fail(`${label}-not-a-file`, parsed.path);
    } catch (error) {
        if (error?.code !== "ENOENT") return fail(`${label}-stat-failed`, parsed.path, { detail: error.message });
    }
    return { ok: true, path: parsed.path };
}

export function validateLocalReferencePath(value, options = {}) {
    if (value === undefined || value === null || value === "") return { ok: true, path: null };
    const label = options.label || "local-reference-path";
    const parsed = boundedPath(value, label);
    if (!parsed.ok) return parsed;
    const rawPrefixes = rejectRawSymlinkPrefixes(value, label);
    if (!rawPrefixes.ok) return rawPrefixes;
    const ancestors = rejectSymlinkAncestors(parsed.path, label);
    if (!ancestors.ok) return ancestors;
    try {
        const stat = lstatSync(parsed.path);
        if (stat.isSymbolicLink()) return fail(`${label}-symlink-rejected`, parsed.path);
        if (!stat.isFile()) return fail(`${label}-not-a-file`, parsed.path);
    } catch (error) {
        if (error?.code !== "ENOENT") return fail(`${label}-stat-failed`, parsed.path, { detail: error.message });
    }
    return { ok: true, path: parsed.path };
}

function pathSegments(value, platform) {
    const normalized = platform === "windows" ? String(value).replace(/\//g, "\\") : String(value);
    return normalized.split(platform === "windows" ? /\\+/ : /\/+/).filter(Boolean);
}

function hasTraversal(value, platform) {
    return pathSegments(value, platform).some((segment) => segment === "..");
}

function isGuestAbsolute(value, platform) {
    if (platform === "windows") {
        return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
    }
    return posix.isAbsolute(value);
}

function normalizeGuestPath(value, platform) {
    if (platform === "windows") return win32.normalize(String(value).replace(/\//g, "\\"));
    return posix.normalize(String(value));
}

function rejectScpUnsafe(path, label) {
    if (/[\s'"`$;&|<>(){}[\]*?!]/.test(path) || path.includes(":")) {
        return fail(`${label}-scp-unsafe-path`, path);
    }
    return { ok: true };
}

export function validateGuestPath(value, options = {}) {
    const label = options.label || "guest-path";
    const platform = options.platform === "windows" ? "windows" : "posix";
    if (typeof value !== "string" || value.length === 0) return fail(`missing-${label}`, "");
    if (value.length > Number(options.maxLength ?? 4096)) return fail(`${label}-too-long`, value);
    if (/[\u0000-\u001f]/.test(value)) return fail(`invalid-${label}`, value);
    if (platform === "windows" && /^\\\\[?.][\\/]/.test(value)) {
        return fail(`${label}-device-namespace-rejected`, value);
    }
    if (platform === "posix" && value.includes("\\")) return fail(`${label}-invalid-separator`, value);
    if (options.requireAbsolute !== false && !isGuestAbsolute(value, platform)) {
        return fail(`${label}-not-absolute`, value);
    }
    if (hasTraversal(value, platform)) return fail(`${label}-traversal-rejected`, value);
    const normalized = normalizeGuestPath(value, platform);
    if (options.transport === "scp") {
        const scp = rejectScpUnsafe(normalized, label);
        if (!scp.ok) return scp;
    }
    return { ok: true, path: normalized };
}
