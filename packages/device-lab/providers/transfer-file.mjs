import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { validateLocalInputPath, validateLocalOutputPath } from "./policy/files.mjs";
import { copyFileAtomically } from "./state/shared-mutation-lock.mjs";

/**
 * @typedef {{label?:string,limitBytes?:number}} TransferOptions
 * @typedef {{label?:string,stageParent?:string,stagePrefix?:string}} OutputStageOptions
 * @typedef {TransferOptions & {minBytes?:number}} CommitOptions
 * @typedef {{ok:false,error:string,message:string}} TransferFailure
 * @typedef {import("./policy/files.mjs").FilePolicyFailure | TransferFailure} NativeTransferFailure
 * @typedef {{ok:true,path:string,stagedPath:string,cleanup:()=>void}} NativeTransferStage
 * @typedef {NativeTransferStage & {stageRoot:string}} NativeOutputStage
 * @typedef {NativeTransferStage | NativeTransferFailure} InputStageResult
 * @typedef {NativeOutputStage | NativeTransferFailure} OutputStageResult
 * @typedef {{ok:true,path:string,bytes:number} | NativeTransferFailure} TransferCopyResult
 */

const DEVICE_UPLOAD_LIMIT_BYTES = 16 * 1024 * 1024;
const DEVICE_DOWNLOAD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** @param {unknown} error @param {string} fallback @returns {TransferFailure} */
function transferFailure(error, fallback) {
    let detail = fallback;
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
        if ("code" in error && typeof error.code === "string" && error.code) detail = error.code;
        else if ("message" in error && typeof error.message === "string" && error.message) detail = error.message;
    }
    return { ok: false, error: detail, message: detail };
}

/** @param {string} root */
function cleanupTempRoot(root) {
    rmSync(root, { recursive: true, force: true });
}

/** @param {unknown} value @param {TransferOptions} [options] @returns {InputStageResult} */
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
    /** @type {NativeTransferFailure} */
    let failure;
    try {
        copyFileAtomically(policy.path, stagedPath, { prefix: label, limitBytes });
        const stagedPolicy = validateLocalInputPath(stagedPath, {
            label,
            maxFileBytes: limitBytes,
            rejectSecretName: false,
        });
        if (!stagedPolicy.ok) {
            failure = { ...stagedPolicy, path: policy.path, message: `${stagedPolicy.error}: ${policy.path}` };
        } else {
            return {
                ok: true,
                path: policy.path,
                stagedPath,
                cleanup: () => cleanupTempRoot(root),
            };
        }
    } catch (error) {
        failure = transferFailure(error, `${label}-stage-failed`);
    }
    try {
        cleanupTempRoot(root);
    } catch (error) {
        throw new AggregateError([failure, error], "Transfer staging and cleanup failed.", { cause: failure });
    }
    return failure;
}

/** @param {Pick<NativeTransferStage,"stagedPath">} stage @param {string} destination @param {TransferOptions} [options] @returns {TransferCopyResult} */
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

/** @param {unknown} value @param {OutputStageOptions} [options] @returns {OutputStageResult} */
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

/** @param {unknown} value @param {unknown} stagedPath @param {OutputStageOptions} [options] @returns {OutputStageResult} */
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

/** @param {unknown} stagedPath @param {OutputStageOptions} [options] @returns {{ok:true}|TransferFailure} */
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
    try {
        cleanupTempRoot(root);
    } catch {
        return transferFailure(null, `${label}-stage-cleanup-failed`);
    }
    return { ok: true };
}

/** @param {Pick<NativeTransferStage,"path"|"stagedPath">} stage @param {CommitOptions} [options] @returns {TransferCopyResult} */
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

/** @param {string} source @param {Pick<NativeTransferStage,"stagedPath">} stage @param {TransferOptions} [options] @returns {TransferCopyResult} */
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
