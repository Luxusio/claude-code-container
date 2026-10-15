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
            ownIdentity = identity ?? ownIdentity ?? null;
            ownRetryAt = ownIdentity ? 0 : ports.now()+60000; return ownIdentity;
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
    /** @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord & {processIdentity:import('../ports/shared-mutation-lock.mjs').LockProcessIdentity}} lock @param {boolean} [allowQueue] */
    async function observationAsync(lock,allowQueue = true) {
        const key = JSON.stringify([lock.pid,lock.processIdentity]);
        const cached = cache.get(key);
        if (cached && ports.now()-cached.checkedAt < (cached.status === 'unavailable' ? 30000 : 1000)) return cached.status;
        const existing = pending.get(key); if (existing) return existing;
        // A budgeted caller must not leave a new native probe queued after expiry.
        if (!allowQueue && active >= 4) return 'unavailable';
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
            if (asynchronous && ports.platform() === 'win32' && lock.createdAt) {
                return {legacyProbe:lock};
            }
            return {stale:false};
        }
        return {stale:false};
    }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs */
    function stale(file,lock,staleMs) { const facts = staleFacts(file,lock,staleMs,false); if (!facts.probe) return facts.stale; const status = observation(facts.probe); return status === 'mismatch' || status === 'exited'; }
    /** @param {string} file @param {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} lock @param {number} staleMs @param {boolean} [allowQueue] */
    async function staleAsync(file,lock,staleMs,allowQueue = true) {
        const facts = staleFacts(file,lock,staleMs,true);
        if (facts.legacyProbe) {
            if (!allowQueue && active >= 4) return false;
            const current = await slot(() => ports.identityAsync(facts.legacyProbe.pid));
            if (!current) return !ports.alive(facts.legacyProbe.pid);
            // A process born after publication cannot own this claim, even when
            // the old identity is missing.
            const times = ports.publicationTimes(current,facts.legacyProbe.createdAt);
            return times.kind === 'known' && times.processStartedAtMs > times.claimCreatedAtMs + 1000;
        }
        if (!facts.probe) return facts.stale;
        const status = await observationAsync(facts.probe,allowQueue);
        return status === 'mismatch' || status === 'exited';
    }
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
    /** @param {string} file @param {string} token @param {number} staleMs @param {boolean} reclaim @param {Fence} fence */
    function admitArchives(file,token,staleMs,reclaim,fence) {
        for (const archive of ports.archives(file,fence)) {
            const observed = readObservation(archive);
            if (observed.kind === 'missing' || observed.kind === 'value' && observed.value.token === token) continue;
            if (observed.kind === 'unavailable' || !reclaim) return false;
            const lock = observed.kind === 'value' ? observed.value : null;
            if (!stale(archive,lock,staleMs)) return false;
            if (!ports.removeArchive(file,archive,lock?.token ?? null,fence) && readObservation(archive).kind !== 'missing') return false;
        }
        ports.check(fence);
        return true;
    }
    /** @param {string} file @param {string} token @param {number} staleMs @param {ReturnType<typeof waitFor>|null} wait @param {Fence} fence */
    async function admitArchivesAsync(file,token,staleMs,wait,fence) {
        wait?.check();
        for (const archive of ports.archives(file,fence)) {
            const observed = readObservation(archive);
            if (observed.kind === 'missing' || observed.kind === 'value' && observed.value.token === token) continue;
            if (observed.kind === 'unavailable') return false;
            const lock = observed.kind === 'value' ? observed.value : null;
            if (!(wait ? await waitForObservation(wait,() => staleAsync(archive,lock,staleMs,false)) : await staleAsync(archive,lock,staleMs))) return false;
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
            const value = record(token,currentIdentity(!options.waitBudget));
            while (true) {
                wait.check();
                if (!claimed) try {
                    check(); const fd = ports.openClaim(file);
                    claimed = true; own(key,token);
                    publish(fd,() => JSON.stringify(value),failures);
                    check();
                } catch (error) {
                    if (claimed || ports.errorCode(error) !== 'EEXIST') throw error;
                    if (ports.variant === 'typescript') wait.check();
                    const observed = readObservation(file);
                    const existing = observed.kind === 'value' ? observed.value : null;
                    const reclaim = ports.variant !== 'typescript' || options.reclaimStale !== false;
                    if (reclaim && existing && stale(file,existing,options.staleMs ?? 30000) && ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    if (reclaim && observed.kind === 'malformed' && stale(file,null,options.staleMs ?? 30000) && ports.moveMalformed(file,token,fence)) continue;
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    wait.check(); ports.pauseSync(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
                    continue;
                }
                check();
                const admitted = admitArchives(file,token,options.staleMs ?? 30000,ports.variant !== 'typescript' || options.reclaimStale !== false,fence);
                const current = readObservation(file);
                check();
                if (current.kind === 'value' && current.value.token === token && admitted) break;
                if (current.kind !== 'unavailable' && !(current.kind === 'value' && current.value.token === token)) {
                    releaseArchives(file,token,fence);
                    disown(key,token); claimed = false;
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    continue;
                }
                if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                wait.check(); ports.pauseSync(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
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
        const value = record(token,options.waitBudget ? currentIdentity(false) : await currentIdentityAsync());
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
                    if (ports.variant === 'typescript') wait.check();
                    const observed = readObservation(file), staleMs = options.staleMs ?? 30000;
                    const existing = observed.kind === 'value' ? observed.value : null;
                    if (existing && (options.waitBudget ? await waitForObservation(wait,() => staleAsync(file,existing,staleMs,false)) : await staleAsync(file,existing,staleMs))) {
                        if (options.waitBudget) {
                            check(); wait.check();
                            if (readLock(file)?.token !== existing.token) continue;
                            check(); wait.check();
                        }
                        if (ports.moveQualified(file,existing.token,'stale',fence)) continue;
                    }
                    if (observed.kind === 'malformed' && (options.waitBudget ? await waitForObservation(wait,() => staleAsync(file,null,staleMs,false)) : await staleAsync(file,null,staleMs))) {
                        if (options.waitBudget) {
                            check(); wait.check();
                            if (readObservation(file).kind !== 'malformed') continue;
                            check(); wait.check();
                        }
                        if (ports.moveMalformed(file,token,fence)) continue;
                    }
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    wait.check(); await ports.pause(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
                    continue;
                }
                check();
                const admitted = await admitArchivesAsync(file,token,options.staleMs ?? 30000,options.waitBudget ? wait : null,fence);
                const current = readObservation(file);
                check(); wait.check();
                if (current.kind === 'value' && current.value.token === token && admitted) break;
                if (current.kind !== 'unavailable' && !(current.kind === 'value' && current.value.token === token)) {
                    releaseArchives(file,token,fence);
                    disown(key,token); claimed = false;
                    if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                    continue;
                }
                if (ports.variant === 'provider' ? wait.expired() : wait.remaining() <= 0) throw ports.timeout(file);
                wait.check(); await ports.pause(options.waitBudget ? Math.max(0,Math.min(10,wait.remaining())) : 10);
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
