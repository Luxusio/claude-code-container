import { afterEach, describe, expect, it, vi } from "vitest";
import * as domain from "../../domain/profile-request.js";
import * as facade from "../../home-layout.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("profile request native facade", () => {
    it("preserves the existing exports and default constant", () => {
        expect(facade.DEFAULT_PROFILE_NAME).toBe(domain.DEFAULT_PROFILE_NAME);
        expect(Object.keys(facade).sort()).toEqual([
            "DEFAULT_PROFILE_MARKER", "DEFAULT_PROFILE_NAME", "cccHome", "clipboardFilesDir",
            "clipboardPortFile", "clipboardStartingLock", "clipboardStateDir", "configFile",
            "defaultProfileDir", "ensureDefaultProfileDir", "helperBinDir", "legacyRemoteConfigDir",
            "locksDir", "migrateHomeLayout", "normalizeProfile", "profileClaudeDir",
            "profileClaudeJsonFile", "profileCodexDir", "profilesDir", "readCccConfig",
            "runDir", "updateCccConfig",
        ].sort());
    });

    it("forwards every supplied request and returns the actual domain result", () => {
        const spy = vi.spyOn(domain, "normalizeProfile");
        for (const input of [undefined, "", "default", "work", "../work", " default "]) {
            expect(facade.normalizeProfile(input)).toBe(domain.normalizeProfile(input));
        }
        spy.mockReturnValue("delegated-result");
        expect(facade.normalizeProfile("request")).toBe("delegated-result");
        expect(spy).toHaveBeenLastCalledWith("request");
        spy.mockClear();
        facade.normalizeProfile();
        expect(spy).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("propagates a domain exception by identity", () => {
        const sentinel = new Error("domain failure");
        vi.spyOn(domain, "normalizeProfile").mockImplementation(() => { throw sentinel; });
        expect(() => facade.normalizeProfile("work")).toThrow(sentinel);
    });

    it("retains malformed JavaScript identity and downstream native path errors", () => {
        const call = facade.normalizeProfile as (input: unknown) => unknown;
        const coercion = vi.fn(() => { throw new Error("unexpected coercion"); });
        const object = { [Symbol.toPrimitive]: coercion };
        expect(call(object)).toBe(object);
        expect(call(false)).toBeUndefined();
        for (const path of [facade.profileClaudeDir, facade.profileClaudeJsonFile, facade.profileCodexDir]) {
            expect(() => (path as (input: unknown) => string)(object)).toThrow(TypeError);
        }
        expect(coercion).not.toHaveBeenCalled();
    });
});
