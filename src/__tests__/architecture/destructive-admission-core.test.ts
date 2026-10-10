import { describe, expect, it } from "vitest";
import { evaluateDestructivePolicy } from "@ccc/device-lab/providers/domain/destructive-admission.mjs";
type Evaluator = (name: unknown, args?: unknown) => {ok: boolean; [key: string]: unknown};
const evaluate = evaluateDestructivePolicy as Evaluator;

function shell(command: unknown, args: unknown, extra: Record<string, unknown> = {}) {
    return { action: "request", method: "POST", path: "/execute/sync", body: { script: "mobile: shell", args: [{ command, args }] }, ...extra };
}

describe("destructive admission", () => {
    it("requires explicit boolean confirmation for deletion", () => {
        for (const confirmDestructive of [undefined, false, null, 0, 1, "true"]) {
            expect(evaluate("device_delete", { confirmDestructive }).ok).toBe(false);
        }
        expect(evaluate("device_delete", { force: true, deleteAvd: true, deleteSimulator: true, confirmDestructive: true })).toEqual({
            ok: true, destructive: true, actions: ["device-delete", "force-delete", "delete-avd", "delete-simulator"],
        });
    });
    it("requires confirmation for destructive shell commands", () => {
        expect(evaluate("device_broker_appium", shell("pm", ["clear", "pkg"])).ok).toBe(false);
        expect(evaluate("device_broker_appium", shell("pm", ["clear", "pkg"], { confirmDestructive: true })).ok).toBe(true);
    });
    it("permits unrelated requests without reading confirmation", () => {
        expect(evaluate("unknown", {})).toEqual({ ok: true, destructive: false, actions: [] });
    });
});
