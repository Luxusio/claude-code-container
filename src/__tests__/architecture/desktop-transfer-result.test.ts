import {describe, expect, it, vi} from "vitest";
import {renderDesktopTransferCleanup} from "../../../packages/device-lab/providers/adapters/desktop-transfer-result.mjs";
import {renderStageCleanupFailure} from "../../../packages/device-lab/providers/adapters/stage-cleanup-result.mjs";
import type {DesktopCleanupFailure} from "../../../packages/device-lab/providers/domain/desktop-control-transfer.mjs";
import {runDeviceFlow} from "../../../packages/device-lab/providers/application/device-flow.mjs";
import type {DeviceFlowPorts} from "../../../packages/device-lab/providers/ports/device-flow.mjs";
import {decodeFlowResult} from "../../../device-lab-mcp/src/device-flow-adapter.mjs";

type NativeReply = {isError?: boolean; content: {type: string; text?: string; data?: unknown; mimeType?: string}[]};
const {jsonResult, textResult, MCP_ERROR_TEXT_LIMIT_BYTES} = await vi.importActual<{
    jsonResult(value: unknown): NativeReply;
    textResult(ok: boolean, text: string): NativeReply;
    MCP_ERROR_TEXT_LIMIT_BYTES: number;
}>("../../../packages/device-lab/providers/responses.mjs");

const completed = {kind: "completed" as const, name: "device_upload", args: {localPath: "logical", remotePath: "remote"}, evidence: Symbol("native evidence")};
function failure(primary: DesktopCleanupFailure["cleanup"]["primary"], error: unknown): DesktopCleanupFailure {
    return {kind: "failed", name: "device_upload", evidence: error, cleanup: {primary, error}};
}
function value(response: {content: readonly {text?: string}[]}) {
    const text = response.content[0]?.text;
    if (typeof text !== "string") throw new Error("expected JSON text result");
    return JSON.parse(text);
}

describe("desktop transfer cleanup projection", () => {
    it("renders the exact completed primary through its ordinary callback without serializing native evidence or raw cleanup errors", () => {
        const cleanupError = Object.assign(new Error("private cleanup message /staging/secret"), {code: "EACCES", privateData: "private-property"});
        const ordinary = jsonResult({uploaded: {localPath: "logical", remotePath: "remote"}, provider: "scp"});
        const render = vi.fn(() => ordinary);
        const result = renderDesktopTransferCleanup(failure(completed, cleanupError), render, jsonResult);
        expect(render).toHaveBeenCalledExactlyOnceWith(completed);
        expect(result.isError).toBe(true);
        expect(value(result)).toEqual({
            ok: false, error: "desktop-transfer-cleanup-failed", cause: {kind: "completed", result: ordinary},
            cleanup: {operation: "local", failed: true, code: "EACCES"}, result: {kind: "completed", completed: true},
        });
        expect(result.content[0].text).not.toContain("private cleanup message");
        expect(result.content[0].text).not.toContain("/staging/secret");
        expect(result.content[0].text).not.toContain("private-property");
    });

    it.each([
        {kind: "failed" as const, name: "device_download", evidence: Symbol("native failed")},
        {kind: "refused" as const, message: "publication-denied"},
    ])("preserves the ordinary public $kind result without reporting completion", primary => {
        const ordinary = textResult(false, primary.kind === "refused" ? primary.message : "native transfer failed");
        const render = vi.fn(() => ordinary);
        const response = renderDesktopTransferCleanup(failure(primary, undefined), render, jsonResult);
        expect(render).toHaveBeenCalledExactlyOnceWith(primary);
        expect(response.isError).toBe(true);
        expect(value(response)).toEqual({ok: false, error: "desktop-transfer-cleanup-failed",
            cause: {kind: primary.kind, result: ordinary}, cleanup: {operation: "local", failed: true}});
    });

    it.each([0, undefined, Symbol("raw primary")])("keeps opaque thrown primary %s internal without invoking its ordinary renderer", error => {
        const render = vi.fn(() => textResult(true, "must not run"));
        const response = renderDesktopTransferCleanup(failure({kind: "thrown", error}, Symbol("cleanup")), render, jsonResult);
        expect(render).not.toHaveBeenCalled();
        expect(response.isError).toBe(true);
        expect(value(response)).toEqual({ok: false, error: "desktop-transfer-cleanup-failed",
            cause: {kind: "thrown"}, cleanup: {operation: "local", failed: true}});
    });

    it("exposes validated own errno codes for both failures without exposing other error fields", () => {
        const primary = Object.assign(new Error("private transfer failed"), {code: "EIO", path: "/private/transfer"});
        const cleanup = Object.assign(new Error("private cleanup failed"), {code: "ENOENT", path: "/private/stage"});
        const response = renderDesktopTransferCleanup(failure({kind: "thrown", error: primary}, cleanup), () => textResult(true, "unused"), jsonResult);
        expect(value(response)).toEqual({ok: false, error: "desktop-transfer-cleanup-failed",
            cause: {kind: "thrown", code: "EIO"}, cleanup: {operation: "local", failed: true, code: "ENOENT"}});
        expect(response.content[0].text).not.toContain("private");
    });

    it.each([null, "EACCES", {code: 5}, {code: "eacces"}, {code: "EIO\nprivate"}, {code: "E" + "X".repeat(1000)}, Object.create({code: "EPERM"})])(
        "omits invalid, inherited and primitive errno observations %#", error => {
            const response = renderDesktopTransferCleanup(failure({kind: "thrown", error}, error), () => textResult(true, "unused"), jsonResult);
            expect(value(response)).toEqual({ok: false, error: "desktop-transfer-cleanup-failed",
                cause: {kind: "thrown"}, cleanup: {operation: "local", failed: true}});
        },
    );

    it("does not invoke error code getters or replace the failure when property inspection throws", () => {
        const getter = vi.fn(() => { throw new Error("private getter"); });
        const accessor = Object.defineProperty({}, "code", {get: getter});
        const trapped = new Proxy({}, {getOwnPropertyDescriptor() { throw new Error("private trap"); }});
        const response = renderDesktopTransferCleanup(failure({kind: "thrown", error: accessor}, trapped), () => textResult(true, "unused"), jsonResult);
        expect(getter).not.toHaveBeenCalled();
        expect(value(response)).toEqual({ok: false, error: "desktop-transfer-cleanup-failed",
            cause: {kind: "thrown"}, cleanup: {operation: "local", failed: true}});
    });

    it("retains completed-publication evidence when the ordinary result exceeds diagnostic bounds", () => {
        const ordinary = jsonResult({uploaded: {localPath: "logical", remotePath: "remote"}, stdout: "큰 출력\\\"".repeat(50000)});
        const response = renderDesktopTransferCleanup(failure(completed, {code: "EACCES"}), () => ordinary, jsonResult);
        expect(response.isError).toBe(true);
        const text = response.content[0]?.text;
        if (typeof text !== "string") throw new Error("expected bounded JSON text");
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        const bounded = value(response);
        expect(bounded.ok).toBe(false);
        expect(bounded.error).toBe("desktop-transfer-cleanup-failed");
        expect(bounded.cause.kind).toBe("completed");
        expect(bounded.cleanup).toEqual({operation: "local", failed: true, code: "EACCES"});
        expect(bounded.result).toEqual({kind: "completed", completed: true});
        expect(bounded.diagnosticTruncated).toBe(true);
    });

    it.each([true, false])("actual flow decoding honors stopOnError=%s after completed transfer cleanup failure", async stopOnError => {
        const response = renderDesktopTransferCleanup(failure(completed, {code: "EACCES"}), () => jsonResult({uploaded: completed.args}), jsonResult);
        const dispatched: string[] = [];
        const unexpected = (): never => { throw new Error("unexpected validation failure"); };
        const ports: DeviceFlowPorts<ReturnType<typeof decodeFlowResult>["payload"]> = {
            toolInputError: () => null, flowOperationAllowed: () => true, toolOperation: tool => tool,
            flowStepArguments: (_tool, _flow, step) => step || {}, normalizePublicToolArgs: (_tool, args) => args,
            withBrokerOperation: operation => operation(),
            dispatchTool: async operation => {
                dispatched.push(operation);
                const native = operation === "device_upload" ? response : jsonResult({ok: true});
                return decodeFlowResult({...native, content: native.content.map(({type, text}) => ({type, text}))});
            },
            destructiveDenial: unexpected, dispatchFailure: unexpected,
        };
        const outcome = await runDeviceFlow({stopOnError, steps: [{tool: "device_upload"}, {tool: "device_click"}]},
            {toolName: "run_flow", toolAllowed: () => true}, ports);
        expect(outcome).toMatchObject({kind: "complete", ok: false});
        expect(dispatched).toEqual(stopOnError ? ["device_upload"] : ["device_upload", "device_click"]);
        if (outcome.kind === "complete") {
            expect(outcome.results[0]).toMatchObject({failed: true, payload: response});
            expect(outcome.stoppedAt).toBe(stopOnError ? 0 : undefined);
            expect(value(outcome.results[0].payload!)).toMatchObject({result: {kind: "completed", completed: true}});
        }
    });
});

describe("shared transfer and recording cleanup projection", () => {
    it.each(["android-transfer-cleanup-failed", "ios-transfer-cleanup-failed"])("retains a completed transfer result for %s", error => {
        const ordinary = jsonResult({uploaded: {localPath: "logical", remotePath: "remote"}});
        const response = renderStageCleanupFailure({error, primary: {kind: "returned", outcome: "completed", result: ordinary},
            cleanupError: {code: "EPERM"}, result: {kind: "completed", completed: true}}, jsonResult);
        expect(response.isError).toBe(true);
        expect(value(response)).toEqual({ok: false, error, cause: {kind: "completed", result: ordinary},
            cleanup: {operation: "local", failed: true, code: "EPERM"}, result: {kind: "completed", completed: true}});
    });

    it("preserves positive recording publication without claiming completion after finalization failed", () => {
        const ordinary = textResult(false, "recording-generation-changed");
        const response = renderStageCleanupFailure({error: "recording-stage-cleanup-failed",
            primary: {kind: "returned", outcome: "failure", result: ordinary}, cleanupError: {code: "EACCES"},
            result: {outputPublished: true}}, jsonResult);
        expect(response.isError).toBe(true);
        expect(value(response)).toEqual({ok: false, error: "recording-stage-cleanup-failed",
            cause: {kind: "failure", result: ordinary}, cleanup: {operation: "local", failed: true, code: "EACCES"},
            result: {outputPublished: true}});
    });

    it.each([0, undefined])("retains positive recording facts after an opaque thrown finalization %#", primaryError => {
        const cleanup = Object.assign(new Error("private cleanup /owned/stage"), {code: "EIO", privateData: Symbol("private")});
        const response = renderStageCleanupFailure({error: "recording-stage-cleanup-failed",
            primary: {kind: "thrown", error: primaryError}, cleanupError: cleanup,
            result: {outputPublished: true, recordingStateCleared: true}}, jsonResult);
        expect(value(response)).toEqual({ok: false, error: "recording-stage-cleanup-failed", cause: {kind: "thrown"},
            cleanup: {operation: "local", failed: true, code: "EIO"}, result: {outputPublished: true, recordingStateCleared: true}});
        expect(response.content[0].text).not.toContain("private");
        expect(response.content[0].text).not.toContain("/owned/stage");
    });

    it("keeps publication and state-clear facts through giant recording failure diagnostics", () => {
        const response = renderStageCleanupFailure({error: "recording-stage-cleanup-failed",
            primary: {kind: "returned", outcome: "failure", result: textResult(false, 'bad"\\\n'.repeat(40000))},
            cleanupError: {code: "EPERM"}, result: {outputPublished: true, recordingStateCleared: true}}, jsonResult);
        const text = response.content[0]?.text;
        if (typeof text !== "string") throw new Error("expected bounded JSON text");
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(response.isError).toBe(true);
        const bounded = value(response);
        expect(bounded.error).toBe("recording-stage-cleanup-failed");
        expect(bounded.cause.kind).toBe("failure");
        expect(bounded.cleanup).toEqual({operation: "local", failed: true, code: "EPERM"});
        expect(bounded.result).toEqual({outputPublished: true, recordingStateCleared: true});
        expect(bounded.diagnosticTruncated).toBe(true);
    });
});
