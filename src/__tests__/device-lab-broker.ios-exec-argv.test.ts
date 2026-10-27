import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceLabTestHomeEnvironment } from "./helpers/device-lab-test-environment.js";
import { nodeProviderFixturePreloadSource } from "./helpers/node-provider-fixture.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const udid = "11111111-2222-4333-8444-555555555555";
type Call = { args: string[]; owner: string; cwd: string };
type ResponseReceipt = { status: number; body: { ok: boolean; error?: string; backend?: string; result?: {
    ownerId?: string; backend?: string; deviceId?: string; provider?: string;
    mcpResult?: { isError?: boolean; content: Array<{ text: string }> };
} } };
type Receipt = { owner: string; cwd: string; calls: Call[]; responses: ResponseReceipt[]; inventoryUnchanged: boolean; foreignInventoryUnchanged: boolean; markerExists: boolean; module: string; moduleSha: string };

// This is a normal Node import of Root's current configured package emit. The
// real authenticated HTTP handler launches the real provider child; only the
// private xcrun leaf is a fake. No broker commandRunner or TypeScript loader.
const worker = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const s=JSON.parse(fs.readFileSync(process.env.CCC_IOS_ARGV_FIXTURE,'utf8'));
const broker=await import(s.broker),owners=await import(s.owners);
const owner=owners.deviceLabOwnerId(s.cwd),foreign=owners.deviceLabOwnerId(s.foreignCwd);
broker.registerDeviceBrokerOwner(s.cwd);broker.registerDeviceBrokerOwner(s.foreignCwd);
const root=id=>path.join(s.home,'.ccc','devices','owners',id);
const file=(id,key)=>path.join(root(id),key,'devices.json');
const name='ccc-'+owner+'-exec-fixture';
fs.writeFileSync(path.join(s.home,'simulator-name'),s.mode==='foreign-runtime'?'foreign-simulator':name);
const initial={id:'owned-ios',backend:'ios-simulator',status:'running',udid:s.udid,simulatorName:name};
for(const [id,key,records] of [[owner,'ios',[initial]],[foreign,'ios',[{...initial,id:'foreign-ios',simulatorName:'ccc-'+foreign+'-exec-fixture'}]],
    ...Object.entries({'android':'android-emulator','android-device':'android-device','ios-device':'ios-device','macos':'macos-vm','linux-vm':'linux-vm','windows':'windows-sandbox','windows-vm':'windows-vm'}).map(([key,backend])=>[owner,key,[{id:'owned-'+key,backend,status:'running'}]])]){
 fs.mkdirSync(path.dirname(file(id,key)),{recursive:true});fs.writeFileSync(file(id,key),JSON.stringify({devices:records}));
}
const tracked=fs.readdirSync(root(owner)).map(key=>file(owner,key)).filter(file=>fs.existsSync(file)),before=tracked.map(file=>fs.readFileSync(file,'utf8'));
const foreignBefore=fs.readFileSync(file(foreign,'ios'),'utf8');
const server=broker.createDeviceBrokerServer({cwd:s.cwd,host:'127.0.0.1',port:0,commandTimeoutMs:10000});
const responses=[];
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const endpoint='http://127.0.0.1:'+server.address().port+'/v1/owners/'+owner+'/rpc';
 for(const request of s.requests){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-ccc-device-token':request.wrongToken?'invalid-token':broker.deviceBrokerOwnerToken(owner)},body:JSON.stringify({method:'broker.device.tool.invoke',params:{tool:'device_exec',backend:'ios-simulator',deviceId:'owned-ios',...request.params}}),signal:AbortSignal.timeout(15000)});
  responses.push({status:response.status,body:await response.json()});
 }
 const calls=fs.readFileSync(s.log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 console.log(JSON.stringify({owner,cwd:s.cwd,calls,responses,inventoryUnchanged:tracked.every((file,i)=>fs.readFileSync(file,'utf8')===before[i]),foreignInventoryUnchanged:fs.readFileSync(file(foreign,'ios'),'utf8')===foreignBefore,markerExists:fs.existsSync(s.marker),module:s.broker,moduleSha:crypto.createHash('sha256').update(fs.readFileSync(new URL(s.broker))).digest('hex')}));
}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
`;

function invokeCurrent(mode: "success" | "refusal" | "foreign-runtime", requests: Array<{ params: Record<string, unknown>; wrongToken?: boolean }>): Receipt {
    const root = mkdtempSync(join(tmpdir(), "ccc-ios-exec-argv-"));
    try {
        const home = join(root, "home"), bin = join(root, "bin"), cwd = join(home, "project"), foreignCwd = join(home, "foreign-project");
        for (const directory of [home, bin, cwd, foreignCwd]) mkdirSync(directory, { recursive: true });
        const log = join(home, "native.jsonl"), marker = join(home, "unexpected-host-effect");
        writeFileSync(log, "");
        writeFileSync(join(root, "package.json"), '{"type":"commonjs"}');
        writeFileSync(join(bin, "xcrun"), `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,owner:process.env.CCC_DEVICE_OWNER_ID||'',cwd:process.cwd()})+'\\n');\nif(JSON.stringify(args)===JSON.stringify(['simctl','list','devices','-j'])){process.stdout.write(JSON.stringify({devices:{runtime:[{udid:${JSON.stringify(udid)},name:fs.readFileSync(${JSON.stringify(join(home, "simulator-name"))},'utf8'),state:'Booted'}]}}));}\nelse if(args[0]==='simctl'&&args[1]==='spawn'&&args[2]===${JSON.stringify(udid)}){process.stdout.write('42\\n');}\nelse{process.stderr.write('unexpected fake SDK request');process.exitCode=79;}\n`);
        const preload = join(home, "node-provider.cjs");
        writeFileSync(preload, nodeProviderFixturePreloadSource(bin));
        const module = pathToFileURL(join(project, "packages/device-lab/dist/device-lab-broker.js")).href;
        expect(existsSync(fileURLToPath(module)), "Root must provide current configured package emit").toBe(true);
        const moduleSha = createHash("sha256").update(readFileSync(fileURLToPath(module))).digest("hex");
        const settings = join(home, "settings.json"), entry = join(home, "worker.mjs");
        writeFileSync(settings, JSON.stringify({ home, cwd, foreignCwd, bin, log, marker, mode, udid, requests,
            broker: module, owners: pathToFileURL(join(project, "packages/device-lab/dist/device-lab-owner.js")).href }));
        writeFileSync(entry, worker);
        const output = spawnSync(process.execPath, [entry], { cwd, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024,
            env: { ...deviceLabTestHomeEnvironment(home), PATH: bin, NODE_ENV: "test", NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, CCC_IOS_ARGV_FIXTURE: settings } });
        expect(output.error).toBeUndefined();
        expect(output.status, output.stdout + output.stderr).toBe(0);
        const result = JSON.parse(output.stdout.trim()) as Receipt;
        expect(result.module).toBe(module); expect(result.moduleSha).toBe(moduleSha);
        expect(result.inventoryUnchanged).toBe(true); expect(result.foreignInventoryUnchanged).toBe(true); expect(result.markerExists).toBe(false);
        return result;
    } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("current emitted broker iOS explicit program transport", () => {
    it("keeps exact arguments and legacy shell text through authenticated HTTP and the actual backend child", { timeout: 60000 }, () => {
        const argv = ["launchctl", "", " managerpid ", "$(touch unexpected-host-effect); 'quoted'", "한글\n"];
        const command = "printf '%s\\n' '$HOME'; value='a b'\nprintf '%s' \"$value\"";
        const vectors = [argv, ["x", "y".repeat(4095)], Array(64).fill("x")];
        const result = invokeCurrent("success", [...vectors.map(argv => ({ params: { argv } })), { params: { command } }]);
        for (const response of result.responses) {
            expect(response).toMatchObject({ status: 200, body: { ok: true, result: {
                ownerId: result.owner, backend: "ios-simulator", deviceId: "owned-ios", provider: "device-lab-backend-child",
            } } });
            expect(response.body.result?.mcpResult?.isError).not.toBe(true);
            expect(JSON.parse(response.body.result!.mcpResult!.content[0].text)).toEqual({ stdout: "42\n", stderr: "", status: 0 });
        }
        const executions = result.calls.filter(call => call.args[1] === "spawn");
        expect(executions.map(call => call.args)).toEqual([...vectors.map(argv => ["simctl", "spawn", udid, ...argv]), ["simctl", "spawn", udid, "/bin/sh", "-lc", command]]);
        expect(result.calls).toHaveLength(8);
        for (const call of result.calls) expect(call.cwd).toBe(result.cwd);
    });

    it("independently refuses malformed, non-iOS, missing, foreign and unauthenticated requests before any SDK effect", { timeout: 60000 }, () => {
        const malformed = [{}, { command: "echo old", argv: ["launchctl"] }, { argv: [] }, { argv: "launchctl" },
            { argv: ["launchctl", null] }, { argv: ["/bin/launchctl"] }, { argv: ["bin/launchctl"] }, { argv: ["-option"] },
            { argv: ["launchctl", "a\0b"] }, { argv: Array(65).fill("x") }, { argv: ["x", "y".repeat(4096)] }];
        const otherBackends = [["android-emulator", "android"], ["android-device", "android-device"], ["ios-device", "ios-device"],
            ["macos-vm", "macos"], ["linux-vm", "linux-vm"], ["windows-sandbox", "windows"], ["windows-vm", "windows-vm"]];
        const requests = [...malformed.map(params => ({ params })),
            ...otherBackends.map(([backend, key]) => ({ params: { backend, deviceId: `owned-${key}`, argv: ["launchctl", "managerpid"] } })),
            { params: { deviceId: "missing-ios", argv: ["launchctl"] } }, { params: { deviceId: "foreign-ios", argv: ["launchctl"] } },
            { params: { argv: ["launchctl"] }, wrongToken: true }];
        const result = invokeCurrent("refusal", requests);
        for (const response of result.responses.slice(0, malformed.length)) expect(response).toMatchObject({ status: 400, body: { ok: false, error: "device-exec-input-invalid" } });
        for (const [index, [backend]] of otherBackends.entries()) expect(result.responses[malformed.length + index].body)
            .toMatchObject({ ok: false, error: "device-exec-argv-unsupported", backend });
        for (const response of result.responses.slice(-3, -1)) expect(response).toMatchObject({ status: 404, body: { ok: false } });
        expect(result.responses.at(-1)).toMatchObject({ status: 401, body: { ok: false, error: "invalid-owner-token" } });
        expect(result.calls).toEqual([]);
    });

    it("refuses an owner record whose live Simulator target belongs to another name", { timeout: 60000 }, () => {
        const result = invokeCurrent("foreign-runtime", [{ params: { argv: ["launchctl", "managerpid"] } }]);
        expect(result.responses[0]).toMatchObject({ status: 200, body: { ok: true, result: { mcpResult: { isError: true } } } });
        expect(result.calls.map(call => call.args)).toEqual([["simctl", "list", "devices", "-j"]]);
    });
});
