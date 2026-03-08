import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "child_process";

// Resolve Chromium path: container symlink → Playwright cache → env var
export function resolveChromiumPath(): string {
    // 1. Container: /usr/bin/chromium (symlink to Playwright binary)
    try {
        execSync("test -f /usr/bin/chromium", { stdio: "ignore" });
        return "/usr/bin/chromium";
    } catch { /* not in container */ }

    // 2. GHA: Playwright cache
    try {
        const result = execSync(
            "find $HOME/.cache/ms-playwright -name 'chrome' -type f 2>/dev/null | head -1",
            { encoding: "utf-8" },
        ).trim();
        if (result) return result;
    } catch { /* no playwright cache */ }

    // 3. System chromium
    for (const path of ["/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
        try {
            execSync(`test -f ${path}`, { stdio: "ignore" });
            return path;
        } catch { /* skip */ }
    }

    throw new Error("Chromium not found. Run: npx playwright install chromium");
}

export interface McpClientHandle {
    client: Client;
    cleanup: () => Promise<void>;
}

export async function createMcpClient(): Promise<McpClientHandle> {
    const chromiumPath = resolveChromiumPath();

    const transport = new StdioClientTransport({
        command: "npx",
        args: [
            "-y", "chrome-devtools-mcp",
            "--headless",
            "--isolated",
            `--executablePath=${chromiumPath}`,
            "--chromeArg=--no-sandbox",
            "--chromeArg=--disable-setuid-sandbox",
            "--chromeArg=--disable-dev-shm-usage",
        ],
    });

    const client = new Client(
        { name: "ccc-test-client", version: "1.0.0" },
        { capabilities: {} },
    );

    await client.connect(transport);

    const cleanup = async (): Promise<void> => {
        try {
            await client.close();
        } catch { /* ignore */ }

        // Kill any remaining chromium processes spawned by the test
        try {
            execSync("pkill -f 'chrome-devtools-mcp' 2>/dev/null || true", { stdio: "ignore" });
            execSync("pkill -f chromium 2>/dev/null || true", { stdio: "ignore" });
        } catch { /* ignore */ }
    };

    return { client, cleanup };
}
