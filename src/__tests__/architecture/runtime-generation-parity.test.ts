import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

describe("shipped auxiliary generation facade", () => {
    it("preserves actual source/embedded resolution, effect order, defaults and legacy results", () => {
        for (const path of ["domain/runtime-generation.mjs", "ports/runtime-generation.mjs", "application/runtime-generation.mjs", "state/runtime-generation.mjs"]) {
            expect(readFileSync(join(repository, "dist/packages/device-lab/providers", path), "utf8"), path)
                .toBe(readFileSync(join(repository, "packages/device-lab/providers", path), "utf8"));
        }
        // Fixtures are confined to this disposable Node subprocess. Use real
        // module resolution and live builtin bindings, never rewrite the source.
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import assert from 'node:assert/strict';
            import crypto from 'node:crypto';
            import {syncBuiltinESMExports} from 'node:module';
            let trace=[];
            let dateFault=null;
            let uuidFault=null;
            const NativeDate=Date;
            globalThis.Date=class extends NativeDate {
                constructor() {trace.push('date');super('2026-07-14T00:00:00.000Z');}
                toISOString() {trace.push('iso');if(dateFault)throw dateFault;return super.toISOString();}
            };
            crypto.randomUUID=()=>{trace.push('uuid');if(uuidFault)throw uuidFault;return 'next-generation';};
            syncBuiltinESMExports();
            const outputs=[];
            for(const path of ['./packages/device-lab/providers/state/runtime-generation.mjs','./dist/packages/device-lab/providers/state/runtime-generation.mjs']) {
                const m=await import(path);
                const cases=[];
                trace=[];
                assert.deepEqual(m.claimRecordingFinalization(null,'target',null),{committed:false,device:null});
                assert.deepEqual(trace,['date','iso']);
                cases.push(trace);
                trace=[];
                assert.deepEqual(m.claimRecordingFinalization(null,'target',[],{},undefined),{committed:false,device:null});
                assert.deepEqual(trace,['date','iso']);
                for(const explicit of [null,'custom',42]) {
                    trace=[];
                    const previous={runtimeId:'old'};
                    let record={id:'target',recording:previous};
                    const updater=(id,callback)=>{trace.push('update:'+id);record=callback(record);return record;};
                    const claimed=m.claimRecordingFinalization(updater,'target',previous,{active:true,runtimeId:'override'},explicit);
                    assert.equal(claimed.committed,true);
                    assert.equal(claimed.device.updatedAt,explicit);
                    assert.deepEqual(claimed.device.recording,{runtimeId:'next-generation',active:false,recorderRuntimeId:'old',finalizingAt:explicit});
                    assert.deepEqual(trace,['uuid','update:target']);
                    cases.push({explicit,claimed,trace});
                }
                for(const [method,field] of [['transitionRecordingGeneration','recording'],['transitionAppiumGeneration','appium']]) {
                    trace=[];
                    let record={id:'target',[field]:null};
                    const receipt={id:'persisted-result'};
                    const updater=(id,callback)=>{trace.push('update:'+id);record=callback(record);return receipt;};
                    const transitioned=m[method](updater,'target',null,{runtimeId:'new'});
                    assert.equal(transitioned.device,receipt);
                    assert.equal(record.updatedAt,'2026-07-14T00:00:00.000Z');
                    assert.deepEqual(trace,['date','iso','update:target']);
                    // Legacy runtime return values are not eagerly normalized.
                    assert.equal(m[method](()=>undefined,'target',null,{},null).device,undefined);
                    cases.push({field,transitioned,record,trace});
                }
                trace=[];
                dateFault=new Error('date conversion failed');
                assert.throws(()=>m.claimRecordingFinalization(null,'target',null),error=>error===dateFault);
                assert.deepEqual(trace,['date','iso']);
                dateFault=null;
                trace=[];
                uuidFault=new Error('entropy failed');
                assert.throws(()=>m.claimRecordingFinalization(()=>{throw Error('updater must not run');},'target',{}, {},'stamp'),error=>error===uuidFault);
                assert.deepEqual(trace,['uuid']);
                uuidFault=null;
                trace=[];
                const fault=new Error('publication failed');
                assert.throws(()=>m.transitionRecordingGeneration(()=>{trace.push('update');throw fault;},'target',null,null,'stamp'),error=>error===fault);
                assert.deepEqual(trace,['update']);
                assert.equal(m.runtimeGenerationMatches({runtimeId:''},{runtimeId:''}),false);
                assert.equal(m.recordingGenerationMatches({pid:42},{pid:42}),true);
                assert.equal(m.appiumGenerationMatches({serverPid:42},{serverPid:42}),true);
                outputs.push(cases);
            }
            assert.deepEqual(outputs[0],outputs[1]);
            console.log('source/embedded generation parity PASS');
        `], { cwd: repository, encoding: "utf8", timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("source/embedded generation parity PASS");
    });
});
