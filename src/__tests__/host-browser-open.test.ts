import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {request, createServer, type Server} from "node:http";
import {connect} from "node:net";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const native = vi.hoisted(() => ({home: "", inputs: [] as Buffer[], spawn: vi.fn(), spawnSync: vi.fn()}));
vi.mock("os", async original => ({...await original<typeof import("os")>(), homedir: () => native.home}));
vi.mock("child_process", async original => ({...await original<typeof import("child_process")>(), spawn: native.spawn, spawnSync: native.spawnSync}));
vi.mock("@ccc/device-lab/windows-system-powershell.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/windows-system-powershell.js")>(),
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

const token = "private-browser-open-token";
const literalUrl = "https://example.invalid/route?q=%22%20%24%28touch%20unexpected%29%3B&quote='&value=$(touch%20unexpected)`literal`#fixture";
let home: string;
let server: Server | undefined;
let port: number;
let mod: typeof import("../clipboard-server.js");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ccc-host-browser-test-")); native.home = home;
    vi.resetModules(); vi.clearAllMocks(); native.inputs = [];
    native.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {unref: vi.fn(), kill: vi.fn(), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()});
        child.stdin.on("data", chunk => native.inputs.push(Buffer.from(chunk)));
        queueMicrotask(() => {child.emit("spawn"); child.emit("exit", 0); child.emit("close", 0);});
        return child;
    });
    native.spawnSync.mockReturnValue({status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
    mod = await import("../clipboard-server.js");
});
afterEach(async () => {
    if (server) {server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;}
    Object.defineProperty(process, "platform", originalPlatform);
    rmSync(home, {recursive: true, force: true}); vi.restoreAllMocks();
});

async function start(platform: "darwin" | "linux-x11" | "windows" | "unsupported" = "darwin") {
    const service = mod.createClipboardServer(token, platform); server = service.server;
    port = await service.start("127.0.0.1"); native.spawn.mockClear(); native.spawnSync.mockClear(); native.inputs = [];
}
function send(body: Buffer | string, headers: Record<string, string> = {}, method = "POST", path = "/host/open-url") {
    return new Promise<{status: number; body: string}>((resolve, reject) => {
        const req = request({hostname: "127.0.0.1", port, path, method, timeout: 2500,
            headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json;charset=utf-8", ...headers}}, res => {
            let output = ""; res.on("data", chunk => {output += chunk;}); res.once("end", () => resolve({status: res.statusCode ?? 0, body: output})); res.once("error", reject);
        });
        req.once("error", reject); req.once("timeout", () => req.destroy(new Error("private browser HTTP request timed out"))); req.end(body);
    });
}
function nativeCalls(): unknown[][] {return [...native.spawn.mock.calls, ...native.spawnSync.mock.calls];}

describe("authenticated host browser HTTP boundary", () => {
    it.each([["darwin", "/usr/bin/open"], ["linux-x11", "/usr/bin/xdg-open"]] as const)("opens a validated URL as one literal argument on %s", async (platform, executable) => {
        await start(platform);
        expect((await send(JSON.stringify({url: literalUrl}))).status).toBe(204);
        const calls = nativeCalls(); expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(executable); expect(calls[0][1]).toEqual([new URL(literalUrl).href]);
        expect(calls[0][2]).toMatchObject({shell: false});
    });

    it("accepts absolute http URLs while preserving a fragment and query as data", async () => {
        await start(); const url = "http://example.invalid/path?quoted=%22value%22#fragment";
        expect((await send(JSON.stringify({url}))).status).toBe(204);
        expect(nativeCalls()[0][1]).toEqual([url]);
    });

    it("sends Windows URL data on stdin rather than embedding it in native command source", async () => {
        Object.defineProperty(process, "platform", {...originalPlatform, value: "win32"});
        await start("windows");
        expect((await send(JSON.stringify({url: literalUrl}))).status).toBe(204);
        const calls = nativeCalls(); expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        expect(calls[0][1]).not.toContain(literalUrl);
        expect((calls[0][1] as string[]).join(" ")).not.toContain(new URL(literalUrl).href);
        expect(calls[0][2]).toMatchObject({shell: false, windowsHide: true});
        expect(Buffer.from(Buffer.concat(native.inputs).toString("ascii"), "base64").toString("utf8")).toBe(new URL(literalUrl).href);
    });

    it("reports an unsupported native platform without executing", async () => {
        await start("unsupported"); expect((await send(JSON.stringify({url: literalUrl}))).status).toBe(501);
        expect(nativeCalls()).toEqual([]);
    });

    it("authenticates before reading an unfinished request body or invoking a native opener", async () => {
        await start();
        const response = await new Promise<number>((resolve, reject) => {
            const req = request({hostname: "127.0.0.1", port, method: "POST", path: "/host/open-url", timeout: 2000,
                headers: {Authorization: "Bearer wrong-token", "Content-Type": "application/json", "Content-Length": "99999999"}}, res => {
                res.resume(); res.once("end", () => resolve(res.statusCode ?? 0));
                res.once("end", () => req.destroy());
            });
            req.once("error", reject); req.once("timeout", () => req.destroy(new Error("Authentication waited for request body")));
            req.flushHeaders();
        });
        expect(response).toBe(401); expect(nativeCalls()).toEqual([]);
    });

    it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.invalid/data", "https://user:secret@example.invalid/",
        "https://example.invalid/has space", "https://example.invalid/line\nnext", "https://example.invalid/\u0000", "https://example.invalid/\u007f",
        "https:\\example.invalid", "https:///", "//example.invalid/path", "relative/path"])("rejects unsafe URL data %j without a native call", async url => {
        await start(); expect((await send(JSON.stringify({url}))).status).toBe(400); expect(nativeCalls()).toEqual([]);
    });

    it.each(["{", "null", '"https://example.invalid"', "[]", "{}", '{"url":1}', '{"url":"https://example.invalid","command":"open"}'])("rejects malformed or noncontract JSON %j without a native call", async body => {
        await start(); expect((await send(body)).status).toBe(400); expect(nativeCalls()).toEqual([]);
    });

    it("rejects invalid UTF-8 and wrong content types without executing", async () => {
        await start();
        expect((await send(Buffer.from([0x7b, 0x22, 0x75, 0x72, 0x6c, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))).status).toBe(400);
        expect((await send(JSON.stringify({url: literalUrl}), {"Content-Type": "text/plain"})).status).toBe(415);
        expect(nativeCalls()).toEqual([]);
    });

    it("refuses an oversized declared or streamed JSON body without executing", async () => {
        await start(); const body = JSON.stringify({url: `https://example.invalid/${"a".repeat(8192)}`});
        expect((await send(body, {"Content-Length": String(Buffer.byteLength(body))})).status).toBe(413);
        expect((await send(body, {"Transfer-Encoding": "chunked"})).status).toBe(413);
        expect(nativeCalls()).toEqual([]);
    });

    it("does not open a URL from an incomplete request body", async () => {
        await start();
        await new Promise<void>((resolve, reject) => {
            const socket = connect({host: "127.0.0.1", port});
            socket.setTimeout(2500, () => socket.destroy(new Error("Incomplete request did not close")));
            socket.once("error", error => (error as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve() : reject(error));
            socket.once("close", () => resolve()); socket.on("data", () => {});
            socket.once("connect", () => socket.end(`POST /host/open-url HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{"url":"https://example.invalid/"`));
        });
        expect(nativeCalls()).toEqual([]);
        expect((await send("", {}, "GET", "/health")).status).toBe(200);
    });

    it.each(["spawn", "exit"] as const)("reports native %s failure without claiming browser launch acceptance", async failure => {
        await start();
        if (failure === "spawn") native.spawn.mockImplementation(() => {throw new Error("private native launch failure");});
        else native.spawn.mockImplementation(() => {
            const child = Object.assign(new EventEmitter(), {kill: vi.fn(), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()});
            queueMicrotask(() => {child.emit("exit", 9); child.emit("close", 9);}); return child;
        });
        const response = await send(JSON.stringify({url: literalUrl})); expect(response.status).toBe(502);
        expect(response.body).not.toContain(token); expect(response.body).not.toContain(literalUrl);
    });
});

describe.skipIf(process.platform === "win32")("actual container host-browser shell client", () => {
    let requests: Array<{path: string; method: string; auth?: string; type?: string; body: string}>;
    let responseStatus: number;
    let neverRespond: boolean;
    let endpoint: string;
    const script = fileURLToPath(new URL("../../scripts/clipboard-shims/ccc-open-url", import.meta.url));
    beforeEach(async () => {
        requests = []; responseStatus = 204; neverRespond = false;
        server = createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            requests.push({path: req.url ?? "", method: req.method ?? "", auth: req.headers.authorization,
                type: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8")});
            if (!neverRespond) res.writeHead(responseStatus).end();
        });
        await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
        endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    });
    async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
        const {spawn} = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
            const child = spawn("sh", [script, ...args], {cwd: home, env: {...process.env, HOME: home, TMPDIR: home, ENV: "", BASH_ENV: "",
                CCC_CLIPBOARD_URL: endpoint, CCC_CLIPBOARD_TOKEN: token, CCC_CLIPBOARD_GENERATION: "0123456789ab", ...overrides},
            stdio: ["ignore", "pipe", "pipe"]});
            let stdout = "", stderr = "";
            const timeout = setTimeout(() => {child.kill("SIGKILL"); reject(new Error("Browser shell client did not terminate"));}, 13_000);
            child.stdout.on("data", chunk => {stdout += chunk;}); child.stderr.on("data", chunk => {stderr += chunk;});
            child.once("error", error => {clearTimeout(timeout); reject(error);});
            child.once("close", code => {clearTimeout(timeout); resolve({code, stdout, stderr});});
        });
    }
    it("posts metacharacters and quoting as JSON URL data to its paired authenticated endpoint", async () => {
        const result = await run([literalUrl]); expect(result.code, result.stderr).toBe(0);
        expect(requests).toEqual([{path: "/host/open-url", method: "POST", auth: `Bearer ${token}`,
            type: expect.stringMatching(/^application\/json(?:;\s*charset=utf-8)?$/i), body: expect.any(String)}]);
        expect(JSON.parse(requests[0].body)).toEqual({url: literalUrl});
        expect(result.stdout).toBe(""); expect(result.stderr).not.toContain(token);
    });
    it.each([[], [literalUrl, "extra"], ["--help", literalUrl]].map(args => ({args})))("rejects wrong argument count $args without contacting the host", async ({args}) => {
        const result = await run(args); expect(result.code).not.toBe(0); expect(requests).toEqual([]);
    });
    it.each(["", "not-a-generation", "0123456789a", "0123456789abc"])("refuses an unqualified generation %j without contacting the host", async generation => {
        const result = await run([literalUrl], {CCC_CLIPBOARD_GENERATION: generation});
        expect(result.code).not.toBe(0); expect(requests).toEqual([]);
    });
    it.each([401, 404, 413, 502])("returns nonzero for host HTTP %i", async status => {
        responseStatus = status; const result = await run([literalUrl]);
        expect(result.code).not.toBe(0); expect(requests).toHaveLength(1); expect(result.stderr).not.toContain(token);
    });
    it("returns nonzero when the private HTTP endpoint never responds", async () => {
        neverRespond = true; const result = await run([literalUrl]);
        expect(result.code).not.toBe(0); expect(requests).toHaveLength(1); expect(result.stderr).not.toContain(token);
    }, 15_000);
});
