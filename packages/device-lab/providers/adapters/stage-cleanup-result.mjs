/** @typedef {{content:Array<{type:string,text?:string,data?:unknown,mimeType?:string}>,isError?:boolean}} CleanupNativeResult */
/** @typedef {{kind:'thrown',error:unknown}|{kind:'returned',outcome:string,result:unknown}} CleanupPrimary */
/** @typedef {{error:string,primary:CleanupPrimary,cleanupError:unknown,result?:object}} StageCleanupFailure */

/** @param {unknown} error @returns {string|undefined} */
function nodeErrno(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    try {
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        return typeof code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
    } catch { return undefined; }
}

/** @param {StageCleanupFailure} failure
 * @param {(value:object)=>CleanupNativeResult} jsonResult
 * @returns {CleanupNativeResult} */
export function renderStageCleanupFailure(failure, jsonResult) {
    const primary = failure.primary;
    const primaryCode = primary.kind === 'thrown' ? nodeErrno(primary.error) : undefined;
    const cleanupCode = nodeErrno(failure.cleanupError);
    const cause = primary.kind === 'thrown'
        ? { kind: 'thrown', ...(primaryCode ? { code: primaryCode } : {}) }
        : { kind: primary.outcome, result: primary.result };
    return {
        ...jsonResult({
            ok: false, error: failure.error, cause,
            cleanup: { operation: 'local', failed: true, ...(cleanupCode ? { code: cleanupCode } : {}) },
            ...(failure.result === undefined ? {} : { result: failure.result }),
        }),
        isError: true,
    };
}
