import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Matches Dockerfile ENV and scripts/ccc-x11-bridge (Xvfb :99).
const DISPLAY = ":99";

function run(cmd, args) {
    return spawnSync(cmd, args, {
        encoding: "utf-8",
        env: { ...process.env, DISPLAY },
    });
}

function sh(script) {
    return run("sh", ["-c", script]);
}

const TOOLS = [
    {
        name: "screenshot",
        description: "Take a screenshot of the virtual display (Xvfb) inside the CCC container",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "left_click",
        description: "Left-click at the given coordinates on the virtual display",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "right_click",
        description: "Right-click at the given coordinates on the virtual display",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "double_click",
        description: "Double-click at the given coordinates on the virtual display",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "type",
        description: "Type text using xdotool on the virtual display",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Text to type" },
            },
            required: ["text"],
        },
    },
    {
        name: "key",
        description: "Send a key or key combination using xdotool (e.g. Return, ctrl+c, alt+F4)",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "Key name or combination (xdotool syntax)" },
            },
            required: ["key"],
        },
    },
    {
        name: "scroll",
        description: "Scroll at the given coordinates on the virtual display",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
                direction: {
                    type: "string",
                    enum: ["up", "down", "left", "right"],
                    description: "Scroll direction",
                },
                amount: { type: "number", description: "Number of scroll clicks (default 3)" },
            },
            required: ["x", "y", "direction"],
        },
    },
    {
        name: "cursor_position",
        description: "Get the current mouse cursor position on the virtual display",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
];

const server = new Server(
    { name: "x11-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(ok, text) {
    return { content: [{ type: "text", text }], isError: !ok };
}

function fail(result) {
    return textResult(false, `Error: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "screenshot": {
                const ssPath = join(tmpdir(), `x11_ss_${Date.now()}.png`);
                const r = run("scrot", ["-p", "-o", ssPath]);
                if (r.status !== 0) return fail(r);
                const base64 = readFileSync(ssPath).toString("base64");
                try { unlinkSync(ssPath); } catch { /* ignore */ }
                return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
            }

            case "left_click": {
                const { x, y } = args;
                const r = run("xdotool", ["mousemove", String(x), String(y), "click", "1"]);
                return r.status === 0 ? textResult(true, `Left-clicked at (${x}, ${y})`) : fail(r);
            }

            case "right_click": {
                const { x, y } = args;
                const r = run("xdotool", ["mousemove", String(x), String(y), "click", "3"]);
                return r.status === 0 ? textResult(true, `Right-clicked at (${x}, ${y})`) : fail(r);
            }

            case "double_click": {
                const { x, y } = args;
                const r = run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", "2", "1"]);
                return r.status === 0 ? textResult(true, `Double-clicked at (${x}, ${y})`) : fail(r);
            }

            case "type": {
                const { text } = args;
                const r = run("xdotool", ["type", "--clearmodifiers", "--", text]);
                return r.status === 0 ? textResult(true, "Typed text successfully") : fail(r);
            }

            case "key": {
                const { key } = args;
                const r = run("xdotool", ["key", "--", key]);
                return r.status === 0 ? textResult(true, `Sent key: ${key}`) : fail(r);
            }

            case "scroll": {
                const { x, y, direction, amount = 3 } = args;
                const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
                const button = buttonMap[direction];
                if (!button) return textResult(false, `Unknown scroll direction: ${direction}`);
                const r = run("xdotool", [
                    "mousemove", String(x), String(y),
                    "click", "--repeat", String(amount), String(button),
                ]);
                return r.status === 0
                    ? textResult(true, `Scrolled ${direction} ${amount}x at (${x}, ${y})`)
                    : fail(r);
            }

            case "cursor_position": {
                const r = run("xdotool", ["getmouselocation"]);
                return r.status === 0 ? textResult(true, r.stdout.trim()) : fail(r);
            }

            default:
                return textResult(false, `Unknown tool: ${name}`);
        }
    } catch (err) {
        return textResult(false, `Unexpected error: ${err.message}`);
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
