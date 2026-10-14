import { describe, expect, it } from "vitest";
import { compactToolResult } from "../../device-lab-mcp/src/public-output.mjs";

const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const project = (name: string, value: unknown) => JSON.parse(compactToolResult(name, wrap(value)).content[0].text);
const recording = { runtimeId: "generation", sessionId: "session", finalizationId: "final", active: false, finalizing: true, startedAt: "start", stoppedAt: "stop", outputPath: "/artifact/movie.mp4", warnings: ["cleanup pending"], pid: 11, processIdentity: { token: "private" }, processStartToken: "start-token", processOwner: "owned", startedBy: "provider", ownerId: "owner", createdAt: "created", updatedAt: "updated" };
const publicRecording = { runtimeId: "generation", sessionId: "session", finalizationId: "final", active: false, finalizing: true, startedAt: "start", stoppedAt: "stop", outputPath: "/artifact/movie.mp4", warnings: ["cleanup pending"] };

describe("wait continuation presentation contracts", () => {
    it.each(["device_record_video_start", "device_record_video_stop", "device_record_video_status"])("%s keeps lifecycle/artifact semantics and unique helper observations", (name) => {
        const input = { recording, helper: { ...recording, bytesWritten: 72, cleanupPending: true } };
        const before = structuredClone(input);
        expect(project(name, input)).toEqual({ recording: publicRecording, helper: { bytesWritten: 72, cleanupPending: true } });
        expect(input).toEqual(before);
        expect(wrap(input).content[0].text).toContain("processStartToken");
    });
    it.each(["device_status", "device_list"])("%s compacts recording inside known targets", (name) => {
        const target = { id: "vm", incarnationId: "incarnation", recording };
        const output = project(name, name === "device_list" ? { devices: [target] } : { device: target });
        expect((output.devices?.[0] || output.device).recording).toEqual(publicRecording);
        expect((output.devices?.[0] || output.device)).not.toHaveProperty("incarnationId");
    });
    it("retains failed recording/helper cleanup and opaque exec data", () => {
        const failed = { ...recording, error: "finalization failed", scrubContainmentFailed: true };
        expect(project("device_record_video_stop", { recording: failed, helper: { ok: false, pid: 11, cleanupPending: true } })).toEqual({ recording: failed, helper: { ok: false, pid: 11, cleanupPending: true } });
        expect(project("device_exec", { recording, stdout: JSON.stringify(recording), status: 0 })).toEqual({ recording, stdout: JSON.stringify(recording), status: 0 });
    });
    it.each(["mobile_session_status", "device_status"])("%s retains session identity and warning but omits known discovery/process metadata", (name) => {
        const data = { lazy: true, tools: { adb: "/private/adb" }, appium: { appium: "/private/appium", adb: "/private/adb", available: true, warning: "driver mismatch" }, session: { sessionId: "session", active: false, processIdentity: { pid: 4 }, processOwner: "owned", startedBy: "provider", warning: "reconnect required" } };
        const output = project(name, name === "device_status" ? { device: { id: "phone" }, appium: data } : data);
        expect(name === "device_status" ? output.appium : output).toEqual({ appium: { available: true, warning: "driver mismatch" }, session: { sessionId: "session", active: false, warning: "reconnect required" } });
    });
    it("preserves failed discovery metadata for diagnostics", () => {
        const appium = { error: "discovery failed", adb: "/needed/to/debug", tools: { adb: "/needed/to/debug" } };
        const session = { error: "session lost", processIdentity: { pid: 2 }, processOwner: "owned" };
        expect(project("mobile_session_status", { appium, session })).toEqual({ appium, session });
    });
    it.each(["", "한글\nsecond line\n"])("clipboard suppresses only exact stdout mirror for %j", (text) => {
        expect(project("mobile_get_clipboard", { text, stdout: text })).toEqual({ text });
        expect(project("mobile_get_clipboard", { text, stdout: "unique diagnostic" })).toEqual({ text, stdout: "unique diagnostic" });
        expect(project("mobile_dump_ui", { source: text, stdout: "unique diagnostic" })).toEqual({ source: text, stdout: "unique diagnostic" });
    });
});
