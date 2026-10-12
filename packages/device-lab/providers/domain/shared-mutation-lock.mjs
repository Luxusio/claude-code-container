/** @typedef {{pid:number,startToken:string,commandHash:string}} LockProcessIdentity */
/** @typedef {{token:string,pid:number,host:string,bootId?:string,createdAt?:string,processIdentityStatus?:'recorded'|'unavailable',processIdentity?:LockProcessIdentity}} MutationLockRecord */
/** @param {unknown} value */
export function validMutationLockToken(value) { return typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value); }
/** @param {unknown} value @param {number} pid @returns {LockProcessIdentity|null} */
function admittedIdentity(value,pid) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('pid' in value) || value.pid !== pid || !('startToken' in value) || typeof value.startToken !== 'string'
        || value.startToken.length < 1 || value.startToken.length > 512
        || !('commandHash' in value) || typeof value.commandHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.commandHash)) return null;
    return {pid,startToken:value.startToken,commandHash:value.commandHash};
}
/** @param {unknown} value @returns {MutationLockRecord|null} */
export function admitMutationLock(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('token' in value) || typeof value.token !== 'string' || !validMutationLockToken(value.token)
        || !('pid' in value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0
        || !('host' in value) || typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 255) return null;
    const bootId = 'bootId' in value ? value.bootId : undefined;
    const createdAt = 'createdAt' in value ? value.createdAt : undefined;
    const status = 'processIdentityStatus' in value ? value.processIdentityStatus : undefined;
    const rawIdentity = 'processIdentity' in value ? value.processIdentity : undefined;
    if (bootId !== undefined && (typeof bootId !== 'string' || bootId.length > 512)
        || createdAt !== undefined && (typeof createdAt !== 'string' || createdAt.length > 64)
        || status !== undefined && status !== 'recorded' && status !== 'unavailable') return null;
    const identity = rawIdentity === undefined ? null : admittedIdentity(rawIdentity,value.pid);
    if (rawIdentity !== undefined && !identity || status === 'recorded' && !identity || identity && status === 'unavailable') return null;
    return {token:value.token,pid:value.pid,host:value.host,
        ...(typeof bootId === 'string' ? {bootId} : {}),...(typeof createdAt === 'string' ? {createdAt} : {}),
        ...(status === 'recorded' || status === 'unavailable' ? {processIdentityStatus:status} : {}),...(identity ? {processIdentity:identity} : {})};
}
/** Only native Linux boot UUIDs provide independent evidence of reboot.
 * Clock-derived estimates and unknown/legacy identities require process evidence.
 * @param {unknown} left @param {unknown} right */
export function mutationBootProvesReboot(left,right) {
    const authoritative = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    return typeof left === 'string' && typeof right === 'string'
        && authoritative.test(left) && authoritative.test(right)
        && left.toLowerCase() !== right.toLowerCase();
}
