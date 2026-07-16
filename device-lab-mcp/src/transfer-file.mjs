import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { validateLocalInputPath, validateLocalOutputPath } from "./policy/files.mjs";
import { copyFileAtomically } from "./state/shared-mutation-lock.mjs";

const DEVICE_UPLOAD_LIMIT_BYTES = 16 * 1024 * 1024;
const DEVICE_DOWNLOAD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

function transferFailure(error, fallback) {
    const detail = error?.code || error?.message || fallback;
    return { ok: false, error: detail, message: detail };
}

function cleanupTempRoot(root) {
    try {
        rmSync(root, { recursive: true, force: true });
    } catch {
        // The transfer result must not be replaced by best-effort temp cleanup.
    }
}

export function stageLocalInputFile(value, options = {}) {
    const label = options.label || "upload-local-path";
    const limitBytes = options.limitBytes ?? DEVICE_UPLOAD_LIMIT_BYTES;
    const policy = validateLocalInputPath(value, {
        label,
        maxFileBytes: limitBytes,
        rejectSecretContent: false,
    });
    if (!policy.ok) return policy;

    let root;
    try {
        root = mkdtempSync(join(tmpdir(), "ccc-device-upload-"));
    } catch (error) {
        return transferFailure(error, `${label}-stage-create-failed`);
    }
    const stagedPath = join(root, "payload");
    try {
        copyFileAtomically(policy.path, stagedPath, { prefix: label, limitBytes });
        const stagedPolicy = validateLocalInputPath(stagedPath, {
            label,
            maxFileBytes: limitBytes,
            rejectSecretName: false,
        });
        if (!stagedPolicy.ok) {
            cleanupTempRoot(root);
            return { ...stagedPolicy, path: policy.path, message: `${stagedPolicy.error}: ${policy.path}` };
        }
        return {
            ok: true,
            path: policy.path,
            stagedPath,
            cleanup: () => cleanupTempRoot(root),
        };
    } catch (error) {
        cleanupTempRoot(root);
        return transferFailure(error, `${label}-stage-failed`);
    }
}

export function copyStagedInputFile(stage, destination, options = {}) {
    const label = options.label || "upload-local-path";
    const limitBytes = options.limitBytes ?? DEVICE_UPLOAD_LIMIT_BYTES;
    try {
        const bytes = copyFileAtomically(stage.stagedPath, destination, { prefix: label, limitBytes });
        return { ok: true, path: destination, bytes };
    } catch (error) {
        return transferFailure(error, `${label}-copy-failed`);
    }
}

export function createLocalOutputStage(value, options = {}) {
    const label = options.label || "download-local-path";
    const policy = validateLocalOutputPath(value, { label });
    if (!policy.ok) return policy;
    const stageParent = resolve(options.stageParent || tmpdir());
    const stagePrefix = options.stagePrefix || "ccc-device-download-";
    let root;
    try {
        mkdirSync(stageParent, { recursive: true, mode: 0o700 });
        root = mkdtempSync(join(stageParent, stagePrefix));
    } catch (error) {
        return transferFailure(error, `${label}-stage-create-failed`);
    }
    return {
        ok: true,
        path: policy.path,
        stageRoot: root,
        stagedPath: join(root, "payload"),
        cleanup: () => cleanupTempRoot(root),
    };
}

export function restoreLocalOutputStage(value, stagedPath, options = {}) {
    const label = options.label || "download-local-path";
    const policy = validateLocalOutputPath(value, { label });
    if (!policy.ok) return policy;
    if (typeof stagedPath !== "string" || stagedPath.length === 0) {
        return transferFailure(null, `${label}-stage-path-missing`);
    }
    const stageParent = resolve(options.stageParent || tmpdir());
    const stagePrefix = options.stagePrefix || "ccc-device-download-";
    const resolvedStagePath = resolve(stagedPath);
    const root = dirname(resolvedStagePath);
    if (dirname(root) !== stageParent || !basename(root).startsWith(stagePrefix) || basename(resolvedStagePath) !== "payload") {
        return transferFailure(null, `${label}-stage-path-invalid`);
    }
    return {
        ok: true,
        path: policy.path,
        stageRoot: root,
        stagedPath: resolvedStagePath,
        cleanup: () => cleanupTempRoot(root),
    };
}

export function discardLocalOutputStage(stagedPath, options = {}) {
    const label = options.label || "download-local-path";
    if (typeof stagedPath !== "string" || stagedPath.length === 0) {
        return transferFailure(null, `${label}-stage-path-missing`);
    }
    const stageParent = resolve(options.stageParent || tmpdir());
    const stagePrefix = options.stagePrefix || "ccc-device-download-";
    const resolvedStagePath = resolve(stagedPath);
    const root = dirname(resolvedStagePath);
    if (dirname(root) !== stageParent || !basename(root).startsWith(stagePrefix) || basename(resolvedStagePath) !== "payload") {
        return transferFailure(null, `${label}-stage-path-invalid`);
    }
    cleanupTempRoot(root);
    return { ok: true };
}

export function commitLocalOutputStage(stage, options = {}) {
    const label = options.label || "download-local-path";
    const limitBytes = options.limitBytes ?? DEVICE_DOWNLOAD_LIMIT_BYTES;
    const policy = validateLocalOutputPath(stage.path, { label });
    if (!policy.ok) return policy;
    const stagedPolicy = validateLocalInputPath(stage.stagedPath, {
        label: `${label}-stage`,
        maxFileBytes: limitBytes,
        rejectSecretName: false,
        rejectSecretContent: false,
    });
    if (!stagedPolicy.ok) return stagedPolicy;
    const minBytes = options.minBytes ?? 0;
    if (!Number.isSafeInteger(minBytes) || minBytes < 0) {
        return transferFailure(null, `${label}-invalid-min-bytes`);
    }
    if (stagedPolicy.size < minBytes) {
        return transferFailure(null, `${label}-stage-file-too-small`);
    }
    try {
        const bytes = copyFileAtomically(stage.stagedPath, policy.path, { prefix: label, limitBytes });
        return { ok: true, path: policy.path, bytes };
    } catch (error) {
        return transferFailure(error, `${label}-commit-failed`);
    }
}

export function populateLocalOutputStage(source, stage, options = {}) {
    const label = options.label || "download-remote-path";
    const limitBytes = options.limitBytes ?? DEVICE_DOWNLOAD_LIMIT_BYTES;
    try {
        const bytes = copyFileAtomically(source, stage.stagedPath, { prefix: label, limitBytes });
        return { ok: true, path: stage.stagedPath, bytes };
    } catch (error) {
        return transferFailure(error, `${label}-stage-failed`);
    }
}
