import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_PROFILE_NAME, normalizeProfile } from "../../domain/profile-request.js";
import type * as facade from "../../home-layout.js";

// The native facade is type-only here; this function is deliberately never called.
function contracts(publicApi: typeof facade) {
    expectTypeOf<typeof normalizeProfile>().toEqualTypeOf<(profile?: string) => string | undefined>();
    expectTypeOf<typeof publicApi.normalizeProfile>().toEqualTypeOf<typeof normalizeProfile>();
    expectTypeOf<typeof DEFAULT_PROFILE_NAME>().toEqualTypeOf<"default">();
    expectTypeOf<typeof publicApi.DEFAULT_PROFILE_NAME>().toEqualTypeOf<"default">();
    normalizeProfile();
    normalizeProfile(undefined);
    normalizeProfile("work");
    publicApi.normalizeProfile();
    publicApi.normalizeProfile(undefined);
    publicApi.normalizeProfile("work");
    // @ts-expect-error Public requests remain optional strings.
    normalizeProfile(1);
    // @ts-expect-error null is not a supported typed request.
    normalizeProfile(null);
    // @ts-expect-error Native facade accepts no broader request type.
    publicApi.normalizeProfile(1);
    // @ts-expect-error Native facade retains strict-null typing.
    publicApi.normalizeProfile(null);
    // @ts-expect-error The canonical constant retains its exact literal type.
    const other: "work" = DEFAULT_PROFILE_NAME;
    // @ts-expect-error The facade constant also retains its exact literal type.
    const publicOther: "work" = publicApi.DEFAULT_PROFILE_NAME;
    // @ts-expect-error Normalization may return undefined.
    const required: string = normalizeProfile("work");
    void [other, publicOther, required];
}
void contracts;

describe("profile request type contracts", () => {
    it("uses the actual synchronous domain implementation", () => {
        expect(normalizeProfile()).toBeUndefined();
        expect(normalizeProfile(DEFAULT_PROFILE_NAME)).toBeUndefined();
        expect(normalizeProfile("work")).toBe("work");
    });
});
