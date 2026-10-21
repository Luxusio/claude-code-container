/** @typedef {{deviceId?:string,x?:number,y?:number,x1?:number,y1?:number,x2?:number,y2?:number,durationMs?:number,button?:string,key?:string,text?:string|null,direction?:string,amount?:number,handle?:string,helperTimeoutMs?:number,localPath?:string,remotePath?:string}} DesktopArguments */
/** @typedef {{kind:'completed',name:string,args:DesktopArguments,evidence:unknown}|{kind:'refused',message:string}|{kind:'failed',name:string,evidence:unknown}} DesktopResult */
/** @typedef {{kind:'failed',name:string,evidence:unknown,cleanup:{primary:DesktopResult|{kind:'thrown',error:unknown},error:unknown}}} DesktopCleanupFailure */
/** @typedef {DesktopResult|DesktopCleanupFailure|undefined} DesktopOutcome */
/** @param {unknown} x @param {unknown} y */
export function desktopPointValid(x, y) {
    return [x, y].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2147483647);
}
/** @param {DesktopArguments} args */
export function desktopDragValid(args) {
    return desktopPointValid(args.x1, args.y1) && desktopPointValid(args.x2, args.y2)
        && Number.isInteger(args.durationMs ?? 700) && (args.durationMs ?? 700) >= 1 && (args.durationMs ?? 700) <= 10000;
}

