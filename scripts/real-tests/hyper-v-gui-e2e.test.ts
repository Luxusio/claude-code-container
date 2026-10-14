import { Ajv } from "ajv";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { describe, expect, it, vi } from "vitest";
import { proveHyperVLinuxGuiKeyboardFile, focusHyperVGuiWindow, proveHyperVGuiDrag, runHyperVGuiE2E } from "./hyper-v-gui-e2e.ts";

function reply(result: Record<string, unknown> = {}) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }] };
}

describe("Hyper-V Linux GUI keyboard proof", () => {
    it("uses the launcher after a shortcut opens no focused terminal", async () => {
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        let launcherOpened = false;
        const callTool = async (tool: string, args: Record<string, unknown>) => {
            expect(toolInputError(tool, args), `${tool} public input`).toBeNull();
        calls.push({ tool, args });
            if (tool === "key" && args.key === "Alt+F2") launcherOpened = true;
            if (tool === "exec" && String(args.command).includes("ccc-terminal-focused")) return reply({ stdout: "ccc-terminal-focused" });
            if (tool === "exec") return reply({ stdout: launcherOpened ? "abc123" : "" });
            return reply();
        };
        await proveHyperVLinuxGuiKeyboardFile(callTool, { deviceId: "owned-vm" }, "abc123", async () => {});
        expect(calls.filter((call) => call.tool === "type").map((call) => call.args.text)).toEqual([
            "touch /tmp/cccguiabc123",
            "xfce4-terminal",
            "touch /tmp/cccguiabc123",
        ]);
        expect(calls.filter((call) => call.tool === "exec" && String(call.args.command).startsWith("test -f"))
            .every((call) => call.args.command === "test -f /tmp/cccguiabc123 && printf abc123")).toBe(true);
        expect(calls.filter((call) => call.tool === "exec" && String(call.args.command).includes("ccc-terminal-focused"))).toHaveLength(2);
        expect(calls.filter((call) => call.tool === "click").map((call) => [call.args.x, call.args.y]))
            .toEqual([[100, 100], [100, 100]]);
    });

    it("does not accept a terminal process or screen change without the guest file", async () => {
        const callTool = async (tool: string, args: Record<string, unknown>) =>
            tool === "exec" ? reply({ stdout: String(args.command).includes("ccc-terminal-focused") ? "ccc-terminal-focused" : "" }) : reply();
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-keyboard-guest-file-missing");
    });

    it("does not type the file command when the desktop has no focused terminal", async () => {
        const typed: string[] = [];
        const callTool = async (tool: string, args: Record<string, unknown>) => {
            if (tool === "type") typed.push(String(args.text));
            return tool === "exec" ? reply({ stdout: "" }) : reply();
        };
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-linux-terminal-not-focused");
        expect(typed).toEqual(["xfce4-terminal"]);
    });

    it("reports a missing X11 input tool as a bounded focus stage", async () => {
        const callTool = async (tool: string) =>
            tool === "exec" ? reply({ stdout: "ccc-focus-tool-missing" }) : reply();
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-linux-terminal-not-focused[stage=tool-missing]");
    });
});

// Keep the actual journey and MCP payload parser; only remove wall-clock waits
// and decode synthetic frames into realistic 640x480 RGB viewport buffers.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
vi.mock("./hyper-v-console-host.ts", () => ({
    unfilteredHyperVConsolePixels: (png: Buffer) => Buffer.alloc(640 * 480 * 3, png[png.length - 1]),
}));

const direct = { deviceId: "windows-vm-13579bdf-2468-4ace-8bdf-13579bdf2468" };
const windowReply = (windows: unknown) => reply({ windows });

function journey(guest: "windows" | "linux", override?: (tool: string, args: Record<string, unknown>) => any) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let nonce = "";
    let cursor = { x: 0, y: 0 };
    let frame = 0;
    const callTool = async (tool: string, args: Record<string, unknown>) => {
        expect(toolInputError(tool, args), `${tool} public input`).toBeNull();
        calls.push({ tool, args });
        const replaced = override?.(tool, args);
        if (replaced !== undefined) return replaced;
        if (tool === "type") {
            nonce = String(args.text).match(/ccc-gui-([a-f0-9]+)|cccgui([a-f0-9]+)/)?.slice(1).find(Boolean) || nonce;
        }
        if (tool === "exec") {
            const command = String(args.command);
            return reply({ stdout: command.includes("ccc-terminal-focused") ? "ccc-terminal-focused"
                : command.includes("xdotool search") ? "1234" : nonce });
        }
        if (tool === "window_list") return windowReply([
            { title: "Unrelated window", handle: "111", processId: 40 },
            { title: guest === "windows" ? `ccc-gui-${nonce}.txt – Editor localized` : "Localized shell title", handle: "1234", processId: 42 },
        ]);
        if (tool === "focus_window") return reply({ ok: true });
        if (tool === "move") cursor = { x: Number(args.x), y: Number(args.y) };
        if (tool === "drag") { cursor = { x: Number(args.x2), y: Number(args.y2) }; return reply({ applied: true }); }
        if (tool === "cursor_position") return reply(cursor);
        if (tool === "click" && args.x === 640) return { isError: true, content: [{ type: "text", text: "hyper-v-console-pixel-invalid" }] };
        if (tool === "screenshot") return {
            content: [
                { type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, frame++]).toString("base64") },
                { type: "text", text: JSON.stringify({ width: 640, height: 480, deviceId: args.deviceId }) },
            ],
        };
        return reply({ applied: true });
    };
    return { calls, callTool };
}

describe.each(["windows", "linux"] as const)("Hyper-V %s public GUI journey", (guest) => {
    it("exercises real window focus and distinct-point drag before the scroll proof with the owned identity", async () => {
        const { calls, callTool } = journey(guest);
        const result = await runHyperVGuiE2E(callTool, direct, guest);
        expect(result.visibleChange).toBe(true);
        expect(result.tools).toEqual(expect.arrayContaining(["window_list", "focus_window", "drag"]));
        expect(calls.filter(({ tool }) => tool === "focus_window").map(({ args }) => args.handle)).toEqual(["1234"]);
        expect(calls.every(({ args }) => args.deviceId === direct.deviceId && !("incarnationId" in args))).toBe(true);
        const focusIndex = calls.findIndex(({ tool }) => tool === "focus_window");
        const dragIndex = calls.findIndex(({ tool }) => tool === "drag");
        const scrollIndex = calls.findIndex(({ tool }) => tool === "scroll");
        expect(focusIndex).toBeLessThan(dragIndex);
        expect(calls[dragIndex].args).toMatchObject({ x1: 280, y1: 200, x2: 320, y2: 240 });
        expect(calls.slice(dragIndex + 1, scrollIndex).map(({ tool }) => tool)).toEqual(["cursor_position", "move", "cursor_position", "click", "click", "screenshot"]);
        if (guest === "windows") {
            expect(calls.find(({ tool, args }) => tool === "type" && String(args.text).startsWith("notepad"))?.args.text)
                .toMatch(/^notepad "C:\\Users\\Public\\Documents\\ccc-gui-[a-f0-9]+\.txt"$/);
            expect(focusIndex).toBeLessThan(calls.findIndex(({ args }) => args.key === "Win+Up"));
        } else {
            expect(calls.some(({ tool, args }) => tool === "exec" && String(args.command).startsWith("timeout 4s") && args.timeoutMs === 5000)).toBe(true);
        }
    });

    it("rejects a screenshot from a different VM before applying further GUI input", async () => {
        const { calls, callTool } = journey(guest, (tool) => tool === "screenshot" ? {
            content: [
                { type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64") },
                { type: "text", text: JSON.stringify({ width: 640, height: 480, deviceId: "windows-vm-other-instance" }) },
            ],
        } : undefined);
        await expect(runHyperVGuiE2E(callTool, direct, guest)).rejects.toThrow("hyper-v-gui-screenshot-device-invalid");
        expect(calls.at(-1)?.tool).toBe("screenshot");
        expect(calls.some(call => call.tool === "drag" || call.tool === "scroll")).toBe(false);
    });

    it("rejects an acknowledged drag that never moves the cursor", async () => {
        const { callTool } = journey(guest, (tool) => tool === "drag" ? reply({ applied: true }) : undefined);
        await expect(runHyperVGuiE2E(callTool, direct, guest)).rejects.toThrow("hyper-v-gui-drag-cursor-position-failed");
    });

    it.each(["window_list", "focus_window", "drag"])("propagates %s errors through the full journey", async (failedTool) => {
        const record = { expectedError: false };
        const failure = { isError: true, __cccToolCallRecord: record, content: [{ type: "text", text: JSON.stringify({ error: "provider-failure" }) }] };
        const { callTool } = journey(guest, (tool) => tool === failedTool ? failure : undefined);
        await expect(runHyperVGuiE2E(callTool, direct, guest)).rejects.toThrow();
        expect(record.expectedError).toBe(false);
    });
});

describe("public GUI evidence validation", () => {
    it.each([{ windows: [] }, { windows: [{ title: "Other document", handle: "123" }] }])("bounds absent target lookup", async ({ windows }) => {
        let lists = 0;
        const callTool = async () => { lists++; return windowReply(windows); };
        await expect(focusHyperVGuiWindow(callTool, direct, "windows", "abc", async () => {})).rejects.toThrow("hyper-v-gui-window-target-missing");
        expect(lists).toBe(6);
    });
    it.each([undefined, {}, [null], [{ title: "ccc-gui-abc", handle: "NaN" }]].map(windows => ({ windows })))("rejects malformed window results", async ({ windows }) => {
        await expect(focusHyperVGuiWindow(async () => windowReply(windows), direct, "windows", "abc", async () => {})).rejects.toThrow("hyper-v-gui-window-list-invalid");
    });
    it("requires the queried Linux handle in the public listing", async () => {
        const callTool = async (tool: string) => tool === "exec" ? reply({ stdout: "1234" })
            : windowReply([{ handle: "5678", title: "xfce4-terminal", processName: "xfce4-terminal" }]);
        await expect(focusHyperVGuiWindow(callTool, direct, "linux", "abc", async () => {})).rejects.toThrow("hyper-v-gui-window-target-missing");
    });
    it.each([{}, { ok: false }])("requires an explicit successful focus acknowledgement", async (focus) => {
        const callTool = async (tool: string) => tool === "window_list" ? windowReply([{ title: "ccc-gui-abc.txt", handle: "1234" }]) : reply(focus);
        await expect(focusHyperVGuiWindow(callTool, direct, "windows", "abc")).rejects.toThrow("hyper-v-gui-focus-window-failed");
    });
    it.each([{}, { applied: false }])("requires drag application acknowledgement", async (drag) => {
        await expect(proveHyperVGuiDrag(async () => reply(drag), direct)).rejects.toThrow("hyper-v-gui-drag-failed");
    });
    it.each([{ x: 280, y: 200 }, { x: 323, y: 240 }, {}])("rejects a wrong or absent drag endpoint", async (cursor) => {
        await expect(proveHyperVGuiDrag(async (tool) => reply(tool === "drag" ? { applied: true } : cursor), direct)).rejects.toThrow("hyper-v-gui-drag-cursor-position-failed");
    });
    it("accepts the two-pixel cursor tolerance", async () => {
        await expect(proveHyperVGuiDrag(async (tool) => reply(tool === "drag" ? { applied: true } : { x: 318, y: 242 }), direct)).resolves.toBeUndefined();
    });
});


describe("window_list public device selector schema", () => {
    const schema = TOOLS.find(tool => tool.name === "window_list")!.inputSchema;
    const validate = new Ajv({ strict: false }).compile(schema);
    it("accepts deviceId alone and rejects the removed public generation input", () => {
        expect(toolInputError("window_list", direct)).toBeNull();
        expect(validate(direct)).toBe(true);
        expect(validate({ deviceId: direct.deviceId })).toBe(true);
        for (const incarnationId of ["a".repeat(32), "incarnation-123", "", "a".repeat(33), 42, null]) {
            expect(validate({ ...direct, incarnationId }), String(incarnationId)).toBe(false);
        }
    });
});
