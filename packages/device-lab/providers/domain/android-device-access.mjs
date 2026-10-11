/** @typedef {{status:number|null,stdout?:string,stderr?:string,error?:{message?:string},signal?:string|null}} AndroidAccessReceipt */
/** @typedef {{status:number|null,byteLength:number,prefix:readonly number[],base64:string,stdoutText:string,stderrText:string}} AndroidScreenshotFacts */
/** @typedef {{kind:'json',payload:object}|{kind:'text',message:string}|{kind:'command-failure',command:AndroidAccessReceipt}|{kind:'image',data:string}} AndroidAccessOutcome */

/** @param {AndroidAccessReceipt} result */
export function androidWaitCommandFailed(result) { return result.status !== 0 || Boolean(result.error || result.signal); }
/** @param {AndroidAccessReceipt} result */
export function androidWaitFailure(result) {
    const cause = result.error?.message || (result.signal ? `signal ${result.signal}` : "");
    return { error: cause ? { ...result, stderr: `${cause}${result.stderr ? `: ${result.stderr}` : ""}` } : result };
}
/** @param {AndroidScreenshotFacts} facts
 * @returns {AndroidAccessOutcome} */
export function androidScreenshotOutcome(facts) {
    const png = facts.byteLength >= 8 && [137,80,78,71,13,10,26,10].every((byte,index) => facts.prefix[index] === byte);
    if (png || facts.status === 0) return { kind: "image", data: facts.base64 };
    return { kind: "text", message: `Error: ${facts.stderrText || facts.stdoutText || `exit ${facts.status}`}` };
}
