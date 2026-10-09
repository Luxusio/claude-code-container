import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { coreBoundaryViolations } from "./core-boundary.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const messages = (diagnostics: readonly ts.Diagnostic[]) => diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
// Only the authentic pre-extraction export names are frozen here. Historical
// legacy native inference was unchecked; it is not the current checkJs gate.
const originalExports = {
    android: ["androidRealBackend", "handleAndroidRealTool", "listAndroidRealDevices"],
    ios: ["handleIosRealTool", "iosRealBackend", "iosRealDiscovery", "listIosRealDevices"],
};
function checkContracts(emitted: boolean) {
    const providers = join(root, emitted ? "dist/packages/device-lab/providers" : "packages/device-lab/providers");
    const app = join(providers, "application/physical-stop.mjs"), ports = join(providers, "ports/physical-stop.mjs");
    expect(existsSync(app), `mandatory ${emitted ? "genuine build" : "source"} application`).toBe(true);
    expect(existsSync(ports), "mandatory concrete ports").toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "ccc-physical-stop-types-")), fixture = join(directory, "consumer.mts");
    let passed = false;
    try {
        writeFileSync(fixture, `
import {createPhysicalStopApplication} from ${JSON.stringify(app)};
import type {AndroidPhysicalStopPorts,IosPhysicalStopPorts,PhysicalTransition,PhysicalDevice,PhysicalStopResponse} from ${JSON.stringify(ports)};
declare const android:AndroidPhysicalStopPorts;
declare const ios:IosPhysicalStopPorts;
const androidApp=createPhysicalStopApplication(android),iosApp=createPhysicalStopApplication(ios);
const androidStop:Promise<PhysicalStopResponse|undefined>=androidApp.stop("target");
const iosStop:Promise<PhysicalStopResponse|undefined>=iosApp.stop("target");
const record:PhysicalDevice={id:"target",status:"running",recording:{active:true,pid:123},extra:"raw"};
androidApp.cleanup(record,null);iosApp.cleanup(record,undefined);
const nativeCas:PhysicalTransition={matched:true,found:true,currentDevice:record,device:record};
const androidPorts:AndroidPhysicalStopPorts={...android,discoverAdb:()=>null,stopAdbRecording:()=>({status:null,stdout:"",stderr:"raw"}),waitRecordingExit:async(pid,ms)=>{const nullablePid:number|null|undefined=pid;void [nullablePid,ms];return true}};
const iosPorts:IosPhysicalStopPorts={...ios,waitRecordingExit:async(recording,ms)=>{const active:boolean|undefined=recording.active;void [active,ms];return true},stopOwnedAppium:async()=>({exited:false,error:"raw"})};
// @ts-expect-error All semantic native effects are required.
createPhysicalStopApplication({backend:"android-device"});
const {transition:omitted,...withoutCas}=android;void omitted;
// @ts-expect-error A raw native CAS observation cannot be omitted.
createPhysicalStopApplication(withoutCas);
// @ts-expect-error Native find is synchronous.
const asyncFind:AndroidPhysicalStopPorts={...android,find:async()=>record};
// @ts-expect-error Raw CAS is synchronous.
const asyncCas:AndroidPhysicalStopPorts={...android,transition:async()=>nativeCas};
// @ts-expect-error Owned signal is synchronous.
const asyncSignal:AndroidPhysicalStopPorts={...android,signalRecording:async()=>({attempted:true,signaled:true})};
// @ts-expect-error ADB discovery is synchronous.
const asyncDiscovery:AndroidPhysicalStopPorts={...android,discoverAdb:async()=>"adb"};
// @ts-expect-error Default UTF-8 ADB command result is synchronous.
const asyncAdb:AndroidPhysicalStopPorts={...android,stopAdbRecording:async()=>({status:0,stdout:"",stderr:""})};
// @ts-expect-error Android bounded wait is asynchronous.
const syncAndroidWait:AndroidPhysicalStopPorts={...android,waitRecordingExit:()=>true};
// @ts-expect-error iOS bounded wait is asynchronous.
const syncIosWait:IosPhysicalStopPorts={...ios,waitRecordingExit:()=>true};
// @ts-expect-error Native owned-Appium cleanup is asynchronous.
const syncAppium:IosPhysicalStopPorts={...ios,stopOwnedAppium:()=>({exited:true})};
// @ts-expect-error Android wait observes a pid, not an iOS recording carrier.
const wrongAndroidWait:AndroidPhysicalStopPorts={...android,waitRecordingExit:ios.waitRecordingExit};
// @ts-expect-error iOS wait observes a complete recording carrier, not a pid.
const wrongIosWait:IosPhysicalStopPorts={...ios,waitRecordingExit:android.waitRecordingExit};
// @ts-expect-error Native signal result includes attempted and signaled.
const missingSignal:AndroidPhysicalStopPorts={...android,signalRecording:()=>({signaled:true})};
// @ts-expect-error CAS preserves BOTH raw-current and device carriers.
const missingCurrent:PhysicalTransition={found:true,matched:true,device:null};
// @ts-expect-error CAS matched is boolean.
const wrongMatched:PhysicalTransition={found:true,matched:"yes",currentDevice:null,device:null};
// @ts-expect-error Native command stdout is text.
const wrongStdout:AndroidPhysicalStopPorts={...android,stopAdbRecording:()=>({status:0,stdout:42,stderr:""})};
// @ts-expect-error Native command status is numeric or null.
const wrongStatus:AndroidPhysicalStopPorts={...android,stopAdbRecording:()=>({status:"0",stdout:"",stderr:""})};
// @ts-expect-error Owned-Appium exit observation is required.
const missingExited:IosPhysicalStopPorts={...ios,stopOwnedAppium:async()=>({error:"raw"})};
// @ts-expect-error Recording active remains a boolean.
const wrongRecord:PhysicalDevice={id:"target",recording:{active:"yes"}};
// @ts-expect-error New physical policy is internal, not an opaque cleanup native port.
android.stopVolatileProcesses;
// @ts-expect-error Existing physical stop cannot accept a new backend.
createPhysicalStopApplication({...android,backend:"broker"});
void [androidStop,iosStop,nativeCas,androidPorts,iosPorts,asyncFind,asyncCas,asyncSignal,asyncDiscovery,asyncAdb,syncAndroidWait,syncIosWait,syncAppium,wrongAndroidWait,wrongIosWait,missingSignal,missingCurrent,wrongMatched,wrongStdout,wrongStatus,missingExited,wrongRecord];
`, { flag: "wx", mode: 0o600 });
        const program = ts.createProgram([fixture, app, ports], { allowJs: true, checkJs: true, noEmit: true,
            strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            typeRoots: [join(root, "node_modules/@types")] });
        expect(messages(ts.getPreEmitDiagnostics(program)), directory).toEqual([]); passed = true;
    } finally { if (passed) rmSync(directory, { recursive: true, force: true }); }
}

describe("physical stop checked contracts and public namespace", () => {
    it.each([false, true])("checks actual source/genuine emitted=%s with strict checkJs and skipLibCheck:false", checkContracts);
    it("keeps both original public export namespaces", () => {
        for (const platform of ["android", "ios"] as const) {
            const file = join(root, "packages/device-lab/providers/backends", platform + "-device.mjs");
            const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const exported = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).map(node => node.name!.text).sort();
            expect(exported).toEqual(originalExports[platform]);
        }
    });
    it("keeps native authority outside the new checked application and ports", () => {
        const providers = join(root, "packages/device-lab/providers");
        for (const relative of ["application/physical-stop.mjs", "ports/physical-stop.mjs"]) {
            const file = join(providers, relative);
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root: providers, language: "mjs" })).toEqual([]);
        }
    });
});
