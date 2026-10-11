/** @param {import('../ports/android-device-access.mjs').AndroidAccessReceipt} result */
export function androidWaitCommandFailed(result) { return result.status !== 0 || Boolean(result.error || result.signal); }
/** @param {import('../ports/android-device-access.mjs').AndroidAccessReceipt} result */
export function androidWaitFailure(result) {
    const cause = result.error?.message || (result.signal ? `signal ${result.signal}` : "");
    return { error: cause ? { ...result, stderr: `${cause}${result.stderr ? `: ${result.stderr}` : ""}` } : result };
}
/** @param {import('../ports/android-device-access.mjs').AndroidScreenshotFacts} facts
 * @returns {import('../ports/android-device-access.mjs').AndroidAccessOutcome} */
export function androidScreenshotOutcome(facts) {
    const png = facts.byteLength >= 8 && [137,80,78,71,13,10,26,10].every((byte,index) => facts.prefix[index] === byte);
    if (png || facts.status === 0) return { kind: "image", data: facts.base64 };
    return { kind: "text", message: `Error: ${facts.stderrText || facts.stdoutText || `exit ${facts.status}`}` };
}
