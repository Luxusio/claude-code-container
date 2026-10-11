import type { PhysicalLease,PhysicalLeaseOptions,PhysicalLeasePorts,PhysicalLeaseResult,PhysicalLeaseResidueResult,PhysicalLeaseMutation,PhysicalLeaseMutationResult } from '../ports/physical-leases.mjs';
export function createPhysicalLeases<Timer>(ports:PhysicalLeasePorts<Timer>): {
    read(backend:string):PhysicalLease[];
    prune(backend:string):Array<PhysicalLease & {expired:true;expiresAt:string}>;
    claim(backend:string,hardwareId:string,deviceId:string|null|undefined,options?:PhysicalLeaseOptions):PhysicalLeaseResult;
    heartbeat(backend:string,hardwareId:string,deviceId:string|null|undefined,options?:PhysicalLeaseOptions):PhysicalLeaseResult;
    startHeartbeat(backend:string,hardwareId:string,deviceId:string|null|undefined,options?:PhysicalLeaseOptions):{ok:false;error:string}|{ok:true;heartbeatManaged:true;intervalMs:number;ttlMs:number};
    stopHeartbeat(backend:string,hardwareId:string,deviceId:string|null|undefined):boolean;
    release(backend:string,hardwareId:string,deviceId:string|null|undefined,options?:PhysicalLeaseOptions):boolean;
    releaseResidue(backend:string,expected:Partial<PhysicalLease>|null|undefined,options?:PhysicalLeaseOptions):PhysicalLeaseResidueResult;
    releaseWithMutation<Mutation extends PhysicalLeaseMutation>(backend:string,hardwareId:string,deviceId:string|null|undefined,options:PhysicalLeaseOptions|undefined,mutation:(lease:PhysicalLease)=>Mutation|null|undefined):PhysicalLeaseMutationResult<Mutation>;
};
