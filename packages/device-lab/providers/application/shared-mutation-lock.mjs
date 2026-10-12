import { admitMutationLock, mutationBootProvesReboot } from '../domain/shared-mutation-lock.mjs';
/** Local ownership diagnoses blocking waits; it never authorizes file removal.
 * @type {Map<string,string>} */
const ownedClaims = new Map();

/** @template {readonly import('../ports/state-file-publication.mjs').PublicationDirectory[]} Fence
 * @param {import('../ports/shared-mutation-lock.mjs').SharedMutationLockPorts<Fence>} ports */
export function createSharedMutationLock(ports) {
    /** @type {import('../ports/shared-mutation-lock.mjs').LockProcessIdentity|null|undefined} */
    let ownIdentity;
    let ownRetryAt = 0;
    /** @type {Promise<import('../ports/shared-mutation-lock.mjs').LockProcessIdentity|null>|null} */
    let ownPending = null;
    /** @type {Map<string,{checkedAt:number,status:import('../ports/shared-mutation-lock.mjs').LockObservationStatus}>} */
    const cache = new Map();
    /** @type {Map<string,Promise<import('../ports/shared-mutation-lock.mjs').LockObservationStatus>>} */
    const pending = new Map();
    /** @type {Array<()=>void>} */
    const waiters = [];
    let active = 0;
    /** @template T @param {()=>Promise<T>} operation */
    async function slot(operation) {
        if (active < 4) active++;
        else await new Promise(resolve => waiters.push(() => resolve(undefined)));
        try { return await operation(); }
        finally { const next = waiters.shift(); if (next) next(); else active--; }
    }
    function currentIdentity() {
        if (ownIdentity) return ownIdentity;
        if (ports.platform() === 'win32') return null;
        if (ownIdentity === undefined || ownIdentity === null && ports.now() >= ownRetryAt) {
            ownIdentity = ports.identitySync(ports.pid());
            ownRetryAt = ownIdentity ? 0 : ports.now()+60000;
        }
        return ownIdentity;
    }
    async function currentIdentityAsync() {
        if (ownIdentity) return ownIdentity;
        if (ownIdentity === null && ports.now() < ownRetryAt) return null;
        if (!ownPending) ownPending = slot(() => ports.identityAsync(ports.pid())).then(identity => {
            ownIdentity = identity; ownRetryAt = identity ? 0 : ports.now()+60000; return identity;
        }).finally(() => { ownPending = null; });
        return ownPending;
    }
    /** @param {string} token @param {import('../ports/shared-mutation-lock.mjs').LockProcessIdentity|null} identity */
    function record(token,identity) { return {token,pid:ports.pid(),host:ports.host(),bootId:ports.boot(),createdAt:ports.timestamp(),processIdentityStatus:identity ? 'recorded' : 'unavailable',...(identity ? {processIdentity:identity} : {})}; }
    /** @param {string} file */
    function readLock(file) {
        try { const raw = ports.readRaw(file); return raw.kind === 'value' ? admitMutationLock(raw.value) : null; }
        catch { return null; }
    }
    /** @param {string} key @param {import('../ports/shared-mutation-lock.mjs').LockObservationStatus} status */
    function cacheStatus(key,status) {
        cache.delete(key); cache.set(key,{checkedAt:ports.now(),status});
        while (cache.size > 128) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
    }
    /** @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord & {processIdentity:import('../ports/shared-mutation-lock.mjs').LockProcessIdentity}} lock */
    function observation(lock) {
        const key = JSON.stringify([lock.pid,lock.processIdentity]);
        const cached = cache.get(key);
        if (cached && ports.now()-cached.checkedAt < 1000) return cached.status;
        const status = ports.observe(lock.processIdentity,lock.pid);
        cacheStatus(key,status); return status;
    }
    /** @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord & {processIdentity:import('../ports/shared-mutation-lock.mjs').LockProcessIdentity}} lock */
    async function observationAsync(lock) {
        const key = JSON.stringify([lock.pid,lock.processIdentity]);
        const cached = cache.get(key);
        if (cached && ports.now()-cached.checkedAt < (cached.status === 'unavailable' ? 30000 : 1000)) return cached.status;
        const existing = pending.get(key); if (existing) return existing;
        if (pending.size >= 128) { cacheStatus(key,'unavailable'); return 'unavailable'; }
        const promise = (async () => {
            const current = await slot(() => ports.identityAsync(lock.pid));
            const status = current ? (ports.matches(lock.processIdentity,current) ? 'match' : 'mismatch') : (ports.alive(lock.pid) ? 'unavailable' : 'exited');
            cacheStatus(key,status); return status;
        })().finally(() => { if (pending.get(key) === promise) pending.delete(key); });
        pending.set(key,promise); return promise;
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs @param {boolean} asynchronous */
    function staleFacts(file,lock,staleMs,asynchronous) {
        const modified = ports.mtime(file);
        const age = modified === null ? 0 : Math.max(0,ports.now()-modified);
        if (age < 100) return {stale:false};
        if (!lock) return {stale:age >= Math.min(staleMs,1000)};
        if (lock.host === ports.host() && lock.bootId && mutationBootProvesReboot(lock.bootId,ports.boot())) return {stale:true};
        if (lock.host === ports.host() && Number.isInteger(lock.pid)) {
            if (!ports.alive(lock.pid)) return {stale:true};
            if (lock.processIdentity) {
                if (!asynchronous && ports.platform() === 'win32') return {stale:false};
                return {probe:{...lock,processIdentity:lock.processIdentity}};
            }
            return {stale:false};
        }
        return {stale:false};
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs */
    function stale(file,lock,staleMs) { const facts = staleFacts(file,lock,staleMs,false); if (!facts.probe) return facts.stale; const status = observation(facts.probe); return status === 'mismatch' || status === 'exited'; }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs */
    async function staleAsync(file,lock,staleMs) { const facts = staleFacts(file,lock,staleMs,true); if (!facts.probe) return facts.stale; const status = await observationAsync(facts.probe); return status === 'mismatch' || status === 'exited'; }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockOptions} options */
    function waitFor(file,options) {
        const waitMs = options.waitMs ?? 5000;
        const clock = ports.variant === 'typescript' && options.waitBudget ? ports.monotonic : ports.now;
        const deadline = clock()+waitMs;
        const budgetDeadline = ports.variant === 'provider' && options.waitBudget ? ports.monotonic()+waitMs : 0;
        const remaining = () => ports.variant === 'provider' && options.waitBudget
            ? Math.min(budgetDeadline-ports.monotonic(),options.waitBudget.remaining())
            : Math.min(deadline-clock(),options.waitBudget?.remaining() ?? Infinity);
        function check() { if (options.waitBudget && remaining() <= 0) throw ports.timeout(file); }
        return {remaining,check,expired:() => clock() >= deadline};
    }
    /** @param {unknown[]} failures */
    function throwFailures(failures) {
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            const combined = new AggregateError(failures, 'Shared mutation lock operation and cleanup failed', {cause:failures[0]});
            const code = ports.errorCode(failures[0]);
            if (code) Object.assign(combined, {code});
            throw combined;
        }
    }
    /** @param {string} file @param {string} token @param {Fence} fence */
    function release(file,token,fence) {
        ports.check(fence);
        const released = ports.moveQualified(file,token,'release',fence);
        ports.check(fence);
        if (!released && readLock(file)?.token === token) {
            throw Object.assign(new Error(`Failed to release shared mutation lock: ${file}`), {code:'shared-mutation-lock-release-failed'});
        }
    }
    /** @param {number} descriptor @param {()=>string} value @param {unknown[]} failures */
    function publish(descriptor,value,failures) {
        try { ports.writeClaim(descriptor,value()); } catch (error) { failures.push(error); }
        try { ports.closeClaim(descriptor); } catch (error) { failures.push(error); }
        // The enclosing owned lifetime performs release and reports all failures.
        if (failures.length) throw failures[0];
    }
    /** @template T @param {string} file @param {()=>T} operation @param {import('../ports/shared-mutation-lock.mjs').MutationLockOptions} [options] */
    function withLock(file,operation,options = {}) {
        const wait = waitFor(file,options);
        wait.check();
        const token = ports.token(), fence = ports.capture(file);
        const key = ports.key(file);
        if (ownedClaims.has(key)) {
            throw Object.assign(new Error(`Synchronous wait on locally owned shared mutation lock: ${file}`), {code:'shared-mutation-lock-self-contention'});
        }
        const check = () => ports.check(fence);
        let claimed = false;
        /** @type {unknown[]} */
        const failures = [];
        /** @type {T|undefined} */
        let result;
        try {
            while (true) {
                wait.check();
                try {
                    check(); const fd = ports.openClaim(file);
                    claimed = true; ownedClaims.set(key,token);
                    publish(fd,() => JSON.stringify(record(token,currentIdentity())),failures);
                    check(); break;
                } catch (error) {
                    if (claimed || ports.errorCode(error) !== 'EEXIST') throw error;
                    if (ports.variant === 'typescript') wait.check();
                    const existing = readLock(file);
                    const reclaim = ports.variant !== 'typescript' || options.reclaimStale !== false;
                    if (reclaim && existing && stale(file,existing,options.staleMs ?? 30000) && ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    if (reclaim && !existing && stale(file,existing,options.staleMs ?? 30000) && ports.moveMalformed(file,token,fence)) continue;
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    wait.check(); ports.pauseSync(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
                }
            }
            check(); wait.check(); result = ports.runOwnerContext(key,token,operation);
        } catch (error) {
            if (!failures.length) failures.push(error);
        } finally {
            if (claimed) {
                try { release(file,token,fence); } catch (error) { failures.push(error); }
                finally { if (ownedClaims.get(key) === token) ownedClaims.delete(key); }
            }
        }
        throwFailures(failures);
        return /** @type {T} */ (result);
    }
    /** @template T @param {string} file @param {()=>T|Promise<T>} operation @param {import('../ports/shared-mutation-lock.mjs').MutationLockOptions} [options] */
    async function withLockAsync(file,operation,options = {}) {
        const wait = waitFor(file,options);
        wait.check();
        const token = ports.token(), fence = ports.capture(file);
        const key = ports.key(file);
        if (ports.ownerContext().some(owner => owner.key === key && ownedClaims.get(key) === owner.token)) {
            throw Object.assign(new Error(`Asynchronous wait on ancestor-owned shared mutation lock: ${file}`), {code:'shared-mutation-lock-self-contention'});
        }
        const check = () => ports.check(fence);
        const value = record(token,options.waitBudget ? currentIdentity() : await currentIdentityAsync());
        let claimed = false;
        /** @type {unknown[]} */
        const failures = [];
        /** @type {T|undefined} */
        let result;
        try {
            while (true) {
                wait.check();
                try {
                    check(); const fd = ports.openClaim(file);
                    claimed = true; ownedClaims.set(key,token);
                    publish(fd,() => JSON.stringify(value),failures);
                    check(); break;
                } catch (error) {
                    if (claimed || ports.errorCode(error) !== 'EEXIST') throw error;
                    if (ports.variant === 'typescript') wait.check();
                    const existing = readLock(file), staleMs = options.staleMs ?? 30000;
                    if (existing && (options.waitBudget ? stale(file,existing,staleMs) : await staleAsync(file,existing,staleMs)) && ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    if (!existing && (options.waitBudget ? stale(file,existing,staleMs) : await staleAsync(file,existing,staleMs)) && ports.moveMalformed(file,token,fence)) continue;
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    wait.check(); await ports.pause(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
                }
            }
            check(); wait.check(); result = await ports.runOwnerContext(key,token,operation);
        } catch (error) {
            if (!failures.length) failures.push(error);
        } finally {
            if (claimed) {
                try { release(file,token,fence); } catch (error) { failures.push(error); }
                finally { if (ownedClaims.get(key) === token) ownedClaims.delete(key); }
            }
        }
        throwFailures(failures);
        return /** @type {T} */ (result);
    }
    return {readLock,withLock,withLockAsync};
}
