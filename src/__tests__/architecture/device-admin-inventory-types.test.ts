import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { coreBoundaryViolations } from "./core-boundary.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function contracts(emitted: boolean) {
    const base = join(root, emitted ? "dist" : "src");
    const required = ["device-lab-admin", "application/device-admin-inventory", "domain/device-admin-inventory", "ports/device-admin-inventory"];
    for (const name of required) expect(existsSync(join(base, name + (emitted ? ".d.ts" : ".ts"))), "mandatory current " + name).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "ccc-admin-inventory-types-"));
    const birth = lstatSync(directory), canonical = realpathSync(directory), file = join(directory, "consumer.mts");
    let passed = false;
    try {
        const module = (name: string) => JSON.stringify(join(base, name + ".js"));
        writeFileSync(file, `
import {deviceLabSnapshot,deviceLabAllOwnersSnapshot,formatDevicesStatus,formatDevicesList,formatDevicesAllProjectsList,devicesCli,devicesCliAsync,DeviceLabProjectEnumerationError,cleanupOwnerDevices,DEVICE_BACKENDS} from ${module("device-lab-admin")};
import {cleanupOwnerDevices as nativeCleanup,DEVICE_BACKENDS as nativeBackends} from ${module("device-lab-cleanup")};
import {createDeviceAdminInventory} from ${module("application/device-admin-inventory")};
import {classifyDeviceAdminTools,deviceAdminLabel,admitDeviceAdminInventoryCommand} from ${module("domain/device-admin-inventory")};
import type {DeviceAdminInventoryCommand} from ${module("domain/device-admin-inventory")};
import type {DeviceAdminInventoryPorts,DeviceAdminBackend,DeviceAdminRecord} from ${module("ports/device-admin-inventory")};
declare const ports:DeviceAdminInventoryPorts;
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
void[snapshot,owners,text,list,all,command,phase,sameTools,label,publicAll,publicTexts,direct,asyncResult,nativeSame,backendsSame,nativeCode,invalidRecord,invalidTools,wrongAsync];
`, { flag: "wx", mode: 0o600 });
        const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: false,
            target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            typeRoots: [join(root, "node_modules/@types")] });
        const errors = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        expect(errors, directory).toEqual([]); passed = true;
    } finally {
        if (passed) {
            const after = lstatSync(directory);
            expect([after.dev, after.ino, after.uid, realpathSync(directory)]).toEqual([birth.dev, birth.ino, birth.uid, canonical]);
            expect(after.isDirectory() && !after.isSymbolicLink()).toBe(true);
            rmSync(directory, { recursive: true, force: true });
        }
    }
}
describe("Admin inventory source/emission contracts and current public contracts", () => {
    it.each([false, true])("consumes real source/genuine emitted=%s with strict:true and skipLibCheck:false", contracts);
    it("keeps native authority outside the inward application, domain and ports", () => {
        for (const name of ["application", "domain", "ports"]) {
            const file = join(root, "src", name, "device-admin-inventory.ts");
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root: join(root, "src"), language: "ts" })).toEqual([]);
        }
    });
});

