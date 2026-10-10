export function validateOwnerDevicePayload(parsed: unknown, idPattern: RegExp): OwnerDevicePayloadValidation;
export type ValidatedOwnerDeviceRecord = { id: string } & Record<string, unknown>;
export type OwnerDevicePayloadValidation = { kind: 'valid'; devices: ValidatedOwnerDeviceRecord[] } | { kind: 'invalid' };
