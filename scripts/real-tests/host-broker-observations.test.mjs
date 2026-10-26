import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectHostBrokerObservations } from "./host-broker-observations.mjs";

const script = fileURLToPath(new URL("./host-broker-observations.mjs", import.meta.url));
const lsofArgs = ["-nP", "-iTCP:17373", "-sTCP:LISTEN", "-Fp"];
const secret = "PRIVATE_OWNER_AUTH_MUST_NOT_BE_EXPORTED";
const startedAt = "Mon Oct 26 10:12:34 2026";

function receipt(stdout = "", overrides = {}) {
    return { status: 0, signal: null, stdout, stderr: "", ...overrides };
}

function ports({ before = receipt(), after = before, runtime = {}, response } = {}) {
    const listeners = [before, after];
    return {
        run: vi.fn((executable, args) => {
            if (executable === "/usr/sbin/lsof") return listeners.shift();
            if (executable === "/bin/ps" && args.at(-1) === "command=") {
                return receipt(`/usr/local/bin/node /checkout/dist/index.js devices broker serve --port 17373\n`);
            }
            if (executable === "/bin/ps" && args.at(-1) === "lstart=") return receipt(`${startedAt}\n`);
            throw new Error(`Unexpected native observation: ${executable} ${args.join(" ")}`);
        }),
        readFile: vi.fn(() => JSON.stringify(runtime)),
        fetchImpl: vi.fn(async () => response ? response() : new Response('{"ok":true,"broker":{}}')),
    };
}

describe("read-only host broker observations", () => {
    let cwd;
    let home;

    beforeEach(() => {
        cwd = realpathSync(mkdtempSync(join(tmpdir(), "ccc-host-broker-observations-")));
        home = join(cwd, "fake-home");
    });

    afterEach(() => rmSync(cwd, { recursive: true, force: true }));

    const collect = (injected) => collectHostBrokerObservations({ cwd, home, ...injected });

    it("records exact read-only native probes, listener changes, and selected identity fields", async () => {
        const cli = join(cwd, "dist/index.js");
        const brokerEntry = join(cwd, "dist/packages/device-lab/dist/broker-entry.js");
        const command = `/usr/local/bin/node ${brokerEntry} devices broker serve --port 17373 ${"x".repeat(4096)}`;
        const runtime = {
            name: "ccc-device-broker", managedBy: "ccc-host", pid: 111, host: "127.0.0.1", port: 17373, platform: "darwin",
            command: "/usr/local/bin/node", args: [brokerEntry, "devices", "broker", "serve", "--port", "17373"],
            cwd, startedAt, processStartToken: `ps:${startedAt}`,
            processIdentity: { pid: 111, startToken: `ps:${startedAt}`, commandHash: "a".repeat(64), auth: secret },
            ownerId: secret, authentication: { token: secret },
        };
        const broker = {
            name: "ccc-device-broker", mode: "host", version: "1.1.90", host: "127.0.0.1", port: 17373,
            protocolVersion: 8, startedAt,
            process: { pid: 111, startToken: `ps:${startedAt}`, owner: { token: secret } },
            serviceManager: { platform: "darwin", command: ["/usr/local/bin/node", brokerEntry], auth: secret },
            owners: [{ token: secret }],
        };
        const injected = ports({
            before: receipt("p111\nf12\np111\np112\n"), after: receipt("p113\n"), runtime,
            response: () => new Response(JSON.stringify({ ok: true, broker, authentication: secret })),
        });
        const baseRun = injected.run.getMockImplementation();
        injected.run.mockImplementation((executable, args) => executable === "/bin/ps" && args.at(-1) === "command="
            ? receipt(`${command}\n`) : baseRun(executable, args));

        const observed = await collect(injected);

        expect(Number.isFinite(Date.parse(observed.at))).toBe(true);
        expect(observed.checkout).toMatchObject({ cwd, realpath: cwd });
        expect(observed.node).toMatchObject({ executable: process.execPath, version: process.version, platform: process.platform });
        expect(observed.expectedEntries).toEqual({ cli, broker: brokerEntry });
        expect(observed.listener).toMatchObject(receipt("p111\nf12\np111\np112\n"));
        expect(observed.listenerAfter).toMatchObject(receipt("p113\n"));
        expect(observed.processes.map(({ pid }) => pid)).toEqual([111, 112]);
        for (const processObservation of observed.processes) {
            expect(processObservation.command.stdout.trim()).toBe(command);
            expect(processObservation.start).toMatchObject(receipt(`${startedAt}\n`));
            expect(processObservation.startToken).toBe(`ps:${startedAt}`);
        }
        const nativeCalls = injected.run.mock.calls;
        expect(nativeCalls[0]).toEqual(["/usr/sbin/lsof", lsofArgs]);
        expect(nativeCalls.at(-1)).toEqual(["/usr/sbin/lsof", lsofArgs]);
        expect(nativeCalls.slice(1, -1)).toEqual(expect.arrayContaining([
            ["/bin/ps", ["-ww", "-p", "111", "-o", "command="]],
            ["/bin/ps", ["-p", "111", "-o", "lstart="]],
            ["/bin/ps", ["-ww", "-p", "112", "-o", "command="]],
            ["/bin/ps", ["-p", "112", "-o", "lstart="]],
        ]));
        expect(nativeCalls).toHaveLength(6);
        expect(injected.readFile.mock.calls).toEqual([[join(home, ".ccc/devices/broker/runtime.json"), "utf8"]]);
        expect(injected.fetchImpl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17373/status", expect.objectContaining({
            method: "GET", redirect: "manual", signal: expect.any(AbortSignal),
        }));
        const { ownerId, authentication, processIdentity, ...selectedRuntime } = runtime;
        expect(observed.runtime).toEqual({
            ...selectedRuntime,
            processIdentity: { pid: processIdentity.pid, startToken: processIdentity.startToken, commandHash: processIdentity.commandHash },
        });
        const { process: brokerProcess, serviceManager, owners, ...selectedBroker } = broker;
        expect(observed.status).toEqual({
            httpOk: true, http: 200, ok: true, broker: selectedBroker,
            process: { pid: brokerProcess.pid, startToken: brokerProcess.startToken },
            service: { platform: serviceManager.platform, command: serviceManager.command },
        });
        expect(JSON.stringify(observed)).not.toContain(secret);
    });

    it("does not probe PIDs from failed or partial listener output", async () => {
        for (const before of [
            receipt("p111\n", { status: 1, stderr: "lsof unavailable" }),
            receipt("p111\n", { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }),
            receipt("p111\np"),
        ]) {
            const injected = ports({ before, after: receipt("p222\n") });
            const observed = await collect(injected);
            expect(observed.listener).toMatchObject(before);
            expect(observed.listenerAfter.stdout).toBe("p222\n");
            expect(observed.processes).toEqual([]);
            expect(injected.run.mock.calls).toEqual([
                ["/usr/sbin/lsof", lsofArgs], ["/usr/sbin/lsof", lsofArgs],
            ]);
        }
    });

    it("reports missing and malformed runtime metadata without exposing error text or JSON bytes", async () => {
        for (const read of [
            () => { throw Object.assign(new Error(secret), { code: "ENOENT" }); },
            () => `{"ownerToken":"${secret}",`,
            () => "null",
            () => "[]",
        ]) {
            const injected = ports();
            injected.readFile.mockImplementation(read);
            const observed = await collect(injected);
            expect(observed.runtime == null).toBe(true);
            expect(observed.runtimeError).toEqual({ code: expect.any(String) });
            expect(JSON.stringify(observed)).not.toContain(secret);
        }
    });

    it("does not export objects smuggled through selected scalar or command fields", async () => {
        const privateObject = { token: secret };
        const injected = ports({
            runtime: {
                pid: 111, managedBy: privateObject, command: privateObject, args: ["safe", privateObject],
                host: privateObject, port: privateObject, processStartToken: privateObject,
                processIdentity: { pid: 111, startToken: privateObject, commandHash: privateObject },
            },
            response: () => new Response(JSON.stringify({
                ok: true,
                broker: {
                    port: 17373, name: privateObject, protocolVersion: privateObject,
                    process: { pid: 111, startToken: privateObject },
                    serviceManager: { platform: privateObject, command: ["safe", privateObject] },
                },
            })),
        });
        const observed = await collect(injected);
        expect(observed.runtime.pid).toBe(111);
        expect(observed.status.broker.port).toBe(17373);
        expect(observed.status.process.pid).toBe(111);
        expect(JSON.stringify(observed)).not.toContain(secret);
    });

    it("preserves HTTP and application outcomes without following redirects or exporting error bodies", async () => {
        for (const [response, http, code] of [
            [() => new Response(secret, { status: 503 }), 503, "HTTP_STATUS"],
            [() => new Response(secret, { status: 302, headers: { location: `https://example.invalid/${secret}` } }), 302, "HTTP_REDIRECT"],
            [() => { throw new Error(secret); }, null, "HTTP_UNAVAILABLE"],
            [() => new Response(JSON.stringify({ ok: false, broker: { owners: [{ token: secret }] } })), 200, null],
        ]) {
            const injected = ports({ response });
            const observed = await collect(injected);
            if (code === null) {
                expect(observed.statusError).toBeUndefined();
                expect(observed.status).toMatchObject({ httpOk: true, http, ok: false });
            } else {
                expect(observed.statusError).toEqual({ code });
                if (http !== null) expect(observed.status).toEqual({ httpOk: false, http });
            }
            expect(injected.fetchImpl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17373/status", expect.objectContaining({
                method: "GET", redirect: "manual", signal: expect.any(AbortSignal),
            }));
            expect(JSON.stringify(observed)).not.toContain(secret);
        }
    });

    it("bounds HTTP bodies by bytes with or without Content-Length and cancels oversized streams", async () => {
        const cancel = vi.fn();
        const responses = [
            () => new Response(secret, { headers: { "content-length": "262145" } }),
            () => new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode("é".repeat(131073))); },
                cancel,
            })),
        ];
        for (const response of responses) {
            const observed = await collect(ports({ response }));
            expect(observed.statusError).toEqual({ code: "HTTP_BODY_TOO_LARGE" });
            expect(observed.status?.broker).toBeUndefined();
            expect(JSON.stringify(observed)).not.toContain(secret);
        }
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("omits malformed JSON and partial response bytes from parse and stream errors", async () => {
        for (const response of [
            () => new Response(`{"ownerToken":"${secret}",`),
            () => new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode(`{"ownerToken":"${secret}`)); },
                pull(controller) { controller.error(new Error(secret)); },
            })),
        ]) {
            const observed = await collect(ports({ response }));
            expect(observed.statusError).toEqual({ code: expect.any(String) });
            expect(observed.status).toEqual({ httpOk: true, http: 200 });
            expect(observed.status?.broker).toBeUndefined();
            expect(JSON.stringify(observed)).not.toContain(secret);
        }
    });

    it("parses actual CLI help and refuses unsupported hosts before collecting observations", () => {
        const attempted = "UNEXPECTED_HOST_COLLECTION_ATTEMPT";
        const preload = `
            import childProcess from "node:child_process";
            import fs from "node:fs";
            import { syncBuiltinESMExports } from "node:module";
            const deny = () => { process.stderr.write("${attempted}\\n"); throw new Error("${attempted}"); };
            for (const name of ["spawnSync", "spawn", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = deny;
            const originalRead = fs.readFileSync;
            fs.readFileSync = (path, ...args) => String(path).replaceAll("\\\\", "/").endsWith("/.ccc/devices/broker/runtime.json")
                ? deny() : originalRead(path, ...args);
            globalThis.fetch = deny;
            syncBuiltinESMExports();
        `;
        const invoke = (args) => spawnSync(process.execPath, [
            "--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args,
        ], {
            cwd, env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8", timeout: 5000, maxBuffer: 262144, windowsHide: true,
        });

        const help = invoke(["--help"]);
        expect(help.error).toBeUndefined();
        expect(help.status).toBe(0);
        expect(help.stdout).toMatch(/host-broker-observations\.mjs/);
        expect(help.stdout).toMatch(/read.only/i);
        expect(help.stderr).toBe("");
        expect(help.stdout).not.toContain('"listener"');
        if (process.platform !== "darwin") {
            const unsupported = invoke([]);
            expect(unsupported.error).toBeUndefined();
            expect(unsupported.status).not.toBe(0);
            expect(unsupported.stderr).toMatch(/darwin|macos/i);
            expect(unsupported.stdout).toBe("");
            expect(unsupported.stderr).not.toContain(attempted);
        }
    });
});
