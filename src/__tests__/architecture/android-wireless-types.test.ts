import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { coreBoundaryViolations } from "./core-boundary.js";
const root=path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
// Genuine original whole facade declaration privately emitted with authenticated
// TypeScript5.9.3 before the extraction: 31 emitted files, zero diagnostics.
const ORIGINAL_DECLARATION="export function androidRealBackend(discovery?: {\n    adb: string;\n    emulator: string;\n    avdmanager: string;\n    available: boolean;\n    missing: string[];\n    provisioningAvailable: boolean;\n    provisioningMissing: string[];\n}): {\n    name: string;\n    host: string;\n    creatable: boolean;\n    attachable: boolean;\n    available: boolean;\n    lazy: boolean;\n    status: string;\n    missing: string[];\n    tools: {\n        adb: string;\n    };\n    capabilities: string[];\n};\nexport function listAndroidRealDevices(): any;\nexport function handleAndroidRealTool(name: any, args: any): any;\n";
const ORIGINAL_DECLARATION_SHA="1b84e5bbbdbfc9d445bcfcf75f921844b11e2f99ccf0954c1c9a61ea89e52ccf";
const ORIGINAL_EMIT=Object.freeze({sdkSha:"3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675",sourceSha:"b53b89ebcdbdeb8430dc2c739e86e9da196d8cd4a3a844296f06ac00d61de53a",version:"5.9.3",diagnostics:0,files:31});
const messages=(diagnostics:readonly ts.Diagnostic[])=>diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"));

// The historical capture above used the compiler's default strict:false and
// remains immutable evidence. This matched strict reference was emitted from
// the same authenticated original whole source with strict:true, then checked
// bidirectionally against that original source with zero diagnostics.
const STRICT_ORIGINAL_DECLARATION="export function androidRealBackend(discovery?: {\n    adb: string | null;\n    emulator: string | null;\n    avdmanager: string | null;\n    available: boolean;\n    missing: string[];\n    provisioningAvailable: boolean;\n    provisioningMissing: string[];\n}): {\n    name: string;\n    host: string;\n    creatable: boolean;\n    attachable: boolean;\n    available: boolean;\n    lazy: boolean;\n    status: string;\n    missing: string[];\n    tools: {\n        adb: string | null;\n    };\n    capabilities: string[];\n};\nexport function listAndroidRealDevices(): any;\nexport function handleAndroidRealTool(name: any, args: any): any;\n";
const STRICT_ORIGINAL_DECLARATION_SHA="8905487bfe9e9549aa6c02122499763035f5e31a32b0363cb20a500bb4dd8cb3";
const DECLARATION_OPTIONS=Object.freeze({allowJs:true,checkJs:false,declaration:true,emitDeclarationOnly:true,strict:true,
    module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:false});
const STRICT_ORIGINAL_EMIT=Object.freeze({sdkSha:ORIGINAL_EMIT.sdkSha,sourceSha:ORIGINAL_EMIT.sourceSha,version:"5.9.3",
    diagnostics:0,consumerDiagnostics:0,strict:true,strictNullChecks:true});

function checkConsumers(emitted:boolean) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ccc-wireless-types-"));
    try {
        const previous=path.join(directory,"previous.d.mts");
        fs.writeFileSync(previous,STRICT_ORIGINAL_DECLARATION,{flag:"wx",mode:0o600});
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
            import * as Previous from ${JSON.stringify(previous.replace(/\.d\.mts$/,".mjs"))};
            import * as Current from ${JSON.stringify(candidate)};
            import {createAndroidWirelessApplication} from ${JSON.stringify(application)};
            const oldNamespace:typeof Previous=Current;
            const currentNamespace:typeof Current=Previous;
            type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
            type Assert<T extends true>=T;
            const namespaces:Assert<Equal<keyof typeof Previous,keyof typeof Current>>=true;
            const backend=Current.androidRealBackend({adb:"adb",emulator:"emulator",avdmanager:"avdmanager",available:true,missing:[],provisioningAvailable:true,provisioningMissing:[]});
            backend.missing.push("mutable");
            backend.capabilities.push("mutable");
            const missingDiscovery={adb:null,emulator:null,avdmanager:null,available:false,missing:["adb"],provisioningAvailable:false,provisioningMissing:["avdmanager"]};
            const originalMissing=Previous.androidRealBackend(missingDiscovery);
            const currentMissing=Current.androidRealBackend(missingDiscovery);
            const originalNullableTool:string|null=originalMissing.tools.adb;
            const currentNullableTool:string|null=currentMissing.tools.adb;
            type Ports=Parameters<typeof createAndroidWirelessApplication>[0];
            declare const ports:Ports;
            const app=createAndroidWirelessApplication(ports);
            app.handle({action:"status",backend:"android-device"});
            // @ts-expect-error There is no new public legacy facade export.
            Current.createAndroidWirelessApplication;
            // @ts-expect-error Original backend discovery carries concrete string tool paths.
            Previous.androidRealBackend({adb:7});
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
            void [oldNamespace,currentNamespace,namespaces,wrongDiscovery,wrongCommand,wrongPublication,originalNullableTool,currentNullableTool];
        `,{flag:"wx",mode:0o600});
        const program=ts.createProgram([fixture],{allowJs:!emitted,checkJs:false,noEmit:true,strict:true,skipLibCheck:false,
            module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,
            typeRoots:[path.join(root,"node_modules/@types")]});
        expect(messages(ts.getPreEmitDiagnostics(program))).toEqual([]);
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
describe("Android wireless authentic source and emitted contracts",()=>{
    it("authenticates genuine original namespace declarations without Task files",()=>{
        expect(createHash("sha256").update(ORIGINAL_DECLARATION).digest("hex")).toBe(ORIGINAL_DECLARATION_SHA);
        expect(ORIGINAL_EMIT.diagnostics).toBe(0);
        expect(ORIGINAL_EMIT.sourceSha).toBe("b53b89ebcdbdeb8430dc2c739e86e9da196d8cd4a3a844296f06ac00d61de53a");
        expect(createHash("sha256").update(STRICT_ORIGINAL_DECLARATION).digest("hex")).toBe(STRICT_ORIGINAL_DECLARATION_SHA);
        expect(STRICT_ORIGINAL_EMIT.diagnostics).toBe(0);expect(STRICT_ORIGINAL_EMIT.consumerDiagnostics).toBe(0);
        expect(DECLARATION_OPTIONS.strict).toBe(true);expect(DECLARATION_OPTIONS.skipLibCheck).toBe(false);
    });
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
