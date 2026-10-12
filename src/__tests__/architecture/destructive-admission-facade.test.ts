import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES, evaluateDestructivePolicy } from "../../../device-lab-mcp/src/policy/destructive.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT, type DeviceLabMcpTestContext } from "../helpers/device-lab-mcp-fixture.js";
function payload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return JSON.parse((result.content as Array<{ text?: string }>)[0].text ?? "");
}
function snapshot(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    function visit(directory: string, prefix = "") {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name), relative = prefix + name;
            if (statSync(path).isDirectory()) visit(path, relative + "/");
            else files[relative] = readFileSync(path).toString("base64");
        }
    }
    visit(root); return files;
}

describe("destructive admission compatibility facade", () => {
    it("requires boolean confirmation for every destructive schema example", () => {
        expect(DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES.length).toBeGreaterThan(0);
        for (const { name, args } of DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES) {
            const denied = evaluateDestructivePolicy(name, args);
            expect(denied).toMatchObject({ ok: false, destructive: true, error: "destructive-action-confirmation-required", confirmationField: "confirmDestructive" });
            expect(evaluateDestructivePolicy(name, { ...args, confirmDestructive: "true" })).toEqual(denied);
            expect(evaluateDestructivePolicy(name, { ...args, confirmDestructive: true })).toEqual({ ok: true, destructive: true, actions: denied.actions });
        }
    });

    let context: DeviceLabMcpTestContext;
    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext({ rawPublicCalls: true, setupHome(home) {
            mkdirSync(join(home, "fixture-state"));
            writeFileSync(join(home, "fixture-state/device.json"), '{"present":true}');
        } });
    }, TIMEOUT);
    afterAll(async () => { await cleanupDeviceLabMcpTestContext(context); }, TIMEOUT);

    it("denies an unconfirmed public deletion without changing persisted fixture state", { timeout: TIMEOUT }, async () => {
        const before = snapshot(context.homeDir);
        const denied = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", detail: true } });
        expect(denied.isError).toBe(true);
        expect(payload(denied)).toEqual(expect.objectContaining({ ok: false, policy: {
            ok: false, destructive: true, error: "destructive-action-confirmation-required",
            message: "Set confirmDestructive=true to run this destructive device-lab action.",
            confirmationField: "confirmDestructive", actions: ["device-delete"],
        } }));
        expect(snapshot(context.homeDir)).toEqual(before);
    });

    it("preserves public validation presentation and refuses parent flow confirmation", { timeout: TIMEOUT }, async () => {
        const before = snapshot(context.homeDir);
        const invalid = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", confirmDestructive: "true" } });
        expect(invalid.isError).toBe(true);
        expect(payload(invalid)).toMatchObject({ ok: false, error: "delete confirmDestructive must be a boolean" });
        expect(payload(invalid)).not.toHaveProperty("policy");
        const detailed = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", confirmDestructive: "true", detail: true } });
        expect(detailed.isError).toBe(true);
        expect(payload(detailed)).toMatchObject({ ok: false, error: "delete confirmDestructive must be a boolean" });
        expect(payload(detailed)).not.toHaveProperty("policy");
        const missingConfirmation = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", detail: true } });
        expect(missingConfirmation.isError).toBe(true);
        expect(payload(missingConfirmation)).toMatchObject({ ok: false, policy: { error: "destructive-action-confirmation-required", confirmationField: "confirmDestructive", actions: ["device-delete"] } });
        const parent = await context.client.callTool({ name: "run_flow", arguments: { confirmDestructive: true,
            steps: [{ tool: "clear_app_data", arguments: { deviceId: "android-admission-owned", appId: "example.app" } }] } });
        expect(parent.isError).toBe(true);
        expect(payload(parent)).toMatchObject({ ok: false, error: "run_flow does not support confirmDestructive" });
        const step = await context.client.callTool({ name: "run_flow", arguments: { detail: true,
            steps: [{ tool: "clear_app_data", arguments: { deviceId: "android-admission-owned", appId: "example.app" } }] } });
        expect(step.isError).toBe(true);
        expect(payload(step)).toMatchObject({ ok: false, stoppedAt: 0, results: [{ isError: true,
            content: [{ value: { policy: { error: "destructive-action-confirmation-required", actions: ["app-data-clear"] } } }] }] });
        expect(snapshot(context.homeDir)).toEqual(before);
    });
});
