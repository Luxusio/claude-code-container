/** @param {string} base @param {string} entry */
export function atomicTemporaryWriter(base, entry) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = entry.match(new RegExp(`^${escaped}\\.(\\d+)\\.(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\.tmp$`, "i"));
    return match ? Number(match[1]) : null;
}
/** @param {string|undefined} code */
export function retryAtomicRename(code) { return ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(code || ""); }
/** @param {number} limitBytes */
export function assertCopyLimit(limitBytes) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new TypeError("limitBytes must be a non-negative safe integer");
}
