import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/operation-tools.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";
import { compactToolResult } from "../../device-lab-mcp/src/public-output.mjs";

type Data = Record<string, unknown>;
type Fixture = { input: Data; keep: Data; absent?: string[] };
const id = "audit-device";
const incarnationId = "1234567890abcdef1234567890abcdef";
const device = { id, backend: "macos-vm", status: "stopped", incarnationId, ownerId: "private-owner", createdAt: "2026-01-01", helper: { status: "ready", hostHelperScript: "/private/helper" } };
const identity = { id, incarnationId, status: "stopped" };
const success = { status: 0, stdout: "", stderr: "" };
const image = { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" };
const tree = { name: "Editor", children: [{ name: "Unique text", provider: "user field", runtime: { pid: 82 }, ownerId: "UI content", source: "user document" }] };
const fixtures: Record<string, Fixture> = {};
const listing = { entries: [{ name: ".hidden", type: "file", size: 0 }, { name: "Documents", type: "directory" }], truncated: true };
add("device_list_files", listing, listing);
action("device_focus_window", { focused: true }, "desktop-helper");
function add(name: string, input: Data, keep: Data, absent?: string[]) { fixtures[name] = { input, keep, absent }; }
function action(name: string, data: Data, provider = "adb") {
    add(name, { ...data, provider, ...success }, data, ["stdout", "stderr", "status"]);
}
function lifecycle(name: string, extra: Data = {}) {
    add(name, { device, ...extra }, { device: identity, ...extra });
}

// Fixtures follow actual public envelopes in server.mjs and individual providers;
// each tool has a meaningful semantic assertion rather than one shared success blob.
add("device_backends", { backends: [{ name: "macos-vm", available: false, missing: ["tart"] }], ownerId: "private-owner" }, { backends: [{ name: "macos-vm", available: false, missing: ["tart"] }] });
add("device_broker_status", { available: true, rpcReady: false, warnings: ["Owner token missing"], remedies: ["Open host CCC"], implemented: ["internal-v1"] }, { available: true, rpcReady: false, warnings: ["Owner token missing"], remedies: ["Open host CCC"] }, ["implemented"]);
add("device_list", { devices: [device] }, { devices: [identity] });
add("device_inventory", { backend: "macos-vm", devices: [device], discovery: { available: true, missing: [] } }, { devices: [identity] });
add("device_image_list", { images: [{ id: "base-1", name: "Ubuntu", format: "qcow2", sizeBytes: 42 }] }, { images: [{ id: "base-1", name: "Ubuntu", format: "qcow2", sizeBytes: 42 }] });
add("device_image_import", { ok: true, image: { id: "base-1", name: "Ubuntu", format: "qcow2", path: "/images/base.qcow2" } }, { ok: true, image: { id: "base-1", name: "Ubuntu", format: "qcow2" } });
add("device_wireless", { action: "status", backend: "android-device", serial: "192.0.2.1:5555", connected: false, available: true }, { action: "status", serial: "192.0.2.1:5555", connected: false });
add("display_current", { id: "x11-current-display", backend: "x11", lifecycle: "current", ownerId: "private-owner", targetStatus: { lifecycle: "current" } }, { id: "x11-current-display", lifecycle: "current" }, ["ownerId", "targetStatus"]);
for (const prefix of ["display", "device"]) {
    action(`${prefix}_click`, { clicked: { x: 12, y: 34, button: "left" } }, "xdotool");
    action(`${prefix}_double_click`, { doubleClicked: { x: 12, y: 34, button: "right" } }, "xdotool");
    action(`${prefix}_key`, { key: "Control+a" }, "xdotool");
    action(`${prefix}_scroll`, { scrolled: { direction: "down", amount: 3 } }, "xdotool");
}
action("display_type", { typed: true, length: 8 }, "xdotool");
add("device_type", { typed: { text: "secret input", keys: "secret input" }, response: { ok: true, type: "type", id: "helper-id", typed: { text: "secret input", keys: "secret input" } }, provider: "windows-helper" }, { typed: true, length: 12 }, ["response"]);
add("display_cursor_position", { x: 12, y: 34, screen: 0, window: 123, raw: "x:12 y:34 screen:0 window:123", provider: "xdotool" }, { x: 12, y: 34, screen: 0, window: 123 }, ["raw"]);
add("device_cursor_position", { cursor: { x: 12, y: 34 }, response: { id: "request", type: "cursor_position", ok: true, cursor: { x: 12, y: 34 } }, provider: "windows-helper" }, { cursor: { x: 12, y: 34 } }, ["response"]);
for (const name of ["device_create", "device_attach", "device_start", "device_stop", "device_status", "device_base_image_create", "device_base_image_clone"]) lifecycle(name);
add("device_detach", { detached: id, physicalDevicePoweredOff: false }, { detached: id, physicalDevicePoweredOff: false });
add("device_delete", { deleted: id, providerDeleted: ["vm-instance"] }, { deleted: id });
lifecycle("device_reboot", { rebooted: true });
lifecycle("device_disk_materialize", { materialized: false, reused: true });
add("device_target_list", { targets: [{ id: "target-1", labId: id, targetKind: "vm", attachable: false, readiness: "stopped" }] }, { targets: [{ id: "target-1", labId: id, attachable: false, readiness: "stopped" }] });
add("device_readiness_probe", { ok: true, device, readiness: { state: "process-running", ready: false, checks: [{ name: "ssh", status: "skipped", reason: "not configured" }] } }, { readiness: { state: "process-running", ready: false, checks: [{ name: "ssh", status: "skipped", reason: "not configured" }] } });
add("device_session_open", { session: { id: "session-1", labId: id, state: "unavailable", attach: { available: false, reason: "guest-ssh-not-configured" } } }, { session: { id: "session-1", state: "unavailable", attach: { available: false, reason: "guest-ssh-not-configured" } } });
for (const name of ["device_workspace_sync", "device_artifacts_export"]) add(name, { ok: true, device, result: { ok: true, destinationPath: "/artifacts/result", files: 3, bytes: 18 } }, { result: { destinationPath: "/artifacts/result", files: 3, bytes: 18 } });
add("device_guest_agent_status", { ok: true, status: { state: "unknown", ready: false, checks: [] } }, { status: { state: "unknown", ready: false } });
add("device_guest_agent_provision", { ok: true, status: { state: "ready", provisioned: true } }, { status: { state: "ready", provisioned: true } });
add("device_exec", { stdout: JSON.stringify(tree), stderr: "", status: 0, result: { provider: "user provider", ownerId: "command data", runtime: { pid: 22 } } }, { stdout: JSON.stringify(tree), stderr: "", status: 0, result: { provider: "user provider", ownerId: "command data", runtime: { pid: 22 } } });
add("device_window_list", { windows: [{ title: "Editor", processId: 10 }], response: { ok: true, windows: [{ title: "Editor", processId: 10 }], id: "helper-id", type: "window_list" }, provider: "windows-helper" }, { windows: [{ title: "Editor", processId: 10 }] }, ["response"]);
add("device_accessibility_snapshot", { accessibility: { root: tree }, response: { ok: true, accessibility: { root: tree } }, stdout: JSON.stringify({ ok: true, accessibility: { root: tree } }), stderr: "", status: 0, provider: "ssh-macos-helper" }, { accessibility: { root: tree } }, ["response", "stdout", "stderr", "status"]);
add("device_snapshot_list", { snapshots: [{ id: "snap-1", name: "baseline", diskSnapshot: false }], activeSnapshot: null }, { snapshots: [{ id: "snap-1", name: "baseline", diskSnapshot: false }] });
lifecycle("device_snapshot_create", { snapshot: { id: "snap-1", name: "baseline" } });
lifecycle("device_snapshot_restore", { snapshot: { id: "snap-1", name: "baseline" } });
add("device_snapshot_delete", { device, deleted: "snap-1", ...success }, { deleted: "snap-1" }, ["stdout", "stderr", "status"]);
add("device_record_video_start", { deviceId: id, recording: { active: true, runtimeId: "record-generation", sessionId: "rec-1", localPath: "/artifacts/movie.mov" } }, { deviceId: id, recording: { active: true, localPath: "/artifacts/movie.mov" } });
add("device_record_video_stop", { stopped: true, recording: { active: false, localPath: "/artifacts/movie.mov" } }, { stopped: true, recording: { active: false, localPath: "/artifacts/movie.mov" } });
add("device_record_video_status", { deviceId: id, recording: null, provider: "adb-screenrecord" }, { deviceId: id, recording: null });
action("device_upload", { uploaded: { localPath: "/project/file.txt", remotePath: "/tmp/file.txt" } });
action("device_download", { downloaded: { remotePath: "/tmp/file.txt", localPath: "/project/file.txt" } });
action("device_reset", { reset: id });
action("device_install_app", { installed: "/project/test.apk" });
action("device_launch_app", { launched: "com.example.app" });
add("mobile_session_status", { deviceId: id, backend: "android-emulator", session: null, automationName: "UiAutomator2", lazy: true }, { deviceId: id, session: null });
add("mobile_dump_ui", { source: '<node text="Unique UI" ownerId="user data"/>', provider: "adb-uiautomator" }, { source: '<node text="Unique UI" ownerId="user data"/>' });
action("mobile_tap", { tapped: { x: 12, y: 34 } });
action("mobile_double_tap", { doubleTapped: { x: 12, y: 34 } });
action("mobile_long_press", { longPressed: { x: 12, y: 34, durationMs: 700 } });
action("mobile_swipe", { swiped: { x1: 12, y1: 34, x2: 56, y2: 78, durationMs: 300 } });
action("mobile_drag", { dragged: { x1: 12, y1: 34, x2: 56, y2: 78, durationMs: 700 } });
action("mobile_type_text", { typed: true });
action("mobile_key", { key: "KEYCODE_ENTER" });
for (const [name, key] of [["home", "home"], ["back", "back"], ["forward", "forward"], ["recents", "recents"], ["power", "power"], ["lock", "locked"], ["unlock", "unlocked"]]) action(`mobile_${name}`, { [key]: true });
action("mobile_set_orientation", { orientation: "portrait", rotation: "0" });
action("mobile_open_url", { openedUrl: "https://example.test/path" });
for (const [name, key] of [["uninstall_app", "uninstalled"], ["stop_app", "stopped"], ["clear_app_data", "cleared"]]) action(`mobile_${name}`, { [key]: "com.example.app" });
action("mobile_grant_permission", { granted: "android.permission.CAMERA", packageName: "com.example.app" });
action("mobile_revoke_permission", { revoked: "android.permission.CAMERA", packageName: "com.example.app" });
action("mobile_set_location", { location: { latitude: 37.5, longitude: 127.0, altitude: 0 } });
add("mobile_set_battery", { battery: { level: 50, status: null, charging: false }, results: [success, success], provider: "adb" }, { battery: { level: 50, charging: false } });
add("mobile_set_network", { network: { wifi: false, data: true }, provider: "adb" }, { network: { wifi: false, data: true } });
action("mobile_toggle_airplane_mode", { airplaneMode: false });
action("mobile_set_clipboard", { clipboard: true });
add("mobile_get_clipboard", { text: "copied text\nwith newline", provider: "appium" }, { text: "copied text\nwith newline" });
add("mobile_wait_for_text", { found: false, text: "not found", timeoutMs: 1000, source: '<node text="other content"/>', provider: "adb-uiautomator" }, { found: false, text: "not found", timeoutMs: 1000 }, ["source"]);
add("mobile_wait_for_app", { found: false, packageName: "com.example.app", timeoutMs: 1000, appState: 1 }, { found: false, packageName: "com.example.app", timeoutMs: 1000, appState: 1 });
for (const name of ["device_run_flow"]) add(name, { results: [{ tool: "device_window_list", ok: true, content: [{ type: "json", value: { windows: [{ title: "Editor" }], response: { ok: true, windows: [{ title: "Editor" }] } } }] }] }, { results: [{ tool: "device_window_list", ok: true, content: [{ type: "json", value: { windows: [{ title: "Editor" }] } }] }] });
const imageTools = ["display_screenshot", "device_screenshot"];
function reply(value: unknown, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError }; }
function project(name: string, value: unknown) { return JSON.parse(compactToolResult(name, reply(value)).content[0].text); }

describe("every internal Device Lab operation has a compact diagnostic projection", () => {
    it("covers exactly the internal operation registry with operation-specific success data", () => {
        expect([...Object.keys(fixtures), ...imageTools].sort()).toEqual(TOOLS.map((tool: { name: string }) => tool.name).sort());
        expect(new Set(TOOLS.map(tool => tool.name)).size).toBe(TOOLS.length);
    });
    it.each(Object.entries(fixtures))("%s preserves semantic success data and removes known transport echoes", (name, fixture) => {
        const original = structuredClone(fixture.input);
        const result = project(name, fixture.input);
        expect(result).toMatchObject(fixture.keep);
        for (const key of fixture.absent || []) expect(result).not.toHaveProperty(key);
        expect(fixture.input).toEqual(original);
    });
    it.each(imageTools)("%s preserves native image and resource content exactly", (name) => {
        const result = { content: [image, { type: "resource", resource: { uri: "file:///image", mimeType: "image/png", blob: image.data } }] };
        expect(compactToolResult(name, result)).toEqual(result);
    });
    it.each(TOOLS.map((tool: { name: string }) => tool.name))("%s preserves actionable failure and partial cleanup evidence", (name) => {
        // Policy/ownership/transport failures share this structured server envelope,
        // unlike the distinct per-tool success payloads above.
        const failed = { ok: false, error: "owner-device-state-conflict", tool: name, deviceId: id,
            incarnationId, detail: `Cannot complete ${name}: current device changed`,
            cleanup: { ok: false, reason: "provider-instance-owned-by-successor", runtimeStopped: false },
            retryable: false, scrubContainmentFailed: true };
        const result = compactToolResult(name, reply(failed, true));
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual(failed);
    });
    it("preserves successful-but-partial VM restore and skipped disk snapshot evidence", () => {
        const restoreRecovery = { phase: "activated", candidateProviderInstance: "pending-cleanup", error: "delete failed" };
        expect(project("device_snapshot_restore", { device: { ...device, restoreRecovery }, snapshot: { id: "snap-1" } })).toMatchObject({ device: { restoreRecovery } });
        expect(project("device_snapshot_create", { ok: true, device, disk: { ok: true, diskSnapshot: false, reason: "qemu-img-unavailable" } })).toMatchObject({ disk: { diskSnapshot: false, reason: "qemu-img-unavailable" } });
    });
    it("preserves unknown stdout and unique helper payloads instead of treating them as echoes", () => {
        expect(project("device_click", { clicked: { x: 1, y: 2 }, provider: "windows-helper", stdout: "Unique provider warning", response: { ok: true, clicked: { x: 1, y: 2 }, warning: "Secure desktop active" } })).toMatchObject({ stdout: "Unique provider warning", response: { warning: "Secure desktop active" } });
    });
    it("reduces a duplicated large UI result to one complete semantic tree", () => {
        const accessibility = { root: { ...tree, children: Array.from({ length: 30 }, (_, index) => ({ ...tree, name: `Node ${index}` })) } };
        const payload = { accessibility, response: { ok: true, accessibility }, stdout: JSON.stringify({ ok: true, accessibility }), provider: "ssh-macos-helper", stderr: "", status: 0 };
        const before = JSON.stringify(payload);
        const result = project("device_accessibility_snapshot", payload);
        expect(result.accessibility).toEqual(accessibility);
        expect(JSON.stringify(result).length).toBeLessThan(before.length / 2);
    });
});


describe("minimal schemas and diagnostic bypass", () => {
    it("hides server configuration controls from all mobile action schemas", () => {
        const mobile = TOOLS.filter((tool: { name: string }) => tool.name.startsWith("mobile_"));
        expect(mobile.length).toBeGreaterThan(30);
        for (const tool of mobile) {
            for (const key of ["appiumPort", "serverPort", "automationName", "provider", "physical"]) {
                expect(tool.inputSchema.properties, `${tool.name}.${key}`).not.toHaveProperty(key);
            }
        }
    });
    it("uses minimal display output by default and retains the complete diagnostic result on request", { timeout: 30000 }, async () => {
        const context = await createDeviceLabMcpTestContext();
        try {
            const detailed = await context.client.callTool({ name: "status", arguments: { deviceId: "x11-current-display", detail: true } });
            const minimal = await context.client.callTool({ name: "status", arguments: { deviceId: "x11-current-display", detail: false } });
            const detailedValue = JSON.parse((detailed.content as Array<{ text: string }>)[0].text);
            const minimalValue = JSON.parse((minimal.content as Array<{ text: string }>)[0].text);
            expect(detailedValue).toHaveProperty("ownerId");
            expect(detailedValue).toHaveProperty("targetStatus");
            expect(minimalValue).not.toHaveProperty("ownerId");
            expect(minimalValue).not.toHaveProperty("targetStatus");
            expect(minimalValue.id).toBe(detailedValue.id);
            expect(detailedValue.capabilities).toContain("screenshot");
            expect(detailedValue.capabilities).not.toContain("device_screenshot");
            const files = await context.client.callTool({ name: "list_files", arguments: { deviceId: "x11-current-display", path: "/work", implicitBroker: false } });
            expect(files.isError).toBe(true);
            expect(JSON.parse((files.content as Array<{ text: string }>)[0].text)).toMatchObject({
                error: "list-files-unsupported",
                detail: "Current-display targets do not provide a filesystem adapter.",
            });
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });
});


describe("projection boundaries for provider-specific success envelopes", () => {
    it("removes exact Linux lab aliases but keeps distinct lab data", () => {
        const lab = { id, name: "Linux VM", provider: "linux-qemu", runtimeState: "stopped" };
        const vm = { ...lab, deviceId: id, backend: "linux-vm", capabilities: ["device_status"] };
        const compact = project("device_status", { ok: true, lab, device: vm });
        expect(compact.device).toMatchObject({ id, backend: "linux-vm" });
        expect(compact).not.toHaveProperty("lab");
        expect(project("device_status", { ok: true, lab: { ...lab, note: "unique lab metadata" }, device: vm })).toHaveProperty("lab.note", "unique lab metadata");
    });
    it("retains battery subcommand failures and successful stderr warnings", () => {
        const results = [{ status: 0, stdout: "", stderr: "battery override is temporary" }, { status: 5, stdout: "", stderr: "battery level rejected" }];
        expect(project("mobile_set_battery", { battery: { level: 50 }, results, provider: "adb" })).toMatchObject({ results: [{ stderr: "battery override is temporary" }, { status: 5, stderr: "battery level rejected" }] });
    });
    it("leaves arbitrary response metadata and execution-like user payloads untouched", () => {
        const response = { id: "user-id", type: "user-type", ok: true, provider: "user-provider", runtime: { pid: 12 }, source: "document" };
        expect(project("device_wireless", { action: "status", response })).toEqual({ action: "status", response });
        expect(project("mobile_dump_ui", { source: "<node/>", response })).toEqual({ source: "<node/>", response });
    });
});


describe("status-only provider planning diagnostics", () => {
    const plan = { providerInstance: "vm-instance", workspaceDir: "/private/workspace", implemented: ["start"], startCommand: { command: "tart", args: ["run", "vm-instance"] }, helper: { status: "ready", hostScriptPath: "/private/helper" }, available: true };
    it.each(["device_status", "device_list"])("%s removes generated execution plans while preserving identity", (name) => {
        const vm = { ...device, providerInstance: "vm-instance", providerPlan: plan };
        const result = project(name, name === "device_status" ? { device: vm } : { devices: [vm] });
        const current = name === "device_status" ? result.device : result.devices[0];
        expect(current.id).toBe(id);
        expect(current.providerPlan).not.toHaveProperty("startCommand");
        expect(current.providerPlan).not.toHaveProperty("workspaceDir");
        expect(current.providerPlan).not.toHaveProperty("implemented");
        expect(current.providerPlan.available).toBe(true);
    });
    it("keeps create and dry-run command plans available for review", () => {
        for (const name of ["device_create", "device_start"]) {
            const result = project(name, { device: { ...device, providerPlan: plan }, dryRun: true });
            expect(result.device.providerPlan.startCommand).toEqual(plan.startCommand);
        }
    });
    it("mobile session status removes successful server wiring without inventing a session", () => {
        const result = project("mobile_session_status", { deviceId: id, session: null, lazy: true, appium: { available: true, xcrun: "/bin/xcrun", appium: "/bin/appium", adb: "/bin/adb", missing: [] } });
        expect(result).toMatchObject({ deviceId: id, session: null, appium: { available: true } });
        expect(result).not.toHaveProperty("lazy");
        expect(result.appium).not.toHaveProperty("xcrun");
        expect(result.appium).not.toHaveProperty("appium");
        expect(result.appium).not.toHaveProperty("adb");
    });
});
