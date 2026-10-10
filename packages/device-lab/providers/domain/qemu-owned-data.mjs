import { qemuLifecycleSlug, validQemuLabId } from "./qemu-lifecycle.mjs";
/** @typedef {import('./qemu-lifecycle.mjs').QemuLab & {snapshots?:{id:string,name:string,createdAt:string,diskSnapshot:boolean}[],activeSnapshot?:unknown}} QemuOwnedLab */
/** @param {unknown} value @param {string} label @returns {{ok:true,path:string|null}|{ok:false,error:string}} */
export function ownedDataPath(value, label) {
    if (value === undefined || value === null || value === "") return { ok: true, path: null };
    if (typeof value !== "string" || /[\u0000-\u001f]/.test(value) || value.includes("..")) {
        return { ok: false, error: `invalid-${label}` };
    }
    return { ok: true, path: value };
}
/** @param {unknown} value */
export function snapshotName(value) {
    const name = qemuLifecycleSlug(value);
    return validQemuLabId(name) ? name : null;
}
/** @param {string} action */
export function snapshotFlag(action) {
    return action === "create" ? "-c" : action === "restore" ? "-a" : "-d";
}
