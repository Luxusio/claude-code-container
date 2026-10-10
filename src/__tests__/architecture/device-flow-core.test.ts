import { describe, expect, it } from "vitest";
import { runDeviceFlow } from "../../../packages/device-lab/providers/application/device-flow.mjs";
import { sharedFlowTarget } from "../../../packages/device-lab/providers/domain/device-flow.mjs";
import type { DeviceFlowPorts } from "../../../packages/device-lab/providers/ports/device-flow.mjs";
import type { FlowArguments, FlowValue } from "../../../packages/device-lab/providers/domain/device-flow.mjs";

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
async function witness(make: (f: ReturnType<typeof fixture>) => FlowArguments, change?: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture(); change?.(f);
    try { return {result: await runDeviceFlow(make(f), options, f.ports), trace:f.trace, thrown:undefined}; }
    catch (error) { return {result:undefined, thrown:(error as Error).message, trace:f.trace}; }
}

describe("current device-flow policy", () => {
    it.each([0, 1, 50, 51])("preserves %s-step admission bounds", async length => {
        const result = await witness(() => ({ steps: Array.from({ length }, () => ({ tool: "click" })) }));
        const dispatches = result.trace.filter((entry: any) => entry[0] === "dispatch");
        expect(dispatches).toHaveLength(length > 0 && length <= 50 ? length : 0);
    });
    it.each([undefined, null, false, 0, "", true, 1, "yes"])("preserves stopOnError truthiness %j", async stopOnError => {
        const observed = await witness(() => ({ stopOnError, steps: [{ tool: "click", arguments: { invalid: "bad" } }, { tool: "click" }] }));
        expect(observed.trace.filter((row:any) => row[0] === "dispatch")).toHaveLength(stopOnError === undefined || Boolean(stopOnError) ? 0 : 1);
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
        const observed = await witness(() => ({ stopOnError: false, steps: [step, { tool: "click" }] }));
        expect(observed.trace.some((row:any) => row[0] === "dispatch")).toBe(true);
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
        const observed = await witness(() => ({ steps: [{ tool: "click" }] }), f => {
            (f.ports as any)[name] = () => { throw new Error(name); };
        });
        expect(observed.thrown ?? observed.result?.value).toBeDefined();
    });
    it.each([true, false])("retains raw failure and stop/continue", async stopOnError => {
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
