import type { Stats } from "node:fs";
import {
    readDeviceLabStateFile,
    readDeviceLabBinaryFile,
    readDeviceLabBinaryFileWithinRoot,
    readDeviceLabTextFile,
    withDeviceLabReadableFile,
    writeDeviceLabBinaryFile,
} from "../../../packages/device-lab/src/device-lab-state-file.js";
import { readValidatedStateFile } from "../../../packages/device-lab/providers/application/state-file-read.mjs";
import type { StateFileReadPorts } from "../../../packages/device-lab/providers/ports/state-file.mjs";

const token = Symbol("validated");
const validated: typeof token | null = readDeviceLabStateFile<typeof token>("explicit-file", () => token, "prefix");
const binary: Buffer | null = readDeviceLabBinaryFile("file", "prefix");
const fenced: Buffer | null = readDeviceLabBinaryFileWithinRoot("root", "file", "prefix");
const text: string | null = readDeviceLabTextFile("file", "prefix");
const callback: { descriptor: number; stat: Stats } | null = withDeviceLabReadableFile("file", "prefix", 9, (descriptor, stat) => ({ descriptor, stat }));
writeDeviceLabBinaryFile("root", "file", Buffer.from("bytes"), "prefix", { allowNestedCreate: true });
const opaque = { content: "{}" };
const ports: StateFileReadPorts<typeof opaque, typeof token> = {
    read: () => opaque,
    decode: bytes => bytes.content,
    parse: decode => JSON.parse(decode()),
    validate: () => token,
    isStateError: () => false,
    invalidState: cause => new Error("invalid", { cause }),
};
const applicationValue: typeof token | null = readValidatedStateFile(ports);
// @ts-expect-error read port cannot be omitted in a business construction
const incomplete: StateFileReadPorts<typeof opaque, typeof token> = { decode: ports.decode, parse: ports.parse, validate: ports.validate, isStateError: ports.isStateError, invalidState: ports.invalidState };
// @ts-expect-error native compatibility descriptor is a number, not an opaque business token
withDeviceLabReadableFile("file", "prefix", 9, (descriptor: string) => descriptor);
void [validated, binary, fenced, text, callback, applicationValue, incomplete];
