import assert from "assert";
import { commandPath } from "./helpers.mjs";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.mjs";
import { aggregateStepResult } from "./result-status.mjs";

export const name = "level 1 current display MCP E2E";
const scriptedArgumentFacets = [
    "device_click:button=left",
    "device_click:button=right",
    "device_double_click:button=left",
    "device_double_click:button=right",
    "device_scroll:direction=down",
    "device_scroll:direction=left",
    "device_scroll:direction=right",
    "device_scroll:direction=up",
    "display_click:button=left",
    "display_click:button=right",
    "display_double_click:button=left",
    "display_double_click:button=right",
    "display_scroll:direction=down",
    "display_scroll:direction=left",
    "display_scroll:direction=right",
    "display_scroll:direction=up",
];

function imageData(contentItem) {
    assert.strictEqual(contentItem?.type, "image");
    assert.strictEqual(contentItem.mimeType, "image/png");
    const data = String(contentItem.data || "");
    assert.ok(data.startsWith("iVBORw0KGgo"), "screenshot is not a PNG image payload");
    assert.ok(data.length > 64, "screenshot image payload is unexpectedly small");
    return data;
}

function cursorPoint(result) {
    const payload = parseToolPayload(result);
    assert.strictEqual(typeof payload.x, "number", JSON.stringify(payload));
    assert.strictEqual(typeof payload.y, "number", JSON.stringify(payload));
    return { x: payload.x, y: payload.y };
}

async function assertCursorAt(callTool, expected, label) {
    const cursor = await callTool("display_cursor_position");
    assert.notStrictEqual(cursor?.isError, true, `${label}: ${cursor?.content?.[0]?.text || ""}`);
    assert.deepStrictEqual(cursorPoint(cursor), expected, label);
}

export function currentDisplayPrerequisiteResult(missing) {
    const steps = [{ name: "current display prerequisites", status: "SKIP", reason: `missing ${missing.join(", ")}` }];
    return { ...aggregateStepResult(steps), steps };
}

export async function run() {
    const missing = ["xdotool", "scrot"].filter((command) => !commandPath(command));
    if (missing.length > 0) return currentDisplayPrerequisiteResult(missing);

    const steps = [];
    await withDeviceLabMcp(async ({ callTool }) => {
        const current = parseToolPayload(await callTool("display_current"));
        if (current.available !== true) {
            steps.push({ name: "current display available", status: "SKIP", reason: `display target is unavailable: ${current.display || "<unset>"}` });
            return;
        }
        steps.push({ name: "current display available", status: "PASS", detail: `display=${current.display}` });

        const listed = parseToolPayload(await callTool("device_list"));
        assert.ok(Array.isArray(listed.devices), JSON.stringify(listed));
        assert.ok(listed.devices.some((device) => device.id === "x11-current-display" && device.available === true), JSON.stringify(listed.devices));
        steps.push({ name: "device_list includes current display", status: "PASS" });

        const displayDevice = { backend: "x11-current-display", deviceId: "x11-current-display" };
        const status = parseToolPayload(await callTool("device_status", displayDevice));
        assert.strictEqual(status.id, "x11-current-display", JSON.stringify(status));
        assert.strictEqual(status.kind, "display", JSON.stringify(status));
        assert.strictEqual(status.available, true, JSON.stringify(status));
        steps.push({ name: "device_status current display alias", status: "PASS" });

        const cursor = await callTool("display_cursor_position");
        if (cursor?.isError === true) {
            steps.push({ name: "display command execution", status: "SKIP", reason: cursor.content?.[0]?.text || "display command failed" });
            return;
        }
        cursorPoint(cursor);
        steps.push({ name: "cursor position", status: "PASS" });

        const screenshot = await callTool("display_screenshot");
        imageData(screenshot?.content?.[0]);
        steps.push({ name: "display screenshot", status: "PASS" });

        const deviceScreenshot = await callTool("device_screenshot", displayDevice);
        imageData(deviceScreenshot?.content?.[0]);
        steps.push({ name: "device_screenshot current display alias", status: "PASS" });

        for (const button of ["left", "right"]) {
            const click = await callTool("display_click", { x: 1, y: 1, button });
            assert.notStrictEqual(click?.isError, true, `display_click ${button}: ${click?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(click).clicked, { x: 1, y: 1, button });
            await assertCursorAt(callTool, { x: 1, y: 1 }, `display_click ${button} cursor`);
        }
        steps.push({ name: "display_click buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const deviceClick = await callTool("device_click", { ...displayDevice, x: 1, y: 1, button });
            assert.notStrictEqual(deviceClick?.isError, true, `device_click ${button}: ${deviceClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceClick).clicked, { x: 1, y: 1, button });
            await assertCursorAt(callTool, { x: 1, y: 1 }, `device_click ${button} cursor`);
        }
        steps.push({ name: "device_click current display alias buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const doubleClick = await callTool("display_double_click", { x: 1, y: 1, button });
            assert.notStrictEqual(doubleClick?.isError, true, `display_double_click ${button}: ${doubleClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(doubleClick).doubleClicked, { x: 1, y: 1, button });
        }
        steps.push({ name: "display_double_click buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const deviceDoubleClick = await callTool("device_double_click", { ...displayDevice, x: 1, y: 1, button });
            assert.notStrictEqual(deviceDoubleClick?.isError, true, `device_double_click ${button}: ${deviceDoubleClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceDoubleClick).doubleClicked, { x: 1, y: 1, button });
        }
        steps.push({ name: "device_double_click current display alias buttons", status: "PASS" });

        const key = await callTool("display_key", { key: "Escape" });
        assert.notStrictEqual(key?.isError, true, `display_key: ${key?.content?.[0]?.text || ""}`);
        assert.strictEqual(parseToolPayload(key).key, "Escape");
        steps.push({ name: "display_key", status: "PASS" });

        const deviceKey = await callTool("device_key", { ...displayDevice, key: "Escape" });
        assert.notStrictEqual(deviceKey?.isError, true, `device_key: ${deviceKey?.content?.[0]?.text || ""}`);
        assert.strictEqual(parseToolPayload(deviceKey).key, "Escape");
        steps.push({ name: "device_key current display alias", status: "PASS" });

        const type = await callTool("display_type", { text: "ccc-display-e2e" });
        assert.notStrictEqual(type?.isError, true, `display_type: ${type?.content?.[0]?.text || ""}`);
        assert.deepStrictEqual({ typed: parseToolPayload(type).typed, length: parseToolPayload(type).length }, { typed: true, length: "ccc-display-e2e".length });
        steps.push({ name: "display_type", status: "PASS" });

        const deviceType = await callTool("device_type", { ...displayDevice, text: "ccc-display-e2e" });
        assert.notStrictEqual(deviceType?.isError, true, `device_type: ${deviceType?.content?.[0]?.text || ""}`);
        assert.deepStrictEqual({ typed: parseToolPayload(deviceType).typed, length: parseToolPayload(deviceType).length }, { typed: true, length: "ccc-display-e2e".length });
        steps.push({ name: "device_type current display alias", status: "PASS" });

        for (const direction of ["up", "down", "left", "right"]) {
            const scroll = await callTool("display_scroll", { x: 1, y: 1, direction, amount: 1 });
            assert.notStrictEqual(scroll?.isError, true, `display_scroll ${direction}: ${scroll?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(scroll).scrolled, { x: 1, y: 1, direction, amount: 1 });
        }
        steps.push({ name: "display_scroll directions", status: "PASS" });

        for (const direction of ["up", "down", "left", "right"]) {
            const deviceScroll = await callTool("device_scroll", { ...displayDevice, x: 1, y: 1, direction, amount: 1 });
            assert.notStrictEqual(deviceScroll?.isError, true, `device_scroll ${direction}: ${deviceScroll?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceScroll).scrolled, { x: 1, y: 1, direction, amount: 1 });
        }
        steps.push({ name: "device_scroll current display alias directions", status: "PASS" });

        const deviceCursor = await callTool("device_cursor_position", displayDevice);
        assert.notStrictEqual(deviceCursor?.isError, true, `device_cursor_position: ${deviceCursor?.content?.[0]?.text || ""}`);
        cursorPoint(deviceCursor);
        steps.push({ name: "device_cursor_position current display alias", status: "PASS" });

        const flow = parseToolPayload(await callTool("device_run_flow", {
            steps: [
                { tool: "display_current", arguments: {} },
                { tool: "display_cursor_position", arguments: {} },
                { tool: "device_status", arguments: displayDevice },
                { tool: "device_cursor_position", arguments: displayDevice },
            ],
        }));
        assert.strictEqual(flow.ok, true);
        assert.strictEqual(flow.results.length, 4);
        assert.strictEqual(flow.results[0].tool, "display_current");
        assert.strictEqual(flow.results[0].isError, false);
        assert.strictEqual(flow.results[0].content?.[0]?.value?.id, "x11-current-display");
        assert.strictEqual(flow.results[0].content?.[0]?.value?.available, true);
        assert.strictEqual(flow.results[1].tool, "display_cursor_position");
        assert.strictEqual(flow.results[1].isError, false);
        assert.strictEqual(typeof flow.results[1].content?.[0]?.value?.x, "number");
        assert.strictEqual(typeof flow.results[1].content?.[0]?.value?.y, "number");
        assert.strictEqual(flow.results[2].tool, "device_status");
        assert.strictEqual(flow.results[2].isError, false);
        assert.strictEqual(flow.results[2].content?.[0]?.value?.id, "x11-current-display");
        assert.strictEqual(flow.results[3].tool, "device_cursor_position");
        assert.strictEqual(flow.results[3].isError, false);
        steps.push({ name: "device_run_flow", status: "PASS" });
    }, { name: "ccc-real-display-e2e" });

    return { ...aggregateStepResult(steps), steps, scriptedArgumentFacets };
}
