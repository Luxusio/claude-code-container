/**
 * Required synchronous content ports. Bytes is opaque to the application.
 * parse receives a decode thunk so the native parser member is evaluated before
 * the decoder, preserving its receiver and getter order without ambient effects.
 *
 * @template Bytes, Value
 * @typedef {object} StateFileReadPorts
 * @property {() => Bytes | null} read
 * @property {(bytes: Bytes) => string} decode
 * @property {(decode: () => string) => unknown} parse
 * @property {(value: unknown) => Value} validate
 * @property {(error: unknown) => boolean} isStateError
 * @property {(cause: unknown) => Error} invalidState
 */
export {};
