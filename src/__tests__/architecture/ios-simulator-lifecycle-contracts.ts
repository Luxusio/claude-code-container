// Checked by the normal strict architecture compiler; never invoked.
type Reply={native:"raw"};type Ports=IosSimulatorLifecyclePorts<Reply>;

import {createIosSimulatorLifecycle} from "../../../packages/device-lab/providers/application/lifecycle/ios-simulator-lifecycle.mjs";
import type {IosSimulatorLifecyclePorts,IosSimulatorDevice,IosSimulatorLifecycleInput,IosSimulatorLifecycleClaim,IosSimulatorRecording,IosSimulatorAppium,IosSimulatorCommandResult} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";

function contracts(ports: Ports, input: IosSimulatorLifecycleInput) {

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
    void runtimeId;
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

    void [promises, device, nativeResult, wait, session, settlement, app, appium, badRecording, badClaim, badOperation];
}
void contracts;
