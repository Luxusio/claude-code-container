// Checked by the normal strict architecture compiler; never invoked.
import {deviceLabSnapshot,deviceLabAllOwnersSnapshot,formatDevicesStatus,formatDevicesList,formatDevicesAllProjectsList,devicesCli,devicesCliAsync,DeviceLabProjectEnumerationError,cleanupOwnerDevices,DEVICE_BACKENDS} from "../../device-lab-admin.js";
import {cleanupOwnerDevices as nativeCleanup,DEVICE_BACKENDS as nativeBackends} from "../../device-lab-cleanup.js";
import {createDeviceAdminInventory} from "../../application/device-admin-inventory.js";
import {classifyDeviceAdminTools,deviceAdminLabel,admitDeviceAdminInventoryCommand} from "../../domain/device-admin-inventory.js";
import type {DeviceAdminInventoryCommand} from "../../domain/device-admin-inventory.js";
import type {DeviceAdminInventoryPorts,DeviceAdminBackend,DeviceAdminRecord} from "../../ports/device-admin-inventory.js";

function contracts(ports: DeviceAdminInventoryPorts) {

    const app=createDeviceAdminInventory(ports);
    const snapshot=app.snapshot("cwd","work");const owners=app.allOwnersSnapshot();
    const text:string=app.formatStatus("cwd"),list:string=app.formatList("cwd"),all:string=app.formatAllProjectsList();
    const command:{ok:boolean;text:string}|null=app.command(["list"],"cwd",undefined,"list");
    const phase:DeviceAdminInventoryCommand=admitDeviceAdminInventoryCommand(["list"],"list");
    const value:DeviceAdminRecord={id:"raw",status:"running",name:"raw",opaque:true};
    const backend:DeviceAdminBackend={stateKey:"raw",name:"macos-vm",tools:["one","two"]};
    const rawTools:Record<string,string|null>={one:null,two:"path"};
    const sameTools:Record<string,string|null>=classifyDeviceAdminTools(backend,rawTools).tools;
    const label:string=deviceAdminLabel(value);
    const publicSnapshot=deviceLabSnapshot();const publicAll=deviceLabAllOwnersSnapshot();
    const publicTexts:string[]=[formatDevicesStatus(),formatDevicesList(),formatDevicesAllProjectsList()];
    const direct:number=devicesCli(["list"]);const asyncResult:Promise<number>=devicesCliAsync(["list"]);
    const nativeSame:typeof nativeCleanup=cleanupOwnerDevices;const backendsSame:typeof nativeBackends=DEVICE_BACKENDS;
    const nativeCode:"project-namespace-read-failed"=new DeviceLabProjectEnumerationError(value).code;
    for(const backend of publicSnapshot.backends)if(backend.stateKey==="android"){const name:"android-emulator"=backend.name;const tool:string|null=backend.tools.adb;void[name,tool];}
    // @ts-expect-error Required native leaves cannot be omitted.
    createDeviceAdminInventory({});
    // @ts-expect-error Owner resolution is synchronous.
    createDeviceAdminInventory({...ports,resolveOwnerId:async()=> "owner"});
    // @ts-expect-error Project enumeration is synchronous.
    createDeviceAdminInventory({...ports,enumerateOwnerIds:async()=>[]});
    // @ts-expect-error Canonical device records are read synchronously.
    createDeviceAdminInventory({...ports,readDevices:async()=>[]});
    // @ts-expect-error Individual executable observation is synchronous.
    createDeviceAdminInventory({...ports,commandPath:async()=>null});
    // @ts-expect-error Arbitrary boolean availability cannot replace a native executable observation.
    createDeviceAdminInventory({...ports,commandPath:()=>true});
    // @ts-expect-error An opaque whole-backend inventory callback is not a semantic port.
    ports.backendToolSnapshot;
    // @ts-expect-error Native owner selection needs an explicit application cwd.
    app.snapshot();
    // @ts-expect-error Owner identity remains textual.
    const invalidRecord:DeviceAdminRecord={id:123};
    // @ts-expect-error Native tool observations retain nullable textual paths.
    const invalidTools:Record<string,string|null>={one:false};
    // @ts-expect-error Only the admitted exact inventory decisions are accepted.
    app.command(["list"],"cwd",undefined,"all");
    // @ts-expect-error The public async caller does not become synchronous.
    const wrongAsync:number=devicesCliAsync(["list"]);

    void [snapshot, owners, text, list, all, command, phase, sameTools, label, publicAll, publicTexts, direct, asyncResult, nativeSame, backendsSame, nativeCode, invalidRecord, invalidTools, wrongAsync, app, value, backend, rawTools, publicSnapshot];
}
void contracts;
