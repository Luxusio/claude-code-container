import { describe, expect, it } from "vitest";
import { appiumGenerationMatches, recordingGenerationMatches, runtimeGenerationMatches } from "../../../packages/device-lab/providers/domain/runtime-generation.mjs";

const recordingFields = ["authority", "processOwner", "startedBy", "pid", "provider", "startedAt", "remotePath", "localPath", "sessionId"];
const appiumFields = ["authority", "processOwner", "startedBy", "serverPid", "serverUrl", "sessionId", "updatedAt"];

describe("auxiliary generation comparison rules", () => {
    it.each([null, undefined])("matches absent expected %s only with absent current", expected => {
        expect(runtimeGenerationMatches(expected, null)).toBe(true);
        expect(runtimeGenerationMatches(expected, undefined)).toBe(true);
        for (const current of [{}, [], false, 0, ""]) expect(runtimeGenerationMatches(expected, current)).toBe(false);
    });

    it.each([false, 0, "id", [], () => undefined, Symbol("id"), 1n])("refuses non-record %s without coercion", value => {
        expect(runtimeGenerationMatches(value, { runtimeId: "id" })).toBe(false);
        expect(runtimeGenerationMatches({ runtimeId: "id" }, value)).toBe(false);
    });

    it.each([recordingGenerationMatches, appiumGenerationMatches])("prioritizes truthy string runtime IDs", matches => {
        expect(matches({ runtimeId: "same", pid: 1 }, { runtimeId: "same", pid: 2 })).toBe(true);
        for (const other of ["other", "", undefined, null, 42]) {
            expect(matches({ runtimeId: "id", pid: 1 }, { runtimeId: other, pid: 1 })).toBe(false);
            expect(matches({ runtimeId: other, pid: 1 }, { runtimeId: "id", pid: 1 })).toBe(false);
        }
    });

    it("falls back to legacy fields for empty or nonstring IDs", () => {
        for (const runtimeId of ["", 0, 42, null, {}, undefined]) {
            expect(runtimeGenerationMatches({ runtimeId, pid: 1 }, { pid: 1 }, ["pid"])).toBe(true);
            expect(runtimeGenerationMatches({ runtimeId, pid: 1 }, { pid: 2 }, ["pid"])).toBe(false);
        }
        expect(runtimeGenerationMatches({ runtimeId: "" }, { runtimeId: "" })).toBe(false);
    });

    for (const [label, matches, fields] of [
        ["recording", recordingGenerationMatches, recordingFields],
        ["Appium", appiumGenerationMatches, appiumFields],
    ] as const) {
        it.each(fields)(`${label} fences the legacy %s field`, field => {
            expect(matches({ [field]: "value" }, { [field]: "value" })).toBe(true);
            expect(matches({ [field]: "value" }, { [field]: "changed" })).toBe(false);
            expect(matches({ [field]: "value" }, {})).toBe(false);
            expect(matches({}, { [field]: "value" })).toBe(false);
            expect(matches({}, {})).toBe(false);
        });
    }

    it("uses strict legacy equality and requires a selected present field", () => {
        const reference = {};
        expect(runtimeGenerationMatches({ pid: null }, { pid: null }, ["pid"])).toBe(true);
        expect(runtimeGenerationMatches({ pid: NaN }, { pid: NaN }, ["pid"])).toBe(false);
        expect(runtimeGenerationMatches({ pid: reference }, { pid: reference }, ["pid"])).toBe(true);
        expect(runtimeGenerationMatches({ pid: {} }, { pid: {} }, ["pid"])).toBe(false);
        expect(runtimeGenerationMatches({ ignored: "same" }, { ignored: "same" }, ["pid"])).toBe(false);
        expect(runtimeGenerationMatches({ pid: undefined }, { pid: undefined }, ["pid"])).toBe(false);
    });

});
