import { afterEach, describe, expect, it } from "vitest";
import { ownerBasis, ownerId } from "../../device-lab-mcp/src/context.mjs";
import { deviceLabOwnerBasis, deviceLabOwnerId } from "../device-lab-owner.js";

describe("device-lab-mcp owner context", () => {
    const originalProfile = process.env.CCC_PROFILE;

    afterEach(() => {
        if (originalProfile === undefined) delete process.env.CCC_PROFILE;
        else process.env.CCC_PROFILE = originalProfile;
    });

    it("uses canonical project owner basis by default", () => {
        delete process.env.CCC_PROFILE;

        expect(ownerBasis()).toBe(deviceLabOwnerBasis(process.cwd()));
        expect(ownerId()).toBe(deviceLabOwnerId(process.cwd()));
    });

    it("includes profile in the canonical default owner basis", () => {
        process.env.CCC_PROFILE = "work";

        expect(ownerBasis()).toBe(deviceLabOwnerBasis(process.cwd(), "work"));
        expect(ownerId()).toBe(deviceLabOwnerId(process.cwd(), "work"));
    });
});
