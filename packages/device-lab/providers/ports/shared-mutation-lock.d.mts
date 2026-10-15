import type { PublicationDirectory } from './state-file-publication.mjs';
export interface LockProcessIdentity { pid:number;startToken:string;commandHash:string }
export type LockPublicationTimes = {kind:'known';processStartedAtMs:number;claimCreatedAtMs:number}|{kind:'unavailable'};
export type LockObservationStatus = 'match'|'mismatch'|'exited'|'unavailable';
export interface MutationLockRecord { token:string;pid:number;host:string;bootId?:string;createdAt?:string;processIdentityStatus?:'recorded'|'unavailable';processIdentity?:LockProcessIdentity }
export interface MutationLockOptions { reclaimStale?:boolean;waitMs?:number;staleMs?:number;waitBudget?:{remaining():number} }
export type LockReadObservation = {kind:'value';value:unknown}|{kind:'missing'}|{kind:'malformed'}|{kind:'unavailable'};
export interface SharedMutationLockPorts<Fence extends readonly PublicationDirectory[]> {
    variant:'typescript'|'provider';
    key(file:string):string;
    ownerContext():readonly {key:string;token:string}[];
    runOwnerContext<T>(key:string,token:string,operation:()=>T):T;
    capture(file:string):Fence;check(fence:Fence):undefined;
    token():string;pid():number;host():string;boot():string;platform():string;timestamp():string;
    now():number;monotonic():number;pauseSync(ms:number):undefined;
    /** Aborting cancels the pending wait and rejects its promise. */
    pause(ms:number,signal?:AbortSignal):Promise<undefined>;
    openClaim(file:string):number;writeClaim(descriptor:number,text:string):undefined;closeClaim(descriptor:number):undefined;
    readRaw(file:string):LockReadObservation;
    mtime(file:string):number|null;alive(pid:number):boolean;
    identitySync(pid:number):LockProcessIdentity|null;
    identityAsync(pid:number):Promise<LockProcessIdentity|null>;
    observe(identity:LockProcessIdentity,pid:number):LockObservationStatus;
    matches(expected:LockProcessIdentity,current:LockProcessIdentity):boolean;
    moveQualified(file:string,token:string,suffix:'stale'|'release',fence:Fence):boolean;
    moveMalformed(file:string,token:string,fence:Fence):boolean;
    archives(file:string,fence:Fence):string[];
    removeArchive(file:string,archive:string,token:string|null,fence:Fence):boolean;
    errorCode(error:unknown):string|undefined;timeout(file:string):Error;
}
