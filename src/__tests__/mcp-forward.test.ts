import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: vi.fn((operation: () => unknown) => operation()) }));

vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return {
        ...actual,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
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
    let buildMcpConfig: (profile?: string, restoreAccess?: () => void) => string[];

    function getWrittenConfig(): Record<string, unknown> {
        expect(writeFileSync).toHaveBeenCalled();
        const rawJson = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][1] as string;
        return JSON.parse(rawJson);
    }

    function getWrittenCodexConfig(): string {
        const call = writeFileSync.mock.calls.find(([path]) => String(path).endsWith(".ccc/profiles/default/codex/config.toml"));
        expect(call).toBeDefined();
        return call![1] as string;
    }

    beforeEach(async () => {
        vi.resetModules();
        fsMock = await import("fs");
        existsSync = fsMock.existsSync as ReturnType<typeof vi.fn>;
        readFileSync = fsMock.readFileSync as ReturnType<typeof vi.fn>;
        writeFileSync = fsMock.writeFileSync as ReturnType<typeof vi.fn>;
        existsSync.mockReset();
        readFileSync.mockReset();
        writeFileSync.mockReset();
        // Default: CLAUDE_JSON_FILE does not exist, host ~/.claude.json does not exist
        existsSync.mockReturnValue(false);
        writeFileSync.mockImplementation(() => undefined);
        const mod = await import("../mcp-forward.js");
        buildMcpConfig = mod.buildMcpConfig;
    });

    it("restores host access and writes under the selected profile lock", async () => {
        const { withCodexConfigLock } = await import("../codex-config-lock.js");
        let locked = false;
        vi.mocked(withCodexConfigLock).mockImplementation(operation => {
            locked = true;
            try { return operation(); } finally { locked = false; }
        });
        const restoreAccess = vi.fn(() => expect(locked).toBe(true));
        writeFileSync.mockImplementation((path: string) => {
            if (path.endsWith("codex/config.toml")) {
                expect(locked).toBe(true);
                expect(restoreAccess).toHaveBeenCalledOnce();
            }
        });
        try {
            buildMcpConfig("work", restoreAccess);
            expect(withCodexConfigLock).toHaveBeenCalledWith(expect.any(Function), "work");
            expect(restoreAccess).toHaveBeenCalledOnce();
        } finally {
            vi.mocked(withCodexConfigLock).mockImplementation(operation => operation());
        }
    });

    it("stops before config mutation if in-lock access repair fails", () => {
        const restoreAccess = () => { throw new Error("access unavailable"); };
        expect(() => buildMcpConfig("work", restoreAccess)).toThrow("access unavailable");
        expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("always includes chrome-devtools in the written config", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["chrome-devtools"]).toBeDefined();
        const entry = servers["chrome-devtools"] as { command: string; args: string[] };
        expect(entry.command).toBe("mise");
        expect(entry.args.slice(0, 3)).toEqual(["--no-config", "exec", "node@22"]);
        expect(entry.args).toContain("--executablePath=/usr/bin/chromium");
        expect(entry.args).toContain("--chromeArg=--no-sandbox");
        expect(entry.args).toContain("--chromeArg=--disable-setuid-sandbox");
        expect(entry.args).toContain("--chromeArg=--disable-dev-shm-usage");
        expect(entry.args.some((arg) => arg.startsWith("--chromeArg=--host-resolver-rules="))).toBe(false);
    });

    it("does not include the retired standalone x11-display server", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["x11-display"]).toBeUndefined();
    });

    it("uses the container image device-lab MCP bundle", () => {
        existsSync.mockImplementation((p: string) => p.endsWith("/dist/device-lab-mcp/server.mjs"));
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["device-lab"]).toEqual({
            command: "mise",
            args: ["--no-config", "exec", "node@22", "--", "node", "/opt/ccc/dist/device-lab-mcp/server.mjs"],
            env: { CCC_DEVICE_BROKER_AUTH_FILE: "/run/ccc-device-broker-auth/owner.json" },
        });
    });

    it("never writes a host checkout path when host dist is unavailable", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        const entry = servers["device-lab"] as { command: string; args: string[] };
        expect(entry.command).toBe("mise");
        expect(entry.args).toContain("/opt/ccc/dist/device-lab-mcp/server.mjs");
    });

    it("does not register a standalone lab MCP server", () => {
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["lab"]).toBeUndefined();
    });

    it("writes ccc-managed MCP servers to Codex config.toml", () => {
        buildMcpConfig();
        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig).toContain("# ccc-managed-mcp begin");
        expect(codexConfig).toContain("[mcp_servers.chrome-devtools]");
        expect(codexConfig).toContain('command = "mise"');
        expect(codexConfig).toContain('"--no-config"');
        expect(codexConfig).toContain('"--executablePath=/usr/bin/chromium"');
        expect(codexConfig).not.toContain("--host-resolver-rules");
        expect(codexConfig).not.toContain("[mcp_servers.x11-display]");
        expect(codexConfig).not.toContain('"/opt/ccc/x11-mcp/server.mjs"');
        expect(codexConfig).toContain("[mcp_servers.device-lab]");
        expect(codexConfig).toContain('"/opt/ccc/dist/device-lab-mcp/server.mjs"');
        expect(codexConfig).toContain('CCC_DEVICE_BROKER_AUTH_FILE');
        expect(codexConfig).toContain('"/run/ccc-device-broker-auth/owner.json"');
        expect(codexConfig).not.toContain("[mcp_servers.lab]");
        expect(codexConfig).not.toContain("/dist/lab-mcp/server.mjs");
        expect(codexConfig).toContain("# ccc-managed-mcp end");
    });

    it("writes bundled MCP server paths to Codex config.toml when available", () => {
        existsSync.mockImplementation((p: string) => p.endsWith("/dist/device-lab-mcp/server.mjs"));

        buildMcpConfig();

        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig).toContain("/dist/device-lab-mcp/server.mjs");
        expect(codexConfig).not.toContain("/dist/lab-mcp/server.mjs");
        expect(codexConfig).not.toContain('"/opt/ccc/device-lab-mcp/server.mjs"');
    });

    it("does not rewrite Codex config.toml when the generated config is unchanged", () => {
        buildMcpConfig();
        const existingCodexConfig = getWrittenCodexConfig();

        vi.clearAllMocks();
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".ccc/profiles/default/codex/config.toml")) return existingCodexConfig;
            return "{}";
        });

        buildMcpConfig();

        const codexWrites = writeFileSync.mock.calls.filter(([path]) => String(path).endsWith(".ccc/profiles/default/codex/config.toml"));
        expect(codexWrites).toHaveLength(0);
    });

    it("throws an actionable error when existing Codex config cannot be read", () => {
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".ccc/profiles/default/codex/config.toml")) {
                const error = new Error("permission denied") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            return "{}";
        });

        expect(() => buildMcpConfig()).toThrow(/sudo chown -R "\$USER:\$USER" "\/home\/testuser\/\.ccc\/profiles\/default\/codex"/);
    });

    it("throws an actionable error when Codex config cannot be written", () => {
        writeFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".ccc/profiles/default/codex/config.toml")) {
                const error = new Error("permission denied") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
        });

        expect(() => buildMcpConfig()).toThrow(/Unable to write Codex config.*sudo chown -R "\$USER:\$USER" "\/home\/testuser\/\.ccc\/profiles\/default\/codex"/);
    });

    it("writes Codex TOML arrays in the exact order needed for MCP startup", () => {
        buildMcpConfig();
        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig).toContain(
            'args = ["--no-config", "exec", "node@22", "--", "npx", "-y", "chrome-devtools-mcp"',
        );
        expect(codexConfig).toContain(
            'args = ["--no-config", "exec", "node@22", "--", "node", "/opt/ccc/dist/device-lab-mcp/server.mjs"]',
        );
        expect(codexConfig).not.toContain("/opt/ccc/x11-mcp/server.mjs");
        expect(codexConfig).not.toContain("/dist/lab-mcp/server.mjs");
    });

    it("preserves user Codex config while replacing the prior ccc-managed block", () => {
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".ccc/profiles/default/codex/config.toml")) {
                return [
                    'model = "gpt-5.2-codex"',
                    "",
                    "# ccc-managed-mcp begin",
                    "",
                    "[mcp_servers.old-server]",
                    'command = "old"',
                    "",
                    "# ccc-managed-mcp end",
                    "",
                    "[projects.\"/project/example\"]",
                    'trust_level = "trusted"',
                ].join("\n");
            }
            return "{}";
        });

        buildMcpConfig();
        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig).toContain('model = "gpt-5.2-codex"');
        expect(codexConfig).toContain('[projects."/project/example"]');
        expect(codexConfig).toContain("[mcp_servers.chrome-devtools]");
        expect(codexConfig).not.toContain("[mcp_servers.old-server]");
    });

    it("removes legacy unmarked ccc-managed Codex MCP tables before writing", () => {
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".ccc/profiles/default/codex/config.toml")) {
                return [
                    'model = "gpt-5.2-codex"',
                    "",
                    "[mcp_servers.chrome-devtools]",
                    'command = "mise"',
                    'args = ["old"]',
                    "",
                    "[mcp_servers.x11-display]",
                    'command = "mise"',
                    'args = ["old"]',
                    "",
                    "[mcp_servers.device-lab]",
                    'command = "mise"',
                    'args = ["old"]',
                    "",
                    "[mcp_servers.lab]",
                    'command = "mise"',
                    'args = ["old"]',
                    "",
                    "[mcp_servers.user-server]",
                    'command = "user-tool"',
                    "",
                    "[projects.\"/project/example\"]",
                    'trust_level = "trusted"',
                ].join("\n");
            }
            return "{}";
        });

        buildMcpConfig();
        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig.match(/\[mcp_servers\.chrome-devtools\]/g)).toHaveLength(1);
        expect(codexConfig.match(/\[mcp_servers\.x11-display\]/g)).toBeNull();
        expect(codexConfig.match(/\[mcp_servers\.device-lab\]/g)).toHaveLength(1);
        expect(codexConfig.match(/\[mcp_servers\.lab\]/g)).toBeNull();
        expect(codexConfig).not.toContain('args = ["old"]');
        expect(codexConfig).toContain("[mcp_servers.user-server]");
        expect(codexConfig).toContain('[projects."/project/example"]');
    });

    it("removes quoted and unquoted legacy env subtables without orphaning configuration", () => {
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue([
            'model = "gpt-5.2-codex"',
            "[mcp_servers.x11-display.env] # old managed environment",
            'ORPHAN_X11 = "remove"',
            '[mcp_servers."x11-display"]',
            'command = "mise"',
            '[mcp_servers."device-lab".env]',
            'OLD_DEVICE_ENV = "remove"',
            '["mcp_servers"."x11-display"."env"]',
            'QUOTED_ORPHAN_X11 = "remove"',
            "[mcp_servers.device-lab]",
            'command = "old-device-lab"',
            '[mcp_servers."chrome-devtools".env]',
            'OLD_CHROME_ENV = "remove"',
            "[mcp_servers.lab.env]",
            'OLD_LAB_ENV = "remove"',
            "[mcp_servers.user-tool]",
            'command = "user-tool"',
            '[mcp_servers."user-tool".env]',
            'KEEP_USER_ENV = "yes"',
            '[mcp_servers."custom]name"]',
            'command = "keep-special-name"',
            '[projects."/project/example"]',
            'trust_level = "trusted"',
        ].join("\n"));

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        for (const oldValue of ["ORPHAN_X11", "QUOTED_ORPHAN_X11", "OLD_DEVICE_ENV", "OLD_CHROME_ENV", "OLD_LAB_ENV"]) {
            expect(config).not.toContain(oldValue);
        }
        expect(config).toContain('[mcp_servers."user-tool".env]');
        expect(config).toContain('KEEP_USER_ENV = "yes"');
        expect(config).toContain('[mcp_servers."custom]name"]');
        expect(config).toContain('[projects."/project/example"]');
        expect(config.match(/\[mcp_servers\.device-lab\]/g)).toHaveLength(1);
        expect(config).not.toContain("mcp_servers.x11-display");
        expect(config).not.toContain('mcp_servers."x11-display"');
    });

    it("removes exact CCC X11 path aliases while preserving unrelated Codex X11 servers", () => {
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue([
            '[mcp_servers."legacy display".env]',
            'OLD_ALIAS_ENV = "remove"',
            '[mcp_servers."legacy display"]',
            'command = "node"',
            "args = [",
            '  "/opt/ccc/x11-mcp/server.mjs",',
            "]",
            "[mcp_servers.old-bundle]",
            "command = '/opt/ccc/dist/x11-mcp/server.mjs'",
            "[mcp_servers.old-bundle.env]",
            'OLD_BUNDLE_ENV = "remove"',
            "[mcp_servers.x11]",
            'command = "user-x11"',
            'args = ["/custom/x11-mcp/server.mjs"]',
            '[mcp_servers."x11".env]',
            'KEEP_CUSTOM_X11 = "yes"',
            "[mcp_servers.path-prefix]",
            'args = ["/opt/ccc/x11-mcp/server.mjs.custom"]',
            "[mcp_servers.path-suffix]",
            'args = ["/custom/opt/ccc/dist/x11-mcp/server.mjs"]',
            "[mcp_servers.reference-only]",
            'command = "other-tool" # "/opt/ccc/x11-mcp/server.mjs"',
            'args = ["--safe"] # "/opt/ccc/dist/x11-mcp/server.mjs"',
            "[mcp_servers.reference-only.env]",
            'EXAMPLE = "/opt/ccc/x11-mcp/server.mjs"',
        ].join("\n"));

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        expect(config).not.toContain('mcp_servers."legacy display"');
        expect(config).not.toContain("mcp_servers.old-bundle");
        expect(config).not.toContain("OLD_ALIAS_ENV");
        expect(config).not.toContain("OLD_BUNDLE_ENV");
        for (const customName of ["x11", "path-prefix", "path-suffix", "reference-only"]) {
            expect(config).toContain(`[mcp_servers.${customName}]`);
        }
        expect(config).toContain('[mcp_servers."x11".env]');
        expect(config).toContain('KEEP_CUSTOM_X11 = "yes"');
        expect(config).toContain("[mcp_servers.reference-only.env]");
    });

    it.each(['"""', "'''"])("preserves table and managed-marker text inside %s multiline environment strings", (quote) => {
        const retained = [
            "[mcp_servers.custom]",
            'command = "user-tool"',
            "[mcp_servers.custom.env]",
            `NOTES = ${quote}`,
            "[mcp_servers.x11-display.env]",
            'EXAMPLE = "keep this text"',
            "# ccc-managed-mcp begin",
            "[mcp_servers.device-lab]",
            "# ccc-managed-mcp end",
            quote,
        ].join("\n");
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue(`${retained}\n\n[mcp_servers.x11-display]\ncommand = "old-x11"\n`);

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        expect(config.startsWith(retained)).toBe(true);
        expect(config).not.toContain('command = "old-x11"');
        expect(config).toContain('"/opt/ccc/dist/device-lab-mcp/server.mjs"');
    });

    it.each(['"""', "'''"])("ignores command/args text inside %s multiline inline environment values", (quote) => {
        const retained = [
            "[mcp_servers.custom]",
            'command = "user-tool"',
            `env = { NOTES = ${quote}`,
            'command = "/opt/ccc/x11-mcp/server.mjs"',
            'args = ["/opt/ccc/dist/x11-mcp/server.mjs"]',
            `${quote} }`,
            "[mcp_servers.custom.env_extra]",
            'KEEP = "yes"',
        ].join("\n");
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue(retained);

        buildMcpConfig();
        expect(getWrittenCodexConfig().startsWith(retained)).toBe(true);
    });

    it.each([
        ['"command"', '"/opt/ccc/x11-mcp/server.mjs"'],
        ["'command'", "'/opt/ccc/dist/x11-mcp/server.mjs'"],
        ['"args"', '["node", "/opt/ccc/dist/x11-mcp/server.mjs"]'],
        ["'args'", "['node', '/opt/ccc/x11-mcp/server.mjs']"],
    ])("removes an exact retired alias using the quoted %s assignment key", (key, value) => {
        const retained = '[mcp_servers.x11]\ncommand = "custom-x11"\n[mcp_servers.x11.env]\nKEEP = "yes"';
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue([
            "[mcp_servers.old-alias.env]",
            'OLD_ENV = "remove"',
            "[mcp_servers.old-alias]",
            `${key} = ${value}`,
            retained,
        ].join("\n"));

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        expect(config).not.toContain("mcp_servers.old-alias");
        expect(config).not.toContain("OLD_ENV");
        expect(config).toContain(retained);
    });

    it.each(['"', "'"])("preserves an args token with two literal %s suffix quotes", (quote) => {
        const retained = [
            "[mcp_servers.custom]",
            'command = "user-tool"',
            `args = [${quote.repeat(3)}/opt/ccc/x11-mcp/server.mjs${quote.repeat(5)}]`,
            "[mcp_servers.custom.env]",
            'KEEP = "yes"',
        ].join("\n");
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue(retained);

        buildMcpConfig();
        expect(getWrittenCodexConfig().startsWith(retained)).toBe(true);
    });

    it.each(['"', "'"])("removes exact retired command and args aliases written with multiline %s strings", (quote) => {
        const triple = quote.repeat(3);
        const retained = '[mcp_servers.custom]\ncommand = "user-tool"';
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue([
            "[mcp_servers.old-command]",
            `command = ${triple}\n/opt/ccc/x11-mcp/server.mjs${triple}`,
            "[mcp_servers.old-command.env]",
            'OLD_COMMAND = "remove"',
            "[mcp_servers.old-args]",
            `args = [${triple}\n/opt/ccc/dist/x11-mcp/server.mjs${triple}]`,
            "[mcp_servers.old-args.env]",
            'OLD_ARGS = "remove"',
            retained,
        ].join("\n"));

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        expect(config).not.toContain("mcp_servers.old-command");
        expect(config).not.toContain("mcp_servers.old-args");
        expect(config).not.toContain("OLD_COMMAND");
        expect(config).not.toContain("OLD_ARGS");
        expect(config).toContain(retained);
    });

    it("decodes Unicode key components and paths while preserving escaped backslashes", () => {
        const retained = String.raw`[mcp_servers.custom]
command = "user-tool"
args = ["/opt/ccc/\\U00000078\\u0031\\u0031-mcp/server.mjs"]
[mcp_servers.custom.env]
KEEP = "yes"`;
        existsSync.mockImplementation((p: string) => p.endsWith(".ccc/profiles/default/codex/config.toml"));
        readFileSync.mockReturnValue([
            String.raw`[mcp_servers."\U00000064evice-lab"]`,
            'command = "old-device-lab"',
            String.raw`[mcp_servers."\U00000064evice-lab".env]`,
            'OLD_NAME_ENV = "remove"',
            String.raw`["mcp\u005fservers".x11-display]`,
            'command = "old-x11"',
            String.raw`["mcp\u005fservers".x11-display.env]`,
            'OLD_PREFIX_ENV = "remove"',
            "[mcp_servers.old-escaped-path]",
            String.raw`"\U00000061rgs" = ["/opt/ccc/\U00000078\u0031\u0031-mcp/server.mjs"]`,
            "[mcp_servers.old-escaped-path.env]",
            'OLD_PATH_ENV = "remove"',
            retained,
        ].join("\n"));

        buildMcpConfig();
        const config = getWrittenCodexConfig();
        expect(config).not.toContain("old-device-lab");
        expect(config).not.toContain("old-x11");
        expect(config).not.toContain("OLD_NAME_ENV");
        expect(config).not.toContain("OLD_PREFIX_ENV");
        expect(config).not.toContain("OLD_PATH_ENV");
        expect(config).not.toContain("mcp_servers.old-escaped-path");
        expect(config).toContain(retained);
        expect(config.match(/\[mcp_servers\.device-lab\]/g)).toHaveLength(1);
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

    it("does not forward host device-lab (ccc manages its own)", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "device-lab": { command: "host-device-lab", args: [] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        const entry = servers["device-lab"] as { command: string; args: string[] };
        expect(entry.command).toBe("mise");
        expect(entry.args).toContain("/opt/ccc/dist/device-lab-mcp/server.mjs");
    });

    it("does not forward host x11-display after retiring the standalone entry", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        "x11-display": { command: "host-x11", args: [] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["x11-display"]).toBeUndefined();
        expect(servers["device-lab"]).toBeDefined();
    });

    it("filters only exact CCC-owned X11 host aliases and forwards custom X11 servers", () => {
        const customServers = {
            x11: { command: "user-x11", args: ["/custom/x11-mcp/server.mjs"] },
            "x11-custom": { command: "node", args: ["/opt/ccc/x11-mcp/server.mjs.custom"] },
            "x11-reference": { command: "other-tool", args: [], env: { EXAMPLE: "/opt/ccc/x11-mcp/server.mjs" } },
        };
        existsSync.mockImplementation((p: string) => p.endsWith(".claude.json"));
        readFileSync.mockReturnValue(JSON.stringify({
            mcpServers: {
                "old-source": { command: "node", args: ["/opt/ccc/x11-mcp/server.mjs"] },
                "old-bundle": { command: "/opt/ccc/dist/x11-mcp/server.mjs", args: [] },
                ...customServers,
            },
        }));

        const forwarded = buildMcpConfig();
        const servers = getWrittenConfig().mcpServers as Record<string, unknown>;
        expect(servers["old-source"]).toBeUndefined();
        expect(servers["old-bundle"]).toBeUndefined();
        expect(forwarded).toEqual(Object.keys(customServers));
        for (const [name, server] of Object.entries(customServers)) expect(servers[name]).toEqual(server);
        const codexConfig = getWrittenCodexConfig();
        expect(codexConfig).toContain("[mcp_servers.x11]");
        expect(codexConfig).not.toContain("mcp_servers.old-source");
        expect(codexConfig).not.toContain("mcp_servers.old-bundle");
    });

    it("does not forward the retired host lab MCP name", () => {
        existsSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) return true;
            return false;
        });
        readFileSync.mockImplementation((p: string) => {
            if (p.endsWith(".claude.json")) {
                return JSON.stringify({
                    mcpServers: {
                        lab: { command: "host-lab", args: [] },
                    },
                });
            }
            return "{}";
        });
        buildMcpConfig();
        const config = getWrittenConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        expect(servers["lab"]).toBeUndefined();
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
        // Should write to the default profile's claude.json
        const writePath = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][0] as string;
        expect(writePath).toBe("/home/testuser/.ccc/profiles/default/claude.json");
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
