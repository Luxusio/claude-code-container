import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { coreBoundaryViolations } from "./core-boundary.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Genuine976-file build64588b output, authenticated before candidate use.
// This historical declaration is an oracle; current output must be genuinely built.
const ORIGINAL_DECLARATION = "import type { CommandResult, DeviceRecord } from \"./device-lab-cleanup.js\";\nexport { DEVICE_BACKENDS, deviceLabOwnerIdentity, deviceLabOwnerId, cleanupOwnerDevices } from \"./device-lab-cleanup.js\";\nimport { deviceBrokerCliAsync, ensureHyperVHostNetworkForSetup, invokeHostDeviceBrokerOwnerRpc } from \"./packages/device-lab/dist/device-lab-broker.js\";\ntype SmokeResult = {\n    backend: string;\n    status: \"PASS\" | \"SKIP\" | \"FAIL\";\n    detail: string;\n    commands?: CommandResult[];\n};\ntype SmokeMode = \"prerequisite\" | \"real-provider\";\ntype SmokeOptions = {\n    mode?: SmokeMode;\n};\ntype SmokeFormatOptions = SmokeOptions & {\n    mcpSurface?: boolean;\n    mcpServerPath?: string;\n    mcpSmokeScriptPath?: string;\n};\ntype DevicesCliAsyncHooks = Parameters<typeof deviceBrokerCliAsync>[3] & {\n    invokeOwnerRpc?: typeof invokeHostDeviceBrokerOwnerRpc;\n    setupHyperV?: typeof setupHyperVHost;\n};\ntype HyperVSetupHostOptions = {\n    platform?: NodeJS.Platform;\n    powershell?: string | null;\n    systemRoot?: string;\n    stateRoot?: string;\n    networkStateRoot?: string;\n    mutationLockFile?: string;\n    commandRunner?: (command: string, args: string[], timeoutMs: number, input?: string) => CommandResult | null;\n    acceptWindowsEvaluationLicense?: boolean;\n    ensureHostNetwork?: typeof ensureHyperVHostNetworkForSetup;\n    ownerId?: string;\n};\nexport type HyperVSetupHostResult = {\n    ok: boolean;\n    text: string;\n};\nexport declare function spawnableWindowsExecutablePath(path: string): string | null;\ntype AdminBackendSnapshot = {\n    stateKey: string;\n    name: string;\n    devices: DeviceRecord[];\n};\ntype AdminOwnerSnapshot = {\n    ownerId: string;\n    backends: AdminBackendSnapshot[];\n};\ntype BenchDeviceStatus = \"healthy\" | \"lease-ok\" | \"missing-hardware-id\" | \"missing-lease\" | \"expired-lease\" | \"foreign-lease\" | \"device-mismatch\" | \"inventory-missing\";\ntype BenchDeviceCheck = {\n    deviceId: string;\n    name: string;\n    status: BenchDeviceStatus;\n    detail: string;\n    hardwareId: string | null;\n    inventoryState: \"present\" | \"missing\" | \"unknown\";\n    expiresAt?: string;\n};\ntype BenchBackendHealth = {\n    backend: \"android-device\" | \"ios-device\";\n    status: \"PASS\" | \"SKIP\" | \"FAIL\";\n    detail: string;\n    command: {\n        command: string;\n        status: number | null;\n    } | null;\n    devices: BenchDeviceCheck[];\n};\nexport type DeviceLabBenchHealth = {\n    ownerId: string;\n    backends: BenchBackendHealth[];\n};\nexport { DeviceLabProjectEnumerationError } from \"./packages/device-lab/dist/device-lab-project-state.js\";\nexport declare function setupHyperVHost(confirm: boolean, options?: HyperVSetupHostOptions): Promise<HyperVSetupHostResult>;\nexport declare function deviceLabSmoke(cwd?: string, timeoutMs?: number, profile?: string, options?: SmokeOptions): {\n    ownerId: string;\n    mode: SmokeMode;\n    results: SmokeResult[];\n};\nexport declare function deviceLabBenchHealth(cwd?: string, profile?: string, timeoutMs?: number): DeviceLabBenchHealth;\nexport declare function deviceLabSnapshot(cwd?: string, profile?: string): {\n    ownerId: string;\n    backends: ({\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"android\";\n        name: \"android-emulator\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"android-device\";\n        name: \"android-device\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"ios\";\n        name: \"ios-simulator\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"ios-device\";\n        name: \"ios-device\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"windows\";\n        name: \"windows-sandbox\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"windows-vm\";\n        name: \"windows-vm\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"macos\";\n        name: \"macos-vm\";\n    } | {\n        devices: DeviceRecord[];\n        tools: Record<string, string | null>;\n        missing: string[];\n        available: boolean;\n        stateKey: \"linux-vm\";\n        name: \"linux-vm\";\n    })[];\n};\nexport declare function deviceLabAllOwnersSnapshot(): {\n    owners: AdminOwnerSnapshot[];\n};\nexport declare function stopOwnerDevice(deviceId: string, cwd?: string, profile?: string): {\n    ok: boolean;\n    text: string;\n};\nexport declare function deleteOwnerDevice(deviceId: string, cwd?: string, profile?: string): {\n    ok: boolean;\n    text: string;\n};\nexport declare function pruneOwnerDevices(cwd?: string, profile?: string): {\n    ok: boolean;\n    text: string;\n};\nexport declare function stopAllProjectDevices(timeoutMs?: number): {\n    ok: boolean;\n    text: string;\n};\nexport declare function pruneAllProjectDevices(): {\n    ok: boolean;\n    text: string;\n};\nexport declare function formatDevicesStatus(cwd?: string, profile?: string): string;\nexport declare function formatDevicesList(cwd?: string, profile?: string): string;\nexport declare function formatDevicesAllProjectsList(): string;\nexport declare function formatDevicesBackends(cwd?: string, profile?: string): string;\nexport declare function formatDevicesDoctor(cwd?: string, profile?: string): string;\nexport declare function formatDevicesSmoke(cwd?: string, timeoutMs?: number, profile?: string, options?: SmokeFormatOptions): string;\nexport declare function devicesCli(args: string[], cwd?: string, profile?: string): number;\nexport declare function devicesCliAsync(args: string[], cwd?: string, profile?: string, hooks?: DevicesCliAsyncHooks): Promise<number>;\n";
const ORIGINAL_DECLARATION_SHA = "074fa58f04f0d1bde411624b5147e2304715e74b95222c3e4ba035ef9b8850b0";
const exportedFunctions = (text: string) => ts.createSourceFile("surface.ts", text, ts.ScriptTarget.Latest, true)
    .statements.filter(ts.isFunctionDeclaration).filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .map(node => node.name!.text).sort();
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
describe("Admin inventory source/emission contracts and frozen public namespace", () => {
    it.each([false, true])("consumes real source/genuine emitted=%s with strict:true and skipLibCheck:false", contracts);
    it("keeps the original public facade function namespace", () => {
        expect(createHash("sha256").update(ORIGINAL_DECLARATION).digest("hex")).toBe(ORIGINAL_DECLARATION_SHA);
        expect(exportedFunctions(readFileSync(join(root, "src/device-lab-admin.ts"), "utf8"))).toEqual(exportedFunctions(ORIGINAL_DECLARATION));
    });
    it("keeps native authority outside the inward application, domain and ports", () => {
        for (const name of ["application", "domain", "ports"]) {
            const file = join(root, "src", name, "device-admin-inventory.ts");
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root: join(root, "src"), language: "ts" })).toEqual([]);
        }
    });
});

