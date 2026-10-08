/** @template {object} Helper
 * @typedef {import('../../domain/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreatedDefinition<Helper>} Definition
 */
/** @template {object} Helper
 * @typedef {{
 * deriveDeviceId: (name: unknown) => string,
 * readDefinitions: () => {id?: unknown}[],
 * readOwnerId: () => string,
 * ensureHelperWorkspace: (device: {id: unknown}) => Helper & {then?: never},
 * wallTimestamp: () => string,
 * claimDefinition: (device: Definition<Helper>) => {ok: true} | {ok: false, field: string, value: unknown}
 * }} WindowsSandboxCreatePorts
 */
export {};
