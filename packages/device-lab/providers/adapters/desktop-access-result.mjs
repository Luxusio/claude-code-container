/** @typedef {{content:Array<{type:string,text?:string,data?:unknown,mimeType?:string}>,isError?:boolean}} DesktopAccessNativeResult */

/** Keep exception diagnostics bounded by the existing response renderer, without
 * serializing stacks or arbitrary exception properties.
 * @param {unknown} evidence @returns {object} */
function cleanupDiagnostic(evidence) {
    if (evidence === null || typeof evidence !== 'object') return {message:String(evidence)};
    if ('status' in evidence && 'stdout' in evidence && 'stderr' in evidence) {
        const receipt = /** @type {import('../ports/desktop-control-transfer.mjs').CommandReceipt} */ (evidence);
        return {status:receipt.status,stdout:receipt.stdout,stderr:receipt.stderr,
            ...('signal' in evidence ? {signal:evidence.signal} : {}),
            ...('error' in evidence && evidence.error ? {error:cleanupDiagnostic(evidence.error)} : {})};
    }
    return {
        ...('name' in evidence && typeof evidence.name === 'string' ? {name:evidence.name} : {}),
        message:'message' in evidence && typeof evidence.message === 'string' ? evidence.message : String(evidence),
        ...('code' in evidence && (typeof evidence.code === 'string' || typeof evidence.code === 'number') ? {code:evidence.code} : {}),
    };
}

/** @param {{jsonResult:(value:object)=>DesktopAccessNativeResult,textResult:(ok:boolean,text:string)=>DesktopAccessNativeResult,fail:(receipt:import('../ports/desktop-control-transfer.mjs').CommandReceipt)=>DesktopAccessNativeResult}} renderers */
export function createDesktopAccessResult(renderers) {
    /** @param {import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined} outcome
     * @returns {DesktopAccessNativeResult|undefined} */
    function render(outcome) {
        if (!outcome) return undefined;
        if (outcome.kind === 'json') return renderers.jsonResult(outcome.value);
        if (outcome.kind === 'text') return renderers.textResult(false,outcome.text);
        if (outcome.kind === 'command-failure') return renderers.fail(outcome.receipt);
        if (outcome.kind === 'native') return /** @type {DesktopAccessNativeResult} */ (outcome.value);
        if (outcome.kind === 'image') return {content:[{type:'image',data:outcome.data,mimeType:'image/png'}]};
        const primary = outcome.primary;
        const cause = primary.kind === 'thrown' ? {kind:'thrown',error:cleanupDiagnostic(primary.error)}
            : primary.kind === 'image' ? {kind:'image',completed:true}
                : {kind:primary.kind,result:render(primary)};
        const diagnostic = renderers.jsonResult({ok:false,error:'desktop-screenshot-cleanup-failed',cause,
            cleanup:outcome.cleanup.map(item => ({operation:item.operation,evidence:cleanupDiagnostic(item.evidence)})),
            ...(primary.kind === 'image' ? {result:{kind:'image',completed:true}} : {})});
        return { ...diagnostic,isError:true,content:[...diagnostic.content,
            ...(primary.kind === 'image' ? [{type:'image',data:primary.data,mimeType:'image/png'}] : [])] };
    }
    return render;
}
