import { FLOW_MAX_STEPS, flowFailure, isFlowArguments } from '../domain/device-flow.mjs';
/** @template Payload
 * @param {import('../domain/device-flow.mjs').FlowArguments} args
 * @param {import('../ports/device-flow.mjs').DeviceFlowOptions} options
 * @param {import('../ports/device-flow.mjs').DeviceFlowPorts<Payload>} ports
 * @returns {Promise<import('../domain/device-flow.mjs').FlowOutcome<Payload>>} */
export async function runDeviceFlow(args, { toolName, toolAllowed }, ports) {
    const { steps, stopOnError = true } = args;
    if (!Array.isArray(steps)) return { kind: 'invalid', message: `${toolName} requires steps array` };
    if (!steps.length) return { kind: 'invalid', message: `${toolName} requires at least one step` };
    if (steps.length > FLOW_MAX_STEPS) return { kind: 'invalid', message: `${toolName} supports at most ${FLOW_MAX_STEPS} steps` };
    /** @type {import('../domain/device-flow.mjs').FlowStepOutcome<Payload>[]} */
    const results = [];
    for (let index = 0; index < steps.length; index++) {
        /** @type {unknown} */ const rawStep = steps[index];
        const step = isFlowArguments(rawStep) ? rawStep : {};
        const tool = 'tool' in step && typeof step.tool === 'string' ? step.tool : '';
        const label = 'label' in step && typeof step.label === 'string' && step.label || tool || `step-${index + 1}`;
        let error = !tool || Object.hasOwn(step, 'name') ? 'Flow step requires tool; name is not supported'
            : !toolAllowed(tool) ? `${toolName} does not allow step tool: ${tool}` : null;
        const rawArgs = 'arguments' in step ? step.arguments : undefined;
        /** @type {import('../domain/device-flow.mjs').FlowArguments|undefined} */
        let stepArgs;
        if (rawArgs !== undefined) {
            if (!isFlowArguments(rawArgs)) error ||= 'Flow step arguments must be an object';
            else stepArgs = rawArgs;
        }
        if (!error) error = ports.toolInputError(tool, stepArgs) || (!ports.flowOperationAllowed(tool, stepArgs) ? `${toolName} does not allow step action: ${tool}` : null);
        /** @type {import('../domain/device-flow.mjs').FlowStepOutcome<Payload>} */
        let summary;
        if (error) {
            if (error === `${tool} requires confirmDestructive:true`) {
                const operation = ports.toolOperation(tool, stepArgs);
                const observation = ports.destructiveDenial(operation, stepArgs);
                summary = { index, label, tool, operation, payload: observation.payload, ...flowFailure(operation, observation), failed: true };
            } else summary = { index, label, ...(tool && error !== 'Flow step requires tool; name is not supported' ? { tool } : {}), failed: true, error };
        } else {
            let observation;
            try { observation = await ports.withBrokerOperation(() => ports.dispatchTool(ports.toolOperation(tool, stepArgs), ports.normalizePublicToolArgs(tool, ports.flowStepArguments(tool, args, stepArgs)))); }
            catch (failure) { observation = ports.dispatchFailure(failure); }
            const operation = ports.toolOperation(tool, stepArgs);
            summary = { index, label, tool, operation, payload: observation.payload, ...flowFailure(operation, observation) };
        }
        results.push(summary);
        if (summary.failed && stopOnError) return { kind: 'complete', ok: false, stoppedAt: index, results };
    }
    return { kind: 'complete', ok: results.every(result => !result.failed), results };
}
