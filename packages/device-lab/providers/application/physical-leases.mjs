import { normalizedPhysicalTtl,physicalLeaseTtl,physicalLeaseExpiry,physicalHeartbeatInterval,physicalHeartbeatKey,samePhysicalState,samePhysicalLeaseIdentity,replacePhysicalAggregate,removePhysicalAggregate } from '../domain/physical-leases.mjs';
/** @typedef {import('../ports/physical-leases.mjs').PhysicalLease} Lease */
/** @typedef {import('../ports/physical-leases.mjs').PhysicalLeaseOptions} Options */
/** @typedef {import('../ports/physical-leases.mjs').PhysicalLeaseTransaction} Transaction */
/** @template Timer @param {import('../ports/physical-leases.mjs').PhysicalLeasePorts<Timer>} ports */
export function createPhysicalLeases(ports) {
    /** @type {Map<string,Timer>} */
    const timers = new Map();
    /** @param {Lease} lease */
    function expired(lease) { return physicalLeaseExpiry(lease) <= ports.now(); }
    /** @param {Lease} lease */
    function expiry(lease) { return typeof lease.expiresAt === 'string' && !Number.isNaN(Date.parse(lease.expiresAt)) ? lease.expiresAt : ports.iso(physicalLeaseExpiry(lease)); }
    /** @param {Lease} lease @param {number} [ttlMs] @param {string} [now] */
    function refreshed(lease,ttlMs = physicalLeaseTtl(lease),now = ports.timestamp()) {
        return {...lease,ttlMs,heartbeatAt:now,updatedAt:now,expiresAt:ports.iso(Date.parse(now)+ttlMs)};
    }
    /** @template T @param {string} backend @param {string} hardwareId @param {(state:Transaction)=>T} operation @param {{waitBudget?:{remaining():number}}} [options] */
    function transaction(backend,hardwareId,operation,options = {}) {
        return ports.withTransaction(backend,hardwareId,state => {
            if (options.waitBudget && !(options.waitBudget.remaining() > 0)) throw ports.timeout(backend,hardwareId);
            return operation(state);
        },options);
    }
    /** @param {Transaction} state @param {Lease|null} nextLease @param {Lease[]} nextLeases */
    function commit(state,nextLease,nextLeases) {
        const aggregateChanged = !samePhysicalState(state.leases,nextLeases);
        const lockChanged = !samePhysicalState(state.lease,nextLease);
        if (aggregateChanged) state.writeAggregate(nextLeases);
        if (!lockChanged) return;
        try {
            if (nextLease) state.writeLease(nextLease);
            else state.removeLease();
        } catch (error) {
            if (aggregateChanged) {
                try { state.writeAggregate(state.leases); }
                catch (rollbackError) { throw new AggregateError([error,rollbackError],'physical-lease-aggregate-rollback-failed'); }
            }
            throw error;
        }
    }
    /** @param {string} backend */
    function read(backend) { return ports.read(backend); }
    /** @param {string} backend */
    function prune(backend) {
        const owner = ports.owner(), leases = read(backend);
        /** @type {Array<Lease & {expired:true,expiresAt:string}>} */
        const pruned = [];
        if (leases.length > 0) ports.ensure(backend);
        for (const lease of leases) {
            if (lease.ownerId !== owner || !expired(lease)) continue;
            transaction(backend,lease.hardwareId,state => {
                const current = state.lease;
                if (current?.ownerId === owner && expired(current)) {
                    commit(state,null,replacePhysicalAggregate(state.leases,lease.hardwareId,null));
                    pruned.push({...current,expired:true,expiresAt:expiry(current)});
                } else if (!current) commit(state,current,replacePhysicalAggregate(state.leases,lease.hardwareId,null));
                else if (current.ownerId !== owner) commit(state,current,removePhysicalAggregate(state.leases,owner,lease.hardwareId,lease.deviceId));
                else commit(state,current,replacePhysicalAggregate(state.leases,lease.hardwareId,current));
            });
        }
        return pruned;
    }
    /** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId @param {Options} [options]
     * @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResult} */
    function claim(backend,hardwareId,deviceId,options = {}) {
        const owner = ports.owner(), ttlMs = normalizedPhysicalTtl(options.ttlMs);
        if (ttlMs === null) return {ok:false,error:'invalid-lease-ttl-ms'};
        const now = ports.timestamp();
        return transaction(backend,hardwareId,/** @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResult} */ state => {
            const existing = state.lease;
            if (existing && !expired(existing)) {
                if (existing.ownerId !== owner) return {ok:false,conflict:existing};
                if (deviceId && existing.deviceId && existing.deviceId !== deviceId) return {ok:false,error:'physical-lease-device-mismatch',conflict:existing};
                if (options.claimNonce && existing.claimNonce !== options.claimNonce) return {ok:false,error:'physical-lease-operation-conflict',conflict:existing};
                const lease = refreshed(existing,ttlMs,now);
                commit(state,lease,replacePhysicalAggregate(state.leases,hardwareId,lease));
                return {ok:true,lease,reused:true,heartbeat:true};
            }
            const lease = refreshed({backend,hardwareId,ownerId:owner,deviceId,claimId:ports.claimId(),...(options.claimNonce ? {claimNonce:options.claimNonce} : {}),claimedAt:now},ttlMs,now);
            commit(state,lease,replacePhysicalAggregate(state.leases,hardwareId,lease));
            return {ok:true,lease};
        });
    }
    /** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId @param {Options} [options]
     * @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResult} */
    function heartbeat(backend,hardwareId,deviceId,options = {}) {
        const owner = ports.owner(), ttlMs = normalizedPhysicalTtl(options.ttlMs);
        if (ttlMs === null) return {ok:false,error:'invalid-lease-ttl-ms'};
        return transaction(backend,hardwareId,/** @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResult} */ state => {
            const existing = state.lease;
            if (!existing) return {ok:false,error:'physical-lease-not-found'};
            if (existing.ownerId !== owner) {
                if (expired(existing)) { commit(state,null,replacePhysicalAggregate(state.leases,hardwareId,null)); return {ok:false,error:'physical-lease-expired',pruned:true,lease:existing}; }
                return {ok:false,conflict:existing};
            }
            if (deviceId && existing.deviceId && existing.deviceId !== deviceId) return {ok:false,error:'physical-lease-device-mismatch',lease:existing};
            if (options.claimId && existing.claimId !== options.claimId) return {ok:false,error:'physical-lease-claim-mismatch',lease:existing};
            if (options.claimNonce && existing.claimNonce !== options.claimNonce) return {ok:false,error:'physical-lease-operation-mismatch',lease:existing};
            if (expired(existing)) { commit(state,null,replacePhysicalAggregate(state.leases,hardwareId,null)); return {ok:false,error:'physical-lease-expired',pruned:true,lease:existing}; }
            const lease = refreshed(existing,ttlMs);
            const tracks = state.leases.some(candidate => samePhysicalLeaseIdentity(candidate,existing));
            commit(state,lease,tracks ? replacePhysicalAggregate(state.leases,hardwareId,lease) : state.leases);
            return {ok:true,lease,heartbeat:true};
        },{waitBudget:options.waitBudget});
    }
    /** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId */
    function stopHeartbeat(backend,hardwareId,deviceId) {
        const key = physicalHeartbeatKey(backend,hardwareId,deviceId), timer = timers.get(key);
        if (!timer) return false;
        ports.clear(timer); timers.delete(key); return true;
    }
    /** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId @param {Options} [options]
     * @returns {{ok:false,error:string}|{ok:true,heartbeatManaged:true,intervalMs:number,ttlMs:number}} */
    function startHeartbeat(backend,hardwareId,deviceId,options = {}) {
        const ttlMs = normalizedPhysicalTtl(options.ttlMs);
        if (ttlMs === null) return {ok:false,error:'invalid-lease-ttl-ms'};
        const key = physicalHeartbeatKey(backend,hardwareId,deviceId);
        stopHeartbeat(backend,hardwareId,deviceId);
        const allocated = ports.schedule(() => {
            const result = heartbeat(backend,hardwareId,deviceId,{ttlMs,claimId:options.claimId,claimNonce:options.claimNonce});
            if (!result.ok) stopHeartbeat(backend,hardwareId,deviceId);
            return undefined;
        },physicalHeartbeatInterval(ttlMs,options.intervalMs));
        ports.unref(allocated.handle); timers.set(key,allocated.handle);
        return {ok:true,heartbeatManaged:true,intervalMs:physicalHeartbeatInterval(ttlMs,options.intervalMs),ttlMs};
    }
    /** @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId @param {Options} [options] */
    function release(backend,hardwareId,deviceId,options = {}) {
        const owner = ports.owner();
        const released = transaction(backend,hardwareId,state => {
            const existing = state.lease;
            if (existing?.ownerId !== owner || deviceId && existing.deviceId !== deviceId) return false;
            if (options.claimId && existing.claimId !== options.claimId) return false;
            if (options.claimNonce && existing.claimNonce !== options.claimNonce) return false;
            commit(state,null,replacePhysicalAggregate(state.leases,hardwareId,null)); return true;
        });
        if (released) stopHeartbeat(backend,hardwareId,deviceId);
        return released;
    }
    /** @param {string} backend @param {Partial<Lease>|null|undefined} expected @param {Options} [options]
     * @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResidueResult} */
    function releaseResidue(backend,expected,options = {}) {
        const owner = ports.owner(), hardwareId = expected?.hardwareId, deviceId = expected?.deviceId;
        if (!expected || typeof hardwareId !== 'string' || !hardwareId || typeof deviceId !== 'string' || !deviceId) return {ok:false,error:'physical-lease-residue-identity-required'};
        /** @param {Lease} lease */
        const matchesExpected = lease => lease.ownerId === owner && lease.hardwareId === hardwareId && lease.deviceId === deviceId && lease.claimId === expected.claimId && lease.claimNonce === expected.claimNonce;
        const released = transaction(backend,hardwareId,/** @returns {import('../ports/physical-leases.mjs').PhysicalLeaseResidueResult} */ state => {
            const hardware = state.leases.filter(candidate => candidate.hardwareId === hardwareId), matches = state.leases.filter(matchesExpected);
            if (matches.length === 0) return {ok:false,error:'physical-lease-residue-not-found'};
            if (matches.length !== 1 || hardware.length !== 1) return {ok:false,error:'physical-lease-residue-ambiguous'};
            if (options.requireLockAbsent === true && state.lease) return {ok:false,error:'physical-lease-residue-authoritative-lock-present',lease:state.lease};
            if (options.requireExpired === true && !expired(matches[0])) return {ok:false,error:'physical-lease-residue-active',lease:matches[0]};
            if (state.lease && !matchesExpected(state.lease)) return {ok:false,error:'physical-lease-residue-lock-conflict',lease:state.lease};
            commit(state,null,state.leases.filter(candidate => candidate !== matches[0]));
            return {ok:true,lease:matches[0],authoritativeLockRemoved:Boolean(state.lease)};
        });
        if (released.ok) stopHeartbeat(backend,hardwareId,deviceId);
        return released;
    }
    /** @template {import('../ports/physical-leases.mjs').PhysicalLeaseMutation} Mutation
     * @param {string} backend @param {string} hardwareId @param {string|null|undefined} deviceId @param {Options} options
     * @param {(lease:Lease)=>Mutation|null|undefined} mutation
     * @returns {import('../ports/physical-leases.mjs').PhysicalLeaseMutationResult<Mutation>} */
    function releaseWithMutation(backend,hardwareId,deviceId,options = {},mutation) {
        if (typeof mutation !== 'function') throw new TypeError('Physical lease release mutation requires a callback');
        const owner = ports.owner();
        const released = transaction(backend,hardwareId,/** @returns {import('../ports/physical-leases.mjs').PhysicalLeaseMutationResult<Mutation>} */ state => {
            const existing = state.lease;
            if (!existing) return {ok:false,error:'physical-lease-not-found'};
            if (existing.ownerId !== owner) return {ok:false,error:'physical-lease-owner-mismatch',lease:existing};
            if (deviceId && existing.deviceId !== deviceId) return {ok:false,error:'physical-lease-device-mismatch',lease:existing};
            if (options.claimId && existing.claimId !== options.claimId) return {ok:false,error:'physical-lease-claim-mismatch',lease:existing};
            if (options.claimNonce && existing.claimNonce !== options.claimNonce) return {ok:false,error:'physical-lease-operation-mismatch',lease:existing};
            const mutated = mutation(existing);
            if (!mutated?.ok) return {ok:false,error:'physical-lease-release-mutation-rejected',mutation:mutated};
            try { commit(state,null,replacePhysicalAggregate(state.leases,hardwareId,null)); }
            catch (error) {
                if (typeof mutated.rollback === 'function') {
                    try { mutated.rollback(); } catch (rollbackError) { throw new AggregateError([error,rollbackError],'physical-lease-release-mutation-rollback-failed'); }
                }
                throw error;
            }
            return {ok:true,lease:existing,mutation:mutated};
        });
        if (released.ok) stopHeartbeat(backend,hardwareId,deviceId);
        return released;
    }
    return {read,prune,claim,heartbeat,startHeartbeat,stopHeartbeat,release,releaseResidue,releaseWithMutation};
}
