import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { androidHostAvds, androidHostDevices, simulatorObservation, presentSimulatorCatalog } from "../../../packages/device-lab/providers/adapters/mobile-inventory.mjs";
import { nodeProviderFixturePreloadSource } from "../helpers/node-provider-fixture.js";
import { deviceLabTestHomeEnvironment } from "../helpers/device-lab-test-environment.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runner = String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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
 const status=await invoke({action:'status',timeoutMs:1});assert.equal(status.value.hostDevices.available,true);
 const connected=await invoke({action:'connect',host:'192.0.2.1'});assert.equal(connected.value.target,'192.0.2.1:5555');assert.equal(connected.value.stateMutated,false);
 const bounded=await invoke({action:'connect',host:'192.0.2.1',timeoutMs:60000});assert.equal(bounded.value.target,'192.0.2.1:5555');
 const failed=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'654321'});
 assert.equal(failed.envelope.isError,true);assert.equal(failed.value.error,'android-wireless-pair-failed');
 assert(!JSON.stringify(failed).includes('654321'));assert(failed.value.command.args.includes('[redacted]'));
 const malformed=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'987654\u0000'});
 assert.equal(malformed.envelope.isError,true);assert.equal(malformed.value.error,'android-wireless-pair-failed');
 assert.equal(malformed.value.command.status,null);assert(!JSON.stringify(malformed).includes('987654'));
 assert.equal(malformed.value.command.error,'android-wireless-pair-command-failed');
 const followup=await invoke({action:'pair',pairHost:'192.0.2.2',pairPort:37099,pairingCode:'123456',host:'192.0.2.99'});
 assert.equal(followup.value.error,'android-wireless-connect-failed');assert(!JSON.stringify(followup).includes('123456'));assert(followup.value.pair.args.includes('[redacted]'));
 const budgets=readFileSync(process.env.WIRELESS_TIMEOUT_LOG,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert(budgets.some(row=>row.action==='devices'&&row.timeout===120000));
 assert(budgets.some(row=>row.action==='connect'&&row.timeout===15000));
 assert(budgets.some(row=>row.action==='connect'&&row.timeout===30000));
 process.stdout.write(JSON.stringify({status:status.value,connected:connected.value,failed:failed.value,malformed:malformed.value,followup:followup.value}));
} finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
`;
describe("Android wireless actual authenticated default child", () => {
    it("uses native inventory/connect and masks pairing credentials on both failure paths", () => {
        const owned = mkdtempSync(join(tmpdir(), "ccc-wireless-native-")); chmodSync(owned, 0o700);
        const home = join(owned, "home"), bin = join(owned, "bin"); mkdirSync(home); mkdirSync(bin);
        const adb = join(bin, "adb"), preload = join(owned, "routing.cjs"), timeoutLog = join(owned, "timeouts.jsonl");
        writeFileSync(adb, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='devices'){console.log('List of devices attached\\nUSB device');} else if(a[0]==='pair'){console.log(a[2]+' raw stdout');console.error(a[2]+' raw stderr');if(a[2]==='654321')process.exitCode=17;} else if(a[0]==='connect'){console.log('connected');if(a[1]==='192.0.2.99:5555')process.exitCode=8;} else process.exitCode=2;`);
        chmodSync(adb, 0o755);
        writeFileSync(preload, nodeProviderFixturePreloadSource(bin) + `
const wirelessRoutedSpawnSync = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
    if (path.basename(command) === 'adb' && Array.isArray(args) && ['devices', 'pair', 'connect', '-s'].includes(args[0])) {
        fs.appendFileSync(process.env.WIRELESS_TIMEOUT_LOG, JSON.stringify({action: args[0], timeout: options?.timeout}) + '\\n');
    }
    return wirelessRoutedSpawnSync.call(this, command, args, options);
};
require('node:module').syncBuiltinESMExports();
`);
        try {
            const result = spawnSync(process.execPath, ["--input-type=module"], { input: runner, cwd: root,
                env: { ...process.env, ...deviceLabTestHomeEnvironment(home), PATH: bin, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, WIRELESS_REPO_ROOT: root, WIRELESS_TIMEOUT_LOG: timeoutLog },
                encoding: "utf8", timeout: 60000, maxBuffer: 1024*1024, windowsHide: true });
            expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({ status: { ok: true }, connected: { target: "192.0.2.1:5555" }, failed: { error: "android-wireless-pair-failed" }, followup: { error: "android-wireless-connect-failed" } });
        } finally { rmSync(owned, { recursive: true, force: true }); }
    }, 70000);
});


describe("native mobile inventory decoding", () => {
    it("AVD status controls availability before valid-looking output, while exit-zero output is decoded", () => {
        for (const status of [null, 7]) {
            expect(androidHostAvds({ status, stdout: "valid-looking-avd", stderr: "query refused" }))
                .toEqual({ available: false, missing: [], avds: [], error: "query refused" });
        }
        expect(androidHostAvds({ status: 0, stdout: "  Pixel  \r\n한글\n\n", stderr: "" }))
            .toEqual({ available: true, missing: [], avds: ["Pixel", "한글"] });
        expect(androidHostAvds({ status: 0, stdout: "", stderr: "" }))
            .toEqual({ available: true, missing: [], avds: [] });
        const zeroWithError = { status: 0, stdout: "unit", stderr: "", error: new Error("diagnostic only") };
        expect(androidHostAvds(zeroWithError)).toEqual({ available: true, missing: [], avds: ["unit"] });
    });

    it("ADB nonzero inventory is unavailable instead of attaching output-looking devices", () => {
        const stdout = "List of devices attached\r\nUSB device model:Pixel transport_id:3\r\n[2001:db8::2]:5555 offline\nemulator-5554 device\n";
        expect(androidHostDevices({ status: null, stdout, stderr: "offline" }))
            .toEqual({ available: false, missing: [], devices: [], error: "offline" });
        const zeroWithError = { status: 0, stdout: "", stderr: "", error: new Error("diagnostic only") };
        expect(androidHostDevices(zeroWithError)).toEqual({ available: true, missing: [], devices: [] });
        expect(androidHostDevices({ status: 0, stdout, stderr: "" }).devices).toEqual([
            expect.objectContaining({ serial: "USB", state: "device", connection: "usb", emulator: false, details: { model: "Pixel", transport_id: "3" } }),
            expect.objectContaining({ serial: "[2001:db8::2]:5555", state: "offline", connection: "wifi", emulator: false }),
            expect.objectContaining({ serial: "emulator-5554", state: "device", emulator: true }),
        ]);
    });

    it("simctl parse failures remain failed even when the native process exited zero", () => {
        const observation = simulatorObservation({ error: { status: 0, stdout: "not JSON", stderr: "invalid simulator JSON" } });
        expect(observation.ok).toBe(false);
        expect(presentSimulatorCatalog({ available: true, missing: [] }, observation))
            .toEqual({ available: false, missing: [], devices: {}, runtimes: [], deviceTypes: [], error: "invalid simulator JSON" });
    });

    it("the outward simulator catalog preserves SDK collections and the device-type fallback", () => {
        const devices = { runtime: [{ udid: "unit", name: "Owned", state: "Booted" }] };
        const runtimes = [{ identifier: "runtime" }], types = [{ identifier: "phone" }];
        for (const value of [{ devices, runtimes, devicetypes: types }, { devices, runtimes, deviceTypes: types }]) {
            const observation = simulatorObservation({ value });
            expect(observation.ok).toBe(true);
            expect(presentSimulatorCatalog({ available: true, missing: [] }, observation))
                .toEqual({ available: true, missing: [], devices, runtimes, deviceTypes: types });
        }
        expect(presentSimulatorCatalog({ available: false, missing: ["xcrun"] }))
            .toEqual({ available: false, missing: ["xcrun"], devices: {}, runtimes: [], deviceTypes: [] });
    });
});
