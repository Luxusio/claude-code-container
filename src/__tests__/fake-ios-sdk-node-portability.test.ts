import {afterEach,describe,expect,it} from "vitest";
import childProcess,{spawn,spawnSync,type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";import {gunzipSync} from "node:zlib";
import {existsSync,lstatSync,readFileSync,writeFileSync,unlinkSync} from "node:fs";
import {dirname,join,resolve} from "node:path";import {fileURLToPath} from "node:url";import {createServer} from "node:net";
import {readProcessIdentity,inspectProcessIdentity} from "@ccc/device-lab/providers/state/process-identity.mjs";
import {nodeProviderFixturePreloadSource} from "./helpers/node-provider-fixture.js";
import {createFakeIosMcpContext,cleanupFakeIosMcpContext,joinFakeIosFixtureChild,observeFakeIosFixtureAllocation,fakeIosFixtureDiagnostics,TIMEOUT,type FakeIosMcpContext} from "./helpers/fake-ios-mcp-fixture.js";

// Whole original authority2f5419eb... at reviewed2e816; controls selected BEFORE
// candidate helper edits. Static original templates are provenance, not runtime PASS.
const ORIGINAL="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";
const ORIGINAL_SHA="06165455201a7d92702f9b20adf1ea1212eb7b544ed695ab157d7ad5b2038341";
const originalBytes=gunzipSync(Buffer.from(ORIGINAL,"base64"));
const original=JSON.parse(originalBytes.toString("utf8")) as {sourceSha256:string;xcrunSourceTemplate:string;appiumSourceTemplate:string;effectiveGenericSourceTemplate:string};
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const contexts:FakeIosMcpContext[]=[],children:ChildProcess[]=[];
async function allocate(realSdk=false){const context=await createFakeIosMcpContext(realSdk?{}:{connect:async()=>undefined});contexts.push(context);return context;}
async function until(test:()=>boolean){const end=Date.now()+10000;while(!test()){if(Date.now()>=end)throw Error("portable fixture readiness10s");await new Promise(resolve=>setTimeout(resolve,20));}}
function env(c:FakeIosMcpContext){return {...process.env,HOME:c.homeDir,FAKE_IOS_LOG:c.logPath,FAKE_IOS_CONTAINER_ROOT:join(c.homeDir,"ios-app-container")};}
function tool(c:FakeIosMcpContext,name:string,args:string[],input="raw stdin\n한글"){
    const file=join(c.binDir,name),st=lstatSync(file);expect(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1).toBe(true);
    expect(readFileSync(file,"utf8").split("\n",1)[0]).toBe("#!"+process.execPath);
    return spawnSync(process.execPath,[file,...args],{env:env(c),cwd:c.homeDir,stdio:["pipe","pipe","pipe"],windowsHide:true,encoding:"utf8",input,timeout:10000,maxBuffer:4*1024*1024});
}
function result(c:FakeIosMcpContext,name:string,args:string[],expected:{status:number;stdout:string;stderr:string}){
    const observed=tool(c,name,args);
    expect({status:observed.status,stdout:observed.stdout,stderr:observed.stderr,error:observed.error,signal:observed.signal},JSON.stringify({name,args,pid:observed.pid})).toStrictEqual({...expected,error:undefined,signal:null});
    return observed;
}
// Independently specified libuv Windows argument representation, never marker
// commandHash as expected authority. On other actual hosts native ps/proc joins argv.
function nativeCommandHash(argv:string[]){
    const quote=(value:string)=>{if(value.length&&!/[\s"]/.test(value))return value;let out='"',slashes=0;
        for(const char of value){if(char==="\\"){slashes++;continue;}if(char==='"'){out+="\\".repeat(slashes*2+1)+'"';slashes=0;continue;}out+="\\".repeat(slashes)+char;slashes=0;}
        return out+"\\".repeat(slashes*2)+'"';};
    return hash((process.platform==="win32"?argv.map(quote):argv).join(" "));
}
async function service(c:FakeIosMcpContext){
    return observeFakeIosFixtureAllocation(c,async()=>{
        const journalPath=join(c.homeDir,"fake-ios-allocation.jsonl"),birth=lstatSync(journalPath),header=readFileSync(journalPath,"utf8"),initial=JSON.parse(header);
        expect(birth.isFile()&&!birth.isSymbolicLink()&&birth.nlink===1).toBe(true);expect(header.split("\n")).toHaveLength(2);expect(initial).toMatchObject({schema:1,kind:"header",token:expect.any(String)});
        const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
        const address=listener.address();if(!address||typeof address==="string")throw Error("owned listener address");
        await new Promise<void>(resolve=>listener.close(()=>resolve()));
        const argv=[join(c.binDir,"appium"),"server","--port",String(address.port)];
        const child=spawn(process.execPath,argv,{env:env(c),stdio:"ignore",windowsHide:true});children.push(child);
        await until(()=>existsSync(join(c.homeDir,"fake-ios-appium-"+child.pid+".pid"))&&fakeIosFixtureDiagnostics(c).includes('"phase":"listening"'));
        const marker=JSON.parse(readFileSync(join(c.homeDir,"fake-ios-appium-"+child.pid+".pid"),"utf8"));
        const identity=readProcessIdentity(child.pid);
        expect(identity).not.toBeNull();expect(identity).toStrictEqual(marker.identity);expect(identity!.pid).toBe(child.pid);
        expect(identity!.commandHash).toBe(nativeCommandHash([process.execPath,...argv]));expect(inspectProcessIdentity(identity,child.pid).status).toBe("match");
        const final=lstatSync(journalPath);expect([final.dev,final.ino]).toEqual([birth.dev,birth.ino]);
        const raw=readFileSync(journalPath,"utf8"),journal=raw.trimEnd().split("\n").map(line=>JSON.parse(line));expect(raw.startsWith(header)).toBe(true);expect(marker.token).toBe(initial.token);
        expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(32768);expect(journal).toHaveLength(3);
        expect(journal.map(r=>r.kind)).toEqual(["header","pending","allocation"]);expect(journal.map(r=>r.token)).toEqual([marker.token,marker.token,marker.token]);
        expect(journal[1].pid).toBe(child.pid);expect(journal[2].pid).toBe(child.pid);expect(journal[2].allocationId).toBe(journal[1].allocationId);expect(journal[2].identity).toStrictEqual(identity);
        expect(marker.home).toBe(c.homeDir);expect(marker.log).toBe(c.logPath);expect(marker.stalePath).toBe(join(c.homeDir,"stale-ios-session"));
        return {child,marker,url:"http://127.0.0.1:"+address.port};
    });
}
afterEach(async()=>{
    const failures:unknown[]=[],deadline=Date.now()+TIMEOUT;
    for(const child of children.splice(0))try{await joinFakeIosFixtureChild(child,deadline);}catch(error){failures.push(error);}
    for(const c of contexts.splice(0))try{await cleanupFakeIosMcpContext(c,{deadline});}catch(error){console.error(fakeIosFixtureDiagnostics(c));failures.push(error);}
    if(failures.length)throw new AggregateError(failures,"portable fixture owned actor/root settlement");
});
const suffix=',"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}\n';
const inventory=(name?:string,state="Shutdown")=>'{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}'+(name===undefined?'':',{"name":"'+name+'","udid":"CREATED-IOS-UDID","state":"'+state+'"}')+']}'+suffix;
const ok={status:0,stdout:"",stderr:""};
describe("unskipped actual Node iOS SDK programs and independent original behavior",()=>{
    it("authenticates frozen effective original control and unchanged native/router authority",()=>{
        expect(hash(originalBytes)).toBe(ORIGINAL_SHA);expect(original.sourceSha256).toBe("57da3f411ff47d984c3e1525928d83edd7d9a7b6479a7f542e7c9e2d43f551d6");
        expect(original.xcrunSourceTemplate).toContain('exec /bin/sleep 0.8');expect(original.xcrunSourceTemplate).toContain('exec /bin/sleep 20');
        expect(original.effectiveGenericSourceTemplate).not.toContain("Xcode 15.0");
        for(const [file,pin]of [["src/__tests__/helpers/node-provider-fixture.ts","1a76629ce66ed7c6a1de00b69f24d54016445f2fdc2f12ea7b02810d3fa98f67"],["packages/device-lab/providers/state/process-identity.mjs","60982e23b9371428e3d000ea8f236bb1f4afcf122a7f0dca10386687b063f348"]])expect(hash(readFileSync(join(root,file)))).toBe(pin);
    });
    it("child-local routing leaves parent native bindings/environment intact on allocation and primary connect throw",{timeout:TIMEOUT},async()=>{
        const before={spawn:childProcess.spawn,spawnSync:childProcess.spawnSync,nodeOptions:process.env.NODE_OPTIONS,path:process.env.PATH,home:process.env.HOME};
        const assertUnchanged=()=>expect({spawn:childProcess.spawn,spawnSync:childProcess.spawnSync,nodeOptions:process.env.NODE_OPTIONS,path:process.env.PATH,home:process.env.HOME}).toStrictEqual(before);
        await allocate();assertUnchanged();const primary=new Error("independent primary connect throw");let allocated:FakeIosMcpContext|undefined;
        await expect(createFakeIosMcpContext({onAllocated:c=>{allocated=c;},connect:async()=>{throw primary;}})).rejects.toBe(primary);
        expect(allocated).toBeDefined();expect(existsSync(allocated!.homeDir)).toBe(false);expect(existsSync(allocated!.binDir)).toBe(false);assertUnchanged();
    });
    it("real generated tools use both discovery forms, preserve argv/options/stdin and count caught host fallbacks",{timeout:TIMEOUT},async()=>{
        const c=await allocate(),probe=join(c.binDir,"arg-options-control"),preload=join(c.homeDir,"routing-control.cjs");
        writeFileSync(probe,"#!"+process.execPath+"\nconst fs=require('node:fs');process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.OWNED_OPTION,stdin:fs.readFileSync(0,'utf8')}));if(process.argv[2]==='--wait')setTimeout(()=>{},20000);",{flag:"wx",mode:0o700});
        writeFileSync(preload,nodeProviderFixturePreloadSource(c.binDir),{flag:"wx",mode:0o600});
        const source=`
const cp=require('node:child_process'),bin=@BIN@,preload=@PRELOAD@,home=@HOME@,node=process.execPath,path=require('node:path');
const native=cp.spawnSync;let denied=0;const allowed=new Set(['xcrun','arg-options-control'].map(name=>path.join(bin,name)));
cp.spawnSync=function(command,args,options){if(command!==node||!allowed.has(args[0])){denied++;throw Error('unallocated host command');}return native(command,args,options);};
require(preload);require('node:module').syncBuiltinESMExports();
const a=cp.spawnSync('where',['xcrun'],{encoding:'utf8'}),b=cp.spawnSync('/bin/sh',['-c','command -v xcrun'],{encoding:'utf8'}),missing=cp.spawnSync('where',['missing-ios-tool'],{encoding:'utf8'});
const args=@ARGUMENTS@,input=@INPUT@,options={encoding:'utf8',cwd:home,env:{...process.env,OWNED_OPTION:'raw option',PATH:''},input,windowsHide:true,timeout:10000,maxBuffer:4*1024*1024};
const observed=cp.spawnSync(path.join(bin,'arg-options-control'),args,options),real=cp.spawnSync(path.join(bin,'xcrun'),['simctl','bootstatus','owned'],options);
const overflow=cp.spawnSync(path.join(bin,'arg-options-control'),args,{...options,maxBuffer:64}),timed=cp.spawnSync(path.join(bin,'arg-options-control'),['--wait'],{...options,timeout:2000});
const errorRecord=r=>({status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error&&{code:r.error.code,message:r.error.message,path:r.error.path,spawnargs:r.error.spawnargs}});
const positiveDenials=denied;try{cp.spawnSync('unallocated-ios-command',[],options);}catch{}
process.stdout.write(JSON.stringify({a,b,missing,observed,real,overflow:errorRecord(overflow),timed:errorRecord(timed),positiveDenials,denied}));
`.replace("@BIN@",JSON.stringify(c.binDir)).replace("@PRELOAD@",JSON.stringify(preload)).replace("@HOME@",JSON.stringify(c.homeDir)).replace("@ARGUMENTS@",JSON.stringify(["a b","한글",'"quoted"',"C:\\fixture\\end\\"])).replace("@INPUT@",JSON.stringify("raw stdin\n한글"));
        const actor=spawnSync(process.execPath,["-e",source],{encoding:"utf8",env:env(c),timeout:10000,maxBuffer:4*1024*1024});
        expect({status:actor.status,stderr:actor.stderr,error:actor.error}).toEqual({status:0,stderr:"",error:undefined});
        const r=JSON.parse(actor.stdout);for(const lookup of [r.a,r.b])expect({status:lookup.status,stdout:lookup.stdout,stderr:lookup.stderr}).toEqual({status:0,stdout:join(c.binDir,"xcrun")+"\n",stderr:""});
        expect(r.missing.status).toBe(1);expect(r.missing.stdout).toBe("");expect(r.observed.status).toBe(0);
        expect(JSON.parse(r.observed.stdout)).toStrictEqual({args:["a b","한글",'"quoted"',"C:\\fixture\\end\\"],cwd:c.homeDir,env:"raw option",stdin:"raw stdin\n한글"});
        expect({status:r.real.status,stdout:r.real.stdout,stderr:r.real.stderr}).toEqual({status:0,stdout:"Booted\n",stderr:""});expect(r.positiveDenials).toBe(0);expect(r.denied).toBe(1);
        expect(r.overflow.error).toMatchObject({code:"ENOBUFS",path:process.execPath});expect(r.timed.error).toMatchObject({code:"ETIMEDOUT",path:process.execPath});expect(r.timed.error.spawnargs).toEqual([probe,"--wait"]);expect(r.timed.error.message).toContain("ETIMEDOUT");
        expect(readFileSync(c.logPath,"utf8")).toBe("xcrun simctl bootstatus owned\n");
    });
    it("pins raw command families, unescaped created names and effective overwritten version behavior",{timeout:TIMEOUT},async()=>{
        const c=await allocate();result(c,"xcrun",["simctl","list","-j"],{...ok,stdout:inventory()});
        result(c,"xcrun",["xctrace","list","devices"],{...ok,stdout:"Devices:\nBuild Mac (15.0) (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)\nReal iPhone (17.5) (00008110-001C195E0E91801E)\nNetwork Named USB iPhone (17.5) (00008111-001C195E0E91801F)\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\nOther iPhone (16.7) (00008101-00DEADBEEFCAFE00)\nSimulators:\niPhone 15 Simulator (17.0) (SIM-UDID)\n"});
        result(c,"xcrun",["devicectl","device","install","app","--device","owned","app bundle"],ok);
        result(c,"xcrun",["devicectl","device","process","launch","--device","owned","--terminate-existing","com.example.Real"],{...ok,stdout:"launched com.example.Real\n"});
        const name='spaces 한글 "raw name"';result(c,"xcrun",["simctl","create",name,"device type","runtime"],{...ok,stdout:"CREATED-IOS-UDID\n"});
        expect(readFileSync(join(c.homeDir,"fake-ios-created-name"),"utf8")).toBe(name);result(c,"xcrun",["simctl","list","devices","-j"],{...ok,stdout:inventory(name)});
        result(c,"xcrun",["simctl","boot","CREATED-IOS-UDID"],ok);expect(existsSync(join(c.homeDir,"fake-ios-created-booted"))).toBe(true);
        result(c,"xcrun",["simctl","list","-j"],{...ok,stdout:inventory(name,"Booted")});
        result(c,"xcrun",["simctl","bootstatus","CREATED-IOS-UDID","-b"],{...ok,stdout:"Booted\n"});
        for(const args of [["simctl","erase","owned"],["simctl","openurl","owned","https://example.test"],["simctl","install","owned","bundle path"],["unallocated-default-original"]])result(c,"xcrun",args,ok);
        result(c,"xcrun",["simctl","spawn","owned","command","arg"],{...ok,stdout:"ok\n"});
        result(c,"xcrun",["simctl","launch","owned","com.example.App"],{...ok,stdout:"com.example.App: 123\n"});
        const container=join(c.homeDir,"ios-app-container");result(c,"xcrun",["simctl","get_app_container","owned","bundle"],{...ok,stdout:container+"\n"});expect(lstatSync(container).isDirectory()).toBe(true);
        const screenshot=join(c.homeDir,"screen space 한글.png");result(c,"xcrun",["simctl","io","owned","screenshot",screenshot],ok);expect(readFileSync(screenshot,"utf8")).toBe("fakepng");
        result(c,"xcodebuild",["-version"],ok);result(c,"appium-xcuitest-driver",["a b","한글",'"quoted"',"C:\\fixture"],ok);
        const log=readFileSync(c.logPath,"utf8");expect(log).toContain("xcrun simctl create "+name+" device type runtime\n");expect(log).toContain("xcodebuild -version\n");expect(log).toContain('appium-xcuitest-driver a b 한글 "quoted" C:\\fixture\n');
    });
    it.each(["bootstatus","shutdown","delete"])("preserves %s replacement and one-shot failure effect order",{timeout:TIMEOUT},async command=>{
        const c=await allocate(),target=join(c.homeDir,"allocated state.json"),source=join(c.homeDir,"replacement state.json");
        writeFileSync(target,"original");writeFileSync(source,"successor");writeFileSync(join(c.homeDir,"fake-ios-replace-state-target"),target);writeFileSync(join(c.homeDir,"fake-ios-replace-state-source"),source);
        if(command!=="bootstatus")writeFileSync(join(c.homeDir,"fake-ios-replace-state-command"),command);
        result(c,"xcrun",["simctl","create","Owned","type","runtime"],{...ok,stdout:"CREATED-IOS-UDID\n"});result(c,"xcrun",["simctl","boot","CREATED-IOS-UDID"],ok);
        if(command!=="bootstatus"){writeFileSync(join(c.homeDir,"fake-ios-"+command+"-fail-once"),"1");result(c,"xcrun",["simctl",command,"CREATED-IOS-UDID"],{status:1,stdout:"",stderr:"simulated "+command+" failure\n"});
            expect(readFileSync(target,"utf8")).toBe("original");expect(existsSync(join(c.homeDir,"fake-ios-replace-state-done"))).toBe(false);expect(existsSync(join(c.homeDir,"fake-ios-created-booted"))).toBe(true);expect(existsSync(join(c.homeDir,"fake-ios-"+command+"-fail-once"))).toBe(false);}
        result(c,"xcrun",["simctl",command,"CREATED-IOS-UDID"],{...ok,stdout:command==="bootstatus"?"Booted\n":""});
        expect(readFileSync(target,"utf8")).toBe("successor");expect(readFileSync(join(c.homeDir,"fake-ios-replace-state-done"),"utf8")).toBe("");
        if(command!=="bootstatus")expect(existsSync(join(c.homeDir,"fake-ios-created-booted"))).toBe(false);if(command==="delete")expect(existsSync(join(c.homeDir,"fake-ios-created-name"))).toBe(false);
    });
    it("recorder exit9 precedes output, natural 0.8s and normal 20s paths retain returned Node identity",async()=>{
        const c=await allocate(),output=join(c.homeDir,"raw video.mp4");writeFileSync(join(c.homeDir,"fake-ios-record-fail-once"),"1");
        result(c,"xcrun",["simctl","io","owned","recordVideo",output],{status:9,stdout:"",stderr:""});expect(existsSync(output)).toBe(false);expect(existsSync(join(c.homeDir,"fake-ios-record-fail-once"))).toBe(false);
        for(const natural of [true,false]){
            if(natural)writeFileSync(join(c.homeDir,"fake-ios-record-natural-exit-once"),"1");
            if(existsSync(output))unlinkSync(output);
            const argv=[join(c.binDir,"xcrun"),"simctl","io","owned","recordVideo",output],started=Date.now(),child=spawn(process.execPath,argv,{env:env(c),stdio:"ignore",windowsHide:true});children.push(child);
            const terminal=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolve({code,signal}));});
            let identity:ReturnType<typeof readProcessIdentity>=null;await until(()=>existsSync(output)&&Boolean(identity=readProcessIdentity(child.pid)));
            expect(identity!.pid).toBe(child.pid);expect(identity!.commandHash).toBe(nativeCommandHash([process.execPath,...argv]));expect(natural?["match","exited"]:["match"]).toContain(inspectProcessIdentity(identity!,child.pid).status);expect(readFileSync(output,"utf8")).toBe("fakevideo");
            if(natural){expect(await terminal).toEqual({code:0,signal:null});expect(Date.now()-started).toBeGreaterThanOrEqual(750);expect(existsSync(join(c.homeDir,"fake-ios-record-natural-exit-once"))).toBe(false);}
            else{await new Promise(resolve=>setTimeout(resolve,1000));expect(child.exitCode).toBeNull();expect(child.signalCode).toBeNull();expect(await terminal).toEqual({code:0,signal:null});expect(Date.now()-started).toBeGreaterThanOrEqual(19750);}
        }
    },TIMEOUT);
    it("actual Appium process retains bounded journal/native identity and raw HTTP route/marker semantics",async()=>{
        const c=await allocate(),s=await service(c);
        const request=async(method:string,path:string,body?:string)=>{const response=await fetch(s.url+path,{method,body,headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(5000)});return {status:response.status,text:await response.text()};};
        writeFileSync(join(c.homeDir,"fail-ios-status-once"),"1");expect(await request("GET","/status")).toEqual({status:503,text:'{"value":{"error":"fixture status unavailable"}}'});expect(existsSync(join(c.homeDir,"fail-ios-status-once"))).toBe(false);
        expect(await request("GET","/status")).toEqual({status:200,text:'{"value":{"ready":true}}'});
        const body='{"capabilities":{"alwaysMatch":{"raw":"한글 quote \\"value\\""}}}';
        expect(await request("POST","/session",body)).toEqual({status:200,text:'{"value":{"sessionId":"IOS-SESSION-1"}}'});
        expect(await request("GET","/session/IOS-SESSION-1")).toEqual({status:200,text:'{"value":{"sessionId":"IOS-SESSION-1"}}'});
        writeFileSync(join(c.homeDir,"stale-ios-session"),"1");expect(await request("GET","/session/IOS-SESSION-1")).toEqual({status:404,text:'{"value":{"error":"stale"}}'});expect(existsSync(join(c.homeDir,"stale-ios-session"))).toBe(false);
        expect(await request("GET","/session/IOS-SESSION-1/source")).toEqual({status:200,text:'{"value":"<AppiumAUT><XCUIElementTypeApplication name=\\"Test\\"/></AppiumAUT>"}'});
        writeFileSync(join(c.homeDir,"stale-ios-session-source-fail"),"1");expect(await request("GET","/session/IOS-SESSION-1/source")).toEqual({status:500,text:'{"value":{"error":"source failed"}}'});
        expect(await request("GET","/session/IOS-SESSION-1/screenshot")).toEqual({status:200,text:'{"value":"'+Buffer.from("fake-real-ios-png").toString("base64")+'"}'});
        for(const endpoint of ["actions","keys","execute/sync","orientation"])expect(await request("POST","/session/IOS-SESSION-1/"+endpoint,'{"raw":"한글"}')).toEqual({status:200,text:'{"value":null}'});
        expect(await request("POST","/session/IOS-SESSION-1/execute/sync",'{"script":"mobile: activeAppInfo"}')).toEqual({status:200,text:'{"value":{"bundleId":"com.example.Real","name":"Real"}}'});
        const target=join(c.homeDir,"allocated conflict.json");writeFileSync(target,"before");writeFileSync(join(c.homeDir,"fake-ios-real-state-conflict-path"),target);writeFileSync(join(c.homeDir,"fake-ios-real-state-conflict.json"),"after");
        expect(await request("DELETE","/session/IOS-SESSION-1")).toEqual({status:200,text:'{"value":null}'});expect(readFileSync(target,"utf8")).toBe("after");expect(existsSync(join(c.homeDir,"fake-ios-real-state-conflict-path"))).toBe(false);
        expect(await request("GET","/session/IOS-SESSION-1")).toEqual({status:404,text:'{"value":{"error":"unknown route"}}'});
        expect(await request("POST","/session","{}")).toEqual({status:200,text:'{"value":{"sessionId":"IOS-SESSION-2"}}'});
        const log=readFileSync(c.logPath,"utf8");expect(log).toContain("appium-session-body "+body+"\n");expect(log).toContain('appium-command-body /session/IOS-SESSION-1/keys {"raw":"한글"}\n');
        const diagnostic=readFileSync(join(c.homeDir,"fake-ios-lifetime.jsonl"),"utf8");expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192);expect(diagnostic.trimEnd().split("\n").length).toBeLessThanOrEqual(64);
    },TIMEOUT);
    it("real Client/Stdio SDK public requests reach lifecycle and Appium error/recovery without a platform skip",async()=>{
        const c=await allocate(true);expect((await c.client.listTools()).tools.some(t=>t.name==="create_ios_simulator")).toBe(true);
        const call=async(name:string,args:Record<string,unknown>)=>c.client.callTool({name,arguments:{...args,implicitBroker:false}});
        const parsed=(r:any)=>JSON.parse(r.content[0].text),inventoryReply=await call("devices",{view:"available",backend:"ios-simulator"});expect(inventoryReply.isError).not.toBe(true);
        const owner=parsed(inventoryReply).ownerId,id="ios-node-portable",name="ccc-"+owner+"-node-portable";
        const created=await call("create_ios_simulator",{name:"Node portable",deviceId:id,simulatorName:name,deviceType:"com.apple.CoreSimulator.SimDeviceType.iPhone-15",runtime:"com.apple.CoreSimulator.SimRuntime.iOS-17-0"});expect(created.isError).not.toBe(true);expect(parsed(created).device).toMatchObject({deviceId:id,simulatorName:name,udid:"CREATED-IOS-UDID",status:"stopped"});
        const started=await call("start",{deviceId:id,bootTimeoutMs:1000});expect(started.isError).not.toBe(true);expect(parsed(started)).toMatchObject({device:{status:"booted"},boot:{ready:true}});
        const ui=await call("ui",{deviceId:id});expect(ui.isError,JSON.stringify(ui)).not.toBe(true);const uiValue=parsed(ui);expect(uiValue).toMatchObject({provider:"appium-xcuitest",sessionId:"IOS-SESSION-1"});expect(uiValue.source).toContain("XCUIElementTypeApplication");
        const status=await call("status",{deviceId:id}),session=parsed(status).automation.session,native=readProcessIdentity(session.serverPid);
        expect(native).toStrictEqual(session.processIdentity);expect(native!.commandHash).toBe(nativeCommandHash([process.execPath,join(c.binDir,"appium"),"server","--port",String(new URL(session.serverUrl).port),"--base-path","/"]));
        writeFileSync(join(c.homeDir,"stale-ios-session-source-fail"),"1");const failed=await call("ui",{deviceId:id});expect(failed.isError).toBe(true);expect(failed.content[0]).toMatchObject({type:"text"});expect(JSON.stringify(failed)).toContain("source failed");
        const stopped=await call("stop",{deviceId:id});expect(stopped.isError).not.toBe(true);expect(parsed(stopped).device.status).toBe("stopped");
        const deleted=await call("delete",{deviceId:id,deleteSimulator:true,confirmDestructive:true});expect(deleted.isError).not.toBe(true);expect(parsed(deleted)).toEqual({deleted:id,simulatorDeleted:true});
        const log=readFileSync(c.logPath,"utf8"),steps=["create "+name,"boot CREATED-IOS-UDID","bootstatus CREATED-IOS-UDID -b","shutdown CREATED-IOS-UDID","delete CREATED-IOS-UDID"].map(step=>log.indexOf("xcrun simctl "+step));expect(steps.every(n=>n>=0)).toBe(true);expect(steps).toEqual([...steps].sort((a,b)=>a-b));expect(log).toContain("appium-http POST /session");expect(log).toContain("appium-http DELETE /session/IOS-SESSION-1");
    },TIMEOUT);
});
// Linux where controls are routing selection only. Native Windows runtime proof
// requires this unskipped file to execute on an actual admitted Windows Node host.
