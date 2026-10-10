import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import ts from "typescript";
import { coreBoundaryViolations } from "./core-boundary.js";
const root=path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
const DECLARATION_OPTIONS=Object.freeze({allowJs:true,checkJs:false,declaration:true,emitDeclarationOnly:true,strict:true,
    module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:false});

function checkConsumers(emitted:boolean) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ccc-wireless-types-"));
    try {
        const modules=["backends/android-device.mjs","domain/android-wireless.mjs","ports/android-wireless.mjs","application/android-wireless.mjs"]
            .map(name=>path.join(root,"packages/device-lab/providers",name));
        const emitDirectory=path.join(directory,"current");
        let candidate=modules[0], application=modules[3];
        if(emitted) {
            const emit=ts.createProgram(modules,{...DECLARATION_OPTIONS,outDir:emitDirectory,rootDir:path.join(root,"packages/device-lab/providers")});
            expect(messages(ts.getPreEmitDiagnostics(emit))).toEqual([]);
            expect(messages(emit.emit().diagnostics)).toEqual([]);
            candidate=path.join(emitDirectory,"backends/android-device.mjs");
            application=path.join(emitDirectory,"application/android-wireless.mjs");
        }
        const fixture=path.join(directory,"consumer.mts");
        fs.writeFileSync(fixture,`
            import * as Current from ${JSON.stringify(candidate)};
            import {createAndroidWirelessApplication} from ${JSON.stringify(application)};
            const backend=Current.androidRealBackend({adb:"adb",emulator:"emulator",avdmanager:"avdmanager",available:true,missing:[],provisioningAvailable:true,provisioningMissing:[]});
            backend.missing.push("mutable");
            backend.capabilities.push("mutable");
            const missingDiscovery={adb:null,emulator:null,avdmanager:null,available:false,missing:["adb"],provisioningAvailable:false,provisioningMissing:["avdmanager"]};
            const currentMissing=Current.androidRealBackend(missingDiscovery);
            const currentNullableTool:string|null=currentMissing.tools.adb;
            type Ports=Parameters<typeof createAndroidWirelessApplication>[0];
            declare const ports:Ports;
            const app=createAndroidWirelessApplication(ports);
            app.handle({action:"status",backend:"android-device"});
            // @ts-expect-error There is no new public legacy facade export.
            Current.createAndroidWirelessApplication;
            // @ts-expect-error Candidate preserves complete discovery carrier rather than accepting arbitrary fields.
            Current.androidRealBackend({adb:7});
            const {discover:omitted,...incomplete}=ports;void omitted;
            // @ts-expect-error Native discovery is required; no fallback is installed.
            createAndroidWirelessApplication(incomplete);
            const wrongDiscovery:Ports={...ports,
                // @ts-expect-error Discovery observations are synchronous.
                discover:async()=>({adb:"adb"}),
            };
            const wrongCommand:Ports={...ports,
                // @ts-expect-error Native command observations are synchronous.
                tcpip:async()=>({status:0,stdout:"",stderr:""}),
            };
            const wrongPublication:Ports={...ports,
                // @ts-expect-error Publisher selection returns a callable synchronously.
                selectJsonPublisher:async()=>()=>({}),
            };
            // @ts-expect-error No opaque wireless workflow native port.
            ports.wireless({action:"pair"});
            void [wrongDiscovery,wrongCommand,wrongPublication,currentNullableTool];
        `,{flag:"wx",mode:0o600});
        const program=ts.createProgram([fixture],{allowJs:!emitted,checkJs:false,noEmit:true,strict:true,skipLibCheck:false,
            module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,
            typeRoots:[path.join(root,"node_modules/@types")]});
        expect(messages(ts.getPreEmitDiagnostics(program))).toEqual([]);
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
describe("Android wireless authentic source and emitted contracts",()=>{
    it("strictly checks actual source consumers and required synchronous steps",()=>checkConsumers(false),30000);
    it("strictly checks actual emitted consumers and required synchronous steps",()=>checkConsumers(true),30000);
    it("uses the established inward guard for all three modules and rejects native authority mutations",()=>{
        const providers=path.join(root,"packages/device-lab/providers");
        for(const layer of ["domain","ports","application"]) {
            const file=path.join(providers,layer,"android-wireless.mjs");
            expect(coreBoundaryViolations(fs.readFileSync(file,"utf8"),file,{root:providers,language:"mjs"})).toEqual([]);
        }
        const file=path.join(providers,"application/android-wireless.mjs");
        for(const source of ["process.env.HOME;","Date.now();",'import {spawn} from "node:child_process";','import "../backends/android-device.mjs";','import("node:fs");']) {
            expect(coreBoundaryViolations(source,file,{root:providers,language:"mjs"}).length).toBeGreaterThan(0);
        }
    });
});
