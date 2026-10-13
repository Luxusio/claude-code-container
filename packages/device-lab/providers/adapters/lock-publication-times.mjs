/** Decode native Windows start tokens without changing claim timestamp compatibility.
 * @param {import('../ports/shared-mutation-lock.mjs').LockProcessIdentity} identity
 * @param {string|undefined} createdAt
 * @returns {import('../ports/shared-mutation-lock.mjs').LockPublicationTimes} */
export function readLockPublicationTimes(identity,createdAt) {
    const start = /^windows:(\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2}))$/.exec(identity.startToken);
    const processStartedAtMs = start ? Date.parse(start[1]) : NaN;
    const claimCreatedAtMs = Date.parse(createdAt ?? '');
    return Number.isFinite(processStartedAtMs) && Number.isFinite(claimCreatedAtMs)
        ? {kind:'known',processStartedAtMs,claimCreatedAtMs}
        : {kind:'unavailable'};
}
