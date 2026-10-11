import type { PublicationDirectory, PublicationStage, StateFilePublicationPorts } from '../ports/state-file-publication.mjs';
export function createStateFilePublication<Fence extends readonly PublicationDirectory[],Stage extends PublicationStage>(ports:StateFilePublicationPorts<Fence,Stage>): {
    write(file:string,value:string|ArrayBufferView):undefined;
    writeJson(file:string,value:unknown):undefined;
    copy(source:string,destination:string,options:{prefix?:string;limitBytes:number}):number;
    rename(source:string,destination:string,check?:()=>undefined):undefined;
};
