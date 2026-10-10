import { describe, expect, it, vi } from "vitest";
import { createMcpConfigRegenerator } from "../../application/mcp-forward.js";
import { selectHostMcpServers, forwardHostMcpServers, freshManagedMcpServers } from "../../domain/mcp-forward.js";
import * as domain from "../../domain/mcp-forward.js";

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
        withCodexProfileLock<T>(profile: string | undefined, operation: () => T): T {
            effect(`lock:${profile ?? "default"}`); locked = true;
            try { return operation(); } finally { locked = false; events.push("unlock"); }
        },
        prepareCodexProfile(profile?: string) { expect(locked).toBe(true); effect(`prepare:${profile ?? "default"}`); return { binding: { path: "codex" }, existingText: existing }; },
        publishCodexProfile(binding: { path: string }, text: string) { expect(locked).toBe(true); effect("publish-codex"); writes[binding.path] = text; return undefined; },
        publishClaudeProfile(binding: { path: string }, text: string) { expect(locked).toBe(false); effect("publish-claude"); writes[binding.path] = text; return undefined; },
    };
    const generator = createMcpConfigRegenerator(ports);
    return { generator, events, writes, failures, isLocked: () => locked };
}

describe("inward synchronous MCP regeneration", () => {
    it("does not select an accessor publication writer during construction", () => {
        let selections = 0; let calls = 0;
        const generator = createMcpConfigRegenerator({
            resolveClaudeProfile: () => "claude",
            readClaudeProfileDocument: () => () => "{}",
            readHostMcpDocument: () => undefined,
            withCodexProfileLock: <T>(_profile: string | undefined, operation: () => T): T => operation(),
            prepareCodexProfile: () => ({binding: "codex", existingText: ""}),
            publishCodexProfile: () => undefined,
            get publishClaudeProfile() {
                selections += 1;
                return () => { calls += 1; return undefined; };
            },
        });
        expect(selections).toBe(0); expect(calls).toBe(0);
        generator.build();
        expect(selections).toBe(1); expect(calls).toBe(1);
    });
    it("requires every semantic port at construction", () => {
        for (const name of ["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"]) {
            const ports = Object.fromEntries(["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"].filter(key => key !== name).map(key => [key, () => undefined]));
            // Intentionally malformed runtime input, independently of the strict consumer proof.
            expect(() => createMcpConfigRegenerator(ports as never)).toThrow(name);
        }
    });
    it("retains ordinary maps, shared mutable Chrome identity and fresh Device Lab identity", () => {
        const first = freshManagedMcpServers(); const second = freshManagedMcpServers();
        expect(Object.getPrototypeOf(first)).toBe(Object.prototype); expect(first).not.toBe(second);
        expect(first["chrome-devtools"]).toBe(second["chrome-devtools"]);
        expect(first["device-lab"]).not.toBe(second["device-lab"]);
        expect(first["device-lab"].args).not.toBe(second["device-lab"].args);
        expect(first["device-lab"].env).not.toBe(second["device-lab"].env);
        first["chrome-devtools"].witness = "mutable";
        try { expect(freshManagedMcpServers()["chrome-devtools"].witness).toBe("mutable"); }
        finally { delete first["chrome-devtools"].witness; }
    });
    it("creates fresh managed entries before observing the host document", () => {
        const f = fixture();
        const original = domain.freshManagedMcpServers;
        const managed = vi.spyOn(domain, "freshManagedMcpServers").mockImplementation(() => { f.events.push("managed"); return original(); });
        try {
            f.generator.build();
            expect(f.events.indexOf("managed")).toBeGreaterThan(f.events.indexOf("read-claude"));
            expect(f.events.indexOf("managed")).toBeLessThan(f.events.indexOf("read-host"));
            expect(managed).toHaveBeenCalledOnce();
        } finally { managed.mockRestore(); }
    });
    it("retains host arrays and unknown primitive entries without schema hardening", () => {
        const array = selectHostMcpServers({mcpServers: [{command: "node"}]});
        expect(Array.isArray(array)).toBe(true);
        const map = freshManagedMcpServers();
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
        expect(f.events).toEqual(["resolve:work", "read-claude", "read-host", "lock:work", "restore", "prepare:work", "publish-codex", "unlock", "publish-claude"]);
        expect(JSON.parse(f.writes.claude).mcpServers.remote.url).toBe("http://host.docker.internal:7/sse");
        expect(f.writes.codex).toContain('url = "http://host.docker.internal:7/sse"');
    });

    it("regenerates fresh managed entries and filters exactly the retired and reserved names", () => {
        const host = { mcpServers: { "chrome-devtools": {}, "device-lab": {}, "x11-display": {}, lab: {}, playwright: {}, retired: { args: ["/opt/ccc/x11-mcp/server.mjs"] }, current: { command: "node", args: ["other"] }, substring: { command: "/opt/ccc/x11-mcp/server.mjs-extra" } } };
        const f = fixture(undefined, JSON.stringify(host));
        expect(f.generator.build()).toEqual(["current", "substring"]);
        const servers = JSON.parse(f.writes.claude).mcpServers;
        expect(Object.keys(servers)).toEqual(["chrome-devtools", "device-lab", "current", "substring"]);
        expect(servers["chrome-devtools"].args).toContain("node@22");
        expect(servers["device-lab"].env).toEqual({ CCC_DEVICE_BROKER_AUTH_FILE: "/run/ccc-device-broker-auth/owner.json" });
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

    it.each(["resolve:default", "read-claude", "read-host", "lock:default", "prepare:default", "publish-codex", "publish-claude"])("retains raw port failure and prior survivors at %s", point => {
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
        expect(f.events).toEqual(["resolve:default", "read-claude", "read-host", "lock:default", "unlock"]);
        expect(f.writes).toEqual({});
    });
    it("Claude serialization failure leaves the successful Codex publication intact", () => {
        const config: Record<string, unknown> = {}; config.circular = config;
        const parse = vi.spyOn(JSON, "parse").mockReturnValueOnce(config);
        const f = fixture("{}");
        try {
            expect(() => f.generator.build()).toThrow(TypeError);
            expect(f.writes.codex).toContain("# ccc-managed-mcp end");
            expect(f.writes.claude).toBeUndefined(); expect(f.events.at(-1)).toBe("unlock");
        } finally { parse.mockRestore(); }
    });
});
