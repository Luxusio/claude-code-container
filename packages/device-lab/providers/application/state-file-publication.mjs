import { atomicTemporaryWriter, retryAtomicRename, assertCopyLimit } from '../domain/state-file-publication.mjs';
/** @template {readonly import('../ports/state-file-publication.mjs').PublicationDirectory[]} Fence
 * @template {import('../ports/state-file-publication.mjs').PublicationStage} Stage
 * @param {import('../ports/state-file-publication.mjs').StateFilePublicationPorts<Fence,Stage>} ports */
export function createStateFilePublication(ports) {
    /** @param {string} source @param {string} destination @param {()=>undefined} [check] @returns {undefined} */
    function rename(source,destination,check = () => undefined) {
        const deadline = ports.now() + 2000;
        while (true) {
            try { check(); ports.renameAttempt(source,destination); check(); return undefined; }
            catch (error) {
                if (!retryAtomicRename(ports.errorCode(error)) || ports.now() >= deadline) throw error;
                ports.pauseSync(10);
            }
        }
    }
    /** @param {string} file @param {Fence} fence */
    function scavenge(file,fence) {
        let entries;
        try { entries = ports.entries(file,fence); } catch { return; }
        if (!entries) return;
        const base = ports.basename(file);
        for (const entry of entries) {
            const pid = atomicTemporaryWriter(base,entry);
            if (pid === null || ports.alive(pid)) continue;
            try {
                const facts = ports.temporaryFacts(file,entry,fence);
                if (!facts || !facts.ordinary || facts.linked || ports.now()-facts.mtimeMs < 100) continue;
                ports.removeTemporary(file,entry,fence);
            } catch { /* concurrent temporary removal/replacement */ }
        }
    }
    /** @param {string} file @param {string|ArrayBufferView} value @returns {undefined} */
    function write(file,value) {
        const fence = ports.capture(file);
        scavenge(file,fence);
        ports.check(fence);
        const stage = ports.stage(file);
        try {
            ports.writeStage(stage,value);
            ports.check(fence);
            rename(stage.path,file,ports.variant === 'provider' ? () => ports.check(fence) : undefined);
            if (ports.variant === 'typescript') { ports.check(fence); try { ports.chmodTarget(file); } catch { /* best effort */ } }
        } finally {
            if (ports.variant === 'provider') ports.check(fence);
            ports.removeStage(stage);
            if (ports.variant === 'provider') ports.check(fence);
        }
        return undefined;
    }
    /** @param {string} file @param {unknown} value @returns {undefined} */
    function writeJson(file,value) { return write(file,JSON.stringify(value,null,2)); }
    /** @param {string} source @param {string} destination @param {{prefix?:string,limitBytes:number}} options */
    function copy(source,destination,options) {
        const prefix = options?.prefix || 'device-lab-copy';
        const limit = options?.limitBytes;
        assertCopyLimit(limit);
        const fence = ports.capture(destination);
        if (ports.variant === 'provider') ports.check(fence);
        const stage = ports.stage(destination);
        try {
            const copied = ports.withSource(source,prefix,limit,resources => {
                const output = resources.openOutput();
                let total = 0;
                while (true) {
                    const count = output.read();
                    if (count === 0) break;
                    if (total + count > limit) throw ports.stateError(`${prefix}-file-too-large`);
                    let written = 0;
                    while (written < count) {
                        const size = output.write(written,count-written);
                        if (size <= 0) throw new Error(`${prefix}-write-failed`);
                        written += size;
                    }
                    total += count;
                }
                try { output.permissions(); } catch { /* best effort */ }
                output.close();
                return total;
            },stage,fence);
            if (copied === null) throw ports.stateError(`${prefix}-file-missing`);
            ports.check(fence);
            rename(stage.path,destination,ports.variant === 'provider' ? () => ports.check(fence) : undefined);
            if (ports.variant === 'typescript') ports.check(fence);
            try { ports.chmodTarget(destination); } catch { /* best effort */ }
            return copied;
        } finally {
            ports.closeOutput(stage);
            if (ports.variant === 'provider') ports.check(fence);
            ports.removeStage(stage);
            if (ports.variant === 'provider') ports.check(fence);
        }
    }
    return {write,writeJson,copy,rename};
}
