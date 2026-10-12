import type { PublicationDirectory } from './state-file-publication.mjs';
export interface LockProcessIdentity { pid:number;startToken:string;commandHash:string }
export type LockObservationStatus = 'match'|'mismatch'|'exited'|'unavailable';
export interface MutationLockRecord { token:string;pid:number;host:string;bootId?:string;createdAt?:string;processIdentityStatus?:'recorded'|'unavailable';processIdentity?:LockProcessIdentity }
export interface MutationLockOptions { reclaimStale?:boolean;waitMs?:number;staleMs?:number;waitBudget?:{remaining():number} }
export interface SharedMutationLockPorts<Fence extends readonly PublicationDirectory[]> {
    variant:'typescript'|'provider';
    key(file:string):string;
    capture(file:string):Fence;check(fence:Fence):undefined;
    token():string;pid():number;host():string;boot():string;platform():string;timestamp():string;
    now():number;monotonic():number;pauseSync(ms:number):undefined;pause(ms:number):Promise<undefined>;
    openClaim(file:string):number;writeClaim(descriptor:number,text:string):undefined;closeClaim(descriptor:number):undefined;
    readRaw(file:string):{kind:'value';value:unknown}|{kind:'missing'};
    mtime(file:string):number|null;alive(pid:number):boolean;
    identitySync(pid:number):LockProcessIdentity|null;
    identityAsync(pid:number):Promise<LockProcessIdentity|null>;
    observe(identity:LockProcessIdentity,pid:number):LockObservationStatus;
    matches(expected:LockProcessIdentity,current:LockProcessIdentity):boolean;
    moveQualified(file:string,token:string,suffix:'stale'|'release',fence:Fence):boolean;
    moveMalformed(file:string,token:string,fence:Fence):boolean;
    errorCode(error:unknown):string|undefined;timeout(file:string):Error;
}
