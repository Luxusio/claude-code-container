import type { LockProcessIdentity, LockPublicationTimes } from '../ports/shared-mutation-lock.mjs';
export function readLockPublicationTimes(identity:LockProcessIdentity,createdAt:string|undefined):LockPublicationTimes;
