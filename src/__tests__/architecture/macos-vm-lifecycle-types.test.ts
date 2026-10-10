import { describe, expect, it } from "vitest";
import { createMacosVmLifecycleApplication } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import { createMacosImageSnapshots } from "../../../packages/device-lab/providers/application/macos-image-snapshots.mjs";
import type { MacosImageSnapshotsPorts } from "../../../packages/device-lab/providers/ports/macos-image-snapshots.mjs";
import type { MacosVmLifecyclePorts, MacosVmDevice, MacosVmProcessHandle } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";

// These are strict source AND genuine-emission consumer controls. Vitest alone
// does not check their directives; QA must use skipLibCheck=false on both.
type Result={ok:boolean;value:unknown;content?:{text?:string}[]};
const device:MacosVmDevice={id:"unit",status:"stopped",extra:{raw:true}};
const child={pid:71,unref(){return undefined;}};
const plan={available:true,missing:[],selectedProvider:"tart",providerCommand:"tart",providerInstance:"instance",startCommand:{command:"tart",args:["run","instance"]},stopCommand:{command:"tart",args:["stop","instance"]}};
const ports:MacosVmLifecyclePorts<Result,typeof child>={
    read:()=>[device],find:()=>device,claim:()=>({ok:true}),transition:()=>({matched:false,found:true}),
    owner:()=>"owner",deviceId:()=>"unit",timestamp:()=>"now",now:()=>1,runtimeId:()=>"claim",claimTtlMs:()=>1000,parseLifecycleClaimedAt:value=>Date.parse(value),
    validateSshKey:()=>({ok:true,path:null}),helperMetadata:()=>({}),
    providerPlan:()=>plan,tartPlan:()=>({plan}),publicDevice:value=>value,
    providerCommand:()=>({status:0,stdout:"raw out",stderr:"raw err"}),commandTimedOut:()=>false,tartStartArgs:()=>[],supportsFeature:()=>false,
    spawn:()=>child,waitProviderStart:async()=>null,waitBoot:async()=>({ready:false,skipped:true}),
    waitGuestHelper:async()=>({ok:true}),provisionHelper:()=>({ok:true}),signalRecording:()=>({signaled:false}),waitRecordingExit:async()=>true,
    sshBridge:()=>({discovery:{ssh:"ssh"},target:"host"}),sshBaseArgs:()=>[],shellQuote:value=>value,sshCommandOptions:()=>({}),
    helperCommand:()=>({status:0,stdout:"",stderr:""}),textResult:(ok,value)=>({ok,value}),jsonResult:value=>({ok:true,value}),fail:value=>({ok:false,value}),
};
type OptionalKeys<T>={[K in keyof T]-?:object extends Pick<T,K>?K:never}[keyof T];
const allLeavesRequired:[OptionalKeys<typeof ports>]extends[never]?true:false=true;void allLeavesRequired;
const app=createMacosVmLifecycleApplication(ports);
const synchronousCreate:Result|undefined=app.create({backend:"other"});
const synchronousImage:Result|undefined=app.createImage({backend:"other"});
function positiveAsyncContract(){
    const asynchronousStart:Promise<Result|undefined>=app.start({deviceId:"missing"});
    const recordingExit:Promise<boolean>=ports.waitRecordingExit({runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"a".repeat(64)}},1000);
    void asynchronousStart;void recordingExit;
}
void synchronousCreate;void synchronousImage;void positiveAsyncContract;
function negativeContracts(){
    const {parseLifecycleClaimedAt,...missingParse}=ports;void parseLifecycleClaimedAt;
    // @ts-expect-error original claimed-at parsing requires its explicit native leaf
    createMacosVmLifecycleApplication(missingParse);
    // @ts-expect-error claimed-at parsing returns its native number synchronously
    const asyncParse:typeof ports={...ports,parseLifecycleClaimedAt:async()=>1};
    // @ts-expect-error claimed-at parsing cannot replace the native number with text
    const textParse:typeof ports={...ports,parseLifecycleClaimedAt:()=>"1"};
    void asyncParse;void textParse;
    const {spawn,...missingSpawn}=ports;void spawn;
    // @ts-expect-error spawn is required even for applications used only to create
    createMacosVmLifecycleApplication(missingSpawn);
    const {transition,...missingTransition}=ports;void transition;
    // @ts-expect-error complete-record publication must be provided
    createMacosVmLifecycleApplication(missingTransition);
    // @ts-expect-error owner inventory remains synchronous
    const asyncRead:typeof ports={...ports,read:async()=>[device]};
    // @ts-expect-error current record observation remains synchronous
    const asyncFind:typeof ports={...ports,find:async()=>device};
    // @ts-expect-error claim result must be immediate
    const asyncClaim:typeof ports={...ports,claim:async()=>({ok:true})};
    // @ts-expect-error publication cannot return an unawaited Promise
    const asyncTransition:typeof ports={...ports,transition:async()=>({matched:true,found:true,device})};
    // @ts-expect-error publication must report match and found, not only a device
    const malformedTransition:typeof ports={...ports,transition:()=>({device})};
    // @ts-expect-error key-policy observation cannot be asynchronous
    const asyncKey:typeof ports={...ports,validateSshKey:async()=>({ok:true,path:null})};
    // @ts-expect-error native commands remain immediate raw observations
    const asyncCommand:typeof ports={...ports,providerCommand:async()=>({status:0,stdout:"",stderr:""})};
    // @ts-expect-error command stdout remains a string
    const malformedCommand:typeof ports={...ports,providerCommand:()=>({status:0,stdout:1,stderr:""})};
    // @ts-expect-error launch returns the actual native handle immediately
    const asyncSpawn:typeof ports={...ports,spawn:async()=>child};
    // @ts-expect-error a pid-only handle cannot preserve native unref
    const missingUnref:MacosVmProcessHandle={pid:71};
    // @ts-expect-error launch wait is asynchronous
    const syncWait:typeof ports={...ports,waitProviderStart:()=>null};
    // @ts-expect-error boot readiness is asynchronous
    const syncBoot:typeof ports={...ports,waitBoot:()=>({ready:true})};
    // @ts-expect-error helper readiness carries async completion
    const syncHelper:typeof ports={...ports,waitGuestHelper:()=>({ok:true})};
    // @ts-expect-error immediate provisioning cannot become a Promise
    const asyncProvision:typeof ports={...ports,provisionHelper:async()=>({ok:true})};
    // @ts-expect-error signal has an immediate structured result
    const weakSignal:typeof ports={...ports,signalRecording:()=>false};
    // @ts-expect-error recorder exit is awaited
    const syncExit:typeof ports={...ports,waitRecordingExit:()=>true};
    // @ts-expect-error recorder exit observation requires the complete runtime generation, not a PID
    ports.waitRecordingExit(17,1000);
    // @ts-expect-error a PID-only native adapter cannot implement generation-aware exit observation
    const pidOnlyExit:typeof ports={...ports,waitRecordingExit:async(_pid:number)=>true};
    // @ts-expect-error mutable device identity is still a string
    const malformedDevice:MacosVmDevice={id:3};
    // @ts-expect-error start is asynchronous, even on an early refusal
    const synchronousStart:Result|undefined=app.start({deviceId:"missing"});
    // @ts-expect-error create stays synchronous
    const promisedCreate:Promise<Result|undefined>=app.create({backend:"other"});
    void asyncRead;void asyncFind;void asyncClaim;void asyncTransition;void malformedTransition;void asyncKey;
    void asyncCommand;void malformedCommand;void asyncSpawn;void missingUnref;void syncWait;void syncBoot;void pidOnlyExit;
    void syncHelper;void asyncProvision;void weakSignal;void syncExit;void malformedDevice;void synchronousStart;void promisedCreate;
}
void negativeContracts;
const imagePorts:MacosImageSnapshotsPorts<Result>={...ports,snapshotId:()=>"snapshot-before",
    providerCommand:()=>({status:0,stdout:"",stderr:""}),publicDevice:value=>value,waitRecordingExit:async()=>true};
const imageApp=createMacosImageSnapshots(imagePorts,app);
function imageContracts(){
    const cloned:Promise<Result|undefined>=imageApp.clone({sourceDeviceId:"unit",deviceId:"copy"});
    const snapshot:Promise<Result|undefined>=imageApp.createSnapshot({deviceId:"unit",snapshotName:"Before"});
    const restored:Promise<Result|undefined>=imageApp.restoreSnapshot({deviceId:"unit",snapshotName:"Before"});
    const deleted:Promise<Result|undefined>=imageApp.deleteSnapshot({deviceId:"unit",snapshotName:"Before"});
    const {claim,...missingClaim}=imagePorts;void claim;
    // @ts-expect-error destination publication is a required native capability
    createMacosImageSnapshots(missingClaim,app);
    const {transition,...missingTransition}=imagePorts;void transition;
    // @ts-expect-error snapshot and source publication require complete-record CAS
    createMacosImageSnapshots(missingTransition,app);
    // @ts-expect-error reused lifecycle policy must be explicitly composed
    createMacosImageSnapshots(imagePorts);
    // @ts-expect-error clone and delete commands remain synchronous observations
    const deferredCommand:typeof imagePorts={...imagePorts,providerCommand:async()=>({status:0,stdout:"",stderr:""})};
    // @ts-expect-error source/current inventory cannot be an unawaited Promise
    const deferredFind:typeof imagePorts={...imagePorts,find:async()=>device};
    // @ts-expect-error candidate publication must immediately report its CAS outcome
    const deferredTransition:typeof imagePorts={...imagePorts,transition:async()=>({matched:true,found:true,device})};
    // @ts-expect-error recording settlement is awaited rather than inferred from a synchronous flag
    const unawaitedRecording:typeof imagePorts={...imagePorts,waitRecordingExit:()=>true};
    void cloned;void snapshot;void restored;void deleted;void deferredCommand;void deferredFind;void deferredTransition;void unawaitedRecording;
}
void imageContracts;
describe("macOS strict required native contracts",()=>{
    it("retains mutable raw records and pure factory construction",()=>{
        device.extra={changed:true};expect(device.extra).toEqual({changed:true});
        expect(synchronousCreate).toBeUndefined();expect(synchronousImage).toBeUndefined();
    });
});

