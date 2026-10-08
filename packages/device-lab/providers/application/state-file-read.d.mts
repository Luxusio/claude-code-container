import type { StateFileReadPorts } from "../ports/state-file.mjs";
export function validateStateFileContent<Bytes, Value>(bytes: Bytes, ports: StateFileReadPorts<Bytes, Value>): Value;
export function readValidatedStateFile<Bytes, Value>(ports: StateFileReadPorts<Bytes, Value>): Value | null;
export function readStateFileText<Bytes>(ports: {readonly read: () => Bytes | null; readonly decode: (bytes: Bytes) => string}): string | null;
