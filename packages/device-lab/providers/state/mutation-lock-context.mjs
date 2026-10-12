import { AsyncLocalStorage } from 'node:async_hooks';

/** @type {AsyncLocalStorage<readonly {key:string,token:string}[]>} */
const owners = new AsyncLocalStorage();

export function ownerContext() { return owners.getStore() ?? []; }

/** @template T @param {string} key @param {string} token @param {()=>T} operation */
export function runOwnerContext(key,token,operation) {
    return owners.run([...ownerContext(),{key,token}],operation);
}
