import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const frozen = resolve(root, "doc/harness/checkpoints/localhost-proxy-20261009/baseline");
// Evaluate the actual complete facade and its inward dependencies; replace only
// native effects. No copied routing or setup business body is used as the oracle.
function load(tree: string, entry: string, effects: Record<string, unknown>, globals: Record<string, unknown>) {
    const cache = new Map<string, Record<string, any>>();
    function evaluate(file: string): Record<string, any> {
        if (cache.has(file)) return cache.get(file)!;
        const exports: Record<string, any> = {}; cache.set(file, exports);
        const source = readFileSync(file, "utf8");
        const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        runInNewContext(compiled, { exports, ...globals, require: (name: string) => {
            if (Object.hasOwn(effects, name)) return effects[name];
            if (!name.startsWith(".")) throw new Error(`Unfenced effect: ${name}`);
            return evaluate(resolve(dirname(file), name.replace(/\.js$/, ".ts")));
        } }, { filename: file });
        return exports;
    }
    return evaluate(resolve(tree, entry));
}

async function routing(tree: string, mode: string) {
    const events: unknown[] = []; const fault = { mode }; const chunks = [{ id: 1 }, { id: 2 }];
    let attempts = 0; let timerId = 0;
    const timers = new Map<number, () => void>();
    class Stream {
        listeners = new Map<string, ((...args: any[]) => void)[]>();
        constructor(readonly name: string) {}
        on(event: string, listener: (...args: any[]) => void) {
            events.push([this.name, "on", event]);
            if (mode === "buffer-throw" && event === "data") throw fault;
            if (mode === "connect-listener-throw" && event === "connect") throw fault;
            if (mode === "error-listener-throw" && event === "error" && this.name !== "client") throw fault;
            this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this;
        }
        emit(event: string, ...args: any[]) { for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args); }
        removeListener(event: string, listener: (...args: any[]) => void) {
            events.push([this.name, "remove", event, this.listeners.get(event)?.includes(listener)]);
            if (mode === "remove-throw") throw fault;
            this.listeners.set(event, (this.listeners.get(event) ?? []).filter(fn => fn !== listener)); return this;
        }
        write(chunk: unknown) {
            events.push([this.name, "write", chunks.indexOf(chunk as typeof chunks[number])]);
            if (mode === "flush-throw") throw fault; return false;
        }
        pipe(peer: Stream) { events.push([this.name, "pipe", peer.name]); if (mode === "pipe-throw") throw fault; return peer; }
        destroy() { events.push([this.name, "destroy"]); if (mode === "destroy-throw") throw fault; return this; }
    }
    const client = new Stream("client"); const upstreams: Stream[] = [];
    let dispatch: ((client: Stream) => void) | undefined;
    const native = {
        createConnection(options: unknown) {
            if (mode === "create-throw") throw fault;
            events.push(["dial", options]); const stream = new Stream(`upstream${++attempts}`); upstreams.push(stream);
            client.emit("data", chunks[(attempts - 1) % chunks.length]);
            queueMicrotask(() => {
                if (mode === "timeout") {
                    for (const callback of [...timers.values()]) callback();
                    stream.emit("connect"); stream.emit("error", fault);
                } else stream.emit(mode === "both-fail" || mode === "destroy-throw" || (mode === "fallback" && attempts === 1) ? "error" : "connect", fault);
            });
            return stream;
        },
        createServer(callback: (client: Stream) => void) {
            dispatch = callback; events.push("server:create");
            return { on(event: string) { events.push(["server:on", event]); return this; },
                listen(port: number, host: string, ready: () => void) { events.push(["listen", port, host]); ready(); },
                close() { events.push("server:close"); if (mode === "stop-throw") throw fault; } };
        },
    };
    const api = load(tree, "src/localhost-proxy.ts", { net: native }, {
        Promise, Error, setTimeout(callback: () => void, ms: number) { events.push(["timer", ms]); timers.set(++timerId, callback); return timerId; },
        clearTimeout(id: number) { events.push(["clear", id]); timers.delete(id); },
    });
    let error: unknown; let result: unknown;
    try {
        if (mode.startsWith("server") || mode === "stop-throw") {
            const server = await api.startProxy(0);
            if (mode === "server-missing") dispatch!(client);
            if (mode === "server-malformed") dispatch!(Object.assign(client, { _handle: { getsockopt: () => ({ length: 7 }) } }));
            if (mode === "server-metadata") {
                dispatch!(Object.assign(client, { _handle: { getsockopt(level: number, option: number) {
                    events.push(["getsockopt", this === (client as any)._handle, level, option]);
                    return { length: 8, readUInt16BE(offset: number) { events.push(["readPort", offset]); return 0; } };
                } } }));
                await Promise.resolve(); await Promise.resolve();
            }
            api.stopProxy(server);
        } else {
            const promise = api.proxyConnection(client, mode === "port-zero" ? 0 : 123, "local", "host", mode === "host-zero" ? 0 : undefined);
            if (mode === "early-close") client.emit("close");
            result = await promise;
            if (mode === "local") {
                client.emit("error", fault); upstreams[0].emit("error", fault);
                client.emit("close"); upstreams[0].emit("close");
            }
        }
    } catch (caught) { error = caught === fault ? "raw" : String(caught); }
    return { result, error, events, bufferingListeners: client.listeners.get("data")?.length ?? 0 };
}

function setup(tree: string, mode: string) {
    const events: unknown[] = []; const fault = { mode }; const consoleMock = {} as Record<string, unknown>;
    for (const method of ["warn", "error"]) Object.defineProperty(consoleMock, method, { get() {
        events.push(`get:${method}`);
        return function(this: unknown, message: string) { events.push([method, this === consoleMock, message]); if (mode === "warning-throw" && method === "warn") throw fault; };
    } });
    const native = { get spawnSync() { events.push("get:spawn"); return function(this: unknown, command: string, args: unknown, options: unknown) {
        events.push(["spawn", this === undefined || this === native, command, args, options]);
        return { get error() { events.push("result:error"); return mode === "probe-error" ? fault : undefined; },
            get status() { events.push("result:status"); return mode === "missing" || mode === "warning-throw" || mode === "runtime-throw" ? 1 : 0; } };
    }; } };
    let runtimeReads = 0;
    const runtime = { runtimeCli() { events.push("runtime"); if (++runtimeReads === 2 && mode === "runtime-throw") throw fault; return mode === "podman" ? "podman" : "docker"; },
        isContainerHostRemote() { events.push("remote"); return mode === "linux-remote"; } };
    const api = load(tree, "src/localhost-proxy-setup.ts", {
        child_process: native, "./localhost-proxy.js": { PROXY_PORT: 19999 }, "./container-runtime.js": runtime,
        "./network-reach.js": { detectHostNetworkReach(container: string, options: unknown) {
            events.push(["reach", container, options]); return { get reachable() { events.push("reachable"); return mode === "reachable" || mode === "debug"; },
                get latencyMs() { events.push("latency"); return 7; } };
        } },
    }, { console: consoleMock, process: { get platform() { events.push("platform"); return mode.startsWith("linux") ? "linux" : "darwin"; },
        env: { get DEBUG() { events.push("debug"); return mode === "debug" ? "1" : undefined; } } } });
    const constructorEvents = [...events]; let error: unknown;
    try { api.setupLocalhostProxy("owned-container"); } catch (caught) { error = caught === fault ? "raw" : String(caught); }
    return { constructorEvents, error, events };
}

it.each(["local", "fallback", "both-fail", "buffer-throw", "flush-throw", "pipe-throw", "remove-throw", "port-zero", "host-zero", "early-close", "connect-listener-throw", "error-listener-throw", "create-throw", "timeout", "server", "server-missing", "server-malformed", "server-metadata", "stop-throw"])("actual complete TS source retains original trace: %s", async mode => {
    expect(existsSync(resolve(frozen, "src/localhost-proxy.ts"))).toBe(true);
    const baseline = await routing(frozen, mode);
    expect(await routing(root, mode)).toEqual(baseline);
    if (mode === "both-fail") expect(baseline.bufferingListeners).toBe(1);
    if (mode === "flush-throw" || mode === "pipe-throw" || mode === "buffer-throw") expect(baseline.error).toBe("raw");
});
it.each(["linux-local", "linux-remote", "reachable", "debug", "missing", "probe-error", "podman", "warning-throw", "runtime-throw"])("actual selected-runtime verifier retains lookup/receiver/getter/fault trace: %s", mode => {
    const baseline = setup(frozen, mode);
    expect(setup(root, mode)).toEqual(baseline);
    expect(baseline.constructorEvents).toEqual([]);
    if (mode === "probe-error") expect(baseline.events).not.toContain("result:status");
});

it("native connect schedules exactly 3000ms, rejects raw errors, and retains late-event behavior", async () => {
    for (const tree of [frozen, root]) {
        const events: unknown[] = []; const callbacks = new Map<string, (...args: any[]) => void>();
        let now = 0; let due = 0; let timeout!: () => void; const raw = {};
        const socket = { on(event: string, fn: (...args: any[]) => void) { events.push(["on", event]); callbacks.set(event, fn); return this; }, destroy() { events.push("destroy"); return this; } };
        const api = load(tree, "src/localhost-proxy.ts", { net: { createConnection(options: unknown) { events.push(["create", options]); return socket; } } }, {
            Promise, Error, setTimeout(fn: () => void, ms: number) { due = now + ms; timeout = fn; events.push(["timer", ms]); return 1; },
            clearTimeout(id: number) { events.push(["clear", id]); due = Infinity; },
        });
        const pending = api.tryConnect("owned", 41);
        const rejected = expect(pending).rejects.toThrow("Connection timeout to owned:41");
        expect(events).toEqual([["create", {host:"owned",port:41}], ["timer",3000], ["on","connect"], ["on","error"]]);
        now = 2999; expect(now < due).toBe(true); expect(events).not.toContain("destroy");
        now = 3000; if (now >= due) timeout(); await rejected;
        callbacks.get("connect")!(); callbacks.get("error")!(raw);
        expect(events.slice(-4)).toEqual(["destroy",["clear",1],["clear",1],"destroy"]);
        events.length = 0; const second = api.tryConnect("owned",42); const rawRejected = expect(second).rejects.toBe(raw);
        callbacks.get("error")!(raw); await rawRejected; expect(events.slice(-2)).toEqual([["clear",1],"destroy"]);
    }
});

it("retained native TS mechanisms and entrypoint/module/build assets match immutable bytes", () => {
    const original = ts.createSourceFile("baseline.ts", readFileSync(resolve(frozen,"src/localhost-proxy.ts"),"utf8"),ts.ScriptTarget.ES2022,true);
    const candidate = ts.createSourceFile("candidate.ts", readFileSync(resolve(root,"src/localhost-proxy.ts"),"utf8"),ts.ScriptTarget.ES2022,true);
    for (const name of ["tryConnect","startProxy","stopProxy"]) {
        const find = (source: ts.SourceFile) => source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name)?.getText(source);
        expect(find(candidate)).toBe(find(original)); expect(find(original)).toBeDefined();
    }
    for (const file of ["scripts/ccc-entrypoint.sh","scripts/localhost-proxy/go.mod","Dockerfile","Containerfile","src/index.ts","src/network-reach.ts"]) {
        expect(readFileSync(resolve(root,file))).toEqual(readFileSync(resolve(frozen,file)));
    }
});
