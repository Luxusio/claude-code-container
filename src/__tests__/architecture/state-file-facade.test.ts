import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as ts from "../../../packages/device-lab/src/device-lab-state-file.js";
import * as tsNative from "../../../packages/device-lab/src/device-lab/adapters/state/state-file.js";
import * as shared from "../../../packages/device-lab/providers/state/state-file.mjs";
import * as sharedNative from "../../../packages/device-lab/providers/adapters/state/state-file.mjs";

const roots: string[] = [];
function file(content: string) { const root = mkdtempSync(join(tmpdir(), "ccc-state-file-facade-")); roots.push(root); const file = join(root, "state"); writeFileSync(file, content); return file; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const [name, binding, native] of [["TS", ts, tsNative], ["shared", shared, sharedNative]] as const) describe(`${name} facade compatibility`, () => {
    it("reexports its own native error constructor and native callback API", () => {
        expect(binding.DeviceLabStateFileError).toBe(native.DeviceLabStateFileError);
        expect(binding.withDeviceLabReadableFile).toBe(native.withDeviceLabReadableFile);
        expect(binding.readDeviceLabBinaryFile).toBe(native.readDeviceLabBinaryFile);
        const error = new native.DeviceLabStateFileError("existing", { cause: "cause" });
        try { binding.readDeviceLabStateFile(file("{}"), () => { throw error; }, "f"); } catch (actual) { expect(actual).toBe(error); }
        expect(error).toMatchObject({ name: "DeviceLabStateFileError", code: "existing", cause: "cause" });
    });
    it("evaluates the parser getter before decoder getter/call and preserves all receivers", () => {
        const target = file('{"id":1}'); const events: string[] = [];
        const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, "parse")!;
        const decodeDescriptor = Object.getOwnPropertyDescriptor(Buffer.prototype, "toString")!;
        const parse = JSON.parse; const decode = Buffer.prototype.toString;
        try {
            Object.defineProperty(JSON, "parse", { configurable: true, get() { events.push("parse-get"); return function (this: unknown, text: string) { events.push(this === JSON ? "parse-JSON" : "parse-other"); return parse(text); }; } });
            Object.defineProperty(Buffer.prototype, "toString", { configurable: true, get() { events.push("decode-get"); return function (this: Buffer, encoding: BufferEncoding) { events.push(Buffer.isBuffer(this) ? "decode-bytes" : "decode-other"); return decode.call(this, encoding); }; } });
            expect(binding.readDeviceLabStateFile(target, function (this: unknown, value: unknown) { events.push(this === undefined ? "validate-bare" : "validate-other"); return value; }, "f")).toEqual({ id: 1 });
        } finally {
            Object.defineProperty(JSON, "parse", parseDescriptor); Object.defineProperty(Buffer.prototype, "toString", decodeDescriptor);
        }
        expect(events).toEqual(["parse-get", "decode-get", "decode-bytes", "parse-JSON", "validate-bare"]);
    });
    it("preserves decode/validator classification and missing-before-decode", () => {
        expect(binding.readDeviceLabStateFile(file("{}")+"missing", () => { throw Error("called"); }, "f")).toBeNull();
        expect(() => binding.readDeviceLabStateFile(file("{"), (value: unknown) => value, "f")).toThrow("f-state-invalid");
        const cause = Error("validator");
        try { binding.readDeviceLabStateFile(file("{}"), () => { throw cause; }, "f"); } catch (error) { expect(error).toMatchObject({ code: "f-state-invalid", cause }); }
    });
});

describe("TS/shared classification differences", () => {
    it("keeps the TS outer recognition pass and shared single recognition pass", () => {
        const target = file("{}");
        for (const [binding, expected] of [[ts, 2], [shared, 1]] as const) {
            let count = 0; const fault = Error("recognizer");
            Object.defineProperty(binding.DeviceLabStateFileError, Symbol.hasInstance, { configurable: true, value() { count++; throw fault; } });
            try { expect(() => binding.readDeviceLabStateFile(target, () => { throw Error("validator"); }, "f")).toThrow(fault); }
            finally { Reflect.deleteProperty(binding.DeviceLabStateFileError, Symbol.hasInstance); }
            expect(count).toBe(expected);
        }
    });
    it("retains narrower shared exports and instanceof-only TS error recognition", () => {
        expect("writeDeviceLabBinaryFile" in shared).toBe(false);
        expect("readDeviceLabBinaryFileWithinRoot" in shared).toBe(false);
        expect("deviceLabStateFileErrorCode" in shared).toBe(false);
        expect(ts.deviceLabStateFileErrorCode({ code: "fake" })).toBeNull();
        expect(ts.deviceLabStateFileErrorCode(new shared.DeviceLabStateFileError("foreign"))).toBeNull();
        expect(ts.deviceLabStateFileErrorCode(new ts.DeviceLabStateFileError("own"))).toBe("own");
    });
});
