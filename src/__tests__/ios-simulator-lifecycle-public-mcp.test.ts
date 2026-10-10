import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {createFakeIosMcpContext,cleanupFakeIosMcpContext,fakeIosFixtureDiagnostics,TIMEOUT} from "./helpers/fake-ios-mcp-fixture.js";

// Existing public SDK/native integration, moved unchanged from the architecture fixture.
describe("iOS Simulator lifecycle public MCP integration",()=>{
    it.skipIf(process.platform==="win32")("actual public MCP normalization/dispatch reaches all four lifecycle branches with existing owned SDK fixture",async()=>{
        let context:Awaited<ReturnType<typeof createFakeIosMcpContext>>|undefined;const errors:unknown[]=[];
        try{
            context=await createFakeIosMcpContext();const parsed=(result:any)=>JSON.parse(result.content[0].text);
            const inventory=await context.client.callTool({name:"devices",arguments:{view:"available",backend:"ios-simulator",implicitBroker:false}});
            const owner=parsed(inventory).ownerId,deviceId="ios-architecture-four",simulatorName="ccc-"+owner+"-architecture-four";
            const created=await context.client.callTool({name:"create_ios_simulator",arguments:{name:"Architecture Four",deviceId,simulatorName,deviceType:"com.apple.CoreSimulator.SimDeviceType.iPhone-15",runtime:"com.apple.CoreSimulator.SimRuntime.iOS-17-0",implicitBroker:false}});
            expect(created.isError).not.toBe(true);expect(parsed(created).device).toMatchObject({deviceId,simulatorName,udid:"CREATED-IOS-UDID",provisioning:"created",status:"stopped"});
            const started=await context.client.callTool({name:"start",arguments:{deviceId,bootTimeoutMs:1000,implicitBroker:false}});
            expect(started.isError).not.toBe(true);expect(parsed(started)).toMatchObject({device:{status:"booted"},boot:{ready:true}});
            const stopped=await context.client.callTool({name:"stop",arguments:{deviceId,implicitBroker:false}});expect(stopped.isError).not.toBe(true);expect(parsed(stopped).device).toMatchObject({status:"stopped",lifecycle:null});
            const deleted=await context.client.callTool({name:"delete",arguments:{deviceId,deleteSimulator:true,confirmDestructive:true,implicitBroker:false}});expect(deleted.isError).not.toBe(true);expect(parsed(deleted)).toMatchObject({deleted:deviceId,simulatorDeleted:true});
            const log=readFileSync(context.logPath,"utf8");const positions=["create "+simulatorName,"boot CREATED-IOS-UDID","bootstatus CREATED-IOS-UDID -b","shutdown CREATED-IOS-UDID","delete CREATED-IOS-UDID"].map(fragment=>log.indexOf("xcrun simctl "+fragment));
            expect(positions.every(position=>position>=0)).toBe(true);expect(positions).toEqual([...positions].sort((a,b)=>a-b));
        }catch(error){errors.push(error);if(context)console.error(fakeIosFixtureDiagnostics(context));}
        finally{try{await cleanupFakeIosMcpContext(context);}catch(error){errors.push(error);}}
        if(errors.length)throw new AggregateError(errors,"iOS primary assertion before owned fixture cleanup failures");
    },TIMEOUT);
});
// Owned fake SDK only; no native macOS/Xcode, broker-native, distribution, or whole-operation acceptance.
