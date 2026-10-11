import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateOwnerDevicePayload } from "../../../packages/device-lab/providers/domain/owner-device-payload.mjs";
import { createOwnerStateContent } from "../../../packages/device-lab/providers/application/owner-state-content.mjs";
import type { OwnerStateContentPorts } from "../../../packages/device-lab/providers/ports/owner-state-content.d.mts";

const pattern = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const repository = fileURLToPath(new URL("../../../", import.meta.url));

class OwnerContentError extends Error {
    constructor(readonly code: string, cause?: unknown) {
        super(code, cause === undefined ? undefined : { cause });
    }
}

const contentPorts = {
    idPattern: pattern,
    byteLength: (text: string) => Buffer.byteLength(text, "utf8"),
    isStateError: (error: unknown) => error instanceof OwnerContentError,
    stateError: (code: "owner-devices-file-too-large" | "owner-devices-state-invalid", cause?: unknown) => new OwnerContentError(code, cause),
} satisfies OwnerStateContentPorts;

describe("canonical owner-state payload", () => {
    it("reads empty and populated JSON owner content without dropping record metadata", () => {
        const content = createOwnerStateContent(contentPorts);
        expect(content.read(() => '{"devices":[]}')).toEqual([]);
        expect(content.read(() => '{"devices":[{"id":"owned","metadata":{"label":"한글"}}]}')).toEqual([{ id: "owned", metadata: { label: "한글" } }]);
    });

    it("classifies malformed JSON with the native error constructor and syntax cause", () => {
        let failure: unknown;
        try { createOwnerStateContent(contentPorts).read(() => "{broken"); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(OwnerContentError);
        expect(failure).toMatchObject({ code: "owner-devices-state-invalid", cause: expect.any(SyntaxError) });
    });

    it("classifies a raw bounded-read fault inside the JSON catch and preserves its cause", () => {
        const readFailure = Object.assign(new Error("native read failed"), { code: "EIO" });
        let failure: unknown;
        try { createOwnerStateContent(contentPorts).read(() => { throw readFailure; }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(OwnerContentError);
        expect(failure).toMatchObject({ code: "owner-devices-state-invalid" });
        if (!(failure instanceof OwnerContentError)) throw new Error("Expected the supplied owner-state error constructor");
        expect(failure.cause).toBe(readFailure);
    });

    it("preserves an existing native state error instead of wrapping it as invalid JSON", () => {
        const tooLarge = new OwnerContentError("owner-devices-file-too-large");
        let failure: unknown;
        try { createOwnerStateContent(contentPorts).read(() => { throw tooLarge; }); } catch (error) { failure = error; }
        expect(failure).toBe(tooLarge);
    });

    it("accepts the exact pretty-serialized UTF-8 limit and refuses one byte below it", () => {
        const devices = [{ id: "owned", metadata: "é한글🧭" }];
        const bytes = Buffer.byteLength(JSON.stringify({ devices }, null, 2), "utf8");
        const content = createOwnerStateContent(contentPorts);
        expect(content.assertWritable(devices, bytes)).toBeUndefined();
        expect(content.assertWritable(devices, bytes + 1)).toBeUndefined();
        let failure: unknown;
        try { content.assertWritable(devices, bytes - 1); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(OwnerContentError);
        expect(failure).toMatchObject({ code: "owner-devices-file-too-large" });
    });
    it.each([null, [], {}, { devices: null }, { devices: {} }, { devices: [null] }, { devices: [[]] }])("rejects malformed payload %j", parsed => {
        expect(validateOwnerDevicePayload(parsed, pattern)).toEqual({ kind: "invalid" });
    });
    it.each(["", ".", "..", "a/b", "a\\b", "C:disk", "한글", "a".repeat(129), null, 1])("rejects unsafe ID %j", id => {
        expect(validateOwnerDevicePayload({ devices: [{ id }] }, pattern)).toEqual({ kind: "invalid" });
    });
    it.each(["", null, 1, "a".repeat(129)])("rejects invalid AVD name %j", avdName => {
        expect(validateOwnerDevicePayload({ devices: [{ id: "safe", avdName }] }, pattern)).toEqual({ kind: "invalid" });
    });
    it("rejects duplicate IDs and AVD names independently", () => {
        for (const devices of [[{ id: "a" }, { id: "a" }], [{ id: "a", avdName: "avd" }, { id: "b", avdName: "avd" }]]) {
            expect(validateOwnerDevicePayload({ devices }, pattern)).toEqual({ kind: "invalid" });
        }
    });
    it("preserves original array, records and extra fields at exact character limits", () => {
        const devices = [{ id: "a".repeat(128), avdName: "b".repeat(128), metadata: { text: "한글" } }];
        const result = validateOwnerDevicePayload({ devices, extra: true }, pattern);
        expect(result.kind).toBe("valid");
        if (result.kind !== "valid") throw new Error("unexpected invalid outcome");
        expect(result.devices).toBe(devices);
        expect(result.devices[0]).toBe(devices[0]);
        expect(validateOwnerDevicePayload({ devices: [] }, pattern)).toEqual({ kind: "valid", devices: [] });
    });
    it("preserves both shipped adapters' class identity, byte limits and read failures", () => {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import assert from 'node:assert/strict';
            import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
            import {tmpdir} from 'node:os';
            import {join} from 'node:path';
            const root = mkdtempSync(join(tmpdir(), 'ccc-owner-payload-'));
            try {
                for (const path of [
                    './packages/device-lab/providers/state/owner-device-state.mjs',
                    './dist/packages/device-lab/providers/state/owner-device-state.mjs',
                    './packages/device-lab/dist/device-lab-owner-state.js',
                    './dist/packages/device-lab/dist/device-lab-owner-state.js',
                ]) {
                    const m = await import(path);
                    const devices = [{id:'valid', metadata:'한글'}];
                    const serialized = JSON.stringify({devices}, null, 2);
                    const bytes = Buffer.byteLength(serialized);
                    m.assertOwnerDeviceStateWritable(devices, bytes);
                    const matches = code => error => error instanceof m.OwnerDeviceStateError && error.code === code;
                    assert.throws(() => m.assertOwnerDeviceStateWritable(devices, bytes-1), matches('owner-devices-file-too-large'));
                    for (const invalid of [[{id:'..'}], [{id:'x'}, {id:'x'}], [{id:'x',avdName:''}]]) {
                        assert.throws(() => m.assertOwnerDeviceStateWritable(invalid), matches('owner-devices-state-invalid'));
                    }
                    const file = join(root, 'devices.json');
                    writeFileSync(file, serialized);
                    assert.deepEqual(m.readOwnerDeviceStateFile(file, bytes), devices);
                    assert.throws(() => m.readOwnerDeviceStateFile(file, bytes-1), matches('owner-devices-file-too-large'));
                    writeFileSync(file, '{broken');
                    assert.throws(() => m.readOwnerDeviceStateFile(file), error => matches('owner-devices-state-invalid')(error) && error.cause instanceof SyntaxError);
                    assert.equal(readFileSync(file, 'utf8'), '{broken');
                    assert.deepEqual(m.readOwnerDeviceStateFile(join(root, 'absent.json')), []);
                }
            } finally { rmSync(root, {recursive:true, force:true}); }
        `], { cwd: repository, encoding: "utf8", timeout: 15000, windowsHide: true });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
    });
});
