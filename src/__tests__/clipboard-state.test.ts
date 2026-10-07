import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { chownSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { request } from "http";
import { connect, type Socket } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

describe.each(["legacy", "run"])("clipboard state across real daemon restarts (%s layout)", (layout) => {
    let fixtureRoot: string;
    let home: string;
    let portFile: string;
    let startingLock: string;
    let ownLock: string;
    let children: ChildProcess[];
    let sockets: Socket[];
    let descriptors: number[];
    let startupFailures: string[];

    beforeAll(() => {
        fixtureRoot = mkdtempSync(join(tmpdir(), "ccc-clipboard-state-"));
        writeFileSync(join(fixtureRoot, "package.json"), '{"type":"module"}');
        symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixtureRoot, "node_modules"), "junction");
        // Compile the real relative dependency closure, including modules moved
        // behind architecture seams. A missing fixture module is not a daemon
        // publication timeout.
        for (const name of ["clipboard-server", "clipboard-startup-lock", "utils", "home-layout", "session-lock-liveness",
            "adapters/session-env-file", "application/session-lock-liveness", "application/home-layout-migration", "application/home/layout-paths", "application/home/config", "domain/session-lock", "domain/profile-request"]) {
            const source = readFileSync(fileURLToPath(new URL(`../${name}.ts`, import.meta.url)), "utf8");
            mkdirSync(dirname(join(fixtureRoot, `${name}.js`)), { recursive: true });
            writeFileSync(join(fixtureRoot, `${name}.js`), transpileModule(source, {
                compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
            }).outputText);
        }
        // Runtime metadata parsing has independent helper coverage. These real
        // daemons isolate its result while proving held-descriptor preservation.
        writeFileSync(join(fixtureRoot, "clipboard-bind-users.js"), `
            import { existsSync, readFileSync } from "fs";
            import { join } from "path";
            export function clipboardPortMayHaveBindUsers() {
                const control = join(process.env.CCC_CLIPBOARD_TEST_HOME, "bind-users");
                const mode = existsSync(control) ? readFileSync(control, "utf8") : "none";
                if (mode === "delayed") {
                    const wait = new Int32Array(new SharedArrayBuffer(4));
                    Atomics.wait(wait, 0, 0, 17000);
                    return true;
                }
                return mode !== "none";
            }
        `);
        writeFileSync(join(fixtureRoot, "home.cjs"), `
            require("os").homedir = () => process.env.CCC_CLIPBOARD_TEST_HOME;
            if (process.argv.includes("--serve")) {
                const fs = require("fs");
                const dataDir = require("path").join(require("os").homedir(), ".ccc", process.env.CCC_CLIPBOARD_TEST_LAYOUT === "run" ? "run" : "");
                const holdStartup = require("path").join(dataDir, "hold-startup");
                if (fs.existsSync(holdStartup)) {
                    fs.appendFileSync(require("path").join(dataDir, "startup-held"), "started\\n");
                    const deadline = Date.now() + 10000;
                    const signal = new Int32Array(new SharedArrayBuffer(4));
                    while (fs.existsSync(holdStartup)) {
                        if (Date.now() > deadline) throw new Error("Fixture startup was not released");
                        Atomics.wait(signal, 0, 0, 25);
                    }
                }
                const http = require("http");
                const createServer = http.createServer;
                http.createServer = (listener) => createServer((req, res) => {
                    const dropHealth = require("path").join(dataDir, "drop-next-health");
                    if (req.url === "/health" && fs.existsSync(dropHealth)) {
                        const remaining = Number(fs.readFileSync(dropHealth, "utf8")) || 1;
                        if (remaining > 1) fs.writeFileSync(dropHealth, String(remaining - 1));
                        else fs.unlinkSync(dropHealth);
                        req.socket.destroy();
                        return;
                    }
                    return listener(req, res);
                });
            }
            require("module").syncBuiltinESMExports();
        `);
        writeFileSync(join(fixtureRoot, "driver.js"), `
            import { ensureClipboardServer, stopClipboardServerIfLast, hasAnyActiveSessionsExcept, retireClipboardServerFromPortFile } from "./clipboard-server.js";
            if (process.argv[2] === "ensure-exit") {
                console.log(await ensureClipboardServer());
                process.exit(0);
            } else if (process.argv[2] === "ensure") console.log(await ensureClipboardServer());
            else if (process.argv[2] === "retire") retireClipboardServerFromPortFile(process.argv[3]);
            else stopClipboardServerIfLast(hasAnyActiveSessionsExcept(process.argv[3] || null));
        `);
        // Compatibility peer preserves the historical close-time unlink and 3-second forced exit.
        writeFileSync(join(fixtureRoot, "legacy-peer.js"), `
            import { createServer } from "http";
            import { existsSync, unlinkSync, writeFileSync } from "fs";
            import { homedir } from "os";
            import { join } from "path";
            const dataDir = join(homedir(), ".ccc", process.env.CCC_CLIPBOARD_TEST_LAYOUT === "run" ? "run" : "");
            const token = "a".repeat(32);
            const server = createServer((req, res) => {
                if (req.headers.authorization !== "Bearer " + token) {
                    res.writeHead(401); res.end(); return;
                }
                if (req.url === "/health") {
                    res.end(JSON.stringify({ service: "ccc-clipboard", valid: true, version: "legacy" }));
                    return;
                }
                if (req.url === "/shutdown") {
                    if (process.argv[2] === "reject") { res.writeHead(503); res.end(); return; }
                    if (process.argv[2] === "timeout") return;
                    res.end("shutting down");
                    server.close(() => {
                        for (const name of ["clipboard.port", "clipboard.starting"]) {
                            const path = join(dataDir, name);
                            if (existsSync(path)) unlinkSync(path);
                        }
                        process.exit(0);
                    });
                    writeFileSync(join(dataDir, "legacy-closing"), "");
                    setTimeout(() => process.exit(0), 3000);
                }
            });
            server.listen(0, "127.0.0.1", () => {
                writeFileSync(join(dataDir, "clipboard.port"), server.address().port + ":" + token, { mode: 0o600 });
            });
        `);
    });

    beforeEach(() => {
        home = mkdtempSync(join(fixtureRoot, "home-"));
        portFile = join(home, ".ccc", layout === "run" ? "run" : "", "clipboard.port");
        startingLock = join(home, ".ccc", layout === "run" ? "run" : "", "clipboard.starting.v2");
        ownLock = join(home, ".ccc", layout === "run" ? "run" : "", "locks", "test.lock");
        mkdirSync(join(home, ".ccc", layout === "run" ? "run" : "", "locks"), { recursive: true });
        writeFileSync(ownLock, String(process.pid));
        children = [];
        sockets = [];
        descriptors = [];
        startupFailures = [];
    });

    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        try {
            const record = readRecord();
            await send(record, "/shutdown", "POST");
            await waitFor(async () => {
                try { await send(record, "/health"); return false; } catch { return true; }
            });
        } catch { /* no published daemon */ }
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        for (const fd of descriptors) closeSync(fd);
        await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve() : new Promise<void>((resolve) => child.once("close", () => resolve()))));
        rmSync(home, { recursive: true, force: true });
    });

    afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

    function start(script: string, ...args: string[]) {
        const child = spawn(process.execPath, [join(fixtureRoot, script), ...args], {
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                TMPDIR: home,
                TMP: home,
                TEMP: home,
                CCC_CLIPBOARD_TEST_HOME: home,
                CCC_CLIPBOARD_TEST_LAYOUT: layout,
                NODE_OPTIONS: `--require=${JSON.stringify(join(fixtureRoot, "home.cjs"))}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => {
                if (script === "clipboard-server.js" && args.includes("--serve") && code !== 0) {
                    // Keep raw stderr in the child result for assertions, but
                    // never publish its potentially sensitive contents in the
                    // diagnostic. Only a bounded Node error identifier leaves it.
                    const nodeCode = stderr.match(/\b(ERR_[A-Z_]{1,64})\b/)?.[1] || "unclassified";
                    const failure = `clipboard fixture daemon exited: status=${code}, error=${nodeCode}`;
                    startupFailures.push(failure);
                    writeFileSync(join(home, "startup-diagnostic.json"), JSON.stringify({ status: code, error: nodeCode }), { mode: 0o600 });
                }
                resolve({ code, stdout, stderr });
            });
        });
        return { child, exited };
    }

    function readRecord() {
        const bytes = readFileSync(portFile, "utf8");
        const [port, token] = bytes.split(":");
        return { bytes, port: Number(port), token };
    }

    async function waitFor(check: () => boolean | Promise<boolean>) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (startupFailures.length) throw new Error(startupFailures[startupFailures.length - 1]);
            try { if (await check()) return; } catch { /* publication may be in progress */ }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for clipboard fixture");
    }

    function send(record: { port: number; token: string }, path: string, method = "GET"): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = request({ hostname: "127.0.0.1", port: record.port, path, method,
                headers: { Authorization: `Bearer ${record.token}`, Connection: "close" }, timeout: 1000 }, (res) => {
                let body = "";
                res.on("data", (data) => { body += data; });
                res.on("end", () => resolve(body));
            });
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Clipboard fixture request timed out")));
            req.end();
        });
    }

    async function published(previousBytes?: string) {
        await waitFor(async () => {
            const record = readRecord();
            return record.bytes !== previousBytes && /^\d+:[a-f0-9]{32}$/.test(record.bytes)
                && JSON.parse(await send(record, "/health")).valid === true;
        });
        return readRecord();
    }

    it.each(["missing", "empty", "permissive"])("publishes private metadata for a %s port file", async (state) => {
        if (state !== "missing") writeFileSync(portFile, "", { mode: state === "permissive" ? 0o644 : 0o600 });
        const before = state !== "missing" ? statSync(portFile) : null;
        start("clipboard-server.js", "--serve");
        await published();
        const after = statSync(portFile);
        if (before) expect(after.ino).toBe(before.ino);
        if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600);
    });

    it("retains bytes and the bound inode after last-session stop, then republishes on that inode", async () => {
        const daemon = start("clipboard-server.js", "--serve");
        const old = await published();
        const fd = openSync(portFile, "r");
        descriptors.push(fd);
        const inode = fstatSync(fd).ino;

        expect((await start("driver.js", "stop", ownLock).exited).code).toBe(0);
        expect((await daemon.exited).code).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
        expect(statSync(portFile).ino).toBe(inode);

        const restarted = await start("driver.js", "ensure").exited;
        expect(restarted.code, restarted.stderr).toBe(0);
        const fresh = await published(old.bytes);
        expect(Number(restarted.stdout.trim())).toBe(fresh.port);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(fd, "utf8")).toBe(fresh.bytes);
    });

    it("retires an explicitly recorded daemon without removing its bind source", async () => {
        const daemon = start("clipboard-server.js", "--serve");
        const record = await published();
        const inode = statSync(portFile).ino;
        const result = await start("driver.js", "retire", portFile).exited;
        expect(result.code, result.stderr).toBe(0);
        expect((await daemon.exited).code).toBe(0);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(portFile, "utf8")).toBe(record.bytes);
    });

    it("reuses a healthy daemon and preserves it while another session is active", async () => {
        start("clipboard-server.js", "--serve");
        const record = await published();
        const inode = statSync(portFile).ino;
        const reused = await start("driver.js", "ensure").exited;
        expect(reused.code, reused.stderr).toBe(0);
        expect(Number(reused.stdout.trim())).toBe(record.port);
        writeFileSync(join(home, ".ccc", layout === "run" ? "run" : "", "locks", "other.lock"), String(process.pid));
        expect((await start("driver.js", "stop", ownLock).exited).code).toBe(0);
        expect(JSON.parse(await send(record, "/health")).valid).toBe(true);
        expect(readFileSync(portFile, "utf8")).toBe(record.bytes);
        expect(statSync(portFile).ino).toBe(inode);
    });

    it("keeps successor publication and startup lock when an old daemon finishes shutdown late", async () => {
        const oldDaemon = start("clipboard-server.js", "--serve");
        const old = await published();
        const inode = statSync(portFile).ino;
        const pending = connect(old.port, "127.0.0.1");
        sockets.push(pending);
        await new Promise<void>((resolve) => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        await send(old, "/shutdown", "POST");
        expect(oldDaemon.child.exitCode).toBeNull();
        start("clipboard-server.js", "--serve");
        const successor = await published(old.bytes);
        writeFileSync(startingLock, "successor-startup-lock");
        pending.destroy();
        expect((await oldDaemon.exited).code).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(successor.bytes);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(startingLock, "utf8")).toBe("successor-startup-lock");
        expect(JSON.parse(await send(successor, "/health")).valid).toBe(true);
    });

    it("does not reclaim a live owner during delayed bind inspection", async () => {
        start("legacy-peer.js");
        const old = await published();
        writeFileSync(join(home, "bind-users"), "delayed");
        const first = start("driver.js", "ensure-exit");
        await waitFor(() => existsSync(startingLock) && readFileSync(startingLock, "utf8").includes('"nonce"'));
        const before = statSync(startingLock);
        const ownership = readFileSync(startingLock, "utf8");
        const second = await start("driver.js", "ensure-exit").exited;
        expect(second.code).not.toBe(0);
        expect(second.stderr).toContain("still owned or its owner cannot be verified");
        expect(statSync(startingLock).ino).toBe(before.ino);
        expect(readFileSync(startingLock, "utf8")).toBe(ownership);
        expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
        expect((await first.exited).code).toBe(0);
        expect(existsSync(startingLock)).toBe(false);
        expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
    }, 45000);

    it.each(["active", "unknown"])("preserves a held legacy bind inode while %s container users prevent upgrade", async mode => {
        const legacy = start("legacy-peer.js");
        const old = await published();
        const fd = openSync(portFile, "r");
        descriptors.push(fd);
        const before = fstatSync(fd);
        writeFileSync(join(home, "bind-users"), mode);
        const result = await start("driver.js", "ensure-exit").exited;
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain("Clipboard update deferred");
        expect(Number(result.stdout.trim())).toBe(old.port);
        expect(fstatSync(fd).ino).toBe(before.ino);
        expect(statSync(portFile).ino).toBe(before.ino);
        expect(readFileSync(fd, "utf8")).toBe(old.bytes);
        expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
        expect(existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "legacy-closing"))).toBe(false);
        expect((await start("driver.js", "retire", portFile).exited).code).toBe(0);
        expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
        expect((await start("driver.js", "stop", ownLock).exited).code).toBe(0);
        expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
        writeFileSync(join(home, "bind-users"), "none");
        const upgraded = await start("driver.js", "ensure-exit").exited;
        expect(upgraded.code, upgraded.stderr).toBe(0);
        const successor = await published(old.bytes);
        expect(successor.bytes).not.toBe(old.bytes);
        expect((await legacy.exited).code).toBe(0);
    }, 45000);

    it("waits out legacy shutdown before publishing even when the upgrading caller exits immediately", async () => {
        const legacy = start("legacy-peer.js");
        const old = await published();
        const pending = connect(old.port, "127.0.0.1");
        sockets.push(pending);
        pending.on("error", () => { /* the legacy forced exit closes this held request */ });
        await new Promise<void>((resolve) => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        let successor: ReturnType<typeof readRecord> | undefined;
        try {
            const result = await start("driver.js", "ensure-exit").exited;
            expect(result.code, result.stderr).toBe(0);
            successor = await published(old.bytes);
            pending.destroy();
            expect((await legacy.exited).code).toBe(0);
            expect(readFileSync(portFile, "utf8")).toBe(successor.bytes);
            expect(Number(result.stdout.trim())).toBe(successor.port);
            expect(JSON.parse(await send(successor, "/health")).valid).toBe(true);
        } finally {
            pending.destroy();
            if (successor) await send(successor, "/shutdown", "POST").catch(() => {});
        }
    });

    it("recovers an interrupted upgrade without publishing before legacy cleanup finishes", async () => {
        const legacy = start("legacy-peer.js");
        const old = await published();
        const pending = connect(old.port, "127.0.0.1");
        sockets.push(pending);
        pending.on("error", () => {});
        await new Promise<void>((resolve) => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        const first = start("driver.js", "ensure-exit");
        let earlyPublication: ReturnType<typeof readRecord> | undefined;
        try {
            await waitFor(() => existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "legacy-closing")));
            const startedAt = Date.now();
            const second = start("driver.js", "ensure-exit");
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (existsSync(portFile) && readRecord().bytes !== old.bytes) earlyPublication = readRecord();
            first.child.kill("SIGKILL");
            await first.exited;
            pending.destroy();
            expect((await legacy.exited).code).toBe(0);
            const lockSurvivedLegacyCleanup = existsSync(startingLock);
            const result = await second.exited;
            expect(result.code, result.stderr).toBe(0);
            const fresh = readRecord();
            expect(Number(result.stdout.trim())).toBe(fresh.port);
            expect(earlyPublication).toBeUndefined();
            expect(lockSurvivedLegacyCleanup).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(20000);
            expect(JSON.parse(await send(fresh, "/health")).valid).toBe(true);
        } finally {
            pending.destroy();
            if (earlyPublication) await send(earlyPublication, "/shutdown", "POST").catch(() => {});
        }
    }, 25000);

    it("keeps the current startup lock through early legacy cleanup and publishes only one replacement", async () => {
        const legacy = start("legacy-peer.js");
        await published();
        const holdStartup = join(home, ".ccc", layout === "run" ? "run" : "", "hold-startup");
        const old = readRecord();
        const pending = connect(old.port, "127.0.0.1");
        sockets.push(pending);
        await new Promise<void>((resolve) => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        writeFileSync(holdStartup, "");
        const first = start("driver.js", "ensure-exit");
        try {
            await waitFor(() => existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "legacy-closing")));
            pending.destroy();
            expect((await legacy.exited).code).toBe(0);
            expect(existsSync(startingLock)).toBe(true);
            const second = start("driver.js", "ensure-exit");
            await waitFor(() => existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "startup-held")));
            await new Promise((resolve) => setTimeout(resolve, 350));
            expect(readFileSync(join(home, ".ccc", layout === "run" ? "run" : "", "startup-held"), "utf8")).toBe("started\n");
            expect(first.child.exitCode).toBeNull();
            expect(second.child.exitCode).toBeNull();
            rmSync(holdStartup);
            const fresh = await published(old.bytes);
            for (const result of await Promise.all([first.exited, second.exited])) {
                expect(result.code, result.stderr).toBe(0);
                expect(Number(result.stdout.trim())).toBe(fresh.port);
            }
        } finally {
            pending.destroy();
            rmSync(holdStartup, { force: true });
            if (existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "startup-held"))) await published(old.bytes);
        }
    });

    it.each(["reject", "timeout"])("does not publish when legacy shutdown acknowledgement fails: %s", async (mode) => {
        const legacy = start("legacy-peer.js", mode);
        const old = await published();
        const inode = statSync(portFile).ino;
        try {
            const startedAt = Date.now();
            const result = await start("driver.js", "ensure-exit").exited;
            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain("Failed to acknowledge clipboard server shutdown for upgrade");
            expect(Date.now() - startedAt).toBeLessThan(4500);
            expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
            expect(statSync(portFile).ino).toBe(inode);
            expect(existsSync(startingLock)).toBe(false);
            expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
        } finally {
            legacy.child.kill("SIGKILL");
            await legacy.exited;
        }
    });

    it("stale callers wait for the existing startup lock and share authenticated successor state", async () => {
        writeFileSync(portFile, "1:stale-token", { mode: 0o600 });
        const inode = statSync(portFile).ino;
        writeFileSync(startingLock, "startup-in-progress");
        const first = start("driver.js", "ensure");
        const second = start("driver.js", "ensure");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(readFileSync(startingLock, "utf8")).toBe("startup-in-progress");
        expect(readFileSync(portFile, "utf8")).toBe("1:stale-token");
        start("clipboard-server.js", "--serve");
        const record = await published();
        for (const result of await Promise.all([first.exited, second.exited])) {
            expect(result.code, result.stderr).toBe(0);
            expect(Number(result.stdout.trim())).toBe(record.port);
        }
        expect(statSync(portFile).ino).toBe(inode);
    });

    it("reuses a current daemon that recovers before the startup lock holder forks", async () => {
        start("clipboard-server.js", "--serve");
        const old = await published();
        const inode = statSync(portFile).ino;
        writeFileSync(join(home, ".ccc", layout === "run" ? "run" : "", "drop-next-health"), "");
        const result = await start("driver.js", "ensure-exit").exited;
        expect(result.code, result.stderr).toBe(0);
        expect(Number(result.stdout.trim())).toBe(old.port);
        expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
        expect(statSync(portFile).ino).toBe(inode);
        expect(existsSync(startingLock)).toBe(false);
    });

    it.each(["new startup", "existing startup lock"])("waits for fresh publication when old health recovers during %s", async (mode) => {
        start("clipboard-server.js", "--serve");
        const old = await published();
        const inode = statSync(portFile).ino;
        const dropHealth = join(home, ".ccc", layout === "run" ? "run" : "", "drop-next-health");
        const holdStartup = join(home, ".ccc", layout === "run" ? "run" : "", "hold-startup");
        writeFileSync(dropHealth, mode === "new startup" ? "2" : "1");
        writeFileSync(holdStartup, "");
        if (mode === "existing startup lock") writeFileSync(startingLock, "startup-in-progress");
        const restarting = start("driver.js", "ensure");
        let returnedBeforePublication: boolean;
        let fresh: ReturnType<typeof readRecord>;
        try {
            await waitFor(() => !existsSync(dropHealth));
            if (mode === "existing startup lock") start("clipboard-server.js", "--serve");
            await waitFor(() => existsSync(join(home, ".ccc", layout === "run" ? "run" : "", "startup-held")));
            expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 350));
            returnedBeforePublication = restarting.child.exitCode !== null;
            expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
        } finally {
            rmSync(holdStartup, { force: true });
            fresh = await published(old.bytes);
        }
        const result = await restarting.exited;
        expect(result.code, result.stderr).toBe(0);
        expect(Number(result.stdout.trim())).toBe(fresh.port);
        expect(returnedBeforePublication).toBe(false);
        expect(statSync(portFile).ino).toBe(inode);
    });

    for (const kind of ["symlink", "hardlink", "directory"]) {
        it.skipIf(kind === "symlink" && process.platform === "win32")(`refuses a ${kind} target without modifying its sentinel`, async () => {
            const sentinel = join(home, "sentinel");
            writeFileSync(sentinel, "private-sentinel-bytes", { mode: 0o640 });
            if (kind === "symlink") symlinkSync(sentinel, portFile);
            else if (kind === "hardlink") linkSync(sentinel, portFile);
            else {
                mkdirSync(portFile);
                writeFileSync(join(portFile, "sentinel"), "directory-sentinel");
            }
            const before = statSync(sentinel);
            const targetBefore = lstatSync(portFile);
            const result = await start("clipboard-server.js", "--serve").exited;
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("Failed to start clipboard server");
            expect(readFileSync(sentinel, "utf8")).toBe("private-sentinel-bytes");
            expect(statSync(sentinel)).toMatchObject({ ino: before.ino, mode: before.mode, uid: before.uid, size: before.size });
            expect(lstatSync(portFile)).toMatchObject({ ino: targetBefore.ino, mode: targetBefore.mode });
            if (kind === "directory") expect(readFileSync(join(portFile, "sentinel"), "utf8")).toBe("directory-sentinel");
        });
    }

    it.skipIf(process.platform === "win32")("refuses a dangling symlink without creating its target", async () => {
        const target = join(home, "must-stay-missing");
        symlinkSync(target, portFile);
        const before = lstatSync(portFile);
        const result = await start("clipboard-server.js", "--serve").exited;
        expect(result.code).toBe(1);
        expect(() => statSync(target)).toThrow();
        expect(lstatSync(portFile)).toMatchObject({ ino: before.ino, mode: before.mode });
    });

    it.skipIf(process.getuid?.() !== 0)("refuses a foreign-owned file before changing its bytes or mode", async () => {
        writeFileSync(portFile, "foreign-owner-sentinel", { mode: 0o666 });
        chownSync(portFile, 65534, 65534);
        const before = statSync(portFile);
        const result = await start("clipboard-server.js", "--serve").exited;
        expect(result.code).toBe(1);
        expect(readFileSync(portFile, "utf8")).toBe("foreign-owner-sentinel");
        expect(statSync(portFile)).toMatchObject({ ino: before.ino, mode: before.mode, uid: before.uid, size: before.size });
    });
});
