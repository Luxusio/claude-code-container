import { describe, expect, it } from "vitest";
import { createMacosVmLifecycleApplication } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import type { MacosVmLifecycle, MacosVmNativeLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import { createMacosImageSnapshots } from "../../../packages/device-lab/providers/application/macos-image-snapshots.mjs";
import type { MacosImageSnapshotsPorts } from "../../../packages/device-lab/providers/ports/macos-image-snapshots.mjs";
import type { MacosVmLifecyclePorts, MacosVmDevice, MacosVmProcessHandle, MacosNativeCloneFailureEvidence, MacosVmLifecycleOutcome, MacosVmStartBudget } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";

// These are strict source AND genuine-emission consumer controls. Vitest alone
// does not check their directives; QA must use skipLibCheck=false on both.
type Result={ok:boolean;value:unknown};
const device:MacosVmDevice={id:"unit",status:"stopped",extra:{raw:true}};
const child={pid:71,unref(){return undefined;}};
const plan={available:true,missing:[],selectedProvider:"tart",providerCommand:"tart",providerInstance:"instance",startCommand:{command:"tart",args:["run","instance"]},stopCommand:{command:"tart",args:["stop","instance"]}};
const nativePlan={available:true,missing:[],selectedProvider:"tart",providerInstance:"instance",stopAvailable:true,evidence:plan};
const observation={ok:true,timedOut:false,detail:"",evidence:{status:0,stdout:"",stderr:""}};
const ports:MacosVmLifecyclePorts<typeof child>={
    read:()=>[device],find:()=>device,claim:()=>({ok:true}),transition:()=>({matched:false,found:true}),
    owner:()=>"owner",deviceId:()=>"unit",timestamp:()=>"now",now:()=>1,monotonicNow:()=>17.25,runtimeId:()=>"claim",claimTtlMs:()=>1000,parseLifecycleClaimedAt:value=>Date.parse(value),
    validateSshKey:()=>({ok:true,path:null}),helperMetadata:()=>({}),
    providerPlan:()=>nativePlan,tartPlan:()=>({plan:nativePlan}),
    cloneInstance:()=>observation,deleteInstance:()=>observation,stopInstance:()=>observation,
    launchProvider:()=>({child,startCommand:plan.startCommand}),waitProviderStart:async()=>null,waitBoot:async()=>({ready:false,skipped:true}),
    waitGuestHelper:async()=>({ok:true}),provisionHelper:()=>({ok:true}),signalRecording:()=>({signaled:false}),waitRecordingExit:async()=>true,
    interruptGuestRecording:()=>undefined,

};
type OptionalKeys<T>={[K in keyof T]-?:object extends Pick<T,K>?K:never}[keyof T];
const allLeavesRequired:[OptionalKeys<typeof ports>]extends[never]?true:false=true;void allLeavesRequired;
const app=createMacosVmLifecycleApplication(ports);
const synchronousCreate:MacosVmLifecycleOutcome|undefined=app.create({backend:"other"});
const synchronousImage:MacosVmLifecycleOutcome|undefined=app.createImage({backend:"other"});
function positiveAsyncContract(){
    const asynchronousStart:Promise<MacosVmLifecycleOutcome|undefined>=app.start({deviceId:"missing"});
    const recorderSettlement:Promise<{ok:true}|{ok:false;reason:string}>=app.stopRecording(device);
    const recordingExit:Promise<boolean>=ports.waitRecordingExit({runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"a".repeat(64)}},1000);
    const evidence:MacosNativeCloneFailureEvidence=app.cloneFailureEvidence(observation,null,"owned-target");
    const failed:MacosVmLifecycleOutcome=app.cloneFailure(evidence.command,evidence.cleanup,evidence.target);
    void asynchronousStart;void recorderSettlement;void recordingExit;void failed;
}
void synchronousCreate;void synchronousImage;void positiveAsyncContract;
function relativeStartBudgetContracts() {
    const budget: MacosVmStartBudget = { remainingMs: () => 123.75 };
    const remaining: number = budget.remainingMs();
    const wall: number = ports.now(), elapsed: number = ports.monotonicNow();
    const launched = ports.launchProvider(nativePlan, device, budget);
    if (launched) {
        const providerChild: typeof child = launched.child;
        const settled: Promise<MacosVmLifecycleOutcome | null> = ports.waitProviderStart(providerChild, budget);
        void settled;
    }
    const boot = ports.waitBoot(nativePlan, Number.NaN, budget);
    const helper = ports.waitGuestHelper(device, budget);
    const provision = ports.provisionHelper(device, budget);
    const { monotonicNow, ...withoutElapsed } = ports;
    // @ts-expect-error Elapsed start accounting requires its own clock beside wall now.
    createMacosVmLifecycleApplication(withoutElapsed);
    // @ts-expect-error Clock readings settle synchronously before native effects.
    const deferredClock: typeof ports = { ...ports, monotonicNow: async () => 1 };
    // @ts-expect-error Relative allowances are finite numeric durations, not serialized text.
    const textBudget: MacosVmStartBudget = { remainingMs: () => "123" };
    // @ts-expect-error A relative allowance cannot defer its admission decision.
    const deferredBudget: MacosVmStartBudget = { remainingMs: async () => 123 };
    // @ts-expect-error Native lifecycle boot no longer receives an absolute Unix deadline.
    ports.waitBoot(nativePlan, 1000, Date.now() + 1000);
    // @ts-expect-error Feature preparation and spawn require the shared relative allowance.
    ports.launchProvider(nativePlan, device);
    // @ts-expect-error Settling cannot renew a standalone timer after provider launch.
    ports.waitProviderStart(child);
    // @ts-expect-error A launch refused by the budget has no native child authority.
    const uncheckedChild = launched.child;
    // @ts-expect-error Native lifecycle helper receives the captured relative carrier.
    ports.waitGuestHelper(device, Date.now() + 1000);
    // @ts-expect-error Even one-shot provisioning must receive the captured allowance.
    ports.provisionHelper(device);
    // @ts-expect-error Provisioning cannot replace the relative carrier with a Unix deadline.
    ports.provisionHelper(device, Date.now() + 1000);
    void [remaining, wall, elapsed, boot, helper, provision, monotonicNow, deferredClock, textBudget, deferredBudget, uncheckedChild];
}
void relativeStartBudgetContracts;
function negativeContracts(){
    const {deviceId,...withoutCreationEntropy}=ports;void deviceId;
    // @ts-expect-error creation entropy is a required native leaf
    createMacosVmLifecycleApplication(withoutCreationEntropy);
    // @ts-expect-error admitted creation identity is synchronous
    const deferredIdentity:typeof ports={...ports,deviceId:async()=>"macos-id"};
    void deferredIdentity;
    const {parseLifecycleClaimedAt,...missingParse}=ports;void parseLifecycleClaimedAt;
    // @ts-expect-error original claimed-at parsing requires its explicit native leaf
    createMacosVmLifecycleApplication(missingParse);
    // @ts-expect-error claimed-at parsing returns its native number synchronously
    const asyncParse:typeof ports={...ports,parseLifecycleClaimedAt:async()=>1};
    // @ts-expect-error claimed-at parsing cannot replace the native number with text
    const textParse:typeof ports={...ports,parseLifecycleClaimedAt:()=>"1"};
    void asyncParse;void textParse;
    const {launchProvider,...missingSpawn}=ports;void launchProvider;
    // @ts-expect-error launch is required even for applications used only to create
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
    // @ts-expect-error native clone observations settle immediately
    const asyncCommand:typeof ports={...ports,cloneInstance:async()=>observation};
    // @ts-expect-error opaque diagnostic receipt stdout remains a string
    const malformedCommand:typeof ports={...ports,cloneInstance:()=>({ok:true,timedOut:false,detail:"",evidence:{status:0,stdout:1,stderr:""}})};
    // @ts-expect-error launch returns the actual native handle immediately
    const asyncSpawn:typeof ports={...ports,launchProvider:async()=>({child,startCommand:null})};
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
    // @ts-expect-error same-claim recorder settlement requires the captured device, not a process ID
    app.stopRecording(17);
    // @ts-expect-error settlement reports a finite observation, never a bare success boolean
    const booleanSettlement:Promise<boolean>=app.stopRecording(device);
    // @ts-expect-error the current lifecycle caller must await recorder settlement
    const synchronousSettlement:{ok:true}|{ok:false;reason:string}=app.stopRecording(device);
    // @ts-expect-error a PID-only native adapter cannot implement generation-aware exit observation
    const pidOnlyExit:typeof ports={...ports,waitRecordingExit:async(_pid:number)=>true};
    // @ts-expect-error mutable device identity is still a string
    const malformedDevice:MacosVmDevice={id:3};
    // @ts-expect-error start is asynchronous, even on an early refusal
    const synchronousStart:MacosVmLifecycleOutcome|undefined=app.start({deviceId:"missing"});
    // @ts-expect-error create stays synchronous
    const promisedCreate:Promise<MacosVmLifecycleOutcome|undefined>=app.create({backend:"other"});
    void asyncRead;void asyncFind;void asyncClaim;void asyncTransition;void malformedTransition;void asyncKey;
    void asyncCommand;void malformedCommand;void asyncSpawn;void missingUnref;void syncWait;void syncBoot;void pidOnlyExit;void booleanSettlement;void synchronousSettlement;
    void syncHelper;void asyncProvision;void weakSignal;void syncExit;void malformedDevice;void synchronousStart;void promisedCreate;
}
void negativeContracts;
function imageContracts(imagePorts:MacosImageSnapshotsPorts,lifecycle:MacosVmNativeLifecycle,outward:MacosVmLifecycle<Result>){
    const imageApp=createMacosImageSnapshots(imagePorts,lifecycle);
    const imageLeavesRequired:[OptionalKeys<MacosImageSnapshotsPorts>]extends[never]?true:false=true;
    const cloned:Promise<MacosVmLifecycleOutcome|undefined>=imageApp.clone({sourceDeviceId:"unit",name:"Copy"});
    const snapshot:Promise<MacosVmLifecycleOutcome|undefined>=imageApp.createSnapshot({deviceId:"unit",snapshotName:"Before"});
    const restored:Promise<MacosVmLifecycleOutcome|undefined>=imageApp.restoreSnapshot({deviceId:"unit",snapshotName:"Before"});
    const deleted:Promise<MacosVmLifecycleOutcome|undefined>=imageApp.deleteSnapshot({deviceId:"unit",snapshotName:"Before"});
    const restoreFailure:MacosVmLifecycleOutcome={kind:"restore-failed",candidate:"owned-candidate",error:"exit 9",cloneEvidence:null};
    const {claim,...missingClaim}=imagePorts;void claim;
    // @ts-expect-error destination publication remains required
    createMacosImageSnapshots(missingClaim,lifecycle);
    const {transition,...missingTransition}=imagePorts;void transition;
    // @ts-expect-error source reservation and publication require complete-record CAS
    createMacosImageSnapshots(missingTransition,lifecycle);
    const {stopInstance,...missingStop}=imagePorts;void stopInstance;
    // @ts-expect-error forced image mutations require the immediate native stop observation
    createMacosImageSnapshots(missingStop,lifecycle);
    const {deleteInstance,...missingDelete}=imagePorts;void deleteInstance;
    // @ts-expect-error image compensation and snapshot cleanup require their native delete leaf
    createMacosImageSnapshots(missingDelete,lifecycle);
    const {imageDiagnostic,...missingDiagnostic}=imagePorts;void imageDiagnostic;
    // @ts-expect-error persisted image diagnostics require the finite outward fallback policy
    createMacosImageSnapshots(missingDiagnostic,lifecycle);
    // @ts-expect-error lifecycle policy must be composed explicitly
    createMacosImageSnapshots(imagePorts);
    // @ts-expect-error a public wire-result lifecycle cannot replace the actual native policy peer
    createMacosImageSnapshots(imagePorts,outward);
    // @ts-expect-error native image stop observations remain synchronous
    const deferredStop:typeof imagePorts={...imagePorts,stopInstance:async()=>observation};
    // @ts-expect-error raw command receipts cannot replace semantic image observations
    const rawDelete:typeof imagePorts={...imagePorts,deleteInstance:()=>({status:0,stdout:"",stderr:""})};
    // @ts-expect-error provider admission takes finite native plan facts, not raw command plans
    const rawPlan:typeof imagePorts={...imagePorts,providerPlan:()=>plan};
    // @ts-expect-error raw provider-command execution is not an inward image port
    const rawCommand:typeof imagePorts={...imagePorts,providerCommand:()=>({status:0,stdout:"",stderr:""})};
    // @ts-expect-error wire-result presentation does not belong to the image application ports
    const publisher:typeof imagePorts={...imagePorts,textResult:()=>({ok:true,value:null})};
    // @ts-expect-error fallback diagnostics settle immediately before recovery publication
    const deferredDiagnostic:typeof imagePorts={...imagePorts,imageDiagnostic:async()=>"exit 9"};
    // @ts-expect-error diagnostic kinds cannot admit an unbounded arbitrary string
    imagePorts.imageDiagnostic(observation,"native-error-message");
    // @ts-expect-error source lookup remains synchronous
    const deferredFind:typeof imagePorts={...imagePorts,find:async()=>device};
    // @ts-expect-error candidate publication reports its CAS outcome immediately
    const deferredTransition:typeof imagePorts={...imagePorts,transition:async()=>({matched:true,found:true,device})};
    // @ts-expect-error recorder signaling belongs to the existing lifecycle policy peer
    const duplicateRecordingSignal:typeof imagePorts={...imagePorts,signalRecording:()=>({signaled:true})};
    // @ts-expect-error generation-aware exit settlement belongs to the lifecycle policy peer
    const duplicateRecordingWait:typeof imagePorts={...imagePorts,waitRecordingExit:async()=>true};
    // @ts-expect-error restored failure always identifies the retained candidate
    const unidentifiedRecovery:MacosVmLifecycleOutcome={kind:"restore-failed",error:"exit 9",cloneEvidence:null};
    // @ts-expect-error clone cleanup evidence retains its semantic observation, not an unclassified raw receipt
    const rawRecovery:MacosVmLifecycleOutcome={kind:"restore-failed",candidate:"owned-candidate",error:"exit 9",cloneEvidence:{target:"primary",command:{status:9,stdout:"",stderr:""},cleanup:null}};
    void [imageLeavesRequired,cloned,snapshot,restored,deleted,restoreFailure,deferredStop,rawDelete,rawPlan,rawCommand,publisher,
        deferredDiagnostic,deferredFind,deferredTransition,duplicateRecordingSignal,duplicateRecordingWait,unidentifiedRecovery,rawRecovery];
}
void imageContracts;
describe("macOS strict required native contracts",()=>{
    it("retains mutable raw records and pure factory construction",()=>{
        device.extra={changed:true};expect(device.extra).toEqual({changed:true});
        expect(synchronousCreate).toBeUndefined();expect(synchronousImage).toBeUndefined();
    });
});

