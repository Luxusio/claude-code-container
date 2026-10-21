/** @typedef {{content:Array<{type:string,text?:string,data?:unknown,mimeType?:string}>,isError?:boolean}} DesktopTransferNativeResult */

/** @param {unknown} error @returns {string|undefined} */
function nodeErrno(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    try {
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        return typeof code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
    } catch { return undefined; }
}

/** @param {import('../domain/desktop-control-transfer.mjs').DesktopCleanupFailure} outcome
 * @param {(primary:import('../domain/desktop-control-transfer.mjs').DesktopResult)=>DesktopTransferNativeResult} renderPrimary
 * @param {(value:object)=>DesktopTransferNativeResult} jsonResult
 * @returns {DesktopTransferNativeResult} */
export function renderDesktopTransferCleanup(outcome, renderPrimary, jsonResult) {
    const primary = outcome.cleanup.primary;
    const primaryCode = primary.kind === 'thrown' ? nodeErrno(primary.error) : undefined;
    const cleanupCode = nodeErrno(outcome.cleanup.error);
    const cause = primary.kind === 'thrown'
        ? { kind: 'thrown', ...(primaryCode ? { code: primaryCode } : {}) }
        : { kind: primary.kind, result: renderPrimary(primary) };
    return {
        ...jsonResult({
            ok: false,
            error: 'desktop-transfer-cleanup-failed',
            cause,
            cleanup: { operation: 'local', failed: true, ...(cleanupCode ? { code: cleanupCode } : {}) },
            ...(primary.kind === 'completed' ? { result: { kind: 'completed', completed: true } } : {}),
        }),
        isError: true,
    };
}
