import { describe, expect, it } from "vitest";
import { createMcpConfigRegenerator } from "../../application/mcp-forward.js";
import { selectHostMcpServers, forwardHostMcpServers } from "../../domain/mcp-forward.js";
import type { McpServerConfig } from "../../domain/mcp-forward.js";

function fixture(claude: string | undefined = undefined, host: string | undefined = undefined, existing = "") {
    const events: string[] = [];
    const writes: Record<string, string> = {};
    const failures = new Map<string, unknown>();
    let locked = false;
    const effect = (name: string) => { events.push(name); if (failures.has(name)) throw failures.get(name); };
    const ports = {
        resolveClaudeProfile(profile?: string) { effect(`resolve:${profile ?? "default"}`); return { path: "claude" }; },
        readClaudeProfileDocument(binding: { path: string }) { expect(binding.path).toBe("claude"); effect("read-claude"); return claude === undefined ? undefined : () => claude; },
        readHostMcpDocument() { effect("read-host"); return host === undefined ? undefined : () => host; },
        createManagedMcpServers() {
            effect("managed");
            return {
                chromeDevtools: { command: "fixture-browser", args: ["browser-argument"] },
                deviceLab: { command: "fixture-device", env: { FIXTURE_AUTH: "fixture-auth-path" } },
            };
        },
        withCodexProfileLock<T>(profile: string | undefined, operation: () => T): T {
            effect(`lock:${profile ?? "default"}`); locked = true;
            try { return operation(); } finally { locked = false; events.push("unlock"); }
        },
        prepareCodexProfile(profile?: string) { expect(locked).toBe(true); effect(`prepare:${profile ?? "default"}`); return { binding: { path: "codex" }, existingText: existing }; },
        publishCodexProfile(binding: { path: string }, text: string) { expect(locked).toBe(true); effect("publish-codex"); writes[binding.path] = text; return undefined; },
        publishClaudeProfile(binding: { path: string }, text: string) {
            expect(locked).toBe(false);
            expect(writes.codex ?? existing).toContain("# ccc-managed-mcp end");
            effect("publish-claude"); writes[binding.path] = text; return undefined;
        },
    };
    const generator = createMcpConfigRegenerator(ports);
    return { generator, events, writes, failures, isLocked: () => locked };
}

describe("inward synchronous MCP regeneration", () => {
    it.each(["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "createManagedMcpServers", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"])("requires callable %s at construction", name => {
        const names = ["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "createManagedMcpServers", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"];
        const absent = Object.fromEntries(names.filter(key => key !== name).map(key => [key, () => undefined]));
        // Intentionally malformed runtime inputs exercise the construction boundary.
        expect(() => createMcpConfigRegenerator(absent as never)).toThrow(name);
        for (const value of [undefined, null, false, 1, "writer", {}]) {
            expect(() => createMcpConfigRegenerator({ ...absent, [name]: value } as never)).toThrow(name);
        }
    });
    it("retains host arrays and unknown primitive entries without schema hardening", () => {
        const array = selectHostMcpServers({mcpServers: [{command: "node"}]});
        expect(Array.isArray(array)).toBe(true);
        const map: Record<string, McpServerConfig> = {};
        expect(forwardHostMcpServers(map, array)).toEqual(["0"]);
        expect(forwardHostMcpServers(map, { scalar: 42 } as never)).toEqual(["scalar"]);
        expect(map.scalar).toEqual({});
        expect(() => forwardHostMcpServers(map, { bad: null } as never)).toThrow(TypeError);
    });
    it("constructs without effects and publishes Codex inside the lock before Claude", () => {
        const f = fixture(undefined, JSON.stringify({ mcpServers: { remote: { url: "http://localhost:7/sse" } } }));
        expect(f.events).toEqual([]);
        const result = f.generator.build("work", () => { expect(f.isLocked()).toBe(true); f.events.push("restore"); });
        expect(result).toEqual(["remote"]);
        expect(f.isLocked()).toBe(false);
        expect(f.events).toContain("restore");
        expect(JSON.parse(f.writes.claude).mcpServers.remote.url).toBe("http://host.docker.internal:7/sse");
        expect(f.writes.codex).toContain('url = "http://host.docker.internal:7/sse"');
    });

    it("publishes supplied managed entries and filters exactly the retired and reserved names", () => {
        const host = { mcpServers: { "chrome-devtools": {}, "device-lab": {}, "x11-display": {}, lab: {}, playwright: {}, retired: { args: ["/opt/ccc/x11-mcp/server.mjs"] }, current: { command: "node", args: ["other"] }, substring: { command: "/opt/ccc/x11-mcp/server.mjs-extra" } } };
        const f = fixture(undefined, JSON.stringify(host));
        expect(f.generator.build()).toEqual(["current", "substring"]);
        const servers = JSON.parse(f.writes.claude).mcpServers;
        expect(Object.keys(servers)).toEqual(["chrome-devtools", "device-lab", "current", "substring"]);
        expect(servers["chrome-devtools"]).toEqual({ command: "fixture-browser", args: ["browser-argument"] });
        expect(servers["device-lab"]).toEqual({ command: "fixture-device", env: { FIXTURE_AUTH: "fixture-auth-path" } });
        expect(f.writes.codex).toContain('command = "fixture-browser"');
        expect(f.writes.codex).toContain('FIXTURE_AUTH = "fixture-auth-path"');
    });

    it.each([undefined, "{broken", "[]"])("keeps permissive Claude parsing for %s", document => {
        const f = fixture(document);
        expect(f.generator.build()).toEqual([]);
        expect(f.writes.codex).toContain("# ccc-managed-mcp begin");
        expect(f.writes.claude).toBe(document === "[]" ? "[]" : JSON.stringify({ mcpServers: JSON.parse(f.writes.claude).mcpServers }, null, 2));
    });

    it.each(["null", "1", '"text"', "true"])("preserves valid scalar mutation failure after Codex publication: %s", document => {
        const f = fixture(document);
        expect(() => f.generator.build()).toThrow(TypeError);
        expect(f.writes.codex).toContain("# ccc-managed-mcp end");
        expect(f.writes.claude).toBeUndefined();
        expect(f.events.at(-1)).toBe("unlock");
    });

    it("suppresses only unchanged Codex publication", () => {
        const first = fixture(); first.generator.build();
        const second = fixture(undefined, undefined, first.writes.codex);
        second.generator.build();
        expect(second.events).not.toContain("publish-codex");
        expect(second.events).toContain("publish-claude");
    });

    it.each(["resolve:default", "read-claude", "managed", "read-host", "lock:default", "prepare:default", "publish-codex", "publish-claude"])("retains raw port failure and prior survivors at %s", point => {
        const f = fixture(); const cause = { point }; f.failures.set(point, cause);
        let thrown: unknown; try { f.generator.build(); } catch (error) { thrown = error; }
        expect(thrown).toBe(cause);
        expect(f.writes.claude).toBeUndefined();
        expect(Boolean(f.writes.codex)).toBe(point === "publish-claude");
    });

    it("a bare restore failure prevents preparation and both publications", () => {
        const f = fixture(); const cause = Symbol("restore");
        let thrown: unknown; try { f.generator.build(undefined, () => { throw cause; }); } catch (error) { thrown = error; }
        expect(thrown).toBe(cause);
        expect(f.events).not.toContain("prepare:default");
        expect(f.isLocked()).toBe(false);
        expect(f.writes).toEqual({});
    });
});
