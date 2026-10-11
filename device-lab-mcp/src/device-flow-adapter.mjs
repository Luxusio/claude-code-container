import { runDeviceFlow } from '@ccc/device-lab/providers/application/device-flow.mjs';
/** @param {import('./ports/device-request.mjs').DeviceResult} result
 * @returns {import('@ccc/device-lab/providers/domain/device-flow.mjs').FlowObservation<import('./ports/device-request.mjs').DeviceResult>} */
export function decodeFlowResult(result) {
    /** @type {import('@ccc/device-lab/providers/domain/device-flow.mjs').FlowFacts[]} */
    const values = [];
    for (const item of result.content || []) {
        if (item.type !== 'text') continue;
        try {
            /** @type {unknown} */ const value = JSON.parse(item.text || '');
            if (value && typeof value === 'object') {
                values.push({
                    ...('ok' in value && typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
                    ...('matched' in value && typeof value.matched === 'boolean' ? { matched: value.matched } : {}),
                    ...('found' in value && typeof value.found === 'boolean' ? { found: value.found } : {}),
                    ...('running' in value && typeof value.running === 'boolean' ? { running: value.running } : {}),
                });
            }
        } catch { /* Plain native text has no structured observation facts. */ }
    }
    return { transportFailed: Boolean(result.isError), values, payload: result };
}
/** Native output codec: semantic classification stays in the shared application.
 * @param {import('./ports/device-request.mjs').DeviceArguments} args
 * @param {import('./ports/device-request.mjs').DeviceRequestOptions} options
 * @param {import('./ports/device-request.mjs').DeviceFlowPorts} ports
 * @returns {Promise<import('./ports/device-request.mjs').DeviceResult>} */
export async function runMcpDeviceFlow(args, options, ports) {
    const { toolName = 'device_run_flow', toolAllowed = () => false, detail } = options;
    const outcome = await runDeviceFlow(args, { toolName, toolAllowed }, {
        toolInputError: ports.toolInputError,
        flowOperationAllowed: ports.flowOperationAllowed,
        toolOperation: ports.toolOperation,
        flowStepArguments: (tool, flow, step) => ports.flowStepArguments(tool, flow, step || {}),
        normalizePublicToolArgs: ports.normalizePublicToolArgs,
        withBrokerOperation: ports.withBrokerOperation,
        dispatchTool: async (operation, arguments_) => decodeFlowResult(await ports.dispatchTool(operation, arguments_, { detail })),
        destructiveDenial: (operation, arguments_) => decodeFlowResult(ports.policyDeniedResult(ports.evaluateDestructivePolicy(operation, arguments_))),
        dispatchFailure: error => decodeFlowResult(ports.unexpectedError(`Unexpected error: ${error && typeof error === 'object' && 'message' in error ? error.message : undefined}`)),
    });
    if (outcome.kind === 'invalid') return ports.textFailure(outcome.message);
    /** @type {import('./ports/device-request.mjs').DeviceContent[]} */
    const attachments = [];
    const results = outcome.results.map(step => {
        /** @type {{index:number,label:string,tool?:string,isError:boolean,error?:string,contentIndex?:number,contentCount?:number,content?:unknown[]}} */
        const summary = { index: step.index, label: step.label, ...(step.tool ? { tool: step.tool } : {}), isError: step.failed, ...(step.error ? { error: step.error } : {}) };
        if (step.payload) {
            const presented = ports.actionResult(step.tool || '', step.operation || '', step.payload, { detail });
            const contentIndex = attachments.length + 1;
            /** @type {Array<{type:'json',value:unknown}|{type:'text',text:string}>} */
            const content = [];
            for (const item of presented.content || []) {
                if (item.type !== 'text') attachments.push(item);
                else {
                    const text = item.text || '';
                    try { content.push({ type: 'json', value: JSON.parse(text) }); }
                    catch { content.push({ type: 'text', text }); }
                }
            }
            if (attachments.length + 1 > contentIndex) Object.assign(summary, { contentIndex, contentCount: attachments.length + 1 - contentIndex });
            if (content.length) summary.content = content;
        }
        return summary;
    });
    const value = { ...(!outcome.ok ? { error: 'flow-step-failed' } : {}), ok: outcome.ok, ...(outcome.stoppedAt !== undefined ? { stoppedAt: outcome.stoppedAt } : {}), results };
    const response = ports.renderFlow(value, { toolName, detail: Boolean(detail) });
    return { ...response, content: [...response.content, ...attachments] };
}
