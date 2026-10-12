import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], result: {status:0,stdout:"",stderr:""} as any, results: [] as any[], calls: [] as any[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({Server:class { setRequestHandler(_schema:unknown, handler:any) {fixture.handlers.push(handler);} async connect(){} }}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({StdioServerTransport:class{}}));
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    run: (...args:unknown[]) => {fixture.calls.push(args);return fixture.results.shift() ?? fixture.result;},
    runWithTimeout: (...args:unknown[]) => {fixture.calls.push(args);return fixture.results.shift() ?? fixture.result;},
}));
import {startServer} from "../../device-lab-mcp/src/server.mjs";
import {TOOLS} from "../../device-lab-mcp/src/tools.mjs";
import {currentDisplayTarget, handleDisplayTool} from "@ccc/device-lab/providers/display/x11.mjs";
import {X11_DRAG_COMMAND} from "@ccc/device-lab/providers/display/desktop-input.mjs";
import {X11_WINDOW_LIST_COMMAND} from "@ccc/device-lab/providers/display/window-list.mjs";
beforeAll(async()=>{await startServer();});
beforeEach(()=>{fixture.calls.length=0;fixture.results.length=0;fixture.result={status:0,stdout:"",stderr:""};});
const call=(detail=false)=>fixture.handlers[1]({params:{name:"window_list",arguments:{deviceId:"x11-current-display",implicitBroker:false,detail}}});
const display = (name:string, args:any = {}) => handleDisplayTool(name,args);
const payload = (result:any) => JSON.parse(result.content[0].text);
describe("public desktop windows",()=>{
    it("retains the 59-tool surface and advertises implemented display capability",()=>{
        expect(TOOLS).toHaveLength(59);
        expect(currentDisplayTarget().capabilities).toContain("device_window_list");
    });
    it.each([false,true])("routes current display and preserves window output detail=%s",async detail=>{
        fixture.result.stdout=`42\t123\t${Buffer.from("Notes").toString("base64")}\n`;
        const result=await call(detail);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({windows:[{handle:"42",title:"Notes",processId:123}]});
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0][0]).toBe("bash");
    });
    it("returns real empty success, but flags query and decode failures",async()=>{
        expect(JSON.parse((await call()).content[0].text)).toMatchObject({windows:[]});
        fixture.result={status:1,stdout:"",stderr:"window-list-display-unavailable"};
        expect((await call()).isError).toBe(true);
        fixture.result={status:0,stdout:"bad",stderr:""};
        expect((await call()).isError).toBe(true);
    });
});

describe("X11 public native controls",()=>{
    it.each([
        ["display_click", {x:"12",y:13}, ["mousemove","12","13","click","1"], {clicked:{x:"12",y:13,button:"left"}}],
        ["display_click", {x:12,y:13,button:"right"}, ["mousemove","12","13","click","3"], {clicked:{x:12,y:13,button:"right"}}],
        ["display_double_click", {x:12,y:13,button:"middle"}, ["mousemove","12","13","click","--repeat","2","1"], {doubleClicked:{x:12,y:13,button:"middle"}}],
        ["display_double_click", {x:12,y:13,button:"right"}, ["mousemove","12","13","click","--repeat","2","3"], {doubleClicked:{x:12,y:13,button:"right"}}],
        ["display_key", {key:"--window $(touch /tmp/never)"}, ["key","--","--window $(touch /tmp/never)"], {key:"--window $(touch /tmp/never)"}],
        ["display_type", {text:"--window 42; $(touch /tmp/never)\n'quoted'"}, ["type","--clearmodifiers","--","--window 42; $(touch /tmp/never)\n'quoted'"], {typed:true,length:46}],
    ] as [string, any, string[], any][])("executes %s as native argv and preserves public evidence",async(name,args,argv,expected)=>{
        fixture.result={status:0,stdout:"native output",stderr:"native warning"};
        const result=await display(name,args);
        expect(result?.isError).not.toBe(true);
        // Text length is a public value, independent of native output.
        const fields = name === "display_type" ? {...expected,length:String(args.text).length} : expected;
        expect(payload(result)).toEqual({...fields,provider:"xdotool",stdout:"native output",stderr:"native warning",status:0});
        expect(fixture.calls).toEqual([["xdotool",argv]]);
    });
    it.each([["up","4"],["down","5"],["left","6"],["right","7"]])("maps %s scroll with the default amount",async(direction,button)=>{
        expect(payload(await display("display_scroll",{x:2,y:4,direction}))).toMatchObject({scrolled:{x:2,y:4,direction,amount:3},provider:"xdotool"});
        expect(fixture.calls).toEqual([["xdotool",["mousemove","2","4","click","--repeat","3",button]]]);
    });
    it("preserves explicit scroll amount and refuses unknown direction before execution",async()=>{
        await display("display_scroll",{x:2,y:4,direction:"down",amount:0});
        expect(fixture.calls).toEqual([["xdotool",["mousemove","2","4","click","--repeat","0","5"]]]);
        fixture.calls.length=0;
        expect(await display("display_scroll",{direction:"diagonal"})).toMatchObject({isError:true,content:[{text:"Unknown scroll direction: diagonal"}]});
        expect(fixture.calls).toEqual([]);
    });
    it.each([
        ["x:12 y:34 screen:0 window:42\n",{x:12,y:34,screen:0,window:"42",raw:"x:12 y:34 screen:0 window:42"}],
        ["x:bad y:Infinity screen:nope\n",{x:null,y:null,screen:null,window:null,raw:"x:bad y:Infinity screen:nope"}],
        ["",{x:null,y:null,screen:null,window:null,raw:""}],
    ])("decodes cursor native data %s",async(stdout,expected)=>{
        fixture.result.stdout=stdout;
        expect(payload(await display("display_cursor_position"))).toEqual({...expected,provider:"xdotool"});
        expect(fixture.calls).toEqual([["xdotool",["getmouselocation"]]]);
    });
    it("moves an integer point and rejects invalid coordinates without execution",async()=>{
        expect(payload(await display("display_move",{x:0,y:23}))).toEqual({ok:true});
        expect(fixture.calls).toEqual([["xdotool",["mousemove","0","23"]]]);
        fixture.calls.length=0;
        expect(await display("display_move",{x:1.5,y:23})).toMatchObject({isError:true,content:[{text:"invalid-pointer-coordinates"}]});
        expect(fixture.calls).toEqual([]);
    });
    it.each([undefined,1,10000])("uses the bounded native drag recipe duration=%s",async(durationMs)=>{
        expect(payload(await display("display_drag",{x1:1,y1:2,x2:3,y2:4,durationMs}))).toEqual({ok:true});
        expect(fixture.calls).toEqual([["bash",["-c",X11_DRAG_COMMAND,"ccc-drag","1","2","3","4",String(durationMs ?? 700)],15000]]);
    });
    it.each([0,10001])("refuses invalid drag duration %s before execution",async(durationMs)=>{
        expect(await display("display_drag",{x1:1,y1:2,x2:3,y2:4,durationMs})).toMatchObject({isError:true,content:[{text:"invalid-drag-arguments"}]});
        expect(fixture.calls).toEqual([]);
    });
    it.each(["display_click","display_double_click","display_key","display_type","display_scroll","display_cursor_position","display_move","display_drag"])("renders native failure for %s without success",async name=>{
        fixture.result={status:7,stdout:"ignored",stderr:"native refused"};
        expect(await display(name,{x:1,y:2,key:"Return",text:"hello",direction:"down",x1:1,y1:2,x2:3,y2:4})).toMatchObject({isError:true,content:[{text:"Error: native refused"}]});
        expect(fixture.calls).toHaveLength(1);
    });
    it("activates then reads native focus, accepting trimmed exact handles",async()=>{
        fixture.results.push({status:0,stdout:"",stderr:""},{status:0,stdout:" \n42\t",stderr:""});
        expect(payload(await display("display_focus_window",{handle:"42"}))).toEqual({ok:true});
        expect(fixture.calls).toEqual([["xdotool",["windowactivate","--sync","42"],5000],["xdotool",["getactivewindow"],5000]]);
    });
    it("skips focus readback when activation fails",async()=>{
        fixture.result={status:1,stdout:"",stderr:"activation failed"};
        expect(await display("display_focus_window",{handle:"42"})).toMatchObject({isError:true,content:[{text:"Error: activation failed"}]});
        expect(fixture.calls).toEqual([["xdotool",["windowactivate","--sync","42"],5000]]);
    });
    it.each([[1,"","readback failed","Error: readback failed"],[0,"43","","window-focus-denied"],[0,"042","","window-focus-denied"]])("refuses failed or mismatching focus readback %s/%s",async(status,stdout,stderr,message)=>{
        fixture.results.push({status:0,stdout:"",stderr:""},{status,stdout,stderr});
        expect(await display("display_focus_window",{handle:"42"})).toMatchObject({isError:true,content:[{text:message}]});
        expect(fixture.calls).toHaveLength(2);
    });
    it.each(["0","42; echo injected","-42","123456789012345678901"])("refuses invalid focus handle %s without native effects",async handle=>{
        expect(await display("display_focus_window",{handle})).toMatchObject({isError:true,content:[{text:"invalid-window-handle"}]});
        expect(fixture.calls).toEqual([]);
    });
    it.each([[undefined,30000],[0,30000],[90000,30000],[1200,1200]])("bounds window query timeout %s",async(helperTimeoutMs,timeout)=>{
        expect(payload(await display("display_window_list",{helperTimeoutMs}))).toEqual({windows:[]});
        expect(fixture.calls).toEqual([["bash",["-c",X11_WINDOW_LIST_COMMAND],timeout,{maxBuffer:1024*1024}]]);
    });
    it.each([["malformed row","bad"],["invalid base64","42\t123\tnot-base64!\n"],["oversized output","x".repeat(1024*1024+1)]])("renders %s as parse refusal",async(_label,stdout)=>{
        fixture.result.stdout=stdout;
        expect(await display("display_window_list")).toMatchObject({isError:true,content:[{text:"window-list-invalid-result"}]});
        expect(fixture.calls).toHaveLength(1);
    });
    it("renders native window query failure before decoding",async()=>{
        fixture.result={status:1,stdout:"malformed",stderr:"window-list-query-failed"};
        expect(await display("display_window_list")).toMatchObject({isError:true,content:[{text:"Error: window-list-query-failed"}]});
        expect(fixture.calls).toHaveLength(1);
    });
});
