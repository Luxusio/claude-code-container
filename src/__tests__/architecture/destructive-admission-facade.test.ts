import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as facade from "../../../device-lab-mcp/src/policy/destructive.mjs";
import { evaluateDestructivePolicy } from "@ccc/device-lab/providers/domain/destructive-admission.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, repoRoot, TIMEOUT, type DeviceLabMcpTestContext } from "../helpers/device-lab-mcp-fixture.js";
function payload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return JSON.parse((result.content as Array<{ text?: string }>)[0].text ?? "");
}
function snapshot(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    function visit(directory: string, prefix = "") {
        for (const name of readdirSync(directory).sort()) {
            if (["admission-loader.mjs", "admission-preload.cjs", "admission-armed", "admission-effects.log", "admission-hooks.log"].includes(name)) continue;
            const path = join(directory, name), relative = prefix + name;
            if (statSync(path).isDirectory()) visit(path, relative + "/");
            else files[relative] = readFileSync(path).toString("base64");
        }
    }
    visit(root); return files;
}

// Loader adds observation/block guards at downstream entries. Public request handler,
// schemas, normalization and policy evaluation execute unchanged in the real stdio server.
function loaderSource(home: string) {
    return String.raw`import {appendFileSync,existsSync} from 'node:fs';
const home=${JSON.stringify(home)};
const hooks=home+'/admission-hooks.log';
const guard="if(__admissionExists(__admissionHome+'/admission-armed')){__admissionAppend(__admissionHome+'/admission-effects.log',__admissionLabel+String.fromCharCode(10));throw new Error('downstream admission fence crossed:'+__admissionLabel);} ";
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 if(result.format!=='module'||!result.source)return result;
 let source=String(result.source), names=[];
 if(url.endsWith('/device-lab-mcp/src/server.mjs')) names=['inferLifecycleBackend','dispatchTool'];
 if(url.endsWith('/providers/backends/android.mjs')) names=['handleAndroidTool'];
 if(url.endsWith('/device-lab-mcp/src/broker.mjs')) names=['brokerRpc','brokerCommand','brokerDeviceTool','brokerAppium','brokerPhysical'];
 if(!names.length)return result;
 for(const name of names){
  const pattern=new RegExp('((?:export )?(?:async )?function '+name+'\\([^]*?\\)\\s*\\{)');
  if(!pattern.test(source))throw new Error('missing downstream instrumentation:'+name);
  source=source.replace(pattern,match=>match+'const __admissionLabel='+JSON.stringify(name)+';'+guard);
  appendFileSync(hooks,name+String.fromCharCode(10));
 }
 source="import {appendFileSync as __admissionAppend,existsSync as __admissionExists} from 'node:fs';const __admissionHome="+JSON.stringify(home)+";"+String.fromCharCode(10)+source;
 return {...result,source};
}`;
}
function preloadSource(home: string) {
    return `const cp=require('node:child_process'),fs=require('node:fs');const home=${JSON.stringify(home)};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){const original=cp[name];cp[name]=function(...args){if(fs.existsSync(home+'/admission-armed')){fs.appendFileSync(home+'/admission-effects.log','native:'+name+String.fromCharCode(10));throw new Error('native admission fence crossed');}return original.apply(this,args);};}
require('node:module').syncBuiltinESMExports();`;
}

describe("destructive admission compatibility facade", () => {
    it("directly reexports the exact canonical evaluator and preserves schema data and mutability", () => {
        expect(Object.keys(facade).sort()).toEqual(["DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES", "evaluateDestructivePolicy"]);
        expect(facade.evaluateDestructivePolicy).toBe(evaluateDestructivePolicy);
        const source = readFileSync(join(repoRoot, "device-lab-mcp/src/policy/destructive.mjs"), "utf8");
        expect(source).toContain('"@ccc/device-lab/providers/domain/destructive-admission.mjs"');
        expect(facade.DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES.length).toBeGreaterThan(0);
        const examples = facade.DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES;
        expect(Object.isFrozen(examples)).toBe(false);
        const prior = [...examples];
        examples.reverse();
        try { expect(facade.DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES).toBe(examples); expect(examples).toEqual(prior.reverse()); }
        finally { examples.reverse(); }
    });

    let context: DeviceLabMcpTestContext;
    beforeAll(async () => {
        // env is populated by setupHome before the helper constructs its stdio transport.
        const env: Record<string, string> = {};
        context = await createDeviceLabMcpTestContext({ rawPublicCalls: true, env, setupHome(home) {
            const loader = join(home, "admission-loader.mjs"), preload = join(home, "admission-preload.cjs");
            writeFileSync(loader, loaderSource(home)); writeFileSync(preload, preloadSource(home));
            writeFileSync(join(home, "admission-effects.log"), ""); writeFileSync(join(home, "admission-hooks.log"), "");
            mkdirSync(join(home, "fixture-state")); writeFileSync(join(home, "fixture-state/device.json"), '{"present":true}');
            env.NODE_OPTIONS = `--require=${JSON.stringify(join(home, "isolate-broker-auth.cjs"))} --require=${JSON.stringify(preload)} --experimental-loader=${pathToFileURL(loader).href}`;
        } });
        writeFileSync(join(context.homeDir, "admission-armed"), "armed");
    }, TIMEOUT);
    afterAll(async () => { await cleanupDeviceLabMcpTestContext(context); }, TIMEOUT);

    it("denies a real public request with zero routing, provider, native or persisted fixture effects", { timeout: TIMEOUT }, async () => {
        const hooks = readFileSync(join(context.homeDir, "admission-hooks.log"), "utf8").trim().split("\n");
        for (const name of ["inferLifecycleBackend", "dispatchTool", "handleAndroidTool", "brokerRpc", "brokerCommand", "brokerDeviceTool", "brokerAppium", "brokerPhysical"]) expect(hooks).toContain(name);
        const before = snapshot(context.homeDir);
        const denied = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", detail: true } });
        expect(denied.isError).toBe(true);
        expect(payload(denied)).toEqual(expect.objectContaining({ ok: false, policy: {
            ok: false, destructive: true, error: "destructive-action-confirmation-required",
            message: "Set confirmDestructive=true to run this destructive device-lab action.",
            confirmationField: "confirmDestructive", actions: ["device-delete"],
        } }));
        expect(readFileSync(join(context.homeDir, "admission-effects.log"), "utf8")).toBe("");
        expect(snapshot(context.homeDir)).toEqual(before);
    });

    it("preserves public validation presentation and refuses parent flow confirmation", { timeout: TIMEOUT }, async () => {
        expect(existsSync(join(context.homeDir, "admission-armed"))).toBe(true);
        const invalid = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", confirmDestructive: "true" } });
        expect(invalid.isError).toBe(true);
        expect(payload(invalid)).toMatchObject({ ok: false, error: "delete confirmDestructive must be a boolean" });
        expect(payload(invalid)).not.toHaveProperty("policy");
        expect(readFileSync(join(context.homeDir, "admission-effects.log"), "utf8")).toBe("");
        const detailed = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", confirmDestructive: "true", detail: true } });
        expect(detailed.isError).toBe(true);
        expect(payload(detailed)).toMatchObject({ ok: false, error: "delete confirmDestructive must be a boolean" });
        expect(payload(detailed)).not.toHaveProperty("policy");
        const missingConfirmation = await context.client.callTool({ name: "delete", arguments: { deviceId: "android-admission-owned", detail: true } });
        expect(missingConfirmation.isError).toBe(true);
        expect(payload(missingConfirmation)).toMatchObject({ ok: false, policy: { error: "destructive-action-confirmation-required", confirmationField: "confirmDestructive", actions: ["device-delete"] } });
        const parent = await context.client.callTool({ name: "run_flow", arguments: { confirmDestructive: true,
            steps: [{ tool: "clear_app_data", arguments: { deviceId: "android-admission-owned", appId: "example.app" } }] } });
        expect(parent.isError).toBe(true);
        expect(payload(parent)).toMatchObject({ ok: false, error: "run_flow does not support confirmDestructive" });
        const step = await context.client.callTool({ name: "run_flow", arguments: { detail: true,
            steps: [{ tool: "clear_app_data", arguments: { deviceId: "android-admission-owned", appId: "example.app" } }] } });
        expect(step.isError).toBe(true);
        expect(payload(step)).toMatchObject({ ok: false, stoppedAt: 0, results: [{ isError: true,
            content: [{ value: { policy: { error: "destructive-action-confirmation-required", actions: ["app-data-clear"] } } }] }] });
        expect(readFileSync(join(context.homeDir, "admission-effects.log"), "utf8")).toBe("");
    });
});
