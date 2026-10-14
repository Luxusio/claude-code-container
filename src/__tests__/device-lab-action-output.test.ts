import { describe, expect, it } from "vitest";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { validateDeviceLabToolOutput } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const parse = (value: any) => JSON.parse(value.content[0].text);

describe("action-first output", () => {
    it("validates literal action success and rejects minimal error objects", () => {
        expect(validateDeviceLabToolOutput("click", "ok")).toBe("ok");
        expect(() => validateDeviceLabToolOutput("click", { error: "offline" })).toThrow("offline");
    });
    it("returns only ok after a successful click without echoing input", () => {
        expect(actionResult("click", "device_click", json({ clicked: { x: 3, y: 4 }, ok: true, provider: "adb", status: 0, stdout: "", stderr: "" })))
            .toEqual({ content: [{ type: "text", text: "ok" }] });
    });
    it("preserves warnings rather than reporting bare ok", () => {
        expect(parse(actionResult("type", "device_type", json({ ok: true, warnings: ["partial input"], typed: true }))))
            .toEqual({ warnings: ["partial input"] });
    });
    it.each([
        { ok: false, error: "offline" },
        { ok: true, result: { ok: false, error: "lost ownership" } },
        { ok: true, response: { body: { value: { error: "stale incarnation" } } } },
        { result: { status: 1, stderr: "failed" } },
    ])("never hides nested action failure %j", (value) => {
        const result = actionResult("click", "device_click", json(value));
        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toBe("ok");
    });
    it("preserves native screenshots and dimensions without a public generation selector", () => {
        const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
        const result = actionResult("screenshot", "device_screenshot", { content: [image, ...json({ width: 100, height: 200, incarnationId: "a".repeat(32) }).content] });
        expect(result.content[0]).toEqual(image);
        expect(JSON.parse(result.content[1].text)).toEqual({ width: 100, height: 200 });
    });
    it("keeps false, zero, and opaque query payloads", () => {
        const raw = json({ found: false, count: 0, nested: { deviceId: "opaque", incarnationId: "guest-payload", ok: true, source: "" } });
        expect(parse(actionResult("wait_for_text", "mobile_wait_for_text", raw))).toEqual({ count: 0, nested: { deviceId: "opaque", incarnationId: "guest-payload", ok: true, source: "" }, matched: false, reason: "wait-condition-not-met" });
    });
    it("removes CCC generation metadata while retaining opaque guest output", () => {
        const guest = { incarnationId: "guest-root", nested: { incarnationId: "guest-child" } };
        const exec = parse(actionResult("exec", "device_exec", json({ deviceId: "win-existing", incarnationId: "a".repeat(32), status: 0, stdout: JSON.stringify(guest), output: guest })));
        expect(exec).toMatchObject({ deviceId: "win-existing", status: 0, stdout: JSON.stringify(guest), output: guest });
        expect(exec).not.toHaveProperty("incarnationId");
        const status = parse(actionResult("status", "device_status", json({ device: { id: "win-existing", backend: "windows-vm", incarnationId: "a".repeat(32) } })));
        expect(status.device).not.toHaveProperty("incarnationId");
        const diagnostic = json({ device: { id: "win-existing", incarnationId: "a".repeat(32) } });
        expect(parse(actionResult("status", "device_status", diagnostic, { detail: true }))).toMatchObject({ device: { deviceId: "win-existing", incarnationId: "a".repeat(32) } });
    });
    it("returns minimal device rows and cursor coordinates", () => {
        expect(parse(actionResult("devices", "device_list", json({ devices: [{ id: "d", name: "Pixel", runtimeState: "running", ownerId: "private" }], ownerId: "private" }))))
            .toEqual([{ deviceId: "d", name: "Pixel", state: "running" }]);
        expect(parse(actionResult("cursor_position", "device_cursor_position", json({ x: 0, y: 2, provider: "xdotool", raw: "x:0" }))))
            .toEqual({ x: 0, y: 2 });
        expect(parse(actionResult("cursor_position", "device_cursor_position", json({ cursor: { x: 0, y: 2 }, provider: "windows-helper" }))))
            .toEqual({ x: 0, y: 2 });
    });
    it("retains diagnostic output on explicit request", () => {
        const raw = json({ ok: true, provider: "test", clicked: { x: 1, y: 2 } });
        expect(actionResult("click", "device_click", raw, { detail: true })).toBe(raw);
    });
    it("keeps diagnostic provider capabilities callable without rewriting opaque payloads", () => {
        const result = parse(actionResult("devices", "device_backends", json({
            localBackends: [{ capabilities: ["device_screenshot", "mobile_tap"] }],
            output: { capabilities: ["opaque_device_token"] },
        }), { detail: true }));
        expect(result.localBackends[0].capabilities).toEqual(["screenshot", "click"]);
        expect(result.output.capabilities).toEqual(["opaque_device_token"]);
    });
    it("advertises cursor movement for the current-display backend", () => {
        const result = parse(actionResult("devices", "device_backends", json({ backends: [
            { name: "x11-current-display", capabilities: ["device_cursor_position"] },
        ] }), { detail: true }));
        expect(result.backends[0].capabilities).toEqual(["cursor_position", "move"]);
    });
    it("does not invent action success for an empty query response", () => {
        expect(actionResult("screenshot", "device_screenshot", { content: [] })).toEqual({ content: [] });
    });
    it("wraps plain-text errors with MCP failure status", () => {
        expect(actionResult("click", "device_click", { ...json(null), isError: true, content: [{ type: "text", text: "offline" }] }))
            .toEqual({ isError: true, content: [{ type: "text", text: '{"error":"offline"}' }] });
    });
    it("bounds JSON expansion of large plain-text errors", () => {
        const result = actionResult("click", "device_click", { isError: true, content: [{ type: "text", text: '\\"\n'.repeat(30000) }] });
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(65536);
        expect(parse(result).diagnosticTruncated).toBe(true);
    });
});
