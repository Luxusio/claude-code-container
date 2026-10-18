import { expect, it } from "vitest";
import { createLocalhostProxy } from "../../application/localhost-proxy.js";
import { createLocalhostProxyVerifier } from "../../application/localhost-proxy-setup.js";

class Stream {
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(readonly name: string, readonly events: unknown[]) {}
    on(event: string, listener: (...args: any[]) => void): this { this.events.push([this.name, "on", event]); this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
    removeListener(event: string, listener: (...args: any[]) => void): this { this.events.push([this.name, "remove", event]); this.listeners.set(event, (this.listeners.get(event) ?? []).filter(fn => fn !== listener)); return this; }
    write(chunk: object): boolean { this.events.push([this.name, "write", chunk]); return false; }
    pipe(peer: Stream): Stream { this.events.push([this.name, "pipe", peer.name]); return peer; }
    destroy(): this { this.events.push([this.name, "destroy"]); return this; }
    emit(event: string, ...args: any[]): void { for (const fn of this.listeners.get(event) ?? []) fn(...args); }
}
it("buffers original objects in FIFO order while local dial is pending, then attaches all four cleanup directions", async () => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    const first = {}; const second = {}; let finish!: (value: Stream) => void;
    const app = createLocalhostProxy<object, Stream>({ connect: (host, port) => { events.push(["connect", host, port]); return new Promise(resolve => { finish = resolve; }); } });
    expect(events).toEqual([]);
    const completion = app.proxyConnection(client, 8123);
    client.emit("data", first); client.emit("data", second); client.emit("close");
    expect(events).toEqual([["client", "on", "data"], ["connect", "127.0.0.1", 8123]]);
    finish(upstream); expect(await completion).toBeUndefined();
    expect(events.slice(2)).toEqual([["client", "remove", "data"], ["upstream", "write", first], ["upstream", "write", second],
        ["client", "pipe", "upstream"], ["upstream", "pipe", "client"], ["client", "on", "error"], ["upstream", "on", "error"], ["client", "on", "close"], ["upstream", "on", "close"]]);
    expect((events[3] as unknown[])[2]).toBe(first); expect((events[4] as unknown[])[2]).toBe(second);
    client.emit("error", new Error()); upstream.emit("error", new Error()); client.emit("close"); upstream.emit("close");
    expect(events.slice(-4)).toEqual([["upstream", "destroy"], ["client", "destroy"], ["upstream", "destroy"], ["client", "destroy"]]);
});
it.each([undefined, 0, 9191])("every raw local rejection falls back using nullish host port %s", async hostPort => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events); const fault = { code: "UNRELATED" }; let attempt = 0;
    const app = createLocalhostProxy<object, Stream>({ connect: async (host, port) => { events.push(["connect", host, port]); if (++attempt === 1) throw fault; return upstream; } });
    await app.proxyConnection(client, 0, "local", "host", hostPort);
    expect(events.filter(event => Array.isArray(event) && event[0] === "connect")).toEqual([["connect", "local", 0], ["connect", "host", hostPort ?? 0]]);
});
it("both rejected dials destroy the client and retain the original buffering listener", async () => {
    const events: unknown[] = []; const client = new Stream("client", events);
    await createLocalhostProxy<object, Stream>({ connect: async () => { throw null; } }).proxyConnection(client, 80);
    expect(events).toEqual([["client", "on", "data"], ["client", "destroy"]]);
    expect(client.listeners.get("data")).toHaveLength(1);
});
it.each(["write", "pipe", "destroy"] as const)("raw %s throws preserve partial effects", async operation => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events); const raw = {};
    if (operation === "write") upstream.write = () => { throw raw; };
    if (operation === "pipe") client.pipe = () => { throw raw; };
    if (operation === "destroy") client.destroy = () => { throw raw; };
    const completion = createLocalhostProxy<object, Stream>({ connect: async () => { if (operation === "destroy") throw raw; return upstream; } }).proxyConnection(client, 80);
    client.emit("data", {});
    await expect(completion).rejects.toBe(raw);
    expect(events.filter(event => Array.isArray(event) && event[1] === "on")).toEqual([["client", "on", "data"]]);
});

function verifierFixture() {
    const events: unknown[] = [];
    const ports = {
        platform: () => { events.push("platform"); return "darwin"; },
        containerHostRemote: () => { events.push("remote"); return false; },
        directReach: (container: string, timeout: number) => { events.push(["reach", container, timeout]); return { reachable: false, latencyMs: 7 }; },
        proxyListenerPresent: (container: string) => { events.push(["listener", container]); return false; },
        debugFlag: (): string | undefined => { events.push("debug"); return undefined; },
        reportDirectReachable: (latencyMs: number): undefined => { events.push(["direct-reachable", latencyMs]); return undefined; },
        reportUnavailable: (container: string): undefined => { events.push(["unavailable", container]); return undefined; },
    };
    return { events, ports };
}
it("verifier construction has no effects; native Linux skips reach and observation", () => {
    const { events, ports } = verifierFixture(); ports.platform = () => { events.push("platform"); return "linux"; };
    const app = createLocalhostProxyVerifier(ports); expect(events).toEqual([]); app.setup("owned");
    expect(events).toEqual(["platform", "remote"]);
});
it("verifier observes unreachable host and reports unavailability after the listener fact", () => {
    const { events, ports } = verifierFixture(); createLocalhostProxyVerifier(ports).setup("owned");
    expect(events).toEqual(["platform", ["reach", "owned", 1500], ["listener", "owned"], ["unavailable", "owned"]]);
});
it("a remote Linux host still receives bounded reach and listener checks", () => {
    const { events, ports } = verifierFixture();
    ports.platform = () => { events.push("platform"); return "linux"; };
    ports.containerHostRemote = () => { events.push("remote"); return true; };
    createLocalhostProxyVerifier(ports).setup("remote-owned");
    expect(events).toEqual(["platform", "remote", ["reach", "remote-owned", 1500],
        ["listener", "remote-owned"], ["unavailable", "remote-owned"]]);
});
it.each([undefined, "", "1"])("direct reach reports latency only when DEBUG is enabled (%s)", debugFlag => {
    const { events, ports } = verifierFixture();
    ports.directReach = (container, timeout) => { events.push(["reach", container, timeout]); return { reachable: true, latencyMs: 23 }; };
    ports.debugFlag = () => { events.push("debug"); return debugFlag; };
    createLocalhostProxyVerifier(ports).setup("owned");
    expect(events).toEqual(["platform", ["reach", "owned", 1500], "debug",
        ...(debugFlag ? [["direct-reachable", 23]] : [])]);
});
it("a present listener ends setup without debug or unavailable notifications", () => {
    const { events, ports } = verifierFixture();
    ports.proxyListenerPresent = container => { events.push(["listener", container]); return true; };
    createLocalhostProxyVerifier(ports).setup("owned");
    expect(events).toEqual(["platform", ["reach", "owned", 1500], ["listener", "owned"]]);
});
it("notification capabilities stay lazy until their selected setup branch", () => {
    const { events, ports } = verifierFixture();
    Object.defineProperty(ports, "reportDirectReachable", { get() { throw new Error("unselected-direct-notification"); } });
    Object.defineProperty(ports, "reportUnavailable", { get() {
        events.push("get:unavailable");
        return (container: string): undefined => { events.push(["unavailable", container]); return undefined; };
    } });
    const app = createLocalhostProxyVerifier(ports);
    expect(events).toEqual([]);
    app.setup("owned");
    expect(events).toEqual(["platform", ["reach", "owned", 1500], ["listener", "owned"],
        "get:unavailable", ["unavailable", "owned"]]);
});
it.each(["reach", "listener"])("a raw %s failure propagates before any notification", operation => {
    const { events, ports } = verifierFixture(); const failure = {};
    if (operation === "reach") ports.directReach = (container, timeout) => { events.push(["reach", container, timeout]); throw failure; };
    else ports.proxyListenerPresent = container => { events.push(["listener", container]); throw failure; };
    let observed: unknown;
    try { createLocalhostProxyVerifier(ports).setup("owned"); } catch (error) { observed = error; }
    expect(observed).toBe(failure);
    expect(events).toEqual(["platform", ["reach", "owned", 1500],
        ...(operation === "listener" ? [["listener", "owned"]] : [])]);
});
it("routing constructor leaves getter-backed dial capability lazy until after buffering", async () => {
    const events: unknown[] = []; const client = new Stream("client",events); const upstream = new Stream("upstream",events);
    const ports = { get connect() { events.push("get:connect"); return async (host: string,port: number) => {events.push(["connect",host,port]);return upstream;}; } };
    const app = createLocalhostProxy<object,Stream>(ports); expect(events).toEqual([]);
    await app.proxyConnection(client,80); expect(events.slice(0,3)).toEqual([["client","on","data"],"get:connect",["connect","127.0.0.1",80]]);
});
