export interface PhysicalLease {
    backend:string;hardwareId:string;ownerId:string;deviceId?:string|null;
    claimId?:string;claimNonce?:string;claimedAt?:string;ttlMs?:number;
    heartbeatAt?:string;updatedAt?:string;expiresAt?:string;
}
export interface PhysicalLeaseOptions {
    ttlMs?:unknown;intervalMs?:unknown;claimId?:string;claimNonce?:string;
    waitBudget?:{remaining():number};requireLockAbsent?:boolean;requireExpired?:boolean;
}
export interface PhysicalLeaseTransaction {
    lease:PhysicalLease|null;leases:PhysicalLease[];
    writeAggregate(leases:PhysicalLease[]):undefined;
    writeLease(lease:PhysicalLease):undefined;
    removeLease():undefined;
}
export interface PhysicalLeasePorts<Timer> {
    owner():string;now():number;timestamp():string;iso(milliseconds:number):string;claimId():string;
    read(backend:string):PhysicalLease[];ensure(backend:string):undefined;
    withTransaction<T>(backend:string,hardwareId:string,operation:(state:PhysicalLeaseTransaction)=>T,options:{waitBudget?:{remaining():number}}):T;
    timeout(backend:string,hardwareId:string):Error;
    schedule(operation:()=>undefined,intervalMs:number):{handle:Timer};unref(timer:Timer):undefined;clear(timer:Timer):undefined;
}
export type PhysicalLeaseResult = {ok:true;lease:PhysicalLease;reused?:true;heartbeat?:true}|{ok:false;error?:string;conflict?:PhysicalLease;lease?:PhysicalLease;pruned?:true};
export type PhysicalLeaseResidueResult = {ok:true;lease:PhysicalLease;authoritativeLockRemoved:boolean}|{ok:false;error:string;lease?:PhysicalLease};
export interface PhysicalLeaseMutation { ok:boolean;rollback?:()=>undefined }
export type PhysicalLeaseMutationResult<Mutation extends PhysicalLeaseMutation> = {ok:true;lease:PhysicalLease;mutation:Mutation}|{ok:false;error:string;lease?:PhysicalLease;mutation?:Mutation|null};
