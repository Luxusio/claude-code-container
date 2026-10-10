import { describe, expect, it } from "vitest";
import { compactToolResult } from "../../device-lab-mcp/src/public-output.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

function reply(value: unknown) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false };
}

function projected(name: string, value: unknown) {
    const result = compactToolResult(name, reply(value));
    return { result, text: result.content[0].text, value: JSON.parse(result.content[0].text) };
}

const incarnationId = "1234567890abcdef1234567890abcdef";
const target = {
    id: "test-vm", name: "Test VM", backend: "windows-vm", status: "stopped", incarnationId,
    ownerId: "internal-owner", runtimeState: "stopped", readiness: { state: "stopped" }, leaseState: { state: "not-required" },
    targetStatus: { runtimeState: "stopped", readiness: { state: "stopped" }, leaseState: { state: "not-required" } },
};

describe("minimal public Device Lab output", () => {
    it("returns one actionable backend list without discovery transport duplicates", () => {
        const backends = [
            { name: "android-emulator", available: true, capabilities: ["device_screenshot", "device_stop"], tools: { adb: "/internal/adb" } },
            { name: "ios-simulator", available: false, missing: ["xcrun"] },
        ];
        const original = reply({
            ownerId: "internal-owner", backends, hostBackends: { backends }, localBackends: backends,
            broker: { available: true, rpcReady: true, implemented: ["internal-capability-v1"], state: { root: "/internal/state" } },
            routedBy: "device-backends-broker",
        });
        const result = compactToolResult("device_backends", original);
        const value = JSON.parse(result.content[0].text);
        expect(value.backends).toHaveLength(2);
        expect(result.content[0].text).toContain("xcrun");
        expect(value.backends[0].capabilities).toEqual(["device_screenshot", "device_stop"]);
        expect(value).not.toHaveProperty("hostBackends");
        expect(value).not.toHaveProperty("localBackends");
        expect(result.content[0].text).not.toContain("internal-capability-v1");
        expect(result.content[0].text).not.toContain("/internal/state");
        expect(result.content[0].text.length).toBeLessThan(original.content[0].text.length / 2);
        expect(result.content[0].text).not.toContain("\n");
    });

    it("keeps device identity and fenced-action incarnation while removing duplicate status", () => {
        const { value, text } = projected("device_status", target);
        expect(text).toContain("test-vm");
        expect(text).toContain(incarnationId);
        expect(text).toContain("stopped");
        expect(value).not.toHaveProperty("targetStatus");
        expect(text).not.toContain("internal-owner");
    });

    it("projects inventory devices while keeping empty inventory meaningful", () => {
        const { value, text } = projected("device_list", { ownerId: "internal-owner", devices: [target], routedBy: "device-list-direct" });
        expect(value.devices).toHaveLength(1);
        expect(text).toContain(incarnationId);
        expect(value.devices[0]).not.toHaveProperty("targetStatus");
        expect(projected("device_list", { devices: [] }).value.devices).toEqual([]);
    });

    it("keeps unavailable and authentication-not-ready broker states distinguishable", () => {
        const unavailable = projected("device_broker_status", {
            available: false, rpcReady: false, mode: "broker-unavailable",
            warnings: ["Broker is unreachable"], remedies: ["Reopen CCC from the host"],
            implemented: ["internal-capability-v1"],
        });
        expect(unavailable.text).toContain("Reopen CCC from the host");
        expect(unavailable.text).not.toMatch(/"(?:ready|available|rpcReady)":true/);
        const reachable = projected("device_broker_status", {
            available: true, rpcReady: false, mode: "host-broker-detected",
            warnings: ["Owner credential unavailable"], remedies: ["Restore owner credentials"],
        });
        expect(reachable.text).toContain("Restore owner credentials");
        expect(reachable.text).not.toMatch(/"(?:ready|rpcReady)":true/);
    });

    it("does not turn unknown device readiness into ready", () => {
        const { text } = projected("device_status", {
            id: "unknown-vm", backend: "linux-vm", runtimeState: "unknown", readiness: { state: "unknown" },
        });
        expect(text).toContain("unknown");
        expect(text).not.toMatch(/"(?:ready|available)":true/);
    });

    it.each([
        ["mobile_get_clipboard", "text", "clipboard-unique-data"],
        ["mobile_dump_ui", "source", "<node text='unique-ui-content'/>"],
    ])("returns %s data only once without its transport echo", (name, key, content) => {
        const { value, text } = projected(name, {
            provider: "broker-appium", backend: "android-emulator", [key]: content,
            broker: { ok: true, result: { response: { body: { value: content } } }, selected: { host: "internal-host" } },
        });
        expect(value[key]).toBe(content);
        expect(text.split(content)).toHaveLength(2);
        expect(text).not.toContain("internal-host");
    });

    it.each(["device_broker_rpc", "device_exec"])("preserves arbitrary %s payloads with metadata-looking keys", (name) => {
        const data = {
            ownerId: "user-owner", source: "user-source", broker: { implemented: ["application-capability"] },
            targetStatus: { status: "application-state" }, status: 0, stdout: "exact command output\n", stderr: "",
        };
        const { value } = projected(name, { ok: true, result: data });
        expect(value.result).toEqual(data);
    });

    it("preserves opaque UI data even when object keys resemble transport metadata", () => {
        const tree = { ownerId: "ui-owner", source: "ui-source", targetStatus: { label: "Readiness" }, broker: "visible label" };
        expect(projected("mobile_dump_ui", { source: tree }).value.source).toEqual(tree);
    });

    it("preserves lifecycle outcomes and artifact paths required by the next operation", () => {
        for (const [name, data] of [
            ["device_create", { device: target }],
            ["device_delete", { deleted: "test-vm", avdDeleted: true }],
            ["device_record_video_stop", { stopped: true, recording: { active: false }, outputPath: "/tmp/movie.mp4" }],
        ] as const) {
            const { text } = projected(name, data);
            if (name === "device_create") expect(text).toContain(incarnationId);
            if (name === "device_delete") { expect(text).toContain("test-vm"); expect(text).toContain('"avdDeleted":true'); }
            if (name === "device_record_video_stop") { expect(text).toContain("/tmp/movie.mp4"); expect(text).toContain('"stopped":true'); }
        }
    });

    it("retains actionable nested errors and incomplete containment/cleanup results", () => {
        const input = {
            ok: false, error: "provider-command-failed",
            body: { detail: "Guest did not stop", remedy: "Retry stop before deletion", scrubContainmentFailed: true,
                cleanup: { stopped: false, deleted: false, error: "cleanup-incomplete" } },
        };
        const { text } = projected("device_stop", input);
        for (const required of ["provider-command-failed", "Guest did not stop", "Retry stop before deletion", "scrubContainmentFailed", "cleanup-incomplete"]) {
            expect(text).toContain(required);
        }
        expect(text).toContain('"ok":false');
        expect(text).toContain('"stopped":false');
    });

    it("deduplicates a broker transport failure while preserving provider containment and cleanup evidence", () => {
        const provider = {
            error: "guest-shutdown-failed", detail: "Guest remains running", remedy: "Stop guest before retry",
            scrubContainmentFailed: true, cleanup: { stopped: false, deleted: false, error: "cleanup-incomplete" },
        };
        const body = { ok: false, error: "provider-command-failed", result: provider };
        const original = {
            ok: false, error: "provider-command-failed", method: "broker.device.tool.invoke", result: provider, body,
            routedBy: "device-lifecycle-broker", ownerId: "internal-owner", runtime: { file: "/internal/runtime" },
            selected: { host: "internal-host", port: 17373, endpoint: "/v1/rpc", status: 502, body },
            attempts: [{ host: "internal-host", durationMs: 123, status: 502, body }],
            launch: { ok: true, reused: true, attempts: [
                { reason: "broker-reuse-process-verified", processVerification: { ok: true, pid: 999 } },
                { ok: true, endpoint: "http://internal-host:17373/health", body: { ok: true, name: "ccc-device-broker", implemented: ["internal-capability-v1"] } },
            ] },
        };
        const { value, text } = projected("device_stop", original);
        expect(value.ok).toBe(false);
        expect(value.result).toEqual(provider);
        expect(text.split("Guest remains running")).toHaveLength(2);
        for (const internal of ["internal-host", "internal-owner", "/internal/runtime", "internal-capability-v1", "processVerification", "durationMs"]) {
            expect(text).not.toContain(internal);
        }
        expect(text).toContain('"scrubContainmentFailed":true');
        expect(text.length).toBeLessThan(JSON.stringify(original).length);
    });

    it("retains distinct transport attempts and selected provider errors when they are not top-level duplicates", () => {
        const providerFailure = { error: "guest-rpc-refused", detail: "Guest agent connection rejected", scrubContainmentFailed: true };
        const { value, text } = projected("device_start", {
            ok: false, error: "broker-command-failed", method: "broker.device.start", routedBy: "device-lifecycle-broker",
            selected: { host: "internal-host", port: 17373, status: 502, body: providerFailure },
            attempts: [
                { host: "first-host", error: "connection-refused", transportCode: "ECONNREFUSED", retryable: true },
                { host: "second-host", error: "request-aborted", transportCode: "ETIMEDOUT", retryable: false, termination: "deadline" },
            ],
        });
        expect(value.selected.body).toEqual(providerFailure);
        expect(value.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ error: "connection-refused", transportCode: "ECONNREFUSED", retryable: true }),
            expect.objectContaining({ error: "request-aborted", transportCode: "ETIMEDOUT", retryable: false, termination: "deadline" }),
        ]));
        expect(text).not.toContain("first-host");
        expect(text).toContain("Guest agent connection rejected");
    });

    it("leaves opaque RPC failures and unknown failure payloads unchanged", () => {
        const applicationFailure = {
            ok: false, error: "application-failure", method: "custom-method", selected: { ownerId: "user-selection", body: { x: 1 } },
            attempts: [{ host: "application-data", runtime: "application-runtime" }], result: { source: "application-source" },
        };
        expect(projected("device_broker_rpc", applicationFailure).value).toEqual(applicationFailure);
        expect(projected("future_tool", applicationFailure).value).toEqual(applicationFailure);
    });

    it("removes successful readiness checks without hiding pending, unknown, or denied access states", () => {
        const { value } = projected("device_backends", { backends: [{
            name: "windows-vm", available: true, readiness: {
                ok: true, available: true, moduleAvailable: true, hypervisorPresent: true,
                vmmsRunning: true, qemuImgAvailable: true, qemuImgTrusted: true,
                managementAccess: false, rebootPending: true, sessionRefreshRequired: "unknown",
                linuxImageMissing: ["image.vhdx"], missing: [], freeMemoryMb: 16384,
            },
        }] });
        const readiness = value.backends[0].readiness;
        expect(readiness.managementAccess).toBe(false);
        expect(readiness.rebootPending).toBe(true);
        expect(readiness.sessionRefreshRequired).toBe("unknown");
        expect(readiness.linuxImageMissing).toEqual(["image.vhdx"]);
        expect(readiness).not.toHaveProperty("moduleAvailable");
        expect(readiness).not.toHaveProperty("freeMemoryMb");
        expect(readiness).not.toHaveProperty("missing");
        const failedReadiness = { ok: false, available: false, managementAccess: false, rebootPending: "unknown", detail: "Access denied" };
        const failure = projected("device_backends", { backends: [{ name: "windows-vm", available: false, readiness: failedReadiness }] });
        expect(failure.value.backends[0].readiness).toEqual(failedReadiness);
    });

    it("compacts flow results without losing step failure or returned clipboard data", () => {
        const { value, text } = projected("device_run_flow", {
            ok: false, stoppedAt: 1, results: [
                { index: 0, label: "Read", tool: "mobile_get_clipboard", isError: false, content: [{ type: "json", value: { text: "flow-clipboard", provider: "broker-appium", broker: { ok: true, selected: { host: "internal-host" } } } }] },
                { index: 1, label: "Stop", tool: "device_stop", isError: true, content: [{ type: "json", value: { ok: false, error: "stop-unconfirmed", remedy: "Retry stop" } }] },
            ],
        });
        expect(value.ok).toBe(false);
        expect(value.stoppedAt).toBe(1);
        expect(value.results).toHaveLength(2);
        expect(text).toContain("flow-clipboard");
        expect(text).toContain("stop-unconfirmed");
        expect(text).toContain("Retry stop");
        expect(text).not.toContain("internal-host");
    });

    it("preserves images, resources, non-JSON text and MCP error status", () => {
        const result = {
            isError: true,
            content: [
                { type: "image", data: "AQID", mimeType: "image/png" },
                { type: "resource", resource: { uri: "file:///artifact.txt", text: "source: application content" } },
                { type: "text", text: "Error: exact backend message" },
            ],
        };
        expect(compactToolResult("device_screenshot", result)).toEqual(result);
    });

    it("preserves unknown result shapes without guessing at their meaning", () => {
        const unknown = { custom: { ownerId: "user-data", targetStatus: { x: 1 } }, payload: [0, false, null] };
        expect(projected("future_tool", unknown).value).toEqual(unknown);
    });

    it("supports create/list/status/delete chaining through the compact MCP wire and opt-in diagnostics", { timeout: TIMEOUT }, async () => {
        const context = await createDeviceLabMcpTestContext();
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await context.client.callTool({ name, arguments: { detail: false, ...args } });
            expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
            const text = (result.content as Array<{ text: string }>)[0].text;
            return { value: JSON.parse(text), text };
        };
        try {
            const created = await call("create_android_emulator", {
                 name: "Minimal output fixture",
                avdName: "Minimal_Fixture", port: 5580,
            });
            const id = created.value.device.deviceId;
            expect(id).toEqual(expect.any(String));
            const list = await call("devices");
            expect(list.value.some((device: { deviceId: string }) => device.deviceId === id)).toBe(true);
            const compact = await call("status", { deviceId: id });
            const detailed = await call("status", { deviceId: id, detail: true });
            expect(compact.value.device.deviceId).toBe(id);
            expect(compact.value.device).not.toHaveProperty("targetStatus");
            expect(detailed.value.device).toHaveProperty("targetStatus");
            expect(compact.text.length).toBeLessThan(detailed.text.length);
            expect(compact.text).not.toContain("\n");
            const compactBackends = await call("devices", { view: "backends" });
            const detailedBackends = await call("devices", { view: "backends", detail: true });
            expect(compactBackends.value.backends.some((backend: { capabilities?: string[] }) => backend.capabilities?.includes("screenshot"))).toBe(true);
            expect(detailedBackends.value.backends.some((backend: { capabilities?: string[] }) => backend.capabilities?.includes("screenshot"))).toBe(true);
            const refused = await context.client.callTool({ name: "delete", arguments: { deviceId: id, confirmDestructive: false } });
            expect(refused.isError).toBe(true);
            expect(JSON.parse((refused.content as Array<{ text: string }>)[0].text)).toMatchObject({
                ok: false,
                policy: { error: "destructive-action-confirmation-required", confirmationField: "confirmDestructive" },
            });
            const retained = await call("status", { deviceId: id });
            expect(retained.value.device.deviceId).toBe(id);
            const deleted = await call("delete", { deviceId: id, confirmDestructive: true });
            expect(deleted.value.deleted).toBe(id);
        } finally {
            await cleanupDeviceLabMcpTestContext(context);
        }
    });
});
