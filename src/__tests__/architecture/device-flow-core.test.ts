import { describe, expect, it } from "vitest";
import { runDeviceFlow } from "../../../packages/device-lab/providers/application/device-flow.mjs";
import { sharedFlowTarget } from "../../../packages/device-lab/providers/domain/device-flow.mjs";
import type { DeviceFlowPorts } from "../../../packages/device-lab/providers/ports/device-flow.mjs";
import type { FlowArguments, FlowValue } from "../../../packages/device-lab/providers/domain/device-flow.mjs";

// Exact pre-edit source frozen at 10c8618383811ced1f24305c35f6098ab858d25d.
// The full native facade/transitive context has a separate paired witness.
const frozenLoop = "async function handleRunFlow(args, { toolName, toolAllowed, detail }) {\n    const nativeContent = [];\n    const finish = (value) => {\n        if (value && typeof value === \"object\" && value.ok === false) value = { error: \"flow-step-failed\", ...value };\n        const response = typeof value === \"string\"\n            ? textResult(false, value)\n            : flowJsonResult(detail ? value : compactToolValue(toolName, value), { detail });\n        response.content.push(...nativeContent);\n        return response;\n    };\n    const { steps, stopOnError = true } = args;\n    if (!Array.isArray(steps)) return finish(`${toolName} requires steps array`);\n    if (steps.length === 0) return finish(`${toolName} requires at least one step`);\n    if (steps.length > FLOW_MAX_STEPS) return finish(`${toolName} supports at most ${FLOW_MAX_STEPS} steps`);\n\n    const results = [];\n    for (let index = 0; index < steps.length; index += 1) {\n        const step = steps[index] || {};\n        const tool = typeof step.tool === \"string\" ? step.tool : \"\";\n        const label = (typeof step.label === \"string\" && step.label) || tool || `step-${index + 1}`;\n        if (!tool || Object.hasOwn(step, \"name\")) {\n            const summary = { index, label, isError: true, error: \"Flow step requires tool; name is not supported\" };\n            results.push(summary);\n            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });\n            continue;\n        }\n        if (!toolAllowed(tool)) {\n            const summary = { index, label, tool, isError: true, error: `${toolName} does not allow step tool: ${tool}` };\n            results.push(summary);\n            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });\n            continue;\n        }\n\n        if (step.arguments !== undefined && (!step.arguments || typeof step.arguments !== \"object\" || Array.isArray(step.arguments))) {\n            results.push({ index, label, tool, isError: true, error: \"Flow step arguments must be an object\" });\n            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });\n            continue;\n        }\n        const inputError = toolInputError(tool, step.arguments) || (!flowOperationAllowed(tool, step.arguments) ? `${toolName} does not allow step action: ${tool}` : null);\n        if (inputError) {\n            if (inputError === `${tool} requires confirmDestructive:true`) {\n                const operation = toolOperation(tool, step.arguments);\n                const denied = policyDeniedResult(evaluateDestructivePolicy(operation, step.arguments));\n                results.push({ index, label, tool, ...summarizeToolResult(operation, actionResult(tool, operation, denied, { detail }), nativeContent) });\n            } else results.push({ index, label, tool, isError: true, error: inputError });\n            if (stopOnError) return finish({ ok: false, stoppedAt: index, results });\n            continue;\n        }\n        // A preceding step may have changed the broker or device state.\n        let result;\n        try {\n            result = await withBrokerOperation(() => dispatchTool(toolOperation(tool, step.arguments), normalizePublicToolArgs(tool, flowStepArguments(tool, args, step.arguments)), { detail }));\n        } catch (err) {\n            result = textResult(false, `Unexpected error: ${err.message}`);\n        }\n        const operation = toolOperation(tool, step.arguments);\n        const classified = summarizeToolResult(operation, result, []);\n        const presented = actionResult(tool, operation, result, { detail });\n        const summary = { index, label, tool, ...summarizeToolResult(operation, presented, nativeContent),\n            ...(classified.isError ? { isError: true } : {}) };\n        results.push(summary);\n        if (summary.isError && stopOnError) return finish({ ok: false, stoppedAt: index, results });\n    }\n\n    return finish({ ok: results.every((result) => !result.isError), results });\n}\n";
type Content = { type: string; text?: string; token?: string };
type Result = { content: Content[]; isError?: boolean };
type Reply = Result & { value?: FlowValue | string };
type Ports = DeviceFlowPorts<Result, Result, Content, Reply, { ok: boolean }>;
const options = { toolName: "device_run_flow", toolAllowed: (tool: string) => tool !== "forbidden", detail: true };

function fixture() {
    const trace: unknown[] = [];
    let scope = 0;
    const text = (message: string): Reply => ({ content: [{ type: "text", text: message }], isError: true, value: message });
    const render = (value: FlowValue): Reply => ({ content: [{ type: "text", text: JSON.stringify(value) }], value });
    const ports: Ports = {
        toolInputError(tool, args) { trace.push(["validate", tool, args?.action]); return args?.invalid ?? (args?.deny ? `${tool} requires confirmDestructive:true` : null); },
        flowOperationAllowed(tool, args) { trace.push(["allow", tool, args?.action]); return !args?.disallowed; },
        toolOperation(tool, args) { trace.push(["operation", tool, args?.action]); return args?.action ?? tool; },
        flowStepArguments(tool, _flow, step) { trace.push(["stepArgs", tool, step?.action]); return step ?? {}; },
        normalizePublicToolArgs(tool, args) { trace.push(["normalize", tool, args.action]); return args; },
        async withBrokerOperation(callback) { trace.push(["scope", ++scope]); return callback(); },
        async dispatchTool(operation, args) {
            trace.push(["dispatch", operation, scope]);
            if (args.throwDispatch) throw new Error("dispatch-failed");
            args.afterDispatch?.();
            return { content: [{ type: "image", token: operation }, { type: "text", text: JSON.stringify({ ok: !args.rawFail }) }], isError: !!args.rawFail };
        },
        evaluateDestructivePolicy(operation) { trace.push(["admission", operation]); return { ok: false }; },
        policyDeniedResult() { return { content: [{ type: "text", text: "denied" }], isError: true }; },
        unexpectedError: text,
        summarizeToolResult(operation, result, native) {
            trace.push(["summary", operation, !!result.isError]);
            for (const item of result.content) if (item.type !== "text") native.push(item);
            return { isError: !!result.isError };
        },
        actionResult(tool, operation, result) {
            trace.push(["present", tool, operation]);
            return { ...result, isError: false };
        },
        textFailure: text,
        renderFlow: render,
    };
    return { trace, ports, text, render };
}
type Fixture = ReturnType<typeof fixture>;
function baseline(f: Fixture) {
    const bindings = { ...f.ports, FLOW_MAX_STEPS: 50, textResult: (_ok: boolean, message: string) => f.text(message),
        flowJsonResult: f.render, compactToolValue: (_tool: string, value: FlowValue) => value };
    return new Function(...Object.keys(bindings), frozenLoop + "; return handleRunFlow;")(...Object.values(bindings)) as
        (args: FlowArguments, opts: typeof options) => Promise<Reply>;
}
async function witness(make: (f: Fixture) => FlowArguments, change?: (f: Fixture) => void) {
    const observed: Array<{ result?: Reply; thrown?: string; trace: unknown[] }> = [];
    for (const current of [false, true]) {
        const f = fixture(); change?.(f);
        const args = make(f);
        try {
            const result = await (current ? runDeviceFlow(args, options, f.ports) : baseline(f)(args, options));
            observed.push({ result, trace: f.trace });
        } catch (error) {
            observed.push({ thrown: (error as Error).message, trace: f.trace });
        }
    }
    expect(observed[1]).toEqual(observed[0]);
    return observed[1];
}

describe("ordered device-flow application source equivalence", () => {
    it.each([0, 1, 50, 51])("preserves %s-step admission bounds", async length => {
        const result = await witness(() => ({ steps: Array.from({ length }, () => ({ tool: "click" })) }));
        const dispatches = result.trace.filter((entry: any) => entry[0] === "dispatch");
        expect(dispatches).toHaveLength(length > 0 && length <= 50 ? length : 0);
    });
    it.each([undefined, null, false, 0, "", true, 1, "yes"])("preserves stopOnError truthiness %j", async stopOnError => {
        await witness(() => ({ stopOnError, steps: [{ tool: "click", arguments: { invalid: "bad" } }, { tool: "click" }] }));
    });
    it("validates later turns after preceding effects and reevaluates mutable steps length", async () => {
        const result = await witness(f => {
            const steps: any[] = [{ tool: "click", arguments: { afterDispatch() { f.trace.push("effect"); steps.push({ tool: "click", arguments: { invalid: "later" } }); } } }];
            return { steps };
        });
        expect(result.trace.indexOf("effect")).toBeLessThan(result.trace.findIndex((entry: any) => entry[0] === "validate" && entry[2] === undefined && result.trace.indexOf(entry) > result.trace.indexOf("effect")));
    });
    it.each([null, false, 0, "", {}, { tool: "click", name: undefined }, { tool: "forbidden" },
        { tool: "click", arguments: null }, { tool: "click", arguments: [] },
        { tool: "click", arguments: false }, { tool: "click", arguments: { disallowed: true } }])("keeps malformed turn branches %j", async step => {
        await witness(() => ({ stopOnError: false, steps: [step, { tool: "click" }] }));
    });
    it("retains changing repeated tool, label, arguments and action getter reads", async () => {
        await witness(f => {
            let toolReads = 0, labelReads = 0, argumentReads = 0, actionReads = 0;
            const args = { get action() { f.trace.push(["actionRead", ++actionReads]); return "a" + actionReads; } };
            const step = {
                get tool() { f.trace.push(["toolRead", ++toolReads]); return toolReads === 1 ? "first" : "click"; },
                get label() { f.trace.push(["labelRead", ++labelReads]); return labelReads === 1 ? "first" : "second"; },
                get arguments() { f.trace.push(["argumentsRead", ++argumentReads]); return args; },
            };
            return { steps: [step] };
        });
    });
    it("resolves operation inside scope before normalization and again after await", async () => {
        const result = await witness(() => {
            const args: FlowArguments = { action: "before" };
            args.afterDispatch = () => { args.action = "after"; };
            return { steps: [{ tool: "click", arguments: args }] };
        });
        expect(result.trace).toContainEqual(["dispatch", "before", 1]);
        expect(result.trace).toContainEqual(["present", "click", "after"]);
        const scope = result.trace.findIndex((entry: any) => entry[0] === "scope");
        const operation = result.trace.findIndex((entry: any, index) => index > scope && entry[0] === "operation");
        const normalization = result.trace.findIndex((entry: any) => entry[0] === "normalize");
        expect(scope).toBeLessThan(operation); expect(operation).toBeLessThan(normalization);
    });
    it.each(["toolInputError", "flowOperationAllowed", "withBrokerOperation", "flowStepArguments",
        "normalizePublicToolArgs", "dispatchTool", "actionResult", "summarizeToolResult", "renderFlow"] as const)("preserves %s failure boundary", async name => {
        await witness(() => ({ steps: [{ tool: "click" }] }), f => {
            (f.ports as any)[name] = () => { throw new Error(name); };
        });
    });
    it("preserves operation lookup failure inside scope versus after dispatch", async () => {
        for (const failingLookup of [1, 2]) {
            await witness(() => ({ steps: [{ tool: "click" }] }), f => {
                let reads = 0;
                f.ports.toolOperation = () => { if (++reads === failingLookup) throw new Error("lookup"); return "click"; };
            });
        }
    });
    it.each(["tool", "label", "arguments"])("keeps throwing %s getter outside dispatch catch", async field => {
        const result = await witness(() => {
            const step: any = { tool: "click" };
            Object.defineProperty(step, field, { get() { throw new Error(field); } });
            return { steps: [step] };
        });
        expect(result).toHaveProperty("thrown", field);
    });
    it("catches an arguments getter failure reached only inside scoped dispatch", async () => {
        await witness(() => {
            let reads = 0;
            return { steps: [{ tool: "click", get arguments() { if (++reads === 7) throw new Error("late-arguments"); return {}; } }] };
        });
    });
    it.each([1, 3, 4, 5, 8])("keeps throwing action getter read %s at its original boundary", async failingRead => {
        await witness(() => {
            let reads = 0;
            const args = { get action() { if (++reads === failingRead) throw new Error("action-read"); return "click"; } };
            return { steps: [{ tool: "click", arguments: args }] };
        });
    });
    it.each([true, false])("keeps raw failure despite presented success with native ordering (stop=%s)", async stopOnError => {
        const result = await witness(() => ({ stopOnError, steps: [
            { tool: "click", arguments: { rawFail: true } }, { tool: "second" },
        ] }));
        expect(result.result?.value).toMatchObject({ ok: false });
        expect(result.result?.content.filter(item => item.type === "image").map(item => item.token)).toEqual(stopOnError ? ["click"] : ["click", "second"]);
    });
    it("keeps denial before dispatch and native aggregation", async () => {
        const result = await witness(() => ({ stopOnError: false, steps: [
            { tool: "delete", arguments: { deny: true } }, { tool: "click" },
        ] }));
        expect(result.trace).toContainEqual(["admission", "delete"]);
        expect(result.trace.filter((entry: any) => entry[0] === "dispatch")).toHaveLength(1);
    });
});

describe("normalized flow target policy", () => {
    const flow = { deviceId: "a", incarnationId: "generation", confirmDestructive: true, backend: "android" };
    it("inherits only eligible schema target properties", () => {
        expect(sharedFlowTarget(flow, {}, { deviceId: {} })).toEqual({ deviceId: "a" });
        expect(sharedFlowTarget(flow, {}, undefined)).toEqual({});
        expect(sharedFlowTarget(flow, {}, { deviceId: {}, incarnationId: {} })).toEqual({ deviceId: "a", incarnationId: "generation" });
    });
    it("clears shared target on deviceId change alone", () => {
        expect(sharedFlowTarget(flow, { deviceId: "b" }, { deviceId: {}, incarnationId: {} })).toEqual({});
        expect(sharedFlowTarget(flow, { backend: "ios" }, { deviceId: {}, incarnationId: {} })).toEqual({ deviceId: "a", incarnationId: "generation" });
    });
});
