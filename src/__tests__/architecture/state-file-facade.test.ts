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

    it("preserves decode/validator classification and missing-before-decode", () => {
        expect(binding.readDeviceLabStateFile(file("{}")+"missing", () => { throw Error("called"); }, "f")).toBeNull();
        expect(() => binding.readDeviceLabStateFile(file("{"), (value: unknown) => value, "f")).toThrow("f-state-invalid");
        const cause = Error("validator");
        try { binding.readDeviceLabStateFile(file("{}"), () => { throw cause; }, "f"); } catch (error) { expect(error).toMatchObject({ code: "f-state-invalid", cause }); }
    });
});

describe("TS/shared classification differences", () => {

    it("recognizes only its own TS error constructor", () => {
        expect(ts.deviceLabStateFileErrorCode({ code: "fake" })).toBeNull();
        expect(ts.deviceLabStateFileErrorCode(new shared.DeviceLabStateFileError("foreign"))).toBeNull();
        expect(ts.deviceLabStateFileErrorCode(new ts.DeviceLabStateFileError("own"))).toBe("own");
    });
});
