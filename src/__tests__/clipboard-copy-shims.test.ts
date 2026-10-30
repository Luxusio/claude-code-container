import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Capture = { method: string; path: string; auth?: string; type?: string; body: Buffer };
const shimDir = fileURLToPath(new URL("../../scripts/clipboard-shims/", import.meta.url));
const sample = Buffer.from("  한글 😀 ' \" $(echo unsafe) `echo unsafe`\r\nsecond\n\n", "utf8");
const readClients: Array<[string, string[]]> = [
    ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]],
    ["wl-paste", []], ["pbpaste", []],
];
const copyClients: Array<[string, string[]]> = [
    ["wl-copy", []], ["xclip", ["-selection", "clipboard", "-i"]], ["xsel", ["--clipboard", "--input"]],
];

// These scripts run inside Linux containers; native Windows does not require sh.
describe.skipIf(process.platform === "win32")("actual clipboard copy shell clients", () => {
    let server: Server;
    let url: string;
    let captured: Capture[];
    let responseStatus: number;
    let responseBody: Buffer;
    let fixtureRoot: string;
    let portFile: string;
    let decoy: Server;
    let decoyUrl: string;
    let decoyRequests: number;
    let decoyStatus: number;
    let decoyBody: Buffer;

    beforeEach(async () => {
        captured = [];
        responseStatus = 204;
        responseBody = Buffer.alloc(0);
        server = createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            captured.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization,
                type: req.headers["content-type"], body: Buffer.concat(chunks) });
            res.writeHead(responseStatus);
            res.end(responseBody);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("HTTP fixture failed to bind");
        url = `http://127.0.0.1:${address.port}`;
        fixtureRoot = mkdtempSync(join(tmpdir(), "ccc-copy-shims-"));
        mkdirSync(join(fixtureRoot, ".ccc", "clipboard"), { recursive: true });
        portFile = join(fixtureRoot, ".ccc", "clipboard", "clipboard.port");
        for (const name of ["wl-copy", "xclip", "xsel", "wl-paste", "pbpaste"]) {
            const source = readFileSync(`${shimDir}${name}`, "utf8");
            expect(source).toContain("/run/ccc/clipboard.port");
            const isolated = source.replaceAll("/run/ccc/clipboard.port", '"$CCC_TEST_PORT_FILE"');
            expect(isolated).not.toContain("/run/ccc/clipboard.port");
            writeFileSync(join(fixtureRoot, name), isolated, { mode: 0o600 });
        }
        decoyRequests = 0;
        decoyStatus = 500;
        decoyBody = Buffer.alloc(0);
        decoy = createServer((_req, res) => { decoyRequests++; res.writeHead(decoyStatus); res.end(decoyBody); });
        await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
        const decoyAddress = decoy.address();
        if (!decoyAddress || typeof decoyAddress === "string") throw new Error("Decoy failed to bind");
        decoyUrl = `http://127.0.0.1:${decoyAddress.port}`;
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        decoy.closeAllConnections();
        await new Promise<void>((resolve, reject) => decoy.close((error) => error ? reject(error) : resolve()));
        rmSync(fixtureRoot, { recursive: true, force: true });
        expect(decoyRequests).toBe(0);
    });

    function run(name: string, args: string[], input = sample, endpoint = url,
        selection?: { url: string; token: string; generation?: string }) {
        // Mounted metadata wins over stale environment values, but both endpoints
        // and every byte of metadata belong exclusively to this test.
        writeFileSync(portFile, endpoint ? `${new URL(endpoint).port}:test-copy-token` : "invalid", { mode: 0o600 });
        return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
            const child = spawn("sh", [join(fixtureRoot, name), ...args], {
                env: { ...process.env, ENV: "", BASH_ENV: "", HOME: fixtureRoot, TMPDIR: fixtureRoot,
                    CCC_TEST_PORT_FILE: portFile, CCC_CLIPBOARD_URL: selection?.url ?? (endpoint ? decoyUrl : ""),
                    CCC_CLIPBOARD_TOKEN: selection?.token ?? "stale-fixture-token",
                    CCC_CLIPBOARD_GENERATION: selection?.generation ?? "" },
                stdio: ["pipe", "pipe", "pipe"],
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("shim did not terminate")); }, 5000);
            child.on("error", (error) => { clearTimeout(timer); reject(error); });
            child.stdout.on("data", (chunk) => stdout.push(chunk));
            child.stderr.on("data", (chunk) => stderr.push(chunk));
            child.stdin.on("error", () => { /* early option rejection can close stdin */ });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
            });
            child.stdin.end(input);
        });
    }

    function expectWrite(body: Buffer, token = "test-copy-token") {
        expect(captured).toHaveLength(1);
        expect(captured[0].method).toBe("POST");
        expect(captured[0].path).toBe("/clipboard/text");
        expect(captured[0].type).toMatch(/^text\/plain(?:;\s*charset=utf-8)?$/i);
        expect(captured[0].auth).toBe(`Bearer ${token}`);
        expect(captured[0].body).toEqual(body);
    }

    it.each(readClients)("%s pins current-generation text instead of reading the old mounted image endpoint", async (name, args) => {
        responseStatus = 200;
        responseBody = Buffer.from("current session text 한글 😀");
        decoyStatus = 200;
        decoyBody = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
        const result = await run(name as string, args as string[], Buffer.alloc(0), decoyUrl,
            { url, token: "current-generation-token", generation: "a1b2c3d4e5f6" });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toEqual(responseBody);
        expect(captured).toEqual([expect.objectContaining({ method: "GET", path: "/clipboard/text",
            auth: "Bearer current-generation-token" })]);
        expect(readFileSync(portFile, "utf8")).toBe(`${new URL(decoyUrl).port}:test-copy-token`);
        expect(decoyRequests).toBe(0);
    });

    it.each(readClients.flatMap(([name, args]) =>
        [undefined, "not-a-generation", "a1b2c3d4e5f", "a1b2c3d4e5f60"].map(generation => ({name, args, generation}))))(
        "$name refreshes the mounted endpoint when generation is $generation", async ({name, args, generation}) => {
            responseStatus = 200;
            responseBody = Buffer.from("legacy refreshed text 한글");
            const result = await run(name, args, Buffer.alloc(0), url,
                {url: decoyUrl, token: "stale-session-token", generation});
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toEqual(responseBody);
            expect(captured).toEqual([expect.objectContaining({method: "GET", path: "/clipboard/text",
                auth: "Bearer test-copy-token"})]);
            expect(decoyRequests).toBe(0);
        });

    it.each(copyClients.flatMap(([name, args]) =>
        [sample, Buffer.alloc(0)].map(input => ({name, args, input, size: input.length}))))(
        "$name writes $size exact bytes to the pinned current endpoint", async ({name, args, input}) => {
            const result = await run(name, args, input, decoyUrl,
                {url, token: "current-generation-token", generation: "a1b2c3d4e5f6"});
            expect(result.code, result.stderr).toBe(0);
            expectWrite(input, "current-generation-token");
            expect(readFileSync(portFile, "utf8")).toBe(`${new URL(decoyUrl).port}:test-copy-token`);
            expect(decoyRequests).toBe(0);
        });

    it.each(copyClients)("%s still refreshes mounted write credentials for an invalid generation", async (name, args) => {
        const result = await run(name, args, sample, url,
            {url: decoyUrl, token: "stale-session-token", generation: "not-a-generation"});
        expect(result.code, result.stderr).toBe(0);
        expectWrite(sample);
        expect(decoyRequests).toBe(0);
    });

    it.each([
        ["wl-copy", []],
        ["wl-copy", ["--type", "text/plain;charset=utf-8"]],
        ["xclip", ["-selection", "clipboard"]],
        ["xclip", ["-selection", "clipboard", "-i"]],
        ["xclip", ["-selection", "c", "-in", "-target", "UTF8_STRING"]],
        ["xclip", ["-selection", "clipboard", "-t", "text/plain"]],
        ["xsel", ["--clipboard", "--input"]],
        ["xsel", ["-b", "-i"]],
        ["xsel", ["--clipboard"]],
    ])("%s %j sends exact Unicode and newline bytes", async (name, args) => {
        const result = await run(name as string, args as string[]);
        expect(result.code, result.stderr).toBe(0);
        expectWrite(sample);
    });

    it.each([["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["-b"]]])(
        "%s supports empty stdin as clear", async (name, args) => {
            const result = await run(name as string, args as string[], Buffer.alloc(0));
            expect(result.code, result.stderr).toBe(0);
            expectWrite(Buffer.alloc(0));
        });

    it("wl-copy positional arguments preserve text without a newline", async () => {
        const result = await run("wl-copy", ["--", "한글", "emoji 😀\n\n"], Buffer.alloc(0));
        expect(result.code, result.stderr).toBe(0);
        expectWrite(Buffer.from("한글 emoji 😀\n\n"));
    });

    it.each(["--clear", "-c"])("wl-copy %s clears", async (option) => {
        const result = await run("wl-copy", [option], Buffer.alloc(0));
        expect(result.code, result.stderr).toBe(0);
        expectWrite(Buffer.alloc(0));
    });

    it.each(["wl-copy", "xclip", "xsel"])("%s surfaces HTTP and transport failure", async (name) => {
        const args = name === "xclip" ? ["-selection", "clipboard"] : name === "xsel" ? ["-b"] : [];
        for (const status of [401, 413, 500]) {
            responseStatus = status;
            expect((await run(name, args)).code).not.toBe(0);
        }
        expect((await run(name, args, sample, "http://127.0.0.1:1")).code).not.toBe(0);
        expect((await run(name, args, sample, "")).code).not.toBe(0);
    });

    it.each([
        ["wl-copy", ["--type", "image/png"]],
        ["wl-copy", ["--primary"]],
        ["wl-copy", ["--unknown-option"]],
        ["wl-copy", ["--type"]],
        ["xclip", ["-selection", "clipboard", "-t", "image/png", "-i"]],
        ["xclip", ["-selection", "primary", "-i"]],
        ["xclip", ["-selection", "clipboard", "-unknown"]],
        ["xclip", ["-selection"]],
        ["xsel", ["--primary", "--input"]],
        ["xsel", ["--clipboard", "--unknown-option"]],
    ])("%s %j rejects unsupported input without a request", async (name, args) => {
        expect((await run(name as string, args as string[])).code).not.toBe(0);
        expect(captured).toEqual([]);
    });

    it.each([
        ["xclip", ["-selection", "clipboard", "-o"], "/clipboard/text", "paste text"],
        ["xclip", ["-selection", "clipboard", "-out"], "/clipboard/text", "paste text"],
        ["xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], "/clipboard/targets", "text/plain"],
        ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], "/clipboard/image/png", "\u0000PNG\r\n"],
        ["xclip", ["-selection", "clipboard", "-t", "image/bmp", "-o"], "/clipboard/image/bmp", "BMP\u0000"],
        ["xsel", ["--clipboard", "--output"], "/clipboard/text", "paste text"],
    ])("%s %j preserves paste route", async (name, args, path, body) => {
        responseStatus = 200;
        responseBody = Buffer.from(body as string);
        const result = await run(name as string, args as string[], Buffer.alloc(0));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toEqual(responseBody);
        expect(captured).toHaveLength(1);
        expect(captured[0].method).toBe("GET");
        expect(captured[0].path).toBe(path);
    });
});
