/** @typedef {{labId?:unknown,guestPath?:unknown,sourcePath?:unknown,destinationPath?:unknown,replace?:unknown,dryRun?:unknown,maxFiles?:unknown,maxFileBytes?:unknown,maxTotalBytes?:unknown}} QemuGuestTransferArgs */
const DEFAULT_FILE_POLICY = {
    maxFiles: 5000,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024
};
const DEFAULT_GUEST_ROOTS = ["/workspace", "/artifacts", "/tmp/ccc-lab"];
/** @param {QemuGuestTransferArgs} [args] */
export function normalizeGuestTransferPolicy(args = {}) {
    /** @param {unknown} value @param {number} fallback @param {number} maximum */
    const numberOrDefault = (value, fallback, maximum) => {
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
            return fallback;
        }
        return Math.min(value, maximum);
    };
    return {
        maxFiles: numberOrDefault(args.maxFiles, DEFAULT_FILE_POLICY.maxFiles, DEFAULT_FILE_POLICY.maxFiles),
        maxFileBytes: numberOrDefault(args.maxFileBytes, DEFAULT_FILE_POLICY.maxFileBytes, DEFAULT_FILE_POLICY.maxFileBytes),
        maxTotalBytes: numberOrDefault(args.maxTotalBytes, DEFAULT_FILE_POLICY.maxTotalBytes, DEFAULT_FILE_POLICY.maxTotalBytes)
    };
}
/** @param {unknown} input @returns {string[]} */
export function normalizeGuestTransferRoots(input) {
    const roots = Array.isArray(input) && input.length > 0
        ? input
        : DEFAULT_GUEST_ROOTS;
    return roots
        .filter(/** @returns {root is string} */ (root) => typeof root === "string" && root.startsWith("/") && !root.includes("\0"))
        .map((root) => root.replace(/\/+$/g, "") || "/");
}
/** @param {unknown} value @param {string} label @param {unknown} input @returns {{ok:true,guestPath:string,allowedGuestRoots:string[]}|{ok:false,error:string}} */
export function validateGuestTransferPath(value, label, input) {
    if (typeof value !== "string" || value.length === 0) {
        return {
            ok: false, error: `missing-${label}`
        };
    }
    if (/[\u0000-\u001f]/.test(value)) {
        return {
            ok: false, error: `invalid-${label}`
        };
    }
    if (!value.startsWith("/")) {
        return {
            ok: false, error: `${label}-must-be-absolute`
        };
    }
    const parts = value.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
        return {
            ok: false, error: `${label}-path-traversal-rejected`
        };
    }
    const normalized = `/${parts.join("/")}`;
    const allowedRoots = normalizeGuestTransferRoots(input);
    return {
        ok: true, guestPath: normalized, allowedGuestRoots: allowedRoots
    };
}
/** @param {unknown} result @returns {unknown} */
export function publicGuestTransferResult(result) {
    if (!result || typeof result !== "object") {
        return result;
    }
    const stripKeys = new Set(["args", "argv", "command", "env", "socketPath", "privateKey", "token"]);
    /** @param {unknown} value @returns {unknown} */
    const sanitize = (value) => {
        if (Array.isArray(value)) {
            return value.map((entry) => sanitize(entry));
        }
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
/** @param {unknown} result */
export function guestTransferSucceeded(result) {
    return Boolean(result && (typeof result === "object" || typeof result === "function") && "ok" in result && result.ok);
}
/** @param {unknown} value @returns {{ok:true,path:string}|{ok:false,error:string}} */
export function validateGuestTransferSource(value) {
    if (typeof value !== "string" || /[\u0000-\u001f]/.test(value) || value.includes("..")) {
        return {
            ok: false, error: "invalid-source-path"
        };
    }
    return {
        ok: true, path: value
    };
}
/** @param {string} timestamp */
export function guestPullDestinationName(timestamp) {
    return `guest-pull-${timestamp.replace(/[^0-9A-Za-z._-]+/g, "-")}`;
}
/** @param {import("./qemu-lifecycle.mjs").QemuLab} lab
 * @param {{type:string,completedAt:unknown,guestPath?:string,sourcePath?:string,destinationPath?:string,stagedPath?:string,files?:number,bytes?:number,error?:string}} operation */
export function withGuestTransferOperation(lab, operation) {
    const fileOperations = Array.isArray(lab.fileOperations) ? lab.fileOperations : [];
    return {
        ...lab, updatedAt: operation.completedAt, fileOperations: [...fileOperations, operation].slice(-50)
    };
}
