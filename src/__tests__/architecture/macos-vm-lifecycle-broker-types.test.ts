import { describe, expect, it } from "vitest";
import { createBrokerMacosVmLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosLifecycleInput, BrokerMacosLifecycleRequest, BrokerMacosLifecycleResponse, BrokerMacosBoot, BrokerMacosPublicationChange } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/macos-vm-lifecycle.js";

// Proposed mechanical names from the independent read-only contract drafter.
// Source and genuine-emission consumers must both be checked with
// skipLibCheck=false. Runtime tests do not validate these negative directives.
const record:Record<string,unknown>={id:"unit",provider:"tart",providerInstance:"owned",status:"stopped",absent:undefined,structured:new Map([["kept",new Set([1,2])]])};
const parsed:BrokerMacosLifecycleRequest={ok:true,backend:"macos-vm",stateKey:"macos",command:"device_start",deviceId:"unit",force:false,dryRun:false};
const command={mode:"detached" as const,provider:"tart",executable:"/native/tart",args:["run","owned"]};
const ports:BrokerMacosVmLifecyclePorts={
    execute:value=>({...value,status:0,stdout:"raw out",stderr:"raw err"}),executable:()=>"/native/tart",
    timestamp:()=>"now",now:()=>1,sleep:()=>undefined,
    claimDefinition:(_owner,_parsed,device)=>({ok:true,device}),
    cleanupAuxiliary:(_owner,_parsed,expected)=>({result:{ok:true,changed:false,appium:{cleared:false},recording:{cleared:false},minimizeWatchdog:{cleared:false}},device:expected,committed:false}),
    publish:()=>({found:false,matched:false,device:null}),redactDevice:value=>value,stateErrorCode:()=>null,
    stateFailure:()=>({status:503,payload:{ok:false,error:"raw-state-failure"}}),failureDetail:()=>"raw failure",
    commandTimeoutMs:2300,outputLimit:32*1024,
};
type OptionalKeys<T>={[K in keyof T]-?:object extends Pick<T,K>?K:never}[keyof T];
const allLeavesRequired:[OptionalKeys<BrokerMacosVmLifecyclePorts>]extends[never]?true:false=true;void allLeavesRequired;
const input:BrokerMacosLifecycleInput={ownerId:"0123456789abcdef",parsed,plan:{device:record,providerCommand:command},expectedDevice:record};
const boot:BrokerMacosBoot={ok:true,ready:false,skipped:true};
const change:BrokerMacosPublicationChange={kind:"start",boot};void change;
function positiveConsumers(){
    const app=createBrokerMacosVmLifecycle(ports);
    const create:Promise<BrokerMacosLifecycleResponse>=app.create(input),start:Promise<BrokerMacosLifecycleResponse>=app.start(input);
    const stop:Promise<BrokerMacosLifecycleResponse>=app.stop(input),remove:Promise<BrokerMacosLifecycleResponse>=app.delete(input);
    const definition:unknown=app.createRecord(input.ownerId,parsed);void definition;
    app.planCreate(input.ownerId,parsed);app.planExisting(input.ownerId,parsed,record);
    void create;void start;void stop;void remove;
}
void positiveConsumers;
function negativeConsumers(){
    const {sleep,...missingSleep}=ports;void sleep;
    // @ts-expect-error bounded synchronous pacing is required, even for create-only callers
    createBrokerMacosVmLifecycle(missingSleep);
    const {publish,...missingPublish}=ports;void publish;
    // @ts-expect-error native complete-record CAS publication is required
    createBrokerMacosVmLifecycle(missingPublish);
    const {cleanupAuxiliary,...missingCleanup}=ports;void cleanupAuxiliary;
    // @ts-expect-error supporting canonical cleanup authority cannot default to success
    createBrokerMacosVmLifecycle(missingCleanup);
    // @ts-expect-error execution returns its raw observation synchronously
    const asyncExecute:typeof ports={...ports,execute:async value=>({...value,status:0})};
    // @ts-expect-error native executable observation is synchronous
    const asyncExecutable:typeof ports={...ports,executable:async()=>"/native/tart"};
    // @ts-expect-error the original clock is an immediate number
    const asyncClock:typeof ports={...ports,now:async()=>1};
    // @ts-expect-error timestamp cannot be an unawaited Promise
    const asyncTimestamp:typeof ports={...ports,timestamp:async()=>"now"};
    // @ts-expect-error undefined return rejects Promise-returning synchronous sleep
    const asyncSleep:typeof ports={...ports,sleep:async()=>undefined};
    // @ts-expect-error even a numeric sleep result changes the native contract
    const numericSleep:typeof ports={...ports,sleep:()=>1};
    // @ts-expect-error claim finishes synchronously before compensation selection
    const asyncClaim:typeof ports={...ports,claimDefinition:async()=>({ok:true,device:record})};
    // @ts-expect-error claims report an ok discriminator and the raw device
    const weakClaim:typeof ports={...ports,claimDefinition:()=>({device:record})};
    // @ts-expect-error canonical cleanup completion is synchronous
    const asyncCleanup:typeof ports={...ports,cleanupAuxiliary:async()=>({result:{ok:true,changed:false,appium:{},recording:{},minimizeWatchdog:{}},device:record,committed:false})};
    // @ts-expect-error cleanup must identify whether the expected snapshot advanced
    const weakCleanup:typeof ports={...ports,cleanupAuxiliary:()=>({result:{ok:true,changed:false,appium:{},recording:{},minimizeWatchdog:{}},device:record})};
    // @ts-expect-error native conditional publication is synchronous
    const asyncPublication:typeof ports={...ports,publish:async()=>({found:true,matched:true,device:record})};
    // @ts-expect-error publication must report both found and matched
    const weakPublication:typeof ports={...ports,publish:()=>({device:record})};
    // @ts-expect-error publication takes fixed change data, never an opaque policy updater
    ports.publish(input.ownerId,"macos","unit",record,()=>record);
    // @ts-expect-error raw command status remains numeric/null
    const wrongStatus:typeof ports={...ports,execute:value=>({...value,status:"0"})};
    // @ts-expect-error raw stdout remains a string
    const wrongStdout:typeof ports={...ports,execute:value=>({...value,stdout:1})};
    // @ts-expect-error state error classification is synchronous
    const asyncStateError:typeof ports={...ports,stateErrorCode:async()=>null};
    // @ts-expect-error required command limits are numeric
    const weakLimits:typeof ports={...ports,commandTimeoutMs:"2300"};
    // @ts-expect-error failed boot carries the actual native error observation
    const weakBoot:BrokerMacosBoot={ok:false};
    // @ts-expect-error the publication change set is finite
    const weakChange:BrokerMacosPublicationChange={kind:"reboot",boot:null};
    // @ts-expect-error selected operations retain asynchronous exported completion
    const synchronousStart:BrokerMacosLifecycleResponse=createBrokerMacosVmLifecycle(ports).start(input);
    void asyncExecute;void asyncExecutable;void asyncClock;void asyncTimestamp;void asyncSleep;void numericSleep;
    void asyncClaim;void weakClaim;void asyncCleanup;void weakCleanup;void asyncPublication;void weakPublication;
    void wrongStatus;void wrongStdout;void asyncStateError;void weakLimits;void weakBoot;void weakChange;void synchronousStart;
}
void negativeConsumers;
describe("macOS broker strict proposed required native contracts",()=>{
    it("retains mutable non-JSON raw carriers and inert construction",()=>{
        record.absent=undefined;record.extra={changed:true};
        expect(Object.hasOwn(record,"absent")).toBe(true);expect(record.structured).toBeInstanceOf(Map);
        const touched:string[]=[];const unopened=new Proxy({},{get(_target,key){touched.push(String(key));throw Error("eager-native-observation");}}) as BrokerMacosVmLifecyclePorts;
        createBrokerMacosVmLifecycle(unopened);expect(touched).toEqual([]);
    });
});

