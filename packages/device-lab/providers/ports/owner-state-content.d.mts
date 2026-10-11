export interface OwnerStateContentPorts {
    readonly idPattern: RegExp;
    byteLength(text: string): number;
    isStateError(error: unknown): boolean;
    stateError(code: 'owner-devices-file-too-large' | 'owner-devices-state-invalid', cause?: unknown): Error;
}
