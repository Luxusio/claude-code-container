import { expect, it } from "vitest";
import { createLocalhostProxy } from "../../application/localhost-proxy.js";
import { createLocalhostProxyVerifier } from "../../application/localhost-proxy-setup.js";

class Stream {
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    writes: object[] = [];
    pipes: Stream[] = [];
    destroyed = false;
    destroyCalls = 0;
    constructor(readonly name: string, readonly events: unknown[]) {}
    on(event: string, listener: (...args: any[]) => void): this { this.events.push([this.name, "on", event]); this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
    removeListener(event: string, listener: (...args: any[]) => void): this { this.events.push([this.name, "remove", event]); this.listeners.set(event, (this.listeners.get(event) ?? []).filter(fn => fn !== listener)); return this; }
    write(chunk: object): boolean { this.writes.push(chunk); this.events.push([this.name, "write", chunk]); return false; }
    pipe(peer: Stream): Stream { this.pipes.push(peer); this.events.push([this.name, "pipe", peer.name]); return peer; }
    destroy(): this { this.destroyed = true; this.destroyCalls++; this.events.push([this.name, "destroy"]); return this; }
    emit(event: string, ...args: any[]): void {
        const listeners = this.listeners.get(event) ?? [];
        if (event === "error" && listeners.length === 0) throw args[0];
        for (const fn of listeners) fn(...args);
    }
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
function expectNoForwarding(client: Stream, upstream: Stream) {
    expect(upstream.writes).toEqual([]);
    expect(client.pipes).toEqual([]);
    expect(upstream.pipes).toEqual([]);
}
it("buffers original objects in FIFO order while local dial is pending, then forwards both ways", async () => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    const first = {}; const second = {}; const dial = deferred<Stream>();
    const app = createLocalhostProxy<object, Stream>({ connect: (host, port) => { events.push(["connect", host, port]); return dial.promise; } });
    expect(events).toEqual([]);
    const completion = app.proxyConnection(client, 8123);
    client.emit("data", first); client.emit("data", second);
    expectNoForwarding(client, upstream);
    dial.resolve(upstream); expect(await completion).toBeUndefined();
    expect(upstream.writes).toHaveLength(2);
    expect(upstream.writes[0]).toBe(first); expect(upstream.writes[1]).toBe(second);
    expect(client.pipes).toEqual([upstream]); expect(upstream.pipes).toEqual([client]);
    expect(client.listeners.get("data")).toHaveLength(0);
    client.emit("data", {}); expect(upstream.writes).toHaveLength(2);
});
it.each(["error", "close"])("established %s events clean up the counterpart", async event => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    await createLocalhostProxy<object, Stream>({connect: async () => upstream}).proxyConnection(client, 80);
    client.emit(event, new Error("client terminated")); expect(upstream.destroyed).toBe(true);
    upstream.emit(event, new Error("upstream terminated")); expect(client.destroyed).toBe(true);
});
it.each(["close", "error"])("a client %s during the local dial discards input and destroys a late upstream", async event => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    const dial = deferred<Stream>(); const calls: unknown[] = [];
    const completion = createLocalhostProxy<object, Stream>({connect: (host, port) => { calls.push([host, port]); return dial.promise; }}).proxyConnection(client, 80);
    client.emit("data", {}); client.emit(event, new Error("client terminated"));
    expect(client.listeners.get("data")).toHaveLength(0);
    client.emit("data", {}); dial.resolve(upstream); await completion;
    expect(calls).toEqual([["127.0.0.1", 80]]);
    expect(upstream.destroyed).toBe(true); expectNoForwarding(client, upstream);
});
it.each(["close", "error", "destroyed"])("a client %s prevents fallback after the pending local dial rejects", async event => {
    const events: unknown[] = []; const client = new Stream("client", events); const dial = deferred<Stream>(); const calls: unknown[] = [];
    const completion = createLocalhostProxy<object, Stream>({connect: (host, port) => { calls.push([host, port]); return dial.promise; }}).proxyConnection(client, 80);
    client.emit("data", {});
    if (event === "destroyed") client.destroyed = true;
    else client.emit(event, new Error("client terminated"));
    dial.reject({code: "arbitrary local rejection"}); await completion;
    expect(calls).toEqual([["127.0.0.1", 80]]);
    expect(client.listeners.get("data")).toHaveLength(0); expect(client.pipes).toEqual([]);
});
it.each(["close", "error"])("a client %s during fallback destroys the late host connection without forwarding", async event => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    const fallback = deferred<Stream>(); const fallbackStarted = deferred<void>(); const calls: unknown[] = [];
    const completion = createLocalhostProxy<object, Stream>({connect: async (host, port) => {
        calls.push([host, port]);
        if (calls.length === 1) throw {code: "unrelated local error"};
        fallbackStarted.resolve(); return fallback.promise;
    }}).proxyConnection(client, 80, "local", "host", 81);
    await fallbackStarted.promise;
    client.emit("data", {}); client.emit(event, new Error("client terminated"));
    expect(client.listeners.get("data")).toHaveLength(0);
    fallback.resolve(upstream); await completion;
    expect(calls).toEqual([["local", 80], ["host", 81]]);
    expect(upstream.destroyed).toBe(true); expectNoForwarding(client, upstream);
});
it("observes native destruction before close is delivered", async () => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events); const dial = deferred<Stream>();
    const completion = createLocalhostProxy<object, Stream>({connect: () => dial.promise}).proxyConnection(client, 80);
    client.emit("data", {}); client.destroyed = true;
    dial.resolve(upstream); await completion;
    expect(upstream.destroyed).toBe(true); expectNoForwarding(client, upstream);
    expect(() => client.emit("error", new Error("deferred native error"))).not.toThrow();
    client.emit("close");
});
it("an already destroyed client never dials and still observes a deferred native error", async () => {
    const events: unknown[] = []; const client = new Stream("client", events); const calls: unknown[] = [];
    client.destroyed = true;
    await createLocalhostProxy<object, Stream>({connect: async (host, port) => { calls.push([host, port]); return new Stream("unused", events); }}).proxyConnection(client, 80);
    expect(calls).toEqual([]); expect(client.pipes).toEqual([]);
    expect(() => client.emit("error", new Error("deferred native error"))).not.toThrow();
    client.emit("close");
});
it.each([undefined, 0, 9191])("every raw local rejection falls back using nullish host port %s", async hostPort => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events); const fault = { code: "UNRELATED" }; let attempt = 0;
    const app = createLocalhostProxy<object, Stream>({ connect: async (host, port) => { events.push(["connect", host, port]); if (++attempt === 1) throw fault; return upstream; } });
    await app.proxyConnection(client, 0, "local", "host", hostPort);
    expect(events.filter(event => Array.isArray(event) && event[0] === "connect")).toEqual([["connect", "local", 0], ["connect", "host", hostPort ?? 0]]);
});
it("both rejected dials destroy a live client and detach its pending input", async () => {
    const events: unknown[] = []; const client = new Stream("client", events);
    const completion = createLocalhostProxy<object, Stream>({ connect: async () => { throw null; } }).proxyConnection(client, 80);
    client.emit("data", {}); await completion;
    expect(client.destroyCalls).toBe(1); expect(client.listeners.get("data")).toHaveLength(0);
    expect(client.pipes).toEqual([]);
    expect(() => client.emit("error", new Error("deferred destroy error"))).not.toThrow();
});
it.each(["write", "pipe", "destroy"] as const)("raw %s throws preserve partial effects", async operation => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events); const raw = {};
    if (operation === "write") upstream.write = () => { upstream.emit("close"); throw raw; };
    if (operation === "pipe") client.pipe = () => { upstream.emit("close"); throw raw; };
    if (operation === "destroy") client.destroy = () => { throw raw; };
    let dials = 0;
    const completion = createLocalhostProxy<object, Stream>({ connect: async () => { dials++; if (operation === "destroy") throw raw; return upstream; } }).proxyConnection(client, 80);
    client.emit("data", {});
    await expect(completion).rejects.toBe(raw);
    expect(dials).toBe(operation === "destroy" ? 2 : 1);
    if (operation !== "destroy") expect(client.destroyed).toBe(true);
    expect(client.listeners.get("data")).toHaveLength(0);
});
it("a raw late-upstream destroy failure is not mistaken for a dial failure", async () => {
    const events: unknown[] = []; const client = new Stream("client", events); const upstream = new Stream("upstream", events);
    const raw = {}; const dial = deferred<Stream>(); let dials = 0;
    upstream.destroy = () => { throw raw; };
    const completion = createLocalhostProxy<object, Stream>({connect: () => { dials++; return dial.promise; }}).proxyConnection(client, 80);
    client.emit("data", {}); client.emit("close"); dial.resolve(upstream);
    await expect(completion).rejects.toBe(raw);
    expect(dials).toBe(1); expectNoForwarding(client, upstream);
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
    const pending = {};
    const ports = { get connect() { events.push("get:connect"); client.emit("data", pending); return async (host: string,port: number) => {events.push(["connect",host,port]);return upstream;}; } };
    const app = createLocalhostProxy<object,Stream>(ports); expect(events).toEqual([]);
    await app.proxyConnection(client,80);
    expect(upstream.writes).toEqual([pending]); expect(upstream.writes[0]).toBe(pending);
    expect(events.filter(event => event === "get:connect")).toHaveLength(1);
    expect(events.filter(event => Array.isArray(event) && event[0] === "connect")).toEqual([["connect","127.0.0.1",80]]);
});
