export interface PublicationDirectory { path:string }
export interface PublicationStage { path:string }
export interface CopyStream {
    read():number;
    write(offset:number,length:number):number;
    permissions():undefined;
    close():undefined;
}
export interface CopyResources { openOutput():CopyStream }
export interface StateFilePublicationPorts<Fence extends readonly PublicationDirectory[], Stage extends PublicationStage> {
    variant:'typescript'|'provider';
    capture(file:string):Fence;
    check(fence:Fence):undefined;
    basename(file:string):string;
    stage(file:string):Stage;
    entries(file:string,fence:Fence):string[]|null;
    temporaryFacts(file:string,entry:string,fence:Fence):{ordinary:boolean;linked:boolean;mtimeMs:number}|null;
    removeTemporary(file:string,entry:string,fence:Fence):undefined;
    alive(pid:number):boolean;
    writeStage(stage:Stage,value:string|ArrayBufferView):undefined;
    renameAttempt(source:string,destination:string):undefined;
    removeStage(stage:Stage):undefined;
    chmodTarget(file:string):undefined;
    withSource(source:string,prefix:string,limitBytes:number,operation:(resources:CopyResources)=>number,stage:Stage,fence:Fence):number|null;
    closeOutput(stage:Stage):undefined;
    now():number;
    pauseSync(ms:number):undefined;
    errorCode(error:unknown):string|undefined;
    stateError(code:string):Error;
}
