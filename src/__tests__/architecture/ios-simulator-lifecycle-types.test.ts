import {describe,expect,it} from "vitest";
import {chmodSync,existsSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";import {tmpdir} from "node:os";import {fileURLToPath} from "node:url";import ts from "typescript";
import {coreBoundaryViolations} from "./core-boundary.js";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../.."),provider="packages/device-lab/providers/";
// Historical direct MJS facade has no adjacent declaration in genuine987 manifest.
// Consume the new actual explicit sidecars in BOTH source and genuine emitted tiers.
const CONTRACT=`
import {createIosSimulatorLifecycle} from @APPLICATION@;
import type {IosSimulatorLifecyclePorts,IosSimulatorDevice,IosSimulatorLifecycleInput,IosSimulatorLifecycleClaim,IosSimulatorRecording,IosSimulatorAppium,IosSimulatorCommandResult} from @PORTS@;
type Reply={native:"raw"};type Ports=IosSimulatorLifecyclePorts<Reply>;
declare const ports:Ports;declare const input:IosSimulatorLifecycleInput;
type OptionalKeys<T>={[K in keyof T]-?:{} extends Pick<T,K>?K:never}[keyof T];
const allNativeLeavesRequired:OptionalKeys<Ports> extends never?true:false=true;
const app=createIosSimulatorLifecycle(ports);
const promises:Promise<Reply|undefined>[]=[app.create(input),app.start(input),app.stop(input),app.delete(input)];
const device:IosSimulatorDevice={id:"d",udid:null,recording:{pid:41,processIdentity:{opaque:true},raw:"kept"},appium:{serverPid:42},lifecycle:{runtimeId:"r",operation:"start",claimedAt:"t"},raw:{kept:true}};
const nativeResult:IosSimulatorCommandResult=ports.run("xcrun",["simctl","boot",device.udid??undefined]);
const wait:Promise<boolean>=ports.waitForProcessExit(41,3000);
const session:Promise<void>=ports.deleteAppiumSession(device.appium);
const appium:IosSimulatorAppium={serverPid:42,processIdentity:{opaque:true}};
const settlement:Promise<{exited:boolean}>=ports.terminateOwnedAppiumProcess(appium,"iOS Simulator Appium");
// @ts-expect-error every native leaf is required, not a workflow callback
createIosSimulatorLifecycle({});
const {runtimeId,...missingGeneration}=ports;
// @ts-expect-error lifecycle generation authority is required
createIosSimulatorLifecycle(missingGeneration);
// @ts-expect-error record observation is synchronous
createIosSimulatorLifecycle({...ports,readIosDevices:async()=>[]});
// @ts-expect-error discovery is synchronous
createIosSimulatorLifecycle({...ports,iosDiscovery:async()=>({xcrun:null,available:false,missing:[]})});
// @ts-expect-error commands preserve strict synchronous raw result
createIosSimulatorLifecycle({...ports,run:async()=>({status:0,stdout:"",stderr:""})});
// @ts-expect-error CAS reports found and matched separately
createIosSimulatorLifecycle({...ports,transitionIosDevice:()=>({matched:true})});
// @ts-expect-error publication is synchronous
createIosSimulatorLifecycle({...ports,transitionIosDevice:async()=>({matched:true,found:true})});
// @ts-expect-error timestamp is synchronous
createIosSimulatorLifecycle({...ports,wallTimestamp:async()=>"t"});
// @ts-expect-error recorder exit settlement is asynchronous
createIosSimulatorLifecycle({...ports,waitForProcessExit:()=>true});
// @ts-expect-error session cleanup is asynchronous
createIosSimulatorLifecycle({...ports,deleteAppiumSession:()=>undefined});
// @ts-expect-error native process settlement has boolean exited
createIosSimulatorLifecycle({...ports,terminateOwnedAppiumProcess:async()=>({exited:1})});
// @ts-expect-error staged-output cleanup is synchronous
createIosSimulatorLifecycle({...ports,discardLocalOutputStage:async()=>({ok:true})});
// @ts-expect-error a PID-only signaling result cannot erase signaled status
createIosSimulatorLifecycle({...ports,signalOwnedRuntimeProcess:()=>({pid:41})});
// @ts-expect-error recorder PID remains numeric
const badRecording:IosSimulatorRecording={pid:"41"};
// @ts-expect-error generation claim remains a string tuple
const badClaim:IosSimulatorLifecycleClaim={runtimeId:9,operation:"start",claimedAt:"t"};
// @ts-expect-error public operation is always asynchronous
const badOperation:(input:IosSimulatorLifecycleInput)=>Reply=app.start;
// @ts-expect-error command deadline remains numeric
ports.runWithTimeout("xcrun",["simctl"],"3000");
// @ts-expect-error provisioning flag remains boolean
app.create({createSimulator:"yes"});
void [allNativeLeavesRequired,promises,device,nativeResult,wait,session,settlement];
`;
function compileContracts(emitted:boolean){
    const base=join(root,emitted?"dist/"+provider:provider);
    for(const relative of ["application/lifecycle/ios-simulator-lifecycle.mjs","application/lifecycle/ios-simulator-lifecycle.d.mts","ports/lifecycle/ios-simulator-lifecycle.mjs","ports/lifecycle/ios-simulator-lifecycle.d.mts"]){
        const file=join(base,relative);expect(existsSync(file),"actual required artifact "+file).toBe(true);const st=lstatSync(file);expect(st.isFile()&&!st.isSymbolicLink()).toBe(true);expect(realpathSync(file)).toBe(file);
    }
    const home=mkdtempSync(join(tmpdir(),"ccc-ios-lifecycle-types-"));chmodSync(home,0o700);const birth=lstatSync(home),real=realpathSync(home);let passed=false;
    try{
        const file=join(home,"consumer.mts");writeFileSync(file,CONTRACT.replace("@APPLICATION@",JSON.stringify(join(base,"application/lifecycle/ios-simulator-lifecycle.mjs"))).replace("@PORTS@",JSON.stringify(join(base,"ports/lifecycle/ios-simulator-lifecycle.mjs"))),{flag:"wx",mode:0o600});
        const program=ts.createProgram([file],{strict:true,noEmit:true,skipLibCheck:false,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,typeRoots:[join(root,"node_modules/@types")]});
        const errors=ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"));expect(errors).toEqual([]);passed=true;
    }finally{
        if(passed){const now=lstatSync(home);expect([now.dev,now.ino,now.uid,now.isDirectory(),now.isSymbolicLink(),realpathSync(home)]).toEqual([birth.dev,birth.ino,birth.uid,true,false,real]);rmSync(home,{recursive:true});}
        // Failed owned controls remain for diagnosis; no fallback or broad cleanup.
    }
}
describe("iOS lifecycle actual strict source/emission and pure inward graph",()=>{
    it("requires eighteen meaningful negative native/public declaration controls",()=>expect((CONTRACT.match(/@ts-expect-error/g)||[]).length).toBe(18));
    it("keeps application/domain/ports inside the actual pure provider graph",()=>{
        for(const layer of ["application","domain","ports"]){const file=join(root,provider,layer,"lifecycle/ios-simulator-lifecycle.mjs");expect(coreBoundaryViolations(readFileSync(file,"utf8"),file,{root:join(root,provider),language:"mjs"})).toEqual([]);}
    });
    it.each([false,true])("compiles strict actual source/emitted sidecar consumers emitted=%s",emitted=>compileContracts(emitted));
});
