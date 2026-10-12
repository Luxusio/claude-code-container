/** Native SDK result types stay at this presentation boundary.
 * @typedef {{type:string,text?:string,data?:string,mimeType?:string,[key:string]:unknown}} NativeDeviceContent
 * @typedef {{content:NativeDeviceContent[],isError?:boolean,[key:string]:unknown}} NativeDeviceResult
 */
/** @param {unknown} value @returns {value is NativeDeviceResult} */
function nativeResult(value) {
    return value !== null && typeof value === 'object' && 'content' in value && Boolean(value.content);
}
/** @param {unknown} receipt @param {Record<string,unknown>} extra
 * @param {(value:unknown)=>NativeDeviceResult} renderJson @returns {NativeDeviceResult} */
export function presentBrokerReceipt(receipt, extra, renderJson) {
    const broker = /** @type {import('./ports/device-request.mjs').BrokerResult} */ (receipt);
    return renderJson({...extra,...broker,...(extra.routedBy === undefined ? {} : {routedBy:extra.routedBy})});
}
/** Only presentation selection; no provider call, authority or retry.
 * @param {unknown} receipt
 * @param {import('./ports/device-request.mjs').BrokerToolPresentation} options
 * @param {(value:unknown)=>NativeDeviceResult} renderJson @returns {NativeDeviceResult} */
export function presentBrokerTool(receipt, options, renderJson) {
    const broker = /** @type {import('./ports/device-request.mjs').BrokerResult} */ (receipt);
    const result = broker.result?.mcpResult;
    if (broker.ok && nativeResult(result)) return result;
    const fallback = options.payload && broker.ok && broker.result && typeof broker.result === 'object'
        ? broker.result : broker;
    return renderJson({...fallback,...(options.routedBy === undefined ? {} : {routedBy:options.routedBy})});
}
/** @param {unknown} receipt
 * @param {import('./ports/device-request.mjs').BrokerLifecyclePresentation} options
 * @param {(value:unknown)=>NativeDeviceResult} renderJson @returns {NativeDeviceResult} */
export function presentBrokerLifecycle(receipt, options, renderJson) {
    const broker = /** @type {import('./ports/device-request.mjs').BrokerResult} */ (receipt);
    if (options.implicit && broker.ok && broker.result && typeof broker.result === 'object' && !Array.isArray(broker.result)) {
        return renderJson({...broker.result,routedBy:options.routedBy,
            ...(options.deleted === undefined ? {} : {deleted:options.deleted}),
            ...(options.avdDeleted === true ? {avdDeleted:true} : {}),
            ...(options.simulatorDeleted === true ? {simulatorDeleted:true} : {}),
        });
    }
    const body = broker.body && typeof broker.body === 'object' && !Array.isArray(broker.body) ? broker.body : null;
    return renderJson({...broker,
        ...(typeof body?.detail === 'string' && body.detail ? {detail:body.detail} : {}),
        ...(typeof body?.remedy === 'string' && body.remedy ? {remedy:body.remedy} : {}),
        routedBy:options.routedBy});
}
/** @param {import('./domain/device-request.mjs').BackendCatalogValue} value
 * @param {(value:unknown)=>NativeDeviceResult} renderJson @returns {NativeDeviceResult} */
export function presentBackendCatalog(value, renderJson) {
    const {hostBackends,...catalog} = value;
    return renderJson({...catalog,...(hostBackends ? {hostBackends:{
        .../** @type {Record<string,unknown>} */ (hostBackends.receipt),backends:hostBackends.backends,
    }} : {})});
}
/** @param {string} name @param {string} backend
 * @param {Extract<import('./ports/device-request.mjs').MobileObservation,{kind:'completed'}>} observation
 * @param {Record<string,unknown>} extra
 * @param {(value:unknown)=>NativeDeviceResult} renderJson
 * @param {(ok:boolean,text:string)=>NativeDeviceResult} renderText @returns {NativeDeviceResult} */
export function presentMobileObservation(name, backend, observation, extra, renderJson, renderText) {
    if (name === 'mobile_screenshot') return observation.screenshotData
        ? imageResult({data:observation.screenshotData,mimeType:'image/png'})
        : renderText(false,'Appium did not return screenshot data');
    return renderJson({provider:'broker-appium',backend,broker:observation.receipt,...extra,
        ...(name === 'mobile_dump_ui' ? {source:observation.source} : {}),
        ...(name === 'mobile_get_clipboard' ? {text:observation.clipboardText} : {}),
    });
}
/** @param {import('./ports/device-request.mjs').SourceWaitOutcome} outcome
 * @param {(value:unknown)=>NativeDeviceResult} renderJson
 * @param {(ok:boolean,text:string)=>NativeDeviceResult} renderText @returns {NativeDeviceResult} */
export function presentSourceWait(outcome, renderJson, renderText) {
    if (outcome.kind === 'deadline-before' || outcome.kind === 'deadline-during') return renderText(false,
        outcome.kind === 'deadline-before' ? 'Appium wait deadline exhausted before observation' : 'Appium wait deadline exhausted during observation');
    return renderJson({found:outcome.kind === 'matched',text:outcome.text,source:outcome.source,
        ...(outcome.kind === 'unmatched' ? {timeoutMs:outcome.timeoutMs} : {}),
        provider:'broker-appium',backend:outcome.backend,
        ...(outcome.kind === 'matched' ? {broker:outcome.receipt} : {}),
    });
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
