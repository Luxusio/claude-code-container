import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleLabTool } from "./provider.mjs";
import { jsonResult } from "./responses.mjs";
import { TOOLS } from "./tools.mjs";

export async function startServer() {
    const server = new Server({ name: "ccc-lab-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments || {};
        return jsonResult(handleLabTool(name, args));
    });

    await server.connect(new StdioServerTransport());
}
