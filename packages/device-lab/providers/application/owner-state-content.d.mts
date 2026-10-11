import type { OwnerStateContentPorts } from '../ports/owner-state-content.mjs';

export function createOwnerStateContent(ports: OwnerStateContentPorts): {
    read(readText: () => string): unknown[];
    assertWritable(devices: unknown[], limitBytes: number): undefined;
};
