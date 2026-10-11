/** @param {unknown} ttlMs */
export function normalizedPhysicalTtl(ttlMs) {
    if (ttlMs === undefined || ttlMs === null) return 60*60*1000;
    return typeof ttlMs === 'number' && Number.isInteger(ttlMs) && ttlMs >= 30000 && ttlMs <= 24*60*60*1000 ? ttlMs : null;
}
/** @param {{ttlMs?:number}} lease */
export function physicalLeaseTtl(lease) { return typeof lease.ttlMs === 'number' && Number.isInteger(lease.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : 60*60*1000; }
/** @param {{ttlMs?:number,updatedAt?:string,expiresAt?:string}} lease */
export function physicalLeaseExpiry(lease) {
    if (typeof lease.expiresAt === 'string' && !Number.isNaN(Date.parse(lease.expiresAt))) return Date.parse(lease.expiresAt);
    const updated = typeof lease.updatedAt === 'string' && !Number.isNaN(Date.parse(lease.updatedAt)) ? Date.parse(lease.updatedAt) : 0;
    return updated + physicalLeaseTtl(lease);
}
/** @param {number} ttlMs @param {unknown} intervalMs */
export function physicalHeartbeatInterval(ttlMs,intervalMs) {
    return typeof intervalMs === 'number' && Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : Math.max(10000,Math.min(5*60*1000,Math.floor(ttlMs/3)));
}
/** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId */
export function physicalHeartbeatKey(backend,hardwareId,deviceId) { return `${backend}\0${hardwareId}\0${deviceId || ''}`; }
/** @param {unknown} left @param {unknown} right */
export function samePhysicalState(left,right) { return JSON.stringify(left) === JSON.stringify(right); }
/** @param {{backend:string,hardwareId:string,ownerId:string,deviceId?:string|null,claimId?:string,claimNonce?:string}} left @param {{backend:string,hardwareId:string,ownerId:string,deviceId?:string|null,claimId?:string,claimNonce?:string}} right */
export function samePhysicalLeaseIdentity(left,right) { return left.backend === right.backend && left.hardwareId === right.hardwareId && left.ownerId === right.ownerId && left.deviceId === right.deviceId && left.claimId === right.claimId && left.claimNonce === right.claimNonce; }
/** @template {{hardwareId:string}} Lease @param {Lease[]} leases @param {string} hardwareId @param {Lease|null} lease */
export function replacePhysicalAggregate(leases,hardwareId,lease) { const remaining = leases.filter(entry => entry.hardwareId !== hardwareId); return lease ? [...remaining,lease] : remaining; }
/** @template {{hardwareId:string,ownerId:string,deviceId?:string|null}} Lease @param {Lease[]} leases @param {string} owner @param {string} hardwareId @param {string|null|undefined} deviceId */
export function removePhysicalAggregate(leases,owner,hardwareId,deviceId) { return leases.filter(lease => lease.hardwareId !== hardwareId || lease.ownerId !== owner || Boolean(deviceId && lease.deviceId !== deviceId)); }
