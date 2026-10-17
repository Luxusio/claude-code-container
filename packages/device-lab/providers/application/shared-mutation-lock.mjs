import { admitMutationLock, mutationBootProvesReboot } from '../domain/shared-mutation-lock.mjs';
/** Local ownership diagnoses blocking waits; it never authorizes file removal.
 * @type {Map<string,Set<string>>} */
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
    /** @param {boolean} allowWindowsProbe */
    function currentIdentity(allowWindowsProbe) {
        if (ownIdentity) return ownIdentity;
        if (ports.platform() === 'win32' && !allowWindowsProbe) return null;
        if (ownIdentity === undefined || ownIdentity === null && ports.monotonic() >= ownRetryAt) {
            ownIdentity = ports.identitySync(ports.pid());
            ownRetryAt = ownIdentity ? 0 : ports.monotonic()+60000;
        }
        return ownIdentity;
    }
    /** @param {ReturnType<typeof waitFor>|null} [wait] */
    async function currentIdentityAsync(wait = null) {
        wait?.check();
        if (ownIdentity) return ownIdentity;
        if (ownIdentity === null && ports.monotonic() < ownRetryAt) return null;
        if (!ownPending && wait && active >= 4) return null;
        if (!ownPending) ownPending = slot(() => { wait?.check(); return ports.identityAsync(ports.pid()); }).then(identity => {
            ownIdentity = identity ?? ownIdentity ?? null;
            ownRetryAt = ownIdentity ? 0 : ports.monotonic()+60000; return ownIdentity;
        }).finally(() => { ownPending = null; });
        return ownPending;
    }
    /** @param {string} token @param {import('../ports/shared-mutation-lock.mjs').LockProcessIdentity|null} identity */
    function record(token,identity) { return {token,pid:ports.pid(),host:ports.host(),bootId:ports.boot(),createdAt:ports.timestamp(),processIdentityStatus:identity ? 'recorded' : 'unavailable',...(identity ? {processIdentity:identity} : {})}; }
    /** @param {string} file
     * @returns {{kind:'value',value:import('../ports/shared-mutation-lock.mjs').MutationLockRecord}|{kind:'missing'}|{kind:'malformed'}|{kind:'unavailable'}} */
    function readObservation(file) {
        try {
            const raw = ports.readRaw(file);
            if (raw.kind !== 'value') return raw;
            const lock = admitMutationLock(raw.value);
            return lock ? {kind:'value',value:lock} : {kind:'malformed'};
        } catch { return {kind:'unavailable'}; }
    }
    /** @param {string} file */
    function readLock(file) {
        const observed = readObservation(file);
        return observed.kind === 'value' ? observed.value : null;
    }
    /** @param {string} key @param {string} token */
    function own(key,token) {
        let tokens = ownedClaims.get(key);
        if (!tokens) { tokens = new Set(); ownedClaims.set(key,tokens); }
        tokens.add(token);
    }
    /** @param {string} key @param {string} token */
    function disown(key,token) {
        const tokens = ownedClaims.get(key);
        if (tokens) { tokens.delete(token); if (!tokens.size) ownedClaims.delete(key); }
    }
    /** @param {string} key @param {import('../ports/shared-mutation-lock.mjs').LockObservationStatus} status */
    function cacheStatus(key,status) {
        cache.delete(key); cache.set(key,{checkedAt:ports.monotonic(),status});
        while (cache.size > 128) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
    }
    /** @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord & {processIdentity:import('../ports/shared-mutation-lock.mjs').LockProcessIdentity}} lock */
    function observation(lock) {
        const key = JSON.stringify([lock.pid,lock.processIdentity]);
        const cached = cache.get(key);
        if (cached && ports.monotonic()-cached.checkedAt < 1000) return cached.status;
        const status = ports.observe(lock.processIdentity,lock.pid);
        cacheStatus(key,status); return status;
    }
    /** @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord & {processIdentity:import('../ports/shared-mutation-lock.mjs').LockProcessIdentity}} lock @param {ReturnType<typeof waitFor>|null} [wait] */
    async function observationAsync(lock,wait = null) {
        wait?.check();
        const key = JSON.stringify([lock.pid,lock.processIdentity]);
        const cached = cache.get(key);
        if (cached && ports.monotonic()-cached.checkedAt < (cached.status === 'unavailable' ? 30000 : 1000)) return cached.status;
        const existing = pending.get(key); if (existing) return existing;
        // A timed caller must not leave a new native probe queued after expiry.
        if (wait && active >= 4) return 'unavailable';
        if (pending.size >= 128) { cacheStatus(key,'unavailable'); return 'unavailable'; }
        const promise = (async () => {
            const current = await slot(() => { wait?.check(); return ports.identityAsync(lock.pid); });
            const status = current ? (ports.matches(lock.processIdentity,current) ? 'match' : 'mismatch') : (ports.alive(lock.pid) ? 'unavailable' : 'exited');
            cacheStatus(key,status); return status;
        })().finally(() => { if (pending.get(key) === promise) pending.delete(key); });
        pending.set(key,promise); return promise;
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs @param {boolean} asynchronous */
    function staleFacts(file,lock,staleMs,asynchronous) {
        if (!lock) {
            const modified = ports.mtime(file);
            const age = modified === null ? 0 : Math.max(0,ports.now()-modified);
            return {stale:age >= 100 && age >= Math.min(staleMs,1000)};
        }
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
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs @param {ReturnType<typeof waitFor>|null} [wait] */
    function stale(file,lock,staleMs,wait = null) {
        wait?.check();
        const facts = staleFacts(file,lock,staleMs,false);
        wait?.check();
        if (!facts.probe) return facts.stale;
        const status = observation(facts.probe);
        wait?.check();
        return status === 'mismatch' || status === 'exited';
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs @param {ReturnType<typeof waitFor>|null} [wait] */
    async function staleAsync(file,lock,staleMs,wait = null) {
        wait?.check();
        const facts = staleFacts(file,lock,staleMs,true);
        wait?.check();
        if (!facts.probe) return facts.stale;
        const status = await observationAsync(facts.probe,wait);
        return status === 'mismatch' || status === 'exited';
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockOptions} options */
    function waitFor(file,options) {
        const waitMs = options.waitMs ?? 5000;
        let deadline = ports.monotonic()+waitMs;
        const timed = waitMs > 0 || !!options.waitBudget;
        function remaining() {
            const now = ports.monotonic();
            if (options.waitBudget) deadline = Math.min(deadline,now+options.waitBudget.remaining());
            return deadline-now;
        }
        function check() { if (timed && remaining() <= 0) throw ports.timeout(file); }
        function pauseMs() {
            const milliseconds = Math.min(10,remaining());
            if (!(milliseconds > 0)) throw ports.timeout(file);
            return milliseconds;
        }
        return {remaining,check,pauseMs,timed,expired:() => remaining() <= 0};
    }
    /** @template T @param {ReturnType<typeof waitFor>} wait @param {()=>Promise<T>} observe @returns {Promise<T>} */
    async function waitForObservation(wait,observe) {
        wait.check();
        const cancellation = new AbortController();
        /** @returns {Promise<never>} */
        async function expire() {
            while (true) {
                await ports.pause(Math.max(1,Math.min(2147483647,Math.ceil(wait.remaining()))),cancellation.signal);
                wait.check();
            }
        }
        // Observation is read-only and may settle after this caller has expired.
        try {
            const result = await Promise.race([observe(),expire()]); wait.check(); return result;
        } finally { cancellation.abort(); }
    }
    /** @param {unknown[]} failures @param {string} [codeOverride] */
    function throwFailures(failures,codeOverride) {
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            const combined = new AggregateError(failures, 'Shared mutation lock operation and cleanup failed', {cause:failures[0]});
            const code = codeOverride ?? ports.errorCode(failures[0]);
            if (code) Object.assign(combined, {code});
            throw combined;
        }
    }
    /** @param {string} file @param {string} token @param {Fence} fence @param {unknown} [cause] */
    function releaseFailure(file,token,fence,cause) {
        ports.check(fence);
        if (readLock(file)?.token === token) {
            throw Object.assign(new Error(`Failed to release shared mutation lock: ${file}`, cause === undefined ? undefined : {cause}), {code:'shared-mutation-lock-release-failed'});
        }
    }
    /** @param {string} file @param {string} token @param {Fence} fence */
    function releaseArchives(file,token,fence) {
        /** @type {unknown[]} */
        const failures = [];
        for (const archive of ports.archives(file,fence)) {
            try {
                ports.check(fence);
                if (readLock(archive)?.token !== token) continue;
                try { ports.removeArchive(file,archive,token,fence); }
                catch (error) { releaseFailure(archive,token,fence,error); throw error; }
                releaseFailure(archive,token,fence);
            } catch (error) { failures.push(error); }
        }
        throwFailures(failures);
    }
    /** @param {string} file @param {string} token @param {Fence} fence */
    function release(file,token,fence) {
        /** @type {unknown[]} */
        const failures = [];
        try { ports.check(fence); ports.moveQualified(file,token,'release',fence); }
        catch (error) { failures.push(error); }
        try { releaseArchives(file,token,fence); } catch (error) { failures.push(error); }
        try { releaseFailure(file,token,fence); } catch (error) { failures.push(error); }
        throwFailures(failures,failures.some(error => ports.errorCode(error) === 'shared-mutation-lock-release-failed') ? 'shared-mutation-lock-release-failed' : undefined);
    }
    /** @param {string} file @param {string} token @param {number} staleMs @param {boolean} reclaim @param {Fence} fence @param {ReturnType<typeof waitFor>} wait */
    function admitArchives(file,token,staleMs,reclaim,fence,wait) {
        wait.check();
        for (const archive of ports.archives(file,fence)) {
            wait.check();
            const observed = readObservation(archive);
            if (observed.kind === 'missing' || observed.kind === 'value' && observed.value.token === token) continue;
            if (observed.kind === 'unavailable' || !reclaim) return false;
            const lock = observed.kind === 'value' ? observed.value : null;
            if (!stale(archive,lock,staleMs,wait)) return false;
            wait.check();
            if (!ports.removeArchive(file,archive,lock?.token ?? null,fence) && readObservation(archive).kind !== 'missing') return false;
        }
        ports.check(fence);
        return true;
    }
    /** @param {string} file @param {string} token @param {number} staleMs @param {ReturnType<typeof waitFor>|null} wait @param {Fence} fence */
    async function admitArchivesAsync(file,token,staleMs,wait,fence) {
        wait?.check();
        for (const archive of ports.archives(file,fence)) {
            wait?.check();
            const observed = readObservation(archive);
            if (observed.kind === 'missing' || observed.kind === 'value' && observed.value.token === token) continue;
            if (observed.kind === 'unavailable') return false;
            const lock = observed.kind === 'value' ? observed.value : null;
            if (!(wait ? await waitForObservation(wait,() => staleAsync(archive,lock,staleMs,wait)) : await staleAsync(archive,lock,staleMs))) return false;
            if (wait) {
                ports.check(fence); wait.check();
                const current = readObservation(archive);
                if (lock ? current.kind !== 'value' || current.value.token !== lock.token : current.kind !== 'malformed') return false;
                if (readLock(file)?.token !== token) return false;
                ports.check(fence); wait.check();
            }
            if (!ports.removeArchive(file,archive,lock?.token ?? null,fence) && readObservation(archive).kind !== 'missing') return false;
        }
        ports.check(fence);
        return true;
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
            wait.check();
            const value = record(token,currentIdentity(!options.waitBudget));
            while (true) {
                wait.check();
                if (!claimed) try {
                    check(); wait.check(); const fd = ports.openClaim(file);
                    claimed = true; own(key,token);
                    publish(fd,() => JSON.stringify(value),failures);
                    check();
                } catch (error) {
                    if (claimed || ports.errorCode(error) !== 'EEXIST') throw error;
                    wait.check();
                    const observed = readObservation(file);
                    const existing = observed.kind === 'value' ? observed.value : null;
                    const reclaim = ports.variant !== 'typescript' || options.reclaimStale !== false;
                    if (reclaim && existing && stale(file,existing,options.staleMs ?? 30000,wait)) {
                        wait.check();
                        if (ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    }
                    if (reclaim && observed.kind === 'malformed' && stale(file,null,options.staleMs ?? 30000,wait)) {
                        wait.check();
                        if (ports.moveMalformed(file,token,fence)) continue;
                    }
                    if (wait.expired()) throw ports.timeout(file);
                    wait.check(); ports.pauseSync(wait.pauseMs());
                    continue;
                }
                check();
                const admitted = admitArchives(file,token,options.staleMs ?? 30000,ports.variant !== 'typescript' || options.reclaimStale !== false,fence,wait);
                const current = readObservation(file);
                check();
                if (current.kind === 'value' && current.value.token === token && admitted) break;
                if (current.kind !== 'unavailable' && !(current.kind === 'value' && current.value.token === token)) {
                    releaseArchives(file,token,fence);
                    disown(key,token); claimed = false;
                    if (wait.expired()) throw ports.timeout(file);
                    continue;
                }
                if (wait.expired()) throw ports.timeout(file);
                wait.check(); ports.pauseSync(wait.pauseMs());
            }
            check(); wait.check(); result = ports.runOwnerContext(key,token,operation);
        } catch (error) {
            if (!failures.length) failures.push(error);
        } finally {
            if (claimed) {
                try { release(file,token,fence); } catch (error) { failures.push(error); }
                finally { disown(key,token); }
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
        if (ports.ownerContext().some(owner => owner.key === key && ownedClaims.get(key)?.has(owner.token))) {
            throw Object.assign(new Error(`Asynchronous wait on ancestor-owned shared mutation lock: ${file}`), {code:'shared-mutation-lock-self-contention'});
        }
        const check = () => ports.check(fence);
        wait.check();
        const value = record(token,options.waitBudget ? currentIdentity(false)
            : wait.timed ? await waitForObservation(wait,() => currentIdentityAsync(wait)) : await currentIdentityAsync());
        let claimed = false;
        /** @type {unknown[]} */
        const failures = [];
        /** @type {T|undefined} */
        let result;
        try {
            while (true) {
                wait.check();
                if (!claimed) try {
                    check(); wait.check(); const fd = ports.openClaim(file);
                    claimed = true; own(key,token);
                    publish(fd,() => JSON.stringify(value),failures);
                    check();
                } catch (error) {
                    if (claimed || ports.errorCode(error) !== 'EEXIST') throw error;
                    wait.check();
                    const observed = readObservation(file), staleMs = options.staleMs ?? 30000;
                    const existing = observed.kind === 'value' ? observed.value : null;
                    if (existing && (wait.timed ? await waitForObservation(wait,() => staleAsync(file,existing,staleMs,wait)) : await staleAsync(file,existing,staleMs))) {
                        if (wait.timed) {
                            check(); wait.check();
                            if (readLock(file)?.token !== existing.token) continue;
                            check(); wait.check();
                        }
                        if (ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    }
                    if (observed.kind === 'malformed' && (wait.timed ? await waitForObservation(wait,() => staleAsync(file,null,staleMs,wait)) : await staleAsync(file,null,staleMs))) {
                        if (wait.timed) {
                            check(); wait.check();
                            if (readObservation(file).kind !== 'malformed') continue;
                            check(); wait.check();
                        }
                        if (ports.moveMalformed(file,token,fence)) continue;
                    }
                    if (wait.expired()) throw ports.timeout(file);
                    wait.check(); await ports.pause(wait.pauseMs());
                    continue;
                }
                check();
                const admitted = await admitArchivesAsync(file,token,options.staleMs ?? 30000,wait.timed ? wait : null,fence);
                const current = readObservation(file);
                check(); wait.check();
                if (current.kind === 'value' && current.value.token === token && admitted) break;
                if (current.kind !== 'unavailable' && !(current.kind === 'value' && current.value.token === token)) {
                    releaseArchives(file,token,fence);
                    disown(key,token); claimed = false;
                    if (wait.expired()) throw ports.timeout(file);
                    continue;
                }
                if (wait.expired()) throw ports.timeout(file);
                wait.check(); await ports.pause(wait.pauseMs());
            }
            check(); wait.check(); result = await ports.runOwnerContext(key,token,operation);
        } catch (error) {
            if (!failures.length) failures.push(error);
        } finally {
            if (claimed) {
                try { release(file,token,fence); } catch (error) { failures.push(error); }
                finally { disown(key,token); }
            }
        }
        throwFailures(failures);
        return /** @type {T} */ (result);
    }
    return {readObservation,readLock,withLock,withLockAsync};
}
