import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { nodeProviderFixturePreloadSource } from "../helpers/node-provider-fixture.js";
import { deviceLabTestHomeEnvironment } from "../helpers/device-lab-test-environment.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runner = String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root=process.env.WIRELESS_REPO_ROOT, home=process.env.HOME;
const {createDeviceBrokerServer,deviceBrokerOwnerToken}=await import(pathToFileURL(join(root,'packages/device-lab/dist/device-lab-broker.js')));
const {deviceLabOwnerId}=await import(pathToFileURL(join(root,'packages/device-lab/dist/device-lab-owner.js')));
const server=createDeviceBrokerServer({cwd:home,host:'127.0.0.1',port:0});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
 const owner=deviceLabOwnerId(home),endpoint='http://127.0.0.1:'+server.address().port+'/v1/owners/'+owner+'/rpc';
 const invoke=async args=>{
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-ccc-device-token':deviceBrokerOwnerToken(owner)},body:JSON.stringify({method:'broker.device.tool.invoke',params:{tool:'device_wireless',backend:'android-device',...args}})});
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.result.provider,'device-lab-backend-child');
  return {envelope:body.result.mcpResult,value:JSON.parse(body.result.mcpResult.content[0].text)};
 };
 const status=await invoke({action:'status'});assert.equal(status.value.hostDevices.available,true);
 const connected=await invoke({action:'connect',host:'192.0.2.1'});assert.equal(connected.value.target,'192.0.2.1:5555');assert.equal(connected.value.stateMutated,false);
 const failed=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'654321'});
 assert.equal(failed.envelope.isError,true);assert.equal(failed.value.error,'android-wireless-pair-failed');
 assert(!JSON.stringify(failed).includes('654321'));assert(failed.value.command.args.includes('[redacted]'));
 const malformed=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'987654\u0000'});
 assert.equal(malformed.envelope.isError,true);assert.equal(malformed.value.error,'android-wireless-pair-failed');
 assert.equal(malformed.value.command.status,null);assert(!JSON.stringify(malformed).includes('987654'));
 assert.equal(malformed.value.command.error,'android-wireless-pair-command-failed');
 const followup=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'123456',host:'192.0.2.99'});
 assert.equal(followup.value.error,'android-wireless-connect-failed');assert(!JSON.stringify(followup).includes('123456'));assert(followup.value.pair.args.includes('[redacted]'));
 process.stdout.write(JSON.stringify({status:status.value,connected:connected.value,failed:failed.value,malformed:malformed.value,followup:followup.value}));
} finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
`;
describe("Android wireless actual authenticated default child", () => {
    it("uses native inventory/connect and masks pairing credentials on both failure paths", () => {
        const owned = mkdtempSync(join(tmpdir(), "ccc-wireless-native-")); chmodSync(owned, 0o700);
        const home = join(owned, "home"), bin = join(owned, "bin"); mkdirSync(home); mkdirSync(bin);
        const adb = join(bin, "adb"), preload = join(owned, "routing.cjs");
        writeFileSync(adb, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='devices'){console.log('List of devices attached\\nUSB device');} else if(a[0]==='pair'){console.log(a[2]+' raw stdout');console.error(a[2]+' raw stderr');if(a[2]==='654321')process.exitCode=17;} else if(a[0]==='connect'){console.log('connected');if(a[1]==='192.0.2.99:5555')process.exitCode=8;} else process.exitCode=2;`);
        chmodSync(adb, 0o755); writeFileSync(preload, nodeProviderFixturePreloadSource(bin));
        try {
            const result = spawnSync(process.execPath, ["--input-type=module"], { input: runner, cwd: root,
                env: { ...process.env, ...deviceLabTestHomeEnvironment(home), PATH: bin, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, WIRELESS_REPO_ROOT: root },
                encoding: "utf8", timeout: 60000, maxBuffer: 1024*1024, windowsHide: true });
            expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({ status: { ok: true }, connected: { target: "192.0.2.1:5555" }, failed: { error: "android-wireless-pair-failed" }, followup: { error: "android-wireless-connect-failed" } });
        } finally { rmSync(owned, { recursive: true, force: true }); }
    }, 70000);
});
