import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freePort } from "./helpers/fake-broker-mcp-fixture.js";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { brokerRpc, brokerStatus, withBrokerOperation } from "../../device-lab-mcp/src/broker.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";

// Real HTTP and Linux process identity; deliberately no unverified-fixture escape.
describe.skipIf(process.platform !== "linux")("broker setup reuse with authenticated generation checks", () => {
    let home: string;
    let child: ChildProcess;
    let log: string;
    let behavior: string;
    let auth: string;
    let options: { hostCandidates: string[]; port: number; autolaunch: boolean; timeoutMs: number };
    const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const count = (path: string) => requests().filter(entry => entry === path).length;
    const rpc = () => brokerRpc({ ...options, method: "broker.echo", params: { message: "hello" } });

    beforeEach(async () => {
        home = mkdtempSync(join(tmpdir(), "ccc-broker-flow-"));
        log = join(home, "requests.log");
        behavior = join(home, "behavior.json");
        auth = join(home, "auth.json");
        writeFileSync(log, "");
        writeFileSync(behavior, "{}");
        const owner = ownerId();
        writeFileSync(auth, JSON.stringify({ ownerId: owner, secret: "b".repeat(64) }), { mode: 0o600 });
        for (const key of Object.keys(process.env)) if (/^(CCC_|ANDROID_)/i.test(key)) vi.stubEnv(key, undefined);
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("CCC_DEVICE_BROKER_AUTH_FILE", auth);
        vi.stubEnv("CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER", "");
        const port = await freePort();
        const script = join(home, "broker.cjs");
        writeFileSync(script, `
const fs=require('fs'),http=require('http'),crypto=require('crypto');
const log=${JSON.stringify(log)},behavior=${JSON.stringify(behavior)},owner=${JSON.stringify(owner)},port=${port};
const stat=fs.readFileSync('/proc/self/stat','utf8');
const token='linux:'+stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19];
const startedAt=new Date().toISOString();
const server=http.createServer((req,res)=>{
 fs.appendFileSync(log,req.url+'\\n');
 const state=JSON.parse(fs.readFileSync(behavior,'utf8'));
 const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 if(req.url==='/health')return send(200,{ok:true,name:'ccc-device-broker'});
 if(req.url==='/status')return send(200,{ok:true,broker:{name:'ccc-device-broker',mode:'host-broker-daemon',port,process:{pid:process.pid,startToken:state.changedGeneration?'replacement-token':token},startedAt,protocolVersion:state.incompatible?0:${JSON.stringify(DEVICE_BROKER_PROTOCOL_VERSION)}}});
 if(req.url==='/v1/owner/resolve')return send(200,{ok:true,result:{ownerId:owner}});
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  const h=req.headers,secret=JSON.parse(fs.readFileSync(${JSON.stringify(auth)},'utf8')).secret;
  const ownerToken=crypto.createHash('sha256').update('ccc-device-broker:owner:'+owner+':secret:'+secret).digest('hex');
  const payload=['v1',owner,h['x-ccc-device-auth-timestamp'],h['x-ccc-device-auth-nonce'],startedAt,token,crypto.createHash('sha256').update(body).digest('hex')].join('\\n');
  const expected=crypto.createHmac('sha256',ownerToken).update(payload).digest('hex');
  if(h['x-ccc-device-auth']!==expected)return send(401,{ok:false,error:'bad-generation-auth'});
  send(state.rpcFailure?503:200,state.rpcFailure?{ok:false,error:'temporary-provider-failure'}:{ok:true,result:{echo:JSON.parse(body).params}});
 });
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({pid:process.pid,processStartToken:token,startedAt})+'\\n'));
`);
        child = spawn(process.execPath, [script, "devices", "broker", "serve", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
        const [data] = await once(child.stdout!, "data");
        const runtime = { ...JSON.parse(String(data)), name: "ccc-device-broker", ownerId: owner, managedBy: "ccc-host", host: "127.0.0.1", port, command: process.execPath, args: [script, "devices", "broker", "serve", "--port", String(port)] };
        const root = join(home, ".ccc", "devices", "broker");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "runtime.json"), JSON.stringify(runtime));
        options = { hostCandidates: ["127.0.0.1"], port, autolaunch: true, timeoutMs: 2000 };
    }, 15000);

    afterEach(async () => {
        if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
        vi.unstubAllEnvs();
        if (home) rmSync(home, { recursive: true, force: true });
    });

    it("uses one setup and resolves owner once, while attesting every RPC", async () => {
        await withBrokerOperation(async () => {
            expect((await brokerStatus(options)).rpcReady).toBe(true);
            expect((await rpc()).ok).toBe(true);
            expect((await rpc()).ok).toBe(true);
        });
        expect(count("/health")).toBe(1);
        expect(count("/v1/owner/resolve")).toBe(1);
        expect(count("/status")).toBe(3);
        expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(2);
    });

    it("does not share successful setup across sequential or overlapping operation scopes", async () => {
        await withBrokerOperation(rpc);
        await withBrokerOperation(rpc);
        await Promise.all([withBrokerOperation(rpc), withBrokerOperation(rpc)]);
        expect(count("/health")).toBe(4);
        expect(count("/v1/owner/resolve")).toBe(4);
        expect(count("/status")).toBe(8);
    });

    it("starts fresh nested operation scopes", async () => {
        await withBrokerOperation(async () => {
            expect((await withBrokerOperation(rpc)).ok).toBe(true);
            expect((await withBrokerOperation(rpc)).ok).toBe(true);
        });
        expect(count("/health")).toBe(2);
        expect(count("/v1/owner/resolve")).toBe(2);
    });

    it("isolates every device_run_flow step through the actual MCP server", { timeout: 15000 }, async () => {
        const client = new Client({ name: "broker-flow-regression", version: "1" }, { capabilities: {} });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL("../../device-lab-mcp/server.mjs", import.meta.url))],
            env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        });
        try {
            await client.connect(transport);
            const result = await client.callTool({
                name: "run_flow",
                arguments: { steps: [0, 1].map(() => ({
                    tool: "devices", arguments: { view: "available", ...options, backend: "android-emulator", viaBroker: true },
                })) },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
            expect(payload.ok, JSON.stringify(payload)).toBe(true);
            expect(payload.results).toHaveLength(2);
            expect(count("/health")).toBe(2);
            expect(count("/v1/owner/resolve")).toBe(2);
            expect(count("/status")).toBe(4);
            expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(2);
        } finally {
            await client.close();
        }
    });

    it("refuses changed generation before sending an authenticated RPC", async () => {
        await withBrokerOperation(async () => {
            expect((await brokerStatus(options)).rpcReady).toBe(true);
            writeFileSync(behavior, JSON.stringify({ changedGeneration: true }));
            expect(await rpc()).toEqual(expect.objectContaining({ ok: false, error: "broker-runtime-process-unverified" }));
        });
        expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(0);
        expect(count("/status")).toBe(2);
    });

    it.each(["test", "production"])("authenticates every RPC with autolaunch disabled and no fixture authorization in %s mode", async (nodeEnv) => {
        vi.stubEnv("NODE_ENV", nodeEnv);
        vi.stubEnv("CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER", undefined);
        const request = () => brokerRpc({ ...options, autolaunch: false, method: "broker.echo", params: { message: "attested" } });

        await withBrokerOperation(async () => {
            expect(await request()).toMatchObject({ ok: true, result: { echo: { message: "attested" } } });
            expect(count("/status")).toBe(1);
            expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(1);

            expect((await request()).ok).toBe(true);
            expect(count("/status")).toBe(2);
            expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(2);

            writeFileSync(behavior, JSON.stringify({ changedGeneration: true }));
            expect(await request()).toMatchObject({ ok: false, error: "broker-runtime-process-unverified" });
            expect(count("/status")).toBe(3);
            expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(2);
        });
        expect(count("/health")).toBe(0);
    });

    it("reads owner credentials freshly instead of caching a token", async () => {
        await withBrokerOperation(async () => {
            expect((await rpc()).ok).toBe(true);
            rmSync(auth);
            expect(await rpc()).toEqual(expect.objectContaining({ ok: false, error: "broker-owner-auth-unavailable" }));
        });
        expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(1);
    });

    it("does not cache failed setup and can recover in the same scope", async () => {
        await withBrokerOperation(async () => {
            writeFileSync(behavior, JSON.stringify({ incompatible: true }));
            expect((await rpc()).ok).toBe(false);
            writeFileSync(behavior, "{}");
            expect((await rpc()).ok).toBe(true);
        });
        expect(count("/health")).toBe(2);
    });

    it("invalidates setup after a failed RPC without automatically replaying it", async () => {
        await withBrokerOperation(async () => {
            writeFileSync(behavior, JSON.stringify({ rpcFailure: true }));
            expect((await rpc()).ok).toBe(false);
            expect(requests().filter(path => path.endsWith("/rpc"))).toHaveLength(1);
            writeFileSync(behavior, "{}");
            expect((await rpc()).ok).toBe(true);
        });
        expect(count("/health")).toBe(2);
        expect(count("/v1/owner/resolve")).toBe(2);
    });

    it("does not reuse setup across different launch budgets or ordered route candidates", async () => {
        await withBrokerOperation(async () => {
            expect((await rpc()).ok).toBe(true);
            expect((await brokerRpc({ ...options, timeoutMs: 1500, method: "broker.echo" })).ok).toBe(true);
            expect((await brokerRpc({ ...options, hostCandidates: ["127.0.0.1", "host.docker.internal"], method: "broker.echo" })).ok).toBe(true);
        });
        expect(count("/health")).toBe(3);
        expect(count("/v1/owner/resolve")).toBe(3);
        expect(count("/status")).toBe(6);
    });

    it("keeps autolaunch false independent of a preceding successful setup", async () => {
        await withBrokerOperation(async () => {
            expect((await rpc()).ok).toBe(true);
            expect((await brokerRpc({ ...options, autolaunch: false, method: "broker.echo" })).ok).toBe(true);
        });
        expect(count("/health")).toBe(1);
        expect(count("/v1/owner/resolve")).toBe(2);
        expect(count("/status")).toBe(3);
    });
});
