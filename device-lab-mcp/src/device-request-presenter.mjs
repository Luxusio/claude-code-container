/** Native SDK result types stay at this presentation boundary.
 * @typedef {{type:string,text?:string,data?:string,mimeType?:string,[key:string]:unknown}} NativeDeviceContent
 * @typedef {{content:NativeDeviceContent[],isError?:boolean,[key:string]:unknown}} NativeDeviceResult
 */
/** @param {unknown} value @returns {value is NativeDeviceResult} */
function nativeResult(value) {
    return value !== null && typeof value === 'object' && 'content' in value && Boolean(value.content);
}
/** Only presentation selection; no provider call, authority or retry.
 * @param {import('./ports/device-request.mjs').BrokerResult} receipt
 * @param {unknown} selectedFallbackValue
 * @param {(value:unknown)=>NativeDeviceResult} renderJson @returns {NativeDeviceResult} */
export function presentBrokerTool(receipt, selectedFallbackValue, renderJson) {
    const result = receipt.result?.mcpResult;
    return receipt.ok && nativeResult(result) ? result : renderJson(selectedFallbackValue);
}
/** @param {{data:string,mimeType:'image/png'}} image @returns {NativeDeviceResult} */
export function imageResult(image) {
    return {content:[{type:'image',data:image.data,mimeType:image.mimeType}]};
}

/** Active-app wait envelopes are native presentation, not matching policy.
 * @param {import('./ports/device-request.mjs').ActiveAppWaitOutcome} outcome
 * @param {(value:unknown)=>NativeDeviceResult} renderJson
 * @param {(ok:boolean,text:string)=>NativeDeviceResult} renderText
 * @returns {NativeDeviceResult} */
export function presentActiveAppWait(outcome, renderJson, renderText) {
    if (outcome.kind === 'deadline-before' || outcome.kind === 'deadline-during') {
        return renderText(false, outcome.kind === 'deadline-before'
            ? 'Appium wait deadline exhausted before observation'
            : 'Appium wait deadline exhausted during observation');
    }
    if (outcome.kind === 'failed-observation') {
        const broker = /** @type {import('./ports/device-request.mjs').BrokerResult} */ (outcome.receipt);
        return renderJson({...broker,routedBy:'mobile-broker-appium'});
    }
    const receipt = /** @type {{broker:import('./ports/device-request.mjs').BrokerResult,appState:unknown}} */ (outcome.receipt);
    if (outcome.kind === 'unmatched') {
        return renderJson({found:false,appState:receipt.appState,timeoutMs:outcome.timeoutMs,provider:'broker-appium',backend:outcome.backend});
    }
    return renderJson({found:true,
        ...(outcome.backend.startsWith('ios') ? {bundleId:outcome.expectedAppId,activeApp:receipt.appState}
            : {packageName:outcome.expectedAppId,appState:receipt.appState}),
        provider:'broker-appium',backend:outcome.backend,broker:receipt.broker});
}
