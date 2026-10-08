import { FLOW_MAX_STEPS } from "../domain/device-flow.mjs";

/**
 * Read each turn immediately before its effects; property reads are part of the
 * existing contract, including repeated reads and failures outside dispatch.
 * @template Raw, Presented, Content, Policy
 * @template {{content: Content[]}} Reply
 * @param {import('../domain/device-flow.mjs').FlowArguments} args
 * @param {import('../ports/device-flow.mjs').DeviceFlowOptions} options
 * @param {import('../ports/device-flow.mjs').DeviceFlowPorts<Raw, Presented, Content, Reply, Policy>} ports
 * @returns {Promise<Reply>}
 */
export async function runDeviceFlow(args, { toolName, toolAllowed, detail }, ports) {
    /** @type {Content[]} */
    const nativeContent = [];
    /** @param {string | import('../domain/device-flow.mjs').FlowValue} value */
    const finish = (value) => {
        if (value && typeof value === "object" && value.ok === false) value = { error: "flow-step-failed", ...value };
        const response = typeof value === "string"
            ? ports.textFailure(value)
            : ports.renderFlow(value, { toolName, detail });
        response.content.push(...nativeContent);
        return response;
    };
    const { steps, stopOnError = true } = args;
    if (!Array.isArray(steps)) return finish(`${toolName} requires steps array`);
    if (steps.length === 0) return finish(`${toolName} requires at least one step`);
    if (steps.length > FLOW_MAX_STEPS) return finish(`${toolName} supports at most ${FLOW_MAX_STEPS} steps`);

    /** @type {import('../domain/device-flow.mjs').FlowStepSummary[]} */
    const results = [];
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] || {};
        const tool = typeof step.tool === "string" ? step.tool : "";
        const label = (typeof step.label === "string" && step.label) || tool || `step-${index + 1}`;
        if (!tool || Object.hasOwn(step, "name")) {
            const summary = { index, label, isError: true, error: "Flow step requires tool; name is not supported" };
            results.push(summary);
            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });
            continue;
        }
        if (!toolAllowed(tool)) {
            const summary = { index, label, tool, isError: true, error: `${toolName} does not allow step tool: ${tool}` };
            results.push(summary);
            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });
            continue;
        }

        if (step.arguments !== undefined && (!step.arguments || typeof step.arguments !== "object" || Array.isArray(step.arguments))) {
            results.push({ index, label, tool, isError: true, error: "Flow step arguments must be an object" });
            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });
            continue;
        }
        const inputError = ports.toolInputError(tool, step.arguments) || (!ports.flowOperationAllowed(tool, step.arguments) ? `${toolName} does not allow step action: ${tool}` : null);
        if (inputError) {
            if (inputError === `${tool} requires confirmDestructive:true`) {
                const operation = ports.toolOperation(tool, step.arguments);
                const denied = ports.policyDeniedResult(ports.evaluateDestructivePolicy(operation, step.arguments));
                results.push({ index, label, tool, ...ports.summarizeToolResult(operation, ports.actionResult(tool, operation, denied, { detail }), nativeContent) });
            } else results.push({ index, label, tool, isError: true, error: inputError });
            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });
            continue;
        }
        // A preceding step may have changed the broker or device state.
        let result;
        try {
            result = await ports.withBrokerOperation(() => ports.dispatchTool(ports.toolOperation(tool, step.arguments), ports.normalizePublicToolArgs(tool, ports.flowStepArguments(tool, args, step.arguments)), { detail }));
        } catch (err) {
            result = ports.unexpectedError(`Unexpected error: ${/** @type {Error} */ (err).message}`);
        }
        const operation = ports.toolOperation(tool, step.arguments);
        const classified = ports.summarizeToolResult(operation, result, []);
        const presented = ports.actionResult(tool, operation, result, { detail });
        const summary = { index, label, tool, ...ports.summarizeToolResult(operation, presented, nativeContent),
            ...(classified.isError ? { isError: true } : {}) };
        results.push(summary);
        if (summary.isError && stopOnError) return finish({ ok: false, stoppedAt: index, results });
    }

    return finish({ ok: results.every((result) => !result.isError), results });
}
