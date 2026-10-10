/** @typedef {import('../domain/owner-device-payload.mjs').ValidatedOwnerDeviceRecord} OwnerDeviceRecord */

/**
 * Synchronous storage boundary for one trusted owner/backend binding.
 * read returns records validated by the existing fenced reader. validate
 * retains the existing payload and serialized UTF-8 byte limits. publish
 * retains the existing atomic {devices} envelope. The adapter owns all paths,
 * file identity checks, lock acquisition/release and exact record comparison.
 * @typedef {{
 *   read: () => OwnerDeviceRecord[],
 *   exists: () => boolean,
 *   validate: (devices: unknown[]) => void,
 *   publish: (devices: unknown[]) => void,
 *   withMutationLock: <T>(operation: () => T) => T,
 *   equals: (left: unknown, right: unknown) => boolean
 * }} OwnerDeviceRepositoryPorts
 */
export {};
