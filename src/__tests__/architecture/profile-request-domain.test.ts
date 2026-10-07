import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE_NAME, normalizeProfile } from "../../domain/profile-request.js";

afterEach(() => {
    for (const module of ["fs", "os", "path", "child_process", "../../home-layout.js"]) vi.doUnmock(module);
    vi.resetModules();
});

describe("profile request domain", () => {
    it("maps omitted, undefined, empty and exact default requests to no named profile", () => {
        expect(DEFAULT_PROFILE_NAME).toBe("default");
        expect(normalizeProfile()).toBeUndefined();
        for (const input of [undefined, "", "default"]) expect(normalizeProfile(input)).toBeUndefined();
    });

    it.each(["work", "Default", "DEFAULT", " default", "default ", " ", "../work", "a/b", "a\\b", "工作", "\u0000"])("preserves arbitrary string %j without validation", input => {
        expect(normalizeProfile(input)).toBe(input);
    });

    it("preserves legacy JavaScript truthiness and identity without coercion", () => {
        const call = normalizeProfile as (input: unknown) => unknown;
        for (const input of [null, false, 0, -0, 0n, NaN]) expect(call(input)).toBeUndefined();
        const coercion = vi.fn(() => { throw new Error("coercion is not normalization"); });
        const object = { toString: coercion, valueOf: coercion, [Symbol.toPrimitive]: coercion };
        for (const input of [true, 1, 1n, Symbol("default"), new String("default"), object, []]) {
            expect(call(input)).toBe(input);
        }
        expect(coercion).not.toHaveBeenCalled();
    });

    it("imports and runs with native and facade dependencies fenced", async () => {
        for (const module of ["fs", "os", "path", "child_process", "../../home-layout.js"]) {
            vi.doMock(module, () => { throw new Error(`domain imported ${module}`); });
        }
        vi.resetModules();
        const domain = await import("../../domain/profile-request.js");
        expect(Object.keys(domain).sort()).toEqual(["DEFAULT_PROFILE_NAME", "normalizeProfile"]);
        expect(domain.normalizeProfile("work")).toBe("work");
        expect(domain.normalizeProfile("default")).toBeUndefined();
    });
});
