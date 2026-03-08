import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type McpClientHandle, createMcpClient, resolveChromiumPath } from "./helpers/mcp-stdio-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Integration tests for chrome-devtools MCP server.
// Gracefully skipped when Chromium is not available (e.g. pure unit test CI).
const TIMEOUT = 90000;

const chromiumAvailable = (() => {
    try { resolveChromiumPath(); return true; } catch { return false; }
})();

describe.skipIf(!chromiumAvailable)("chrome-devtools MCP integration", () => {
    let handle: McpClientHandle;
    let client: Client;

    beforeAll(async () => {
        handle = await createMcpClient();
        client = handle.client;
    }, TIMEOUT);

    afterAll(async () => {
        await handle?.cleanup();
    }, TIMEOUT);

    it("connects and returns server info", { timeout: TIMEOUT }, async () => {
        const serverVersion = client.getServerVersion();
        expect(serverVersion).toBeDefined();
        expect(serverVersion?.name).toBeTruthy();
    });

    it("lists tools including navigate_page and take_screenshot", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const toolNames = result.tools.map((t) => t.name);
        expect(toolNames).toContain("navigate_page");
        expect(toolNames).toContain("take_screenshot");
    });

    it("creates a new page", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "new_page",
            arguments: { url: "about:blank" },
        });
        expect(result.content).toBeDefined();
        expect((result.content as Array<{ type: string; text?: string }>)[0].text).toBeTruthy();
    });

    it("navigates to a data URI page", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "navigate_page",
            arguments: { url: "data:text/html,<h1>ccc-test</h1>", type: "url" },
        });
        expect(result.isError).not.toBe(true);
    });

    it("evaluates a script and returns the result", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "evaluate_script",
            arguments: { function: "() => 6 * 7" },
        });
        const content = result.content as Array<{ type: string; text?: string }>;
        expect(content[0].text).toContain("42");
    });

    it("takes a screenshot and returns an image", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "take_screenshot",
            arguments: {},
        });
        const content = result.content as Array<{ type: string; mimeType?: string }>;
        // content[0] is always text summary, content[1] is the image
        expect(content[1]).toBeDefined();
        expect(content[1].type).toBe("image");
    });
});
