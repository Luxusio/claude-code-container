export interface StateFileReadPorts<Bytes, Value> {
    readonly read: () => Bytes | null;
    readonly decode: (bytes: Bytes) => string;
    readonly parse: (decode: () => string) => unknown;
    readonly validate: (value: unknown) => Value;
    readonly isStateError: (error: unknown) => boolean;
    readonly invalidState: (cause: unknown) => Error;
}
export {};
