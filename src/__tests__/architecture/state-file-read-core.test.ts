import { describe, expect, it } from "vitest";
import { readStateFileText, readValidatedStateFile, validateStateFileContent } from "../../../packages/device-lab/providers/application/state-file-read.mjs";
import type { StateFileReadPorts } from "../../../packages/device-lab/providers/ports/state-file.mjs";

type MutableReadPorts = { -readonly [Key in keyof StateFileReadPorts<string, unknown>]: StateFileReadPorts<string, unknown>[Key] };

function fixture(bytes: string | null = '{"id":1}') {
    const trace: string[] = [];
    const ports: MutableReadPorts = {
        read: () => { trace.push("read"); return bytes; },
        decode: bytes => { trace.push("decode"); return bytes; },
        parse: decode => { trace.push("parse-capture"); const text = decode(); trace.push("parse-call"); return JSON.parse(text); },
        validate: value => { trace.push("validate"); return value; },
        isStateError: error => { trace.push("recognize"); return error instanceof RangeError; },
        invalidState: cause => { trace.push("invalid"); return new Error("state-invalid", { cause }); },
    };
    return { ports, trace };
}

describe("bounded state read policy", () => {
    it("requires explicit ports and reads opaque content before decode/parse/validate", () => {
        const { ports, trace } = fixture();
        expect(readValidatedStateFile(ports)).toEqual({ id: 1 });
        expect(trace).toEqual(["read", "parse-capture", "decode", "parse-call", "validate"]);
    });

    it("returns missing content before accessing decoder, parser or validator getters", () => {
        const { ports, trace } = fixture(null);
        for (const key of ["decode", "parse", "validate"] as const) Object.defineProperty(ports, key, { get() { throw Error(key); } });
        expect(readValidatedStateFile(ports)).toBeNull();
        expect(trace).toEqual(["read"]);
    });

    it("propagates read faults without classifier access", () => {
        const { ports, trace } = fixture();
        const fault = Error("read");
        ports.read = () => { throw fault; };
        expect(() => readValidatedStateFile(ports)).toThrow(fault);
        expect(trace).toEqual([]);
    });

    it.each(["decode", "parse", "validate"] as const)("classifies %s faults with the original cause", key => {
        const { ports } = fixture();
        const cause = Error(key);
        Object.defineProperty(ports, key, { value: () => { throw cause; } });
        try { readValidatedStateFile(ports); throw Error("expected failure"); }
        catch (error) { expect(error).toMatchObject({ message: "state-invalid", cause }); }
    });

    it("propagates recognized state errors", () => {
        const { ports } = fixture();
        const fault = new RangeError("existing");
        ports.validate = () => { throw fault; };
        try { validateStateFileContent("{}", ports); } catch (error) { expect(error).toBe(fault); }
    });

    it("propagates throwing recognizers and error constructors without an extra classifier", () => {
        const { ports } = fixture("{");
        const fault = Error("recognizer");
        ports.isStateError = () => { throw fault; };
        expect(() => readValidatedStateFile(ports)).toThrow(fault);
        ports.isStateError = () => false;
        ports.invalidState = () => { throw fault; };
        expect(() => readValidatedStateFile(ports)).toThrow(fault);
    });

    it("keeps text decoding outside JSON classification", () => {
        const fault = Error("decode");
        expect(readStateFileText({ read: () => null, decode: () => { throw fault; } })).toBeNull();
        expect(() => readStateFileText({ read: () => "opaque", decode: () => { throw fault; } })).toThrow(fault);
    });
});
