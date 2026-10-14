import type { PublicationDirectory } from '../ports/state-file-publication.mjs';
import type { SharedMutationLockPorts,MutationLockOptions,MutationLockRecord } from '../ports/shared-mutation-lock.mjs';
export function createSharedMutationLock<Fence extends readonly PublicationDirectory[]>(ports:SharedMutationLockPorts<Fence>): {
    readObservation(file:string):{kind:'value';value:MutationLockRecord}|{kind:'missing'}|{kind:'malformed'}|{kind:'unavailable'};
    readLock(file:string):MutationLockRecord|null;
    withLock<T>(file:string,operation:()=>T,options?:MutationLockOptions):T;
    withLockAsync<T>(file:string,operation:()=>T|Promise<T>,options?:Omit<MutationLockOptions,'reclaimStale'>):Promise<T>;
};
