import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, mkdirSync, renameSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { createInterface } from "readline";
import { once } from "events";

const script = resolve("scripts/ccc-x11-bridge");
const policy = resolve("scripts/lib/clipboard-x11-sync.sh");
const available = existsSync("/usr/bin/Xvfb") && existsSync("/usr/bin/xclip");
let dir: string;
let display: string;
let env: NodeJS.ProcessEnv;
let server: Server;
let extraServers: Server[];
let hostText: Buffer;
let hostImage: Buffer | null;
let token: string;
let failPosts: boolean;
let failHostReads: boolean;
let deferTextRead: boolean;
let releaseTextRead: (() => void) | undefined;
let posts: Buffer[];
let requests: { method: string; path: string; auth: string | undefined }[];
let procs: ChildProcess[];
let control: ChildProcess;
let lines: string[];
let stderr: string;

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 4000) {
    const end = Date.now() + timeout;
    while (!await check()) {
        if (Date.now() > end) throw new Error(`Condition timed out. Bridge stderr: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function command(executable: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => execFile(executable, args, { env, encoding: "buffer", timeout: 3000, maxBuffer: 2 * 1048576 },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function own(text: Buffer, target = "UTF8_STRING") {
    const proc = spawn("/usr/bin/xclip", ["-selection", "clipboard", "-t", target, "-i", "-quiet"], { env, stdio: ["pipe", "ignore", "ignore"] });
    procs.push(proc);
    proc.stdin!.end(text);
    await waitFor(async () => {
        try { return (await read(target)).equals(text); }
        catch { return false; }
    });
    return proc;
}

const read = (target = "UTF8_STRING") => command("/usr/bin/xclip", ["-selection", "clipboard", "-t", target, "-o"]);

async function startControl(identity: { uid?: number; gid?: number } = {}) {
    control = spawn("bash", ["-c", 'source "$1"; bridge_init; echo READY; while IFS= read -r action; do if [ "$action" = cycle ]; then bridge_cycle; echo "DONE:$?"; else bridge_cleanup; exit; fi; done', "test-bridge", script], { env, stdio: ["pipe", "pipe", "pipe"], ...identity });
    procs.push(control);
    createInterface({ input: control.stdout! }).on("line", line => lines.push(line));
    control.stderr!.on("data", chunk => { stderr += chunk; });
    await waitFor(() => lines.includes("READY"));
}

async function cycle() {
    const before = lines.filter(line => line.startsWith("DONE:")).length;
    control.stdin!.write("cycle\n");
    await waitFor(() => lines.filter(line => line.startsWith("DONE:")).length > before, 10000);
    return lines.filter(line => line.startsWith("DONE:")).at(-1);
}

function clipboardServer(credential: () => string = () => token, requestLog: () => typeof requests = () => requests,
    snapshot?: { image: Buffer | null; text: Buffer }): Server {
    return createServer((req, res) => {
        requestLog().push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
        if (req.headers.authorization !== `Bearer ${credential()}`) { res.writeHead(401).end(); return; }
        if (req.method === "GET" && failHostReads) { res.writeHead(503).end("Clipboard read failed"); return; }
        if (req.method === "POST" && req.url === "/clipboard/text") {
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(chunk));
            req.on("end", () => {
                const body = Buffer.concat(chunks);
                posts.push(body);
                if (failPosts) { res.writeHead(503).end(); return; }
                if (snapshot) { snapshot.text = body; snapshot.image = null; }
                else { hostText = body; hostImage = null; }
                res.writeHead(204).end();
            });
        } else if (req.url === "/clipboard/image/png") {
            const image = snapshot ? snapshot.image : hostImage;
            res.writeHead(image ? 200 : 204).end(image ?? undefined);
        } else if (req.url === "/clipboard/text") {
            const text = snapshot ? snapshot.text : hostText;
            const send = () => res.writeHead(text.length ? 200 : 204).end(text);
            if (deferTextRead) releaseTextRead = send;
            else send();
        } else res.writeHead(404).end();
    });
}

async function privateEndpoint(credential: string, snapshot?: { image: Buffer | null; text: Buffer }) {
    const endpointRequests: typeof requests = [];
    const endpoint = clipboardServer(() => credential, () => endpointRequests, snapshot);
    extraServers.push(endpoint);
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    return { port: (endpoint.address() as { port: number }).port, requests: endpointRequests };
}

function launchBridge(args: string[] = []) {
    const proc = spawn("bash", [script, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr!.on("data", chunk => { stderr += chunk; });
    procs.push(proc);
    return proc;
}

async function waitUntilBridgeReady() {
    const waiter = launchBridge(["--wait-ready"]);
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Bridge readiness did not settle. ${stderr}`)), 15000);
        waiter.once("error", error => { clearTimeout(timeout); reject(error); });
        waiter.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
}

describe.skipIf(!available)("real isolated X11 clipboard bridge", () => {
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "ccc-x11-copy-test-"));
        procs = [];
        extraServers = [];
        posts = [];
        requests = [];
        lines = [];
        stderr = "";
        hostText = Buffer.from("host baseline\n\n");
        hostImage = null;
        token = "first-token";
        failPosts = false;
        failHostReads = false;
        deferTextRead = false;
        releaseTextRead = undefined;
        const xvfb = spawn("/usr/bin/Xvfb", ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
        procs.push(xvfb);
        const [number] = await once(xvfb.stdout!, "data");
        display = `:${String(number).trim()}`;
        server = clipboardServer();
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        writeFileSync(join(dir, "port"), `${port}:${token}`);
        env = { ...process.env, DISPLAY: display, DISPLAY_N: display,
            LOCK_DIR: join(dir, "state"), TMPDIR: dir, REAL_XCLIP: "/usr/bin/xclip",
            CCC_CLIPBOARD_URL: `http://127.0.0.1:${port}`, CCC_CLIPBOARD_TOKEN: token,
            CCC_CLIPBOARD_PORT_FILE: join(dir, "port") };
        delete env.CCC_CLIPBOARD_GENERATION;
    });

    afterEach(async () => {
        if (control?.exitCode === null) {
            control.stdin!.write("stop\n");
            await Promise.race([once(control, "exit"), new Promise(resolve => setTimeout(resolve, 500))]);
        }
        for (const proc of procs.reverse()) if (proc.exitCode === null) proc.kill("SIGKILL");
        server?.closeAllConnections();
        if (server) await new Promise<void>(resolve => server.close(() => resolve()));
        for (const endpoint of extraServers) {
            endpoint.closeAllConnections();
            await new Promise<void>(resolve => endpoint.close(() => resolve()));
        }
        rmSync(dir, { recursive: true, force: true });
    });

    it("adopts host startup data before stale local data and never echoes incoming text", async () => {
        await own(Buffer.from("stale local"));
        await startControl();
        await cycle();
        expect(await read()).toEqual(hostText);
        await cycle();
        expect(posts).toEqual([]);
        hostText = Buffer.from("new host 한글 😀\r\n\n");
        await cycle();
        expect(await read()).toEqual(hostText);
        await cycle();
        expect(posts).toEqual([]);
    });

    it("publishes exact UTF-8 bytes and empty clear before host polling, without echo", async () => {
        await startControl();
        await cycle();
        const text = Buffer.from("  한글 😀 ' \"\r\nlast\n\n");
        await own(text);
        requests = [];
        await cycle();
        expect(posts).toEqual([text]);
        expect(requests[0].method).toBe("POST");
        expect(hostText).toEqual(text);
        await cycle();
        expect(posts).toHaveLength(1);
        await own(Buffer.alloc(0));
        await cycle();
        expect(posts).toEqual([text, Buffer.alloc(0)]);
        expect(await read()).toEqual(Buffer.alloc(0));
    });

    it("never posts stale local text while the initial host read fails", async () => {
        const stale = Buffer.from("stale local before startup\n");
        await own(stale);
        failHostReads = true;
        await startControl();
        await cycle();
        await cycle();
        expect(posts).toEqual([]);
        expect(await read()).toEqual(stale);
        failHostReads = false;
        await cycle();
        expect(await read()).toEqual(hostText);
        await cycle();
        expect(posts).toEqual([]);
    });

    it("retains failed local copies for retry even when host changes", async () => {
        await startControl();
        await cycle();
        const local = Buffer.from("retry me\n\n");
        await own(local);
        failPosts = true;
        hostText = Buffer.from("competing host");
        await cycle();
        expect(await read()).toEqual(local);
        expect(posts).toEqual([local]);
        failPosts = false;
        await cycle();
        expect(posts).toEqual([local, local]);
        expect(hostText).toEqual(local);
        await cycle();
        expect(posts).toHaveLength(2);
    });

    it("preserves incoming image bytes and avoids uploading failed text reads", async () => {
        hostImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        await startControl();
        await cycle();
        expect(await read("image/png")).toEqual(hostImage);
        await cycle();
        expect(posts).toEqual([]);
        const local = Buffer.from("replace image with text");
        await own(local);
        await cycle();
        expect(hostText).toEqual(local);
        expect(posts).toEqual([local]);
    });

    it("retains image on host 503 and observes image to text to empty to identical image", async () => {
        const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        hostImage = image;
        await startControl();
        await cycle();
        expect(await read("image/png")).toEqual(image);
        failHostReads = true;
        hostImage = null;
        hostText = Buffer.from("recovered plain text");
        await cycle();
        expect(await read("image/png")).toEqual(image);
        expect(posts).toEqual([]);
        failHostReads = false;
        await cycle();
        expect(await read()).toEqual(hostText);
        expect((await read("TARGETS")).toString()).not.toContain("image/png");
        hostText = Buffer.alloc(0);
        await cycle();
        expect(await read()).toEqual(Buffer.alloc(0));
        hostImage = image;
        await cycle();
        expect(await read("image/png")).toEqual(image);
        expect((await read("TARGETS")).toString()).toContain("image/png");
        await cycle();
        expect(posts).toEqual([]);
    });

    it("uses the pinned current generation instead of pasting the old mounted endpoint's image", async () => {
        const oldImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        hostImage = oldImage;
        const current = { image: null as Buffer | null, text: Buffer.from("current copied text 한글 😀\n") };
        const currentToken = "current-generation-token";
        const endpoint = await privateEndpoint(currentToken, current);
        const legacyRecord = readFileSync(join(dir, "port"));
        env.CCC_CLIPBOARD_URL = `http://127.0.0.1:${endpoint.port}`;
        env.CCC_CLIPBOARD_TOKEN = currentToken;
        env.CCC_CLIPBOARD_GENERATION = "a1b2c3d4e5f6";
        await startControl();
        await cycle();
        expect((await read("TARGETS")).toString()).not.toContain("image/png");
        expect(await read()).toEqual(current.text);
        expect(requests).toEqual([]);
        expect(endpoint.requests.length).toBeGreaterThan(0);
        expect(endpoint.requests.every(request => request.auth === `Bearer ${currentToken}`)).toBe(true);
        expect(readFileSync(join(dir, "port"))).toEqual(legacyRecord);

        current.image = oldImage;
        await cycle();
        expect(await read("image/png")).toEqual(oldImage);
        current.image = null;
        current.text = Buffer.alloc(0);
        await cycle();
        expect(await read()).toEqual(Buffer.alloc(0));
        expect((await read("TARGETS")).toString()).not.toContain("image/png");
        current.image = oldImage;
        await cycle();
        expect(await read("image/png")).toEqual(oldImage);
        expect(posts).toEqual([]);
        expect(requests).toEqual([]);
    });

    it.each([undefined, "not-a-generation"])("keeps mounted endpoint refresh for legacy generation %s", async generation => {
        const current = { image: null as Buffer | null, text: Buffer.from("unselected environment endpoint") };
        const endpoint = await privateEndpoint("unselected-token", current);
        env.CCC_CLIPBOARD_URL = `http://127.0.0.1:${endpoint.port}`;
        env.CCC_CLIPBOARD_TOKEN = "unselected-token";
        if (generation !== undefined) env.CCC_CLIPBOARD_GENERATION = generation;
        await startControl();
        await cycle();
        expect(await read()).toEqual(hostText);
        expect(endpoint.requests).toEqual([]);
        expect(requests.every(request => request.auth === `Bearer ${token}`)).toBe(true);
    });

    it("recovers unchanged host image only after the fixture selection owner exits", async () => {
        const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        const localImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        hostImage = image;
        await startControl();
        await cycle();
        expect(await read("image/png")).toEqual(image);
        const owner = await own(localImage, "image/png");
        expect(await read("image/png")).toEqual(localImage);
        await cycle();
        expect(await read("image/png")).toEqual(localImage);
        expect(posts).toEqual([]);

        const exited = once(owner, "exit");
        owner.kill("SIGTERM");
        await exited;
        await waitFor(async () => {
            try { await read("TARGETS"); return false; }
            catch { return true; }
        });
        expect(procs[0].exitCode).toBeNull();
        await cycle();
        expect(await read("image/png")).toEqual(image);
        expect(posts).toEqual([]);
    });

    it("preserves a foreign image when selection ownership cannot be observed", async () => {
        const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        const localImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        const transport = join(dir, "real-xclip");
        writeFileSync(transport, '#!/bin/sh\nexport DISPLAY="$CCC_FIXTURE_X11_DISPLAY"\nexec /usr/bin/xclip "$@"\n', { mode: 0o700 });
        let unavailableDisplay = 65535;
        while (existsSync(`/tmp/.X11-unix/X${unavailableDisplay}`)) unavailableDisplay -= 1;
        expect(unavailableDisplay).toBeGreaterThan(0);
        env.DISPLAY_N = `:${unavailableDisplay}`;
        env.CCC_FIXTURE_X11_DISPLAY = display;
        env.REAL_XCLIP = transport;
        hostImage = image;
        await startControl();
        await cycle();
        expect(await read("image/png")).toEqual(image);
        await own(localImage, "image/png");
        expect(await read("image/png")).toEqual(localImage);
        await cycle();
        expect(await read("image/png")).toEqual(localImage);
        expect(posts).toEqual([]);
        expect(procs[0].exitCode).toBeNull();
    });

    it("does not report first-sync readiness while host reads fail, then readies exact current text", async () => {
        const stale = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        await own(stale, "image/png");
        failHostReads = true;
        launchBridge();
        await waitFor(() => requests.some(request => request.path === "/clipboard/image/png"));
        const unavailable = await waitUntilBridgeReady();
        expect(unavailable.signal, stderr).toBeNull();
        expect(unavailable.code, stderr).not.toBe(0);
        expect(await read("image/png")).toEqual(stale);
        failHostReads = false;
        const ready = await waitUntilBridgeReady();
        expect(ready, stderr).toEqual({ code: 0, signal: null });
        expect(await read()).toEqual(hostText);
        expect((await read("TARGETS")).toString()).not.toContain("image/png");
        expect(posts).toEqual([]);
    }, 20000);

    it("replaces an owned bridge when its pinned bearer changes on the same endpoint", async () => {
        env.CCC_CLIPBOARD_GENERATION = "a1b2c3d4e5f6";
        const first = launchBridge();
        expect(await waitUntilBridgeReady(), stderr).toEqual({ code: 0, signal: null });
        expect(await read()).toEqual(hostText);
        const legacyRecord = readFileSync(join(dir, "port"));
        token = "rotated-generation-token";
        env.CCC_CLIPBOARD_TOKEN = token;
        hostText = Buffer.from("current text after bearer rotation 한글\n");
        requests = [];
        const replacement = launchBridge();
        const recordPath = join(dir, "state", "running");
        await waitFor(() => existsSync(recordPath) && readFileSync(recordPath, "utf8").split("\n")[0] === String(replacement.pid), 8000);
        await waitFor(() => first.exitCode !== null || first.signalCode !== null);
        expect(await waitUntilBridgeReady(), stderr).toEqual({ code: 0, signal: null });
        expect(await read()).toEqual(hostText);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.auth === `Bearer ${token}`)).toBe(true);
        expect(readFileSync(recordPath, "utf8")).not.toContain(token);
        expect(readFileSync(join(dir, "port"))).toEqual(legacyRecord);
        expect(procs[0].exitCode).toBeNull();
    }, 20000);

    it("refreshes the mounted bearer token before publishing", async () => {
        await startControl();
        await cycle();
        token = "rotated-token";
        const port = (server.address() as { port: number }).port;
        writeFileSync(join(dir, "port"), `${port}:${token}`);
        await own(Buffer.from("rotated"));
        requests = [];
        await cycle();
        expect(posts).toEqual([Buffer.from("rotated")]);
        expect(requests.every(req => req.auth === `Bearer ${token}`)).toBe(true);
    });

    it.each(["startup", "initialized"] as const)("refreshes port and token together with stale %s credentials and preserves no-echo state", async phase => {
        if (phase === "initialized") {
            await startControl(); await cycle();
        } else await own(Buffer.from("stale local text before bootstrap"));
        const nextToken = "replacement-token";
        const next = await privateEndpoint(nextToken);
        writeFileSync(join(dir, "port"), `${next.port}:${nextToken}`);
        requests = [];
        if (phase === "startup") { await startControl(); await cycle(); expect(await read()).toEqual(hostText); }
        const local = Buffer.from("  회전된 endpoint 😀 ' \"\r\nlast\n\n");
        await own(local); next.requests.length = 0;
        await cycle();
        expect(posts).toEqual([local]); expect(hostText).toEqual(local);
        expect(next.requests[0]).toEqual({ method: "POST", path: "/clipboard/text", auth: `Bearer ${nextToken}` });
        expect(requests).toEqual([]); // A remains listening: any stale-port request is observable.
        hostText = Buffer.from("new endpoint host read 한글\n\n");
        await cycle(); expect(await read()).toEqual(hostText);
        await cycle(); expect(posts).toEqual([local]);
        expect(next.requests.every(req => req.auth === `Bearer ${nextToken}`)).toBe(true);
        expect(requests).toEqual([]);
    });

    it("retries pending local bytes on the rotated endpoint without restoring stale host text", async () => {
        await startControl(); await cycle();
        const local = Buffer.from("pending copy across restart 한글 😀\n\n");
        await own(local); failPosts = true; hostText = Buffer.from("old endpoint changed");
        await cycle(); expect(posts).toEqual([local]); expect(await read()).toEqual(local);
        const nextToken = "retry-endpoint-token", next = await privateEndpoint(nextToken);
        writeFileSync(join(dir, "port"), `${next.port}:${nextToken}`);
        requests = []; failPosts = false; hostText = Buffer.from("new endpoint competing text");
        await cycle();
        expect(next.requests).toEqual([{ method: "POST", path: "/clipboard/text", auth: `Bearer ${nextToken}` }]);
        expect(posts).toEqual([local, local]); expect(hostText).toEqual(local); expect(requests).toEqual([]);
        await cycle(); expect(posts).toHaveLength(2); expect(requests).toEqual([]);
    });

    it("restores the paired environment fallback for invalid, retired and missing mounted records after a valid refresh", async () => {
        await startControl(); await cycle();
        const next = await privateEndpoint("mounted-token");
        const portFile = join(dir, "port");
        writeFileSync(portFile, `${next.port}:mounted-token`);
        await cycle();
        const invalid: Array<{ name: string; bytes?: string; directory?: true }> = [
            { name: "empty", bytes: "" }, { name: "malformed", bytes: "no-port-or-token" },
            { name: "zero port", bytes: "0:mounted-token" }, { name: "out of range", bytes: "65536:mounted-token" },
            { name: "extra field", bytes: `${next.port}:mounted-token:extra` },
            { name: "multiline", bytes: `${next.port}:mounted-token\n${next.port}:another-token\n` },
            { name: "retired", bytes: `retired-v1:${next.port}:${"a".repeat(32)}` },
            { name: "missing" }, { name: "directory", directory: true },
        ];
        for (const record of invalid) {
            rmSync(portFile, { recursive: true, force: true });
            if (record.directory) mkdirSync(portFile);
            else if (record.bytes !== undefined) writeFileSync(portFile, record.bytes);
            const local = Buffer.from(`fallback ${record.name} 한글\n\n`);
            await own(local); requests = []; next.requests.length = 0;
            await cycle();
            expect(requests).toEqual([{ method: "POST", path: "/clipboard/text", auth: `Bearer ${env.CCC_CLIPBOARD_TOKEN}` }]);
            expect(posts.at(-1)).toEqual(local); expect(hostText).toEqual(local);
            expect(next.requests).toEqual([]);
        }
    });

    it("keeps environment port and token paired when the mounted record is genuinely unreadable", async () => {
        const next = await privateEndpoint("unreadable-mounted-token"), portFile = join(dir, "port");
        writeFileSync(portFile, `${next.port}:unreadable-mounted-token`); chmodSync(portFile, 0o000);
        const identity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
        if ("uid" in identity) chmodSync(dir, 0o777);
        await new Promise<void>((resolve, reject) => execFile("bash", ["-c", '[ ! -r "$CCC_CLIPBOARD_PORT_FILE" ]'],
            { env, timeout: 1000, ...identity }, error => error ? reject(error) : resolve()));
        await startControl(identity); await cycle(); expect(await read()).toEqual(hostText);
        const local = Buffer.from("unreadable record fallback 😀\n\n");
        await own(local); requests = [];
        await cycle();
        expect(requests).toEqual([{ method: "POST", path: "/clipboard/text", auth: `Bearer ${env.CCC_CLIPBOARD_TOKEN}` }]);
        expect(posts).toEqual([local]); expect(next.requests).toEqual([]);
    });

    it.each(["clipboard.fixture.invalid", "[fd00::1234]"])("preserves configured host %s while refreshing the endpoint pair", async host => {
        const nextToken = "host-preserved-token", next = await privateEndpoint(nextToken);
        const oldPort = (server.address() as { port: number }).port;
        const capture = join(dir, "curl-requests.jsonl"), bin = join(dir, "bin"); mkdirSync(bin);
        // Only the transport is redirected. Actual curl, HTTP auth/body handling
        // and X11 synchronization still execute against our private endpoints.
        writeFileSync(join(bin, "curl"), `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), index=args.findIndex(arg=>arg.startsWith('http://'));
if(index<0) process.exit(92);
const original=args[index], url=new URL(original);
if(![${JSON.stringify(oldPort)},${JSON.stringify(next.port)}].includes(Number(url.port))) process.exit(93);
appendFileSync(${JSON.stringify(capture)},JSON.stringify({url:original,args})+'\\n');
url.hostname='127.0.0.1'; args[index]=url.href;
const result=spawnSync('/usr/bin/curl',['--noproxy','*',...args],{stdio:'inherit'});
process.exit(result.status??94);
`, { mode: 0o700 });
        env.PATH = `${bin}:${env.PATH}`;
        env.CCC_CLIPBOARD_URL = `http://${host}:${oldPort}`;
        writeFileSync(join(dir, "port"), `${next.port}:${nextToken}`);
        await startControl(); await cycle();
        const local = Buffer.from("preserved host text 한글 😀\n\n"); await own(local); await cycle();
        expect(posts).toEqual([local]); expect(next.requests.every(req => req.auth === `Bearer ${nextToken}`)).toBe(true);
        expect(requests).toEqual([]);
        const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line) as { url: string; args: string[] });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call.url.startsWith(`http://${host}:${next.port}/clipboard/`))).toBe(true);
        expect(calls.every(call => call.args.includes(`Authorization: Bearer ${nextToken}`))).toBe(true);
        expect(await read()).toEqual(local);
    });

    it("uses private temporary files and cleans them on normal exit", async () => {
        await startControl();
        await cycle();
        const privateDirs = readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory());
        expect(privateDirs.length).toBeGreaterThan(0);
        for (const name of privateDirs) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
        control.stdin!.write("stop\n");
        await once(control, "exit");
        for (const name of privateDirs) {
            const path = join(dir, name);
            if (existsSync(path)) expect(readdirSync(path)).toEqual([]);
        }
    });

    it("does not publish oversized local text or overwrite it from the host", async () => {
        await startControl();
        await cycle();
        const oversized = Buffer.alloc(1048577, "a");
        await own(oversized);
        await cycle();
        expect(posts).toEqual([]);
        expect(await read()).toEqual(oversized);
    });

    it("preserves a local copy made while a host read is in flight", async () => {
        await startControl();
        await cycle();
        hostText = Buffer.from("late host response");
        deferTextRead = true;
        const pending = cycle();
        await waitFor(() => releaseTextRead !== undefined);
        const local = Buffer.from("copy during host poll\n");
        await own(local);
        deferTextRead = false;
        releaseTextRead!();
        await pending;
        expect(await read()).toEqual(local);
        await cycle();
        expect(posts).toEqual([local]);
    });

    it("keeps one bridge, replaces changed code, and never kills an unrelated lock PID", async () => {
        const privateScript = join(dir, "ccc-x11-bridge");
        writeFileSync(privateScript, readFileSync(script), { mode: 0o700 });
        const privatePolicy = join(dir, "lib", "clipboard-x11-sync.sh");
        mkdirSync(join(dir, "lib"), { mode: 0o700 });
        writeFileSync(privatePolicy, readFileSync(policy), { mode: 0o600 });
        const state = join(dir, "state");
        mkdirSync(state, { mode: 0o700 });
        const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
        procs.push(unrelated);
        const unrelatedStat = readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
        const startToken = unrelatedStat.slice(unrelatedStat.lastIndexOf(")") + 2).split(" ")[19];
        const lock = join(state, "running");
        writeFileSync(lock, `${unrelated.pid}\n${startToken}\nold-generation\n${env.CCC_CLIPBOARD_URL}\n`);
        const launch = () => {
            const proc = spawn("bash", [privateScript], { env, stdio: ["ignore", "ignore", "pipe"] });
            proc.stderr!.on("data", chunk => { stderr += chunk; });
            procs.push(proc);
            return proc;
        };
        const first = launch();
        await waitFor(() => existsSync(lock) && readFileSync(lock, "utf8").split("\n")[0] === String(first.pid));
        expect(unrelated.exitCode).toBeNull();
        const duplicate = launch();
        await waitFor(() => duplicate.exitCode !== null);
        expect(duplicate.exitCode).toBe(0);
        expect(readFileSync(lock, "utf8").split("\n")[0]).toBe(String(first.pid));
        writeFileSync(`${privateScript}.new`, `${readFileSync(script, "utf8")}\n# new deployed generation\n`, { mode: 0o700 });
        renameSync(`${privateScript}.new`, privateScript);
        const replacement = launch();
        await waitFor(() => existsSync(lock) && readFileSync(lock, "utf8").split("\n")[0] === String(replacement.pid), 8000);
        await waitFor(() => first.exitCode !== null || first.signalCode !== null);
        expect(unrelated.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
        expect(procs[0].exitCode).toBeNull(); // The pre-existing isolated X server survives replacement.
        writeFileSync(`${privatePolicy}.new`, `${readFileSync(policy, "utf8")}\n# deployed policy revision\n`, { mode: 0o600 });
        renameSync(`${privatePolicy}.new`, privatePolicy);
        const policyReplacement = launch();
        await waitFor(() => existsSync(lock) && readFileSync(lock, "utf8").split("\n")[0] === String(policyReplacement.pid), 8000);
        await waitFor(() => replacement.exitCode !== null || replacement.signalCode !== null);
        expect(unrelated.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
        expect(procs[0].exitCode).toBeNull();
        env.CCC_CLIPBOARD_URL = `${env.CCC_CLIPBOARD_URL}/changed`;
        const movedEndpoint = launch();
        await waitFor(() => existsSync(lock) && readFileSync(lock, "utf8").split("\n")[0] === String(movedEndpoint.pid), 8000);
        await waitFor(() => policyReplacement.exitCode !== null || policyReplacement.signalCode !== null);
        expect(unrelated.signalCode).toBeNull();
    }, 25000);
});

it("includes the bridge in the published package files", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.files).toContain("scripts/ccc-x11-bridge");
    expect(pkg.files).toContain("scripts/lib/clipboard-x11-sync.sh");
    expect(readFileSync(policy).length).toBeGreaterThan(0);
    expect(readFileSync(script, "utf8")).toMatch(/^#!\/bin\/bash/);
});
