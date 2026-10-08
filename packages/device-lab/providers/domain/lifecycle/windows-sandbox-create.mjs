/** @typedef {{backend?: unknown, name?: unknown, deviceId?: unknown, networking?: unknown, clipboard?: unknown, vgpu?: unknown, memoryMb?: unknown, minimized?: unknown}} WindowsSandboxCreateInput */
/** @template {object} Helper
 * @typedef {{id: unknown, name: unknown, backend: unknown, kind: 'desktop', platform: 'windows', ownerId: string, networking: boolean, clipboard: boolean, vgpu: boolean, memoryMb: unknown, minimized: boolean, helper: Helper, recording: null, status: 'stopped', creatable: true, createdAt: string, updatedAt: string}} WindowsSandboxCreatedDefinition
 */
/** @template {object} Device
 * @typedef {{kind: 'skipped'} | {kind: 'duplicate', id: unknown} | {kind: 'claim-conflict', field: string, value: unknown} | {kind: 'created', device: Device}} WindowsSandboxCreateOutcome
 */
export {};
