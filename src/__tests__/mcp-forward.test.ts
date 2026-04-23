import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});

vi.mock("os", async () => {
    const actual = await vi.importActual<typeof import("os")>("os");
    return {
        ...actual,
        homedir: vi.fn(() => "/home/testuser"),
    };
});

describe("readHostMcpServers", () => {
    let fsMock: typeof import("fs");
    let existsSync: ReturnType<typeof vi.fn>;
    let readFileSync: ReturnType<typeof vi.fn>;
    let readHostMcpServers: () => Record<string, unknown>;

    beforeEach(async () => {
        vi.resetModules();
        fsMock = await import("fs");
        existsSync = fsMock.existsSync as ReturnType<typeof vi.fn>;
        readFileSync = fsMock.readFileSync as ReturnType<typeof vi.fn>;
        vi.clearAllMocks();
        const mod = await import("../mcp-forward.js");
        readHostMcpServers = mod.readHostMcpServers;
    });

    it("returns empty object when host ~/.claude.json does not exist", () => {
        existsSync.mockReturnValue(false);
        const result = readHostMcpServers();
        expect(result).toEqual({});
    });

    it("returns MCP servers from valid host ~/.claude.json", () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue(
            JSON.stringify({
                mcpServers: {
                    "my-tool": { command: "mytool", args: ["--flag"] },
                    "another": { url: "http://example.com/sse" },
                },
            })
        );
        const result = readHostMcpServers();
        expect(result).toEqual({
            "my-tool": { command: "mytool", args: ["--flag"] },
            "another": { url: "http://example.com/sse" },
        });
    });

    it("returns empty object when host ~/.claude.json has malformed JSON", () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue("not valid json {{{{");
        const result = readHostMcpServers();
        expect(result).toEqual({});
    });
});

describe("rewriteLocalhostUrl", () => {
    let rewriteLocalhostUrl: (url: string) => string;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import("../mcp-forward.js");
        rewriteLocalhostUrl = mod.rewriteLocalhostUrl;
    });

    it("rewrites http://localhost:3000 to http://host.docker.internal:3000", () => {
        expect(rewriteLocalhostUrl("http://localhost:3000")).toBe(
            "http://host.docker.internal:3000"
        );
    });

    it("rewrites http://127.0.0.1:3000 to http://host.docker.internal:3000", () => {
        expect(rewriteLocalhostUrl("http://127.0.0.1:3000")).toBe(
            "http://host.docker.internal:3000"
        );
    });

    it("does not rewrite non-localhost URLs", () => {
        const url = "http://example.com:3000/path";
        expect(rewriteLocalhostUrl(url)).toBe(url);
    });

    it("rewrites localhost with path separator", () => {
        expect(rewriteLocalhostUrl("http://localhost/api")).toBe(
            "http://host.docker.internal/api"
        );
    });
});

describe("processServerForContainer", () => {
    let processServerForContainer: (name: string, server: Record<string, unknown>) => Record<string, unknown>;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import("../mcp-forward.js");
        processServerForContainer = mod.processServerForContainer as typeof processServerForContainer;
    });

    it("forwards stdio server as-is", () => {
        const server = { command: "mytool", args: ["--flag"] };
        const result = processServerForContainer("my-tool", server);
        expect(result).toEqual({ command: "mytool", args: ["--flag"] });
    });

    it("rewrites localhost URL for HTTP server", () => {
        const server = { url: "http://localhost:4000/sse" };
        const result = processServerForContainer("my-sse", server);
        expect(result).toEqual({ url: "http://host.docker.internal:4000/sse" });
    });

    it("leaves non-localhost URL unchanged for HTTP server", () => {
        const server = { url: "http://remote.example.com:4000/sse" };
        const result = processServerForContainer("remote-sse", server);
        expect(result).toEqual({ url: "http://remote.example.com:4000/sse" });
    });
});

describe("buildMcpConfig", () => {
    let fsMock: typeof import("fs");
    let existsSync: ReturnType<typeof vi.fn>;
    let readFileSync: ReturnType<typeof vi.fn>;
    let writeFileSync: ReturnType<typeof vi.fn>;
    let buildMcpConfig: (profile?: string) => string[];

    function getWrittenConfig(): Record<string, unknown> {
        expect(writeFileSync).toHaveBeenCalled();
        const rawJson = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][1] as string;
        return JSON.parse(rawJson);
    }

    beforeEach(async () => {
        vi.resetModules();
        fsMock = await import("fs");
        existsSync = fsMock.existsSync as ReturnType<typeof vi.fn>;
        readFileSync = fsMock.readFileSync as ReturnType<typeof vi.fn>;
        writeFileSync = fsMock.writeFileSync as ReturnType<typeof vi.fn>;
        vi.clearAllMocks();
        // Default: CLAUDE_JSON_FILE does not exist, host ~/.claude.json does not exist
        existsSync.mockReturnValue(false);
        const mod = await import("../mcp-forward.js");
        buildMcpConfig = mod.buildMcpConfig;
    });

    it("always includes chrome-devtools in the written config", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["chrome-devtools"]).toBeDefined();
        const entry = servers["chrome-devtools"] as { command: string; args: string[] };
        expect(entry.command).toBe("mise");
        expect(entry.args).toContain("--executablePath=/usr/bin/chromium");
    });

    it("always includes x11-display with the expected direct-spawn shape", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["x11-display"]).toEqual({
            command: "mise",
            args: ["exec", "node@22", "--", "node", "/opt/ccc/x11-mcp/server.mjs"],
        });
    });

    it("forwards host MCP servers (stdio)", () => {
        // CLAUDE_JSON_FILE does not exist, but host ~/.claude.json does
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true; // host file
            return false; // CLAUDE_JSON_FILE
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "my-tool": { command: "mytool", args: [] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["my-tool"]).toEqual({ command: "mytool", args: [] });
    });

    it("does not forward host chrome-devtools (ccc manages its own)", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "chrome-devtools": { command: "host-chrome", args: [] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        // ccc's own chrome-devtools should be present, not host's version
        const entry = servers["chrome-devtools"] as { command: string };
        expect(entry.command).toBe("mise");
    });

    it("does not forward playwright (legacy, removed)", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        playwright: { command: "npx", args: ["playwright"] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["playwright"]).toBeUndefined();
    });

    it("returns list of forwarded server names (excludes chrome-devtools and playwright)", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "chrome-devtools": { command: "host-chrome" },
                        playwright: { command: "npx" },
                        "my-tool": { command: "mytool" },
                        "another-tool": { command: "anothertool" },
                    },
                });
            }
            return "{}";
        });
        const forwarded = buildMcpConfig();
        expect(forwarded).toContain("my-tool");
        expect(forwarded).toContain("another-tool");
        expect(forwarded).not.toContain("chrome-devtools");
        expect(forwarded).not.toContain("playwright");
    });

    it("returns empty array when no host servers are forwarded", () => {
        // Both files don't exist
        existsSync.mockReturnValue(false);
        const forwarded = buildMcpConfig();
        expect(forwarded).toEqual([]);
    });

    it("still includes chrome-devtools when CLAUDE_JSON_FILE contains invalid JSON", () => {
        // CLAUDE_JSON_FILE exists but has invalid JSON (catch block, line 78)
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return false; // no host file
            return true; // CLAUDE_JSON_FILE exists
        });
        readFileSync.mockImplementation(() => "not valid json {{{");

        const forwarded = buildMcpConfig();

        // Should not throw and chrome-devtools should still be present
        expect(forwarded).toEqual([]);
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["chrome-devtools"]).toBeDefined();
        const entry = servers["chrome-devtools"] as { command: string };
        expect(entry.command).toBe("mise");
    });

    it("per-exec isolation: regenerates mcpServers fully, no stale servers accumulate", () => {
        // First call: CLAUDE_JSON_FILE has an old server from a previous project
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith("claude.json") && !p.endsWith(".claude.json")) return true; // CLAUDE_JSON_FILE
            return false; // no host file
        });
        readFileSync.mockImplementation(() =>
            JSON.stringify({
                mcpServers: {
                    "stale-server": { command: "stale" },
                    "chrome-devtools": { command: "old" },
                },
                someOtherConfig: "preserved",
            })
        );
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        // stale-server from previous project must NOT be present
        expect(servers["stale-server"]).toBeUndefined();
        // chrome-devtools should be ccc's managed version
        const entry = servers["chrome-devtools"] as { command: string };
        expect(entry.command).toBe("mise");
        // Non-MCP config is preserved
        expect(config["someOtherConfig"]).toBe("preserved");
    });

    it("rewrites localhost URL for forwarded HTTP/SSE servers", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "my-sse": { url: "http://localhost:8080/sse" },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        const entry = servers["my-sse"] as { url: string };
        expect(entry.url).toBe("http://host.docker.internal:8080/sse");
    });

    it("buildMcpConfig() with no profile writes to default CLAUDE_JSON_FILE path", () => {
        existsSync.mockReturnValue(false);
        buildMcpConfig();
        // Should write to ~/.ccc/claude.json (default path, not profiles dir)
        const writePath = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][0] as string;
        expect(writePath).toContain(".ccc");
        expect(writePath).not.toContain("profiles");
        expect(writePath).toMatch(/claude\.json$/);
    });

    it("buildMcpConfig('work') writes to profile-specific path", () => {
        existsSync.mockReturnValue(false);
        buildMcpConfig("work");
        // Should write to ~/.ccc/profiles/work/claude.json
        const writePath = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][0] as string;
        expect(writePath).toContain("profiles");
        expect(writePath).toContain("work");
        expect(writePath).toMatch(/claude\.json$/);
    });

    it("buildMcpConfig('work') reads from profile-specific claude.json for existing config", () => {
        existsSync.mockImplementation((p: string) => {
            // profile claude.json exists
            if (p.includes("profiles") && p.includes("work") && p.endsWith("claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.includes("profiles") && p.includes("work")) {
                return JSON.stringify({ existingConfig: "preserved" });
            }
            return "{}";
        });
        buildMcpConfig("work");
        const config = getWrittenConfig();
        // Non-MCP config from profile file should be preserved
        expect(config["existingConfig"]).toBe("preserved");
    });
});
